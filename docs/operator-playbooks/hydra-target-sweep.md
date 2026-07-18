---
name: hydra-target-sweep
description: Autonomous target project board processor. Scans the GitHub-Issues board on gaberoo322/hydra-betting (needs-triage / blocked / reframe / in-progress) and advances items that can be progressed without operator input.
when_to_use: "When the user says 'sweep target', 'process backlog', 'advance target items', or wants to clean up the target project work queue. Also dispatched by hydra-autopilot."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
---

# Hydra Target Sweep

Autonomous board processor for `~/hydra-betting` work tracked as **GitHub Issues on `gaberoo322/hydra-betting`** (ADR-0031). Advances items without operator judgment, escalates the rest.

Under ADR-0031 the Target board **is** the GitHub-Issues board on the Target repo — the Redis lanes / reframe-queue / prior-failures lists are retired. The lane↔label mapping the sweep works over:

| Old Redis lane / list | GitHub-Issues board state (`gaberoo322/hydra-betting`) |
|-----------------------|--------------------------------------------------------|
| `triage`              | open issue labelled `needs-triage` |
| `queued`              | open issue labelled `ready-for-agent` |
| `inProgress`          | open issue labelled `in-progress` |
| `blocked`             | open issue labelled `blocked` |
| `reframe-queue`       | open issue labelled `reframe` (+ `ready-for-human` for the operator drain) |
| `done`               | **closed** issue |

**Hard read constraint (ADR-0031 Decision 6).** Board reads on the hot path use **REST** (`gh api repos/...`), never `gh --json` / GraphQL — the GraphQL pool is saturated by the running Orchestrator loop, and the money-critical Target loop must draw from the separate, ~100×-headroom REST pool. Every board read below uses `gh api repos/gaberoo322/hydra-betting/issues`. All writes are `gh issue edit` / `gh issue close` / `gh issue comment` on the same repo — never the retired `hydra backlog` / `/backlog` API or `docker exec redis-cli`.

## Context management

On `/loop`, run `/compact` (Claude) / restart context (Codex) at the START of each iteration.

## Process

### 1. Collect state

Read each board state via REST (labels are the lanes). `gh api` paginates with `--paginate`; the `--jq` projection keeps the payload small.

```bash
REPO=gaberoo322/hydra-betting
for lane in needs-triage ready-for-agent in-progress blocked reframe; do
  echo "== $lane =="
  gh api --paginate "repos/$REPO/issues?state=open&labels=$lane&per_page=100" \
    --jq '.[] | select(has("pull_request")|not) | "  [#\(.number)] \(.title[0:70])"' 2>/dev/null | head -5
done

# Recent merged titles (completed-detection input) — REST, never gh --json.
echo "== recently merged =="
gh api --paginate "repos/$REPO/pulls?state=closed&per_page=50" \
  --jq '.[] | select(.merged_at != null) | .title' 2>/dev/null | head -20
```

### 2. Process triage lane (`needs-triage` issues)

For each open `needs-triage` issue:
1. **Already completed?** → compare title to recent merged titles. If done: close it —
   `gh issue close $NUM --repo $REPO --reason completed --comment "Already shipped (merged-title overlap) — closing."`
2. **Well-described?** = specific title (names file/function/behavior) + a body with context.
3. **Auto-promote** well-described → relabel to `ready-for-agent`:
   `gh issue edit $NUM --repo $REPO --remove-label needs-triage --add-label ready-for-agent`
4. **Flag vague** items — log for operator (leave `needs-triage`), don't block sweep.

### 3. Process blocked lane (`blocked` issues)

For each open `blocked` issue:
1. Read the blocker reason from the issue body / `blocked-by #N` reference.
2. Blocker issue now closed → unblock: `gh issue edit $NUM --repo $REPO --remove-label blocked --add-label ready-for-agent`
3. External dependency (vendor / operator) → leave, log.
4. Stale reason (>7 days, `updated_at`) → log for operator review.
5. Work was done by a different issue / cycle → close as completed with a pointer comment.

### 4. Process reframe queue (`reframe` issues)

Each `reframe`-labelled issue carries the reframe context in its body (reason, prior retry count — no separate Redis JSON blob):
1. Underlying issue fixed by a recent merge (title overlap) → close as completed:
   `gh issue close $NUM --repo $REPO --reason completed --comment "Reframe resolved by merge — closing."`
2. Still failing — is the failure reason actionable without operator input?
   - "No code changes produced" → too vague. Leave `reframe` + `ready-for-human` for the operator.
   - "Verification failed" → narrow the scope and re-queue by editing the issue title/body to the narrowed reference, then relabel to `ready-for-agent`:
     `gh issue edit $NUM --repo $REPO --title "<narrowed title>" --remove-label reframe --remove-label ready-for-human --add-label ready-for-agent`
     (append a body note: `Reframed after <N> failures: <specific narrowing>`.)
   - "Scope gate blocked" → too broad. Leave for operator (`reframe` + `ready-for-human`).
   - "Regression" → fragile area. Leave for operator.

