"""reap_stall.py — dev_orch/dev_target stall-recovery handlers for
scripts/autopilot/reap.py (issue #4398, the architecture-scan follow-on to
#4366/#4367's reap.py split). See PR #4399 for the design-concept
reconciliation against artifact ac7ab343f7df90c5.

Owns the three `run_completion` post-accounting side effects that detect a
code-writing dispatch that ended its session without opening (or advancing)
a PR, and recover the anchor so the next autopilot turn doesn't silently
re-pay the same work from scratch:

  - `_handle_dev_orch_stall` (issue #3866) — relabel a dev_orch completion
    with no open PR to `needs-dev-resume` and queue a pinned resume.
  - `_handle_dev_orch_needs_qa_promotion` (issue #4045) — advance
    ready-for-agent -> needs-qa once a dev_orch completion's PR actually
    closes the anchor.
  - `_handle_dev_target_stall` (issue #4195) — release a dev_target
    completion with no closing PR back to `ready-for-agent` so ADR-0031
    Decision 4's WIP cap doesn't deadlock the whole class on an orphaned
    claim.

Imported by reap.py via a guarded `sys.path` insert + name-binding import
(mirrors reap_state.py's existing pattern) — never via attribute access, so
`reap._handle_dev_orch_stall = spy`-style monkeypatching (if any test ever
does it) keeps working on the reap.py side. This module itself imports ONLY
from the sibling leaves `reap_ghrefs` (the `gh` seam + PR/issue predicates)
and `reap_state` (`_append_log`, `save_state`) — never from `reap` — which is
exactly what avoids the import cycle a naive "move only the three handlers"
slice would hit: reap.py imports reap_stall at module top, so a `from reap
import ...` here would re-enter reap.py's own module init a second time
under both `python3 reap.py` (running module is `__main__`) and the
importlib-by-path test loaders. This module is a library, not a CLI: no
shebang, no `__main__` block, no exec bit — matching the reap_state.py /
reap_ghrefs.py precedent for a shared leaf.
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

# Same guarded sys.path insert reap.py itself uses for reap_state (issue
# #4366) — this module is loaded by BOTH `python3 reap.py`-style execution
# (where reap.py's own insert already ran) and the importlib-by-path test
# loader (cwd = repo root, sys.path[0] == ''), which loads reap_stall.py
# directly without ever running reap.py's header. Without this insert, a
# bare `from reap_ghrefs import ...` / `from reap_state import ...` would
# raise ModuleNotFoundError under that loader.
_SCRIPT_DIR = str(Path(__file__).resolve().parent)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
from reap_ghrefs import (
    REPO,
    TARGET_REPO,
    _anchor_issue_is_closed,
    _dev_orch_pr_closes_anchor,
    _dev_orch_pr_exists_for_anchor,
    _gh_run,
)
from reap_state import _append_log, save_state

# Issue #3866: cap on state.dev_resume_pending so a run with many distinct
# stalling anchors can't grow the list unboundedly across a long session —
# mirrors REAPED_TASK_IDS_CAP's FIFO-bound rationale, just a much smaller
# ceiling since this list drains via dispatch, not just accumulates.
DEV_RESUME_PENDING_CAP = 20

# The `needs-dev-resume` label already exists on gaberoo322/hydra (created
# for this issue) — reap never attempts to create it, only to apply it.
DEV_RESUME_LABEL = "needs-dev-resume"


def _handle_dev_orch_stall(
    s: dict,
    cls: str,
    skill: str | None,
    anchor_ref: str | None,
    task_id: str,
    worktree_branch: str | None,
    pr_list_json: str | None,
) -> None:
    """Detect + relabel a dev_orch completion that opened no PR (issue #3866).

    Motivating incident: dev_orch on #3726 did ~9.5 min of implementation,
    backgrounded `npm test`, then ended its turn waiting on the test run
    instead of finishing the PR. reap.py's completion accounting treated
    that as a normal `completed` cycle, the source issue stayed labelled
    `ready-for-agent` (or whatever the child left it as), and the NEXT
    autopilot turn re-dispatched the same anchor from a brand-new worktree —
    silently re-paying the ~165k tokens already spent, because nothing in
    the reap/decide path ever checked "did a PR actually get opened?"

    Only applies to `dev_orch` completions carrying a resolved anchor — a
    signal-class completion, a pinned-anchor miss, or a genuine no_op (no
    anchor deposit) all skip this by construction (the `not anchor_ref`
    guard). `pr_list_json` is the ALREADY-FETCHED `gh pr list` payload (issue
    #4045 INV-5) — `run_completion` fetches it once via
    `_fetch_dev_orch_pr_list_json` and shares it with
    `_handle_dev_orch_needs_qa_promotion` too, so a `gh` hiccup on that ONE
    shared fetch fails BOTH checks open (never mislabels a healthy
    in-flight/merged anchor) — see `_dev_orch_pr_exists_for_anchor`.

    Issue #4057: "no open PR" alone is NOT sufficient stall evidence — the
    dispatch may have legitimately CLOSED the anchor itself (verified the
    defect was already resolved elsewhere and closed the issue with evidence
    instead of inventing a fix). A closed anchor is terminal by definition,
    so before any mutation the handler reads the anchor issue's own state
    (`_anchor_issue_is_closed`, fired only on this already-narrow no-PR
    branch) and short-circuits when it reads CLOSED. An unreadable state
    fails open as no-mutation, like every other `gh` gate here.

    On a confirmed stall (PR-existence == False, anchor OPEN):
      - relabel the issue away from ready-for-agent/in-progress to
        `needs-dev-resume` (label pre-created for this issue) so hydra-dev's
        own `gh issue list --label ready-for-agent | .[0]` self-selection can
        never re-pick it for a from-scratch redo.
      - post an explanatory comment (best-effort).
      - append a resume record to `state.dev_resume_pending` — the queue
        `decide.py`'s dev_orch selector drains ahead of a fresh
        ready-for-agent pick, pinning the NEXT dev_orch dispatch back to
        this anchor (with the stalled branch name, when known) instead of
        leaving it to rot under a label nothing else consumes.

    Every step here is best-effort and non-fatal — a relabel/comment/gh
    failure logs to stderr and the reap still returns normally, exactly like
    the other post-accounting side effects in `run_completion` (reflection
    fire, worktree GC).
    """
    if cls != "dev_orch" or not anchor_ref:
        return
    pr_exists = _dev_orch_pr_exists_for_anchor(anchor_ref, pr_list_json)
    if pr_exists is not False:
        # True (PR found) or None (unknown/gh unreachable) — no action here.
        # A found PR means the anchor is legitimately progressing — the
        # ready-for-agent -> needs-qa promotion for that case is a SEPARATE
        # best-effort step (`_handle_dev_orch_needs_qa_promotion`, issue
        # #4045), not this function's job; an unknown result fails open
        # rather than risking a false stall label.
        return

    m = re.match(r"^issue-(\d+)$", anchor_ref)
    issue_num = m.group(1) if m else None
    if issue_num is None:
        return

    # Issue #4057: disambiguate the stall signal before mutating. A closed
    # anchor is a terminal outcome (closed by a merged PR's Closes ref, or by
    # the agent itself with evidence that the work is already done — observed
    # on #4032): relabelling it would tag a CLOSED issue needs-dev-resume and
    # queue a redispatch of work that is finished. Unreadable state → no
    # mutation, per the fail-open convention above.
    issue_closed = _anchor_issue_is_closed(issue_num)
    if issue_closed is None:
        return
    if issue_closed:
        line = (
            f"dev_stall_no_pr_skipped_closed anchor={anchor_ref} "
            f"task_id={task_id} branch={worktree_branch or ''}"
        )
        print(f"[autopilot] {line}")
        _append_log(line)
        return

    edit = _gh_run(
        "issue", "edit", issue_num, "--repo", REPO,
        "--remove-label", "ready-for-agent",
        "--remove-label", "in-progress",
        "--add-label", DEV_RESUME_LABEL,
        context=f"#{issue_num} needs-dev-resume relabel",
    )
    relabelled = edit is not None and edit.returncode == 0
    if edit is not None and not relabelled:
        print(
            f"[autopilot] reap: WARN failed to relabel issue #{issue_num} "
            f"to {DEV_RESUME_LABEL} (non-fatal): {edit.stderr.strip()}",
            file=sys.stderr,
        )

    branch_note = f"\n**Branch:** `{worktree_branch}`" if worktree_branch else ""
    _gh_run(
        "issue", "comment", issue_num, "--repo", REPO, "--body",
        "> *Automated reap — dev_orch stalled with no PR (issue #3866)*\n\n"
        "The `dev_orch` dispatch for this anchor ended its session "
        "without opening a PR (no open PR currently references this "
        f"issue).{branch_note}\n\n"
        f"Relabelled `{DEV_RESUME_LABEL}` so the next autopilot turn "
        "resumes this anchor instead of re-dispatching a fresh "
        "implementation from scratch.",
        context=f"#{issue_num} dev_orch stall comment",
    )

    # Append/replace the resume record — dedup by anchor so a repeated stall
    # on the SAME anchor keeps only its latest attempt, then FIFO-bound the
    # whole queue (issue #3866).
    pending = s.get("dev_resume_pending")
    if not isinstance(pending, list):
        pending = []
    pending = [e for e in pending if not (isinstance(e, dict) and e.get("anchor") == anchor_ref)]
    pending.append({
        "anchor": anchor_ref,
        "task_id": task_id,
        "branch": worktree_branch or "",
        "stalled_epoch": int(time.time()),
    })
    if len(pending) > DEV_RESUME_PENDING_CAP:
        pending = pending[-DEV_RESUME_PENDING_CAP:]
    s["dev_resume_pending"] = pending
    save_state(s)

    line = (
        f"dev_stall_no_pr anchor={anchor_ref} task_id={task_id} "
        f"branch={worktree_branch or ''} relabelled={relabelled}"
    )
    print(f"[autopilot] {line}")
    _append_log(line)


def _handle_dev_orch_needs_qa_promotion(
    cls: str,
    anchor_ref: str | None,
    pr_list_json: str | None,
) -> None:
    """Advance ready-for-agent -> needs-qa once a dev_orch completion's PR
    actually CLOSES the anchor issue (issue #4045).

    Motivating incident: measured during autopilot run f1347b80 — 9 of the
    10 open PRs with a resolvable linked issue left that issue labelled
    `ready-for-agent`. Nothing in the dev flow or the reap path advances
    the lane once a PR exists, so `qa_orch` (which gates on `needs-qa`) sat
    idle while reviewable PRs piled up, AND `dev_orch`'s own unpinned
    `ready-for-agent` self-selection (no open-PR check anywhere in its
    path) was free to pick an issue that already has a PR waiting for
    review, inviting a duplicate build.

    Deliberately gated on a CLOSING reference only (see
    `_dev_orch_pr_closes_anchor` / `pr-refs.py`'s `closing_issues()`) —
    never a bare branch-name match or a non-closing `Refs #N`, which are
    enough to say a dispatch didn't stall (`_handle_dev_orch_stall`'s
    job) but NOT enough to say the work is done and reviewable.

    Idempotent by construction: the relabel only fires when the issue is
    CURRENTLY `ready-for-agent` (checked via a fresh `gh issue view` right
    before the edit) — an issue already on `needs-qa`, or moved to any
    other lane by another actor, is left untouched, so a repeated reap on
    the same anchor across multiple completions is a safe no-op.

    Every step is best-effort/non-fatal, matching every other
    post-accounting side effect in `run_completion`: a `gh` failure at any
    point logs to stderr and this function returns without raising.
    """
    if cls != "dev_orch" or not anchor_ref:
        return
    closes = _dev_orch_pr_closes_anchor(anchor_ref, pr_list_json)
    if closes is not True:
        # False (no closing PR yet) or None (unknown/gh unreachable) — no
        # action. An unknown result fails open rather than risking a
        # premature or incorrect promotion.
        return

    m = re.match(r"^issue-(\d+)$", anchor_ref)
    issue_num = m.group(1) if m else None
    if issue_num is None:
        return

    view = _gh_run(
        "issue", "view", issue_num, "--repo", REPO, "--json", "labels",
        context=f"#{issue_num} needs-qa promotion labels view",
    )
    if view is None:
        return
    if view.returncode != 0:
        print(
            f"[autopilot] reap: WARN gh issue view exited {view.returncode} "
            f"for #{issue_num} needs-qa promotion; no relabel this reap",
            file=sys.stderr,
        )
        return
    try:
        current_labels = {
            entry.get("name")
            for entry in json.loads(view.stdout).get("labels", [])
            if isinstance(entry, dict)
        }
    except Exception as exc:  # noqa: BLE001 — best-effort, never abort the reap
        print(
            f"[autopilot] reap: WARN labels parse failed for #{issue_num} "
            f"needs-qa promotion (non-fatal): {exc}",
            file=sys.stderr,
        )
        return
    if "ready-for-agent" not in current_labels:
        # Already advanced (by this same check on a prior reap, by a human,
        # or never was ready-for-agent to begin with) — idempotent no-op.
        return

    edit = _gh_run(
        "issue", "edit", issue_num, "--repo", REPO,
        "--remove-label", "ready-for-agent",
        "--add-label", "needs-qa",
        context=f"#{issue_num} needs-qa promotion relabel",
    )
    if edit is None:
        return
    relabelled = edit.returncode == 0
    if not relabelled:
        print(
            f"[autopilot] reap: WARN failed to relabel issue #{issue_num} "
            f"to needs-qa (non-fatal): {edit.stderr.strip()}",
            file=sys.stderr,
        )

    line = f"dev_pr_closes_anchor anchor={anchor_ref} relabelled={relabelled}"
    print(f"[autopilot] {line}")
    _append_log(line)


def _handle_dev_target_stall(
    s: dict,
    cls: str,
    skill: str | None,
    anchor_ref: str | None,
    task_id: str,
    worktree_branch: str | None,
    pr_list_json: str | None,
) -> None:
    """Detect + release a dev_target completion that opened no PR (issue #4195).

    The dev_target mirror of `_handle_dev_orch_stall` (#3866). Motivating
    deadlock: a dev_target dispatch that ends without opening a PR leaves its
    Target anchor labelled `in-progress` forever, and hydra-target-build
    Step 1 refuses to claim new work while 3 issues carry `in-progress`
    (ADR-0031 Decision 4's WIP cap) — so three orphaned claims don't just
    lose three issues, they structurally dead-arm the ENTIRE dev_target
    class (autopilot run b0253320, 2026-08-21: WIP 3/3 on hydra-betting
    #864/#840/#836, none with a PR, branch, or live session). It is a
    deadlock, not a leak: nothing on the Target side ever clears them.

    Every gh call here targets TARGET_REPO, never the orch REPO — the
    anchor's issue number is a hydra-betting number. `pr_list_json` is the
    ALREADY-FETCHED TARGET_REPO payload (`run_completion` fetches it once via
    `_fetch_pr_list_json(TARGET_REPO, anchor_ref)`), so the predicate reuse
    below answers for the Target repo even though it shares dev_orch's
    helper name.

    Where this deliberately DIVERGES from the dev_orch shape (design-concept
    #4195, INV-4/5/7):
      - PR-existence uses `closing_issues()` — the STRICT closing predicate —
        not `referenced_issues()`. Target build branches are always named
        feature/<cycle-id> (hydra-target-build Step 0.6), so the latter's
        branch-name half can never match a Target PR, while ADR-0031
        Decision 5 (as amended by #3700) already enforces a `Closes #N` body
        line for every board-picked-issue build: the closing form is both
        sufficient and the documented, enforced signal.
      - A confirmed stall relabels `in-progress` -> `ready-for-agent` ONLY.
        `needs-dev-resume` is an orch-repo label that does not exist on
        hydra-betting, and no new Target-side label is created — Step 2's
        board-picker already searches `ready-for-agent` (oldest-first), so
        the WIP-gate slot frees on the very next board read with zero new
        label taxonomy and zero decide.py wiring.
      - NO resume-pin queue: `state.dev_resume_pending`'s Target equivalent
        (and any decide.py dev_target-selector drain) is out of scope per
        #4195's own open questions — a separately-scoped follow-up. The
        accepted trade-off: the anchor re-enters the claim/orphan loop
        rather than being pinned, which still beats a permanently wedged
        lane.

    The #4057 disambiguator is preserved verbatim in shape: "no closing PR"
    is NOT sufficient stall evidence — a dev_target dispatch may legitimately
    CLOSE the anchor itself (triage/research issues whose done-when is a
    bucketed list + follow-on filings; observed hydra-betting #1247), so
    `_anchor_issue_is_closed` (repo=TARGET_REPO) runs before any mutation and
    a CLOSED anchor short-circuits with a log line only.

    Only applies to `dev_target` completions carrying an `issue-<N>` anchor —
    non-issue picks (failing-tests/typecheck/priorities-doc, which carry no
    GitHub issue number) and every other class skip this by construction,
    mirroring `_handle_dev_orch_stall`'s guard.

    Every step is best-effort and non-fatal — a gh failure/timeout/non-zero
    exit at ANY point fails OPEN (no mutation) and the reap still returns
    normally, exactly like the dev_orch handler.
    """
    if cls != "dev_target" or not anchor_ref:
        return
    m = re.match(r"^issue-(\d+)$", (anchor_ref or "").strip())
    if not m:
        return
    issue_num = m.group(1)

    closes = _dev_orch_pr_closes_anchor(anchor_ref, pr_list_json)
    if closes is not False:
        # True (a closing PR exists — the build is legitimately in flight) or
        # None (unknown / TARGET_REPO fetch failed) — no action. Unknown
        # fails open rather than risking a false stall release.
        return

    # Issue #4057's Target twin: a CLOSED anchor is a legitimate terminal
    # outcome (the dispatch closed a triage/research issue directly, no PR by
    # design — observed hydra-betting #1247). Releasing it back to
    # ready-for-agent would re-queue finished work. Unreadable state → no
    # mutation, per the fail-open convention.
    issue_closed = _anchor_issue_is_closed(issue_num, repo=TARGET_REPO)
    if issue_closed is None:
        return
    if issue_closed:
        line = (
            f"dev_target_stall_no_pr_skipped_closed anchor={anchor_ref} "
            f"task_id={task_id} branch={worktree_branch or ''}"
        )
        print(f"[autopilot] {line}")
        _append_log(line)
        return

    edit = _gh_run(
        "issue", "edit", issue_num, "--repo", TARGET_REPO,
        "--remove-label", "in-progress",
        "--add-label", "ready-for-agent",
        context=f"#{issue_num} on {TARGET_REPO} ready-for-agent release",
    )
    relabelled = edit is not None and edit.returncode == 0
    if edit is not None and not relabelled:
        print(
            f"[autopilot] reap: WARN failed to release issue #{issue_num} "
            f"on {TARGET_REPO} to ready-for-agent (non-fatal): "
            f"{edit.stderr.strip()}",
            file=sys.stderr,
        )

    branch_note = f"\n**Branch:** `{worktree_branch}`" if worktree_branch else ""
    _gh_run(
        "issue", "comment", issue_num, "--repo", TARGET_REPO, "--body",
        "> *Automated reap — dev_target stalled with no PR (issue #4195)*\n\n"
        "The `dev_target` dispatch for this anchor ended its session "
        "without opening a PR (no open PR currently closes this "
        f"issue).{branch_note}\n\n"
        "Released `in-progress` -> `ready-for-agent` so the WIP gate "
        "(ADR-0031 Decision 4) frees this slot on the next board "
        "read; the issue re-enters the normal pick order instead of "
        "wedging the lane as an orphaned claim.",
        context=f"#{issue_num} on {TARGET_REPO} dev_target stall comment",
    )

    line = (
        f"dev_target_stall_no_pr anchor={anchor_ref} task_id={task_id} "
        f"branch={worktree_branch or ''} relabelled={relabelled}"
    )
    print(f"[autopilot] {line}")
    _append_log(line)
