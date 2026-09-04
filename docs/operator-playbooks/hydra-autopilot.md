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
| pipeline | `dev_orch` | hydra-dev (**implement** stage — composed on the vendored upstream `implement` base, ADR-0030 Decision 2 / #3422) |
| pipeline | `qa_orch` | hydra-qa (**review** stage — composed on the vendored upstream `code-review` base, ADR-0030 Decision 2 / #3420) |
| pipeline | `research_orch` | hydra-research / hydra-issue-research |
| pipeline | `dev_target` | hydra-target-build |
| pipeline | `qa_target` | hydra-qa (target scope) |
| pipeline | `research_target` | hydra-target-research |
| pipeline | `design_concept_orch` | hydra-grill (Phase B, warn-only — the **spec** stage of the one-lineage refit; ADR-0030 Decision 2, superseded for this stage's base by ADR-0035) |

> **One-lineage stage bindings (ADR-0030 Decision 2; ADR-0035 supersedes the spec-stage base).** The three code-writing pipeline stages compose against the *same* vendored upstream Pocock skills the operator runs interactively (lineage home `docs/operator-playbooks/_vendor/`, ADR-0030 Decision 4 / Option C): the **implement** stage (`dev_orch` → `hydra-dev`) rides `_vendor/implement.md`, the **review** stage (`qa_orch` → `hydra-qa`) rides `_vendor/code-review.md`, and the **spec** stage (`design_concept_orch` → `hydra-grill`) composes on NO upstream base. The `decide.py` `make_dispatch` string literals (`hydra-dev` / `hydra-qa` / `hydra-grill`) **stay live and unchanged** — they are the class rows that *select* these composed stages, not a second inline copy of the pattern. The grill-before-build sequencing (the #628 gate; post-#3711 `dev_orch` yields **per-anchor** rather than board-wide — see the Signal wiring table) is a documentation/lineage rebind here, **not** a change to that `decide.py` gate.
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
| signal | `tickets_orch` | hydra-tickets (#3423, epic #3419, ADR-0030 Decision 2/5; the **tickets**-STAGE producer — turns a resolved plan into one parent epic + N tracer-bullet child issues. Dispatches the COMPOSED `hydra-tickets` skill (vendored `to-tickets` base + AFK overlay, #3992), never the bare upstream `to-tickets` (disable-model-invocation hard-errors) nor the demoted `hydra-prd` renderer. Fires on the `tickets_available` signal collect-state.sh emits from the oldest unassigned `needs-tickets` spec (#4014) — structural twin of `wayfinder_orch` (1h, plan-anchored, signal class, not pipeline), so likewise deliberately NOT seeded into bootstrap's carry-forward `signal_last_fired`. 1h cooldown, one spec/fire, model param omitted; collect-state.sh owns the GH enumeration + ref pre-resolution, decide.py stays pure) |

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
| `dispatch` | `Agent(run_in_background=True, isolation="worktree", model=<resolved>, ...)` — **resolve `<model>` from the action's `slot` (the dispatch class) via the Per-class model routing map below and pass it to the `Agent` call** (issue #1093). A class absent from the map → omit `model`, inheriting the parent session. `decide.py` stays pure: it emits no model field; the model lever lives here in the playbook, keyed off the `slot`/class the action already carries. The action carries `worktreeBranch` (stamped by `decide.py:_synthesize_worktree_branch`; issue #527) so the dashboard's slice-4 "Watch stream" cross-link can scope `/agents/stream?agent=<branch>`. The action ALSO carries `dispatchSentinel` (issue #692) — a hidden HTML comment of the form `<!-- hydra-dispatch v1 skill=… dispatchId=… runId=… -->`. **Prepend `action.dispatchSentinel` verbatim, on its own line, to the FIRST user message of the Agent prompt** (before the worktree-guard preamble). The project-scoped `SessionStart` hook (`scripts/hooks/session-start-capture.sh`, registered in `~/hydra/.claude/settings.json`) scrapes that sentinel from the session transcript and registers the subagent session into `hydra:dispatches:subagent:*` so every live session is recoverable to `(skill, dispatchId, runId, startedAt)`. When `decide.py` does not emit `dispatchSentinel` (legacy plans / a dispatch with no `skill`), skip the prepend — the session simply won't auto-register. **`dev_target` exception (issue #3889):** omit `isolation="worktree"` for `dev_target` dispatches ONLY. The harness's worktree isolation only covers the orchestrator repo (`~/hydra`); because `~/hydra-betting` is a sibling repo not nested under `~/hydra`, a pinned session is refused ALL git ops against it — which made `hydra-target-build` Step 0.6 (`git -C ~/hydra-betting worktree add …`) categorically fail (2/2 dispatches). `dev_target` isolates itself via Step 0.6's worktree (nested under `~/hydra-betting/web/.worktrees/` since issue #4177 — previously `/dev/shm/hydra-worktrees/`, relocated to eliminate the reach-back node_modules symlink hazard, #4175), and the installed `worktree-write-fence.sh` PreToolUse hook provides the ghost-write protection `isolation="worktree"` plays for the orchestrator-only classes. Every other class keeps `isolation="worktree"`. The preamble follows the same split (issue #4178): prepend the **dev_target variant** of the worktree-guard preamble (see the Worktree-guard preamble section) — NOT the default block, whose `cwd == /home/gabe/hydra → ABORT` line false-aborts a dispatch whose expected launch cwd is exactly that. `dev_target` ALSO carries its OWN dev_target forbidden-ending preamble variant (issue #4196): append that variant (see the Worktree-guard preamble section) immediately after the dev_target worktree-guard block — never the `dev_orch` block, which bans the Agent tool outright and would contradict `hydra-target-build`'s own delegated-mode contract. **`qa_orch` exception:** append the `qa_orch` forbidden-ending preamble variant (issue #4272; see the Worktree-guard preamble section) instead of the `dev_orch` block — it prohibits the same end-turn-on-a-child hazard but, unlike `dev_orch`'s flat ban, permits the blocking (`run_in_background: false`) reviewer spawns `hydra-qa` step 7's fan-out requires. |
| `auto-merge` | `Bash` → `gh pr merge --auto --squash`, then a SINGLE `POST /api/holdback/pending {prNumber, tier, cycleId}` register call (see Phase 6). **No self-approve prefix** — every agent shares the `gaberoo322` identity and GitHub 422s a self-approval, so chaining an approval before the merge (`… && gh pr merge …`) short-circuits and silently skips the merge-enable, leaving green PRs to pile up for admin-merge (reference_qa_cannot_self_approve / #848; hydra-qa removed the same trap via #974). There is no approving-review branch-protection gate — CI required-status-checks are the merge gate — so approval is a no-op regardless. Guarded by `test/autopilot-auto-merge-no-self-approve.test.mts`. The handler does NOT itself enroll the holdback or write the merged cycle-record — it only ARMS the PR; the in-process merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`, issue #2623) fires both merge-coupled follow-ups once the merge lands. |
| `route-prs-to-review` | `Bash` → emitted only while the operator-only **emergency brake** (issue #744) is engaged, IN PLACE OF every `auto-merge` action. The model routes the current open PRs to the `/hydra-review` pickup set: `gh pr list --repo gaberoo322/hydra --state open --json number` to enumerate them, then for each apply the review label (`gh api .../labels` — `gh pr edit` is broken, per operator memory) so `/hydra-review` surfaces them. The action carries no per-PR list — `decide()` is pure and cannot enumerate PRs. Because the brake suppresses all `auto-merge`, no PR auto-merges this turn; the operator clears the brake via `hydra brake off` once the incident is resolved. The autopilot NEVER engages or disengages the brake — there is no such action type. |
| `apply-operator-approved` | `Bash` → `gh pr edit --add-label operator-approved` |
| `update-branch` | `Bash` → `gh pr update-branch` |
| `queue-decision` | `Bash` → `./scripts/autopilot/queue-decision.sh ...` |
| `reap` | `Bash` → `./scripts/autopilot/reap.py completion ...` (also fires `dispatch.sh cycle-record` for `hydra-dev` / `hydra-target-build`; see Phase 6) |
| `terminate` | `Bash` → `./scripts/autopilot/drain.sh <merged_prs>` → Phase 7. The decide CLI has already POSTed the clean run-end for this cause (issue #1352) — drain (always) + digest (skipped for cause `context_compaction`, see Phase 7 below, issue #3787) are all that remain. |
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
classes off the frontier model; keep behaviour-reshaping and money-critical
authoring classes on Fable 5 (the frontier model, replacing Opus as of
2026-06-10) **when Fable is actually entitled**. Entitlement returned
2026-08-19 and was re-verified 2026-09-02 with the prescribed
`Agent(model="fable")` smoke test (`FABLE-OK: claude-fable-5`), so the map
routes the behaviour-reshaping and money-critical classes back to Fable — the
cost-emergency note before the table is retained as history and marked
superseded.

**`dev_orch` demoted to Sonnet 2026-07-29 — on evidence, not a cost guess.** The
GLM dev-drainer beachhead (ADR-0032) authored 9 CI-green PRs here on GLM-5.2, a
model *below* Sonnet on SWE-bench. A sub-Sonnet model clearing this repo's
`dev_orch` bar is direct evidence Sonnet clears it. `dev_target` does NOT inherit
this: the beachhead is fenced off the Target board, so money-critical authoring
was never measured. Frontier is retained where the evidence does not reach.

**`dev_target`/`retro_orch`/`design_concept_orch` demoted to Sonnet 2026-08-04 —
cost emergency, not evidence.** `fable` has been unentitled on this account since
before these classes were routed to it, which per the fallback rule below means
they were never actually running on Fable — every dispatch was silently paying
**Opus** prices as the permanent steady state, not the rare fallback the rule was
designed for. Live proof: `dev_target` alone burned 907M tokens over 7 days,
100% Opus, ~18% of the entire weekly token budget, while the account sat at 97%
of its weekly cap with the weekly emergency stop engaged. `retro_orch` and
`design_concept_orch` are low-volume and orchestrator-side (not money-critical)
— demoting them mirrors the already-evidenced `dev_orch` demotion above and
carries the same low risk. `dev_target` is the operator-accepted exception: this
is an **explicit trial**, unmeasured the same way the pre-2026-08-04 Fable
routing was unmeasured — watch QA/CI pass rate on Target PRs closely and revert
this row to Fable/Opus if quality regresses. Restoring `fable` entitlement
obsoletes this whole note; re-promote all three once it's live and re-verified
(don't just flip the table back on faith — dispatch one `Agent(model="fable", …)`
smoke test first, per the fallback rule below).

**Superseded 2026-09-02 — operator-approved re-promotion.** Fable entitlement
returned 2026-08-19; the required smoke test passed 2026-09-02
(`FABLE-OK: claude-fable-5`). The cost emergency is over: weekly usage sat at
8% with the Target mothballed (Kalshi banned in WA; the successor target CSB is
being founded via map #4313). Per this note's own re-promotion instruction,
`retro_orch` and `design_concept_orch` return to Fable immediately;
`dev_target` and `qa_target` are stamped Fable in the table but those rows are
moot until the CSB swap lifts the orch-only scope pin — CSB launches its
money-critical authoring and review at the frontier tier and demotes on
evidence, never the reverse. `dev_orch` deliberately stays Sonnet: that
demotion was evidence-based (the GLM-5.2 beachhead cleared the bar from below
Sonnet), not cost-driven, and its `ESCALATION_POLICY` row already self-rescues
failures at Fable.

| Class (`slot`) | Model | Rationale |
|---|---|---|
| `dev_orch` | Sonnet | Multi-file, tier-gated self-modification — but measured (above). An `ESCALATION_POLICY` row re-dispatches a `subagent_failure` once at frontier, so a capability miss self-rescues. `qa_orch` + CI unchanged. |
| `dev_target` | Fable (re-promoted 2026-09-02; effective at the CSB swap) | Money-critical authoring. The 2026-08-04 Sonnet trial ended unmeasured (Target mothballed before a verdict); the successor target launches at the frontier tier and demotes on evidence, not the reverse. |
| `retro_orch` | Fable (re-promoted 2026-09-02) | Reshapes future behaviour; per-run low volume. The 2026-08-04 demotion was cost-emergency-driven and prescribed its own reversal on entitlement + smoke test (both done). |
| `design_concept_orch` | Fable (re-promoted 2026-09-02) | A weak design concept wastes a full dev+QA cycle downstream; low volume — same re-promotion basis as `retro_orch`. |
| `qa_orch` | Sonnet | Highest ROI; structured review against an artifact, ~every PR |
| `qa_target` | Fable (re-promoted 2026-09-02; effective at the CSB swap) | Money-critical review — the last judgment before auto-merge on real-money code. Sonnet remains the hard floor if cost ever forces a demotion. |
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

### `dev_orch` dispatch — honour a pinned anchor (issue #3711)

`dev_orch` normally dispatches **unpinned** — `hydra-dev` picks its own issue off
the orch board (#458). But when a design concept is pending for some *other*
anchor, `decide.py` emits `prompt_args.anchor = "issue-<N>"`: the pre-resolved
grill-clear anchor from `orch_dev_ready_anchor`.

**When `prompt_args.anchor` is present you MUST name that issue in the dispatch
prompt** ("Invoke the `hydra-dev` skill on **issue #N**" — the form the parent
flow already accepts: *"If `$issue_number` provided, use it."*). The pin is the
safety half of the per-anchor gate, not a hint: `hydra-dev` otherwise
self-selects via an unguarded `gh issue list --label ready-for-agent … | .[0]`
with no design-concept check in its path, so an unpinned dispatch could land on
the very anchor being grilled this turn — the grill-before-dev violation #628
exists to prevent. No `prompt_args.anchor` → today's self-selection.

**Frontier-tier routing hint on a pinned anchor (issue #3798, #3795
follow-up).** A pinned `dev_orch` dispatch MAY also carry
`prompt_args.route_model` — a string model alias (today `fable`, read live
from `ESCALATION_POLICY["dev_orch"]["model"]`) `decide.py` attaches ONLY when
the pin's grill-clearness came from a genuine, **approved** design-concept
artifact (never the mechanical #1230 / trivial #1088 exemption, which are the
*opposite* of architecturally consequential). **When `prompt_args.route_model`
is present, pass `model=action.prompt_args.route_model` to the `Agent` call
for that one dispatch, overriding the static per-class Sonnet default** — the
same override mechanics as the cascade-routing `escalate_model` hint above,
but a **distinct key**: `route_model` is a first-attempt, dispatch-time
routing decision with no `attempt` / `prior_attempt_status` fields, so it must
never be conflated with (or substituted for) `escalate_model`'s
retry-after-failure telemetry. No `prompt_args.route_model` → resolve `model`
from the static per-class map as usual (the overwhelmingly common case: most
`dev_orch` dispatches are unpinned, and most pinned ones are grill-clear via
the mechanical/trivial exemption, not a fresh artifact). This routing is
purely additive to — and structurally independent of — the
`subagent_failure`-triggered `escalate_model` cascade: that net still fires
identically on top of whichever model this hint (or its absence) resolved for
the first attempt.

**A second, independent source of a pinned anchor: draining
`state.dev_resume_pending` (issue #3866).** `reap.py` appends a resume record
here when a PRIOR `dev_orch` completion opened no PR for its anchor (the
no-PR-stall backstop — see "Reap-side backstop" below); the `dev_orch`
selector in `decide.py` drains this queue BEFORE the grill-gate/self-select
logic above, so it can pin a dispatch even when the anchor's issue is no
longer labelled `ready-for-agent` (it was relabelled `needs-dev-resume`) and
`orch_work_available` is otherwise false. Such an action carries
`prompt_args.resume: true` and, when the stalled worktree branch is known,
`prompt_args.resume_branch = "<branch-name>"`. **When `prompt_args.resume` is
true, say so in the dispatch prompt** — e.g. *"This anchor previously stalled
without a PR (branch `<resume_branch>`, if given). Before implementing from
scratch, check whether that branch still exists (`git ls-remote origin
<resume_branch>`) and continue from it if so — do not silently redo already-
committed work."* This is a fresh subagent, not a literal resumed session (a
completed dispatch's live agent handle is not something `decide.py` can act
on), but reusing the branch avoids re-paying the tokens already spent on the
committed portion of the prior attempt.

**Reap-side backstop (issue #3866).** `scripts/autopilot/reap.py`'s
`_handle_dev_orch_stall` (called from every `dev_orch` completion reap) checks
whether an open PR references the completion's anchor, via the same
`pr-refs.py` predicate `recover-stale.sh` uses (issue #3852). No open PR found
→ the source issue is relabelled away from `ready-for-agent`/`in-progress` to
`needs-dev-resume` (a label pre-created for this issue), an explanatory
comment is posted, and a resume record is queued onto
`state.dev_resume_pending` for the drain above. This is the backstop for the
forbidden-ending rule (see the Worktree-guard preamble section) — it exists to
limit the blast radius of a dispatch that ends without a PR, not to make
ending early acceptable. The check fails OPEN (no mutation) on any `gh`
hiccup, so a transient network blip never mislabels a healthy in-flight
anchor.

**Ordering the unpinned pick — the standing work ranking (issue #3981).** Today's
unpinned self-selection is `gh issue list --label ready-for-agent … | .[0]` — it
takes whatever the API returns first, which is **not** a priority order. There is
no numeric priority dial anywhere in the loop to consult: `classes.json` carries
only `cooldownSeconds` (a cadence dial, no priority field), `collect-state.sh`
*counts* `ready_for_agent` without ordering it, and `config/orchestrator/vision.md`
is read by no loop code. So the ranking is applied **here, in the prompt**, the
same way `hydra-sweep` already carries "pick highest unblock count first, NOT
oldest".

When more than one `ready-for-agent` issue is eligible and none is pinned, break
the tie in this order (from `config/orchestrator/vision.md` § Trade-offs):

1. **Maintainability** — refactors, test coverage, dead-code removal, silent-catch
   audits, module splits.
2. **Operator surface** — the dashboard and the observability it renders
   (`dashboard/`, the read APIs that feed it, digest/alerting legibility).
3. **Throughput** — new capability.

This is a **tie-break, not a quota**: it orders work that already advances a
Decision Vector and never promotes work that advances none. It does not override a
pinned anchor, an unblock-count ordering where one applies, or an explicit
operator steer. If the top-ranked eligible issue is blocked or lacks a
`## Files in scope` section, fall through to the next — do not relabel to force it.

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

**Claim protocol (issue #3354, ADR-0029 Decision 2) — the worker MUST claim the
ticket FIRST.** Before it does any work, the dispatched worker self-assigns the
frontier ticket:

```bash
gh issue edit <N> --repo gaberoo322/hydra --add-assignee @me
```

This claim is the load-bearing mechanism for BOTH saturation guards. An open,
AFK-typed ticket that is *assigned* is an in-flight worker: `collect-state.sh`
counts assigned tickets into `wayfinder_orch_inflight_global` (the global-cap
input `decide.py` reads) and its frontier query already skips assigned tickets
(`assignees.totalCount==0`), so a claimed ticket is never re-picked. **Skipping
this claim makes both guards inert** — the in-flight counter would read 0 forever
and the same frontier ticket could be dispatched twice. The claim is therefore
step 0 of every `wayfinder_orch` dispatch, not an afterthought.

**Saturation guards (issue #3354, ADR-0029 Decision 2).** Two bounds cap
concurrency, both anchored on the claim above:
- **Global cap — ≤2 concurrent `wayfinder_orch` workers** across all maps.
  `collect-state.sh` counts open, assigned, AFK-typed tickets across every
  approved map into `wayfinder_orch_inflight_global`; `decide.py` suppresses a new
  `wayfinder_orch` dispatch when that counter is ≥2 (frontier-first, then cap —
  purely reading the pre-resolved counter, no network in `decide.py`).
- **Per-map single-flight — ≤1 in-flight worker per map.** Enforced structurally
  in `collect-state.sh`: a map that already has an in-flight (assigned) AFK ticket
  yields NO new frontier pick that tick, so a second worker never starts on the
  same map even if two of its tickets are simultaneously unblocked+unassigned.

HITL-typed tickets (`wayfinder:grilling`, `wayfinder:prototype`) are never
counted and never dispatched here — they surface only in the hydra-review HITL
bucket and resolve via `/wayfinder`.

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
(Opus 4.8) — do not leave the class unrun.** This still applies to the
`inherit-parent` classes (`wire_or_retire_target`, `design_qa_target`,
`wayfinder_orch`) when the parent session's saved default is Fable, and to
`dev_orch`'s `escalate_model` hint (still `fable`). As of 2026-08-04 no class in
the static map above routes to Fable — `dev_target`, `retro_orch`, and
`design_concept_orch` were demoted to Sonnet (see the cost-emergency note above)
specifically *because* this fallback had become the permanent steady state
rather than an exceptional path, silently costing Opus on every single
dispatch. **Before re-promoting any class back to Fable, verify entitlement
actually returned** — dispatch a throwaway `Agent(model="fable", …)` smoke test
and confirm it doesn't die in <1s with the model-access error above; don't flip
the table back on the assumption that time alone fixed it.

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

- **Phase 7** — `drain.sh <merged_prs>` (always) + `hydra-digest` dispatch for cause in `{budget, quota, wall_clock, idle, failure_backstop}` (`quota` is issue #3867's spend cap — a genuine run boundary, same as `budget`). SKIPPED when cause is `context_compaction` (issue #3787, periodic restart not a run boundary) — dispatching a costed digest every ~8-turn restart would multiply that cost and fragment the summary.

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

Why: a stale `~/.claude/skills/` mirror of this playbook against a newer
state.json shape makes the model silently wedge mid-reconcile. The handshake
converts that into a loud abort at second 0.

A v1 state.json (legacy, no `schema_version` field) is interpreted as
v1 via the `// 1` jq fallback above — mismatched against any modern
playbook, the handshake aborts and the operator re-runs after
`bootstrap.sh` writes a fresh v2 state on next invocation. There is
no in-place upgrader: bootstrap is the single writer for state.json.

## Termination

`decide.py` emits a `terminate` action when the token budget, wall-clock limit, idle-drain turns, or failure backstop trips, when the **quota-percent budget** trips (`quota`, issue #3867 — see below), when the turn count reaches the periodic session-restart cadence (`context_compaction`, issue #3787 — default every 8 Autopilot Turns via `state.limits.context_compaction_turns`, cuts the parent session's own prompt-cache re-read cost), or when the turn is wait-only with zero occupied slots (handoff baton-pass). Full termination conditions and the handoff baton-pass contract (issue #1903) are in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

### Quota-percent budget (issue #3867)

`token_budget` is denominated in the **wrong currency**. It counts cumulative subagent-reported input/output tokens; what the operator pays is cache-weighted **account utilization**. Measured on run 2bcba309 (2026-08-05): the run "spent" 801k of a 4,000,000 token budget and would have kept dispatching, while the OAuth meter moved the 5h utilization window 2% → 30% over the same period (~150M raw tokens — one QA dispatch's 4-subagent fan-out moved ~15M, one dev dispatch ~40M). So a "conservative" token budget does not bound real spend.

The quota-percent budget is a second per-run cap denominated in **utilization points accrued over this run's own run-start baseline**:

| Knob | Env var | Meaning |
|---|---|---|
| `--quota-5h-max=<pts>` | `HYDRA_AUTOPILOT_QUOTA_5H_MAX` | terminate once `usage.percentLast5h` has risen this many points over the run-start baseline |
| `--quota-week-max=<pts>` | `HYDRA_AUTOPILOT_QUOTA_WEEK_MAX` | same, against `usage.percentSinceReset` |

- **Opt-in, default disabled.** Both stamp `state.limits.quota_5h_max_pts` / `quota_week_max_pts`, defaulting to `0` = the cap never fires. An unset flag leaves every existing termination path byte-identical, so the standing systemd invocation is unchanged by this feature. The token budget stays as a **secondary** bound.
- **Zero new I/O.** `collect-state.sh` already fetches `/usage/eligibility` every turn; the cap reads the nested `usage` object out of `state.usage_eligibility`.
- **Baseline capture.** `decide.py` writes `state.quota_baseline` **once**, lazily, on the first turn that sees a *calibrated* payload (persisted through the same tmp-file + `os.replace` write-back as the force-research and turn counters). `term-check.py` only *reads* that baseline — it stays side-effect-free, so Phase 3 simply prints `OK` on the very first turn and the authoritative check lands moments later in Phase 4.
- **Window resets are not spend.** If a current percentage drops below the baseline the 5h window (or the weekly reset anchor) rolled over: the delta clamps to zero **and** the baseline rebases down, so post-reset spend is measured fresh. A reset never reads as negative spend and never itself terminates.
- **Subordinate to the Pace Gate.** Per ADR-0021 D5 this is a per-run *hygiene* cap, not a second governor: it reads raw `percentLast5h` / `percentSinceReset` only, never `paceState` / `targetPercent`, and touches no Pace Gate admission logic.

### Workless-board backoff on a productive idle exit (issue #3867 slice 2)

The #2956 workless-board hint used to be stamped only on a **zero-dispatch** `cause=idle` exit. A productive run that drained the board and then idle-exited stamped nothing — so the Pace Gate's next ~15-min tick launched a fresh session into the just-drained board, which zero-dispatch idle-exited once before the 45-min backoff engaged: **one wasted session bootstrap per drain cycle, structurally.** `endRun` now stamps on **every** `cause=idle` termination:

| Idle exit | Window |
|---|---|
| dispatched nothing | full `HYDRA_WORKLESS_BACKOFF_SEC` (default 45 min) — unchanged |
| dispatched work (`dispatches > 0`) | shorter `HYDRA_WORKLESS_BACKOFF_POSTWORK_SEC` (default 20 min) — new QA-able output can arrive sooner after a drain |

Non-idle causes still stamp nothing. Pace Gate semantics are unchanged: it already honours whatever instant `reasons.worklessUntil` carries, and the hint remains **launcher-only** — never `allow=false`, never draining an in-flight or operator-launched session (the #2956 / ADR-0021 boundary).

## Worktree-guard preamble (REQUIRED for code-writing dispatches)

There are TWO variants of this preamble, and the dispatch class decides which
one it carries (issue #4178). For every class launched with
`isolation="worktree"` — `dev_orch`, `qa_orch`, and the rest — the **default
variant** below applies unchanged. For `dev_target` ONLY, the **dev_target
variant** further down **replaces the default block entirely — never compose
both**: the default's `cwd == /home/gabe/hydra → ABORT` line and #3889's
"launched without `isolation="worktree"`" (so cwd IS `/home/gabe/hydra`) are
mutually exclusive gates, and a compliant `dev_target` subagent handed both
aborted at its first tool call 100% of the time (run 84b070ff; third confirmed
recurrence 6320c46f, 2026-08-31; ~46k tokens per occurrence, zero deliverable).
The invariant that actually binds `dev_target` is *never Edit/Write into either
main checkout*, not *your cwd must be a worktree* — the variant asserts the
former.

Default variant — every harness-worktree-isolated code-writing class:

```
## CRITICAL SAFETY RULE — READ FIRST
Run `pwd` and `git rev-parse --git-dir` first.
- Worktree path AND `.git/worktrees/...` gitdir → proceed.
- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT.
No fallback. No `git checkout` in the main tree.
```

dev_target variant — REPLACES the block above for `dev_target` dispatches only
(issue #4178; this class is exempt from harness worktree isolation per #3889):

```
## CRITICAL SAFETY RULE — READ FIRST (dev_target variant, issue #4178)
This dispatch is NOT harness-worktree-isolated (#3889).
- EXPECTED at launch: pwd == /home/gabe/hydra, `git rev-parse --git-dir`
  returns `.git` (not a `.git/worktrees/...` path). This is NOT an abort
  condition. Do NOT abort on it, and do NOT cd into either main checkout.
- FORBIDDEN from launch onward: any Edit/Write/Bash file mutation under
  /home/gabe/hydra or /home/gabe/hydra-betting outside the worktree Step 0.6
  creates. Both main checkouts are read-only to you.
- ABORT only if Step 0.6 fails to create the hydra-betting worktree, or its
  rev-parse verification fails. No fallback to either main checkout.
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

**`dev_orch` dispatches carry a SECOND required preamble block — the
forbidden-ending rule (issue #3866), unchanged.** Append verbatim, immediately
after the worktree-guard preamble above, for every `dev_orch` dispatch. As of
issue #4272, `qa_orch` and `dev_target` no longer share this block — each
carries its OWN forbidden-ending preamble variant instead (the `qa_orch`
blocking-fan-out variant, appended after the `dev_target` block further down;
the `dev_target` delegated-mode variant, immediately below this one). Every
code-writing dispatch class carries EXACTLY ONE forbidden-ending block, chosen
by class — never this block composed with either variant:

```
## NEVER END WAITING — deliverable or terminal state, always (issue #3866)
This is an UNATTENDED dispatch. Nothing resumes you after your final message —
reap.py records your session's end as a completion the instant it happens,
whatever you did or didn't finish. NEVER end your turn waiting on CI, a
monitor, or a background process ("I'll wait for the test run to finish",
"standing by for the re-check"). Either poll to a terminal state in the
FOREGROUND, or your final message reports one of: a PR is open (dev_orch) / a
verdict was posted (qa_orch), OR a hard blocker via ## Friction Report. There
is no third option.

You MUST do this work yourself, in THIS session. Do NOT delegate the skill
invocation to a nested background agent (`Agent(run_in_background=true)`) and
end your turn waiting on it — a background child does not keep you alive, and
reap.py will record your session as a completion with no PR the moment you go
quiet. Do NOT use the Agent tool at all. Search with Grep/Glob/Read yourself,
inline, in THIS session. There is no sub-agent that keeps you alive.

A backgrounded Bash process and an armed Monitor are the same class of handle
as a background Agent: neither keeps this session alive. Ending your turn with
a test run (or any command) still running in the background, or with a
Monitor armed to notify you later, is exactly the forbidden ending above —
reap.py records completion the instant you go quiet, whatever is still
running or armed.

Commit and push your work to the branch BEFORE running verification (`npm
test`, `npm run typecheck`), not after. Verification gates whether the PR
merges, not whether the work survives — the hourly worktree-orphan-prune
destroys anything still uncommitted when a session stalls.
```

The delegation clause above closes a route the original wording missed (issue
#4052, autopilot run f7b47a0c): a `dev_orch` dispatch on #4041 spawned a
nested `Agent(run_in_background=true)` to run the whole skill invocation,
then ended its turn to "wait for its completion notification" — satisfying
the letter of "poll to a terminal state in the FOREGROUND" while violating
its spirit, because a background child does not keep the parent session
alive. Cost: 75k tokens and ~5.8 min for zero deliverable, plus a race
between the still-live child and the no-PR-stall backstop it triggered.

Motivating incidents (autopilot run 2bcba309, 2026-08-05): a `dev_orch`
dispatch on #3726 did ~9.5 min of real implementation, backgrounded `npm
test`, then ended its session waiting on the test run — no PR existed at reap
time, and the ~165k tokens already spent were silently re-paid by a
from-scratch redispatch on the next turn (see the `dev_orch` no-PR-stall
backstop below, which now catches this case at reap time — but the backstop
exists to limit the blast radius of this failure mode, not to make it
acceptable).

**`dev_target` dispatches carry their OWN forbidden-ending preamble variant
(issue #4196) — ADDITIVE to the dev_target worktree-guard variant above, never
a replacement for it.** Append verbatim, immediately after the dev_target
worktree-guard variant, for every `dev_target` dispatch. Unlike the
`dev_orch` block above, this variant does NOT ban the Agent tool
outright: `hydra-target-build`'s own contract requires spawning a delegated
build child for context-window protection (issue #1782), and a flat ban here
would recreate the exact degradation once observed when the flat block was
still applied to `qa_orch` (before issue #4272 gave it its own hazard-scoped
variant below) — it skipped its Standards+Spec Agent fan-out and reviewed both
axes inline as one reviewer (run 8e50460f). What this variant forbids is going
quiet while that delegated child is still running — the gap this issue was
filed to close (autopilot run 155f6d3c: a `dev_target` dispatch spawned a
nested `Agent(run_in_background=true)`, said "I'll relay its summary once it
completes", and ended its turn 101s in with zero deliverable), and the
recurrences that followed even after an earlier draft of this preamble was
present (runs `ad07927f`, `b123538c`: an armed Monitor re-fired, the dispatch
re-armed it and quit again, and a follow-on self-report claimed a push and a
merge that had not actually happened):

```
## NEVER END WAITING — dev_target delegated-mode variant (issue #4196)
This is an UNATTENDED dispatch. Nothing resumes you after your final message —
reap.py records your session's end as a completion the instant it happens,
whatever the delegated child did or didn't finish. `hydra-target-build`'s
delegated mode PERMITS spawning `Agent(run_in_background=true)` for the build
child itself (Step 2) — that is NOT the forbidden ending. The forbidden ending
is spawning the child and then going quiet, or narrating a future action
("I'll relay its summary once it completes", "the armed Monitor will notify
me", "I'll stop polling and wait for the notification") instead of watching it
happen now, in THIS turn.

A Monitor cannot resume a reaped session, and neither can a plain "I'll wait"
message: arming one and ending your turn is functionally identical to ending
on the background child itself — nothing wakes this session back up, so the
wait never ends and reap.py records a completion with zero deliverable. After
spawning the delegated build child, poll it to a terminal state in the
FOREGROUND — repeated status checks with a bounded interval between them, in
THIS session, never a backgrounded Bash process and never an armed Monitor —
then report exactly one of: a PR is open, or a hard blocker via
## Friction Report. "The child is still running" is never itself the final
message, and if a notification wakes you while the child is STILL not done,
re-arming the wait and ending your turn again is the same forbidden ending
repeated, not progress — keep polling in the foreground instead.

Commit and push your work to the branch BEFORE running verification (`npm
test`, `npm run typecheck`), not after — same rule as `dev_orch`/`qa_orch`.
Verification gates whether the PR merges, not whether the work survives.

Your final report is not verification. State only what you directly observed
in THIS session — a `gh pr view` showing `MERGED`, a CI run you polled to
green — never assert a push, a green run, or a merge you did not just watch
happen. A prior dev_target dispatch reported "committed, and pushed... CI went
green... merged" for a commit that in fact sat unpushed in the local worktree
the whole time; a separate dispatch found and recovered it.
```

**`dev_target` dispatches are NOT harness-worktree-isolated (issue #3889, superseding the #542 framing).** Unlike every other dispatch class, `dev_target` is launched **without** `isolation="worktree"` (see the `dispatch` action-to-tool entry above). The harness's worktree isolation only covers the orchestrator repo (`~/hydra`); because `~/hydra-betting` is a sibling repo not nested under `~/hydra`, the harness refuses ALL git ops against it from a pinned session — which made `hydra-target-build` Step 0.6 (`git -C ~/hydra-betting worktree add …`) categorically fail (2/2 dispatches, issue #3889). `dev_target` therefore relies **solely** on Step 0.6's worktree (nested under `~/hydra-betting/web/.worktrees/` since issue #4177) for isolation, and on the installed `worktree-write-fence.sh` PreToolUse hook for ghost-write protection (the role `isolation="worktree"` plays for the orchestrator-only classes). Every `dev_target` dispatch MUST still go through Step 0.6 before any Edit/Write against the target. This launch shape is also why the dev_target variant of the worktree-guard preamble above exists (issue #4178): the default block's `cwd == /home/gabe/hydra → ABORT` clause describes exactly the EXPECTED `dev_target` launch state, so carrying the default preamble (or worse, both) is a guaranteed false-abort for this class — carry the variant instead.

```
## TARGET-REPO SAFETY RULE — applies to dev_target only
Before writing to ~/hydra-betting:
- Create a hydra-betting worktree (see hydra-target-build Step 0.6).
- Verify `git -C <worktree> rev-parse --git-common-dir` resolves to ~/hydra-betting/.git
  AND `git -C <worktree> rev-parse --git-dir` contains `.git/worktrees/`.
- Use ONLY worktree-anchored paths for Edit/Write — never raw `/home/gabe/hydra-betting/...`.
- ABORT if any check fails. The two-repo asymmetry was the silent-leak failure mode in #542.
```

**`qa_orch` dispatches carry their OWN forbidden-ending preamble variant
(issue #4272) — the hazard-scoped rewrite, not the `dev_orch` flat ban above.**
`hydra-qa`'s step 7 review fan-out is an `Agent(*)`-based design by
construction (Standards + Spec sub-agents run as **parallel sub-agents** so
neither pollutes the other's context, `hydra-qa/SKILL.md` lines 48/103), and
every spawn in it already carries the #3789/#3880 blocking mandate
(`run_in_background: false`) plus the step 7.5 incomplete-fan-out exit — a
blocking spawn cannot outlive the turn, so it sits in the same safety class as
a foreground `Bash` call and is mechanically incapable of the #3866 hazard.
`dev_orch` has no equivalent internal blocking mandate, so for that class the
tool ban and the hazard ban still coincide and the flat wording stays
(operator decision, 2026-08-31). Before this variant existed, a `qa_orch`
dispatch reviewing PR #4270 / issue #4257 (autopilot run `8e50460f`, turn 7)
complied with the flat ban's letter by skipping `hydra-qa` step 7's parallel
Standards+Spec fan-out and reviewing both axes itself inline — a competent
single review, but not the two independent, context-isolated reviewers the
design calls for, and nothing errored to surface the degradation.

Append verbatim, immediately after the worktree-guard preamble above, for
every `qa_orch` dispatch — REPLACING the `dev_orch` block above, never
composed with it and never with the `dev_target` variant either:

```
## NEVER END WAITING — qa_orch blocking-fan-out variant (issue #4272)
This is an UNATTENDED dispatch. Nothing resumes you after your final message —
reap.py records your session's end as a completion the instant it happens,
whatever you did or didn't finish. NEVER end your turn waiting on CI, a
monitor, or a background process. Either poll to a terminal state in the
FOREGROUND, or your final message reports one of: a verdict was posted, OR
hydra-qa's own pre-verdict exit was executed (step 7.5 incomplete fan-out /
step 6.6 defer, with `needs-qa` left in place), OR a hard blocker via
## Friction Report. There is no fourth option.

Do NOT spawn a background agent (`Agent(run_in_background: true)`) for ANY
purpose — not to run the skill, not to search, not to "explore first" — and
NEVER end your turn with any child still running. A background child does not
keep you alive, and it cannot outlive your worktree: run 793fa896 spawned 9
background children and quit; the hourly orphan-prune reaped the parent
worktree and every child died with it — ~790k tokens, zero verdicts.

You MAY spawn reviewer sub-agents ONLY where hydra-qa step 7 directs, ONLY
with `run_in_background: false`, and ONLY all in one message. That spawn is
BLOCKING — the message cannot return, and your turn cannot end, until every
reviewer has returned — so it is mechanically incapable of the forbidden
ending, the same safety class as a foreground Bash call. That is the ONLY
permitted Agent use. Everything else you do yourself, inline, in THIS session,
with Grep/Glob/Read. Then run step 7.5: if any reviewer came back empty, post
the incomplete-fan-out comment and exit — never aggregate a partial set.

A backgrounded Bash process and an armed Monitor are the same class of handle
as a background Agent: neither keeps this session alive. Ending your turn with
any command still running in the background, or with a Monitor armed to
notify you later, is exactly the forbidden ending above.

Post the verdict and execute its step-10 routing BEFORE any optional follow-on
work (step 11 lesson capture) — the posted verdict is the deliverable that
survives a reap; nothing after it does.
```

Filed `hitl-grill` as issue #4272 (self-filed-defect admission rule);
operator decision 2026-08-31 accepted the narrowing, gated on issue #4196
landing first because both rewrite this same preamble section — see the
issue's comment thread for the full reasoning. The run 793fa896 catastrophe
this variant's background-spawn ban cites (9 background reviewer children,
parent worktree reaped by the hourly orphan-prune, ~790k tokens, zero
verdicts) is the reason the ban is unconditional — "for ANY purpose" — while
the `run_in_background: false` fan-out stays permitted: only a *background*
spawn can outlive the parent's worktree.

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
`--subagent-soft=`, `--subagent-hard=`, `--unattended=`, `--quota-5h-max=`,
`--quota-week-max=`) parse via `args-parse.sh` and override env vars. The two
`--quota-*` flags are the opt-in quota-percent budget (issue #3867 — see
**Termination**); unset means disabled.

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

### Stopping the autopilot: the two levers (issue #3868)

Two stop levers exist and they are **not** interchangeable:

| Lever | What stops | What keeps running |
|---|---|---|
| `POST /api/autopilot/paused` (`paused=true`) | **Everything.** The Pace Gate skips Claude AFK launches, AND `scripts/glm/drainer-loop.sh` honours the same durable flag (ADR-0032 Decision 6) — the GLM free lane freezes too. | Nothing. |
| `systemctl --user stop hydra-pace-gate.timer` | Claude AFK relaunches only — no new Autopilot Runs are admitted (a live run finishes its budget). `paused` stays `false`. | The GLM drainer keeps draining `glm-eligible` work on z.ai. |

**`paused=true` is the TOTAL stop; stopping `hydra-pace-gate.timer` is the
Claude-only stop.** Use the timer stop for a cost emergency where Anthropic
quota must stop burning but the free lane should keep shipping: during the
2026-08 cost-emergency shutdown the operator pause froze the drainer for days
while ~30 `glm-eligible` issues queued — the exact outage class this
distinction exists to prevent. Re-arm afterwards with
`systemctl --user start hydra-pace-gate.timer`.

Related watchdog coverage: the launch-flow block's `glm-sterile` signal
(`scripts/hydra-watchdog.sh`) alarms in-band when the drainer heartbeat is
fresh, `glm-eligible` + `ready-for-agent` work is queued, and zero drainer PRs
(the shared #4048 OR-predicate) were created in the trailing window (default
6h, `HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS`) — the live-but-sterile
failure (#3863) that liveness checks alone cannot see.

## Slot lifecycle events (issue #509)

Subagent slot accounting is event-driven: `SubagentStop` and `Notification` hooks XADD events onto `hydra:autopilot:slot-events`; `collect-state.sh` drains it each turn; `decide.py` translates `subagent_stop` events into completions and appends failures to `state.failure_log`. A silent-wedge wall-clock fallback (`subagent_max_wall_seconds=3600`) covers hook failures. Full event schema, turn-consumption detail, env overrides, and best-effort guarantees are in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

## Signal wiring (state.signals)

`collect-state.sh` emits raw counts; the model turns them into the
boolean signals decide.py reads from `state.signals`. The key mappings:

| collect-state output | state.signals key | Drives |
|---|---|---|
| `ready_for_agent > 0` (orch GH board) | `orch_work_available` | `dev_orch` (issue #458) |
| `work_queue > 0` (target Redis queue) | `target_work_available` | `dev_target` (legacy Redis substrate; runs in parallel with the GitHub board during the ADR-0031 expand phase) |
| `target_ready_for_agent > 0` (**target GH board**, scope=target board-state — open-blocker-excluded via the inherited #3059 filter) | `target_board_work_available` | `dev_target` (issue #3435, ADR-0031 — orch-style GitHub-board Target dispatch: ready-for-agent present → build. Fires alongside `target_work_available`; either triggers dev_target during cutover) |
| `target_ready_for_agent == 0` (**target GH board** empty of ready-for-agent work) | `target_board_research_due` | `research_target` (issue #3435, ADR-0031 — orch-style GitHub-board Target dispatch: board empty → research. Not subject to the daily force cap — a plain board-empty signal, cadence-paced) |
| `target_needs_qa > 0` (**target GH board**, scope=target) | `needs_qa_target` | `qa_target` (issue #3435, ADR-0031 — Target QA now GitHub-board-derived, same source that drives `dev_target`/`research_target`) |
| `needs_qa > 0` (orch GH board) | `needs_qa_orch` | `qa_orch` — the coarse PRESENCE gate; a necessary but not sufficient condition post-#3829 (see the row below) |
| `needs_qa_numbers` (orch GH board — space-separated `needs-qa` issue NUMBERS in the SAME unsorted-default order hydra-qa's own self-selection query returns, e.g. `3841 3850`; empty when the lane is empty or the read degraded) | `needs_qa_numbers` (string, merged verbatim — the same seam as `target_needs_triage_items` / `wayfinder_orch_frontier`) | the per-issue STALL CAP guard on `qa_orch` (issue #3829, design-concept issue-3829). Unlike #3729's per-item guard, this tracks ONLY the HEAD (`needs_qa_numbers[0]`) — the issue hydra-qa's own `gh issue list --label needs-qa --jq '.[0]'` will actually review next — never a non-head issue merely present in the lane. `qa_orch` fires iff the head has attempted fewer than `QA_STALL_MAX_ATTEMPTS` (3) qa_orch dispatches; on fire the tracker is rebuilt to hold only the head's bumped count, so a former head that is superseded or resolved is pruned and restarts at 0 on a later re-open. A head that repeatably cannot reach a QA verdict (e.g. the worktree-orphan-prune race that motivated #3829) stops being dispatched once exhausted — the plan's `dispatch_decision` reason + `debug.qa_orch_stalled_issue` name it instead of a silent re-fire. Absent/empty → fail-open on the coarse `needs_qa_orch` boolean alone (never dead-arm the class the #3709/#3729 way). |
| `needs_research > 0` (orch GH board) | `needs_research` | `research_orch` |
| `needs_triage > 0` (orch GH board) | `needs_triage_orch` | `sweep_orch`. This coarse boolean stays TRUE even when every item is inside its per-item backoff window (issue #3939 INV-3) — it is the presence gate, not the eligibility gate. |
| `orch_needs_triage_items` (orch GH board — space-separated `needs-triage` item NUMBERS, e.g. `3921 3844`; empty when the lane is empty or the read degraded) | `orch_needs_triage_items` (string, merged verbatim — the same seam as `wayfinder_orch_frontier`) | the per-item verdict-stability guard on `sweep_orch` (issue #3939 — the orchestrator mirror of the `sweep_target` #3729 guard; the four guard functions are SHARED, lane-parameterized, not forked). `sweep_orch`'s `needs_triage_orch` branch fires iff the 900s class cooldown has elapsed AND ≥1 item in this set has no stamp OR a stamp older than `ORCH_TRIAGE_BACKOFF_SEC` (default 6h, env `HYDRA_ORCH_TRIAGE_BACKOFF_SEC` — a SEPARATE env from the target lane's `HYDRA_TARGET_TRIAGE_BACKOFF_SEC`); on fire every item in the CURRENT set is stamped and departed items are pruned. If every current item is inside its backoff window the `needs_triage_orch` branch is suppressed but control FALLS THROUGH to the `untriaged_orphans_orch` trigger (INV-6) — a parked standing-trigger never drops a live orphan-routing opportunity. Absent/empty → fail-open on the coarse `needs_triage_orch` boolean alone (never re-dead-arm the sweep). |
| `target_needs_triage > 0` (**target GH board**, scope=target — raw `needs-triage` label count; the #3059 blocker filter applies to `ready_for_agent` only) | `needs_triage_target` | `sweep_target` (issue #3709 — Target mirror of `needs_triage_orch`; no saturation cap, it drains the lane it gates on). This coarse boolean stays TRUE even when every item is inside its per-item backoff window (issue #3729 INV-3) — it is the presence gate, not the eligibility gate. |
| `target_needs_triage_items` (**target GH board** — space-separated `needs-triage` item NUMBERS, e.g. `626 631`; empty when the lane is empty or the read degraded) | `target_needs_triage_items` (string, merged verbatim — the same seam as `wayfinder_orch_frontier`) | the per-item verdict-stability guard on `sweep_target` (issue #3729). `sweep_target` fires iff ≥1 item in this set has no stamp OR a stamp older than `TARGET_TRIAGE_BACKOFF_SEC` (default 6h); on fire every item in the CURRENT set is stamped and departed items are pruned. Absent/empty → fail-open on the coarse `needs_triage_target` boolean alone (never re-dead-arm the sweep). |
| `target_board_signals_truncated` (**target GH board** read returned exactly `--limit` rows — succeeded but incomplete) | (advisory only) | nothing — never gates dispatch (issue #3710). Opposite of `_degraded`: that one suppresses, this one keeps dispatching on a floor-valued count |
| `untriaged_orphans > 0` (orch GH board — open issues carrying NONE of {ready-for-agent, in-progress, blocked, needs-qa, needs-triage, needs-research, target-backlog, ready-for-human, needs-info} AND no `wayfinder:`-prefixed label) | `untriaged_orphans_orch` | `sweep_orch` (issue #2426) — triage backstop: routes mislabeled/orphaned issues invisible to BOTH the dev_orch and needs_triage_orch paths into an actionable lane. `ready-for-human` (#2828) / `needs-info` (#2958) are operator-wait, not mislabeled. `wayfinder:*` is excluded by PREFIX test (#3728) — label-less by design, dispatched via `wayfinder_orch_frontier`; a truly label-less issue still counts |
| `health=FAIL` or `failed_services>0` | `health_fail` | `health` |
| `scout_last_walk_iso` >7d old or empty | `scout_walk_due` | `scout_orch` (issue #485) |
| `scout_board_open_enhancements > 20` | `scout_board_saturated` | suppresses `scout_orch` |
| `scout_spend_usd_today` | (read directly from state) | suppresses `scout_orch` via cost-cap (issue #532) |
| `dev_target_spend_usd_cycle` | (read directly from state) | halts `dev_target` via per-cycle cost-cap backstop (issue #1059) |
| `arch_fallback_due` (`ready_for_agent==0 && needs_research==0 && needs_triage==0 && work_queue==0`) | `arch_fallback_due` | `architecture_orch` (issues #789/#790) |
| `arch_board_open_scan > ARCH_BOARD_SATURATION_CAP (6)` → `arch_board_saturated` | `arch_board_saturated` | suppresses `architecture_orch` (checked FIRST) |
| `orch_backfill_idle` (same signal as above) | `orch_backfill_idle` | also drives `cleanup_orch` (issue #960) — NOT staggered, so it may co-fire with the backfill set |
| `orch_board_signals_degraded=true` (ANY orch-lane board read in the pass failed — the counts fallback, the grill list, or the ARCH backfill read; emitted unconditionally every pass as `true`/`false`) | `orch_board_signals_degraded` (boolean) | suppresses BOTH `terminate:idle` producers and every `orch_backfill_idle`-driven backfill dispatch (issue #4130). A GraphQL-only outage used to degrade every board signal to a legitimate-looking 0/none, so decide.py drained runs to a clean idle terminate with a full board and could inverse-fire backfill against it; the flag makes the blindness observable, and a wait-only degraded turn takes the wall-clock heartbeat wait instead of terminating. decide.py reads it pre-resolved (`_orch_board_read_degraded`) and stays pure. The orch mirror of `target_board_signals_degraded` — with opposite teeth: the target flag is advisory-observable, this one gates. |
| `cleanup_board_open_scan > CLEANUP_BOARD_SATURATION_CAP (10)` → `cleanup_board_saturated` | `cleanup_board_saturated` | suppresses `cleanup_orch` (checked FIRST, mirrors `arch_board_saturated`) (issue #960) |
| `target_backfill_idle` (target triage + queued lanes empty AND `work_queue==0`) | `target_backfill_idle` | drives `cleanup_target` (Target mirror of cleanup_orch; API-down degrades to `false`) |
| `target_cleanup_board_open_scan > 10` → `target_cleanup_board_saturated` | `target_cleanup_board_saturated` | suppresses `cleanup_target` (checked FIRST; API-down degrades to `true` — fail closed) |
| `wire_or_retire_target_triage > 0` (≥1 open `wire-or-retire`-labelled item in the Target `triage` lane) → `wire_or_retire_target_available` | `wire_or_retire_target_available` | drives `wire_or_retire_target` (issue #2722, epic #2720) — the judgment resolver; 24h class cooldown, ≤2 items/run; API-down degrades to `false` (fail closed) |
| `/api/autopilot/runs` index has ≥1 non-`running` run | `retro_run_available` | `retro_orch` (issue #920) — daily per-run retrospective; 24h class cooldown enforces the once-per-day cadence |
| `usage_eligibility_json` | `state.usage_eligibility` (object, merged verbatim) | hard-stop all dispatches when `allow=false`; skip listed classes when `shed` non-empty (PR B1). `shed` is the UNION of the weekly-projection pacing shed (`pacingState==="over"`) and the graduated 5h-utilization throttle (issue #1087, keyed off `percentLast5h` against `HYDRA_USAGE_5H_THROTTLE_T1/T2`); `reasons.fiveHourThrottleShed` flags the latter |
| `emergency_brake_json` | `state.emergency_brake` (object, merged verbatim) | operator-only emergency brake (issue #744): when `engaged=true`, `decide()` emits ZERO `auto-merge` actions and a single `route-prs-to-review` action that arms the /hydra-review pickup set. Default `{engaged:false}`. READ-ONLY — the autopilot can never set/clear it (no engage/disengage action type); the sole write path is `hydra brake on\|off`. |
| `orch_pending_grill_anchor=issue-N` (or `none`) | `state.signals.orch_pending_grill_anchor` (string, or omit — verbatim, no rename) | `design_concept_orch` fires hydra-grill on the named anchor (issue #628). Key name aligned in #736 so collect-state emits exactly what decide.py reads — no model-mediated rename. **The `dev_orch` yield it triggers is PER-ANCHOR, not global, post-#3711** — see the row below. |
| `orch_dev_ready_anchor=issue-N` (or `none`) | `state.signals.orch_dev_ready_anchor` (string, or omit — verbatim, no rename) | `dev_orch` (issue #3711) — the first orch-board `ready-for-agent` anchor already **grill-clear**: fresh design-concept artifact, or the mechanical (#1230) / trivial (#1088) exemption. Resolved by the SAME `collect-state.sh` loop pass as `orch_pending_grill_anchor` because `decide.py` must stay pure and cannot look up artifact freshness — same division of labour as `wayfinder_orch_frontier`. When a grill is pending AND this names a **different** anchor, `dev_orch` dispatches **pinned to it** (`prompt_args.anchor`) instead of yielding board-wide; when it is `none` or equals the pending-grill anchor, `dev_orch` yields as it did pre-#3711. gh/API-down degrades to `none` (fail closed). |
| `wayfinder_orch_frontier=issue-N` (or `none`) | `state.signals.wayfinder_orch_frontier` (string, or omit — verbatim, no rename) | `wayfinder_orch` (issue #3351, epic #3350, ADR-0029) — the pre-resolved next AFK-typed, unblocked, unclaimed frontier ticket across all open **approved** (`wayfinder:map` minus `wayfinder:destination-pending`) maps. collect-state.sh owns the native GraphQL sub-issue/blocked-by enumeration so decide.py stays pure; gh/GraphQL-down degrades to `none` (fail closed). |
| `wayfinder_orch_ticket_type=research\|task` | `state.signals.wayfinder_orch_ticket_type` (string) | the frontier ticket's type, threaded into the dispatch `prompt_args.ticket_type` so the dispatch step below resolves ticket-type → skill (`research` → hydra-issue-research, `task` → hydra-dev). |
| `wayfinder_orch_inflight_global=N` | `state.signals.wayfinder_orch_inflight_global` (string integer) | the count of live `wayfinder_orch` workers — open, self-assigned, AFK-typed (`wayfinder:research`\|`wayfinder:task`) sub-issues across all open **approved** maps (issue #3354, ADR-0029 Decision 2). `decide.py` reads it verbatim and suppresses a new dispatch at ≥2 (global cap of ≤2 concurrent workers). collect-state.sh owns the count so decide.py stays pure; absent/malformed → treated as 0 (fail-open on absence — the structural per-map single-flight guard still holds). |
| `tickets_available` (≥1 open, **unassigned** `needs-tickets` issue on the orch GH board) | `state.signals.tickets_available` (boolean) | `tickets_orch` (issue #4014, ADR-0030 Decision 2/5) — the **tickets**-STAGE producer, woken by this signal. collect-state.sh owns the GH enumeration (the existing `needs-tickets` label, #3817, is the board condition — no new label) and emits `true`/`false` directly; the model merges it as a boolean (same shape as `orch_backfill_idle`). gh-down degrades to `false` (fail closed — never dispatch a decomposition with no resolved target). |
| `tickets_orch_pending_spec=issue-N` (or `none`) | `state.signals.tickets_orch_pending_spec` (string, or omit — verbatim, no rename) | the OLDEST open unassigned `needs-tickets` spec ref, threaded into the dispatch `prompt_args.spec_issue` so hydra-tickets decomposes exactly that spec — the same pre-resolution seam as `wayfinder_orch_frontier`. Assigned specs are excluded (mirroring wayfinder's assignee-based in-flight dedup — a live hydra-tickets worker self-assigns the spec), bounding duplicate-epic risk beyond the 1h class cooldown. gh-down degrades to `none` (fail closed). |

Pre-#458 `dev_orch` consumed `/api/anchor/candidates` and routinely
received target-product anchors (item-26x). Post-#458, candidates are
treated as target-side work: `dev_target` surfaces the top candidate as
a hint, and a low best-score forces `research_target` (not `research_orch`).

**Discover signals (#959, epic #958; un-starved by #4114).** `discover_orch`
reads the unified **`orch_backfill_idle`** board-empty signal — the SAME signal
`architecture_orch` reads. Both classes are members of
`BACKFILL_SIGNAL_CLASSES` (`decide.py:373`) and share the 1h backfill cadence.
Because the board-empty conjunction (`ready_for_agent==0 && needs_research==0 &&
needs_triage==0 && work_queue==0` — `collect-state.sh`'s `fallback_due`) stays
permanently false on a healthy, continuously-stocked orch board, idle-only
gating starves the class. So the selector (`decide.py:3708`) has a SECOND
trigger path: it fires on `orch_backfill_idle` OR the **7-day staleness floor**
(`DISCOVER_STALENESS_FLOOR_SEC`, `decide.py:420`, via `signal_dark_past_floor`)
— a never-fired class (last == 0) counts as dark, and a floor dispatch carries
the "discover staleness floor (>7d dark since last fire)" reason so it is
distinguishable from an idle dispatch in the `dispatch_decision` audit trail.
**Deferred follow-up:** `architecture_orch` and `cleanup_orch` share the
dark-producer symptom (both last fired 2026-07-25 at #4114 diagnosis) and
deliberately keep idle-only gating in this change — extending the floor to them
is a separate decision (the helper is class-parameterized for it).
`discover_target` still gates on `target_idle` (its own selector at
`decide.py:3720`); whether that signal is produced is a separate Target-side
question.

**Backfill dedup baseline (issue #2554).** Because `discover_orch` and
`architecture_orch` both fire on `orch_backfill_idle`, the **one-per-turn
stagger guard** (it lets only one `BACKFILL_SIGNAL_CLASSES` member dispatch per
turn) prevents them co-firing the same TURN — but their independent per-class 1h
cooldowns plus the `BACKFILL_STARVATION_FLOOR` (`decide.py:392+`, which forces a
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

## Self-filed work — the admission rule (operator directive 2026-08-19)

**When you discover a defect in Hydra's own machinery, you file it as `hitl-grill`, never as `ready-for-agent`.**

You may file freely — noticing defects is valuable and nothing here discourages it.
What you may NOT do is promote your own finding into the dispatch queue. Only the
operator moves an issue from `hitl-grill` to `ready-for-agent`. The `/work` inbox
and the `/hydra-review` hitl-grill bucket are where they do it.

Applies to every issue you file about the orchestrator itself: autopilot loop bugs,
CI/test-harness defects, gate false-positives, dashboard faults, cost-accounting
gaps, drainer routing, watchdog behaviour. It applies whether the defect surfaced
from a reaped dispatch, a failed check, your own tick, or a subagent's report.

Three carve-outs, all narrow:

1. **`needs-triage` for a wedge** — the stale-heartbeat recovery path keeps filing
   `needs-triage` with the run-log tail. Unchanged.
2. **`queue-decision.sh`** — the operator decision queue is a different surface and
   is not an issue you are promoting. Unchanged.
3. **Runaway-subagent issues (#395)** — a hard-cap breach is an incident, not a
   proposal. Unchanged.

Target-scope work is unaffected: `dev_target` anchors come from the Target board,
which you do not author.

### Why (do not undo this without reading it)

Measured over the 14 days to 2026-08-19, orchestrator-side: **137 issues created,
159 closed, 0.9-day median lifetime, 78% closed inside 2 days, 100% inside 7.**
That board was not a backlog — it was a churn buffer the loop refilled as fast as
it drained, and `hydra-dev` implementing it consumed **49.8%** of all tokens while
the Target merged 1 commit in 7 days.

The specimen that made it legible: #4141 filed a suite-count gate, #4152 merged it,
it false-positived and reddened master, #4154 was filed CRITICAL, and #4157 reverted
it — filed, built, broke production, withdrawn, in roughly 36 hours, net change zero.

None of that came from a producer class. `discover_orch` / `research_orch` /
`architecture_orch` / `cleanup_orch` had all been dark since 2026-07-26, gated off a
`orch_backfill_idle` signal that cannot be true while the board is non-empty. The
supply was self-filed. This rule cuts the edge from "the loop noticed a defect" to
"the loop funds fixing it", which is the only edge that was ever load-bearing.

## Safety rules

1. NEVER modify `~/hydra` or `~/hydra-betting` working trees directly.
2. Worktree-guard preamble is mandatory for every code-writing dispatch — the default variant for `dev_orch` and every other harness-isolated class, the dev_target variant for `dev_target` (never the default: its cwd-ABORT clause false-aborts the one class launched without `isolation="worktree"`, issue #4178).
3. One subagent per pipeline slot.
4. Token budget is a hard cap; subagent caps (#395) bound a single misbehaving subagent.
5. `hydra-architect` is operator-only.
6. Phase 7 is the only path to the end-of-run digest (idempotent shutdown).
7. Self-filed orchestrator defects are filed `hitl-grill`, never `ready-for-agent` — see the admission rule above. Only the operator promotes.
8. The forbidden-ending preamble (issue #3866) is class-selected, exactly one block per code-writing dispatch: `dev_orch` gets the flat Agent-tool ban, `qa_orch` gets the blocking-fan-out variant (issue #4272), `dev_target` gets the delegated-mode variant (issue #4196) — never two of these composed on the same dispatch.
