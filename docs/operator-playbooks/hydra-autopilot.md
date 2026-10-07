---
name: hydra-autopilot
description: Event-driven autonomous decision loop that orchestrates all Hydra work in one Claude Code session via decide.py, executing typed action plans unattended for hours per run.
when_to_use: "When the operator says 'autopilot' or 'autonomous mode', or a scheduled launch fires."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
disable-model-invocation: true
reference_files: [_fragments/hydra-autopilot-class-wiring.md, _fragments/hydra-autopilot-phase6-ops.md, _fragments/hydra-autopilot-ops-reference.md, _fragments/hydra-autopilot-dispatch-reference.md, _fragments/hydra-autopilot-operator-guide.md, _fragments/hydra-autopilot-signal-wiring.md]
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

**On-demand files (siblings of this SKILL.md).** None is needed to run an
ordinary turn. Read the one a trigger names, when it fires — and read the
section, not the whole file:

| File | Read it when |
|---|---|
| `hydra-autopilot-dispatch-reference.md` | the first dispatch of a class this session (its taxonomy row); any `wayfinder_orch` dispatch; a `fable`-routed dispatch dies instantly; a question about resume queueing, the `qa_target` hold, the isolation verdicts, or why a preamble block is worded as it is |
| `hydra-autopilot-class-wiring.md` | a class's cooldown, saturation guard, scope or cadence is in question |
| `hydra-autopilot-phase6-ops.md` | the cycle-record write, the register handoff on auto-merge, the token-surrogate write |
| `hydra-autopilot-ops-reference.md` | troubleshooting, termination and baton-pass detail, the slot-event schema |
| `hydra-autopilot-operator-guide.md` | operator-facing material: invocation, Pace Gate scheduling, the stop levers, inspecting a run, the quota budget |
| `hydra-autopilot-signal-wiring.md` | a signal's meaning, producer or consumer is in question — the collect-state output → `state.signals` key → class table `merge-signals.py` executes (never run by the session) |

## Loop

Each tick:

