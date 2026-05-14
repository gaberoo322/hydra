---
name: hydra-autopilot
description: Long-running autonomous decision loop. A single Claude Code session orchestrates Hydra work through parallel-across-class background subagents. Token-budgeted; designed to run unattended for ~8 hours (e.g., overnight).
when_to_use: "When the user wants autonomous overnight operation, says 'autopilot', 'run overnight', 'autonomous mode', or wants a single skill to manage all hydra operations."
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
claude_only: true
---

# Hydra Autopilot

Long-running autonomous decision loop. Replaces the previous `/loop`-based iteration model. A single Claude Code session orchestrates Hydra work end-to-end by dispatching background subagents, one per class, in parallel.

Designed to be invoked once per overnight window (typically `claude -p "/hydra-autopilot"` from `hydra-autopilot.timer` at 22:00) and run to completion. Three independent termination conditions:

1. **Token budget** — `cumulative_subagent_tokens >= 2,000,000`
2. **Wall-clock cap** — elapsed time `>= 8h`
3. **Idle drain** — all class slots empty AND nothing eligible for ≥ 5 consecutive decision turns

Whichever fires first triggers Phase 7 (graceful drain + final digest).

The deterministic shell / python plumbing for each phase lives in `scripts/autopilot/`. This playbook owns the decision logic; the scripts own the heredocs. **When you edit a phase, edit the script — not the snippet here.**

## Class taxonomy

Work is partitioned into 10 classes. At most one subagent per class is in flight at a time; multiple classes run in parallel. Theoretical max concurrency = 10, but cooldowns + priority gates keep typical concurrency at 2–4.

| Class | Skills | Code-writing? | Notes |
|---|---|---|---|
| `health` | hydra-doctor | No | Mostly read-only; can fix quick wins inline |
| `qa` | hydra-qa | No | Reviews target PRs |
| `dev_orch` | hydra-dev | Yes | Orchestrator-side feature work; requires worktree-guard |
| `dev_target` | hydra-target-build | Yes | Claude-side replacement for Codex cycles; requires worktree-guard |
| `research_orch` | hydra-research, hydra-issue-research | No | Subject to research_orch cooldown |
| `research_target` | hydra-target-research | No | Subject to research_target cooldown |
| `sweep_orch` | hydra-sweep | No | Board management; idempotent |
| `sweep_target` | hydra-target-sweep | No | Target board management; idempotent |
| `discover_orch` | hydra-discover | No | Patrol; produces issues |
| `discover_target` | hydra-target-discover | No | Runtime diagnostics on target |

**Inline operations** (not class-scoped, run in main thread):

- `hydra scheduler start` / `hydra scheduler stop` (P0.5 pipeline recovery)
- `hydra research start` (P3 research-cycle trigger — separate from `research_orch` / `research_target` classes)
- `hydra raw POST /capacity/orchestrator-merge` (post-merge capacity-ledger writeback — see `scripts/autopilot/dispatch.sh capacity-writeback`)
- Stale-label fixes (Phase 1.5)

The Codex cycle trigger (`hydra cycle start`, previously P5) has been **removed**. The orchestrator's own scheduler continues to tick Codex cycles until Codex is fully retired; the autopilot no longer kicks it.

## Architecture

```
Single Claude Code session, internal decision loop:

  Phase 0:  bootstrap (heartbeat, run log, read budget)        scripts/autopilot/bootstrap.sh
  Phase 1:  collect state (parallel, counts only)              scripts/autopilot/collect-state.sh
  Phase 1.5: auto-recover stale issues                         scripts/autopilot/recover-stale.sh
  Phase 2:  reap completed subagents, sum token usage          scripts/autopilot/reap.py (+ playbook prose)
  Phase 3:  termination check (budget? clock? idle?)           scripts/autopilot/term-check.py
              → if terminating, jump to Phase 7
  Phase 4:  priority waterfall (per class slot, parallel decisions)
  Phase 5:  dispatch eligible work (Agent run_in_background)   scripts/autopilot/dispatch.sh
  Phase 6:  brief turn report
              → 5s pause, back to Phase 1

  Phase 7:  drain in-flight subagents (graceful), then         scripts/autopilot/drain.sh
            final hydra-digest dispatch, then exit
```

