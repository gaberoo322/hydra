/**
 * Regression test for issue #4411 (QA remediation on PR #4459) —
 * `scripts/autopilot/collect-state.sh`'s `target_risk_surface_json=`
 * collector duplicated/corrupted its output line under `pipefail` whenever
 * `print-target-facts.ts` reported the expected, non-crash `ok:false`
 * outcome (e.g. no resolvable Target Manifest).
 *
 * The block runs:
 *
 *   (cd ... && npx tsx print-target-facts.ts 2>/dev/null) | python3 -c "..." \
 *     || echo '{"ok":false,"errors":[...unreachable]}'
 *
 * `print-target-facts.ts` deliberately `process.exit(1)`s whenever
 * `facts.manifest.ok === false` — a normal signal, not a crash. Under
 * `set -uo pipefail` (collect-state.sh line 24), that nonzero upstream exit
 * makes the WHOLE PIPELINE's exit status nonzero even though the python3
 * extractor already succeeded and printed valid `{"ok":false,"errors":[...]}`
 * to stdout. The trailing `|| echo ...` then fired IN ADDITION TO that
 * already-printed line, so two lines landed where the header promises one:
 * the real manifest JSON, followed by a second, bare, unprefixed fallback
 * JSON line — corrupting whatever line-oriented parser turns
 * collect-state.sh's stdout into state.json.
 *
 * QA (PR #4459 review comment) reproduced this in isolation:
 *
 *   $ bash -c 'set -uo pipefail; echo -n "key="; (exit 1) | python3 -c "print(1)" || echo FALLBACK'
 *   key=1
 *   FALLBACK
 *
 * The fix stops gating the fallback on the PIPELINE's combined exit status
 * and instead checks `PIPESTATUS[1]` — the python3 extractor's OWN exit
 * status — explicitly. The extractor's `except` branch already guarantees
 * valid `{"ok":false,...}` JSON on any malformed/absent/erroring input, so
 * it only exits nonzero if python3 itself failed to run at all (e.g. a
 * missing binary), which is the only case that should still trigger the
 * generic "unreachable" fallback.
 *
 * This is an extract-and-run test (mirroring the discipline of
 * test/autopilot-dev-orch-gate.test.mts and
 * test/collect-state-inflight-exclusion.test.mts): collect-state.sh itself
 * is network-dependent (live `gh`, `docker`, the orchestrator HTTP
 * service), so we extract the exact `target_risk_surface_json=` block
 * verbatim from the committed script, substitute a stub for the
 * `npx tsx print-target-facts.ts` invocation (to make the scenario
 * hermetic and deterministic), and execute the REAL extracted shell +
 * python3 source under `set -uo pipefail` — the same shell mode the real
 * script runs under.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");

const TSX_INVOCATION =
  '(cd "$SCRIPT_DIR/../.." && npx tsx scripts/target/print-target-facts.ts 2>/dev/null)';

/**
 * Extract the `target_risk_surface_json=` collector block verbatim from
 * collect-state.sh, from its `echo -n` header through the trailing
 * `unset _target_risk_py_status` line (inclusive).
 */
function extractBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const startMarker = 'echo -n "target_risk_surface_json="';
  const endMarker = "unset _target_risk_py_status";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx >= 0, "could not locate target_risk_surface_json collector start in collect-state.sh");
  const endIdx = src.indexOf(endMarker, startIdx);
  assert.ok(endIdx >= 0, "could not locate target_risk_surface_json collector end in collect-state.sh");
  const block = src.slice(startIdx, endIdx + endMarker.length);
  assert.ok(
    block.includes(TSX_INVOCATION),
    "extracted block no longer contains the expected npx tsx invocation — update this test's stub substitution",
  );
  return block;
}

/**
 * Run the extracted collector block under bash with `set -uo pipefail`
 * (matching collect-state.sh's own shell mode), replacing the real
 * `npx tsx print-target-facts.ts` call with a stub that prints
 * `stdoutPayload` to stdout and exits with `exitCode`.
 */
