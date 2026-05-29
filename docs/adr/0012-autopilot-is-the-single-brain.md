# ADR-0012: Autopilot is the single decisional brain; state is continuous via Redis + hooks

Status: Proposed
Date: 2026-05-28
Deciders: Operator + Hydra (via `/grill-with-docs` session on autopilot brittleness)
Issue: TBD (autopilot-restructure epic)

## Context

The operator's intuition that `hydra-autopilot` "feels brittle" is rooted in **structural** flaws, not in any single bug. A grilling session walked the design tree and surfaced six concerns that compound:

### 1. Two-brain architecture

Two control planes run on different lifecycles with no shared source of truth:

- The **Orchestrator Scheduler** (the scheduler module — then `loop.ts`, since renamed to `src/scheduler/heartbeat.ts` in #725) is a continuously-alive 15-minute loop. It tracks `lastTickAt`, merge-rate windows, daily-spend, the stale-claim reaper — and historically it also force-fires research cycles via `runResearchLoop` when `scheduler/research-floor.ts` triggers.
- The **Autopilot Run** (`scripts/autopilot/decide.py`, ADR-0007) is the L2 brain — discrete timer-fired Claude sessions (~8h) that wake, walk the decision loop, and exit.

The two have **structurally-identical research-floor policy implemented twice** — once in `scheduler/research-floor.ts`, once in `decide.py:_research_force_allowed`. They cannot veto each other; they share no state about what's been decided.

### 2. Per-run amnesia

`bootstrap.sh` initialises a fresh `state.json` on `/tmp` every run. `cumulative_tokens`, `burned_classes`, `failure_log`, `slots`, `merged_prs` all start at zero. This conflates **per-run execution context** with **continuous reality**:

- `slots` describe subagents that outlive runs (a dispatch in run N can complete during run N+1) — but bootstrap zeros them anyway.
- `burned_classes` records soft-cap trips that should remain in force for hours, not just the current run.
- `failure_log` resets so the 5-failure backstop only counts within one run; chronic cross-run failures don't trip it.

The proximate consequence: on systemd `Restart=on-failure` (or any crash), in-flight subagents become orphaned because the new state.json says no slot is occupied. The Plan that decide.py computed is forgotten the moment it's executed.

### 3. Implicit campaigns

The autopilot's mental model — per the operator — is *"advance highest-priority issues from triage through merged and deployed."* But `decide.py` makes per-turn local decisions over a flat candidate set. There is no first-class concept of "the multi-issue program of work we're focused on right now." The autopilot has no way to know that "issues #500-#504 are this week's program" without that being implicit in priority labels.

GitHub epics (#437, #642) and `config/direction/roadmap.md` milestones provide unit-of-work and timeline-grouping concepts respectively — but no pointer says "the autopilot should bias toward this epic / milestone / theme right now."

### 4. Wedges treated as runs-to-terminate, not subagents-to-unblock

When a dispatched subagent gets stuck (CI red, PR conflict, missing context, no-diff outcome), the autopilot's current responses are:

- The 5-failure backstop (terminate the run after 5 consecutive same-pattern failures)
- `self_heal.py` retry strategies (narrow — verification-failure / no-diff / rollback only)
- The external watchdog catching process freeze (heartbeat staleness)

None of these handle the "subagent blocker → autopilot unblocks autonomously" pattern. The autopilot has the visibility (it dispatched the subagent; it knows the goal) but lacks the action vocabulary (no `reprompt`, no `dispatch-helper`, no `decompose`). Blockers either resolve themselves or the run terminates and the operator inherits the mess via the digest.

### 5. The decisional brain isn't bound by cost on remediation

If we DID add autonomous remediation, today there is no bound that prevents cascading retries from consuming the budget. A primary blocks → helper dispatched → helper blocks → helper-for-helper dispatched. Token budget vanishes in 90 minutes with nothing merged.

### 6. The operator surface is reactive, not at-a-glance

The autopilot's state is observable via journalctl, `gh issue view`, dashboard widgets — all spread across surfaces. There is no single view showing "how are my agents doing right now, and what's stuck." The pokemon-themed `/now` page (#647-#649, sub-issues of #642) already speaks the right vocabulary (HP/EXP/LV/status conditions/Infirmary/town crier) but doesn't yet surface remediation health.

## Decision

**The autopilot is the single decisional brain. State is continuous and lives in Redis. Subagent blockers are handled autonomously, bounded by a per-task budget, and observed through a pokemon-themed /now page.** Six structural changes:

### D1 — Scheduler is bookkeeping-only

Delete `src/scheduler/research-floor.ts`, `src/scheduler/research-decision.ts`, and the `runResearchLoop` call in the scheduler module (then `loop.ts`, since renamed to `heartbeat.ts` in #725). The Scheduler retains ONLY:

- `lastTickAt` heartbeat for the watchdog
- Rolling merge-rate window (`mergeRate`, `mergeRateWindow`)
- Daily-spend totals
- Cycle-record aggregation for the dashboard

The stale-claim reaper migrates into `decide.py` (extending Phase 2's existing reap loop to also sweep stale claims with no `subagent_stop` event). After this PR the Scheduler makes no policy decisions and dispatches no work. Future-rename to **Observability Heartbeat** is plausible but out of scope.

### D2 — Continuous state via Redis + hooks

`bootstrap.sh` reads `slots`, `burned_classes`, `failure_log`, and the `remediation` map from Redis at run start — with TTL-bounded keys that auto-cleanse. `state.json` on `/tmp` becomes a **per-run cache** of Redis-backed continuous state, not the source of truth.

New hooks under `scripts/autopilot/hooks/`:

- `pre-tool-use.sh` — fires on every `Agent` / `Bash` (merge|approve|queue-decision) tool call from inside the autopilot harness. XADD `plan-action` event with `state=attempting, action_type, action_payload` to `hydra:autopilot:plan-actions:<runId>:<turn>`.
- `post-tool-use.sh` — confirms the same event with `state=completed, result_hash, result_summary`.
- `inside-subagent-progress.sh` — fires from inside the *subagent's* harness (PreToolUse/PostToolUse). XADD progress event to `hydra:autopilot:slot:<slot>:progress` (e.g., "ran `gh pr checks`, output is FAILURE", "edited file X").

On crash + restart, bootstrap reads pending `plan-actions` with no completion and emits reconciliation actions before normal Phase 1. On normal run-end, completed plan-actions get rolled into the run/turn observability stream and the per-action keys are deleted.

Operator escape hatch: `hydra autopilot reset` clears all continuous-state keys, returning the autopilot to today's amnesiac behavior. Tier-1 (operator-only).

### D3 — Autopilot Focus pointer

One Redis key: `hydra:autopilot:focus`. Four shapes:

- `epic:<N>` — bias toward sub-issues of epic #N
- `milestone:<slug>` — bias toward issues referenced by the named milestone in `config/direction/roadmap.md`
- `label:<l>` — bias toward issues carrying this label (typically a `focus-<theme>` label)
- `auto` — no bias; current behavior

`decide.py:_select_for_slot` reads the focus once per turn. When the intersection of focus-matching and eligible candidates is non-empty, it prefers the top-scored match within that subset. When empty it falls back to the global top-scored candidate. **Focus biases; it never blocks** — if nothing in the focus area is eligible, the autopilot does normal work.

Operator CLI: `hydra focus set|clear|show`.

The closure of focused work is the closure of the underlying object — Epic auto-closes via `hydra-epic-close`, milestone tickoff via roadmap.md edit, label-set drain to zero matching issues. Autopilot Focus never closes itself; the operator clears it when satisfied.

### D4 — Subagent blockers handled autonomously

A new sibling module `scripts/autopilot/blockers.py` classifies events from `hydra:autopilot:slot:<slot>:progress` into blocker classes. `decide.py` reads classifications and emits remediation actions.

**Blocker classes** (initial set; extensible):

| Class | Sample trigger | Remediation |
|---|---|---|
| PR conflict (DIRTY) | subagent reports `gh pr view` returns `mergeStateStatus: DIRTY` | `dispatch-helper: hydra-pr-rebase` |
| Missing design-concept artifact | `dev_orch`/`dev_target` dispatch before grill artifact exists | `dispatch-helper: hydra-grill scope=<orch\|target>` |
| QA-fail with named criteria | hydra-qa returns FAIL verdict with `acceptance-criterion-unmet` cues | `reprompt` with QA report as augmented context |
| Scope-justification needed | scope-check gate fails | `reprompt` with scope-justification template |
| Verification-failure (test/typecheck/build) | CI check returns failure on PR | `reprompt` with failure output |
| no-diff outcome | subagent completes with `no-diff` | `decompose` (`/to-issues` against the task; requeue children) |
| Subagent crash | `subagent_stop` with `status=failure` and no friction report | `retry` with backoff (existing `self_heal.py`) |
| Idle within subagent | progress stream silent for ≥30 min while CI green | SIGTERM + `reprompt` with `Friction Report` as context |
| Blocked-by-other-issue | subagent explicit signal | requeue with `blocked` label; activate dependency |
| Operator-required (ADR-0005 closed list) | secrets / external accounts / Tier-0 / vision conflict | `queue-decision` — the only path that escalates |

**New action types** added to `decide.py`'s `make_*` helpers:

- `reprompt(task_id, augmented_context)` — re-dispatch SAME task with the same task_id but additional context. Idempotent per `(task_id, attempt_n)`.
- `dispatch-helper(parent_task_id, helper_class, helper_payload)` — dispatch a sibling agent to unblock the primary. Slot state becomes `blocked-pending-helper` rather than free/occupied.
- `decompose(task_id)` — kill in-flight subagent, run `/to-issues` against its task, requeue children.
- `abort-and-replan(task_id, smaller_scope)` — kill + replan smaller scope.

The remediation pipeline runs *before* normal pipeline-dispatch in `decide.py`'s decision order, between step 2 (completion reaps) and step 4 (pipeline dispatch).

### D5 — Per-task remediation budget

A new Redis-resident map: `hydra:autopilot:remediation:<task_id>` carrying:

```
- blocker_class: str | null
- first_detected_at: int
- remediation_attempts: [{type, task_id, started_at, outcome, tokens_spent}]
- chain_depth: int
- parent_task_id: str | null
- status: enum  # detecting | remediating | resolved | failed-cascade
- tokens_spent_on_remediation: int
- attempt_count: int
```

Three independent caps:

1. **Per-task attempt count**: max 3 remediation attempts per task. Beyond 3 → `queue-decision`.
2. **Per-task chain depth**: max 2. Helper-of-helper-of-primary allowed; deeper → `queue-decision`.
3. **Per-task token cap on remediation**: soft cap ~50k tokens. Tunable via `state.limits.remediation_token_cap`.

Plus one global guard:

4. **Per-run remediation share**: soft cap at 40% of the run's token budget. Hard-stop if remediation consumes more than primary work; lands in the daily decision queue.

Any one cap tripping forces `queue-decision`. The redundancy is intentional — each catches a different failure mode (lots of cheap retries vs. one expensive retry vs. deep cascade vs. global runaway).

### D6 — Pokemon-themed operator surface on /now

The existing `/now` page (#647-#649) already carries subagent sprites with HP/EXP/LV/cooldown (#657), an Infirmary (#647), and notice board + Oak town crier (#647). Three additive overlays:

- **HP bar** = per-task remediation budget remaining. Depletes with each attempt. At 0 HP the task is "fainted" → routes to Infirmary.
- **Status conditions over the sprite** — one icon per active blocker class:
  - `Sleep` = waiting on CI
  - `Paralysis` = PR-conflict (DIRTY)
  - `Confusion` = no-diff outcome
  - `Poison` = chronic failure-pattern
  - `Burn` = exceeded per-task token cap
  - `Frozen` = waiting on operator (ADR-0005 closed list)
- **Chain depth badge** — small "1/2" or "2/2" indicator showing helper-cascade depth.

Two existing dashboard elements naturally absorb new remediation semantics:

- **Infirmary** is the destination lane for fainted tasks (any cap tripped). Operator triages from Infirmary like a trainer reviving at a Pokemon Center.
- **Oak town crier** posts the 40% global remediation share warning: *"Something feels off — most of your team is recovering, not battling."*

New widget: **Team Health Panel** bottom-right of /now. Six rows matching the pipeline slots, each showing sprite + HP bar + status icons + chain badge. Empty slots render as PokéBalls. **No proactive alarms** — operator looks at the party panel when they look.

## Consequences

### Positive

- **Single source of truth for policy.** Research-floor logic exists in one place (`decide.py`), not two. The two-brain failure mode is structurally eliminated.
- **No more per-run amnesia.** Slots, failure patterns, and burned classes survive crashes. Chronic cross-run failures finally trip the backstop. The autopilot's mental model of "I'm the project manager advancing this work" stops being broken by lifecycle gaps.
- **Subagent blockers stop becoming operator inbox items.** PR conflicts, missing artifacts, QA fails route to helpers or reprompts instead of dying silently. The autonomy ceiling rises significantly.
- **The 87% recent merge rate should improve** because most "wedges" the operator notices are actually subagents the autopilot could have unblocked itself.
- **Operator-visible health at a glance.** The pokemon /now panel makes "which subagents are healthy vs struggling" inspectable without parsing journalctl.

### Negative

- **Substantial blast radius.** Six structural changes; one ADR but ~6-10 PRs to fully land. Migration risk is real.
- **Continuous state introduces new failure mode** — wrong values can poison subsequent runs. The TTLs auto-cleanse but a wedged Redis value within the TTL window could degrade behavior. Mitigation: `hydra autopilot reset` operator command + aggressive 24h max TTL on derived fields.
- **`decide.py` grows.** It's already ~1500 lines. Adding 4 action types + a blocker classification call site + remediation budget tracking pushes it further. We accept this for now; the auditability concern earns its own future ADR.
- **More frequent Claude sessions.** Autopilot frequency rises from 2x/day to ~6x/day to compensate for scheduler-side research disappearing. Per-session overhead (bootstrap/drain ceremony, ~5 min) means ~30 min/day of pure ceremony. Acceptable for autonomy gains.
- **Helper agents can fan out.** With `dispatch-helper`, a single primary task can trigger up to chain-depth-2 helpers. Tokens compound; bounded by D5 caps but still real.

### Risks accepted

- **Mid-run schema bumps to the continuous-state shape will require a one-time `hydra autopilot reset`.** We adopt the same loud-failure handshake as ADR-0007's schema-version pattern: bootstrap reads `schema_version` and aborts if mismatched. Operators run the reset on bump.
- **The pokemon surface is a one-way design commitment.** The operator's mental model is now expressed in pokemon vocabulary across the dashboard. Reverting to a "neutral" UI later would be a UX downgrade. We accept this — the operator has explicit preference for the theme, and the abstraction (HP/status/chain depth) is sound regardless of skin.
- **Per-task budgets can mis-fire on legitimately-hard work.** A task that takes 4 attempts to land could exceed the attempt-count cap. The escape hatch is `queue-decision` → operator can grant more budget by clearing the remediation key. Trade-off accepted: better to surface the hard case to operator than to spin indefinitely.

## Alternatives considered

- **Keep two brains; firewall them.** Document precisely what's each brain's responsibility; add invariant tests. Rejected: doesn't resolve the duplication, just makes it intentional. The scheduler-side research-floor is exactly the duplication we don't want frozen as design.
- **Stay with per-run amnesia; add only selective persistence** (failure pattern + burned-classes + last-focus hint). Rejected: at 6x/day frequency, amnesia gets worse, not better. Selective persistence solves half the problem; continuous state solves all of it for similar implementation cost.
- **Add a Campaign object** with goal, acceptance function, active anchors, expiry. Rejected: overlaps too much with **Epic** which already exists. The structural gap was a missing pointer, not a missing noun.
- **Wedge detection + 3-stage degrade/escalate/terminate.** Rejected: abdicates the autopilot's project-manager responsibility. The right response to a stuck subagent is for the autopilot to unblock it, not to give up and queue an operator decision.
- **Per-slot remediation budget** instead of per-task. Rejected: slots are reused across tasks, so "max 3 remediations per slot" doesn't map to "max 3 attempts to ship this one issue." The work unit is the task; the budget should align.
- **No operator surface; just fix the architecture.** Rejected: the pokemon /now integration is cheap (additive overlays on existing sprites) and the operator explicitly asked for it. At-a-glance health is an autonomy multiplier — operators intervene faster when they can see what's stuck.

## Migration plan

1. **PR-1**: Land this ADR + the `hydra:autopilot:focus` Redis key + minimal CLI (`hydra focus`) + `decide.py` scoring bias. No behavior change unless operator sets a focus.
2. **PR-2**: Add the hook infrastructure (`pre-tool-use.sh`, `post-tool-use.sh`, `inside-subagent-progress.sh`) wiring Redis streams. No autopilot behavior change; observability only.
3. **PR-3**: Bootstrap-from-Redis for `slots`, `burned_classes`, `failure_log`, `remediation`. TTL-bounded. `hydra autopilot reset` operator command.
4. **PR-4**: Delete `scheduler/research-floor.ts`, `scheduler/research-decision.ts`, `runResearchLoop` callsite. Migrate the stale-claim reaper to `decide.py`.
5. **PR-5**: `scripts/autopilot/blockers.py` classifier + the new action types (`reprompt`, `dispatch-helper`, `decompose`, `abort-and-replan`). Each blocker class gets a dedicated test.
6. **PR-6**: Per-task remediation budget + 4 caps. Caps tunable via env / `state.limits`.
7. **PR-7**: Pokemon /now overlays — HP bar = remediation budget; status conditions per blocker class; chain depth badge; Team Health Panel; Infirmary as fainted-task destination; Oak town crier for 40% guard.
8. **PR-8**: Increase autopilot timer frequency (morning 10:00, midday 14:00, evening 18:00, overnight 22:00, late-overnight 02:00, dawn 06:00 — 6x/day). Verify per-run wall-clock budget can absorb the cadence.

Each PR lands and stabilises before the next. Behavior change is layered; rollback is a revert of any single PR.

## Related

- ADR-0001 Untouchable Core & gate extraction — the Scheduler bookkeeping retains Tier-0 protection
- ADR-0005 Operator escalation is narrow — the closed list still defines the only legitimate escalation surface; D4's `queue-decision` is the only path to it
- ADR-0006 Codex CLI removed; autopilot-only — this ADR is the next step in that lineage (autopilot becomes the *only* decisional brain, not just the only execution path)
- ADR-0007 Decision-brain orchestration — `decide.py` was already the L2 brain; this ADR makes it the SINGLE brain by deleting scheduler-side policy
- ADR-0008 Design-concept gate — D4's "missing design-concept" blocker uses Phase B's gate as the trigger
- ADR-0010 Stuckness detector retired — this ADR explicitly does NOT reintroduce stuckness detection; remediation handles subagent-level wedges and operator-curated focus replaces system-curated trip wires
- Issue #437 (design-concept gate epic) — affected by D4 (missing-artifact blocker triggers grill-helper)
- Issue #642 (now-pixel epic) — extended by D6 (remediation overlays)
- Epic for this ADR — TBD (will spawn PR-1 through PR-8 as sub-issues)
