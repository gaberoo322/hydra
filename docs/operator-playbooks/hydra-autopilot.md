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
- `hydra raw POST /capacity/orchestrator-merge` (post-merge capacity-ledger writeback)
- Stale-label fixes (Phase 1.5)

The Codex cycle trigger (`hydra cycle start`, previously P5) has been **removed**. The orchestrator's own scheduler continues to tick Codex cycles until Codex is fully retired; the autopilot no longer kicks it.

## Architecture

```
Single Claude Code session, internal decision loop:

  Phase 0:  bootstrap (heartbeat, run log, read budget)
  Phase 1:  collect state (parallel, counts only)
  Phase 1.5: auto-recover stale issues
  Phase 2:  reap completed subagents, sum token usage
  Phase 3:  termination check (budget? clock? idle?)
              → if terminating, jump to Phase 7
  Phase 4:  priority waterfall (per class slot, parallel decisions)
  Phase 5:  dispatch eligible work (Agent run_in_background per class)
  Phase 6:  brief turn report
              → 5s pause, back to Phase 1

  Phase 7:  drain in-flight subagents (graceful), then final hydra-digest dispatch, then exit
```

## Phase 0: Bootstrap

Run once at session start. **The budget limits resolved here MUST be written into `state.json`'s `"limits"` block** — shell variables don't persist between turns, and the model cannot remember a budget value it only saw printed once. Every subsequent termination check reads from `state.json`, not from env.

```bash
# Heartbeat
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) start pid=$$ run_id=$(uuidgen)" > /tmp/hydra-autopilot-heartbeat.txt

# Run log (overwrites previous run; previous-run content rotated to .prev)
[ -f /tmp/hydra-autopilot-nightly.log ] && mv /tmp/hydra-autopilot-nightly.log /tmp/hydra-autopilot-nightly.log.prev
: > /tmp/hydra-autopilot-nightly.log

# Resolve budget knobs from env (per-run override) with hardcoded defaults
TOKEN_BUDGET="${HYDRA_AUTOPILOT_TOKEN_BUDGET:-2000000}"
WALL_CLOCK_MAX_SEC="${HYDRA_AUTOPILOT_MAX_SEC:-28800}"   # 8h
IDLE_DRAIN_TURNS="${HYDRA_AUTOPILOT_IDLE_TURNS:-5}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date -u +%s)"

# Initialize state file — limits are now first-class members
cat > /tmp/hydra-autopilot-state.json <<EOF
{
  "started": "${STARTED_AT}",
  "started_epoch": ${STARTED_EPOCH},
  "limits": {
    "token_budget": ${TOKEN_BUDGET},
    "wall_clock_max_sec": ${WALL_CLOCK_MAX_SEC},
    "idle_drain_turns": ${IDLE_DRAIN_TURNS}
  },
  "cumulative_tokens": 0,
  "dispatches": 0,
  "idle_turns": 0,
  "turn": 0,
  "slots": {
    "health": null, "qa": null,
    "dev_orch": null, "dev_target": null,
    "research_orch": null, "research_target": null,
    "sweep_orch": null, "sweep_target": null,
    "discover_orch": null, "discover_target": null
  }
}
EOF

# Echo resolved limits so the model captures them in conversation context
echo "[autopilot] limits resolved: token_budget=${TOKEN_BUDGET} wall_clock_max_sec=${WALL_CLOCK_MAX_SEC} idle_drain_turns=${IDLE_DRAIN_TURNS}"
```

After Phase 0, the model MUST treat `/tmp/hydra-autopilot-state.json` as the authoritative budget source. Do not invent or rely on remembered defaults.

**Required preflight** before entering the decision loop:

1. Verify `pwd` is `/home/gabe/hydra`. Abort otherwise.
2. Verify orchestrator health: `curl -sf http://localhost:4000/api/health` returns 200. If not, dispatch `hydra-doctor` once as the first action, then proceed.
3. Confirm Hydra scheduler state (we do NOT start/stop it from here unless P0.5 fires).

## Phase 1: Collect state (parallel, counts only — never dump raw responses)

