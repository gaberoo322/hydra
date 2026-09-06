/**
 * Coverage for scripts/autopilot/reap_stall.py (issue #4398) — the
 * dev_orch/dev_target stall-recovery handlers extracted out of reap.py,
 * alongside the prerequisite leaf scripts/autopilot/reap_ghrefs.py (the `gh`
 * subprocess seam + PR/issue predicates the handlers depend on).
 *
 * reap_stall.py is a pure move-and-import extraction: `_handle_dev_orch_stall`,
 * `_handle_dev_orch_needs_qa_promotion`, `_handle_dev_target_stall` (formerly
 * defined inside reap.py) move verbatim, and the module imports its `gh`/PR
 * predicates from the sibling leaf reap_ghrefs.py rather than from reap.py —
 * the design-concept's INV-3: reap.py imports reap_stall at module top, so a
 * `from reap import ...` inside reap_stall would re-enter reap.py's own
 * module init a second time (under `python3 reap.py`, the running module is
 * `__main__`; under an importlib-by-path test loader, the same double-load
 * happens) and raise on the partially-initialised module.
 *
 * This file exercises the extraction's structural contract directly,
 * in-process, via the same importlib.util.spec_from_file_location pattern
 * test/autopilot-reap-state.test.mts already uses for reap_state.py — the
 * module has no CLI (no shebang, no `__main__`), so it is loaded by path via
 * a REAP_STALL_PATH env var rather than spawned.
 *
 * reap.py's own pinned suites (test/autopilot-dev-resume-stall.test.mts,
 * test/autopilot-dev-target-resume-stall.test.mts,
 * test/autopilot-dedup-reap.test.mts, test/autopilot-dev-orch-needs-qa-
 * promotion.test.mts) continue to exercise the same behavior end-to-end
 * through reap.py's CLI and are unedited by this change — this file is the
 * new, focused unit-level coverage for the extracted module.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPTS = join(REPO_ROOT, "scripts", "autopilot");
const REAP_STALL = join(SCRIPTS, "reap_stall.py");

function runPython(
  code: string,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  // cwd = repo root (not SCRIPTS) — mirrors the importlib-by-path test
  // loaders reap.py's own header comment calls out (sys.path[0] == ''), so
  // this probe genuinely exercises reap_stall.py's own guarded sys.path
  // insert rather than piggybacking on an ambient script-directory cwd.
  const r = spawnSync("python3", ["-c", code], {
    cwd: REPO_ROOT,
    env: { ...process.env, REAP_STALL_PATH: REAP_STALL, ...env },
    encoding: "utf-8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Registers the module in sys.modules BEFORE exec_module — mirroring
// test/autopilot-dedup-reap.test.mts's own precaution for reap.py and
// test/autopilot-reap-state.test.mts's for reap_state.py.
const LOAD_PREAMBLE = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("reap_stall_u", os.environ["REAP_STALL_PATH"])
reap_stall = importlib.util.module_from_spec(spec)
sys.modules["reap_stall_u"] = reap_stall
spec.loader.exec_module(reap_stall)
`;

describe("scripts/autopilot/reap_stall.py — extraction structure (issue #4398)", () => {
  test("the three dev_orch/dev_target stall handlers all exist on the loaded module (INV-10a)", () => {
    const r = runPython(
      `${LOAD_PREAMBLE}
names = ["_handle_dev_orch_stall", "_handle_dev_orch_needs_qa_promotion", "_handle_dev_target_stall"]
for n in names:
    assert callable(getattr(reap_stall, n, None)), f"{n} missing or not callable"
print("ALL_PRESENT")
`,
    );
    assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "ALL_PRESENT");
  });

  test("loading reap_stall.py never pulls reap into sys.modules — no import cycle (INV-10b, INV-3)", () => {
    const r = runPython(
      `${LOAD_PREAMBLE}
# "reap" itself (the bare top-level name a \`from reap import ...\` or
# \`import reap\` inside reap_stall.py would register) must never appear —
# reap_stall.py only imports its sibling leaves reap_ghrefs / reap_state.
assert "reap" not in sys.modules, f"reap module leaked into sys.modules: {sorted(sys.modules)}"
# The sibling leaves it DOES depend on should have loaded successfully.
assert "reap_ghrefs" in sys.modules, "reap_stall.py failed to import reap_ghrefs"
assert "reap_state" in sys.modules, "reap_stall.py failed to import reap_state"
print("NO_CYCLE")
`,
    );
    assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "NO_CYCLE");
  });

  test("a cls outside dev_orch/dev_target is a no-op guard — returns without invoking gh at all (INV-10c)", () => {
    // HYDRA_AUTOPILOT_GH_CLI points at a binary that cannot exist — if any
    // of the three handlers reached a _gh_run call on an unrelated class
    // (e.g. "research_orch"), the probe would either raise (FileNotFoundError
    // surfaces as a caught WARN, not a crash) or, more importantly, print a
    // WARN line to stderr. Asserting stderr is EMPTY is the stronger check:
    // the class guard must short-circuit before any subprocess is attempted.
    const r = runPython(
      `${LOAD_PREAMBLE}
reap_stall._handle_dev_orch_stall(
    {}, "research_orch", "hydra-research", "issue-1", "task-1", None, None,
)
reap_stall._handle_dev_orch_needs_qa_promotion("research_orch", "issue-1", None)
reap_stall._handle_dev_target_stall(
    {}, "research_orch", "hydra-research", "issue-1", "task-1", None, None,
)
print("NOOP_OK")
`,
      { HYDRA_AUTOPILOT_GH_CLI: "/nonexistent/path/to/gh-binary-that-does-not-exist" },
    );
    assert.equal(r.status, 0, `python probe failed: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "NOOP_OK");
    assert.equal(r.stderr.trim(), "", `expected zero gh invocations, got stderr: ${r.stderr}`);
  });
});