function runCollectorBlock(stdoutPayload: string, exitCode: number): { stdout: string; status: number } {
  const block = extractBlock();
  const stub = `(printf '%s' ${JSON.stringify(stdoutPayload)}; exit ${exitCode})`;
  const script = `set -uo pipefail\n${block.split(TSX_INVOCATION).join(stub)}\n`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
  return { stdout: r.stdout ?? "", status: r.status ?? -1 };
}

describe("collect-state.sh — target_risk_surface_json pipefail double-emit (issue #4411)", () => {
  test("upstream ok:false + exit 1 (the expected/documented failure signal) emits exactly one well-formed line", () => {
    // print-target-facts.ts's real behavior on ok:false: prints
    // `{"manifest":{"ok":false,"errors":[...]}}` to stdout AND exits 1.
    const upstreamJson = JSON.stringify({
      manifest: { ok: false, errors: ["no resolvable Target Manifest"] },
    });
    const { stdout, status } = runCollectorBlock(upstreamJson, 1);

    const lines = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(
      lines.length,
      1,
      `expected exactly one output line, got ${lines.length}: ${JSON.stringify(lines)}`,
    );
    assert.match(lines[0], /^target_risk_surface_json=/);
    const payload = JSON.parse(lines[0].slice("target_risk_surface_json=".length));
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.errors, ["no resolvable Target Manifest"]);
    // The generic "unreachable" fallback text must NOT appear anywhere —
    // it would if the old pipefail-gated `||` fired alongside this real
    // extractor output.
    assert.ok(
      !stdout.includes("print-target-facts.ts unreachable"),
      `fallback text leaked into output despite a real extractor result: ${JSON.stringify(stdout)}`,
    );
    // The collector block itself never aborts the run (no `set -e` in
    // collect-state.sh); the block's own exit status should be 0.
    assert.equal(status, 0);
  });

  test("upstream ok:true + exit 0 (healthy path) emits exactly one well-formed line", () => {
    const upstreamJson = JSON.stringify({
      manifest: { ok: true, appSubdir: "web", surfaceRepoRelative: ["web/src/risk/"] },
    });
    const { stdout, status } = runCollectorBlock(upstreamJson, 0);

    const lines = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `expected exactly one output line, got ${lines.length}`);
    const payload = JSON.parse(lines[0].slice("target_risk_surface_json=".length));
    assert.equal(payload.ok, true);
    assert.equal(payload.appSubdir, "web");
    assert.equal(status, 0);
  });

  test("upstream produces no output at all (genuinely unreachable) still falls back to exactly one well-formed line", () => {
    // No stdout at all, nonzero exit — python3's json.load(sys.stdin) raises
    // on empty input, so its own except-branch still emits valid JSON with
    // status 0. The trailing fallback must NOT also fire in this case
    // (python3 itself succeeded), so this still yields exactly one line —
    // just the python3-authored one, not the generic fallback text.
    const { stdout, status } = runCollectorBlock("", 1);

    const lines = stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, `expected exactly one output line, got ${lines.length}: ${JSON.stringify(lines)}`);
    const payload = JSON.parse(lines[0].slice("target_risk_surface_json=".length));
    assert.equal(payload.ok, false);
    assert.equal(status, 0);
  });

  test("gates the generic fallback on PIPESTATUS[1] (the python3 extractor), never PIPESTATUS[0] (tsx)", () => {
    // Source-shape guard: confirms the fix's mechanism directly, so a
    // future edit that reintroduces a bare `|| echo` on the pipeline's
    // combined exit status is caught even before behavioral drift.
    const block = extractBlock();
    assert.match(
      block,
      /_target_risk_py_status="\$\{PIPESTATUS\[1\]\}"/,
      "expected the fallback to be gated on PIPESTATUS[1] (python3's own exit status)",
    );
    assert.ok(
      !/\)"\s*\|\|\s*echo/.test(block),
      "the pipeline must not have a trailing `|| echo` fallback gated on the combined pipeline exit status",
    );
  });
});
