#!/usr/bin/env python3
"""
render-dispatch.py — render a `dispatch` action into the Agent call (issue #4833).

  python3 scripts/autopilot/render-dispatch.py <slot> [--notes-file <md> | --notes -] [--prompt-only]

Reads the plan's `dispatch` action for `<slot>` and state.json, and prints ONE
JSON object the session passes straight to the Agent tool:

  {slot, skill, model, model_source, isolation, run_in_background,
   description, prompt}

  model        the harness alias (fable / sonnet / haiku / opus) or null —
               null means OMIT the kwarg and inherit the parent session.
  isolation    "worktree" or null — null means OMIT the kwarg (a `self`
               class isolates itself in a Target worktree; #3889 / #4476).
  prompt       sentinel → worktree-guard block → ONE forbidden-ending block
               → `## Task` (the class skeleton with every mandatory
               prompt_args-driven sentence, then the dispatcher's notes).

Where the text comes from — nothing here is a second copy of a rule:

  * The worktree-guard fences and the three `## NEVER END WAITING` variants
    are read at render time from docs/operator-playbooks/hydra-autopilot.md
    (§ Worktree-guard preamble) and _fragments/target-self-isolation-
    preamble.md — the same fences test/autopilot-*-preamble.test.mts pin, so
    an edit to the playbook changes every rendered prompt and the renderer
    cannot drift from the documented block.
  * The per-class model comes from the playbook's Per-class model routing
    table (§ Per-class model routing), then `prompt_args.escalate_model`
    (#3274), then the Fable out-of-credits pre-resolution (#4585:
    `state.usage_eligibility.reasons.fableExhaustedUntil` in the future →
    $HYDRA_AUTOPILOT_FALLBACK_MODEL or `opus`).
  * The skill is the action's, except `wayfinder_orch`, whose
    `prompt_args.ticket_type` selects hydra-issue-research / hydra-dev at
    dispatch time (#3351). stamp-slot.py imports `effective_skill` from here
    so the stamped slot records the skill that ran.

The `## Task` skeleton carries the sentences the playbook makes MANDATORY for
a prompt_args shape (pinned anchor #3711, resume + resume_branch #3866, the
GLM forward-fix contract #4460, qa_target `pr_ref` #4576, wayfinder claim +
resolution protocol #3354, `apply: true` for the scan classes) and the
standing operator rules for each class. The dispatcher's `--notes` (lane
heads, SHAs, warnings) are appended verbatim — that is the part only the
session knows.

Exit 0 on success; 1 when the plan has no dispatch action for `<slot>`; 2 on
bad arguments / unreadable inputs / a playbook whose fences cannot be found.

Paths: $HYDRA_AUTOPILOT_STATE (/tmp/hydra-autopilot-state.json),
$HYDRA_AUTOPILOT_PLAN (/tmp/hydra-autopilot-plan.json).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
PLAYBOOK_PATH = os.path.join(REPO_ROOT, "docs", "operator-playbooks", "hydra-autopilot.md")
SELF_ISOLATION_FRAGMENT_PATH = os.path.join(
    REPO_ROOT, "docs", "operator-playbooks", "_fragments", "target-self-isolation-preamble.md"
)
STATE_PATH = os.environ.get("HYDRA_AUTOPILOT_STATE", "/tmp/hydra-autopilot-state.json")
PLAN_PATH = os.environ.get("HYDRA_AUTOPILOT_PLAN", "/tmp/hydra-autopilot-plan.json")

ORCH_REPO = "gaberoo322/hydra"
MODEL_ALIASES = ("fable", "sonnet", "haiku", "opus")
DEFAULT_FALLBACK_MODEL = "opus"

# The forbidden-ending block for every class that is NOT dev_orch / dev_target
# / qa_orch (those three read their playbook fences). Short on purpose: these
# classes have no delegated child and no fan-out, so the one hazard is the
# quiet ending itself.
GENERIC_UNATTENDED_BLOCK = """## NEVER END WAITING
This is an UNATTENDED dispatch; reap.py records your session's end as a
completion the instant you go quiet. Never end your turn waiting on CI, a
background agent, a backgrounded Bash process, or an armed Monitor — none of
them keeps this session alive. Do the work yourself, in the foreground, in
THIS session, and poll anything you must wait on in the foreground. Your final
message reports the deliverable the skill defines, or a hard blocker via a
`## Friction Report` section. State only what you directly observed in this
session."""

# The admission rule (operator directive 2026-08-19; playbook § Self-filed
# work) — carried by every issue-producing class.
ADMISSION_RULE = (
    "Admission rule (operator directive 2026-08-19): any issue you file about "
    "Hydra's own machinery (autopilot loop, CI/test harness, gates, dashboard, "
    "cost accounting, drainer, watchdog) is labelled `hitl-grill` — NEVER "
    "`ready-for-agent` or `needs-triage`. Only the operator promotes such work "
    "into the dispatch queue. Dedupe against open AND recently closed issues "
    "before filing; filing nothing is an acceptable outcome."
)

LABEL_API_RULE = (
    "Label mutations go through `gh api repos/" + ORCH_REPO + "/issues/<N>/labels` "
    "(`gh pr edit` is broken for labels); to remove a label put its name in the "
    "URL PATH (`DELETE .../labels/<name>`) — the `-f name=` form wipes ALL labels. "
    "If GraphQL `gh --json` calls rate-limit, fall back to `gh api repos/...` REST."
)

ISSUE_PRODUCING_CLASSES = {
    "research_orch", "research_target", "sweep_orch", "sweep_target", "discover_orch",
    "discover_target", "scout_orch", "architecture_orch", "retro_orch", "cleanup_orch",
    "cleanup_target", "wire_or_retire_target", "design_qa_target", "skill_prune", "tickets_orch",
}

# The GLM red-PR forward-fix contract (playbook § dev_orch dispatch, issue
# #4460 INV-10) — "the dispatch prompt MUST carry this contract verbatim".
FORWARD_FIX_CONTRACT = """GLM red-PR forward-fix contract (issue #4460, INV-10) — PR #{pr} on branch `{branch}` already exists; the work is to make its required checks pass, NOT a fresh implementation:
1. **Stay on the harness branch.** Work in the dispatched worktree, then `git fetch origin {branch} && git reset --hard FETCH_HEAD` — the forward-fix continues the PR's exact head, never a rebase or a new branch. NEVER `gh pr create`: the PR exists; a second PR duplicates the anchor. NEVER remove the `glm-authored` label — it is the provenance key the whole #4460 predicate (and #4048's lane) keys on.
2. **Read the failure before fixing it.** For a CI-required-check failure, `gh run view <run-id> --log-failed` for the failing run (find the run id via `gh pr checks {pr} --json` or the PR's checks UI). For a QA-FAIL bounce (`needs-dev-resume` applied by hydra-qa's INV-7 path), the request-changes review on the PR IS the finding list. Fix the named defect, not a neighbouring one.
3. **Push to the SAME branch:** `git push origin HEAD:{branch}`. The existing PR's CI re-runs on the push.
4. **Design-concept-reconcile failure specifically:** the gate reads the PR body captured at push time (webhook snapshot). Correct the body FIRST via `gh pr edit {pr} --body-file <file>`, THEN push the fix commit — a push that lands before the body edit replays the stale body and re-fails the check (bit #4242 twice).
5. **Verify in the foreground** (npm test / typecheck as the change requires), commit, push — the same commit-before-verify discipline as any dev dispatch. When done, post exactly ONE comment on the PR naming what was fixed and which required check(s) the fix targets. Do not relabel the anchor issue by hand — reap's needs-qa promotion (INV-9) advances it when the closing PR is confirmed."""

UNPINNED_RANKING = """Ordering the unpinned pick (issue #3981) — when more than one `ready-for-agent` issue is eligible, break the tie in this order (a tie-break, not a quota): 1. **Maintainability** — refactors, test coverage, dead-code removal, silent-catch audits, module splits; 2. **Operator surface** — the dashboard and the observability it renders; 3. **Throughput** — new capability. If the top-ranked eligible issue is blocked, has an open PR already referencing it (grep PR bodies for `Closes #N`), or lacks a `## Files in scope` section, fall through to the next — do not relabel to force it."""

DEV_VERIFY_RULES = (
    "Commit and push BEFORE verifying; then verify in the foreground: `npm test`, "
    "`npm run typecheck` AND `npm run typecheck:test` (the src-only typecheck misses "
    "test-file errors). If you add/remove/rename any `test/*.test.mts` file, regenerate "
    "`test/fixtures/suite-count-baseline.json` in the same push "
    "(`node scripts/test/suite-count-check.mjs --update-baseline`) — a FILE-SET verdict "
    "is blocking. Poll the PR's required checks in the FOREGROUND to a terminal state "
    "(a bounded `sleep` loop inside ONE Bash call) and report what you observed."
)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

class RenderError(Exception):
    """A playbook/fragment fence the renderer depends on is missing."""


def _load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not a JSON object")
    return data


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def find_dispatch(plan: dict, slot: str) -> dict | None:
    for action in plan.get("actions") or []:
        if isinstance(action, dict) and action.get("type") == "dispatch" and action.get("slot") == slot:
            return action
    return None


# ---------------------------------------------------------------------------
# Playbook fences (the ONE source of every preamble block)
# ---------------------------------------------------------------------------

def fenced_blocks(text: str) -> list[str]:
    """Bodies of every ``` fence in `text`, in order (info string ignored)."""
    out: list[str] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        if lines[i].startswith("```"):
            j = i + 1
            while j < len(lines) and not lines[j].startswith("```"):
                j += 1
            out.append("\n".join(lines[i + 1 : j]))
            i = j + 1
        else:
            i += 1
    return out


def _first_fence_starting(text: str, prefix: str, what: str) -> str:
    for body in fenced_blocks(text):
        if body.split("\n", 1)[0].startswith(prefix):
            return body.rstrip("\n")
    raise RenderError(f"{what}: no fenced block starting with {prefix!r}")


def preamble_blocks(playbook: str, fragment: str) -> dict[str, str]:
    """The guard + forbidden-ending blocks, keyed by what the renderer needs.

    `default_guard`  — § Worktree-guard preamble, default variant
    `self_guard`     — the self-isolation variant (fragment)
    `never_dev_orch` / `never_dev_target` / `never_qa_orch` — the three
    `## NEVER END WAITING` fences, told apart by their headings exactly as
    test/autopilot-qa-orch-forbidden-ending-preamble.test.mts does.
    """
    blocks = {
        "default_guard": _first_fence_starting(playbook, "## CRITICAL SAFETY RULE — READ FIRST", "playbook"),
        "self_guard": _first_fence_starting(
            fragment, "## CRITICAL SAFETY RULE — READ FIRST (self-isolation variant", "self-isolation fragment"
        ),
    }
    never: dict[str, str] = {}
    for body in fenced_blocks(playbook):
        heading = body.split("\n", 1)[0]
        if not heading.startswith("## NEVER END WAITING"):
            continue
        if "dev_target" in heading:
            key = "never_dev_target"
        elif "qa_orch" in heading:
            key = "never_qa_orch"
        else:
            key = "never_dev_orch"
        never.setdefault(key, body.rstrip("\n"))
    for key in ("never_dev_orch", "never_dev_target", "never_qa_orch"):
        if key not in never:
            raise RenderError(f"playbook: no `## NEVER END WAITING` fence for {key}")
    blocks.update(never)
    return blocks


# ---------------------------------------------------------------------------
# Model routing (the playbook table is the source; #1093)
# ---------------------------------------------------------------------------

ROUTING_ROW = re.compile(r"^\|\s*(`[^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$")


def routing_table(playbook: str) -> dict[str, str | None]:
    """class → alias (None = inherit the parent) from § Per-class model routing."""
    start = playbook.find("### Per-class model routing")
    if start == -1:
        raise RenderError("playbook: no `### Per-class model routing` section")
    body_start = playbook.find("\n", start) + 1
    nxt = re.search(r"^##+ ", playbook[body_start:], re.M)
    section = playbook[start : body_start + nxt.start()] if nxt else playbook[start:]
    table: dict[str, str | None] = {}
    for line in section.split("\n"):
        m = ROUTING_ROW.match(line)
        if not m or m.group(1).strip().startswith("`Class") or "Class (" in m.group(1):
            continue
        classes = re.findall(r"`([a-z][a-z0-9_]*)`", m.group(1))
        cell = m.group(2).strip()
        head = cell.split()[0].lower().rstrip(",;") if cell else ""
        if head == "inherit":
            alias: str | None = None
        elif head in MODEL_ALIASES:
            alias = head
        else:
            raise RenderError(f"playbook routing row {line!r}: unrecognised model cell {cell!r}")
        for cls in classes:
            table[cls] = alias
    if not table:
        raise RenderError("playbook: the Per-class model routing table has no rows")
    return table


def _parse_instant(value) -> float | None:
    """ISO-8601 (Z or offset) or epoch seconds/ms → epoch seconds; None if unreadable."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return v / 1000.0 if v > 1e11 else v
    s = str(value).strip()
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        try:
            v = float(s)
            return v / 1000.0 if v > 1e11 else v
        except ValueError:
            return None


def fable_exhausted(state: dict, now: float | None = None) -> bool:
    reasons = ((state.get("usage_eligibility") or {}).get("reasons")) or {}
    until = _parse_instant(reasons.get("fableExhaustedUntil")) if isinstance(reasons, dict) else None
    return until is not None and until > (time.time() if now is None else now)


def resolve_model(slot: str, action: dict, table: dict[str, str | None], state: dict, now: float | None = None) -> tuple[str | None, str]:
    """(alias-or-None, source). Static row → escalate_model hint → Fable pre-resolution."""
    prompt_args = action.get("prompt_args") if isinstance(action.get("prompt_args"), dict) else {}
    hint = prompt_args.get("escalate_model")
    if isinstance(hint, str) and hint:
        model, source = hint.lower(), "escalate_model"
    elif slot in table:
        model, source = table[slot], "routing-table" if table[slot] else "routing-table:inherit"
    else:
        model, source = None, "unmapped-class:inherit"
    if model == "fable" and fable_exhausted(state, now):
        fallback = os.environ.get("HYDRA_AUTOPILOT_FALLBACK_MODEL", "").strip().lower() or DEFAULT_FALLBACK_MODEL
        return fallback, f"{source}→fable-exhausted-fallback"
    return model, source


# ---------------------------------------------------------------------------
# Skill + ids
# ---------------------------------------------------------------------------

def effective_skill(action: dict) -> str | None:
    """The skill that actually runs — wayfinder_orch routes by ticket_type (#3351)."""
    prompt_args = action.get("prompt_args") if isinstance(action.get("prompt_args"), dict) else {}
    if action.get("slot") == "wayfinder_orch":
        tt = prompt_args.get("ticket_type")
        if tt == "task":
            return "hydra-dev"
        if tt == "research":
            return "hydra-issue-research"
    return action.get("skill")


def cycle_id(action: dict, state: dict) -> str:
    branch = action.get("worktreeBranch") or ""
    if branch.startswith("worktree-agent-"):
        return branch[len("worktree-agent-"):]
    run8 = str(state.get("run_id") or "")[:8]
    return f"{run8}-t{int(state.get('turn') or 0)}-{action.get('slot')}"


def _issue_number(ref) -> str | None:
    m = re.fullmatch(r"issue-(\d+)", str(ref or ""))
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# The `## Task` skeleton
# ---------------------------------------------------------------------------

def task_section(slot: str, action: dict, state: dict, skill: str | None) -> list[str]:
    pa = action.get("prompt_args") if isinstance(action.get("prompt_args"), dict) else {}
    signals = state.get("signals") if isinstance(state.get("signals"), dict) else {}
    out: list[str] = ["## Task"]
    anchor_n = _issue_number(pa.get("anchor"))
    scope = pa.get("scope")

    if slot == "dev_orch":
        if anchor_n:
            out.append(
                f"Invoke the `{skill}` skill (via the Skill tool) on **issue #{anchor_n}** of {ORCH_REPO} "
                f"(anchor `issue-{anchor_n}`) — this anchor is PINNED (issue #3711): work that issue and no other."
            )
        else:
            out.append(
                f"Invoke the `{skill}` skill (via the Skill tool) on the orch board ({ORCH_REPO}), unpinned — "
                "it self-selects one `ready-for-agent` issue."
            )
            out.append(UNPINNED_RANKING)
        if pa.get("resume"):
            branch = pa.get("resume_branch")
            branch_txt = f" (branch `{branch}`)" if branch else ""
            out.append(
                f"This anchor previously stalled without a landed result{branch_txt}. Before implementing from "
                "scratch, check whether that branch still exists (`git ls-remote origin <branch>`) and continue "
                "from it if so — do not silently redo already-committed work. This is a fresh session, not a "
                "resumed one; reusing the branch is what avoids re-paying for the committed portion."
            )
        if pa.get("forward_fix_pr"):
            out.append(FORWARD_FIX_CONTRACT.format(pr=pa.get("forward_fix_pr"), branch=pa.get("resume_branch") or "<resume_branch>"))
        else:
            out.append(
                "Open the PR from the worktree branch with a body that carries `## Files in scope`, a `Tier:` line and "
                f"ends `Closes #{anchor_n or '<N>'}`; fetch the design concept first if one exists "
                f"(`curl -s http://localhost:4000/api/design-concepts/issue-{anchor_n or '<N>'}`) and include the "
                "reconciliation section the design-concept gate requires. Do NOT merge or self-approve (shared identity "
                "422s; CI is the merge gate) and do NOT relabel the issue by hand — reap's needs-qa promotion advances it."
            )
        out.append(DEV_VERIFY_RULES)
        out.append("Final message: the PR number and head SHA (or the commits pushed to the existing PR), the required-check state you observed, or a `## Friction Report` naming a hard blocker.")

    elif slot == "qa_orch":
        lane = str(signals.get("needs_qa_numbers") or "").split()
        head = f"The needs-qa lane head is **issue #{lane[0]}**" if lane else "Resolve the needs-qa lane head yourself"
        rest = f"; the rest of the lane, in order: {', '.join('#' + n for n in lane[1:])}" if len(lane) > 1 else ""
        out.append(
            f"Invoke the `{skill}` skill (via the Skill tool; scope: {scope or 'orch'}, repo {ORCH_REPO}). {head}{rest}. "
            "Find its open PR by closing-ref (`Closes #N` in the PR body), not by title."
        )
        out.append(
            "Review that PR with the FULL step-7 Standards + Spec fan-out (blocking reviewer spawns, all in one message) — "
            "never an inline single-reviewer substitute. Review with `gh pr view` / `gh pr diff` only; do NOT `gh pr checkout` "
            "and do NOT approve the PR (shared identity 422s). If the PR is BEHIND master, `gh pr update-branch` first so you "
            "do not report phantom reversions. If a design-concept artifact exists for the anchor "
            "(`curl -s http://localhost:4000/api/design-concepts/issue-<N>`), review Spec against it; otherwise against the "
            "issue's acceptance criteria — and do not FAIL a PR for picking an option the issue itself offers."
        )
        out.append(
            "Post the verdict as a PR comment with the `QA-Verdict:` trailer and execute the step-10 routing. If the lane "
            "head already has a verdict at its current head SHA, move on to the next needs-qa issue instead."
        )
        out.append("Final message: the PR(s) reviewed, the verdict(s) posted (with head SHA), and the routing applied — or a `## Friction Report`.")

    elif slot == "design_concept_orch":
        out.append(
            f"Invoke the `{skill}` skill (via the Skill tool) on **issue #{anchor_n or '<N>'}** of {ORCH_REPO} "
            f"(anchor `issue-{anchor_n or '<N>'}`, scope={scope or 'orch'}) and follow it end to end in AFK (non-interactive) "
            "mode: produce the design-concept artifact for that anchor, or the skill's gate-fail handoff if a gap is "
            "genuinely unresolvable."
        )
        out.append(
            "Grill against `origin/master`, not any stale local branch — verify each premise in the issue against the code on "
            "master before designing around it (premise-check first; if the issue is already fixed or a duplicate of shipped "
            "work, say so and route it per the skill rather than writing a concept). Commit to a recommended position on each "
            "open question; no neutral option matrices."
        )
        out.append(
            "The artifact must actually PERSIST: after writing it, confirm it is readable back via "
            f"`curl -s http://localhost:4000/api/design-concepts/issue-{anchor_n or '<N>'}` (use the skill's `grill-artifact.sh` "
            "write + approve path if its own persistence step did not land it)."
        )
        out.append("Final message: whether the artifact persisted (and its approval status as read back from the API), or the handoff you posted, plus the key decisions.")

    elif slot == "dev_target":
        out.append(
            f"Invoke the `{skill}` skill (via the Skill tool; scope: target). **Use delegated mode** (spawn the build child, "
            "then poll it to completion in the FOREGROUND) — inline mode skips anchors touching more than five files."
        )
        if pa.get("resume"):
            out.append(
                f"This is a RESUME pin: Target issue #{pa.get('resume_issue') or anchor_n or '<N>'} is `needs-dev-resume`"
                + (f" with open PR #{pa.get('resume_pr')}" if pa.get("resume_pr") else "")
                + (f" on branch `{pa.get('resume_branch')}`" if pa.get("resume_branch") else "")
                + ". Continue that PR/branch — fix forward on the same branch, never a second PR for the same anchor."
            )
        elif anchor_n:
            out.append(f"Work **Target issue #{anchor_n}** (anchor `issue-{anchor_n}`) — pinned; no other issue.")
        else:
            out.append(
                "Pick ONE `ready-for-agent` Target issue per the skill's own selection (money-critical first when the skill's "
                "ranking ties). Check the open Target PRs first and do not duplicate work already in flight; branch off the "
                "Target's default branch."
            )
        out.append(
            "Open the PR with a body ending `Closes #<N>`, label the issue per the skill's contract, and do NOT merge or "
            "self-approve — Target QA is a separate dispatch. Run the Target's real test suite as its own `package.json` "
            "defines it. If the board state has changed (the issue claimed or closed), report that via ## Friction Report "
            "instead of inventing work."
        )
        out.append("Final message: the PR opened (number, head SHA, closing ref) or the forward-fix commits pushed — state only what you directly observed.")

    elif slot == "qa_target":
        pr_ref = pa.get("pr_ref")
        if pr_ref:
            out.append(f"Invoke the `{skill}` skill (via the Skill tool) on Target PR `{pr_ref}` (`pr_ref`) — pinned (issue #4576).")
        else:
            out.append(f"Invoke the `{skill}` skill (via the Skill tool) unpinned — its own step 1 resolves the PR the current Target build opened.")
        out.append(
            "Run the Standards pass, the Spec pass, and the adversarial fold the skill prescribes for the PR's risk class "
            "(money-critical / risk-surface PRs get the full fan-out — never an inline substitute). Read the linked issue's "
            "operator scope notes and verify the PR satisfies them. Post the verdict per the skill (on the linked issue, with "
            "the head SHA named). Do not merge; do not approve; never scrape external sites; never read or grep `.env` files."
        )
        out.append("Final message: the PR reviewed, the verdict posted (with head SHA) and where, or a `## Friction Report`.")

    elif slot == "wayfinder_orch":
        ticket_n = _issue_number(pa.get("ticket"))
        tt = pa.get("ticket_type")
        out.append(
            f"You are the `wayfinder_orch` worker for wayfinder frontier ticket **#{ticket_n or '<N>'}** (type `{tt or 'unknown'}`)."
        )
        out.append(f"Step 0 — CLAIM FIRST (issue #3354): `gh issue edit {ticket_n or '<N>'} --repo {ORCH_REPO} --add-assignee @me`. Skipping the claim makes both saturation guards inert.")
        if tt == "task":
            out.append(f"Then invoke the `hydra-dev` skill on #{ticket_n or '<N>'}: implement it in this worktree and open a PR whose body ends `Closes #{ticket_n or '<N>'}`. {DEV_VERIFY_RULES}")
        else:
            out.append(f"Then invoke the `hydra-issue-research` skill on #{ticket_n or '<N>'}: research the codebase (against `origin/master`) and enrich the ticket's body with the findings; if a findings doc belongs in the repo (`docs/research/`), open a PR for it.")
        out.append(
            "Resolution protocol when done (ADR-0029): (1) post a resolution comment on the ticket summarising findings / PR; "
            "(2) close the ticket once the enrichment or PR has landed (a `task` ticket closes when its PR merges — leave it "
            "open with the PR referenced if the PR is still in CI); (3) append a line to the parent map's `## Decisions so far` "
            "section (the map issue named in the ticket's body; edit via `gh api -X PATCH`) recording what this ticket cleared."
        )
        out.append("Final message: findings headline, PR (if any), and whether the map was updated.")

    elif slot == "research_target":
        out.append(
            f"Invoke the `{skill}` skill (via the Skill tool; scope: target). The Target board has zero `ready-for-agent` "
            "issues, so the build lane has nothing to pick up; the goal is a SMALL number of well-scoped, buildable "
            "`ready-for-agent` Target issues that advance the Target's stated vision and priorities."
        )
        out.append(
            "Before filing anything, check open AND recently closed Target issues and open Target PRs for duplicates. An empty "
            "ready lane with open PRs in flight is not by itself evidence that more issues are needed; prefer filing nothing "
            "over a duplicate or a padding item. Every issue you label `ready-for-agent` must carry concrete acceptance "
            "criteria and a `## Files in scope` section. Never read or grep `.env` files; never scrape sites the Target's "
            "direction docs rule out."
        )
        out.append("Final message: the issues you filed or updated (numbers + one line each), any direction-doc PR you pushed, and what you deliberately did not file and why.")

    elif slot == "research_orch":
        out.append(
            f"Invoke the `{skill}` skill (via the Skill tool; scope: orch, repo {ORCH_REPO}) and follow it end to end in this "
            "session. Research against `origin/master`; verify every finding against real current behaviour (code on master, "
            "the live API on http://localhost:4000) before writing it down."
        )
        out.append("Final message: the issues enriched or filed (numbers + one line each) and the key findings.")

    else:
        # Signal classes — the skill's own contract plus the prompt_args it was fired with.
        args_txt = ", ".join(f"{k}: {json.dumps(v)}" for k, v in pa.items())
        out.append(
            f"Invoke the `{skill}` skill (via the Skill tool"
            + (f"; {args_txt}" if args_txt else "")
            + ") and follow it end to end, in this session."
        )
        if pa.get("apply") is True:
            out.append("`apply: true` — this is a REAL run, not a dry run: file the issues / open the gated PR the skill's caps allow (a dry-run exit that files nothing is a no-op the brain will escalate).")
        if slot in ("sweep_orch", "sweep_target"):
            out.append(
                "Only advance items that can be progressed without operator input, per the skill. Before re-routing any issue "
                "toward dev, check whether an open or merged PR already references it (grep PR bodies for `Closes #N` — match by "
                "closing ref, not by title); an issue with an open PR never goes back to `ready-for-agent`. `ready-for-agent` "
                "requires a `## Files in scope` section on the ISSUE (a label validator reverts it otherwise). `blocked` slices "
                "of wayfinder epics are deliberately label-gated — do not unblock them unless every strict `Blocked by` reference "
                "is closed AND merged. Event-gated issues that keep bouncing \"re-triage forward\" get parked (`blocked`, with the "
                "named event), not re-triaged again. Do not relabel, comment on, or re-route an item a pipeline dispatch is "
                "working right now."
            )
            out.append(LABEL_API_RULE)
        if slot in ("discover_orch", "discover_target"):
            out.append(
                "Dedup before filing: run every candidate through `scripts/ci/issue-dedup.ts` against the shared backfill "
                "baseline as the skill prescribes, and grep CLOSED issues too — do not re-file work that already shipped or was "
                "closed not-planned. Verify each finding against real current behaviour before filing; do not pad the count."
            )
        if slot == "cleanup_orch":
            out.append("Triage with `npx knip` first and close duplicates of already-shipped or closed-not-planned findings before filing; the dashboard `tailwindcss` dependency is a known knip false positive — never re-file it.")
        if slot in ISSUE_PRODUCING_CLASSES:
            out.append(ADMISSION_RULE)
        out.append("Final message: each item you filed, changed or routed (numbers, before → after as read back from GitHub) — or state plainly that nothing needed doing and why.")

    return out


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

def render_prompt(slot: str, action: dict, state: dict, blocks: dict[str, str], skill: str | None, notes: str | None) -> str:
    isolation = action.get("isolation") or "worktree"
    parts: list[str] = []
    sentinel = action.get("dispatchSentinel")
    if isinstance(sentinel, str) and sentinel.strip():
        parts.append(sentinel.strip())

    if isolation == "self":
        parts.append(blocks["self_guard"])
        cid = cycle_id(action, state)
        line = f"Use CYCLE_ID=`{cid}` for the Target worktree id"
        signals = state.get("signals") if isinstance(state.get("signals"), dict) else {}
        pa = action.get("prompt_args") if isinstance(action.get("prompt_args"), dict) else {}
        head = signals.get("target_needs_qa_pr_head")
        if slot == "qa_target" and pa.get("pr_ref") and isinstance(head, str) and head:
            line += f" and set `TARGET_WT_BASE=origin/{head}` (the PR head)"
        parts.append(line + ". NEVER symlink node_modules into the Target worktree.")
    else:
        parts.append(blocks["default_guard"])

    if slot == "dev_orch":
        parts.append(blocks["never_dev_orch"])
    elif slot == "dev_target":
        parts.append(blocks["never_dev_target"])
    elif slot == "qa_orch":
        parts.append(blocks["never_qa_orch"])
    else:
        parts.append(GENERIC_UNATTENDED_BLOCK)

    parts.extend(task_section(slot, action, state, skill))
    if notes and notes.strip():
        parts.append("Notes from the dispatcher:\n" + notes.strip())
    return "\n\n".join(parts) + "\n"


def describe(slot: str, action: dict, skill: str | None) -> str:
    pa = action.get("prompt_args") if isinstance(action.get("prompt_args"), dict) else {}
    tail = ""
    if _issue_number(pa.get("anchor")):
        tail = f" on #{_issue_number(pa.get('anchor'))}"
    elif pa.get("pr_ref"):
        tail = f" on PR {str(pa.get('pr_ref')).rstrip('/').rsplit('/', 1)[-1]}"
    elif _issue_number(pa.get("ticket")):
        tail = f" on ticket #{_issue_number(pa.get('ticket'))}"
    elif pa.get("scope"):
        tail = f" ({pa.get('scope')})"
    return f"{slot}: {skill}{tail}"


def render(slot: str, action: dict, state: dict, playbook: str, fragment: str, notes: str | None = None, now: float | None = None) -> dict:
    blocks = preamble_blocks(playbook, fragment)
    table = routing_table(playbook)
    skill = effective_skill(action)
    model, source = resolve_model(slot, action, table, state, now)
    isolation = action.get("isolation") or "worktree"
    return {
        "slot": slot,
        "skill": skill,
        "model": model,
        "model_source": source,
        "isolation": "worktree" if isolation == "worktree" else None,
        "run_in_background": True,
        "description": describe(slot, action, skill),
        "prompt": render_prompt(slot, action, state, blocks, skill, notes),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

USAGE = "usage: render-dispatch.py <slot> [--notes-file <md> | --notes -] [--prompt-only]"


def main(argv: list[str]) -> int:
    args = argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(USAGE, file=sys.stderr)
        return 2
    slot = args[0]
    notes: str | None = None
    prompt_only = False
    i = 1
    while i < len(args):
        a = args[i]
        if a == "--prompt-only":
            prompt_only = True
        elif a == "--notes-file" and i + 1 < len(args):
            i += 1
            try:
                notes = _read(args[i])
            except OSError as exc:
                print(f"[render-dispatch] cannot read notes file: {exc}", file=sys.stderr)
                return 2
        elif a == "--notes" and i + 1 < len(args) and args[i + 1] == "-":
            i += 1
            notes = sys.stdin.read()
        else:
            print(USAGE, file=sys.stderr)
            return 2
        i += 1

    try:
        state = _load_json(STATE_PATH)
        plan = _load_json(PLAN_PATH)
    except (OSError, ValueError) as exc:
        print(f"[render-dispatch] cannot read state/plan: {exc}", file=sys.stderr)
        return 2
    action = find_dispatch(plan, slot)
    if action is None:
        print(f"[render-dispatch] plan {PLAN_PATH} has no dispatch action for slot {slot!r}", file=sys.stderr)
        return 1
    try:
        playbook = _read(PLAYBOOK_PATH)
        fragment = _read(SELF_ISOLATION_FRAGMENT_PATH)
        result = render(slot, action, state, playbook, fragment, notes)
    except (OSError, RenderError) as exc:
        print(f"[render-dispatch] {exc}", file=sys.stderr)
        return 2
    if prompt_only:
        sys.stdout.write(result["prompt"])
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