## Phase 0: Bootstrap

Run once at session start.

```bash
./scripts/autopilot/bootstrap.sh
```

The script:
1. Initializes `/tmp/hydra-autopilot-heartbeat.txt`.
2. Rotates the run log: `/tmp/hydra-autopilot-nightly.log` → `.prev`, truncates the live file.
3. Resolves budget knobs from env vars (`HYDRA_AUTOPILOT_TOKEN_BUDGET`, `_MAX_SEC`, `_IDLE_TURNS`, `_SUBAGENT_MAX_TOKENS`, `_SUBAGENT_HARD_MAX_TOKENS`, `_SCOPE`) with hardcoded defaults.
4. Validates soft cap ≤ hard cap (FATAL exit on violation, issue #395).
5. Validates `_SCOPE` is one of `all | orch-only | target-only` (FATAL exit otherwise).
6. Writes the authoritative `/tmp/hydra-autopilot-state.json` with `limits` as a first-class block, all 10 class slots set to `null`, and counters at zero.

**The budget limits in `state.json`'s `"limits"` block are authoritative** — shell variables don't persist between turns, and the model cannot remember a budget value it only saw printed once. Every subsequent termination check (`term-check.py`) reads from `state.json`, not from env.

After Phase 0, treat `/tmp/hydra-autopilot-state.json` as the only source of truth for budget / scope. Do not invent or rely on remembered defaults.

**Required preflight** before entering the decision loop:

1. Verify `pwd` is `/home/gabe/hydra`. Abort otherwise.
2. Verify orchestrator health: `curl -sf http://localhost:4000/api/health` returns 200. If not, dispatch `hydra-doctor` once as the first action, then proceed.
3. Confirm Hydra scheduler state (we do NOT start/stop it from here unless P0.5 fires).

## Phase 1: Collect state (parallel, counts only — never dump raw responses)

```bash
./scripts/autopilot/collect-state.sh
```

Emits one line per signal: `health`, `failed_services`, board counts (`needs_qa`, `ready_for_agent`, `needs_triage`, `needs_research`, `in_progress`, `blocked`, `stale_in_progress`, `stale_blocked`), `active_dev_orch` (open PR on a hydra-dev branch updated within 90 min — drives the `dev_orch` gate, see issue #412), `work_queue`, `reframe_queue`, `prior_failures`, capacity-floor state, scheduler / cycle state, and recommendation count.

Run every decision turn (cheap: ~100ms total).

## Phase 1.5: Auto-recover stale issues

```bash
./scripts/autopilot/recover-stale.sh stale_in_progress <N1> <N2> ... stale_blocked <M1> <M2> ...
```

Pass the lists Phase 1 emitted. Either list may be empty. The script:

- For each stale in-progress (>90 min): removes `in-progress`, adds `ready-for-agent`, posts a comment.
- For each stale blocked (>12h): re-checks that ALL blockers referenced in the body are closed; if so, removes `blocked` and adds `ready-for-agent`.

Single-issue failures are logged and skipped — one bad issue doesn't strand the whole turn. If labels changed, re-read the board on the next turn.

## Phase 2: Reap completed subagents + accounting

Phase 2 has **two distinct concerns** — completion reaps (which require the Claude harness to read TaskNotifications) and in-flight hard-cap enforcement (pure state-file math). The latter is extracted into `scripts/autopilot/reap.py`; the former stays in playbook prose.

**Step 1 — In-flight hard-cap enforcement (issue #395)** — run first, every turn, before the completion-reap loop:

```bash
./scripts/autopilot/reap.py
```

For each occupied slot whose harness exposed `partial_tokens >= limits.subagent_hard_max_tokens`: clear the slot, append the class to `burned_classes` (suppresses re-dispatch this session), and file a `needs-triage` issue documenting the runaway. The script is idempotent. If the harness has no partial-token signal for a class, the hard cap only catches the slot at completion (still bounded by `wall_clock_max_sec`).

**Step 2 — Completion reap (playbook decision logic).** For each class slot in `state.json` that has an entry, the Claude turn:

1. Checks whether the background Agent dispatch has produced its TaskNotification.
2. If completed, route the result through the **idempotent completion reap** (issue #411). The TaskNotification carries a `task_id`; the same notification can fire multiple times (observed: task `a153eb193e1b05209` fired three completion notifications hours apart for `hydra-qa` on PR #402). Without dedup the tokens would be triple-counted. Invoke:

   ```bash
   ./scripts/autopilot/reap.py completion <class> <task_id> <total_tokens> <skill>
   ```

   The script:
   - Checks `state.reaped_task_ids` for `<task_id>`. If present, emits `dup_skip task_id=<X>` to the run log and exits without any token accounting, slot mutation, or `burned_classes` mutation.
   - Otherwise: appends `<task_id>` to `reaped_task_ids` (FIFO-bounded to the most-recent 1000 entries), adds `<total_tokens>` to `cumulative_tokens`, records `slots[<class>].tokens = <total_tokens>` (for the turn-report and digest; see Phase 6), runs the **soft-cap check** — if `<total_tokens> >= limits.subagent_max_tokens` it appends `<class>` to `burned_classes` (Phase 4 must refuse to dispatch into a class in this list for the rest of the session) — and clears the slot (`slots[<class>] = null`). One `slot_complete` line is appended to `/tmp/hydra-autopilot-nightly.log`.

   **Post-dispatch sanity check (code-writing classes only):** before invoking the reap subcommand, the Claude turn verifies `git -C ~/hydra rev-parse --abbrev-ref HEAD == master`. If not, log `isolation_breach=<branch>` and surface it in the turn report. Do NOT auto-`checkout master`.

3. Updates `dispatches` counter. Increments `idle_turns` if NO new dispatch this turn AND no class slot still occupied; otherwise resets `idle_turns = 0`.

## Phase 3: Termination check

Run this script at the top of every decision turn:

```bash
./scripts/autopilot/term-check.py
```

Reads `state.json` and prints one of:

- `OK ...` → proceed to Phase 4
- `TERM:budget ...` → token budget exhausted; jump to Phase 7
- `TERM:wall_clock ...` → wall-clock cap exceeded; jump to Phase 7
- `TERM:idle ...` → idle-drain reached with all slots empty; jump to Phase 7

Do not read limit values from memory — always invoke the script.

## Phase 4: Priority waterfall (per class slot, parallel decisions)

### Phase 4.0: Capacity-floor preference (ADR-0003 vision-vector-2)

If `capacity_floor_met == false` AND `capacity_window >= 5`, **prefer filling `*_orch` slots first** this turn. Targets (`*_target`) are only considered after all eligible `*_orch` slots have been examined.

P0 (health) and P0.5 (pipeline recovery) always pre-empt this preference.

### Standard waterfall per class

**You MUST walk every class with a free slot on each turn — not just the first one or two that match.** The whole point of class-parallel dispatch is to fan out across multiple classes simultaneously. Stopping after the first match collapses the new design back to the old sequential `/loop` behaviour.

Iteration order (every turn, exactly once):

```
SCOPE = state.limits.scope  # "all" | "orch-only" | "target-only"
for class in [health, qa, dev_orch, dev_target, research_orch, research_target,
              sweep_orch, sweep_target, discover_orch, discover_target]:
    if SCOPE == "orch-only" and class.endswith("_target"): continue
    if SCOPE == "target-only" and class.endswith("_orch"):  continue
    # health and qa are scope-agnostic (qa reviews any PR, health is whole-system)
    if state.slots[class] is not None: continue          # slot busy
    if class in state.burned_classes: continue           # soft cap tripped (#395)
    if class on cooldown: continue
    if class circuit-broken this turn: continue
    eligible_skill = evaluate_priority(class, state)     # see per-class rules below
    if eligible_skill is None: continue
    dispatch(class, eligible_skill)                      # Phase 5
```

Apply the capacity-floor preference (Phase 4.0) by ordering `*_orch` classes before `*_target` in this iteration when the floor has fired.

Per-class eligibility rules (first match wins **for that class**):

#### `health`
- **P0**: `health=FAIL` OR `redis=false` OR `failed_services>0` → dispatch `hydra-doctor`
- **P0.5**: `stall=hard-stop` OR `scheduler=stopped` → first run inline pipeline recovery (`hydra scheduler start`), then dispatch `hydra-doctor` if root cause unclear

#### `qa`
- **P1**: `needs_qa > 0` → dispatch `hydra-qa <oldest>`

#### `dev_orch`
- **P2**: `ready_for_agent > 0` AND `active_dev_orch == 0` → dispatch `hydra-dev <highest-impact>`
- The gate is the live PR signal, **not** the `in-progress` label (issue #412). The label can go stale when an earlier dispatch died before producing a PR; Phase 1.5 (`stale_in_progress`) still re-queues those issues, but the dev_orch gate no longer waits on label cleanup.
- Worktree-guard preamble REQUIRED. Post-dispatch sanity check REQUIRED.

#### `dev_target`
- **P-dev-target**: `work_queue > 0` AND no Codex cycle currently mid-flight (`CODEX_IDLE`) → dispatch `hydra-target-build`
- Worktree-guard preamble REQUIRED. Post-dispatch sanity check REQUIRED.
- **Codex coexistence**: while Codex removal is in progress, the Codex-driven scheduler still ticks cycles. We gate dev_target on `CODEX_IDLE` to avoid both touching the target at once. The merge lock will catch any race, but this gate avoids the lock contention.

#### `research_orch`
- **P3.5**: `ready_for_agent == 0` AND research_orch cooldown elapsed → dispatch `hydra-research`
- **P7**: `needs_research > 0` AND research_orch cooldown elapsed → dispatch `hydra-issue-research <oldest>`

#### `research_target`
- **P-research-target**: target backlog signal weak (`work_queue + triage < 15`) AND research_target cooldown elapsed → dispatch `hydra-target-research`
- The previous inline P3 (`hydra research start`) may still be invoked as a non-class operation when this same condition fires AND no `research_target` is currently in flight. Inline takes precedence — if `hydra research start` ran this turn, skip the subagent dispatch.

#### `sweep_orch`
- **P4**: `needs_triage > 0` → dispatch `hydra-sweep`

#### `sweep_target`
- **P4.5**: `triage > 5` OR `reframe > 2` OR `prior_failures > 8` → dispatch `hydra-target-sweep`

#### `discover_orch`
- **P6**: `backlog >= 30` AND last 10 cycles >50% empty/failed → dispatch `hydra-discover`

#### `discover_target`
- **P9**: true idle (no other class produced a dispatch this turn) → dispatch `hydra-target-discover`

### Cooldowns (per class, written by the skill itself on dispatch start)

| Class | File | Cooldown |
|---|---|---|
| `research_orch` | `/tmp/hydra-last-research-orch.txt` | 3600s |
| `research_target` | `/tmp/hydra-last-research-target.txt` | 3600s |
| `discover_orch` | `/tmp/hydra-last-discover-orch.txt` | 1800s |
| `discover_target` | `/tmp/hydra-last-discover-target.txt` | 1800s |

**Do not pre-stamp cooldown files** — skills with internal rate-limiting own their own files and check on entry. Pre-stamping causes the skill to read its own pre-write and rate-limit itself into a no-op (observed 2026-05-09).

### Circuit breaker

Per class: if the same skill was dispatched 3+ times in the last 5 dispatches for that class AND board state for that class hasn't changed (compare to `/tmp/hydra-autopilot-prev-state.json`), skip this class this turn:

```
[autopilot] Circuit break: <skill> dispatched 3x without board progress.
```

## Phase 5: Dispatch

For each class that selected a skill in Phase 4:

1. Mark slot: `slots[<class>] = {"skill":"<S>","started":"<ts>","prompt_summary":"...","partial_tokens":0}`. The `partial_tokens` field is updated by the Phase 2 in-flight poll (issue #395) whenever the harness exposes a progress signal for the dispatched Agent; it defaults to 0 until the first poll observation lands.
2. Log the dispatch:

   ```bash
   ./scripts/autopilot/dispatch.sh log <class> <skill>
   ```

3. **Worktree-guard preamble (REQUIRED for `dev_orch` and `dev_target`):**

   ```
   ## CRITICAL SAFETY RULE — READ FIRST
   Run `pwd` and `git rev-parse --git-dir` first.
   - Worktree path AND `.git/worktrees/...` gitdir → proceed.
   - cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT with status:failed.
     Do not run any git commands. Do not check out master. Do not fall back.
   No fallback. No `git checkout` in the main tree.
   ```

4. Dispatch via `Agent` tool. The subagent does NOT have access to slash commands in its prompt — it must invoke skills via the `Skill` tool explicitly. Use `subagent_type: "general-purpose"` (which has access to all tools including `Skill`):

   ```
   Agent(
     description: "<class>:<skill>",
     subagent_type: "general-purpose",
     run_in_background: true,
     isolation: "worktree",    // REQUIRED for dev_orch and dev_target
     prompt: |
       <WORKTREE-GUARD PREAMBLE (if code-writing)>

       Invoke the Skill tool to run skill="<S>" with args="<ARGS>".
       Specifically: Skill(skill: "<S>", args: "<ARGS>")

       After the skill completes, return a one-paragraph summary of what
       it did, any errors, and any artifacts created (PR numbers, file
       paths, issue numbers, etc).
   )
   ```

   The harness will spin a fresh worktree for code-writing classes under `.claude/worktrees/agent-<id>` and return its path on completion. Slash-command invocation (`/<S>`) inside the prompt is NOT supported in subagent context — that's the `skill_denied` failure mode observed in early smoke tests.

   The autopilot session itself MUST be launched with `claude --dangerously-skip-permissions` (the systemd unit does this). Without that flag, headless `claude -p` denies tool calls that require confirmation, including `Skill` and `Bash` invocations the subagents make.

5. **Capacity-ledger writeback (post hydra-dev / hydra-target-build merges):**
   When `dev_orch` or `dev_target` completes AND it reports a merged PR, POST to the capacity ledger so the share is reflected:

   ```bash
   ./scripts/autopilot/dispatch.sh capacity-writeback <PR_NUMBER> <SHA> <SKILL> '<FILES_JSON>'
   ```

   Without this, the share reads as 0% and the capacity-floor preference fires every turn.

## Phase 6: Turn report + ACTIVE LOOP CONTINUATION

One line per decision turn appended to `/tmp/hydra-autopilot-nightly.log`:

```
[autopilot] <ts> | turn=<N> | active=[<class>:<skill>@<partial_tokens>,...] | tokens=<cum>/<budget> | burned=[<class>,...] | board: qa=N agent=N triage=N wq=N | dispatched=<N this turn>
```

Per-slot `partial_tokens` (when the harness exposes it) and the cumulative total appear in the active-slots field as `<skill>@<N>` so the operator can post-mortem token-burn rates from the run log alone. Once a slot completes, its final total is written as a `slot_complete` line (see Phase 2 step 2).

### CRITICAL: This is an ACTIVE loop, not a passive wait

After appending the turn report, run this Bash snippet and **immediately re-enter Phase 1**:

```bash
sleep 5
# Increment turn counter in state.json so the model knows how many turns have elapsed
python3 -c "
import json
s = json.load(open('/tmp/hydra-autopilot-state.json'))
s['turn'] = s.get('turn', 0) + 1
json.dump(s, open('/tmp/hydra-autopilot-state.json', 'w'))
print(f'turn={s[\"turn\"]}')
"
```

**You MUST re-enter Phase 1 after the sleep.** Do NOT passively wait for a background subagent's TaskNotification to arrive — those arrive asynchronously and the loop must continue polling state regardless. The whole point of the loop is to:

1. Re-collect state every 5–30s (`Phase 1`).
2. Reap any subagents that completed asynchronously (`Phase 2`).
3. Check termination conditions (`Phase 3`).
4. Make new dispatches into any free class slots (`Phases 4 + 5`).
5. Report (`Phase 6`).
6. Sleep 5s. Repeat.

If `Phase 4` produces no new dispatches AND all class slots are non-empty (every class busy), the loop still runs — its purpose is to detect completions and check termination, not to dispatch on every turn. Increment `idle_turns` only if no dispatch was made AND no slot was occupied this turn. Otherwise reset `idle_turns = 0`.

**Common failure mode to avoid:** "I dispatched two subagents on turn=1 and now I'm waiting for them to come back." This is wrong. After turn=1, sleep 5s, run Phase 1's bash collectors again, check termination, and either dispatch into freed slots or report turn=2. Never passively wait.

## Phase 7: Terminal (graceful drain + final digest)

1. **Stop accepting new dispatches.** Phase 4 returns nothing.
2. **Drain.** Wait for all in-flight class slots to finish, with a 30-min cap. Beyond that, accept that they continue running headlessly via TaskNotification; the autopilot exits without their token counts (they show up in the next run's accounting if applicable, otherwise lost).
3. **Final dispatch: `hydra-digest`** with prompt `"Generate an overnight summary for the operator. Cover: number of dispatches per class, token usage, merges shipped, incidents auto-resolved, alerts opened/closed, capacity-floor share movement, isolation breaches if any, and a 'next morning action items' bullet list. Source data: /tmp/hydra-autopilot-nightly.log."`
4. **Wait** up to 5 min for the digest to complete; capture its output.
5. **Final summary line** — run the drain helper with the merged-PR count tallied during the run:

   ```bash
   ./scripts/autopilot/drain.sh <MERGED_PR_COUNT>
   ```

   Emits the final line operators see in `journalctl --user -u hydra-autopilot.service`:

   ```
   [autopilot] FINAL | duration=<HH:MM> | dispatches=<N> | tokens=<cum>/<budget> | merged_PRs=<N> | digest=/tmp/hydra-autopilot-nightly.log
   ```

6. Exit cleanly.

## Safety rules

1. **NEVER modify `~/hydra` or `~/hydra-betting` working tree directly.** All code writes happen in isolated worktrees via the Agent tool.
2. **Worktree-guard preamble is mandatory** for `dev_orch` and `dev_target` dispatches. The subagent must ABORT if it lands in a main tree — no fallback.
3. **One subagent per class.** Multiple classes run in parallel; never two `dev_orch` at once.
4. **Token budget is a hard cap.** Stop at 2M cumulative reported tokens. Do not exceed.
   - **Per-subagent caps (issue #395):** `subagent_max_tokens` (default 400k) suppresses re-dispatch into a class that has overspent in this session; `subagent_hard_max_tokens` (default 800k) abandons an in-flight slot and files a `needs-triage` issue. Soft must be `<=` hard. The point is to bound the blast radius of a single misbehaving subagent — without this, one looping `hydra-dev` BG can burn the whole 2M before Phase 3 trips. Caps are inert until tripped; a well-behaved 8h run uses none of this mechanism.
5. **Cooldowns are per-class and skill-owned.** Do not pre-stamp from autopilot.
6. **Circuit breaker is per-class.** 3 same-skill dispatches in 5 without board progress → skip that class.
7. **`hydra-architect` is operator-only.** Never auto-dispatch.
8. **Capacity-floor preference is SOFT.** P0 / P0.5 always pre-empt. The share recovers naturally.
9. **No Codex cycle triggers.** The `hydra cycle start` op is removed from this skill. The orchestrator's scheduler still ticks Codex on its own.
10. **Idempotent shutdown.** Phase 7 must run regardless of how termination is reached (budget, clock, idle). It is the only path to the morning digest.
11. **Scope is enforced at dispatch time, not at skill time.** Once a subagent is in flight when scope changes (operator edits `state.json` mid-run), let it finish. New dispatches respect the latest scope. `health` and `qa` are scope-agnostic — they always run regardless of scope.

## Operator interface

### Manual invocation (development / debugging)
```bash
claude --dangerously-skip-permissions -p "/hydra-autopilot"

# Custom budget for a short smoke test (env vars are honoured via state.json):
HYDRA_AUTOPILOT_TOKEN_BUDGET=100000 \
HYDRA_AUTOPILOT_MAX_SEC=600 \
  claude --dangerously-skip-permissions -p "/hydra-autopilot"

# Only do orchestrator-side work this run:
HYDRA_AUTOPILOT_SCOPE=orch-only claude --dangerously-skip-permissions -p "/hydra-autopilot"

# Only do target-side work this run (e.g. orchestrator merge freeze):
HYDRA_AUTOPILOT_SCOPE=target-only claude --dangerously-skip-permissions -p "/hydra-autopilot"

# Default: do everything (equivalent to omitting HYDRA_AUTOPILOT_SCOPE):
HYDRA_AUTOPILOT_SCOPE=all claude --dangerously-skip-permissions -p "/hydra-autopilot"

# Tighten per-subagent caps for a debugging session where the operator
# is watching for runaways (issue #395). Defaults are 400k soft / 800k hard.
HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS=200000 \
HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS=300000 \
  claude --dangerously-skip-permissions -p "/hydra-autopilot"
```

The `--dangerously-skip-permissions` flag is REQUIRED. Headless `claude -p` denies all confirmation-required tool calls by default; without skip-permissions, the subagents the autopilot dispatches return `skill_denied` and Phase 2 reaps them as immediate failures.

#### Slash-arg form (interactive Claude sessions)

When invoking `/hydra-autopilot` from inside a Claude session, the same knobs are exposed as `--key=value` slash args. Args win over env vars (explicit overrides implicit), so a one-off slash invocation can override a systemd-defined `Environment=` line without editing the unit file. Unknown args (e.g. trailing free-form tokens like `focus=codex-cli-removal`) emit a `[autopilot] WARN: unknown arg ...` line but are otherwise ignored — they survive in the run log as conversational context for the model.

| Slash arg | Alias | Env equivalent |
|---|---|---|
| `--scope=<v>` | — | `HYDRA_AUTOPILOT_SCOPE` |
| `--tokens=<N>` | `--token-budget=<N>` | `HYDRA_AUTOPILOT_TOKEN_BUDGET` |
| `--max-sec=<N>` | `--max-seconds=<N>` | `HYDRA_AUTOPILOT_MAX_SEC` |
| `--idle-turns=<N>` | — | `HYDRA_AUTOPILOT_IDLE_TURNS` |
| `--subagent-soft=<N>` | — | `HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS` |
| `--subagent-hard=<N>` | — | `HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS` |

Examples:
```text
/hydra-autopilot --scope=orch-only
/hydra-autopilot --tokens=500000 --max-sec=3600
/hydra-autopilot --scope=target-only focus=codex-cli-removal   # focus= is logged but ignored
```

### Scheduled invocation
The provided systemd unit pair (`scripts/systemd/hydra-autopilot.{service,timer}`) fires `claude -p "/hydra-autopilot"` nightly at 22:00 local time. The service is `Type=oneshot` with `RuntimeMaxSec=32400` (9h) — slightly above the default wall-clock cap to allow Phase 7 drain. Failure handler routes to the existing `hydra-notify-failure@.service` template.

To make a scope restriction stick across nightly runs, add an `Environment=` line to the systemd service unit:

```ini
# scripts/systemd/hydra-autopilot.service
[Service]
Environment=HYDRA_AUTOPILOT_SCOPE=orch-only
```

The operator updates this manually (systemd unit changes are out of scope for autopilot itself).

### Inspecting a run
- Heartbeat: `cat /tmp/hydra-autopilot-heartbeat.txt`
- Live state: `cat /tmp/hydra-autopilot-state.json`
- Run log: `cat /tmp/hydra-autopilot-nightly.log`
- Previous run: `cat /tmp/hydra-autopilot-nightly.log.prev`
- Final morning artifact: the `hydra-digest` output is appended to the same log; tail it (`tail -100 /tmp/hydra-autopilot-nightly.log`) to see the summary first thing.
