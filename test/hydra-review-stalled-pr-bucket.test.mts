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

  test("the Rules drain-order bullet places the bucket first, before ready-for-human", () => {
    // Pins INV-4 (updated by #4621, ADR-0034 §8.1): the canonical drain-order
    // string in ## Rules must open with this bucket.
    //
    // Issue #4179 retargeted this from its original left-neighbour ("...
    // un-ticketed specs -> stalled PRs (§0.9) -> ..."), and #4621 retired the
    // overnight operator-decision queue that used to precede it (ADR-0034
    // §8.1: hydra-grill now posts its gate-fail handoff on the anchor issue
    // instead of writing a dated queue issue) — so §0.9 is now the FIRST
    // bucket drained, not the second. §0.9's POSITION is what this pins --
    // first, immediately before ready-for-human -- not the identity of
    // whatever used to precede it.
    assert.match(
      src,
      /Drain order: stalled PRs \(§0\.9\) → Orchestrator ready-for-human/,
      "the drain-order bullet must place 'stalled PRs (§0.9)' first, before 'Orchestrator ready-for-human'",
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

  test("the required set is read live from branch protection, never a hardcoded count (#4850)", () => {
    const section = stalledSection();
    // INV-2: "Required" = the branch-protection set, not "all checks". A
    // hardcoded "exactly seven" list went stale when design-concept-reconcile
    // became required, so the playbook must read the set live per repo (the
    // Target's default branch is `main`, not `master`) and treat a required
    // context with no check run as not green.
    assert.doesNotMatch(section, /exactly (seven|eight|\d+) contexts/i, "no hardcoded required-check count");
    assert.match(section, /defaultBranchRef/, "resolve each repo's default branch, not a hardcoded master");
    assert.match(
      section,
      /repos\/\$RREPO\/branches\/\$DEFAULT\/protection\/required_status_checks/,
      "read the live required set from the branch-protection endpoint per repo",
    );
    assert.match(section, /MISSING/, "a required context with no check run must surface as MISSING, never green");
    // The illustrative list must stay current: it names design-concept-reconcile.
    for (const ctx of ["test", "deep-qa-gate", "design-concept-reconcile"]) {
      assert.match(section, new RegExp(`\\b${ctx}\\b`), `the illustrative list must name '${ctx}'`);
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

  test("the four canonical options are present, and Land-it carries BOTH merge mechanisms", () => {
    const section = stalledSection();
    // INV-5 (revised by #4185): the drain loop now offers the canonical
    // four — Land it / Update branch / Close / Skip — via AskUserQuestion,
    // whose 4-option ceiling cannot fit the previous five.
    //
    // "Land it" COLLAPSES the old "Merge now" + "Enable auto-merge" pair: they
    // were the same operator intent, differing only on whether required checks
    // were already green, which the skill already knows. Both mechanisms must
    // therefore still be documented INSIDE the Land-it option — the collapse is
    // in the operator's choice, never in the commands available — so these two
    // assertions are unchanged from the pre-#4185 five-option contract.
    assert.match(section, /gh pr update-branch/, "Update branch option must be present");
    assert.match(section, /gh pr merge <PR> --auto/, "the arm-auto-merge mechanism must survive inside Land it");
    assert.match(section, /gh pr merge <PR> --squash/, "the merge-now mechanism must survive inside Land it");
    assert.match(
      section,
      /\*\*Land it\*\*/,
      "the canonical slot-1 option label must be 'Land it' (issue #4185 option table)",
    );
    assert.match(
      section,
      /required checks/i,
      "Land it must state that the mechanism is chosen by required-check state, not guessed",
    );
    assert.match(section, /Do not auto-resolve/, "the Update branch option must forbid auto-resolving a real conflict");
    assert.match(
      section,
      /No path here re-bases or merges automatically/,
      "the bucket must state no merge/rebase fires without an explicit operator pick — no auto-rebase / auto-resolve / auto-merge",
    );
  });
});

/**
 * Issue #5058 — an operator resolution that hands an Orchestrator stalled PR
 * back to an autonomous lane must clear the PR's OWN stranding labels. Both
 * durable resume picks skip a `ready-for-human` PR and the #4807 conflict lane
 * never re-attempts a `conflict-fix-attempted` one, so an issue-only relabel
 * stranded PRs #4810 / #4818 for 8+ days after "fix forward" decisions.
 */
describe("hydra-review playbook — hand-back clears the PR's stranding labels (issue #5058)", () => {
  function handBackRule(): string {
    const section = stalledSection();
    const start = section.indexOf("clears the PR's");
    assert.ok(start > -1, "§0.9 must carry the #5058 PR-side stranding-label rule");
    return section.slice(start);
  }

  test("the rule names every hand-back resolution: fix forward, slot-1 'Fix and push', needs-dev-resume / needs-qa", () => {
    const rule = handBackRule();
    assert.match(rule, /fix forward/i);
    assert.match(rule, /Fix and push/);
    assert.match(rule, /needs-dev-resume/);
    assert.match(rule, /needs-qa/);
  });

  test("the recipe removes BOTH ready-for-human and conflict-fix-attempted from the PR itself", () => {
    const rule = handBackRule();
    const recipe = /```bash\n([\s\S]*?)```/.exec(rule);
    assert.ok(recipe, "the rule must carry a concrete bash recipe block");
    const body = recipe[1];
    assert.match(body, /for L in ready-for-human conflict-fix-attempted/, "both stranding labels are cleared");
    // Name-in-URL-path DELETE on the PR number — the `-f name=` form wipes ALL labels.
    assert.match(body, /gh api -X DELETE "repos\/\$RREPO\/issues\/\$PR\/labels\/\$L"/);
    assert.doesNotMatch(body, /gh pr edit/, "gh pr edit is broken for labels — never use it");
    assert.doesNotMatch(body, /gh api[^\n]*-f name=/, "the -f name= DELETE form wipes every label");
    // The linked issue is routed too.
    assert.match(body, /gh issue edit "\$ISSUE" --repo "\$RREPO" --remove-label ready-for-human --add-label "\$LANE"/);
  });

  test("the label DELETE fails loud: only an HTTP 404 is tolerated, anything else aborts before the issue relabel (QA round 1)", () => {
    const rule = handBackRule();
    const recipe = /```bash\n([\s\S]*?)```/.exec(rule);
    assert.ok(recipe, "the rule must carry a concrete bash recipe block");
    const body = recipe[1];
    // No silent swallow: discarding stderr behind an `||` fallback reports
    // every failure (auth, rate limit, network) as a harmless 404.
    assert.doesNotMatch(body, /2>\/dev\/null/, "the DELETE must not discard stderr");
    assert.doesNotMatch(body, /--silent[^\n]*\|\|/, "the DELETE must not swallow failures with an || fallback");
    // stderr is captured and only a 404 / "Label does not exist" is tolerated.
    assert.match(body, /ERR=\$\(gh api -X DELETE [^\n]*2>&1\)/, "the DELETE's stderr must be captured");
    assert.match(body, /grep -qE 'HTTP 404\|Label does not exist'/, "only a 404 is tolerated");
    // Any other failure prints the error and exits non-zero.
    assert.match(body, /could not remove[^\n]*>&2\n\s*exit 1/, "a non-404 failure must print and exit non-zero");
    // The PR's labels are re-read; the issue relabel is refused while a
    // stranding label is still present.
    assert.match(body, /gh api "repos\/\$RREPO\/issues\/\$PR\/labels"/, "the PR's labels must be re-read");
    assert.match(body, /still carries[^\n]*NOT relabelled/);
    // Ordering: every abort sits BEFORE the issue relabel.
    const relabel = body.indexOf('gh issue edit "$ISSUE"');
    const lastExit = body.lastIndexOf("exit 1");
    assert.ok(relabel > -1 && lastExit > -1 && lastExit < relabel, "every abort must precede the issue relabel");
  });

  test("a QA round-cap escalation (#4735) the operator keeps is explicitly NOT a hand-back", () => {
    assert.match(handBackRule(), /#4735[\s\S]{0,120}NOT a hand-back/);
  });

  test("§4's #4739 Target fix-forward text cross-references the Orchestrator analogue", () => {
    const start = src.indexOf("**Fix-forward resolution stamps `needs-dev-resume` (issue #4739).**");
    assert.ok(start > -1, "the #4739 Target fix-forward paragraph must exist");
    const end = src.indexOf("### 5. Wrap-up", start);
    assert.match(src.slice(start, end), /#5058/);
  });
});
