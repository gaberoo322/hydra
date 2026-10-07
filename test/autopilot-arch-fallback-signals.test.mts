/**
 * collect-state.sh — the orch-lane degraded accumulator's remaining bash reads
 * (issue #4130).
 *
 * The architecture fallback signals this file used to pin (issue #789's
 * orch_backfill_idle + arch_board_saturated, #4657's enhancement>20 fold and
 * #4130's ARCH-read cases) moved with collect_arch_cleanup_boards into the
 * typed Turn Snapshot collector (ADR-0043 slice 5B, #4933); those cases now
 * live, ported 1:1, in test/turn-snapshot-remaining.test.mts. What stays here
 * pins the two still-bash orch reads that flip ORCH_BOARD_DEGRADED (the counts
 * fallback and the grill list), which belong to slice 2 (collect_orch_board).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const src = readFileSync(SCRIPT, "utf-8");

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
  test("a failed orch COUNTS read emits NO counts line (never a legitimate zero)", () => {
    // The fallback board-counts gh call is captured; empty output (gh failed —
    // the jq object always prints) prints nothing and flips the accumulator
    // instead of rendering a failed read as an all-zero board.
    assert.match(
      src,
      /if \[ -n "\$ORCH_BOARD_FALLBACK_JSON" \]; then\n    printf '%s\\n' "\$ORCH_BOARD_FALLBACK_JSON"\n  else\n    ORCH_BOARD_DEGRADED=1/,
      "the counts fallback must withhold its counts on failure and flag the lane",
    );
  });

  test("an EMPTY grill-list payload (failed query) also flips the accumulator", () => {
    // A healthy gh query over an empty lane prints `[]`; only a failed query
    // yields the empty string — so `[ -z ]` is the failed-read discriminator.
    assert.match(
      src,
      /if \[ -z "\$ORCH_GRILL_LIST_JSON" \]; then\n  ORCH_BOARD_DEGRADED=1/,
      "the grill/dev-ready candidate enumeration must not silently render 'no candidates' on a failed read",
    );
  });

  test("BEHAVIOURAL: the orch counts fallback jq prints a full object over an EMPTY board — empty output ⟺ gh failure", () => {
    // This is the discriminator the shell `[ -n ]` test relies on: extract
    // the committed jq and run it through real `jq` over `[]` — it must print
    // a complete all-zero OBJECT, never nothing. (Mirrors the #3687/#3754
    // pattern of running the committed filter rather than a copy.)
    const m = src.match(/ORCH_BOARD_FALLBACK_JSON=\$\(gh issue list[^\n]*--jq '\{([\s\S]*?)\n  \}'\)/);
    assert.ok(m, "could not locate the orch counts fallback jq in collect-state.sh");
    const r = spawnSync("jq", ["{" + m[1] + "}"], { input: "[]", encoding: "utf-8" });
    assert.equal(r.status, 0, `jq failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ready_for_agent, 0, "an empty board is all-zero…");
    assert.deepEqual(
      parsed.stale_in_progress,
      [],
      "…but every key still prints — so a genuinely empty board can never be mistaken for a failed read",
    );
  });
});
