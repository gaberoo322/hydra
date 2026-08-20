/**
 * Drift-guard regression test for issue #3963 — pins the **Stalled PRs** bucket
 * in docs/operator-playbooks/hydra-review.md.
 *
 * The defect this closes: a PR that is green but unmergeable (a merge conflict)
 * OR mergeable + green but never armed for auto-merge is invisible to every
 * surface Hydra had — it is not an issue (so no /hydra-review bucket walked it),
 * its checks pass (so nothing alarms), and a conflict raises no signal at all.
 * Four such PRs sat unexamined on 2026-08-11. The fix is a new §0.9 bucket in
 * the operator cockpit that gathers both failure modes across the Orchestrator
 * AND every Target repo and drains them in the same one-at-a-time loop.
 *
 * This is the drift-guard-as-test pattern (a test in the REQUIRED `test` npm
 * job actually gates; a sibling advisory workflow cannot —
 * `feedback_drift_guard_as_test_not_workflow`), mirroring
 * test/target-wire-or-retire-lane-invariant.test.mts and test/deploy-drift.test.mts:
 * readFileSync + regex assertions against the in-repo PLAYBOOK source only.
 *
 * Hard constraints (per the approved design-concept artifact `issue-3963`):
 *   - reads the in-repo PLAYBOOK (docs/operator-playbooks/hydra-review.md), NEVER
 *     the generated skill artifact under ~/.claude/skills/ — only one SKILL.md is
 *     tracked in this repo, so a generated-artifact assertion would read a file
 *     that doesn't exist in a fresh worktree (the worktree-local doc-drift flake);
 *   - makes NO `gh api` call — a live PR read would burn the `gh` quota a running
 *     autopilot shares and go ambiently red.
 *
 * Pins (acceptance criterion 3): the bucket section exists, BOTH predicates
 * (conflicted / unshepherded) are defined, the UNKNOWN caveat, and the
 * required-vs-advisory caveat (naming advisory-checks as excluded).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLAYBOOK = join(REPO_ROOT, "docs", "operator-playbooks", "hydra-review.md");

const src = readFileSync(PLAYBOOK, "utf-8");

/** Slice the §0.9 section: from its heading up to the next ### heading (§1). */
function stalledSection(): string {
  const start = src.indexOf("### 0.9. Drain stalled PRs");
  assert.ok(start > -1, "§0.9 heading not found — the Stalled PRs bucket section is missing");
  const end = src.indexOf("### 1. Gather (Orchestrator)");
  assert.ok(end > start, "could not locate the §1 heading that terminates §0.9");
  return src.slice(start, end);
}

