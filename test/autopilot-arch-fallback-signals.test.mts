/**
 * collect-state.sh — the orch-lane degraded accumulator's remaining shell
 * hand-off (issue #4130).
 *
 * The architecture fallback signals this file used to pin (issue #789's
 * orch_backfill_idle + arch_board_saturated, #4657's enhancement>20 fold and
 * #4130's ARCH-read cases) moved with collect_arch_cleanup_boards into the
 * typed Turn Snapshot collector (ADR-0043 slice 5B, #4933); those cases now
 * live, ported 1:1, in test/turn-snapshot-remaining.test.mts. What stays here
 * pins the grill-list read's degraded hand-back through the slice-3 wrapper.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

// ---------------------------------------------------------------------------
// collect-state.sh — orch board DEGRADED flag (issue #4130)
// ---------------------------------------------------------------------------
//
// A GraphQL-only GitHub outage (REST healthy, 2026-08-17) made every orch
// board read silently render as 0/none: the ARCH read's `|| echo zeros`
// substitution fed the emitter fake zeros, the emitter computed
// orch_backfill_idle=true from a board it never saw (inverse-fire backfill
// against a FULL board), and the counts read vanished whole — leaving
// decide.py to drain runs to a clean terminate:idle with 15 eligible issues.
// The fix distinguishes FAILED reads from EMPTY ones at every orch-lane read
// and surfaces a single observable `orch_board_signals_degraded` flag. These
// tests pin the EMISSION side; the decide.py suppression side lives in
// test/autopilot-decide.test.mts's "degraded orch board read" describe.
// ---------------------------------------------------------------------------

describe("scripts/autopilot/collect-state.sh — orch board degraded flag (issue #4130)", () => {
  test("an EMPTY grill-list payload (failed query) also flips the accumulator", () => {
    // A healthy gh query over an empty lane prints `[]`; only a failed query
    // yields the empty string — the failed-read discriminator. Since ADR-0043
    // slice 3 (#4931) the grill list is read by the Turn Snapshot picks
    // collector, which hands the verdict back through --exports-file: run the
    // real call site with a `gh` that fails vs one that answers `[]`.
    const run = (ghBody: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "arch-degraded-"));
      try {
        const gh = join(dir, "gh");
        writeFileSync(gh, `#!/usr/bin/env bash\n${ghBody}\n`);
        chmodSync(gh, 0o755);
        const r = spawnSync(
          "bash",
          ["-c", 'source "$1"\nORCH_BOARD_DEGRADED=0\ncollect_turn_snapshot_pr_gate_and_picks >/dev/null 2>&1\necho "$ORCH_BOARD_DEGRADED"', "_", SCRIPT],
          { encoding: "utf-8", env: { ...process.env, HYDRA_GH_BIN: gh }, timeout: 60_000 },
        );
        return (r.stdout ?? "").trim();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    assert.equal(run("exit 1"), "1", "a failed grill-list read must flag the orch lane degraded");
    assert.equal(run('echo "[]"'), "0", "a healthy empty lane is NOT a degraded read");
  });
  // The counts-fallback cases (no counts line on a failed read; a full object
  // over an empty board) moved with the collector to
  // test/turn-snapshot-orch-board.test.mts (ADR-0043 slice 2, #4930).
});
