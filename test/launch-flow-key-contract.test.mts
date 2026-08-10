/**
 * Drift-guard test for the pace-gate last-tick Redis key (issue #3845,
 * epic #3844).
 *
 * `hydra:autopilot:pace-gate:last-tick` has exactly one owner in each
 * language: `src/redis/launch-flow.ts` exports `PACE_GATE_LAST_TICK_KEY`
 * (TypeScript), and `scripts/autopilot/pace-gate.sh` assigns the SAME
 * literal string to its `LAST_TICK_KEY` shell variable before writing it
 * via `redis-cli HSET`. Because the write path is bash and the read path
 * (and any future in-process reader) is TypeScript, a rename on EITHER side
 * alone is syntactically valid and silently drifts the other: the launcher
 * would write an orphan key while a detector reads an always-empty one —
 * "green everything, no alarm", precisely the failure class #3844 exists to
 * close. This test reads the shell script's own source (never re-derives or
 * hardcodes the key value itself) and asserts it against the TS constant,
 * so a one-sided rename fails a test instead of shipping silently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PACE_GATE_LAST_TICK_KEY } from "../src/redis/launch-flow.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PACE_GATE_SCRIPT = resolve(REPO_ROOT, "scripts/autopilot/pace-gate.sh");

/**
 * Extract the value assigned to `LAST_TICK_KEY="..."` from the shell
 * script's source. Deliberately a narrow, literal regex — this test must
 * fail (not silently pass) if the assignment is ever restructured in a way
 * this pattern no longer matches, since a passing-by-accident drift guard
 * is worse than an absent one.
 */
function extractShellLastTickKey(source: string): string | null {
  const match = source.match(/^LAST_TICK_KEY="([^"]+)"/m);
  return match ? match[1] : null;
}

describe("pace-gate last-tick key contract (issue #3845)", () => {
  test("the TS accessor exports the expected literal", () => {
    assert.equal(PACE_GATE_LAST_TICK_KEY, "hydra:autopilot:pace-gate:last-tick");
  });

  test("pace-gate.sh's LAST_TICK_KEY literal equals src/redis/launch-flow.ts's PACE_GATE_LAST_TICK_KEY", () => {
    const source = readFileSync(PACE_GATE_SCRIPT, "utf-8");
    const shellKey = extractShellLastTickKey(source);
    assert.ok(
      shellKey,
      "expected scripts/autopilot/pace-gate.sh to assign LAST_TICK_KEY=\"...\" — " +
        "if this fails, either the assignment was removed/restructured or the " +
        "extraction regex above needs updating (never widen it to a fuzzy match)",
    );
    assert.equal(
      shellKey,
      PACE_GATE_LAST_TICK_KEY,
      "pace-gate.sh's LAST_TICK_KEY and src/redis/launch-flow.ts's " +
        "PACE_GATE_LAST_TICK_KEY have drifted apart — a rename on only one " +
        "side leaves the launcher writing an orphan key while a reader " +
        "reads an always-empty one (the failure class epic #3844 exists to close)",
    );
  });

  test("pace-gate.sh's HSET call references the LAST_TICK_KEY variable, not a second literal", () => {
    const source = readFileSync(PACE_GATE_SCRIPT, "utf-8");
    // Both the docker-exec and the -h fallback redis-cli branches must HSET
    // the SAME shell variable — never re-embed the literal string a second
    // time, which would be a second place this constant could drift from.
    const hsetCalls = source.match(/HSET\s+"\$LAST_TICK_KEY"/g) ?? [];
    assert.equal(
      hsetCalls.length,
      2,
      "expected exactly 2 HSET \"$LAST_TICK_KEY\" call sites (docker-exec branch + -h fallback branch, mirroring on-subagent-stop.sh's two-callsite pattern)",
    );
  });

  test("the record-tick write is best-effort (never fails the launch verdict)", () => {
    const source = readFileSync(PACE_GATE_SCRIPT, "utf-8");
    // The HSET invocations themselves must be `|| true`-guarded so a Redis
    // failure can never trip `set -euo pipefail` and abort the tick.
    const guardedHsets = source.match(/latency_ms\s+"\$latency_ms"\s+>\/dev\/null\s+2>&1\s+\|\|\s+true/g) ?? [];
    assert.equal(
      guardedHsets.length,
      2,
      "expected both HSET branches inside record_tick() to end in `|| true` — " +
        "this write is the deliberate INVERSE of every other dependency check " +
        "in pace-gate.sh (which all fail SAFE by skipping the launch); a " +
        "regression here would let a docker/Redis hiccup silently stop dispatch",
    );
  });
});