### 5. Stall-detection (`in-progress` >90 min)

Detect issues that claimed an `in-progress` slot but stopped making progress. Use the issue's `updated_at` (the closest board analogue of the retired `movedAt`) as the staleness clock; the `in-progress` label was stamped at claim time (Step 2 of `hydra-target-build`).

```bash
REPO=gaberoo322/hydra-betting
gh api --paginate "repos/$REPO/issues?state=open&labels=in-progress&per_page=100" \
  --jq '.[] | select(has("pull_request")|not) | "\(.number)\t\(.updated_at)\t\(.title[0:60])"' 2>/dev/null \
| python3 -c "
import sys,datetime
now=datetime.datetime.now(datetime.timezone.utc)
cutoff_min=90
for line in sys.stdin:
    parts=line.rstrip('\n').split('\t')
    if len(parts)<3: continue
    num,updated,title=parts[0],parts[1],parts[2]
    try:
        ut=datetime.datetime.fromisoformat(updated.replace('Z','+00:00'))
    except Exception:
        continue
    age_min=(now-ut).total_seconds()/60
    if age_min>cutoff_min:
        print(f'{num}\t{int(age_min)}min\t{title}')
"
```

For each row printed (number, age, title):

1. **Before recovering, confirm no open PR is driving it** — an `in-progress` issue with a live PR citing `Closes #NUM` is progressing, not stalled. Skip it if a matching open PR exists:
   `gh api "repos/$REPO/pulls?state=open&per_page=100" --jq '.[] | select(.body | test("[Cc]loses #'"$NUM"'\\b")) | .number'`
2. Auto-recover a truly-stalled issue: strip the claim so it's pickable again —
   `gh issue edit $NUM --repo $REPO --remove-label in-progress --add-label ready-for-agent`
3. Log the action under "Stall recoveries" with number, age, and reason `stalled-90min`.
4. If the same issue shows up here on consecutive sweeps, flag it for operator attention — repeated stalls usually mean a structural blocker, not a transient agent crash.

The 90-minute version gives operators a fast feedback signal when the WIP slots silently fill up.

### 6. (retired) Prior-failures list

The Redis `hydra:anchors:prior-failures` list is retired with the substrate migration (ADR-0031). Recurring-failure signal now lives on the issue itself — a reframed issue carries its retry history in its body, and the enforced `Closes #N` close-discipline plus the merged-title overlap check (Step 2/4) is what removes work already shipped. No separate prior-failures sweep is needed.

### 7. Detect completed board items

Scan all open board labels for issues whose title matches recent merged PR titles (Step 1's merged-title list). Close completed → `gh issue close $NUM --repo $REPO --reason completed --comment "Shipped (merged-title overlap) — closing."` This is the residual guard for work that landed without a `Closes #N` linkage; enforced `Closes #N` close-discipline (ADR-0031 Decision 5) is the durable path.

### 8. Report

```
## Target Sweep — <date>

### Triage: <before> → <after>
- Promoted: N to queued
- Completed: N (already done)
- Flagged: N (vague, need operator)

### Blocked: <before> → <after>
- Unblocked: N
- Still blocked: N

### Reframe: <before> → <after>
- Cleared: N (work already done — closed)
- Re-queued: N (narrowed scope → ready-for-agent)
- Needs operator: N (left reframe + ready-for-human)

### Stall recoveries (>90 min in-progress)
- Recovered: N (in-progress → ready-for-agent)
- Repeat offenders: N (flagged for operator)

### Operator actions needed
- <list>
```

## Rules

- Never **delete** board issues — close as completed or leave open. (Closing is the `done` transition; there is no destructive delete.)
- Never rewrite an issue body wholesale — relabel to move board state; only append a scope-narrowing note when re-queuing a `reframe` item.
- Re-queuing reframe items: always narrow the scope in the title/reference.
- Log every action for the report.
- Unsure if completed → leave it open. False negatives are safer than false positives (the documented merged/shipped false-positive polarity: positive title-overlap evidence only, never absence-of-a-ref).
- **REST-only reads (ADR-0031 Decision 6).** Every board read uses `gh api repos/gaberoo322/hydra-betting/issues`; never `gh --json` / GraphQL on the hot path.
- **Vocabulary.** When narrowing a reframe item or promoting a triage item, name it using the target's canonical vocabulary — `~/hydra-betting/CONTEXT-MAP.md` and the per-context `CONTEXT.md` files. Don't invent synonyms; if the noun you need isn't in the glossary, leave the item for the operator instead of inventing language. The per-context layout is documented in `~/hydra-betting/docs/agents/domain.md`.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
