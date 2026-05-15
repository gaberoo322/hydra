---
name: hydra-autopilot
description: Event-driven autonomous decision loop. A single Claude Code session orchestrates Hydra work via decide.py — the L2 decision brain — and executes typed action plans. Token-budgeted; designed to run unattended for ~8 hours (e.g., overnight).
when_to_use: "When the user wants autonomous overnight operation, says 'autopilot', 'run overnight', 'autonomous mode', or wants a single skill to manage all hydra operations."
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
claude_only: true
---

# Hydra Autopilot

Event-driven autonomous decision loop. The model is a thin Agent-tool-caller;
the policy lives in `scripts/autopilot/decide.py` (the **L2 decision brain**).

**Authoritative references — read these instead of this playbook when you
need to know what the autopilot will do:**

- Decision logic: `scripts/autopilot/decide.py` (the `decide()` function and
  its docstring own the policy)
- Merge policy: `decide.py:should_auto_merge.__doc__`
- Failure self-heal table: `scripts/autopilot/self_heal.py` docstring
- Runtime invariants: `scripts/autopilot/assert_invariants.py` (INV-001..INV-008)
- Architecture rationale: [ADR-0007](../adr/0007-decision-brain-orchestration.md)

## Loop

Each tick:

1. **Wake** on TaskNotification, Monitor board-change, or a 15-min heartbeat.
2. **Collect** state + candidates + events into three JSON blobs.
3. **`python3 scripts/autopilot/decide.py decide state.json candidates.json events.json`** — pure function call, returns `{actions, reasons, debug}`.
4. **`python3 scripts/autopilot/assert_invariants.py plan.json state.json`** — runtime guards.
5. **Execute** each action in the plan via the right tool (table below).
6. **Re-enter step 1.** No inline reasoning between steps.

## Class taxonomy (6 pipeline slots + 5 signal classes)

| Kind | Class | Skill |
|---|---|---|
| pipeline | `dev_orch` | hydra-dev |
| pipeline | `qa_orch` | hydra-qa |
| pipeline | `research_orch` | hydra-research / hydra-issue-research |
| pipeline | `dev_target` | hydra-target-build |
| pipeline | `qa_target` | hydra-qa (target scope) |
| pipeline | `research_target` | hydra-target-research |
| signal | `health` | hydra-doctor (scope-agnostic) |
| signal | `sweep_orch` | hydra-sweep |
| signal | `sweep_target` | hydra-target-sweep |
| signal | `discover_orch` | hydra-discover |
| signal | `discover_target` | hydra-target-discover |

Pipeline slots: at most one subagent per slot in flight. Signal classes
track only their last-fired timestamp under `signal_last_fired` — no
slot semantics, just cooldowns. The scope filter (`limits.scope`) is an
**exclusion mask** (`orch-only` / `target-only` / `all`); `health` is
the only scope-agnostic class. See `decide.py:scope_excluded()` and
INV-008.

## Action-to-tool table

| Action type | Tool the model invokes |
|---|---|
| `dispatch` | `Agent(run_in_background=True, isolation="worktree", ...)` |
| `auto-merge` | `Bash` → `gh pr review --approve && gh pr merge --auto --squash` |
| `apply-operator-approved` | `Bash` → `gh pr edit --add-label operator-approved` |
| `update-branch` | `Bash` → `gh pr update-branch` |
| `queue-decision` | `Bash` → `./scripts/autopilot/queue-decision.sh ...` |
| `reap` | `Bash` → `./scripts/autopilot/reap.py completion ...` |
| `terminate` | `Bash` → `./scripts/autopilot/drain.sh <merged_prs>` → Phase 7 |
| `wait` | sleep N; re-enter loop |
| `wait-for-api` | `curl --retry`; re-enter loop |

## Phases (one-line each — full prose lives in code)

- **Phase 0** — `bootstrap.sh "$@"` initialises `/tmp/hydra-autopilot-state.json` (slash args via `args-parse.sh`)
- **Phase 1** — `collect-state.sh` emits signal counts (~100ms)
- **Phase 1.5** — `recover-stale.sh stale_in_progress <N...> stale_blocked <M...>`
- **Phase 2** — `reap.py` hard-cap sweep (idempotent; #395)
- **Phase 3** — `decide.py decide state.json cands.json events.json` returns the plan
- **Phase 4** — `assert_invariants.py plan.json state.json`
- **Phase 5** — model executes each action via the table above
- **Phase 6** — sleep until next event or 15-min heartbeat
- **Phase 7** — `drain.sh <merged_prs>` + final `hydra-digest` dispatch

## Termination

`decide.py` emits a single `terminate` action when any of these trip:

1. `cumulative_tokens >= limits.token_budget`
2. `elapsed >= limits.wall_clock_max_sec`
3. `idle_turns >= limits.idle_drain_turns` AND all slots empty
4. 5 consecutive failures of the same pattern (failure backstop; see `self_heal.py`)

## Worktree-guard preamble (REQUIRED for code-writing dispatches)

```
## CRITICAL SAFETY RULE — READ FIRST
Run `pwd` and `git rev-parse --git-dir` first.
- Worktree path AND `.git/worktrees/...` gitdir → proceed.
- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT.
No fallback. No `git checkout` in the main tree.
```

## Inspecting a run

- Heartbeat: `cat /tmp/hydra-autopilot-heartbeat.txt`
- Live state: `jq '.slots,.signal_last_fired,.burned_classes' /tmp/hydra-autopilot-state.json`
- Run log: `tail -100 /tmp/hydra-autopilot-nightly.log`
- Last decision plan: `jq . /tmp/hydra-autopilot-plan.json`
- Failure ledger: `tail /tmp/hydra-autopilot-failures.jsonl`

## Manual invocation

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

## Where to look when something goes wrong

- Wrong dispatch for a class → `decide.py:_select_for_slot` / `_select_for_signal`
- Tier-0 non-mechanical PR merged anyway → INV-001 violation; run log
- Burned class still got dispatched → INV-003; `burned_classes` in `state.json`
- Failure pattern keeps retrying → `self_heal.py` + `state.failure_log` + Phase 3 backstop
- A subagent in flight wedged → Phase 2 reap or `subagent-hard-max-tokens`

## Safety rules

1. NEVER modify `~/hydra` or `~/hydra-betting` working trees directly.
2. Worktree-guard preamble is mandatory for `dev_orch` / `dev_target`.
3. One subagent per pipeline slot.
4. Token budget is a hard cap; subagent caps (#395) bound a single misbehaving subagent.
5. `hydra-architect` is operator-only.
6. Phase 7 is the only path to the morning digest (idempotent shutdown).
