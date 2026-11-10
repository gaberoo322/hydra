/**
 * The counts fold (issue #5454) — a PURE function over the generated family
 * inventories. It used to be committed as docs/generated/counts.json; it holds
 * nothing the family files do not, so it is now computed by each reader
 * (the generator, scripts/docs/prose-drift.ts, the dashboard's Areas page).
 *
 * No Node imports (no `fs`, no `path`) — the dashboard build bundles this
 * module for the browser; test/generated-inventories-drift.test.mts pins that.
 */

import type { CorpusRow, CountRow } from "./envelope.ts";

/** The slice of an inventory the fold reads: just its rows. */
export interface FoldableInventory {
  rows: readonly unknown[];
}

/** The `family/metric = value` listing shape for a count row. */
export function countRowLabel(row: CountRow): string {
  return `${row.family}/${row.metric} = ${row.value}`;
}

/**
 * Per-family derived metrics beyond `<family>/rows` (#4595): each is a row
 * predicate, so every value is COUNTED from the inventory, never typed.
 */
export const FAMILY_METRICS: Record<string, Array<[string, (row: unknown) => boolean]>> = {
  pages: [["in-nav", (r) => (r as { inNav?: boolean }).inNav === true]],
  config: [
    ["unread", (r) => (r as { unread?: boolean }).unread === true],
    ["missing-sections", (r) => (r as { kind?: string; exists?: boolean }).kind === "section" && (r as { exists?: boolean }).exists === false],
  ],
  "ci-gates": [["required", (r) => (r as { required?: boolean }).required === true]],
  corpus: (["adr", "historical", "living", "module-map", "playbook"] as const).map(
    (tier): [string, (row: unknown) => boolean] => [tier, (r) => (r as CorpusRow).tier === tier],
  ),
  areas: [
    ["live", (r) => (r as { retired?: boolean }).retired !== true],
    ["retired", (r) => (r as { retired?: boolean }).retired === true],
  ],
};

/**
 * Deterministic counts: rows sorted by family then metric; derived, never
 * typed. routes/routers + routes/routes; every family adds `<family>/rows`,
 * redis-keys adds `redis-keys/retired`, and FAMILY_METRICS adds pages/in-nav,
 * config/unread, config/missing-sections, ci-gates/required, one row per
 * corpus tier, and areas/live + areas/retired (#4596).
 */
export function buildCounts(inventories: ReadonlyMap<string, FoldableInventory>): CountRow[] {
  const rows: CountRow[] = [];
  const routes = inventories.get("routes");
  if (routes) {
    const routeRows = routes.rows as Array<{ source: { path: string } }>;
    const routers = new Set(routeRows.map((r) => r.source.path));
    rows.push({ family: "routes", metric: "routers", value: routers.size });
    rows.push({ family: "routes", metric: "routes", value: routeRows.length });
  }
  for (const [family, inv] of inventories) {
    rows.push({ family, metric: "rows", value: inv.rows.length });
    if (family === "redis-keys") {
      const retired = (inv.rows as Array<{ retired?: boolean }>).filter((r) => r.retired === true).length;
      rows.push({ family, metric: "retired", value: retired });
    }
    for (const [metric, count] of FAMILY_METRICS[family] ?? []) {
      rows.push({ family, metric, value: inv.rows.filter(count).length });
    }
  }
  rows.sort((a, b) => (a.family === b.family ? (a.metric < b.metric ? -1 : 1) : a.family < b.family ? -1 : 1));
  return rows;
}
