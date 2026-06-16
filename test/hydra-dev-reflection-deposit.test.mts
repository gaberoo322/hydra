/**
 * Regression test for issue #1912 — the hydra-dev and hydra-target-build
 * playbooks must instruct the worktree subagent to DEPOSIT the
 * reflection-source telemetry file (`hydra-refl-sources-<task_id>`) as a
 * MANDATORY child step, not buried optional reference prose.
 *
 * Background:
 *   Slice 2 of #1136 landed the infrastructure for the dispatch-side
 *   reflection-source deposit (the `hydra-refl-sources-<task_id>` file that
 *   `scripts/autopilot/reap.py` reads to stamp the `reflectionMatchSource`
 *   cycle metric). But the deposit recipe lived only at the BOTTOM of the
 *   "Reflection injection" reference subsection — the numbered/sectioned
 *   child execution contract said only "fetch reflections and weave the
 *   narrative" and never pointed at the deposit. Child agents followed the
 *   numbered contract, fetched reflections, and read past the deposit block.
 *   Result: no `/tmp/hydra-refl-sources-*` file ever landed, so
 *   `deriveReflectionMatchSource` returned `'none'` on 100% of cycles.
 *
 * Fix (#1912):
 *   Both playbooks now surface the deposit as an explicit MANDATORY step in
 *   the child execution contract (hydra-dev step 4a; hydra-target-build step
 *   3.6 has-two-halves header), cross-referencing the deposit recipe so it
 *   can't be skipped.
 *
 * This is a grep-style lint on the playbooks, which are the source of truth
 * that `scripts/sync-skills.sh` regenerates into `~/.claude/skills/.../SKILL.md`.
 * Pinning the playbooks pins what gets synced downstream — so the deposit
 * obligation can't silently erode back into optional prose.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_DIR = resolve(__dirname, "..", "docs", "operator-playbooks");

const playbooks: Record<string, string> = {
  "hydra-dev.md": readFileSync(resolve(PLAYBOOK_DIR, "hydra-dev.md"), "utf8"),
  "hydra-target-build.md": readFileSync(
    resolve(PLAYBOOK_DIR, "hydra-target-build.md"),
    "utf8",
  ),
};

for (const [name, playbook] of Object.entries(playbooks)) {
  describe(`${name} — reflection-source deposit is mandatory (issue #1912)`, () => {
    test("documents the deterministic deposit path reap.py reads", () => {
      // The deposit path must match exactly what reap.py reads:
      // ${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-sources-<task_id>.
      assert.ok(
        /hydra-refl-sources-/.test(playbook),
        `${name} must reference the hydra-refl-sources-<task_id> deposit filename reap.py reads`,
      );
      assert.ok(
        /HYDRA_AUTOPILOT_REFL_DIR/.test(playbook),
        `${name} must reference HYDRA_AUTOPILOT_REFL_DIR (the deposit dir reap.py mirrors)`,
      );
    });

    test("keys the deposit on the dispatch task_id", () => {
      assert.ok(
        /HYDRA_AUTOPILOT_TASK_ID/.test(playbook),
        `${name} must key the deposit on HYDRA_AUTOPILOT_TASK_ID so reap.py (which holds the same id) can read it`,
      );
    });

    // Issue #1945: the env vars alone are the WRONG key inside a worktree
    // subagent — HYDRA_AUTOPILOT_TASK_ID is unset and CLAUDE_CODE_SESSION_ID is
    // the child's session UUID, neither of which equals the harness task id reap
    // reads. The harness embeds its task id in the `agent-<HASH>` worktree dir,
    // so the deposit MUST derive the key from cwd as the primary source.
    test("derives the deposit key from the agent-<HASH> worktree cwd (issue #1945)", () => {
      assert.ok(
        /agent-/.test(playbook) && /\$PWD|basename/.test(playbook),
        `${name} must derive the harness task_id from the agent-<HASH> worktree cwd (the key reap actually reads), not solely from env vars (issue #1945)`,
      );
    });

    test("warns that env-var-only keys are wrong inside the worktree (issue #1945)", () => {
      assert.ok(
        /#1945/.test(playbook),
        `${name} must cite issue #1945 explaining the env-var-only deposit landed under the wrong key`,
      );
    });

    // The #1945 fix replaces the silent `|| true` swallow with a loud stderr
    // warning when the deposit cannot determine a key or the write fails, per
    // the repo "fail loud" convention.
    test("fails loud (stderr WARN) on a missing key or write error (issue #1945)", () => {
      assert.ok(
        /refl-deposit-no-task-id/.test(playbook) &&
          /refl-deposit-write-failed/.test(playbook),
        `${name} must surface a loud WARN (cues refl-deposit-no-task-id / refl-deposit-write-failed) instead of silently swallowing a deposit miss (issue #1945)`,
      );
    });

    test("maps API block sources to the bare bucket tokens deriveReflectionMatchSource matches", () => {
      // The API emits per-anchor-reflections / by-file-reflections, but
      // deriveReflectionMatchSource matches the BARE tokens per-anchor / by-file.
      // A regression that emits the raw API strings mis-buckets to mixed/none.
      assert.ok(
        /per-anchor/.test(playbook) && /by-file/.test(playbook),
        `${name} must map served blocks to the bare per-anchor / by-file bucket tokens`,
      );
    });

    test("marks the deposit MANDATORY so it can't be read as optional prose (the #1912 root cause)", () => {
      // The #1912 failure was discoverability: the recipe existed but the
      // numbered child contract never flagged it as a required step, so it
      // read as supplementary reference prose. The fix must say MANDATORY
      // loudly enough that a future edit can't quietly soften it.
      assert.ok(
        /MANDATORY/.test(playbook),
        `${name} must mark the reflection-source deposit MANDATORY (the #1912 root cause was it reading as optional)`,
      );
    });

    test("warns the deposit must run even when zero reflections were served", () => {
      // The deposit block must ALWAYS run; an empty result writes no file,
      // which reap.py correctly buckets to 'none'. Gating the whole block on
      // "reflections were served" is a subtle re-introduction of the bug.
      assert.ok(
        /\bnone\b/.test(playbook),
        `${name} must explain that an empty/served-nothing result truthfully buckets to 'none'`,
      );
    });

    test("forbids the child POSTing cycle-record itself (reap.py is the sole writer)", () => {
      assert.ok(
        /cycle-record/.test(playbook),
        `${name} must reference cycle-record and warn the child not to POST it (reap.py is the sole authoritative writer)`,
      );
    });

    test("cites issue #1912 so the rationale is discoverable", () => {
      assert.ok(
        /#1912/.test(playbook),
        `${name} should cite issue #1912 in the reflection-deposit section for future archaeology`,
      );
    });
  });
}
