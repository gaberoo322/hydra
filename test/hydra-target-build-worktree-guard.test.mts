/**
 * Regression test for issue #542 — worktree-isolation gap for hydra-target-build.
 *
 * Background: the harness `isolation: "worktree"` only worktree-isolates the
 * orchestrator repo (`~/hydra`). When `hydra-target-build` then writes to the
 * Target workspace, those edits land on the main checkout unless the skill
 * explicitly creates a target worktree. Issue #542 closed that gap by
 * adding a Step 0.6 to the `hydra-target-build` playbook that opens a
 * `git worktree` under the Target workspace, symmetric with how `hydra-dev`
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
 * Issue #4411 re-sourced every target-identity literal in this playbook
 * (`~/hydra-betting`, `gaberoo322/hydra-betting`, a hardcoded `web/`
 * worktree nesting) through the `_fragments/target-seam-preamble.md`-resolved
 * `$TARGET_WS` / `$TARGET_APP_DIR` / `$TARGET_GH_REPO` seam vars, so the
 * canaries below assert the SEAM-VAR composition (`$TARGET_WS`,
 * `$TARGET_APP_DIR/.worktrees/...`) rather than the old hardcoded
 * `~/hydra-betting/web/.worktrees` literal — flipped in the same PR that
 * deleted decide.py's WIRE_OR_RETIRE_RISK_CARVEOUT constant.
 *
 * Companion guard for `scripts/branch-prune.sh`: assert it now sweeps the
 * target repo too, so the new target worktrees we create above are
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
  // Issue #4476 INV-6: the canonical create+verify block moved into a shared
  // fragment that Step 0.6 (and the autopilot's self-isolation preamble)
  // @include, so there is exactly ONE worktree-create/verify source. The
  // load-bearing command strings are asserted against the fragment.
  const FRAGMENT_REL = "_fragments/target-self-isolation-preamble.md";
  const fragment = readRepoFile(`docs/operator-playbooks/${FRAGMENT_REL}`);
  const includeLine = /^@include _fragments\/target-self-isolation-preamble\.md$/m;

  test("both hydra-target-build.md and hydra-autopilot.md @include the shared create+verify fragment", () => {
    assert.match(playbook, includeLine, "hydra-target-build.md Step 0.6 must @include the fragment");
    const step06 = playbook.slice(playbook.indexOf("### 0.6."), playbook.indexOf("### 0.5."));
    assert.match(step06, includeLine, "the @include must sit inside Step 0.6");
    assert.match(
      readRepoFile("docs/operator-playbooks/hydra-autopilot.md"),
      includeLine,
      "hydra-autopilot.md must @include the fragment as the self-isolation preamble",
    );
    // sync-skills @include is single-level: the fragment must not nest one.
    assert.doesNotMatch(fragment, /^[ \t]*@include/m);
    // No Target-identity literal in the fragment (INV-8).
    assert.doesNotMatch(fragment, /hydra-betting/);
  });

  test("the fragment's worktree base ref defaults to origin/main and is overridable", () => {
    assert.match(fragment, /TARGET_WT_BASE="\$\{TARGET_WT_BASE:-origin\/main\}"/);
    assert.match(fragment, /worktree add -b "feature\/\$\{CYCLE_ID\}" "\$TARGET_WT" "\$TARGET_WT_BASE"/);
  });

  test("creates a git worktree under $TARGET_APP_DIR/.worktrees, GC-able and node_modules-symlink-free", () => {
    // The load-bearing invocation: `git -C "$TARGET_WS" worktree add ...`
    // with a $TARGET_WT nested under `$TARGET_APP_DIR/.worktrees/` (issue
    // #4177 — relocated off `/dev/shm/hydra-worktrees/hydra-betting-worktree-*`
    // to eliminate the reach-back node_modules symlink hazard, #4175; issue
    // #4411 generalized the literal `web/` nesting to the seam-resolved
    // $TARGET_APP_DIR so the SAME fix applies to a target whose manifest
    // declares a different — or empty — appSubdir) so the existing
    // branch-prune sweep can still GC it AND Node's upward module-resolution
    // walk finds the real $TARGET_APP_DIR/node_modules as an ancestor with no
    // symlink. KEPT VERBATIM — these strings are the real canary, not the
    // surrounding heading.
    assert.match(
      fragment,
      /git -C "\$TARGET_WS" worktree add -b "feature\/\$\{CYCLE_ID\}"/,
    );
    assert.match(
      fragment,
      /TARGET_WT="\$TARGET_APP_DIR\/\.worktrees\/\$\{CYCLE_ID\}"/,
    );
  });

  test("Step 0.6 no longer runs an UNCONDITIONAL per-worktree npm install (issue #4177)", () => {
    // Step 0.6 used to `npm ci` into $TARGET_WT/$APP_SUBDIR on EVERY worktree
    // creation, before the relocation — the RAM-hungry alternative the issue
    // explicitly rejected. With the worktree nested under web/, node_modules
    // resolves via the ancestor walk instead, so Step 0.6 itself must not
    // install anything: the install line (below) may still exist, but ONLY
    // inside the Step 6 conditional (see next test).
    const step06 = playbook.slice(playbook.indexOf("### 0.6."), playbook.indexOf("### 0.5."));
    assert.doesNotMatch(
      step06,
      /eval "\$INSTALL_CMD --no-audit --no-fund"/,
      "Step 0.6 must not unconditionally install — node_modules resolves by ancestor walk",
    );
  });

  test("Step 6's local install is decided by the mirrored leaf, not hand-rolled bash (issues #4177, #4526)", () => {
    // A Target PR that adds/bumps a dependency needs it installed somewhere
    // verify can find it — but the worktree must never write into the shared
    // ancestor node_modules. #4177 gated a JIT local install on whether
    // package.json/package-lock.json actually changed; #4526 moves the GATE
    // itself into the pure decision leaf (scripts/target/verify-install-decision.ts,
    // mirrored to $HYDRA_GATE_DIR) so the same code that owns the new
    // result-driven trigger also owns the lockfile trigger — the playbook
    // feeds it facts and reads {action, reason}, never re-derives the call.
    assert.match(
      playbook,
      /git diff --quiet origin\/main -- package\.json package-lock\.json \|\| LOCKFILE_CHANGED=true/,
      "the lockfile-diff fact must still be computed against origin/main",
    );
    assert.match(
      playbook,
      /node "\$HYDRA_GATE_DIR\/scripts\/target\/verify-install-decision\.ts" \\\n\s+--app-dir "\$PWD" --lockfile-changed "\$LOCKFILE_CHANGED"/,
      "the lockfile trigger routes through the decision leaf with --lockfile-changed, BEFORE the verify ladder",
    );
    assert.doesNotMatch(
      playbook,
      /if ! git diff --quiet origin\/main -- package\.json package-lock\.json; then/,
      "the install gate is no longer hand-rolled in bash — the leaf owns it (#4526)",
    );
    assert.match(
      playbook,
      /eval "\$INSTALL_CMD --no-audit --no-fund"/,
      "the install-then-retry branch must still run the manifest-declared install command",
    );
  });

  test("verifies isolation with git rev-parse before proceeding", () => {
    // Without this verification, a worktree-add failure would silently fall
    // through to writes against the main checkout. The reporter in the #542
    // research transcript caught this only after the fact via auto-stash.
    // The rev-parse commands and both ABORT messages are KEPT VERBATIM.
    assert.match(fragment, /git rev-parse --git-common-dir/);
    assert.match(fragment, /git rev-parse --git-dir/);
    assert.match(fragment, /ABORT: target worktree common-dir/);
    assert.match(fragment, /ABORT: target cwd is not a worktree/);
  });

  test("execute step keeps the child in the worktree (no plain cd into the Target workspace)", () => {
    // The pre-#542 playbook contained `cd ~/hydra-betting && git checkout main`
    // in the execute step. That direct-to-main-tree command is the bug. There
    // is no single command string for the *absence* of that command, so we
    // assert a RELAXED keyword form: the playbook still tells the child to
    // stay in the worktree and not `cd` into the Target workspace ($TARGET_WS,
    // issue #4411 — the seam-resolved var replacing the old hardcoded literal).
    // Heading wording and issue-number cross-refs are intentionally not pinned.
    assert.match(playbook, /do NOT `cd` into `\$TARGET_WS`/);
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
    // happy path we should clean up so $TARGET_APP_DIR/.worktrees/ doesn't
    // fill with stale dirs. The remove invocation is KEPT VERBATIM (issue
    // #4411 flipped it from the hardcoded `git -C ~/hydra-betting` form to
    // the seam-resolved `$TARGET_WS`); the heading is not pinned.
    assert.match(playbook, /git -C "\$TARGET_WS" worktree remove --force "\$TARGET_WT"/);
  });
});

describe("hydra-autopilot playbook — self-isolation preamble (issues #542, #4476)", () => {
  // The two-repo isolation preamble lives in the shared fragment the autopilot
  // playbook @includes (issue #4476); sync-skills expands it into the skill.
  const playbook =
    readRepoFile("docs/operator-playbooks/hydra-autopilot.md") +
    readRepoFile("docs/operator-playbooks/_fragments/target-self-isolation-preamble.md");

  test("preamble keeps the self-isolated two-repo isolation safety substance", () => {
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