Same collectors as the previous iteration-loop version. Run on every decision turn (cheap: ~100ms total).

```bash
# health
hydra health 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print(f'health={d[\"status\"]} redis={d[\"redis\"]}')
except: print('health=FAIL')"

# failed services
echo -n "failed_services="; systemctl --user list-units --type=service --state=failed --no-legend 2>/dev/null | grep -c hydra || echo 0

# orchestrator-side issue board (counts + stale lists)
gh issue list --repo gaberoo322/hydra --state open --json number,labels,updatedAt --jq '{
  needs_qa: [.[] | select(.labels | map(.name) | index("needs-qa"))] | length,
  ready_for_agent: [.[] | select(.labels | map(.name) | index("ready-for-agent"))] | length,
  needs_triage: [.[] | select(.labels | map(.name) | index("needs-triage"))] | length,
  needs_research: [.[] | select(.labels | map(.name) | index("needs-research"))] | length,
  in_progress: [.[] | select(.labels | map(.name) | index("in-progress"))] | length,
  blocked: [.[] | select(.labels | map(.name) | index("blocked"))] | length,
  stale_in_progress: [.[] | select((.labels | map(.name) | index("in-progress")) and ((now - (.updatedAt | fromdateiso8601)) > 5400))] | map(.number),
  stale_blocked: [.[] | select((.labels | map(.name) | index("blocked")) and ((now - (.updatedAt | fromdateiso8601)) > 43200))] | map(.number)
}'

# backlog + queues
hydra raw GET /backlog/counts 2>/dev/null || hydra backlog ls | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(json.dumps({l: len(d.get(l,[])) for l in ['queued','inProgress','blocked','triage']}))"
echo -n "work_queue="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue 2>/dev/null || echo 0
echo -n "reframe_queue="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:reframe-queue 2>/dev/null || echo 0
echo -n "prior_failures="; docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:prior-failures 2>/dev/null || echo 0

# capacity-floor (orchestrator self-improvement share)
hydra raw GET /capacity 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin); o=d['orchestrator']
  print(f'capacity_orch_share={o[\"share\"]:.2f} capacity_floor_met={d[\"floorMet\"]} capacity_window={o[\"window\"]}')
except: print('capacity_floor_met=true capacity_window=0')"

# scheduler / cycle
hydra cycle status 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin); print('CODEX_ACTIVE' if d.get('running') else 'CODEX_IDLE')
except: print('CODEX_IDLE')"
hydra scheduler status 2>/dev/null | python3 -c "
import json,sys
try:
  d=json.load(sys.stdin)
  s=d.get('state','?'); nm=d.get('consecutiveNonMerges',0)
  stall='ok' if nm<5 else ('hard-stop' if nm>=8 else 'alert')
  print(f'scheduler={s} nonmerges={nm} stall={stall}')
except: print('scheduler=unknown stall=unknown')"

# recommendations
hydra recommendations 2>/dev/null | python3 -c "
import json,sys
try:
  items=json.load(sys.stdin)
  if items: print(f'recommendations={len(items)}: {items[0].get(\"action\",\"?\")[:60]}')
  else: print('recommendations=0')
except: print('recommendations=unavailable')"
```

## Phase 1.5: Auto-recover stale issues

**Stale in-progress (>90 min, orchestrator board):**
```bash
for ISSUE in <stale_in_progress>; do
  gh issue edit $ISSUE --repo gaberoo322/hydra --remove-label in-progress --add-label ready-for-agent
  gh issue comment $ISSUE --repo gaberoo322/hydra --body "> *Autopilot:* Re-queued. >90 min idle in in-progress."
done
```

**Stale blocked (>12h, blockers closed):**
```bash
for ISSUE in <stale_blocked>; do
  BLOCKERS=$(gh issue view $ISSUE --repo gaberoo322/hydra --json body --jq '.body' | grep -oP '(?<=#)\d+' | head -20)
  ALL_CLOSED=true
  for b in $BLOCKERS; do
    STATE=$(gh issue view $b --repo gaberoo322/hydra --json state --jq '.state' 2>/dev/null)
    [ "$STATE" != "CLOSED" ] && ALL_CLOSED=false && break
  done
  [ "$ALL_CLOSED" = true ] && gh issue edit $ISSUE --repo gaberoo322/hydra --remove-label blocked --add-label ready-for-agent
done
```

