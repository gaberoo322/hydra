/**
 * Regression test for issue #789 (epic #787) — architecture_orch
 * collect-state signals: arch_fallback_due + arch_board_saturated.
 *
 * `scripts/autopilot/collect-state.sh` must emit two new signals that
 * drive the architecture-deepening fallback, mirroring the existing
 * scout_board_open_enhancements / scout_board_saturated precedent:
 *
 *   - orch_backfill_idle     — true ONLY when the orchestrator board is
 *                              genuinely idle: ready_for_agent == 0 AND
 *                              needs_research == 0 AND needs_triage == 0
 *                              AND work_queue == 0. (Issue #959 renamed this
 *                              from arch_fallback_due and made it the SINGLE
 *                              canonical board-idle signal that BOTH
 *                              architecture_orch and discover_orch key off.)
 *   - arch_board_saturated   — true when OPEN architecture-sourced issues
 *                              exceed the cap (6). Architecture-sourced
 *                              issues are counted via the STABLE
 *                              `architecture-scan` label (the emit/count
 *                              seam #788/#791 agree on).
 *
 * decide.py (#790) consumes these; this test pins the EMISSION side: the
 * stable label, the documented cap, and the boolean logic of the python
 * emitter — so a future edit can't silently drift the seam.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const src = readFileSync(SCRIPT, "utf-8");

// Extract the python emitter the script pipes ARCH_BOARD_JSON through, so
// the test exercises the exact logic the script ships (not a copy that can
// drift). The block lives between `printf '%s' "$ARCH_BOARD_JSON" | ...
// python3 -c "` and its closing `"`. (#4130 wrapped the invocation in an
// `if [ -n "$ARCH_BOARD_JSON" ]` guard, so the `)"` closer is INDENTED —
// `\s*` absorbs that; without it the lazy match overshoots into a later
// python block and the emitter comes back mangled.)
function extractArchEmitter(): string {
  const match = src.match(
    /printf '%s' "\$ARCH_BOARD_JSON"[\s\S]*?python3 -c "\$\(cat <<'PY'([\s\S]*?)\nPY\n\s*\)"\s*2>\/dev\/null/,
  );
  assert.ok(match, "could not locate the arch emitter python block in collect-state.sh");
  return match[1];
}

function runEmitter(
  board: Record<string, number>,
  env: Record<string, string>,
): string[] {
  const r = spawnSync("python3", ["-c", extractArchEmitter()], {
    input: JSON.stringify(board),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `emitter exited non-zero: ${r.stderr}`);
  return (r.stdout ?? "").trim().split("\n");
}

describe("scripts/autopilot/collect-state.sh — architecture fallback signals (issue #789)", () => {
  test("defines the stable architecture-sourced label", () => {
    assert.match(
      src,
      /ARCH_SCAN_LABEL="architecture-scan"/,
      "architecture-sourced issues must be countable via the stable `architecture-scan` label",
    );
  });

  test("documents the saturation cap as a constant (6, within 5-10)", () => {
    const m = src.match(/ARCH_BOARD_SATURATION_CAP=(\d+)/);
    assert.ok(m, "ARCH_BOARD_SATURATION_CAP must be a documented constant");
    const cap = Number(m![1]);
    assert.ok(cap >= 5 && cap <= 10, `cap ${cap} must be in the 5-10 range`);
  });

  test("emits the unified orch_backfill_idle signal + arch_* keys via the architecture-scan label", () => {
    // Issue #959: the board-idle predicate is emitted as the single canonical
    // `orch_backfill_idle` line (renamed from arch_fallback_due).
    assert.match(src, /orch_backfill_idle=/);
    assert.doesNotMatch(src, /print\('arch_fallback_due=/, "the old arch_fallback_due emit must be gone (unified)");
    assert.match(src, /arch_board_saturated=/);
    assert.match(src, /arch_board_open_scan=/);
    // The arch-sourced count must select issues by the stable label.
    assert.match(src, /index\(\\"\$\{ARCH_SCAN_LABEL\}\\"\)/);
  });

  const env = { ARCH_WORK_QUEUE: "0", ARCH_BOARD_SATURATION_CAP: "6" };

  test("orch_backfill_idle=true ONLY when the board is fully idle", () => {
    const out = runEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 },
      env,
    );
    assert.ok(out.includes("orch_backfill_idle=true"));
    assert.ok(out.includes("arch_board_saturated=false"));
  });

  test("orch_backfill_idle=false when work_queue is non-empty", () => {
    const out = runEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 },
      { ...env, ARCH_WORK_QUEUE: "3" },
    );
    assert.ok(out.includes("orch_backfill_idle=false"));
  });

  test("orch_backfill_idle=false when any actionable label count is non-zero", () => {
    for (const label of ["ready_for_agent", "needs_research", "needs_triage"]) {
      const board = { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 0 };
      (board as Record<string, number>)[label] = 2;
      const out = runEmitter(board, env);
      assert.ok(
        out.includes("orch_backfill_idle=false"),
        `non-zero ${label} must suppress backfill-idle`,
      );
    }
  });

  test("arch_board_saturated uses a strict > cap comparison", () => {
    const atCap = runEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 6 },
      env,
    );
    assert.ok(atCap.includes("arch_board_saturated=false"), "== cap is not saturated");
    assert.ok(atCap.includes("arch_board_open_scan=6"));

    const overCap = runEmitter(
      { ready_for_agent: 0, needs_research: 0, needs_triage: 0, arch_sourced: 7 },
      env,
    );
    assert.ok(overCap.includes("arch_board_saturated=true"), "> cap is saturated");
    assert.ok(overCap.includes("arch_board_open_scan=7"));
  });

  test("malformed board JSON degrades to safe zeros (fallback_due reflects work_queue only)", () => {
    const r = spawnSync("python3", ["-c", extractArchEmitter()], {
      input: "not json",
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    assert.equal(r.status, 0);
    const out = r.stdout.trim().split("\n");
    assert.ok(out.includes("arch_board_open_scan=0"));
    assert.ok(out.includes("arch_board_saturated=false"));
  });

  /**
   * Issue #4130 — orch board-read degradation. During run 161d9642
   * (2026-08-17) GitHub's GraphQL endpoint returned 503 while REST stayed
   * healthy. Every orch board read in collect-state.sh is `gh --json`
   * (GraphQL) behind a best-effort guard, so the outage rendered a 15-issue
   * board as "empty" — and the ARCH read's zeros-JSON fallback then
   * fabricated exactly the all-zero conjunction that fires
   * `orch_backfill_idle` against a FULL board. These cases pin the fix: a
   * failed read fails CLOSED (suppressing defaults) + flips the
   * `ORCH_BOARD_READ_FAILED` accumulator, and the flag is emitted once as
   * `orch_board_signals_degraded` — the orch mirror of the Target lane's
   * `target_board_signals_degraded` (#3478), which decide.py now gates on.
   */

  test("a failed ARCH read no longer fabricates a zeros board JSON — it fails closed and flips the accumulator", () => {
    // The pre-#4130 hazard: `|| echo '{"ready_for_agent":0,...}'` conjured a
    // legitimate-looking EMPTY board out of a failed read, whose
    // fallback_due conjunction (all zeros + wq==0) then fired the idle
    // backfill against whatever the board actually held.
    assert.doesNotMatch(
      src,
      /\|\| echo '\{"ready_for_agent":0,"needs_research":0,"needs_triage":0,arch_sourced":0,"cleanup_sourced":0\}'/,
      "the zeros-JSON fabrication must be gone (issue #4130 AC-1)",
    );
    // The else branch keeps the python emitter's five keys on the wire
    // (downstream consumers need them) but in their SUPPRESSING defaults, and
    // marks the turn degraded.
    const from = src.indexOf("if [ -n \"$ARCH_BOARD_JSON\" ]; then");
    const block = src.slice(from, src.indexOf("\nfi", from));
    assert.ok(from > 0, "could not locate the ARCH_BOARD_JSON guard");
    assert.match(
      block,
      /else\n\s+# Fail closed AND observable[\s\S]*?ORCH_BOARD_READ_FAILED=1\n\s+echo "orch_backfill_idle=false"\n\s+echo "arch_board_open_scan=0"\n\s+echo "arch_board_saturated=true"\n\s+echo "cleanup_board_open_scan=0"\n\s+echo "cleanup_board_saturated=true"/,
      "a failed ARCH read must emit idle=false + saturated=true (fail closed), never a phantom empty board",
    );
  });

  test("the orch degraded flag is emitted ONCE, from the accumulator, after all four reads", () => {
    assert.equal(src.match(/echo "orch_board_signals_degraded=/g)?.length, 1);
    assert.match(
      src,
      /echo "orch_board_signals_degraded=\$\(\[ "\$ORCH_BOARD_READ_FAILED" = "1" \] && echo true \|\| echo false\)"/,
      "the flag must be the accumulator OR over the lane's failed reads, emitted unconditionally every turn",
    );
    assert.equal(
      src.match(/ORCH_BOARD_READ_FAILED=1/g)?.length,
      4,
      "expected exactly four flip sites: board-counts fallback, in-flight PR list, grill candidate list, ARCH board JSON",
    );
  });

  test("the board-counts fallback emits NO counts line on failure — never fabricated zeros", () => {
    // The `--jq` object expression prints an 8-key object on every successful
    // read (all-zero counts included), so an empty capture can only be a
    // failed read. The line stays ABSENT (the playbook's signal stitching
    // sees a missing key), and the accumulator flips — the alternative, an
    // echoed zeros object, is exactly the 161d9642 misread.
    const from = src.indexOf("ORCH_BOARD_COUNTS_JSON=$(gh issue list");
    const block = src.slice(from, src.indexOf("\nfi", from));
    assert.ok(from > 0, "could not locate the board-counts fallback capture");
    assert.match(
      block,
      /if \[ -n "\$ORCH_BOARD_COUNTS_JSON" \]; then\n\s+printf '%s\\n' "\$ORCH_BOARD_COUNTS_JSON"\n\s+else\n\s+ORCH_BOARD_READ_FAILED=1\n\s+fi/,
      "a failed board-counts read must print nothing and flip the accumulator — the jq filter lines above stay the deriveBoardState mirror",
    );
  });

  test("a GENUINELY empty candidate pool (`[]`, exit 0) is a successful read and does not degrade (AC-5d)", () => {
    // The grill-candidate read is the one whose failure left the picks at
    // `none` while 15 issues were eligible. Its `--jq '[ ... ]'` array
    // expression prints `[]` for an empty board — non-empty output — so the
    // `-z`-style guard cannot trip on it. Run the committed filter on an
    // empty board to pin that: empty boards behave exactly as before.
    const start = src.indexOf("ORCH_GRILL_LIST_JSON=$(gh issue list");
    const from = src.indexOf("--jq '", start) + "--jq '".length;
    const end = src.indexOf("' 2>/dev/null)", from);
    assert.ok(
      start > 0 && from > start && end > from,
      "could not locate the grill candidate jq filter",
    );
    const filter = src.slice(from, end);
    const r = spawnSync("jq", [filter], { input: "[]", encoding: "utf-8" });
    assert.equal(r.status, 0, `jq failed: ${r.stderr}`);
    assert.equal(
      (r.stdout ?? "").trim(),
      "[]",
      "the empty-board output must be the two-character `[]` — non-empty, so the capture guard sees a successful read",
    );
    // And the guard really is the emptiness test on the captured var.
    assert.match(
      src,
      /\[ -n "\$ORCH_GRILL_LIST_JSON" \] \|\| ORCH_BOARD_READ_FAILED=1/,
      "the grill-list failure detector is `-n` on the capture: `[]` passes, only a truly empty capture degrades",
    );
  });
});
