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
// python3 -c "` and its closing `"`.
function extractArchEmitter(): string {
  const match = src.match(
    /printf '%s' "\$ARCH_BOARD_JSON"[\s\S]*?python3 -c "([\s\S]*?)"\s*2>\/dev\/null/,
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
});
