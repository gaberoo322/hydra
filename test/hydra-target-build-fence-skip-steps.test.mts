/**
 * Regression pins for issue #4224 — the operator-review fence's step-skip
 * carve-out (the advisory finding of the #4230 QA review) — and for issue
 * #4558 — the fence lookup's PR-own-labels subject.
 *
 * The fenced branch of the merge-flow fragment's 7b decision table tells the
 * build agent which post-merge steps to skip when handing a fenced PR to the
 * operator. The merged wording enumerated the skip as a range — "Steps
 * 7.5–8.6" — one sentence after an explicit carve-out said local worktree
 * cleanup (Step 8.5) "is safe and should still run". 8.5 sits numerically
 * inside that range, so the two statements contradict each other, and a
 * build agent that reads the range over the carve-out leaks the worktree and
 * its branch claim on every fenced handoff. These pins hold the skip list to
 * the QA-suggested explicit enumeration.
 *
 * The #4558 pins hold the fence lookup to its full predicate: the reporting
 * Target's CI applies the fencing label to the PR ITSELF (inside the very CI
 * run the merge phase keys off), while the source issue carried none — so a
 * lookup that resolves only issue/anchor labels releases the build's explicit
 * merge on exactly the PR the workflow's fence withheld. The lookup must read
 * the PR's own labels, fail closed on that read like every other, and time
 * the read against the labelling CI job's conclusion.
 *
 * Companion to the fail-closed lookup pins in test/sync-target-gate.test.mts
 * (open PR #4232) — this file deliberately does not touch that one, so the
 * two PRs merge without textual conflicts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRAGMENT_PATH =
  "docs/operator-playbooks/_fragments/hydra-target-build-merge-flow.md";
const FRAGMENT = readFileSync(join(REPO_ROOT, FRAGMENT_PATH), "utf-8");
const PLAYBOOK_PATH = "docs/operator-playbooks/hydra-target-build.md";
const PLAYBOOK = readFileSync(join(REPO_ROOT, PLAYBOOK_PATH), "utf-8");

test("the fenced branch step-skip list names its steps and excludes Step 8.5 (#4224, #4230 QA advisory)", () => {
  // The skip enumeration must be the explicit list ...
  assert.match(
    FRAGMENT,
    /Skip Steps 7\.5, 8, and 8\.6 — NOT Step 8\.5/,
    "the fenced skip list must enumerate 7.5, 8, and 8.6 explicitly, excluding 8.5",
  );
  // ... and the range form that numerically swallows Step 8.5 must not
  // return as an instruction.
  assert.doesNotMatch(
    FRAGMENT,
    /Skip Steps 7\.5–8\.6/,
    "a 'Skip Steps 7.5–8.6' range contradicts the Step 8.5 carve-out one bullet above",
  );
});

test("the fenced branch still carves out local worktree cleanup while skipping the merged-PR steps (#4224)", () => {
  assert.match(
    FRAGMENT,
    /Local worktree cleanup \(Step 8\.5\)\s*is safe and should still run\./,
    "the fenced branch must keep the explicit Step 8.5 carve-out",
  );
});

test("the fence lookup reads the PR's OWN labels — fail-closed like every other read (#4558)", () => {
  // On the reporting Target the fencing label is applied by the Target's CI
  // to the PR ITSELF; the source issue and the anchor carried none. The
  // workflow's fence reads the PR's own labels before anything else, so a
  // build-side lookup without that read desyncs from the workflow predicate.
  assert.match(
    FRAGMENT,
    /if ! PR_LABELS=\$\(gh pr view "\$PR_NUM" --repo "\$TARGET_GH_REPO"/,
    "the PR's own labels must be read through the same fail-closed exit-code branch as every other label read",
  );
  assert.match(
    FRAGMENT,
    /PR_HIT=\$\(printf '%s\\n' "\$PR_LABELS"[\s\S]*?grep -xE 'money-critical\|hold-for-operator' \|\| true\)/,
    "the PR-label read must grep the same literal fencing set as the issue read (predicate alignment)",
  );
  assert.match(
    FRAGMENT,
    /FENCED="\$FENCED PR #\$PR_NUM itself \(\$PR_HIT\)"/,
    "a PR-own-label hit must land in $FENCED, naming the PR itself as the fenced subject",
  );
});

test("the PR-label read is timed against the labelling CI job — valid only after that CI concluded (#4558)", () => {
  // The fencing label lands on the PR DURING the PR's CI run (the labelling
  // job classifies the diff inside that same run). A label read racing an
  // in-flight run mistakes a not-yet-applied fence for absence.
  assert.match(
    FRAGMENT,
    /only valid\s+after that run CONCLUDED/,
    "the lookup must tie the PR-label read to the conclusion of the CI run that applies the label",
  );
});

test("the fence-holds branch names the PR itself as a fencing subject (#4558)", () => {
  assert.match(
    FRAGMENT,
    /the PR itself, any same-repo\s+issue it links, or the anchor carries/,
    "the fenced branch's subject list must include the PR's own labels",
  );
});

test("a merged PR carrying a fencing label on ITSELF is the fence working, not a breach (#4558)", () => {
  // The workflow's fence reads the PR's own labels first, so it can never be
  // the one that merged a PR carrying its own fencing label — a human did.
  // The breach rule stays scoped to an anchor hit the workflow cannot see.
  assert.match(
    FRAGMENT,
    /A hit on the\s+PR's OWN labels, or on any issue among `\$LINKED`, means exactly that/,
    "a PR-own-label hit on a merged PR must read as operator-merged success",
  );
});

test("a PR-own-label fencing hit is never fence-blind — no draft/Closes remediation for it (#4558)", () => {
  // The draft-mark + Closes-link remediation exists for the anchor-hit case
  // the workflow's fence cannot resolve; a PR-own-label hit is directly
  // visible to the workflow, so the remediation must not be applied to it.
  assert.match(
    FRAGMENT,
    /A hit on the PR's own labels is never fence-blind/,
    "the remediation must stay scoped to the anchor-only unlinked case",
  );
});

test("the explicit-merge branch requires the lookup to have succeeded across the PR's own labels too (#4558)", () => {
  assert.match(
    FRAGMENT,
    /SUCCEEDED\s+across the PR's own labels, every linked issue AND the anchor/,
    "the only branch that may merge must be gated on every fence subject resolving cleanly",
  );
});

test("the close-discipline note no longer claims the workflow resolves labels ONLY through linked issues (#4558)", () => {
  // The workflow reads the PR's own labels directly; the Closes link is
  // load-bearing for the ANCHOR's labels specifically. A description that
  // says "only through the PR's linked issues" is stale for any Target whose
  // workflow reads PR labels, and hides the #4558 gap it caused.
  assert.match(
    FRAGMENT,
    /reads the PR's own labels directly/,
    "the workflow-fence description must acknowledge the direct PR-label read",
  );
  assert.match(
    FRAGMENT,
    /without the `Closes #<ANCHOR_NUM>` link the workflow's fence cannot see the anchor/,
    "the Closes-link load-bearing phrase must survive the description fix",
  );
});

test("the merge-phase context pointer names the PR's own labels as a fence subject (#4558)", () => {
  assert.match(
    PLAYBOOK,
    /the PR's own labels first/,
    "the playbook's fence summary must lead with the PR's own labels",
  );
});

test("the fenced branch's detect-at-the-source and do-not-remove bullets cover the PR's own label (#4558)", () => {
  assert.match(
    FRAGMENT,
    /Detect the fence at the source\*\* \(the PR's own labels plus the linked/,
    "the detect-at-the-source sentence must name the PR's own labels as a resolved subject",
  );
  assert.match(
    FRAGMENT,
    /Do NOT remove the fencing label\*\* from the issue or from the PR itself/,
    "the do-not-remove bullet must cover the PR's label too (the operator's release lever)",
  );
});