If labels changed, re-read board on the next turn.

## Phase 2: Reap completed subagents + accounting

For each class slot in `/tmp/hydra-autopilot-state.json` that has an entry:

1. Check whether the background Agent dispatch has produced its task notification (TaskNotification fires on completion; the dispatching session sees it as a completed agent result).
2. If completed:
   - Read the agent's reported `total_tokens` from its result block, add to `cumulative_tokens`
   - **Post-dispatch sanity check (code-writing classes only)**: verify `git -C ~/hydra rev-parse --abbrev-ref HEAD == master`. If not, log `isolation_breach=<branch>` and surface in turn report. Do NOT auto-`checkout master`.
   - Append the dispatch result to `/tmp/hydra-autopilot-nightly.log` (one line: skill, duration, tokens, exit-state, result-summary-first-line)
   - Clear the slot (`slots[class] = null`)

Update `dispatches` counter. Increment `idle_turns` if NO new dispatch this turn AND no class slot still occupied; otherwise reset `idle_turns = 0`.

## Phase 3: Termination check

**Run this Bash snippet at the top of every decision turn.** Do not rely on remembering limit values across turns — read them from `state.json`.

```bash
python3 - <<'PY'
import json, time, os, sys
s = json.load(open('/tmp/hydra-autopilot-state.json'))
limits = s['limits']
elapsed = int(time.time()) - s['started_epoch']
tokens = s['cumulative_tokens']
slots_occupied = sum(1 for v in s['slots'].values() if v is not None)

if tokens >= limits['token_budget']:
    print(f"TERM:budget tokens={tokens}/{limits['token_budget']} elapsed={elapsed}s")
elif elapsed >= limits['wall_clock_max_sec']:
    print(f"TERM:wall_clock elapsed={elapsed}s/{limits['wall_clock_max_sec']}s tokens={tokens}")
elif s['idle_turns'] >= limits['idle_drain_turns'] and slots_occupied == 0:
    print(f"TERM:idle idle_turns={s['idle_turns']} slots=0")
else:
    print(f"OK elapsed={elapsed}s tokens={tokens}/{limits['token_budget']} idle={s['idle_turns']}/{limits['idle_drain_turns']} slots={slots_occupied}")
PY
```

If the output starts with `TERM:`, jump immediately to **Phase 7** (terminal drain + digest). Do not enter Phase 4. If it starts with `OK`, proceed to Phase 4.

## Phase 4: Priority waterfall (per class slot, parallel decisions)

### Phase 4.0: Capacity-floor preference (ADR-0003 vision-vector-2)

If `capacity_floor_met == false` AND `capacity_window >= 5`, **prefer filling `*_orch` slots first** this turn. Targets (`*_target`) are only considered after all eligible `*_orch` slots have been examined.

P0 (health) and P0.5 (pipeline recovery) always pre-empt this preference.

### Standard waterfall per class

**You MUST walk every class with a free slot on each turn — not just the first one or two that match.** The whole point of class-parallel dispatch is to fan out across multiple classes simultaneously. Stopping after the first match collapses the new design back to the old sequential `/loop` behaviour.

Iteration order (every turn, exactly once):

