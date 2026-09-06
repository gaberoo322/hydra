"""reap_ghrefs.py — the `gh` subprocess seam + open-PR reference/closing
predicates for scripts/autopilot/reap.py (issue #4398, the prerequisite
leaf absorbed from #4366's originally-separate reap_ghrefs slice).

Owns:
  - the `_gh_run` subprocess seam (issue #4377/#4378) and its `gh` argv
    builder `_gh_argv`, honouring the `HYDRA_AUTOPILOT_GH_CLI` test/operator
    override
  - `REPO` / `TARGET_REPO` — the orch and Target GitHub repo names
  - the pr-refs.py loader + the referenced/closing predicate wrappers
    (issue #3852, #4045)
  - the shared `gh pr list` fetch (issue #4045 INV-5) and the dev_orch /
    dev_target PR-existence, PR-closes-anchor, and anchor-closed checks that
    sit on top of it (issues #3866, #4045, #4057, #4195)

Imported by reap.py AND reap_stall.py via a guarded `sys.path` insert +
name-binding import (mirrors reap_state.py's existing pattern) — never via
attribute access, so a `reap.<name> = spy`-style monkeypatch in the existing
stall test files keeps resolving through this module's globals (the shared
`subprocess` module object is what makes `reap.subprocess.run = boom` reach
`_gh_run` here). Imports no sibling module — this is the leaf of the split,
which is exactly what lets reap_stall.py depend on it without ever
importing reap.py itself (issue #4398 INV-3: no import cycle). This module
is a library, not a CLI: no shebang, no `__main__` block, no exec bit —
matching the reap_state.py precedent for a shared leaf.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Issue #3866: argv prefix for `gh` calls made by the dev_orch no-PR-stall
# check below. Mirrors the HYDRA_AUTOPILOT_REDIS_CLI override pattern for
# redis_cli — tests inject a stub `gh` recorder here instead of shelling out
# to the real CLI / network. Whitespace-split so a multi-word override works.
GH_CLI_OVERRIDE = os.environ.get("HYDRA_AUTOPILOT_GH_CLI", "").strip()

REPO = os.environ.get("HYDRA_AUTOPILOT_REPO", "gaberoo322/hydra")

# Issue #4195: the Target board's GitHub repo. Every gh call the dev_target
# no-PR stall check makes targets THIS repo, never the orch REPO — a
# dev_target anchor's issue number lives on hydra-betting, so querying REPO
# would misread an unrelated orch issue (or a 404) as "no PR". Reuses
# collect-state.sh's existing HYDRA_TARGET_GITHUB_REPO override name rather
# than inventing a second spelling for the same operator knob.
TARGET_REPO = os.environ.get("HYDRA_TARGET_GITHUB_REPO", "gaberoo322/hydra-betting")


def _gh_argv(*args: str) -> list[str]:
    """Build a `gh` CLI argv, honouring HYDRA_AUTOPILOT_GH_CLI (issue #3866).

    Mirrors `redis_cli`'s override pattern: default prefix is the single
    token `gh`; a test/operator override is whitespace-split so a stub
    recorder script (or a `gh --hostname ...` prefix) can stand in.
    """
    prefix = GH_CLI_OVERRIDE.split() if GH_CLI_OVERRIDE else ["gh"]
    return [*prefix, *args]


def _gh_run(
    *args: str, context: str, timeout: int = 15
) -> subprocess.CompletedProcess[str] | None:
    """Run one `gh` subprocess call, collapsing this module's 8
    byte-identical try/except sites into a single helper (issue #4377, PR #4378, INV-6 fix).

    Composes `_gh_argv(*args)` and calls `subprocess.run` with the same
    four kwargs every site already used (`check=False, capture_output=True,
    text=True, timeout=timeout`). Catches exactly the tuple all 8 sites
    already caught — `(subprocess.TimeoutExpired, FileNotFoundError,
    OSError)` — prints one canonical WARN line naming the `gh` subcommand
    and the caller-supplied `context`, and returns None. Nothing else is
    caught, so a genuine programming error still fails loud.

    A non-zero exit is NEVER swallowed here — the `CompletedProcess` is
    returned as-is so each call site keeps its own `returncode` branch,
    message text, and control flow byte-for-byte. `proc is None` always
    means "gh could not be run/completed at all"; a caller that needs to
    react to "gh ran but exited non-zero" still checks `.returncode`
    itself, exactly as before this helper existed.
    """
    try:
        return subprocess.run(
            _gh_argv(*args),
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        sub = args[0] if len(args) > 0 else ""
        cmd = args[1] if len(args) > 1 else ""
        print(
            f"[autopilot] reap: WARN gh {sub} {cmd} failed for {context} "
            f"(non-fatal): {exc}",
            file=sys.stderr,
        )
        return None


def _load_pr_refs_module():
    """Load pr-refs.py (issue #3852) via importlib — the file is not
    import-friendly by name (lives next to this script, not on sys.path, and
    its hyphenated filename isn't a valid module name). Mirrors the
    lazy-import-for-standalone-usability pattern `_classify_failure_pattern`
    already uses for `self_heal`. Shared by both predicate wrappers below so
    each isn't hand-rolling its own importlib boilerplate.
    """
    spec = importlib.util.spec_from_file_location(
        "hydra_autopilot_pr_refs", Path(__file__).parent / "pr-refs.py"
    )
    if spec is None or spec.loader is None:
        raise ImportError("cannot load pr-refs.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _pr_refs_referenced_issues(pr_list_json: str) -> set[int]:
    """Load pr-refs.py's shared reference predicate and apply it (issue #3866).

    `pr-refs.py` (issue #3852) is THE reference-detection predicate for "does
    an open PR reference issue N" — recover-stale.sh already shells out to it
    for the analogous stale_in_progress/stale_blocked recovery. reap.py is
    pure Python already, so it loads the sibling module directly via
    importlib rather than round-tripping through a second subprocess.
    """
    return _load_pr_refs_module().referenced_issues(pr_list_json)


def _pr_refs_closing_issues(pr_list_json: str) -> set[int]:
    """Load pr-refs.py's narrower CLOSING predicate and apply it (issue #4045).

    Sibling of `_pr_refs_referenced_issues` above — same importlib load, but
    calls `closing_issues()` instead of `referenced_issues()`. See
    `pr-refs.py`'s `closing_issues()` docstring for why this is a stricter
    bar (a real GitHub closing verb only, never a bare branch-name match or
    a non-closing `Refs #N`).
    """
    return _load_pr_refs_module().closing_issues(pr_list_json)


def _fetch_pr_list_json(repo: str, anchor_ref: str) -> str | None:
    """Fetch a repo's OPEN PR list ONCE for a given anchor's stall/closing
    checks (issues #3866, #4045, #4195).

    Shared body behind the per-class fetch wrappers: `_fetch_dev_orch_pr_list_json`
    calls this with REPO for the #3866 stall check (`_dev_orch_pr_exists_for_anchor`)
    and the #4045 closing-PR check (`_dev_orch_pr_closes_anchor`) — one fetch
    shared by both instead of each shelling out its own `gh pr list` (the
    INV-5 design-concept gap closed by PR #4090). `run_completion`'s #4195
    block calls this directly with TARGET_REPO for the dev_target stall check
    (`_handle_dev_target_stall`) — the repo is a parameter precisely because a
    dev_target anchor's PRs live on the Target repo, never the orch REPO.

    Requests `closingIssuesReferences` in addition to `headRefName,body` —
    unused by any predicate today (they parse `body` via regex), but matches
    the approved design-concept artifact's literal field list for "the one
    shared call" and leaves room for a future GitHub-computed closing check
    without a second field-shape migration.

    Returns:
      Raw `gh pr list` stdout (JSON text) on success.
      None — the fetch could not be completed (malformed anchor, `gh`
             failure/timeout, non-zero exit). Callers MUST treat this as
             "unknown" and take no action — never fabricate an empty list.
             Fail-open, matching every other best-effort `gh`/network call
             in this module (e.g. `_recover_tokens_from_transcript`). Because
             both dev_orch checks share this one fetch, a single failure there
             fails BOTH open — the same net effect as the old two-independent-
             calls shape, where each `gh` hiccup independently failed open.
    """
    m = re.match(r"^issue-(\d+)$", (anchor_ref or "").strip())
    if not m:
        return None
    proc = _gh_run(
        "pr", "list", "--repo", repo, "--state", "open",
        "--json", "headRefName,body,closingIssuesReferences", "--limit", "200",
        context=f"repo={repo} anchor={anchor_ref} pr list",
    )
    if proc is None:
        return None
    if proc.returncode != 0:
        print(
            f"[autopilot] reap: gh pr list exited {proc.returncode} for "
            f"repo={repo} anchor={anchor_ref}; PR-existence/closing-status "
            "unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    return proc.stdout


def _fetch_dev_orch_pr_list_json(anchor_ref: str) -> str | None:
    """Fetch REPO's open PR list for the dev_orch stall/closing checks —
    thin wrapper over `_fetch_pr_list_json` (issue #4195's INV-6 extraction:
    the repo is now a parameter so the dev_target stall check can target
    TARGET_REPO through the exact same shared body). Zero behavior change
    for the existing dev_orch callers/tests.
    """
    return _fetch_pr_list_json(REPO, anchor_ref)


def _dev_orch_pr_exists_for_anchor(anchor_ref: str, pr_list_json: str | None) -> bool | None:
    """Does an OPEN PR on REPO reference `anchor_ref`? (issue #3866)

    `anchor_ref` is the "issue-<N>" shape `_read_anchor_deposit` returns.
    `pr_list_json` is the ALREADY-FETCHED `gh pr list` payload (issue #4045
    INV-5) — this function no longer shells out to `gh` itself; the shared
    fetch lives in `_fetch_dev_orch_pr_list_json`, called once by
    `run_completion` for both this check and `_dev_orch_pr_closes_anchor`.

    Returns:
      True  — at least one open PR's head branch or body references the
              issue (pr-refs.py's predicate).
      False — `pr_list_json` parsed cleanly and NO open PR references it.
              This is the "dev_orch completed with no PR" stall signal the
              issue is about.
      None  — the check could not be completed (malformed anchor,
              `pr_list_json` is None because the shared fetch failed, or
              unparseable output). Callers MUST treat this as "unknown" and
              take no action — never as a false `False`. Fail-open, matching
              every other best-effort `gh`/network call in this module.
    """
    m = re.match(r"^issue-(\d+)$", (anchor_ref or "").strip())
    if not m:
        return None
    if pr_list_json is None:
        return None
    issue_num = int(m.group(1))
    try:
        referenced = _pr_refs_referenced_issues(pr_list_json)
    except Exception as exc:  # noqa: BLE001 — best-effort, never abort the reap
        print(
            f"[autopilot] reap: pr-refs parse failed for anchor={anchor_ref} "
            f"({exc}); PR-existence unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    return issue_num in referenced


def _dev_orch_pr_closes_anchor(anchor_ref: str, pr_list_json: str | None) -> bool | None:
    """Does an OPEN PR on REPO actually CLOSE `anchor_ref`'s issue? (#4045)

    `pr_list_json` is the ALREADY-FETCHED `gh pr list` payload (issue #4045
    INV-5, PR #4090's design-concept reconciliation) — this function no
    longer shells out to `gh` itself; `run_completion` fetches ONCE via
    `_fetch_dev_orch_pr_list_json` and shares the same payload with
    `_dev_orch_pr_exists_for_anchor` (the #3866 stall check), so a single
    `gh` hiccup on that one shared fetch fails BOTH checks open instead of
    each independently shelling out its own `gh pr list --json
    headRefName,body,closingIssuesReferences --limit 200`.

    Uses `pr-refs.py`'s `closing_issues()` predicate, which is deliberately
    narrower than `referenced_issues()`: a bare branch-name match or a
    non-closing `Refs #N` body keyword do NOT count here — only a real
    GitHub closing verb (Closes/Fixes/Resolves) does.

    Returns:
      True  — an open PR's body closes the issue.
      False — `pr_list_json` parsed cleanly and no open PR closes it.
      None  — the check could not be completed (malformed anchor,
              `pr_list_json` is None because the shared fetch failed, or
              unparseable output). Callers MUST treat this as "unknown" and
              take no action — never as a false `False`.
    """
    m = re.match(r"^issue-(\d+)$", (anchor_ref or "").strip())
    if not m:
        return None
    if pr_list_json is None:
        return None
    issue_num = int(m.group(1))
    try:
        closing = _pr_refs_closing_issues(pr_list_json)
    except Exception as exc:  # noqa: BLE001 — best-effort, never abort the reap
        print(
            f"[autopilot] reap: pr-refs closing-parse failed for "
            f"anchor={anchor_ref} ({exc}); no relabel this reap",
            file=sys.stderr,
        )
        return None
    return issue_num in closing


def _anchor_issue_is_closed(issue_num: str, repo: str = REPO) -> bool | None:
    """Is anchor issue #N currently CLOSED? (issue #4057)

    `_handle_dev_orch_stall` treats "dev_orch completed and no open PR
    references the anchor" as a stall. That evidence is incomplete: the
    dispatch may have legitimately closed the anchor itself (verified the
    defect was already resolved elsewhere and closed the issue with evidence
    instead of inventing a fix — the motivating #4032 case), which is a
    terminal outcome with no PR by design. This read is the disambiguator:
    scoped to that single issue, deliberately NOT folded into
    `_dev_orch_pr_exists_for_anchor`'s shared open-PR-list fetch — no shape
    of PR-list payload can observe a closure that has no PR.

    Issue #4195: `repo` is now an optional parameter (default REPO — zero
    change for the dev_orch caller) so `_handle_dev_target_stall` can run the
    SAME #4057 disambiguator against the Target board, where a dev_target
    dispatch equally has a legitimate no-PR terminal outcome (observed:
    hydra-betting #1247, a triage issue closed directly with no PR by design).

    Returns:
      True  — `gh issue view` succeeded and the issue's state is CLOSED.
      False — succeeded and the state is OPEN.
      None  — unreadable (`gh` failure/timeout, non-zero exit, or unparseable
              output). Callers MUST treat this as "unknown" and mutate
              nothing — the same fail-open-as-no-mutation convention
              `_dev_orch_pr_exists_for_anchor` follows.
    """
    proc = _gh_run(
        "issue", "view", issue_num, "--repo", repo,
        "--json", "state",
        context=f"#{issue_num} issue view (state)",
    )
    if proc is None:
        return None
    if proc.returncode != 0:
        print(
            f"[autopilot] reap: gh issue view exited {proc.returncode} for "
            f"#{issue_num}; issue state unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    try:
        state = json.loads(proc.stdout).get("state")
    except (json.JSONDecodeError, AttributeError) as exc:
        print(
            f"[autopilot] reap: gh issue view returned unparseable output for "
            f"#{issue_num} ({exc}); issue state unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    if not isinstance(state, str) or not state.strip():
        print(
            f"[autopilot] reap: gh issue view returned no state for "
            f"#{issue_num}; issue state unknown, no relabel this reap",
            file=sys.stderr,
        )
        return None
    return state.strip().upper() == "CLOSED"
