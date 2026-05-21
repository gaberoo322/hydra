/**
 * Regression test for OPENVIKING_API_KEY drift (issue #231).
 *
 * Bug: src/api/misc.ts hard-coded "1080bb34205409..." as the default for
 * OPENVIKING_API_KEY while four other files defaulted to "56611b96...". Only
 * the latter authenticates against the running OV instance, so any environment
 * that lost OPENVIKING_API_KEY would silently break the dashboard search proxy
 * (UNAUTHENTICATED) while the agent search wrapper kept working — a divergence
 * that's invisible in code review and silent in production.
 *
 * Fix: src/learning/ov-config.ts now owns the single canonical default. Every
 * callsite imports from it. This test enforces the rule by scanning src/ for
 * stray API-key-shaped string literals — anything matching /[0-9a-f]{64}/ that
 * looks like an OV key must live only in ov-config.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");
const OV_CONFIG_FILE = join(SRC_DIR, "knowledge-base", "ov-config.ts");

// 64-char hex string — the shape of an OV API key. The regex is intentionally
// broad (any 64-hex-char run) so future key rotations are also caught if a
// developer accidentally pastes the new key into another file.
const HEX64 = /\b[0-9a-f]{64}\b/g;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) yield* walk(full);
    else if (s.isFile()) yield full;
  }
}

describe("issue #231: OPENVIKING_API_KEY single source of truth", () => {
  test("only ov-config.ts contains a 64-hex API-key literal", async () => {
    const offenders: { file: string; matches: string[] }[] = [];
    for await (const file of walk(SRC_DIR)) {
      if (!file.endsWith(".ts")) continue;
      if (file === OV_CONFIG_FILE) continue;
      const content = await readFile(file, "utf8");
      const matches = content.match(HEX64);
      if (matches && matches.length > 0) {
        offenders.push({ file: relative(SRC_DIR, file), matches });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Found 64-hex API-key literals outside src/knowledge-base/ov-config.ts. ` +
        `These should be removed and the value imported from ov-config.ts:\n` +
        offenders.map((o) => `  - ${o.file}: ${o.matches.join(", ")}`).join("\n"),
    );
  });

  test("ov-config.ts exports the canonical OV constants", async () => {
    const mod = await import("../src/knowledge-base/ov-config.ts");
    assert.equal(typeof mod.OPENVIKING_URL, "string", "OPENVIKING_URL must be exported");
    assert.equal(typeof mod.OPENVIKING_API_KEY, "string", "OPENVIKING_API_KEY must be exported");
    assert.ok(
      mod.OPENVIKING_API_KEY.length >= 32,
      "OPENVIKING_API_KEY default looks too short to be a real key",
    );
    assert.ok(
      mod.OPENVIKING_HEADERS &&
        mod.OPENVIKING_HEADERS["X-Api-Key"] === mod.OPENVIKING_API_KEY,
      "OPENVIKING_HEADERS must carry the same X-Api-Key as OPENVIKING_API_KEY",
    );
  });

  test("ov-search re-exports stay aligned with ov-config", async () => {
    const cfg = await import("../src/knowledge-base/ov-config.ts");
    const search = await import("../src/knowledge-base/ov-search.ts");
    assert.equal(search.OV_KEY, cfg.OPENVIKING_API_KEY, "OV_KEY must match canonical key");
    assert.equal(search.OV_URL, cfg.OPENVIKING_URL, "OV_URL must match canonical URL");
  });
});
