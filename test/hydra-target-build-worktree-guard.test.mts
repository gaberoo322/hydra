/**
 * Regression test for issue #542 — worktree-isolation gap for hydra-target-build.
 *
 * Background: the harness `isolation: "worktree"` only worktree-isolates the
 * orchestrator repo (`~/hydra`). When `hydra-target-build` then writes to
 * `~/hydra-betting`, those edits land on the main checkout unless the skill
 * explicitly creates a hydra-betting worktree. Issue #542 closed that gap by
 * adding a Step 0.6 to the `hydra-target-build` playbook that opens a
 * `git worktree` under `~/hydra-betting`, symmetric with how `hydra-dev`
 * worktree-isolates `~/hydra`.
 *
 * This is a cheap canary — it asserts the playbook text contains the
 * load-bearing pieces (worktree-add invocation, $TARGET_WT anchor, the
 * abort-on-main-checkout preamble) so a future edit that silently removes
 * them is caught at `npm test` time rather than at "ghost-edit hits the
 * main checkout in production" time. The skill text is also mirrored to
 * `~/.claude/skills/hydra-target-build/SKILL.md` by `scripts/sync-skills.sh`
 * — guarding the source-of-truth playbook here is sufficient because the
 * sync script is fails-fast on bad regen (#433).
 *
 * Companion guard for `scripts/branch-prune.sh`: assert it now sweeps the
 * target repo too, so the new hydra-betting worktrees we create above are
 * GC'd by the daily timer (and don't leak forever the way the 2026-05-15
 * batch of 71 worktrees did).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

describe("hydra-target-build playbook — worktree isolation (issue #542)", () => {
  // What this guard protects is the *safety substance* of the two-repo
  // isolation contract, not the cosmetic surface text that carries it. The
  // friction cue `playbook-text-asserted-by-test` recurred 11× because the
  // assertions coupled to exact headings / step numbers / prose sentences:
  // a heading reword or section renumber that preserved every safety
  // invariant still false-failed the test (issue #1899). So the canaries
  // below assert the *load-bearing command strings and ABORT messages* —
  // those strings ARE the safety contract — plus a small set of stable
  // keyword phrases, and deliberately do NOT pin exact headings, step
  // numbers, or issue-number cross-references.
  const playbook = readRepoFile("docs/operator-playbooks/hydra-target-build.md");

  test("creates a git worktree under ~/hydra-betting with a GC-able $TARGET_WT path", () => {
    // The load-bearing invocation: `git -C ~/hydra-betting worktree add ...`
    // with a /dev/shm/hydra-worktrees/hydra-betting-worktree-* path so the
    // existing branch-prune sweep can GC it. KEPT VERBATIM — these strings
    // are the real canary, not the surrounding heading.
    assert.match(
      playbook,
      /git -C ~\/hydra-betting worktree add -b "feature\/\$\{CYCLE_ID\}"/,
    );
    assert.match(
      playbook,
      /TARGET_WT="\/dev\/shm\/hydra-worktrees\/hydra-betting-worktree-\$\{CYCLE_ID\}"/,
    );
  });

  test("verifies isolation with git rev-parse before proceeding", () => {
    // Without this verification, a worktree-add failure would silently fall
    // through to writes against the main checkout. The reporter in the #542
    // research transcript caught this only after the fact via auto-stash.
    // The rev-parse commands and both ABORT messages are KEPT VERBATIM.
    assert.match(playbook, /git rev-parse --git-common-dir/);
    assert.match(playbook, /git rev-parse --git-dir/);
    assert.match(playbook, /ABORT: hydra-betting worktree common-dir/);
    assert.match(playbook, /ABORT: hydra-betting cwd is not a worktree/);
  });

  test("execute step keeps the child in the worktree (no plain cd into ~/hydra-betting)", () => {
    // The pre-#542 playbook contained `cd ~/hydra-betting && git checkout main`
    // in the execute step. That direct-to-main-tree command is the bug. There
    // is no single command string for the *absence* of that command, so we
    // assert a RELAXED keyword form: the playbook still tells the child to
    // stay in the worktree and not `cd ~/hydra-betting`. Heading wording and
    // issue-number cross-refs are intentionally not pinned.
    assert.match(playbook, /do NOT `cd ~\/hydra-betting`/);
  });

  test("verifies edits landed in the worktree (the reporter's `git diff` canary)", () => {
    // The reporter (item-472) suggested a `git diff` post-edit check; we kept
    // that as a defense-in-depth signal even though the primary fix is the
    // worktree itself. The command string is the canary — the surrounding
    // sanity-check prose is cosmetic and no longer asserted.
    assert.match(playbook, /git diff --name-only/);
  });

  test("removes the worktree on success", () => {
    // Leaking on crash is acceptable (branch-prune.sh will GC it), but on the
    // happy path we should clean up so /dev/shm doesn't fill with stale dirs.
    // The remove invocation is KEPT VERBATIM; the heading is not pinned.
    assert.match(playbook, /git -C ~\/hydra-betting worktree remove --force "\$TARGET_WT"/);
  });
});

describe("hydra-autopilot playbook — dev_target preamble (issue #542)", () => {
  const playbook = readRepoFile("docs/operator-playbooks/hydra-autopilot.md");

  test("preamble keeps the dev_target two-repo isolation safety substance", () => {
    // The pre-#542 preamble only warned about cwd == ~/hydra-betting, which
    // never triggered for dev_target dispatches (cwd was the orchestrator
    // worktree, not ~/hydra-betting). The safety substance is that the
    // dev_target preamble still routes through the rev-parse worktree
    // verification. We assert the load-bearing rev-parse command string rather
    // than the exact "TARGET-REPO SAFETY RULE" heading or step-number cross-ref,
    // both of which are cosmetic. (The preamble writes it as
    // `git -C <worktree> rev-parse --git-common-dir`, so we match the stable
    // command fragment that survives the `-C <worktree>` interpolation.)
    assert.match(playbook, /rev-parse --git-common-dir/);
  });
});

describe("scripts/branch-prune.sh — two-repo sweep (issue #542)", () => {
  const script = readRepoFile("scripts/branch-prune.sh");

  test("defines a prune_repo function callable per-repo", () => {
    // Refactoring the body into a function is the load-bearing change — it's
    // what lets us run the same classifier against ~/hydra and ~/hydra-betting
    // without duplicating the safety rails.
    assert.match(script, /^prune_repo\(\) \{/m);
  });

  test("invokes prune_repo against both the orchestrator and the target", () => {
    assert.match(script, /prune_repo "orchestrator" "\$REPO_ROOT"/);
    assert.match(script, /prune_repo "target" "\$TARGET_REPO"/);
  });

  test("target repo path is overridable via HYDRA_TARGET_REPO for test setups", () => {
    // The default is ~/hydra-betting but a CI environment may want to point
    // at a fixture repo. Without the env-var indirection, tests would have to
    // populate the real path.
    assert.match(script, /TARGET_REPO="\$\{HYDRA_TARGET_REPO:-\$HOME\/hydra-betting\}"/);
  });

  test("missing target repo is a silent no-op (no exit)", () => {
    // Some operators may run hydra without a target. The script must not
    // explode in that case — it should skip the pass and continue.
    assert.match(script, /has no \.git — skipping/);
  });
});