```
for class in [health, qa, dev_orch, dev_target, research_orch, research_target,
              sweep_orch, sweep_target, discover_orch, discover_target]:
    if state.slots[class] is not None: continue          # slot busy
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
- **P2**: `ready_for_agent > 0` AND `in_progress == 0` → dispatch `hydra-dev <highest-impact>`
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

1. Mark slot: `slots[<class>] = {"skill":"<S>","started":"<ts>","prompt_summary":"..."}`
2. Log: `dispatch <class> <skill> <ts>` appended to `/tmp/hydra-autopilot-nightly.log`
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

5. **Capacity-ledger writeback (post hydra-dev/hydra-target-build merges):**
   When `dev_orch` or `dev_target` completes AND it reports a merged PR, POST to the capacity ledger so the share is reflected:

   ```bash
   hydra raw POST /capacity/orchestrator-merge --json '{
     "cycleId": "pr-<PR_NUMBER>",
     "commitSha": "<sha>",
     "filesChanged": ["src/foo.ts","..."],
     "source": "<skill>"
   }'
   ```

   Without this, the share reads as 0% and the capacity-floor preference fires every turn.

## Phase 6: Turn report + ACTIVE LOOP CONTINUATION

One line per decision turn appended to `/tmp/hydra-autopilot-nightly.log`:

```
[autopilot] <ts> | turn=<N> | active=[<class>:<skill>,...] | tokens=<cum>/<budget> | board: qa=N agent=N triage=N wq=N | dispatched=<N this turn>
```

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
5. **Final summary line printed to stdout** (this is what the operator sees in journalctl):
   ```
   [autopilot] FINAL | duration=<HH:MM> | dispatches=<N> | tokens=<cum>/<budget> | merged_PRs=<N> | digest=/tmp/hydra-autopilot-nightly.log
   ```
6. Exit cleanly.

## Safety rules

1. **NEVER modify `~/hydra` or `~/hydra-betting` working tree directly.** All code writes happen in isolated worktrees via the Agent tool.
2. **Worktree-guard preamble is mandatory** for `dev_orch` and `dev_target` dispatches. The subagent must ABORT if it lands in a main tree — no fallback.
3. **One subagent per class.** Multiple classes run in parallel; never two `dev_orch` at once.
4. **Token budget is a hard cap.** Stop at 2M cumulative reported tokens. Do not exceed.
5. **Cooldowns are per-class and skill-owned.** Do not pre-stamp from autopilot.
6. **Circuit breaker is per-class.** 3 same-skill dispatches in 5 without board progress → skip that class.
7. **`hydra-architect` is operator-only.** Never auto-dispatch.
8. **Capacity-floor preference is SOFT.** P0 / P0.5 always pre-empt. The share recovers naturally.
9. **No Codex cycle triggers.** The `hydra cycle start` op is removed from this skill. The orchestrator's scheduler still ticks Codex on its own.
10. **Idempotent shutdown.** Phase 7 must run regardless of how termination is reached (budget, clock, idle). It is the only path to the morning digest.

## Operator interface

### Manual invocation (development / debugging)
```bash
claude --dangerously-skip-permissions -p "/hydra-autopilot"

# Custom budget for a short smoke test (env vars are honoured via state.json):
HYDRA_AUTOPILOT_TOKEN_BUDGET=100000 \
HYDRA_AUTOPILOT_MAX_SEC=600 \
  claude --dangerously-skip-permissions -p "/hydra-autopilot"
```

The `--dangerously-skip-permissions` flag is REQUIRED. Headless `claude -p` denies all confirmation-required tool calls by default; without skip-permissions, the subagents the autopilot dispatches return `skill_denied` and Phase 2 reaps them as immediate failures.

### Scheduled invocation
The provided systemd unit pair (`scripts/systemd/hydra-autopilot.{service,timer}`) fires `claude -p "/hydra-autopilot"` nightly at 22:00 local time. The service is `Type=oneshot` with `RuntimeMaxSec=32400` (9h) — slightly above the default wall-clock cap to allow Phase 7 drain. Failure handler routes to the existing `hydra-notify-failure@.service` template.

### Inspecting a run
- Heartbeat: `cat /tmp/hydra-autopilot-heartbeat.txt`
- Live state: `cat /tmp/hydra-autopilot-state.json`
- Run log: `cat /tmp/hydra-autopilot-nightly.log`
- Previous run: `cat /tmp/hydra-autopilot-nightly.log.prev`
- Final morning artifact: the `hydra-digest` output is appended to the same log; tail it (`tail -100 /tmp/hydra-autopilot-nightly.log`) to see the summary first thing.
