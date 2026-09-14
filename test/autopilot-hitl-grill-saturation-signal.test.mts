/**
 * Regression test for issue #4391 — hitl-grill inbox saturation signals.
 *
 * Under the 2026-08-19 operator admission rule every orchestrator-defect
 * finding a producer files routes to `hitl-grill` — a TERMINAL park state
 * drained only by the operator. While that inbox holds >= cap (10) open
 * issues, discover_orch / architecture_orch idle-board dispatches are
 * guaranteed ~70-130k-token no-ops (measured 2026-09-05..06: 21 producer
 * dispatches / ~2.0M tokens / 0 admissible output against a 58-open inbox).
 *
 * `scripts/autopilot/collect-state.sh` therefore grows the third
 * anti-feedback-loop guard in the *_board_saturated family:
 *
 *   - hitl_grill_open      — the raw count of open `hitl-grill` issues
 *                            (observability; gates nothing by itself)
 *   - hitl_grill_saturated — true when open >= HITL_GRILL_INBOX_CAP (10)
 *
 * The cap and the INCLUSIVE comparison mirror the in-skill rule
 * docs/operator-playbooks/hydra-architecture-scan.md step 4c enforces ("At
 * 10 or more open hitl-grill issues, park NOTHING"), computed from the same
 * `--label hitl-grill` count so the pre-dispatch gate and the in-skill cap
 * can never disagree. Sibling caps use a strict `>`; the difference is
 * deliberate — a `>` cap would pay for one dispatch at exactly 10 that is
 * guaranteed to park nothing.
 *
 * decide.py consumes these; this test pins the EMISSION side through the
 * COMMITTED python heredoc emitter (the ARCH-emitter `runEmitter` extraction
 * contract from test/autopilot-arch-fallback-signals.test.mts), not a
 * TypeScript re-derivation that can drift. The decide.py suppression side
 * lives in test/decide-signal-classes.test.mts's "#4391" describe.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const src = readFileSync(SCRIPT, "utf-8");

// Extract the python emitter the script pipes HITL_GRILL_OPEN_RAW through,
// so the test exercises the exact logic the script ships (not a copy that
// can drift). The block lives between `printf '%s' "$HITL_GRILL_OPEN_RAW"
// | ... python3 -c "` and its closing `"`.
function extractHitlEmitter(): string {
  const match = src.match(
    /printf '%s' "\$HITL_GRILL_OPEN_RAW"[\s\S]*?python3 -c "\$\(cat <<'PY'([\s\S]*?)\nPY\n\)"\s*2>\/dev\/null/,
  );
  assert.ok(match, "could not locate the hitl-grill emitter python block in collect-state.sh");
  return match[1];
}

/** The whole collect-state block, from the label constant to the python
 *  fallback arm — for source pins that must hold over the block as a unit. */
function extractHitlBlock(): string {
  const start = src.indexOf('HITL_GRILL_LABEL="hitl-grill"');
  assert.ok(start >= 0, "HITL_GRILL_LABEL constant missing from collect-state.sh");
  const end = src.indexOf('echo "hitl_grill_saturated=true"; }', start);
  assert.ok(end >= 0, "hitl-grill block python-fallback arm missing");
  return src.slice(start, end);
}

function runEmitter(count: string, env: Record<string, string> = {}): string[] {
  const r = spawnSync("python3", ["-c", extractHitlEmitter()], {
    input: count,
    encoding: "utf-8",
    env: { ...process.env, HITL_GRILL_INBOX_CAP: "10", ...env },
  });
  assert.equal(r.status, 0, `emitter exited non-zero: ${r.stderr}`);
  return (r.stdout ?? "").trim().split("\n");
}