1. **Wake** on TaskNotification, Monitor board-change, or a 15-min heartbeat.
2. **Events** — write `events.json` (default `/tmp/hydra-autopilot-events.json`): a JSON **list** of typed events (`{"type": "completion" | "qa-verdict" | "signal", ...}`); `[]` — or no file at all — when there are none. Build every `qa-verdict` event with `bash scripts/autopilot/qa-verdict-event.sh <PR> <TIER>` (see "Building `qa-verdict` events" below). Raw `hydra:autopilot:slot-events` rows (`{"id", "fields": {"event": ...}}` — what `collect-state.sh` emits as `slot_events_json`) belong on `state.slot_events`, not on the events lane; `turn.sh` puts them there.
3. **Turn** — `bash scripts/autopilot/turn.sh events.json` (issue #4831) — Phases 1–4 as ONE command: the JSON Turn Snapshot first (ADR-0043 slice 6, #4934: `turn-snapshot.ts --format json` runs every collector in one process, validated on emit, cursor from `state.slot_events_last_id`; `turn_snapshot.py apply` stores it on `state.turn_snapshot`, the form `decide.py` reads through `scripts/autopilot/turn_snapshot.py`) — and, only when that emit is unusable, automatically for that turn: `collect-state.sh` → `merge-signals.py` (issue #4829: writes `state.signals` wholesale — the Signal wiring table in `hydra-autopilot-signal-wiring.md` is what it writes, parity leg L4 keeps the two identical — plus the verbatim blobs `usage_eligibility`, `emergency_brake`, `target_risk_surface`, `class_stats`, `candidate_exclusions`, `slot_events` + `slot_events_last_id`) → `term-check.py` (printed, informational) → `decide.py decide state.json candidates.json events.json` → `plan.json` (default `/tmp/hydra-autopilot-plan.json`) → `assert_invariants.py plan.json state.json`. It prints one plan summary line (`turn`, `actions` without the sentinel, `reasons`) and one usage line; read those, never re-run the pieces by hand. **Exit 0 = execute the plan. Any other exit = do NOT execute**: 1 means the invariants rejected the plan, 2 means a phase could not run (no state — bootstrap first; replay/merge failure), anything else is `decide.py`'s own exit (its stderr tail is echoed). Never hand-edit `state.signals`; a missing `candidates.json` is created as `{"candidates": []}` (ADR-0031). `decide.py`'s CLI bumps `state.turn` by one and persists it atomically BEFORE calling `decide()` — the bump is a `main()` side-effect; `decide()` itself stays pure. **Events-shape contract (issue #4213):** `decide()` normalises the events argument once, at its top, before any rule reads it — a bare list and the `{"events": [...], "last_id": ...}` wrapper are equivalent (the wrapper is unwrapped by the same helper the `state.slot_events` lane uses); non-dict entries are dropped with `events-entry-skipped:<n>`; raw stream rows that land on the events lane are re-homed onto `state.slot_events` (dedup by `id`, reason `events-stream-entries-rehomed:<n>`) so the one `subagent_stop` projection frees the slot either way; an unreadable or unparseable `events.json` logs one stderr line and yields a plan carrying `events-malformed-ignored` — never a traceback, never a lost plan. The turn is still consumed (the bump stays before `decide()`, per #1769). `state.json` / `candidates.json` keep failing hard.
4. **Read the summary.** The plan is at `plan.json`; the two summary lines are the whole of what step 5 needs (action `type`/`slot`/`skill`/`prompt_args`, plus `isolation`/`worktreeBranch` per dispatch). Open `plan.json` only for a field the summary does not carry (`dispatchSentinel`).
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

### Building `qa-verdict` events (issues #4737, #4738)

`bash scripts/autopilot/qa-verdict-event.sh <PR> <TIER>` prints one event
(issue #4831); the session appends it to `events.json` in step 2, one per PR
whose latest `QA-Verdict:` trailer it acts on: right after a `qa_orch` reap,
and again on later ticks for a PR still waiting on CI. `<TIER>` is the PR
body's `Tier:` line. **Every field comes from the QA merge guard and the shared
required-check helpers, never from memory or a hand-parsed comment** — the
script is the recipe below, verbatim (its `ci-state` / `qa-verdict-event`
blocks are pinned to this fence by `test/autopilot-turn-runner.test.mts`, and
it `source`s the shared `checks-fetch` fragment rather than copying it). The
recipe stays here as the documented contract; do not re-type it by hand:

```bash
# $PR = the PR number; $TIER = its tier (the PR body's `Tier:` line).
# Guard exit: 0 allowed, 1 denied, 2 bad args. The JSON is on stdout for 0/1.
GUARD_JSON=$(node --experimental-strip-types scripts/ci/qa-merge-guard.ts --pr "$PR" --repo gaberoo322/hydra)
GUARD_JSON=${GUARD_JSON:-null}
# Required-check state via the SAME shared fetch hydra-qa's verdict uses
# (step 5) — one fragment, so the two call sites cannot drift (issue #4757
# INV-2). A failed read leaves CHECKS_JSON empty, the ci-state block below
# fails to CI_JSON=null, and the event's verdict holds PENDING (fail-closed).
PR_NUMBER="$PR"
@include _fragments/checks-fetch.md
# >>> ci-state
CI_JSON=$(CHECKS_JSON="$CHECKS_JSON" node --no-warnings --experimental-strip-types -e "
  import('./scripts/ci/qa-verdict.ts').then(({redRequiredChecks, classifyVerdict}) => {
    const checks = JSON.parse(process.env.CHECKS_JSON);
    process.stdout.write(JSON.stringify({red: redRequiredChecks(checks), requiredPending: classifyVerdict('PASS', checks).summary.requiredPending}));
  }).catch((err) => { console.error('[autopilot] required-check read failed:', err); process.exit(1); });
") || CI_JSON=null
# <<< ci-state
# >>> qa-verdict-event
jq -nc --argjson pr "$PR" --argjson tier "$TIER" --argjson guard "$GUARD_JSON" --argjson ci "$CI_JSON" '
  ($guard.verdict // "") as $v
  | {type: "qa-verdict", pr_number: $pr, tier: $tier,
     verdict: (if ($v | startswith("FAIL")) then "FAIL"
               elif ($v == "PASS" or $v == "PASS-pending-CI") and $ci != null then
                 (if ($ci.red | length) > 0 then "FAIL"
                  elif $ci.requiredPending > 0 then "PENDING"
                  else "PASS" end)
               else "PENDING" end),
     verdict_sha: ($guard.verdictSha // "unknown"), head_sha: ($guard.headSha // "")}'
# <<< qa-verdict-event
```

- **`verdict`:** a `PASS` or `PASS-pending-CI` trailer becomes `"PASS"` once
  every required check is green, `"PENDING"` while one is still pending, and
  `"FAIL"` if one went red. QA never re-runs to promote `PASS-pending-CI`, so
  this re-evaluation on later ticks is what lands those PRs. A `FAIL*` trailer
  is always `"FAIL"`. An unreadable guard or CI read is `"PENDING"` (fail
  closed).
- **`verdict_sha` / `head_sha`** are the guard's `verdictSha` / `headSha`.
  `decide.py` arms only when they bind, which is the guard's own "allowed" test.
  A stale PASS keeps its mismatched SHAs, so it holds visibly as
  `hold:#N:stale-verdict`. An event WITHOUT the two fields gets only the legacy
  INV-007 check, so never omit them.

## Class taxonomy (7 pipeline slots + 15 signal classes)

Every `dispatch` action names its class in `slot` and its skill in `skill` —
dispatch what the action says. Pipeline classes (one slot each): `dev_orch`,
`qa_orch`, `research_orch`, `dev_target`, `qa_target`, `research_target`,
`design_concept_orch`. Signal classes (a cooldown, no slot): `health`,
`sweep_orch`, `sweep_target`, `discover_orch`, `discover_target`, `scout_orch`,
`architecture_orch`, `retro_orch`, `cleanup_orch`, `cleanup_target`,
`wire_or_retire_target`, `design_qa_target`, `skill_prune`, `wayfinder_orch`,
`tickets_orch`.

> **CONTEXT POINTER:** the class → skill table, with each class's cadence, caps and dispatch notes, lives in `hydra-autopilot-dispatch-reference.md` § Class taxonomy (sibling of this SKILL.md). Read a class's row the first time you dispatch that class in a session. The two dispatch-time overrides (`wayfinder_orch`, `qa_target`) are in THIS file, below.

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
| `dispatch` | **Render first: `python3 scripts/autopilot/render-dispatch.py <slot> [--notes-file <md>]` (issue #4833)** — it prints `{skill, model, isolation, description, prompt}`; pass those four fields straight to `Agent(run_in_background=True, isolation=<isolation or omitted>, model=<model or omitted>, description=<description>, prompt=<prompt>)`, then stamp the slot (below). The renderer reads the preamble fences and the routing table in THIS file at render time and applies every rule in the rest of this row — sentinel, guard variant by `action.isolation`, the class's forbidden-ending block, the `CYCLE_ID` / `TARGET_WT_BASE` line, the mandatory `prompt_args` sentences (pinned anchor, resume, forward-fix contract, `pr_ref`, wayfinder claim + resolution protocol + ticket-type skill override), the `escalate_model` hint and the Fable pre-resolution. Put what only the session knows (lane heads, SHAs, warnings) in the notes file; never re-type a preamble block. The rest of this row documents what the renderer produces: `Agent(run_in_background=True, isolation="worktree", model=<resolved>, ...)` — **resolve `<model>` from the action's `slot` (the dispatch class) via the Per-class model routing map below and pass it to the `Agent` call** (issue #1093). A class absent from the map → omit `model`, inheriting the parent session. `decide.py` stays pure: it emits no model field; the model lever lives here in the playbook, keyed off the `slot`/class the action already carries. **Then stamp the slot — `python3 scripts/autopilot/stamp-slot.py <slot> <agentId> <model>` (issue #4831)**, where `<agentId>` is the bare hash the `Agent` tool returned (`reap.py` keys the completion on it) and `<model>` is the alias actually passed (`inherit` when omitted). It reads everything else off the plan action for that `slot` (`skill`, `worktreeBranch`, `isolation`, `prompt_args.anchor`, `prompt_args.attempt`) and writes `state.slots.<slot>` = `{skill, task_id, started, started_epoch, branch, worktreeBranch, dispatch_id, model, turn, attempt, isolation, anchor?}` (a signal class: `signal_last_fired[<slot>]` only), bumps `dispatches`, and appends the run-log line through `dispatch.sh log`. Never hand-write a slot: a hand stamp that omitted `branch`/`anchor` is why `reap.py` carries a Redis recovery fallback. The action carries `worktreeBranch` (stamped by `decide.py:_synthesize_worktree_branch`; issue #527) so the dashboard's slice-4 "Watch stream" cross-link can scope `/agents/stream?agent=<branch>`. The action ALSO carries `dispatchSentinel` (issue #692) — a hidden HTML comment of the form `<!-- hydra-dispatch v1 skill=… dispatchId=… runId=… -->`. **Prepend `action.dispatchSentinel` verbatim, on its own line, to the FIRST user message of the Agent prompt** (before the worktree-guard preamble). The project-scoped `SessionStart` hook (`scripts/hooks/session-start-capture.sh`, registered in `~/hydra/.claude/settings.json`) scrapes that sentinel from the session transcript and registers the subagent session into `hydra:dispatches:subagent:*` so every live session is recoverable to `(skill, dispatchId, runId, startedAt)`. When `decide.py` does not emit `dispatchSentinel` (legacy plans / a dispatch with no `skill`), skip the prepend — the session simply won't auto-register. **Isolation is read from `action.isolation` (issues #3889, #4476):** `decide.py` stamps `isolation` (`"worktree"` | `"self"`) on every dispatch action from its `TARGET_ISOLATION` policy. Pass `isolation="worktree"` iff `action.isolation == "worktree"`; OMIT it iff `action.isolation == "self"`; a legacy plan whose action lacks the field → `"worktree"` (fail-safe to the old default). A `self` class is a Target-scope class whose playbook mutates the Target tree: the harness's worktree isolation only covers the orchestrator repo (`~/hydra`), and because the Target workspace (`$TARGET_WS`) is a sibling repo, a pinned session is refused every git mutation against it (#3889: Step 0.6's `worktree add` failed 2/2). A `self` class isolates itself in a Target worktree nested under `$TARGET_APP_DIR/.worktrees/` (issue #4177 — relocated off `/dev/shm` to eliminate the reach-back node_modules symlink hazard, #4175), and the installed `worktree-write-fence.sh` PreToolUse hook provides the ghost-write protection `isolation="worktree"` plays for the harness-isolated classes. The per-class verdict table lives in the self-isolated-class carve-out below. The preamble follows the same split (issues #4178, #4476): for a `self` dispatch prepend the **self-isolation variant** of the worktree-guard preamble (`_fragments/target-self-isolation-preamble.md`, see the Worktree-guard preamble section) — NOT the default block, whose `cwd == /home/gabe/hydra → ABORT` line false-aborts a dispatch whose expected launch cwd is exactly that. `dev_target` ALSO carries its OWN dev_target forbidden-ending preamble variant (issue #4196): append that variant (see the Worktree-guard preamble section) immediately after the self-isolation worktree-guard block — never the `dev_orch` block, which bans the Agent tool outright and would contradict `hydra-target-build`'s own delegated-mode contract. **`qa_orch` exception:** append the `qa_orch` forbidden-ending preamble variant (issue #4272; see the Worktree-guard preamble section) instead of the `dev_orch` block — it prohibits the same end-turn-on-a-child hazard but, unlike `dev_orch`'s flat ban, permits the blocking (`run_in_background: false`) reviewer spawns `hydra-qa` step 7's fan-out requires. |
| `auto-merge` | `Bash` → re-run the QA merge guard (`scripts/ci/qa-merge-guard.ts --pr N`, issue #4738); on a non-zero exit skip the arm and log its `reason` (never override). Else `gh pr merge --auto --squash`, then a SINGLE `POST /api/holdback/pending {prNumber, tier, cycleId}` register call (see Phase 6). **No self-approve prefix** — every agent shares the `gaberoo322` identity and GitHub 422s a self-approval, so chaining an approval before the merge (`… && gh pr merge …`) short-circuits and silently skips the merge-enable, leaving green PRs to pile up for admin-merge (reference_qa_cannot_self_approve / #848; hydra-qa removed the same trap via #974). There is no approving-review branch-protection gate — CI required-status-checks are the merge gate — so approval is a no-op regardless. Guarded by `test/autopilot-auto-merge-no-self-approve.test.mts`. The handler does NOT itself enroll the holdback or write the merged cycle-record — it only ARMS the PR; the in-process merge-completion watcher (`src/scheduler/chores/holdback-merge-watch.ts`, issue #2623) fires both merge-coupled follow-ups once the merge lands. |
| `route-prs-to-review` | `Bash` → emitted only while the operator-only **emergency brake** (issue #744) is engaged, IN PLACE OF every `auto-merge` action. The model routes the current open PRs to the `/hydra-review` pickup set: `gh pr list --repo gaberoo322/hydra --state open --json number` to enumerate them, then for each apply the review label (`gh api .../labels` — `gh pr edit` is broken, per operator memory) so `/hydra-review` surfaces them. The action carries no per-PR list — `decide()` is pure and cannot enumerate PRs. Because the brake suppresses all `auto-merge`, no PR auto-merges this turn; the operator clears the brake via `hydra brake off` once the incident is resolved. The autopilot NEVER engages or disengages the brake — there is no such action type. |
| `apply-operator-approved` | `Bash` → `gh pr edit --add-label operator-approved` |
| `update-branch` | `Bash` → `gh api -X PUT "/repos/gaberoo322/hydra/pulls/${PR_NUMBER}/update-branch" -f expected_head_sha="${HEAD_SHA}"` (the `expected_head_sha` binding is load-bearing — it makes a rebase on a moved head fail 422 instead of racing; `HEAD_SHA` is `gh pr view N --json headRefOid --jq .headRefOid`, per the /hydra-pr-rebase playbook the flow mirrors). Emitted ONLY by the PR-gate rule (issue #4240) for BEHIND PRs that are quiescent (collect-state filters on a 5400s `updatedAt` window — an actively-pushed PR never races a rebase), **capped at two per turn, oldest first** (lowest PR number first) so a post-merge-wave behind backlog drains over successive turns instead of one GitHub-mutation burst. |
| `surface-pr` | `Bash` → `gh api .../issues/N/labels` to apply `ready-for-human` (**never `gh pr edit`** — broken, per operator memory; same label route as `route-prs-to-review`), then a single explanatory `gh pr comment N --body` carrying the action's `reason` verbatim so the operator queue shows WHY the PR is parked, not just that it is. Emitted only by the PR-gate rule (issue #4240) with `cause: dirty` (merge conflict — `update-branch` 422s on these; surfaced only after the one `conflict-fix-attempted` fix-forward is spent or the anchor is ambiguous, issue #4807 — when the action carries `closing_issue`, also `DELETE .../issues/<issue>/labels/needs-dev-resume` (name in the URL path, 404 tolerated), add `ready-for-human` to the issue, and post ONE issue comment naming the PR), `cause: unchecked` (zero check-runs past the grace window with a healthy trigger arm — CI never started), or `cause: glm-red-forward-fix-exhausted` (issue #4460, INV-8 — a GLM-authored PR still red on a required check after the cap of 2 pinned forward-fix dispatches). **The label is the idempotency key**: collect-state excludes `ready-for-human`-labelled PRs from the dirty/unchecked buckets (and from the #4460 glm-red predicate, INV-3b) at read time, so a surfaced PR is never re-surfaced next turn. Per-PR blast radius by design — a repo-wide trigger outage holds with a named reason (`hold:ci-trigger-stale`) instead of flooding the queue. |
| `reap` | `Bash` → `./scripts/autopilot/reap.py completion ...` (also fires `dispatch.sh cycle-record` for `hydra-dev` / `hydra-target-build`; see Phase 6) |
| `terminate` | `Bash` → `./scripts/autopilot/drain.sh <merged_prs>` → Phase 7. The decide CLI has already POSTed the clean run-end for this cause (issue #1352) — drain (always) + digest (skipped for cause `context_compaction`, see Phase 7 below, issue #3787) are all that remain. **In an unattended run the session then ENDS, whatever the cause — never run `bootstrap.sh` again in this session (it refuses, issue #4825).** If children are still running, dispatch nothing more: reap each one as its completion arrives, then end. The pace gate admits the next run with a fresh context. |
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

Why each class sits on its tier — the stakes × frequency rule, the Fable
entitlement checks, the evidence behind `dev_orch` on Sonnet, and a per-class
rationale — is in `hydra-autopilot-dispatch-reference.md` § Model routing
rationale.

| Class (`slot`) | Model |
|---|---|
| `dev_orch` | Sonnet |
| `dev_target` | Fable (re-promoted 2026-09-02; effective at the CSB swap) |
| `retro_orch` | Fable (re-promoted 2026-09-02) |
| `design_concept_orch` | Fable (re-promoted 2026-09-02) |
| `qa_orch` | Sonnet |
| `qa_target` | Fable (re-promoted 2026-09-02; effective at the CSB swap) |
| `sweep_orch` / `sweep_target` | Sonnet |
| `health` | Sonnet |
| `research_orch` | Sonnet |
| `research_target` | Sonnet (trial) |
| `architecture_orch` | Sonnet |
| `scout_orch` | Sonnet |
| `cleanup_orch` | Haiku |
| `cleanup_target` | Haiku |
| `wire_or_retire_target` | inherit parent (omit `model`) |
| `design_qa_target` | inherit parent (omit `model`) |
| `discover_orch` / `discover_target` | Haiku |
| `wayfinder_orch` | inherit parent (omit `model`) |

Use the harness's model alias (`fable` / `sonnet` / `haiku` / `opus`) for the
`model` kwarg so the operator's plan resolves the concrete version. A class not
in the map (e.g. a legacy/unknown `slot`) → omit `model` and inherit the parent
session, the conservative default.

`scripts/autopilot/render-dispatch.py` parses THIS table at render time (issue
#4833): a row's model cell is its first word (`Sonnet`, `Fable (…)`, `Haiku`,
`inherit parent (…)` → omit), one class per backticked name, `/`-separated rows
allowed. Add or change a row here and every rendered dispatch follows; a cell
the parser cannot read fails the render loudly (exit 2), and
`test/autopilot-render-dispatch.test.mts` pins the parsed table against the
class taxonomy.

**Fable out-of-weekly-credits pre-resolution (issue #4585).** Before EVERY
`Agent(...)` dispatch, check
`state.usage_eligibility.reasons.fableExhaustedUntil` (collect-state merges the
whole eligibility verdict into `state.usage_eligibility`). While that instant
is in the FUTURE, resolve every `fable` the routing stack would pick — the
static map rows above or a `prompt_args.escalate_model` hint — to the
**fallback model** (`opus`, or
`HYDRA_AUTOPILOT_FALLBACK_MODEL` when the unit sets it — the same pair the
pace-gate's exec branch uses for the PARENT session) BEFORE the `Agent` call,
and name the substituted model in the dispatch log
(`model-fallback: fable->opus reason=out-of-credits` on the first substituted
dispatch of the turn). The flag is a REDIRECT, never a stop: `.allow` stays
true and the class still runs — on the other model. When the instant passes
(fail-safe: absent, past, or unparseable → resolve from the map as usual), the
next `fable` dispatch re-probes the real quota; a 0-token 429 in <0.5s is the
cheap signal that the flag should re-arm. `inherit-parent` rows need no rule
of their own: while the flag is live the pace-gate launches the parent itself
on the fallback, so inheritance lands there without a hint.

**Cascade-routing escalation override (issue #3274).** When a `dispatch` action
carries `prompt_args.escalate_model` (a model alias — `decide.py` re-dispatching,
at a stronger tier, a class that just `no_op`'d or `failed`), three things are
MANDATORY for that ONE dispatch:

1. Pass `model=action.prompt_args.escalate_model` to the `Agent` call,
   overriding the class's static default. `decide.py` emits only this hint,
   never a concrete `model` field.
2. Stamp the attempt onto the new slot — `stamp-slot.py` does this from
   `action.prompt_args.attempt` (issue #4831; the field it writes is
   `slot["attempt"]`) — so a second failure reads `attempt >= max_attempts`
   and never triggers a THIRD dispatch. Pass the escalated alias as its
   `<model>` argument so the slot records what actually ran.
3. **Deposit the escalation provenance (issue #3284)** before, or right
   alongside, the `Agent(...)` call, passing the escalated slot's **task_id
   explicitly** (the `worktree-agent-<HASH>` suffix `reap.py` keys the
   completion on). Without the deposit `escalationAttempt` / `escalatedModel`
   land permanently null on the cycle record:

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

A dispatch with no `escalate_model` key resolves `model` from the static map
and never runs the deposit. Why each step exists (the max-attempts cap, the
reap-side read path, what the helper refuses to write) is in
`hydra-autopilot-dispatch-reference.md` § Cascade-routing escalation.

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

> **CONTEXT POINTER:** how a resume gets queued and survives a relaunch — the reap-side no-PR-stall backstop (issue #3866) and durable dev resume (issue #4518) — lives in `hydra-autopilot-dispatch-reference.md` § dev_orch resume internals (sibling of this SKILL.md). One rule from it applies at dispatch time: a `prompt_args.forward_fix_pr` action for a NON-GLM PR (the `orch_dev_resume_pick` pin, issue #4518) carries the forward-fix contract below verbatim, minus its `glm-authored` clause and its attempt cap, which stay #4460-only.

**GLM red-PR forward-fix dispatch contract (issue #4460, INV-10).** When the
`dev_orch` selector's dispatch action carries
`prompt_args.forward_fix_pr = <pr>` (alongside `anchor`/`resume`/`resume_branch`,
emitted for a GLM-authored PR stranded red on one required check — see the
`orch_glm_red_forward_fix` signal row in the Signal wiring table, `hydra-autopilot-signal-wiring.md`), the dispatch
prompt MUST carry this contract verbatim. The target is NOT a fresh
implementation: a PR already exists and the work is to make its required
checks pass AND resolve the blocking findings of its latest QA FAIL.

1. **Stay on the harness branch.** Work in the dispatched worktree, then
   `git fetch origin <resume_branch> && git reset --hard FETCH_HEAD` — the
   forward-fix continues the PR's exact head, never a rebase or a new branch.
   NEVER `gh pr create`: the PR exists; a second PR duplicates the anchor.
   NEVER remove the `glm-authored` label — it is the provenance key the whole
   #4460 predicate (and #4048's lane) keys on.
2. **Read the failure before fixing it.** For a CI-required-check failure,
   `gh run view <run-id> --log-failed` for the failing run (find the run id via
   `gh pr checks <pr> --json` or the PR's checks UI). For a QA-FAIL bounce
   (`needs-dev-resume` applied by hydra-qa's INV-7 path), the finding list is
   the `### Findings` table in the latest hydra-qa comment on the PR
   containing `### Findings` whose own trailing `QA-Verdict` sha matches the
   `sha=` in the anchor issue's latest `QA-Verdict: FAIL pr=<pr>` trailer
   (`gh issue view <anchor> --json comments`; the PR's comments via
   `gh pr view <pr> --json comments`) — hydra-qa posts FAILs as comments,
   never a review (#4746); a later non-Findings hydra-qa comment is not the
   finding list, and the trailer names the round. Green required checks do NOT complete a QA-FAIL
   forward-fix: push a commit resolving every blocking finding, or rebut a
   wrong finding by name in the step-5 comment — "no code change needed" is
   never the outcome while the latest verdict is FAIL (#4849). Fix the named
   defect, not a neighbouring one.
3. **Push to the SAME branch:** `git push origin HEAD:<resume_branch>`. The
   existing PR's CI re-runs on the push.
4. **Design-concept-reconcile failure specifically:** the gate reads the PR
   body captured at push time (webhook snapshot). Correct the body FIRST via
   `gh pr edit <pr> --body-file <file>`, THEN push the fix commit — a push
   that lands before the body edit replays the stale body and re-fails the
   check (bit #4242 twice).
5. **Verify in the foreground** (npm test / typecheck as the change requires),
   commit, push — the same commit-before-verify discipline as any dev
   dispatch. When done, post exactly ONE comment on the PR naming what was
   fixed and which required check(s) or QA finding(s) the fix targets, plus
   any finding you rebutted and why. Do not relabel the
   anchor issue by hand — reap's needs-qa promotion (INV-9) advances it when
   the closing PR is confirmed.

The cap: `state.glm_red_forward_fix_attempts` allows
`GLM_RED_FORWARD_FIX_CAP = 2` pinned dispatches per PR (in-run state). At cap,
no dispatch fires and `_rule_pr_gate` emits
`surface-pr {cause: glm-red-forward-fix-exhausted}` — the operator owns it.

**Conflict fix-forward delta (issue #4807).** When `prompt_args.conflict_fix` is true (the `orch_dirty_forward_fix` pin), first apply `conflict-fix-attempted` to the PR via `gh api repos/gaberoo322/hydra/issues/<pr>/labels -f 'labels[]=conflict-fix-attempted'` (never `gh pr edit`), then carry the contract above with step 1's reset kept and: merge `origin/master` into the head (NEVER rebase, force-push or `gh pr create`); keep both sides' intent; regenerate `npm run docs:inventories` and union `test/fixtures/suite-count-baseline.json` keys then `--update-baseline`; run targeted tests + `typecheck` + `typecheck:test`; push to the SAME branch; do NOT address review findings. An unresolvable conflict ends with no push and one PR comment naming the paths; never remove the marker.

**Ordering the unpinned pick — the standing work ranking (issue #3981).** Nothing
in the loop orders `ready-for-agent` issues — `hydra-dev`'s self-selection takes
whatever the API returns first — so the ranking is applied **here, in the
dispatch prompt**.

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

This claim feeds both saturation guards (≤2 workers globally, ≤1 per map);
skipping it makes them inert, so it is step 0 of every `wayfinder_orch`
dispatch. The dispatch prompt MUST also carry the **resolution protocol** —
resolution comment, close the ticket, append to the map's
`## Decisions so far`. Read both, in full, from
`hydra-autopilot-dispatch-reference.md` § wayfinder_orch (sibling of this
SKILL.md) before the first `wayfinder_orch` dispatch of a session.

### A `fable`-routed dispatch that dies instantly

A `fable`-routed dispatch — a static map row, an `inherit-parent` class under
a Fable parent, or an `escalate_model` hint — that ends in under a second
with 0 tokens and 0 tool uses did not run. **Re-dispatch the identical action
with `model: "opus"` the SAME turn — never leave the class unrun.** The
notice tells the two causes apart. A model-access error (*"it may not exist
or you may not have access to it"*) needs nothing more. *"You're out of
usage credits"* (issue #4585) also needs the exhaustion flag armed first, so
the pre-resolution rule in Per-class model routing covers the rest of the
turn. The arm command, the flag's lifetime and the check to run before
re-promoting a class to Fable are in `hydra-autopilot-dispatch-reference.md`
§ Fable fallbacks (sibling of this SKILL.md) — read it when this happens.

### `qa_target` dispatch — pass the pre-resolved PR ref (issue #4576)

`qa_target` dispatches **hydra-target-qa**, the purpose-built Target QA skill
(classes.json's row has always named it) — never `hydra-qa`, which has no
target-scope path. The action carries `prompt_args.scope: "target"` (board
provenance, unchanged) and, when collect-state pre-resolved the head needs-qa
Target PR, `prompt_args.pr_ref = <PR html_url>`. **When `pr_ref` is present you
MUST name that PR in the dispatch prompt** ("Invoke the `hydra-target-qa` skill
on Target PR `<url>`") — it is the skill's `pr_ref` argument. Absent → dispatch
unpinned; hydra-target-qa's own step 1 resolves the PR the current Target build
opened.

`decide.py` holds `qa_target` for a turn when the needs-qa PR was opened by a
`dev_target` dispatch that is still running (issue #4653; the plan names it).
Detail: `hydra-autopilot-dispatch-reference.md` § qa_target.

## Phases (one-line each — full prose lives in code)

- **Phase 0** — `bootstrap.sh "$@"` initialises `/tmp/hydra-autopilot-state.json` (slash args via `args-parse.sh`), then the **schema-version handshake** (see below) runs before any other phase
- **Phases 1 → 4 as one command** — `turn.sh events.json` (issue #4831): JSON Turn Snapshot → `turn_snapshot.py apply` (kv fallback: collect → `merge-signals.py`) → `term-check.py` → `decide.py` → `assert_invariants.py`, then the plan + usage summary. The per-phase lines below say what it runs.
- **Phase 1** — `turn-snapshot.ts --format json` emits the typed Turn Snapshot (ADR-0043 slice 6, #4934); `collect-state.sh` emits the legacy signal counts only as the per-turn fallback
- **Phase 1.5** — `recover-stale.sh stale_in_progress <N...> stale_blocked <M...>`
- **Phase 2** — `reap.py` hard-cap sweep (idempotent; #395)
- **Phase 3** — `decide.py decide state.json cands.json events.json` returns the plan (`events.json` = typed-event list; the `{"events": [...]}` wrapper is tolerated; a malformed file yields a plan carrying `events-malformed-ignored`, never a crash — #4213)
- **Phase 4** — `assert_invariants.py plan.json state.json`
- **Phase 5** — model executes each action via the table above
- **Phase 6** — cycle-record write (#430) + sleep until next event or 15-min heartbeat

> **CONTEXT POINTER:** full Phase 6 implementation contracts (cycle-record write, register handoff on auto-merge, token-surrogate write) live in `hydra-autopilot-phase6-ops.md` (sibling of this SKILL.md).

- **Phase 7** — `drain.sh <merged_prs>` (always) + `hydra-digest` dispatch for cause in `{budget, quota, wall_clock, idle, failure_backstop}` (`quota` is issue #3867's spend cap — a genuine run boundary, same as `budget`). SKIPPED when cause is `context_compaction` (issue #3787, periodic restart not a run boundary) — dispatching a costed digest every ~8-turn restart would multiply that cost and fragment the summary. The restart only sheds context if the SESSION ends: an unattended session never re-bootstraps in place (issue #4825).

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

## Termination

`decide.py` emits a `terminate` action when the token budget, wall-clock limit, idle-drain turns, or failure backstop trips, when the **quota-percent budget** trips (`quota`, issue #3867 — see below), when the turn count reaches the periodic session-restart cadence (`context_compaction`, issue #3787 — default every 8 Autopilot Turns via `state.limits.context_compaction_turns`, cuts the parent session's own prompt-cache re-read cost), or when the turn is wait-only with zero occupied slots (handoff baton-pass). Full termination conditions and the handoff baton-pass contract (issue #1903) are in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

> **CONTEXT POINTER:** the quota-percent budget (what it measures, its two knobs, baseline capture, window-reset handling) and the workless-board backoff stamped on an idle exit live in `hydra-autopilot-operator-guide.md` § Termination limits (sibling of this SKILL.md).

## Worktree-guard preamble (REQUIRED for code-writing dispatches)

There are TWO variants of this preamble, and the plan action's `isolation`
field decides which one a dispatch carries (issues #4178, #4476). For every
dispatch whose action carries `isolation: "worktree"` (launched with harness
`isolation="worktree"` — `dev_orch`, `qa_orch`, the read-only Target classes,
and the rest) the **default variant** below applies unchanged. For every
dispatch whose action carries `isolation: "self"` (see the self-isolated-class
carve-out below), the **self-isolation variant** **replaces the default block
entirely — never compose both**: the default's `cwd == /home/gabe/hydra →
ABORT` line and a launch without `isolation="worktree"` (so cwd IS
`/home/gabe/hydra`) are mutually exclusive gates, and a compliant subagent
handed both aborted at its first tool call 100% of the time (run 84b070ff;
third confirmed recurrence 6320c46f, 2026-08-31; ~46k tokens per occurrence,
zero deliverable). The invariant that actually binds a self-isolated class is
*never mutate either main checkout*, not *your cwd must be a worktree* — the
variant asserts the former.

`scripts/autopilot/render-dispatch.py` reads the fenced blocks in this section
(and the self-isolation fragment's) at render time and places exactly one guard
block and exactly one forbidden-ending block in every dispatch prompt (issue
#4833) — edit the fence here and every rendered prompt follows; never paste a
block by hand.

Default variant — every harness-worktree-isolated code-writing class:

```
## CRITICAL SAFETY RULE — READ FIRST
Run `pwd` and `git rev-parse --git-dir` first.
- Worktree path AND `.git/worktrees/...` gitdir → proceed.
- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT.
No fallback. No `git checkout` in the main tree.
```

Self-isolation variant — REPLACES the block above for every `isolation: "self"`
dispatch (prepend the fenced CRITICAL SAFETY RULE block from this shared
fragment; the create+verify block it points at is the same one
hydra-target-build Step 0.6 runs):

@include _fragments/target-self-isolation-preamble.md

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

**`dev_target` dispatches carry their OWN forbidden-ending preamble variant
(issue #4196) — ADDITIVE to the self-isolation worktree-guard variant above,
never a replacement for it.** Append verbatim, immediately after the
self-isolation worktree-guard variant, for every `dev_target` dispatch (the
other self-isolated classes carry no delegated-mode child, so this variant is
`dev_target`-only). Unlike the `dev_orch` block above, this variant does NOT
ban the Agent tool outright: `hydra-target-build` must spawn a delegated
build child (issue #1782). What it forbids is going quiet while that child is
still running:

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

**The self-isolated-class carve-out.** Which classes are `self` is data, not
prose: read `action.isolation`, which `decide.py` stamps on every dispatch
from its `TARGET_ISOLATION` policy. A `self` class creates and verifies its
own Target worktree before its first Target mutation and carries the
self-isolation variant above — never the default block. The per-class verdict
table and the reason harness isolation cannot cover the Target repo are in
`hydra-autopilot-dispatch-reference.md` § Self-isolated classes (sibling of
this SKILL.md).

**`qa_orch` dispatches carry their OWN forbidden-ending preamble variant
(issue #4272) — the hazard-scoped rewrite, not the `dev_orch` flat ban above.**
`hydra-qa` step 7's reviewer fan-out needs blocking (`run_in_background:
false`) Agent spawns, which cannot outlive the turn. Under the flat ban a
`qa_orch` dispatch skipped that fan-out and reviewed both axes inline.

Append verbatim, immediately after the worktree-guard preamble above, for
every `qa_orch` dispatch — REPLACING the `dev_orch` block above, never
composed with it and never with the `dev_target` forbidden-ending variant either:

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

> **CONTEXT POINTER:** the incidents behind each preamble block and variant, and the companion PreToolUse write-fence, are in `hydra-autopilot-dispatch-reference.md` § Preamble rationale (sibling of this SKILL.md). Read it before proposing a change to any block above.

## Inspecting a run

`bash scripts/autopilot/status.sh` prints the heartbeat with a wedge verdict,
the compact state and the log tail. The individual probes, the per-turn
heartbeat format and the wedge decision rule are in
`hydra-autopilot-operator-guide.md` § Inspecting a run (sibling of this
SKILL.md).

## Invocation

The skill runs as `/hydra-autopilot`, launched by the operator or by the Pace
Gate (`hydra-pace-gate.timer`, ADR-0021) — a usage-paced admission
controller, not a fixed schedule. Both paths obey the same token and
wall-clock budgets. Slash-args and env overrides, the Pace Gate's admission
rules and install steps, and the two stop levers are in
`hydra-autopilot-operator-guide.md` § Invocation (sibling of this SKILL.md).

## Slot lifecycle events (issue #509)

Subagent slot accounting is event-driven: `SubagentStop` and `Notification` hooks XADD events onto `hydra:autopilot:slot-events`; `collect-state.sh` drains it each turn; `decide.py` translates `subagent_stop` events into completions and appends failures to `state.failure_log`. A silent-wedge wall-clock fallback (`subagent_max_wall_seconds=3600`) covers hook failures. Full event schema, turn-consumption detail, env overrides, and best-effort guarantees are in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

> **CONTEXT POINTER:** the Signal wiring table — every `collect-state.sh` output, the `state.signals` key `merge-signals.py` promotes it to, and the class it drives, one row per `Rule` — lives in `hydra-autopilot-signal-wiring.md` § Signal wiring (sibling of this SKILL.md). The session never executes that table (`turn.sh` runs `merge-signals.py`, issues #4829/#4831); read a row only when a signal's meaning, producer or consumer is in question. The parity check (`scripts/ci/signal-parity-check.ts`, enforced in `test/decide-signal-classes.test.mts`) keeps the table, `collect-state.sh`, `merge-signals.py` and `decide.py` in step.

> **CONTEXT POINTER:** troubleshooting quick-look (wrong dispatch, burned class, wedge, stale heartbeat), cross-run Redis mirror, termination baton-pass detail, slot lifecycle event schema + env overrides, and merge-rate stabilization history (2026-05 → 2026-06) live in `hydra-autopilot-ops-reference.md` (sibling of this SKILL.md).

## Self-filed work — the admission rule (operator directive 2026-08-19)

**When you discover a defect in Hydra's own machinery, you file it as `hitl-grill`, never as `ready-for-agent`.**

You may file freely — noticing defects is valuable and nothing here discourages it.
What you may NOT do is promote your own finding into the dispatch queue. Only the
operator moves an issue from `hitl-grill` to `ready-for-agent`. The `/work` inbox
and the `/hydra-hitl-grill` skill are where they do it (`/hydra-review` ignores the lane).

Applies to every issue you file about the orchestrator itself: autopilot loop bugs,
CI/test-harness defects, gate false-positives, dashboard faults, cost-accounting
gaps, drainer routing, watchdog behaviour. It applies whether the defect surfaced
from a reaped dispatch, a failed check, your own tick, or a subagent's report.

Three carve-outs, all narrow:

1. **`needs-triage` for a wedge** — the stale-heartbeat recovery path keeps filing
   `needs-triage` with the run-log tail. Unchanged.
2. **hydra-grill's gate-fail handoff, posted on the anchor issue** — a `## hydra-grill
   handoff` comment plus the `ready-for-human` label (ADR-0034 §8.1) is a design-concept
   escalation on the anchor issue itself, not an issue you are promoting. Unchanged.
3. **Runaway-subagent issues (#395)** — a hard-cap breach is an incident, not a
   proposal. Unchanged.

Target-scope work is unaffected: `dev_target` anchors come from the Target board,
which you do not author.

Why this rule exists — the measured churn it cut — is in
`hydra-autopilot-operator-guide.md` § The admission rule (sibling of this
SKILL.md). Read it before proposing to relax the rule.

## Safety rules

1. NEVER modify `~/hydra` or `~/hydra-betting` working trees directly.
2. Worktree-guard preamble is mandatory for every code-writing dispatch — the default variant for `dev_orch` and every other class whose plan action carries `isolation: "worktree"`, the self-isolation variant (`_fragments/target-self-isolation-preamble.md`) for every class whose action carries `isolation: "self"` (never the default: its cwd-ABORT clause false-aborts a class launched without `isolation="worktree"`, issues #4178/#4476).
3. One subagent per pipeline slot.
4. Token budget is a hard cap; subagent caps (#395) bound a single misbehaving subagent.
5. `hydra-architect` is operator-only.
6. Phase 7 is the only path to the end-of-run digest (idempotent shutdown).
7. Self-filed orchestrator defects are filed `hitl-grill`, never `ready-for-agent` — see the admission rule above. Only the operator promotes.
8. The forbidden-ending preamble (issue #3866) is class-selected, exactly one block per code-writing dispatch: `dev_orch` gets the flat Agent-tool ban, `qa_orch` gets the blocking-fan-out variant (issue #4272), `dev_target` gets the delegated-mode variant (issue #4196) — never two of these composed on the same dispatch.
