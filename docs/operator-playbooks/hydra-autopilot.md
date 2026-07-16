---
name: hydra-autopilot
description: Event-driven autonomous decision loop that orchestrates all Hydra work in one Claude Code session via decide.py, executing typed action plans unattended for hours per run.
when_to_use: "When the operator says 'autopilot' or 'autonomous mode', or a scheduled launch fires."
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
claude_only: true
disable-model-invocation: true
reference_files: [_fragments/hydra-autopilot-class-wiring.md, _fragments/hydra-autopilot-phase6-ops.md, _fragments/hydra-autopilot-ops-reference.md]
---

# Hydra Autopilot

HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA: 2

Event-driven autonomous decision loop. The model is a thin Agent-tool-caller;
the policy lives in `scripts/autopilot/decide.py` (the **L2 decision brain**).

> **Schema-version handshake (issue #434).** The grep-able marker above
> (`HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA: 2`) must match the
> `limits.schema_version` value written by `bootstrap.sh`. Phase 0 below
> verifies this and aborts on mismatch. Bumping the schema requires
> editing both this marker AND the `SCHEMA_VERSION` constant in
> `scripts/autopilot/bootstrap.sh` in the same commit, then running
> `scripts/sync-skills.sh` so the installed skill mirror is refreshed.

**Authoritative references — read these instead of this playbook when you
need to know what the autopilot will do:**

- Decision logic: `scripts/autopilot/decide.py` (the `decide()` function and
  its docstring own the policy)
- Merge policy: `decide.py:should_auto_merge.__doc__`
- Failure self-heal table: `scripts/autopilot/self_heal.py` docstring
- Runtime invariants: `scripts/autopilot/assert_invariants.py` (INV-001..INV-010; INV-009 is warn-only in Phase B per #466; INV-010 guards the forced-research daily cap per #1666)
- Architecture rationale: [ADR-0007](../adr/0007-decision-brain-orchestration.md)

## Loop

Each tick:

1. **Wake** on TaskNotification, Monitor board-change, or a 15-min heartbeat.
2. **Collect** state + candidates + events into three JSON blobs.
3. **`python3 scripts/autopilot/decide.py decide state.json candidates.json events.json`** — pure function call, returns `{actions, reasons, debug}`. The CLI bumps `state.turn` by one and persists it atomically BEFORE calling `decide()` — the bump is a `main()` side-effect; `decide()` itself stays pure.
4. **`python3 scripts/autopilot/assert_invariants.py plan.json state.json`** — runtime guards.
5. **Execute** each action in the plan via the right tool (table below).
5a. **`python3 scripts/autopilot/heartbeat.py --last-action=<type>`** — write the per-turn heartbeat line. `<type>` is the `type` of the LAST action executed in step 5 (or `wait` / `(none)` if the plan was a no-op). MUST run on every iteration, even when the plan only contained a `wait` — file mtime is the operator's liveness signal (issue #435).
6. **Re-enter step 1.** No inline reasoning between steps.

> **`state.turn` is owned by the decide.py CLI (issue #1769).** One bump per
> `decide` invocation, persisted atomically before `decide()` runs, so the
> plan's `turn` stamp equals the persisted state.json `turn` by construction
> and the heartbeat's strict plan-freshness equality (#1732/#1735) always
> holds. The session MUST NOT write `turn` — neither an explicit increment
> nor a whole-file rewrite of state.json from a stale snapshot (run 69442b4c
> hit a session-improvised increment racing the heartbeat, which zeroed
> turns 2–9's action ledgers run-wide). Session-side state updates (slots,
> dispatches, tokens, signals) are targeted field edits only. A violation
> surfaces loudly as a `plan-stale-skipped: ... exact off-by-one ...` reason
> in the turn record.

## Class taxonomy (7 pipeline slots + 14 signal classes)

| Kind | Class | Skill |
|---|---|---|
| pipeline | `dev_orch` | hydra-dev |
| pipeline | `qa_orch` | hydra-qa |
| pipeline | `research_orch` | hydra-research / hydra-issue-research |
| pipeline | `dev_target` | hydra-target-build |
| pipeline | `qa_target` | hydra-qa (target scope) |
| pipeline | `research_target` | hydra-target-research |
| pipeline | `design_concept_orch` | hydra-grill (Phase B, warn-only) |
| signal | `health` | hydra-doctor (scope-agnostic) |
| signal | `sweep_orch` | hydra-sweep |
| signal | `sweep_target` | hydra-target-sweep |
| signal | `discover_orch` | hydra-discover |
| signal | `discover_target` | hydra-target-discover |
| signal | `scout_orch` | hydra-tool-scout (Phase B, weekly calendar walk) |
| signal | `architecture_orch` | hydra-architecture-scan (#788; idle-time fallback, issue-producing) |
| signal | `retro_orch` | hydra-retro (#919; daily per-run retrospective, issue-producing + ≤1 gated PR) |
| signal | `cleanup_orch` | hydra-cleanup (#960; board-idle deterministic dead-code/simplification scan, issue-producing → `ready-for-agent`) |
| signal | `cleanup_target` | hydra-target-cleanup (Target mirror of cleanup_orch; demote-only dead-export sweep over ~/hydra-betting, backlog-item-producing → `ready-for-agent` + `queued`) |
| signal | `wire_or_retire_target` | hydra-wire-or-retire (#2722, epic #2720; judgment counterpart to cleanup_target — resolves triage `wire-or-retire` items into WIRE/RETIRE/UNCLEAR verdicts; 24h cooldown, ≤2 items/run, model param omitted) |
| signal | `design_qa_target` | hydra-design-qa (#2739, parent #2732; periodic VISUAL QA — screenshots every nav-registry route + judges vs the Target design ADR's [judgment] rules, files ≤3 deduped `needs-triage` design-qa items/run; 7d calendar cooldown, >5-open saturation backstop, model param omitted) |
| signal | `skill_prune` | hydra-skill-prune (#2949, epic #2944; eval-gated PROMPT counterpart to cleanup_orch — prunes ONE playbook-generated skill/run along the Pocock taxonomy [duplication/sediment/no-op], gated on promptfoo golden-task parity, ≤1 T1/T2 PR/run editing only that playbook + its regenerated skill + tightened ratchet baseline, else files a `needs-triage` candidate list; 7d calendar cooldown, saturation backstop, `apply:true`, model param omitted) |
| signal | `wayfinder_orch` | **ticket-type routed** (#3351, epic #3350, ADR-0029; the single AFK working class for wayfinder maps — works the next unblocked, unclaimed AFK-typed frontier ticket on an open approved `wayfinder:map`. The `skill` is resolved at dispatch time from `prompt_args.ticket_type`: `research` → hydra-issue-research, `task` → hydra-dev. 1h cooldown, one ticket/fire, model param omitted; collect-state.sh owns the native GraphQL frontier enumeration, decide.py stays pure) |

> **CONTEXT POINTER:** per-class wiring details (cooldowns, saturation guards, scope, cadence) for `scout_orch`, `dev_target` cost-cap backstop, `architecture_orch`, `retro_orch`, `cleanup_orch`, and `design_concept_orch` live in `hydra-autopilot-class-wiring.md` (sibling of this SKILL.md). The authoritative source for dispatch policy is `decide.py`.

Pipeline slots: at most one subagent per slot in flight. Signal classes
track only their last-fired timestamp under `signal_last_fired` — no
slot semantics, just cooldowns. The scope filter (`limits.scope`) is an
**exclusion mask** (`orch-only` / `target-only` / `all`); `health` is
the only scope-agnostic class. See `decide.py:scope_excluded()` and
INV-008.

## Action-to-tool table

| Action type | Tool the model invokes |
|---|---|
| `dispatch` | `Agent(run_in_background=True, isolation="worktree", model=<resolved>, ...)` — **resolve `<model>` from the action's `slot` (the dispatch class) via the Per-class model routing map below and pass it to the `Agent` call** (issue #1093). A class absent from the map → omit `model`, inheriting the parent session. `decide.py` stays pure: it emits no model field; the model lever lives here in the playbook, keyed off the `slot`/class the action already carries. The action carries `worktreeBranch` (stamped by `decide.py:_synthesize_worktree_branch`; issue #527) so the dashboard's slice-4 "Watch stream" cross-link can scope `/agents/stream?agent=<branch>`. The action ALSO carries `dispatchSentinel` (issue #692) — a hidden HTML comment of the form `<!-- hydra-dispatch v1 skill=… dispatchId=… runId=… -->`. **Prepend `action.dispatchSentinel` verbatim, on its own line, to the FIRST user message of the Agent prompt** (before the worktree-guard preamble). The project-scoped `SessionStart` hook (`scripts/hooks/session-start-capture.sh`, registered in `~/hydra/.claude/settings.json`) scrapes that sentinel from the session transcript and registers the subagent session into `hydra:dispatches:subagent:*` so every live session is recoverable to `(skill, dispatchId, runId, startedAt)`. When `decide.py` does not emit `dispatchSentinel` (legacy plans / a dispatch with no `skill`), skip the prepend — the session simply won't auto-register. |
| `auto-merge` | `Bash` → `gh pr review --approve && gh pr merge --auto --squash`, then a SINGLE `POST /api/holdback/pending {prNumber, tier, cycleId}` register call (see Phase 6). The handler does NOT itself enroll the holdback or write the merged cycle-record — it only ARMS the PR; the in-process merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`, issue #2623) fires both merge-coupled follow-ups once the merge lands. |
| `route-prs-to-review` | `Bash` → emitted only while the operator-only **emergency brake** (issue #744) is engaged, IN PLACE OF every `auto-merge` action. The model routes the current open PRs to the `/hydra-review` pickup set: `gh pr list --repo gaberoo322/hydra --state open --json number` to enumerate them, then for each apply the review label (`gh api .../labels` — `gh pr edit` is broken, per operator memory) so `/hydra-review` surfaces them. The action carries no per-PR list — `decide()` is pure and cannot enumerate PRs. Because the brake suppresses all `auto-merge`, no PR auto-merges this turn; the operator clears the brake via `hydra brake off` once the incident is resolved. The autopilot NEVER engages or disengages the brake — there is no such action type. |
| `apply-operator-approved` | `Bash` → `gh pr edit --add-label operator-approved` |
| `update-branch` | `Bash` → `gh pr update-branch` |
| `queue-decision` | `Bash` → `./scripts/autopilot/queue-decision.sh ...` |
| `reap` | `Bash` → `./scripts/autopilot/reap.py completion ...` (also fires `dispatch.sh cycle-record` for `hydra-dev` / `hydra-target-build`; see Phase 6) |
| `terminate` | `Bash` → `./scripts/autopilot/drain.sh <merged_prs>` → Phase 7. The decide CLI has already POSTed the clean run-end for this cause (issue #1352) — drain + digest are all that remain. |
| `wait` | sleep N; re-enter loop. Only emitted while slots are in flight (busy-wait nap / `wait_or_reap`) or after a non-dispatch housekeeping turn — a wait-only turn with zero occupied slots emits `terminate` (cause `idle`) instead, because a print-mode session exits on its final message and the wait would never be honoured (issue #1352). **Handoff baton-pass (issue #1903):** a `wait` while slots ARE occupied may be the LAST message of this print-mode turn — print mode physically exits when the model goes quiet across the nap, with subagents still mid-flight. When you end such a turn (slots in flight, no further dispatchable work this turn), POST `/api/autopilot/run-end` with `cause=handoff` BEFORE your final message — an honest baton-pass to the successor run, which re-seeds the slots from the surviving dispatch ledger (#1352). This is idempotent on `run_id` (same as the `terminate` path), and the ExecStopPost reap backstop derives `handoff` from `state.json.slots_occupied > 0` even if you miss the POST, so the baton-pass is never mis-stamped `interrupted`. |
| `wait-for-api` | `curl --retry`; re-enter loop |

### Per-class model routing (issue #1093)

Background `Agent`-dispatched subagents inherit the **parent autopilot
session's model** (the operator's saved default — Fable 5 since 2026-06-10)
unless the dispatch passes an explicit `model`.
Skill frontmatter is NOT a sufficient lever — a background dispatch ignores the
skill's declared model and inherits the parent. So the `dispatch` action-to-tool
row resolves `model` from the action's `slot` (the class) via the static map
below and passes it to the `Agent` call. `decide.py` is **pure and emits no
model field** (the README "Subagent Routing" design principle): the map lives in
this playbook, not in `decide()`.

Right-sized by **stakes × frequency** — drop the high-frequency non-authoring
classes off the frontier model; keep authorship and behaviour-reshaping classes
on Fable 5 (the frontier model, replacing Opus as of 2026-06-10).

| Class (`slot`) | Model | Rationale |
|---|---|---|
| `dev_orch` | Fable 5 (keep) | Multi-file, tier-gated self-modification |
| `dev_target` | Fable 5 (keep) | Money-critical betting code |
| `retro_orch` | Fable 5 (keep) | Reshapes future behaviour; per-run low volume |
| `design_concept_orch` | Fable 5 (keep) | A weak design concept wastes a full dev+QA cycle |
| `qa_orch` | Sonnet | Highest ROI; structured review against an artifact, ~every PR |
| `qa_target` | Sonnet | Floor — money-critical review, do NOT drop below Sonnet |
| `sweep_orch` / `sweep_target` | Sonnet | Board-routing decisions, not authorship |
| `health` | Sonnet | Structured diagnosis; rare small fixes |
| `research_orch` | Sonnet | Bounded codebase+web enrichment, not design |
| `research_target` | Sonnet (trial) | Strategic; trial, watch priority quality, revert on drift |
| `architecture_orch` | Sonnet | Non-interactive Explore+emit wrapper |
| `scout_orch` | Sonnet | Search + rubric scoring (low frequency, modest ROI) |
| `cleanup_orch` | Haiku | Deterministic knip output; LLM only formats findings into issues |
| `cleanup_target` | Haiku | Deterministic knip output + tested emit runner; LLM only drives the two commands |
| `wire_or_retire_target` | inherit parent (omit `model`) | Judgment work — recover a module's intent (git archaeology + vision/priorities/backlog cross-ref) and decide WIRE/RETIRE/UNCLEAR. NOT deterministic like `cleanup_target`; a low tier hits the documented Haiku-premature-exit failure mode (narrates "standing by", files nothing). Omit `model` so it inherits the parent (Fable 5), per #1093. |
| `design_qa_target` | inherit parent (omit `model`) | Visual judgment work — grade every route's screenshot against the Target design ADR's [judgment] rules (consistency / density / empty-state honesty). Like `wire_or_retire_target` it is an opinion, not a deterministic check; omit `model` so it inherits the parent (Fable 5), per #1093, to avoid the Haiku-premature-exit failure mode. |
| `discover_orch` / `discover_target` | Haiku | Patrol/diagnostics, designed small/fast/cheap |
| `wayfinder_orch` | inherit parent (omit `model`) | Works a wayfinder-map frontier ticket (research enrichment or a `wayfinder:task` build) — real authoring/judgment on a foggy initiative, not a deterministic check. Omit `model` so it inherits the parent (Fable 5), per #1093, avoiding the Haiku-premature-exit failure mode. |

Use the harness's model alias (`fable` / `sonnet` / `haiku` / `opus`) for the
`model` kwarg so the operator's plan resolves the concrete version. A class not
in the map (e.g. a legacy/unknown `slot`) → omit `model` and inherit the parent
session, the conservative default.

**Cascade-routing escalation override (issue #3274).** When a `dispatch` action
carries `prompt_args.escalate_model` (a string model alias, e.g. `sonnet`), that
value **overrides** the static per-class model resolved from the map above for
that ONE dispatch — pass `model=action.prompt_args.escalate_model` to the `Agent`
call instead of the class's default. This is the cascade-routing lever: `decide.py`
re-dispatches a cheap-tier class (today `cleanup_orch` at Haiku) that just
`no_op`'d / `failed` at a stronger tier, but stays PURE — it emits only the
`escalate_model` HINT (never a concrete `model` field; the model lever stays here
in the playbook per #1093). The escalation action also carries
`prompt_args.attempt` (the escalated attempt number) — **stamp it onto the new
slot (`slot["attempt"] = action.prompt_args.attempt`)** so a subsequent `no_op`
of the escalation attempt reads `attempt >= max_attempts` in `decide_escalation`
and never triggers a THIRD dispatch (the `ESCALATION_POLICY` max-attempts cap,
default 2). `prompt_args.prior_attempt_status` records what triggered the
escalation, for turn-journal visibility. A dispatch with no `escalate_model` key
uses the static routing map unchanged (zero behavior change for non-escalated
work). The escalation policy + reducer live in `scripts/autopilot/decide.py`
(`ESCALATION_POLICY`, `decide_escalation`); a class absent from that dict never
escalates.

**MANDATORY — deposit the escalation provenance (issue #3284).** The moment you
execute a `dispatch` action carrying `prompt_args.escalate_model`, deposit the
cascade-routing provenance so `scripts/autopilot/reap.py`'s
`_read_escalation_deposit` can read it back and forward it on the single
cycle-record write — otherwise `escalationAttempt` / `escalatedModel` land
permanently null on the durable per-dispatch outcome record and
`/metrics/cascade-routing` reports a structural 0 cost-delta + 0
postEscalationMergeRate forever. This is the WRITE half of the read path reap.py
already implements. Unlike the reflection/grounding deposits (written by the
worktree subagent from its own `agent-<HASH>` cwd), the escalation provenance is
known ONLY to you (the harness) at dispatch time, so pass the escalated
dispatch's **task_id explicitly** — the slot `task_id` you just allocated (the
`worktree-agent-<HASH>` suffix `reap.py` keys the completion on). Run this
BEFORE (or right alongside) the `Agent(...)` dispatch:

```bash
# scripts/reflection-deposit.sh is a worktree-relative helper; resolve it from
# the repo root so a mid-turn `cd` can't lose it. Substitute the values from the
# dispatch action's prompt_args (escalate_model / attempt / prior_attempt_status)
# and the escalated slot's task_id.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
bash "$REPO_ROOT/scripts/reflection-deposit.sh" escalation \
  "<skill_of_escalated_class>" "<escalated_task_id>" \
  "<prompt_args.escalate_model>" "<prompt_args.attempt>" \
  "<prompt_args.prior_attempt_status>"
```

The helper writes `hydra-escalation-<task_id>` only when the provenance is
well-formed (a positive `attempt` and non-empty model), so a malformed
invocation can never fabricate a bogus escalation marker. A non-escalated
dispatch never runs this — no deposit → reap omits the fields (truthful null,
the overwhelming majority).

### `wayfinder_orch` dispatch — ticket-type → skill (issue #3351, epic #3350, ADR-0029)

`wayfinder_orch` is the single AFK working class for **wayfinder maps** (open
issues labelled `wayfinder:map`). `decide.py` fires it on the pre-resolved
`wayfinder_orch_frontier` signal (`collect-state.sh` owns the native GraphQL
frontier enumeration — `decide.py` stays pure), emitting a `dispatch` action
whose `prompt_args` carry the pre-resolved **`ticket`** (`issue-<N>`) and its
**`ticket_type`** (`research` | `task`). `decide.py` emits `skill:
"hydra-issue-research"` as the taxonomy default; **you MUST override it from
`ticket_type` at dispatch time**:

- `ticket_type == "research"` → **hydra-issue-research** on the frontier ticket
  (`prompt_args.ticket`). Enrich the ticket's body with codebase + web findings.
- `ticket_type == "task"` → **hydra-dev** on the frontier ticket. Implement it in
  a worktree and open a PR whose body ends `Closes #<N>`.

Only these two AFK-typed tickets ever reach here — the HITL types
(`wayfinder:grilling`, `wayfinder:prototype`) route to the interactive
`/wayfinder`, never to autopilot (the off-radar rule: `wayfinder:*` tickets carry
no standard lifecycle labels, so the ordinary sweeps stay blind; this frontier
signal is their ONLY AFK dispatch path). The dispatch OMITS `model` (inherit the
parent per #1093 — real authoring/judgment).

**Resolution protocol (AC #1) — the worker records the outcome on the map.** When
the dispatched worker finishes the frontier ticket, it MUST, before the ticket is
considered resolved:

1. Post a **resolution comment** on the frontier ticket summarising the verdict /
   PR / findings (`gh issue comment <N> --body '…'`).
2. **Close** the ticket (`gh issue close <N>`) — a `task` ticket closes when its
   PR merges; a `research` ticket closes once its enrichment lands.
3. **Append to the map's `## Decisions so far`** section (edit the map issue body)
   so the map's running ledger reflects the newly-cleared frontier — the next
   `collect-state.sh` tick then surfaces the NEXT unblocked frontier ticket.

The 1h `wayfinder_orch` cooldown means one frontier ticket per fire; the map is
worked one cleared ticket at a time across ticks until its frontier is empty (all
AFK tickets closed), at which point `wayfinder_orch_frontier` reads `none` and the
class idles until a new map or a newly-unblocked ticket appears.

**Fallback when Fable 5 is unavailable.** The `fable` alias is not entitled in
every environment — a background `Agent(model="fable", …)` dispatch can die in
<1s with *"There's an issue with the selected model (claude-fable-5) … it may
not exist or you may not have access to it"* (0 tokens, 0 tool uses). When a
`fable`-routed dispatch terminates immediately this way (no tool uses + a
model-access error), **re-dispatch the identical action with `model: "opus"`
(Opus 4.8) — do not leave the class unrun.** Opus 4.8 is the frontier-capable
fallback for the authoring/behaviour-reshaping classes (`dev_orch`,
`dev_target`, `retro_orch`, `design_concept_orch`). Fable 5 stays the primary;
the fallback fires only on the model-access failure, so each class
auto-upgrades back to Fable once the alias is entitled again — no manual revert.
The Sonnet/Haiku-routed classes resolve independently and are unaffected.

## Phases (one-line each — full prose lives in code)

- **Phase 0** — `bootstrap.sh "$@"` initialises `/tmp/hydra-autopilot-state.json` (slash args via `args-parse.sh`), then the **schema-version handshake** (see below) runs before any other phase
- **Phase 1** — `collect-state.sh` emits signal counts (~100ms)
- **Phase 1.5** — `recover-stale.sh stale_in_progress <N...> stale_blocked <M...>`
- **Phase 2** — `reap.py` hard-cap sweep (idempotent; #395)
- **Phase 3** — `decide.py decide state.json cands.json events.json` returns the plan
- **Phase 4** — `assert_invariants.py plan.json state.json`
- **Phase 5** — model executes each action via the table above
- **Phase 6** — cycle-record write (#430) + sleep until next event or 15-min heartbeat

> **CONTEXT POINTER:** full Phase 6 implementation contracts (cycle-record write, register handoff on auto-merge, token-surrogate write) live in `hydra-autopilot-phase6-ops.md` (sibling of this SKILL.md).

- **Phase 7** — `drain.sh <merged_prs>` + final `hydra-digest` dispatch (end-of-run summary; the morning timer's digest lands around 19:00, the evening timer's around 05:00)

## Phase 0 schema-version handshake (issue #434)

After `bootstrap.sh` exits successfully, but BEFORE invoking Phase 1
(`collect-state.sh`), the model MUST verify the playbook's expected
schema matches the schema bootstrap wrote:

```bash
PLAYBOOK_SCHEMA=$(grep -oP '^HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA:\s*\K[0-9]+' \
  docs/operator-playbooks/hydra-autopilot.md)
STATE_SCHEMA=$(jq -r '.limits.schema_version // 1' /tmp/hydra-autopilot-state.json)

if [ -z "$PLAYBOOK_SCHEMA" ]; then
  echo "[autopilot] FATAL: playbook missing HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA marker; run scripts/sync-skills.sh"
  exit 1
fi
if [ "$PLAYBOOK_SCHEMA" != "$STATE_SCHEMA" ]; then
  echo "[autopilot] FATAL: schema mismatch (playbook expects v${PLAYBOOK_SCHEMA}, state.json v${STATE_SCHEMA}; run scripts/sync-skills.sh)"
  exit 1
fi
echo "[autopilot] schema handshake OK (v${PLAYBOOK_SCHEMA})"
```

Why: PR #429 changed the state.json shape (10 flat slots → 6 pipeline
slots + 5 signal_last_fired) but the installed `~/.claude/skills/`
mirror of this playbook was stale because `sync-skills.sh` hadn't run.
The model attempted to reconcile and silently wedged for ~20 min
producing no observable output. The handshake makes that wedge a
loud abort at second 0 of the run instead of an invisible stall at
minute 20.

A v1 state.json (legacy, no `schema_version` field) is interpreted as
v1 via the `// 1` jq fallback above — mismatched against any modern
playbook, the handshake aborts and the operator re-runs after
`bootstrap.sh` writes a fresh v2 state on next invocation. There is
no in-place upgrader: bootstrap is the single writer for state.json.

## Termination

`decide.py` emits a `terminate` action when the token budget, wall-clock limit, idle-drain turns, or failure backstop trips, or when the turn is wait-only with zero occupied slots (handoff baton-pass). Full termination conditions and the handoff baton-pass contract (issue #1903) are in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

## Worktree-guard preamble (REQUIRED for code-writing dispatches)

```
## CRITICAL SAFETY RULE — READ FIRST
Run `pwd` and `git rev-parse --git-dir` first.
- Worktree path AND `.git/worktrees/...` gitdir → proceed.
- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT.
No fallback. No `git checkout` in the main tree.
```

The preamble catches cwd-confusion. The companion guard is the PreToolUse
**worktree-write-fence** (issue #549), which catches the more insidious
failure: cwd is correct, but an `Edit`/`Write`/`MultiEdit` tool call
passes a `file_path` that resolves outside the worktree (the bug observed
on the PR #548 dispatch). Operators install it once with `bash
scripts/setup-claude-hooks.sh`; the hook source-of-truth lives at
`scripts/claude-hooks/worktree-write-fence.sh`. When active, the hook
denies any out-of-worktree write from a worktree-cwd session and the
agent must self-correct. `scripts/audit-ghost-writes.py` walks the
JSONL transcript history to quantify ghost-write incidents across past
dispatches (useful as a before/after measurement when the hook is rolled
out).

**`dev_target` dispatches need a SECOND check (issue #542).** The harness `isolation: "worktree"` only worktree-isolates the orchestrator repo (`~/hydra`). When `hydra-target-build` then writes to `~/hydra-betting`, those edits land on the main hydra-betting checkout unless the skill explicitly creates a hydra-betting worktree. The `hydra-target-build` playbook now does this in Step 0.6 — every `dev_target` dispatch MUST go through Step 0.6 before any Edit/Write against the target.

```
## TARGET-REPO SAFETY RULE — applies to dev_target only
Before writing to ~/hydra-betting:
- Create a hydra-betting worktree (see hydra-target-build Step 0.6).
- Verify `git -C <worktree> rev-parse --git-common-dir` resolves to ~/hydra-betting/.git
  AND `git -C <worktree> rev-parse --git-dir` contains `.git/worktrees/`.
- Use ONLY worktree-anchored paths for Edit/Write — never raw `/home/gabe/hydra-betting/...`.
- ABORT if any check fails. The two-repo asymmetry was the silent-leak failure mode in #542.
```

## Inspecting a run

- **One-shot status:** `bash scripts/autopilot/status.sh` — pretty-prints the heartbeat (+ wedge verdict), the compact state, and the log tail. Safe to wire to a shell prompt.
- Heartbeat: `cat /tmp/hydra-autopilot-heartbeat.txt`
- Liveness probe: `find /tmp/hydra-autopilot-heartbeat.txt -mmin -10` — the model writes the heartbeat every decision turn (Phase 5a). An empty result means no turn completed in the last 10 minutes.
- Live state: `jq '.slots,.signal_last_fired,.burned_classes' /tmp/hydra-autopilot-state.json`
- Run log: `tail -100 /tmp/hydra-autopilot-nightly.log` (filename is historical from when there was only a 22:00 fire; both timers still write here)
- Last decision plan: `jq . /tmp/hydra-autopilot-plan.json`
- Failure ledger: `tail /tmp/hydra-autopilot-failures.jsonl`

### Per-turn heartbeat format (issue #435)

After Phase 0, every decision turn overwrites `/tmp/hydra-autopilot-heartbeat.txt` with one line of the form:

```
<epoch> <pid> <run_id> turn=<N> dispatches=<M> tokens=<K> pipeline_filled=<F>/6 signal_active=<S>/5 last_action=<type>
```

The first turn after bootstrap stamps `last_action=bootstrap`; subsequent turns substitute the type of the most recent executed action (`dispatch`, `auto-merge`, `reap`, `wait`, etc.).

### Wedge detection: stale heartbeat + live process == wedge

`claude -p` buffers stdout, so a running autopilot may produce no observable terminal output for many minutes at a stretch. The heartbeat file is the only liveness signal the operator can trust.

**Decision rule:**

| Heartbeat mtime | Process pid alive? | Verdict |
|---|---|---|
| Within last 10 min | yes | Healthy (model is looping) |
| Within last 10 min | no | Already terminated cleanly — check log tail |
| >10 min old | no | Crashed or killed externally — check `journalctl` or run log |
| **>10 min old** | **yes** | **Wedge.** Model is alive but no longer producing decision turns. |

A wedge is the failure mode the 2026-05-15 incident exposed: a stale schema mirror caused the model to silently reconcile two worldviews and stop looping after Phase 0, while the parent `claude -p` process sat live producing no output for ~20 min. Recover with `kill <pid>` and restart the autopilot. File a `needs-triage` issue with the run-log tail.

```bash
# Quick wedge check:
hb=/tmp/hydra-autopilot-heartbeat.txt
if [ -z "$(find "$hb" -mmin -10 2>/dev/null)" ]; then
  pid=$(awk 'NR==1 { print $2 }' "$hb")  # per-turn format: pid is field 2
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "WEDGE: pid $pid alive, heartbeat stale"
  fi
fi
```

`scripts/autopilot/status.sh` runs the above automatically.

## Invocation

The skill is operator-invocable AND scheduled. Both paths run the same
`/hydra-autopilot` entrypoint and obey the same token / wall-clock budgets.

### Manual

Invoke from an interactive Claude Code session with `/hydra-autopilot`, or
headless from the shell:

```bash
claude --dangerously-skip-permissions -p "/hydra-autopilot"
# Short smoke:
HYDRA_AUTOPILOT_TOKEN_BUDGET=100000 HYDRA_AUTOPILOT_MAX_SEC=600 claude --dangerously-skip-permissions -p "/hydra-autopilot"
# Scope-restricted:
HYDRA_AUTOPILOT_SCOPE=orch-only claude --dangerously-skip-permissions -p "/hydra-autopilot"
```

Slash-args (`--scope=`, `--tokens=`, `--max-sec=`, `--idle-turns=`,
`--subagent-soft=`, `--subagent-hard=`, `--unattended=`) parse via
`args-parse.sh` and override env vars.

### Scheduling — the Pace Gate (ADR-0021)

The autopilot is launched by the **Pace Gate** — a usage-paced admission
controller, NOT a fixed daily schedule. The legacy morning (10:00) and
evening (22:00) timers are **retired** (issue #858); a single frequent
(~15 min) timer now decides whether to launch each Autopilot Run based on
where total weekly burn sits relative to the **Pacing Curve**.

| Unit | Fires | File |
|---|---|---|
| `hydra-pace-gate.timer` | every ~15 min | `scripts/systemd/hydra-pace-gate.timer` |
| `hydra-pace-gate.service` | (oneshot, runs the gate) | `scripts/systemd/hydra-pace-gate.service` |

On each tick `scripts/autopilot/pace-gate.sh`:

1. **Skip if a run is already live** — the service is active OR
   `/tmp/hydra-autopilot-state.json` carries a live owning PID (`kill -0`).
2. **Consult `/api/usage/eligibility`** (the Pacing Curve, #857): skip when
   `.reasons.paused == true` (operator pause, #988), `.reasons.sessionBlockedUntil`
   is a future instant (session-limit hard block, #1089),
   `.reasons.emergencyStop == true` (5h cap ≥ 90%) or `.paceState == "ahead"`
   (above the curve); otherwise (`on`/`behind`, not emergency) launch via
   `systemctl --user start hydra-autopilot.service`.
3. **Fail safe** — if the eligibility endpoint is unreachable, do NOT launch
   (pacing is the governor; don't burn quota while blind to usage).

**Session-limit hard block (#1089).** When the Claude Code rolling *session*
window is exhausted the CLI prints `You've hit your session limit · resets <t>`
and the autopilot exits `code=1`. The reap-on-exit backstop (`bootstrap.sh
--reap`) scans the journal for that line and POSTs it to
`POST /api/usage/session-block`, which parses the reset and records a
self-expiring block (`hydra:autopilot:session-blocked-until`, TTL to the reset
instant). While the block is in the future the eligibility route forces
`allow=false` and surfaces `reasons.sessionBlockedUntil`, so the Gate skips
relaunch into the exhausted quota instead of dying instantly on repeat. The
OAuth 5h `emergencyStop` undershoots the true session limit, so this is the
authoritative "the next run cannot make a single turn" signal. Admission
resumes automatically once the reset passes (TTL expiry + a past-instant read
guard) — no operator action needed.

The Gate governs *admission* only (should a run start now?), never *what work*
to do — that stays with `decide.py` (ADR-0012). It reuses the existing
watchdog, bootstrap concurrent-run guard, and the service's
`Restart=on-failure` untouched; it only ever *starts* the service.

`scripts/deploy.sh` installs `pace-gate.sh` to `~/.local/bin/`, retires the
legacy launch timers, and enables `hydra-pace-gate.timer` on every deploy.
Operator install / migration (one-time, if not relying on deploy):

```bash
# Retire the legacy launch timers (no-op on a fresh host).
systemctl --user disable --now hydra-autopilot-morning.timer hydra-autopilot.timer 2>/dev/null || true
rm -f ~/.config/systemd/user/hydra-autopilot-morning.timer \
      ~/.config/systemd/user/hydra-autopilot.timer

# Install + enable the Pace Gate (hydra-autopilot.service itself is unchanged).
install -D -m 0755 scripts/autopilot/pace-gate.sh ~/.local/bin/hydra-pace-gate.sh
cp scripts/systemd/hydra-pace-gate.service scripts/systemd/hydra-pace-gate.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hydra-pace-gate.timer
```

Inspect: `systemctl --user list-timers | grep pace-gate`,
`journalctl --user -u hydra-pace-gate.service` (admission decisions), and
`journalctl --user -u hydra-autopilot.service` after a launch.

Each launched run is still sized for up to 8h of work (the service's 9h
`RuntimeMaxSec` + 8h internal budget); the "already running" skip in step 1
prevents the ~15-min timer from ever stacking a second run on top of a live
one. The autopilot self-terminates on `idle_drain_turns` when there's nothing
to do. The L2 decision brain in `decide.py` benefits from a stable in-process
view of pipeline state across many turns, so the Gate launches one long run
and lets it run to budget/clock/idle rather than firing many short bursts.

## Slot lifecycle events (issue #509)

Subagent slot accounting is event-driven: `SubagentStop` and `Notification` hooks XADD events onto `hydra:autopilot:slot-events`; `collect-state.sh` drains it each turn; `decide.py` translates `subagent_stop` events into completions and appends failures to `state.failure_log`. A silent-wedge wall-clock fallback (`subagent_max_wall_seconds=3600`) covers hook failures. Full event schema, turn-consumption detail, env overrides, and best-effort guarantees are in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

## Signal wiring (state.signals)

`collect-state.sh` emits raw counts; the model turns them into the
boolean signals decide.py reads from `state.signals`. The key mappings:

| collect-state output | state.signals key | Drives |
|---|---|---|
| `ready_for_agent > 0` (orch GH board) | `orch_work_available` | `dev_orch` (issue #458) |
| `work_queue > 0` (target Redis queue) | `target_work_available` | `dev_target` |
| `needs_qa > 0` (orch GH board) | `needs_qa_orch` | `qa_orch` |
| `needs_research > 0` (orch GH board) | `needs_research` | `research_orch` |
| `needs_triage > 0` (orch GH board) | `needs_triage_orch` | `sweep_orch` |
| `untriaged_orphans > 0` (orch GH board — open issues carrying NONE of {ready-for-agent, in-progress, blocked, needs-qa, needs-triage, needs-research, target-backlog}) | `untriaged_orphans_orch` | `sweep_orch` (issue #2426) — triage backstop: routes mislabeled/orphaned issues invisible to BOTH the dev_orch and needs_triage_orch paths into an actionable lane |
| `health=FAIL` or `failed_services>0` | `health_fail` | `health` |
| `scout_last_walk_iso` >7d old or empty | `scout_walk_due` | `scout_orch` (issue #485) |
| `scout_board_open_enhancements > 20` | `scout_board_saturated` | suppresses `scout_orch` |
| `scout_spend_usd_today` | (read directly from state) | suppresses `scout_orch` via cost-cap (issue #532) |
| `dev_target_spend_usd_cycle` | (read directly from state) | halts `dev_target` via per-cycle cost-cap backstop (issue #1059) |
| `arch_fallback_due` (`ready_for_agent==0 && needs_research==0 && needs_triage==0 && work_queue==0`) | `arch_fallback_due` | `architecture_orch` (issues #789/#790) |
| `arch_board_open_scan > ARCH_BOARD_SATURATION_CAP (6)` → `arch_board_saturated` | `arch_board_saturated` | suppresses `architecture_orch` (checked FIRST) |
| `orch_backfill_idle` (same signal as above) | `orch_backfill_idle` | also drives `cleanup_orch` (issue #960) — NOT staggered, so it may co-fire with the backfill set |
| `cleanup_board_open_scan > CLEANUP_BOARD_SATURATION_CAP (10)` → `cleanup_board_saturated` | `cleanup_board_saturated` | suppresses `cleanup_orch` (checked FIRST, mirrors `arch_board_saturated`) (issue #960) |
| `target_backfill_idle` (target triage + queued lanes empty AND `work_queue==0`) | `target_backfill_idle` | drives `cleanup_target` (Target mirror of cleanup_orch; API-down degrades to `false`) |
| `target_cleanup_board_open_scan > 10` → `target_cleanup_board_saturated` | `target_cleanup_board_saturated` | suppresses `cleanup_target` (checked FIRST; API-down degrades to `true` — fail closed) |
| `wire_or_retire_target_triage > 0` (≥1 open `wire-or-retire`-labelled item in the Target `triage` lane) → `wire_or_retire_target_available` | `wire_or_retire_target_available` | drives `wire_or_retire_target` (issue #2722, epic #2720) — the judgment resolver; 24h class cooldown, ≤2 items/run; API-down degrades to `false` (fail closed) |
| `/api/autopilot/runs` index has ≥1 non-`running` run | `retro_run_available` | `retro_orch` (issue #920) — daily per-run retrospective; 24h class cooldown enforces the once-per-day cadence |
| `usage_eligibility_json` | `state.usage_eligibility` (object, merged verbatim) | hard-stop all dispatches when `allow=false`; skip listed classes when `shed` non-empty (PR B1). `shed` is the UNION of the weekly-projection pacing shed (`pacingState==="over"`) and the graduated 5h-utilization throttle (issue #1087, keyed off `percentLast5h` against `HYDRA_USAGE_5H_THROTTLE_T1/T2`); `reasons.fiveHourThrottleShed` flags the latter |
| `emergency_brake_json` | `state.emergency_brake` (object, merged verbatim) | operator-only emergency brake (issue #744): when `engaged=true`, `decide()` emits ZERO `auto-merge` actions and a single `route-prs-to-review` action that arms the /hydra-review pickup set. Default `{engaged:false}`. READ-ONLY — the autopilot can never set/clear it (no engage/disengage action type); the sole write path is `hydra brake on\|off`. |
| `orch_pending_grill_anchor=issue-N` (or `none`) | `state.signals.orch_pending_grill_anchor` (string, or omit — verbatim, no rename) | `design_concept_orch` fires hydra-grill on the named anchor; `dev_orch` yields the same turn (issue #628). Key name aligned in #736 so collect-state emits exactly what decide.py reads — no model-mediated rename. |
| `wayfinder_orch_frontier=issue-N` (or `none`) | `state.signals.wayfinder_orch_frontier` (string, or omit — verbatim, no rename) | `wayfinder_orch` (issue #3351, epic #3350, ADR-0029) — the pre-resolved next AFK-typed, unblocked, unclaimed frontier ticket across all open **approved** (`wayfinder:map` minus `wayfinder:destination-pending`) maps. collect-state.sh owns the native GraphQL sub-issue/blocked-by enumeration so decide.py stays pure; gh/GraphQL-down degrades to `none` (fail closed). |
| `wayfinder_orch_ticket_type=research\|task` | `state.signals.wayfinder_orch_ticket_type` (string) | the frontier ticket's type, threaded into the dispatch `prompt_args.ticket_type` so the dispatch step below resolves ticket-type → skill (`research` → hydra-issue-research, `task` → hydra-dev). |

Pre-#458 `dev_orch` consumed `/api/anchor/candidates` and routinely
received target-product anchors (item-26x). Post-#458, candidates are
treated as target-side work: `dev_target` surfaces the top candidate as
a hint, and a low best-score forces `research_target` (not `research_orch`).

**Discover signals (revived).** `discover_orch` was **revived by issue #959**
(epic #958): it no longer gates on the dead `orch_idle` name — its `decide.py`
selector (`decide.py:2296`) now reads the unified **`orch_backfill_idle`**
board-empty signal, the SAME signal `architecture_orch` reads. Both classes are
members of `BACKFILL_SIGNAL_CLASSES` (`decide.py:329`) and share the 1h backfill
cadence, so `discover_orch` **fires today** on an idle orch board. `collect-state.sh`
emits `orch_backfill_idle` (line ~488); the dead `orch_idle` name it never
produced is gone. `discover_target` still gates on `target_idle` (its own
selector at `decide.py:2307`); whether that signal is produced is a separate
Target-side question.

**Backfill dedup baseline (issue #2554).** Because `discover_orch` and
`architecture_orch` both fire on `orch_backfill_idle`, the **one-per-turn
stagger guard** (it lets only one `BACKFILL_SIGNAL_CLASSES` member dispatch per
turn) prevents them co-firing the same TURN — but their independent per-class 1h
cooldowns plus the `BACKFILL_STARVATION_FLOOR` (`decide.py:331+`, which forces a
starved backfill class through) mean **both can dispatch within the same idle
HOUR**. `cleanup_orch` co-fires on the same signal every idle turn (it is
deliberately NOT in `BACKFILL_SIGNAL_CLASSES`, so exempt from the stagger).
`decide.py` cannot dedup this: it must stay a pure function of `(state, events,
now)` and cannot know what issues a just-dispatched skill WILL file (the filing
happens inside the subagent, after dispatch). The guard therefore lives **at
file-time inside the skill bodies**: `hydra-discover`, `hydra-architecture-scan`
(and `cleanup_orch`/`hydra-research`) each run every candidate through the SAME
deterministic helper `scripts/ci/issue-dedup.ts` (`isDuplicateIssue`,
normalised word-set Jaccard overlap >50%) against the SAME **shared backfill
dedup baseline** — open issues across EVERY backfill label set (`needs-triage` +
`architecture-scan` + `cleanup-scan` + `enhancement`) plus recently-closed — so
whichever class files second sees what the first just filed THIS idle window and
SKIPs the duplicate. The `discover_orch` ↔ `architecture_orch` co-fire is the
primary collision this baseline closes. The helper is a standalone script (NOT
an `@include` fragment), so it is independent of the `_fragments`/#2552 work.

> **CONTEXT POINTER:** troubleshooting quick-look (wrong dispatch, burned class, wedge, stale heartbeat), cross-run Redis mirror, termination baton-pass detail, slot lifecycle event schema + env overrides, and merge-rate stabilization history (2026-05 → 2026-06) live in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

## Safety rules

1. NEVER modify `~/hydra` or `~/hydra-betting` working trees directly.
2. Worktree-guard preamble is mandatory for `dev_orch` / `dev_target`.
3. One subagent per pipeline slot.
4. Token budget is a hard cap; subagent caps (#395) bound a single misbehaving subagent.
5. `hydra-architect` is operator-only.
6. Phase 7 is the only path to the end-of-run digest (idempotent shutdown).