describe("scripts/autopilot/collect-state.sh — hitl-grill inbox saturation signals (issue #4391)", () => {
  test("documents the inbox cap as a constant (10 — the arch-scan 'park NOTHING' number)", () => {
    const m = src.match(/HITL_GRILL_INBOX_CAP=(\d+)/);
    assert.ok(m, "HITL_GRILL_INBOX_CAP must be a documented constant");
    assert.equal(
      Number(m[1]),
      10,
      "the cap must be 10 — hydra-architecture-scan.md step 4c: 'At 10 or more open hitl-grill issues, park NOTHING'",
    );
  });

  test("reads the inbox depth via a dedicated --label hitl-grill count (the arch-scan step-4c query)", () => {
    assert.match(src, /HITL_GRILL_LABEL="hitl-grill"/);
    // Standalone labelled read, NOT a fold into the shared ARCH_BOARD_JSON
    // pass: that read is capped at GH_ISSUE_LIST_LIMIT over the WHOLE open
    // board, so its counts are only a lower bound past the limit — an
    // under-count fails OPEN into the exact wasted dispatch this guard stops.
    assert.match(
      src,
      /HITL_GRILL_OPEN_RAW=\$\(gh issue list --repo gaberoo322\/hydra --state open --label "\$HITL_GRILL_LABEL" --limit "\$GH_ISSUE_LIST_LIMIT" --json number --jq 'length' 2>\/dev\/null\)/,
      "the hitl-grill depth must be its own exact labelled read",
    );
  });

  test("saturated uses an INCLUSIVE >= cap comparison (unlike the siblings' strict >)", () => {
    // The number's semantics come from the playbook prose "10 OR MORE …
    // park NOTHING" — a strict `>` would fund one dispatch at exactly 10
    // that is guaranteed to emit nothing.
    const belowCap = runEmitter("9");
    assert.ok(belowCap.includes("hitl_grill_open=9"));
    assert.ok(belowCap.includes("hitl_grill_saturated=false"), "9 < cap is not saturated");

    const atCap = runEmitter("10");
    assert.ok(atCap.includes("hitl_grill_open=10"));
    assert.ok(atCap.includes("hitl_grill_saturated=true"), "== cap is saturated");

    const overCap = runEmitter("11");
    assert.ok(overCap.includes("hitl_grill_open=11"));
    assert.ok(overCap.includes("hitl_grill_saturated=true"), "> cap is saturated");
  });

  test("empty output (failed gh read) degrades to open=0 AND saturated=true — never a fake 'inbox empty'", () => {
    // A healthy read over an empty inbox prints `0`; only a failed query
    // yields the empty string. The #4130 never-compute-from-fake-zeros rule:
    // a failed read must take the SUPPRESSING default.
    const out = runEmitter("");
    assert.ok(out.includes("hitl_grill_open=0"));
    assert.ok(out.includes("hitl_grill_saturated=true"), "a failed read must saturate (fail closed)");
  });

  test("garbage (non-numeric) output degrades the same way", () => {
    const out = runEmitter("gh: error (rate limit)");
    assert.ok(out.includes("hitl_grill_open=0"));
    assert.ok(out.includes("hitl_grill_saturated=true"));
  });

  test("a healthy read over an EMPTY inbox prints 0 and is NOT saturated", () => {
    // Pins the discriminator the fail-closed arm relies on: `0` is a real
    // count, not a failed read, and must not read as saturated.
    const out = runEmitter("0");
    assert.ok(out.includes("hitl_grill_open=0"));
    assert.ok(out.includes("hitl_grill_saturated=false"));
  });

  test("the python-failure fallback arm emits the same suppressing defaults", () => {
    // `2>/dev/null || { … }` — a python-level crash must not wedge the
    // collector mid-pass or silently omit the signal lines.
    assert.match(
      src,
      /\|\| \{ echo "hitl_grill_open=0"; echo "hitl_grill_saturated=true"; \}/,
      "the python-failure arm must emit open=0 + saturated=true",
    );
  });

  test("the block does NOT flip ORCH_BOARD_DEGRADED (the #4130 three-read enumeration stays byte-identical)", () => {
    const block = extractHitlBlock();
    assert.ok(
      !block.includes("ORCH_BOARD_DEGRADED"),
      "a failed hitl-grill read saturates on its own; widening the degraded flag would also suppress terminate:idle (out of scope for #4391)",
    );
  });

  test("the block does NOT fold into the shared ARCH read (leaves the #4130-pinned else-arm untouched)", () => {
    // Belt-and-braces for the extraction contract: the emitter consumed by
    // this test reads the raw count on stdin, so it is structurally separate
    // from the ARCH_BOARD_JSON pipeline above it.
    const block = extractHitlBlock();
    assert.ok(!block.includes("ARCH_BOARD_JSON"));
  });
});