describe("hydra-review playbook — Stalled PRs bucket (issue #3963)", () => {
  test("the §0.9 bucket section exists", () => {
    assert.match(
      src,
      /### 0\.9\. Drain stalled PRs/,
      "the Stalled PRs bucket must be its own numbered procedure section",
    );
  });

  test("the bucket appears in the top-of-file Buckets-in-drain-order list", () => {
    const listEnd = src.indexOf("## Procedure");
    assert.ok(listEnd > -1, "could not locate the ## Procedure heading");
    const bucketList = src.slice(0, listEnd);
    assert.match(
      bucketList,
      /\bStalled PRs\b/,
      "the Stalled PRs bucket must be listed in the 'Buckets, in drain order' list",
    );
  });

  test("the bucket appears in the §2 presentation table", () => {
    assert.match(
      src,
      /### Stalled PRs\b/,
      "the Stalled PRs bucket must have a presentation-table block in §2",
    );
  });

  test("the Rules drain-order bullet places the bucket after the queue and before ready-for-human", () => {
    // Pins INV-4: the canonical drain-order string in ## Rules must thread this
    // bucket between the overnight queue and ready-for-human.
    //
    // Issue #4179 retargeted this from its original left-neighbour. The bullet
    // used to read "... un-ticketed specs -> stalled PRs (§0.9) -> ...", but the
    // four wayfinder/spec buckets it named were deleted: three of their gating
    // labels (wayfinder:destination-pending, wayfinder:handoff-pending,
    // needs-tickets) had never been applied to a single issue in the repo's
    // history. §0.9's POSITION is what this pins -- immediately after the
    // overnight queue, immediately before ready-for-human -- not the identity of
    // whatever happens to precede it.
    assert.match(
      src,
      /overnight queue → stalled PRs \(§0\.9\) → Orchestrator ready-for-human/,
      "the drain-order bullet must place 'stalled PRs (§0.9)' after the overnight queue and before 'Orchestrator ready-for-human'",
    );
  });

  test("both predicates are defined — conflicted (CONFLICTING) and unshepherded (MERGEABLE + autoMerge null)", () => {
    const section = stalledSection();
    assert.match(
      section,
      /mergeable == "CONFLICTING"/,
      "the conflicted predicate must key on mergeable == CONFLICTING",
    );
    assert.match(
      section,
      /mergeable == "MERGEABLE"/,
      "the unshepherded predicate must key on mergeable == MERGEABLE",
    );
    assert.match(
      section,
      /autoMergeRequest == null/,
      "the unshepherded predicate must require autoMergeRequest == null",
    );
  });

  test("the UNKNOWN caveat: UNKNOWN is treated as no-verdict, never conflicted", () => {
    const section = stalledSection();
    assert.match(
      section,
      /mergeable == "UNKNOWN"/,
      "the UNKNOWN caveat must name the UNKNOWN mergeable state",
    );
    assert.match(
      section,
      /no verdict/i,
      "the UNKNOWN caveat must state UNKNOWN is 'no verdict', never conflicted — reporting it as a conflict cries wolf on every freshly-pushed PR",
    );
  });

  test("the required-vs-advisory caveat: advisory-checks is named and excluded from the predicate", () => {
    const section = stalledSection();
    assert.match(
      section,
      /advisory-checks/,
      "the caveat must name advisory-checks — it is ambient red on master and must never count toward the unshepherded predicate",
    );
    assert.match(
      section,
      /NEVER count|never count/i,
      "the caveat must state advisory-checks must never count toward the predicate",
    );
  });

  test("the required set is exactly the seven branch-protection contexts", () => {
    const section = stalledSection();
    // INV-2: "Required" = the branch-protection set, not "all checks". Pin all
    // seven so a future edit that drops one (or adds advisory-checks) drifts loud.
    for (const ctx of [
      "test",
      "dashboard-build",
      "tier-gate",
      "mutation-test",
      "scope-check",
      "secret-scan",
      "deep-qa-gate",
    ]) {
      assert.match(
        section,
        new RegExp(`\\b${ctx}\\b`),
        `the required-vs-advisory caveat must name the branch-protection context '${ctx}'`,
      );
    }
  });

  test("the gather loops over the Orchestrator AND every Target repo in the same step", () => {
    const section = stalledSection();
    // INV-3: Target stalled-PR coverage is gathered in the SAME new step as the
    // Orchestrator (mirroring §1.5's TARGET_REPOS array), not deferred to the
    // end-of-session per-Target phase.
    assert.match(
      section,
      /gaberoo322\/hydra/,
      "the gather must cover the Orchestrator repo gaberoo322/hydra",
    );
    assert.match(
      section,
      /HYDRA_TARGET_GITHUB_REPO/,
      "the gather must mirror §1.5's TARGET_REPOS enumeration so every configured Target repo is covered in the same step",
    );
  });

  test("the five resolution options are present, including the two merge paths", () => {
    const section = stalledSection();
    // INV-5: the drain loop offers Update branch / Enable auto-merge / Merge now
    // / Close / Skip, and no merge fires without the operator picking one.
    assert.match(section, /gh pr update-branch/, "Update branch option must be present");
    assert.match(section, /gh pr merge <PR> --auto/, "Enable auto-merge option must be present");
    assert.match(section, /gh pr merge <PR> --squash/, "Merge now option must be present");
    assert.match(section, /Do not auto-resolve/, "the Update branch option must forbid auto-resolving a real conflict");
    assert.match(
      section,
      /No path here re-bases or merges automatically/,
      "the bucket must state no merge/rebase fires without an explicit operator pick — no auto-rebase / auto-resolve / auto-merge",
    );
  });
});
