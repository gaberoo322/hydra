/**
 * streams family extractor (issue #4594 — docs-epic 8/13, per the #4542
 * families table and ADR-0034 §10).
 *
 * Rows come from the IMPORTED stream-key vocabulary in
 * src/event-bus-stream-keys.ts (STREAMS, RETAINED_STREAMS, CONSUMER_GROUPS —
 * a zero-side-effect module with no runtime-dep imports). Homes join through
 * the routes inventory: a route serves a stream when its src/api/*.ts router
 * references the stream's constant (`STREAMS.X` / `RETAINED_STREAMS.X`) in
 * code. The redis-keys stream builders stay redis-keys rows — no cross-family
 * dedup.
 *
 * Read-only over src/. Stdlib-only (ADR-0005). Fail-loud (CLAUDE.md).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSUMER_GROUPS, RETAINED_STREAMS, STREAMS } from "../../../src/event-bus-stream-keys.ts";
import type { RouteRow, StreamRow, StreamsInventory } from "./envelope.ts";
import { extractRoutes } from "./routes.ts";
import { byString, fail, lineOf, serveJoin, stripComments, walkFiles } from "./scan.ts";
import type { JoinRoute, SourceFile } from "./scan.ts";

const STREAM_KEYS_FILE = "src/event-bus-stream-keys.ts";

const GENERATED_FROM = ["src/event-bus-stream-keys.ts", "src/api/*.ts", "docs/generated/routes.json"];

export interface StreamInputs {
  streams: Record<string, string>;
  retained: Record<string, string>;
  consumerGroups: Record<string, string[]>;
  /** Raw text of src/event-bus-stream-keys.ts (for each constant's line). */
  keysSource: string;
  /** The src/api/*.ts router files, raw text. */
  routers: SourceFile[];
  routes: JoinRoute[];
}

/** Line of `<constant>:` inside the `const <mapName> = {` block. */
function constantLine(src: string, mapName: string, constant: string): number {
  const open = src.search(new RegExp(`\\bconst\\s+${mapName}\\s*=\\s*\\{`));
  if (open === -1) fail(`${STREAM_KEYS_FILE}: no "const ${mapName} = {" block`);
  const close = src.indexOf("}", open);
  const block = src.slice(open, close === -1 ? undefined : close);
  const at = block.search(new RegExp(`^[ \\t]*${constant}\\s*:`, "m"));
  if (at === -1) fail(`${STREAM_KEYS_FILE}: no "${constant}:" line inside ${mapName}`);
  return lineOf(src, open + at);
}

/** Pure row-builder: injected inputs in, rows sorted by key out. */
export function buildStreamRows(inputs: StreamInputs): StreamRow[] {
  const routers = inputs.routers.map((r) => ({ path: r.path, code: stripComments(r.src) }));
  const rows: StreamRow[] = [];
  const add = (mapName: "STREAMS" | "RETAINED_STREAMS", map: Record<string, string>, retained: boolean): void => {
    for (const [constant, key] of Object.entries(map)) {
      if (typeof key !== "string") fail(`${STREAM_KEYS_FILE}: ${mapName}.${constant} is not a string`);
      const ref = new RegExp(`\\b${mapName}\\.${constant}\\b`);
      const serving = new Set(routers.filter((r) => ref.test(r.code)).map((r) => r.path));
      const { servedBy, home } = serveJoin(inputs.routes, serving);
      rows.push({
        constant,
        key,
        retained,
        consumerGroups: [...(inputs.consumerGroups[key] ?? [])],
        servedBy,
        home,
        source: { path: STREAM_KEYS_FILE, line: constantLine(inputs.keysSource, mapName, constant) },
      });
    }
  };
  add("STREAMS", inputs.streams, false);
  add("RETAINED_STREAMS", inputs.retained, true);
  rows.sort((a, b) => byString(a.key, b.key));
  return rows;
}

/** The listing/sort label of a streams row: its on-wire key. */
export function streamRowLabel(row: StreamRow): string {
  return row.key;
}

export function extractStreams(repoRoot: string, routes?: RouteRow[]): StreamsInventory {
  const routers = walkFiles(repoRoot, "src/api", (n) => n.endsWith(".ts"))
    .filter((p) => /^src\/api\/[^/]+\.ts$/.test(p))
    .map((path) => ({ path, src: readFileSync(join(repoRoot, path), "utf8") }));
  const rows = buildStreamRows({
    streams: STREAMS as Record<string, string>,
    retained: RETAINED_STREAMS as Record<string, string>,
    consumerGroups: CONSUMER_GROUPS as Record<string, string[]>,
    keysSource: readFileSync(join(repoRoot, STREAM_KEYS_FILE), "utf8"),
    routers,
    routes: routes ?? extractRoutes(repoRoot).rows,
  });
  return { family: "streams", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
