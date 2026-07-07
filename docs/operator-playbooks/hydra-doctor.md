---
name: hydra-doctor
description: Comprehensive Hydra system health check that diagnoses the orchestrator, services, cycles, backlog, and infrastructure, then applies fixes.
when_to_use: "When the user wants a health check, asks what's wrong, says 'fix hydra', or wants to know the system status"
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [focus]
---

# Hydra Doctor

Comprehensive health check of the Hydra autonomous orchestrator. You have full conversation context — use it.

**Default behavior: diagnose AND fix.** Always apply quick wins unless the operator says "no fix" or "diagnose only".

If the operator provided a focus area (`$focus`), weight your analysis toward that.

> Prefer `bin/hydra` over raw curl where commands exist. Fall back to `hydra raw GET <path>` for endpoints not yet wrapped.

## Phase 1: Collect (run in parallel)

### Core Health
```bash
hydra health
hydra scheduler status
# External access — checks Cloudflare tunnel + public reachability
curl -s -o /dev/null -w "External: %{http_code}\n" https://admin.clawstreetbets.xyz/api/health
```

### Deployed-build drift (issue #2663)
```bash
# Compares the SHA the RUNNING orchestrator reports it is deployed from
# (/api/health.deployedSha) against origin/master HEAD, after a bounded
# `git fetch`. Closes the 2026-07-02 blind spot where prod ran ~30h-stale
# code (POST /api/holdback/pending 404'd) while the doctor said "uptime 22h,
# status ok" — the doctor had no deployed-build-vs-master drift check.
#
# Read-only: the fetch updates only origin/* remote-tracking refs — it NEVER
# checks out, pulls, or mutates the working tree. Fail-safe: an unreachable
# API, detached origin, or git error degrades to an `unknown` verdict and
# exits 0 (the check never makes the doctor itself "fail"). `--alert` pushes
# a critical alert into hydra:alerts ONLY on SUSTAINED drift (past the grace
# window) — a deploy caught mid-flight reads as `settling`, not an alarm.
#
# The verdict is the load-bearing line:
#   in-sync  — deployed == origin/master. Healthy.
#   settling — drift younger than the grace window (~15m). A deploy is
#              likely mid-flight; re-check next run, don't act yet.
#   drift    — deployed != origin/master past the grace window. LOUD: prod
#              is running STALE code. Deploy-on-merge did NOT restart the
#              service. If a `probable cause: ... dirty tree` note is shown,
#              a spurious tracked modification (e.g. docker/ov.conf) tripped
#              deploy.sh's dirty-tree guard — reset/commit it first.
#   unknown  — a SHA couldn't be resolved (service down / detached origin).
#              Information-only.
cd ~/hydra && npx tsx scripts/deploy-drift-check.ts --text --alert 2>/dev/null \
  || echo "deploy-drift check unavailable"
```
A `drift` verdict is the durable backstop for the "prod is stale but health
says ok" failure mode (`reference_deploy_concurrency_cancels_master`): the
per-2-min `hydra-watchdog.sh` DEPLOY DRIFT block (#734) may already be
converging prod automatically, but its journald WARN is invisible to a
`hydra doctor` reader — this line renders the same drift as an explicit
doctor finding. **Fix (Phase 3):** run `scripts/deploy.sh` from the
`~/hydra` master checkout (rebuilds dashboard + restarts the service); if a
dirty-tree cause is shown, `git reset`/commit the tracked change first so
deploy.sh's guard doesn't re-abort.

### Cycle Performance (last 20 metrics — richer than cycle/history)
```bash
hydra metrics --count 20 | python3 -c "
import json,sys
d=json.load(sys.stdin)
trend=d.get('trend',d.get('metrics',[]))
if not trend: print('No metrics'); sys.exit()
merged=sum(1 for m in trend if int(m.get('tasksMerged',0))>0)
failed=sum(1 for m in trend if int(m.get('tasksFailed',0))>0)
rolled=sum(1 for m in trend if m.get('rolledBack')=='true' or m.get('rolledBack')==True)
abandoned=sum(1 for m in trend if int(m.get('tasksAbandoned',0))>0)
durations=[int(m.get('totalDurationMs',0)) for m in trend if int(m.get('totalDurationMs',0))>0]
tests=[int(m.get('testsAfter',0)) for m in trend if int(m.get('testsAfter',0))>0]
fixes=sum(1 for m in trend if m.get('anchorType') in ('prior-failure','failing-test') and int(m.get('tasksMerged',0))>0)
feats=merged-fixes
print(f'Cycles: {len(trend)} | Merged: {merged} | Failed: {failed} | Rolled back: {rolled} | Abandoned: {abandoned}')
print(f'Merge rate: {100*merged//max(len(trend),1)}%')
if durations: print(f'Cycle time: avg {sum(durations)//len(durations)//1000}s, max {max(durations)//1000}s')
if tests: print(f'Tests: {tests[-1]} -> {tests[0]} (latest)')
print(f'Fix:Feat ratio: {fixes}:{feats}')
for m in trend[:5]:
    status='merged' if int(m.get('tasksMerged',0))>0 else 'failed' if int(m.get('tasksFailed',0))>0 else 'abandoned'
    print(f'  [{status}] {m.get(\"taskTitle\",\"?\")[:65]}')
"
```

### Backlog
```bash
hydra backlog ls | python3 -c "
import json,sys,subprocess
d=json.load(sys.stdin)
for lane in ['queued','inProgress','blocked','triage']:
    items=d.get(lane,[])
    if items:
        print(f'{lane}: {len(items)} items')
        for i in items[:3]: print(f'  [P{i.get(\"priority\",0)}] {i[\"id\"]} — {i[\"title\"][:60]}')
r=subprocess.run(['docker','exec','hydra-redis-1','redis-cli','LLEN','hydra:anchors:work-queue'],capture_output=True,text=True)
if r.returncode==0:
    n=int(r.stdout.strip() or 0)
    if n: print(f'work-queue (Redis): {n} items')
"
```

### Alerts
```bash
hydra alerts ls --limit 20 | python3 -c "
import json,sys
alerts=json.load(sys.stdin)
if not alerts: print('No alerts'); sys.exit()
active=[a for a in alerts if not a.get('dismissed')]
if not active: print('No active alerts'); sys.exit()
print(f'{len(active)} active alerts:')
for a in active[:10]:
    ts=a.get('timestamp','?')[:16]
    sev=a.get('severity','?')
    print(f'  [{sev}] {ts} — {a.get(\"message\",\"?\")[:90]}')
"
```

### Tool currency (issue #480)
```bash
# Compares installed CLI tools against upstream latest and surfaces drift.
# Read-only — never auto-upgrades. Network failures produce `unknown`
# verdicts and never crash the doctor. The script also pushes a
# warning-level alert into `hydra:alerts` for any `outdated` tool when
# `--alert` is passed, so the next `hydra alerts ls` will show it.
#
# Background: the 2026-05-15 incident where Ubuntu's apt-shipped `gh
# 2.45.0` was ~47 versions behind upstream and `gh pr edit --add-label`
# silently no-op'd, wedging autopilot. A passive currency check catches
# this class of failure before the next cycle runs.
cd ~/hydra && npx tsx scripts/tool-currency-check.ts --table --alert 2>/dev/null \
  || echo "tool-currency check unavailable"
```

### Services
```bash
systemctl --user list-units --type=service --state=running,failed 2>/dev/null | grep hydra
systemctl --user list-units --type=service --state=failed   2>/dev/null | grep hydra
```

### Git & Working Tree
```bash
cd ~/hydra-betting && git status --short | head -10
cd ~/hydra-betting && git log --oneline --since="6 hours ago" | head -10
```

### Errors (last hour)
```bash
journalctl --user -u hydra-orchestrator.service --no-pager --since "1 hour ago" 2>&1 \
  | grep -iE "error|fail|reject|crash|fatal" | grep -v "DeprecationWarning" | tail -10
```

### Agent Memory
```bash
# Memory is consolidated JSON in :patterns (Redis string), NOT :rules.
# Per CLAUDE.md learning system: "Consolidated patterns in hydra:memory:{agent}:patterns"
for agent in planner executor skeptic; do
  bytes=$(docker exec hydra-redis-1 redis-cli STRLEN "hydra:memory:${agent}:patterns" 2>/dev/null || echo 0)
  if [ "$bytes" -gt 0 ]; then
    docker exec hydra-redis-1 redis-cli GET "hydra:memory:${agent}:patterns" 2>/dev/null \
      | python3 -c "
import json,sys
try:
  arr=json.loads(sys.stdin.read())
  total_hits=sum(p.get('hitCount',0) for p in arr)
  cats={}
  for p in arr: cats[p.get('category','?')]=cats.get(p.get('category','?'),0)+p.get('hitCount',0)
  top=sorted(cats.items(),key=lambda x:-x[1])[:3]
  last_seen=max((p.get('lastSeen','') for p in arr), default='-')
  print(f'$agent: {len(arr)} patterns, {total_hits} total hits, last_seen={last_seen}, top={top}')
except Exception as e: print(f'$agent: parse error ({e})')
"
  else
    echo "$agent: 0 patterns (learning may be broken — investigate)"
  fi
done
```

### Infrastructure
```bash
df -h / /mnt/hydra-ssd 2>/dev/null | tail -2
docker exec hydra-redis-1 redis-cli INFO memory 2>/dev/null | grep "used_memory_human"
docker exec hydra-redis-1 redis-cli DBSIZE 2>/dev/null
```

### OpenViking embedding backend reachability (issue #1781)
```bash
# The dense-embedding backend (post-#1795: local CPU Ollama, compose service
# ollama-embed) is on OpenViking's HOT search path — a query must be embedded
# before the vector lookup. The VLM backend (gabes-desktop-1 over Tailnet) is a
# SOFT dependency used only for indexing. Both hostnames resolve ONLY inside the
# OV container (compose network + extra_hosts), so probe from INSIDE the
# container with docker exec — a host-side connect cannot reach them.
#
# FIRST distinguish "backend down" from "container never created" (issue #1812):
# a missing ollama-embed container (vs a running-but-unhealthy one) means the
# stack was brought up targeting a subset of services and the depends_on chain
# never pulled ollama-embed in. The fix differs — re-create it (Phase 3), don't
# chase a model-pull / network fault. `docker compose ps` lists only created
# services; an empty match == the #1812 missing-service failure mode.
echo -n "ollama-embed container present: "
if [ -n "$(cd ~/hydra && docker compose ps -q ollama-embed 2>/dev/null)" ]; then
  cd ~/hydra && docker compose ps ollama-embed --format '{{.Name}} {{.Status}}' 2>/dev/null
else
  echo "MISSING (not created — issue #1812; re-create with 'docker compose up -d', see Phase 3)"
fi
echo -n "ollama-embed (dense, HOT path): "
docker exec hydra-openviking-1 curl -m5 -s -o /dev/null -w "%{http_code}\n" \
  http://ollama-embed:11434/api/tags 2>/dev/null || echo "UNREACHABLE"
echo -n "gabes-desktop-1 (VLM, indexing only): "
docker exec hydra-openviking-1 curl -m5 -s -o /dev/null -w "%{http_code}\n" \
  http://gabes-desktop-1:11434/api/tags 2>/dev/null || echo "UNREACHABLE (soft — indexing degrades, search still works)"
# Cross-check the orchestrator's own classification of this hop:
curl -s http://localhost:4000/api/health/deep 2>/dev/null \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('  ovSearch.status =', d.get('intelligence',{}).get('ovSearch',{}).get('status'))" 2>/dev/null \
  || echo "  (deep-health unreachable)"
```
An `ovSearch.status` of `backend-unreachable` (vs `failed`=OV-5xx, `timeout`=slow,
`running`=ok) is the #1781 signal that the dense-embedding backend, not
OpenViking itself, is the broken hop. `searchKnowledge()` degrades gracefully to
empty results (never throws), so this is a quality-degradation warning, not a
cycle-blocking fault — see the OpenViking embedding/VLM backend split section in
docs/reference.md.

If the `ollama-embed container present` line reports **MISSING** (issue #1812),
the dense backend is unreachable because the service was never created — not
because the model pull or the network failed. Re-create it with a full stack
bring-up: `cd ~/hydra && docker compose up -d` (no service arg pulls the whole
depends_on chain, including ollama-embed). It reports healthy once the model
pull lands (~120s start-period grace; first boot downloads nomic-embed-text,
~270MB). The persistent guard against re-recurrence is the bring-up contract
comment in docker-compose.yml — always bring the stack up with a bare
`docker compose up -d`, never targeting a single non-openviking service.

### Database Health (deep)
```bash
cd ~/hydra && docker compose ps postgres --format '{{.Name}} {{.Status}}' 2>/dev/null
docker exec hydra-postgres-1 psql -U hydra -d hydra -t -c "
  SELECT 'last_ingest: ' || COALESCE(max(started_at)::text, 'NEVER')
  FROM sportsbook_ingestion_runs;" 2>/dev/null
docker exec hydra-postgres-1 psql -U hydra -d hydra -t -c "
  SELECT 'market_snapshots: ' || count(*) FROM market_snapshots
  UNION ALL SELECT 'ingestion_runs: ' || count(*) FROM sportsbook_ingestion_runs
  UNION ALL SELECT 'reconciliation: ' || count(*) FROM wager_reconciliation_checkpoints;" 2>/dev/null
docker exec hydra-postgres-1 psql -U hydra -d hydra -t -c "
  SELECT 'pg_connections: ' || count(*) || '/' || current_setting('max_connections')
  FROM pg_stat_activity;" 2>/dev/null
```

### Kill-chain wiring-ledger soft SLO (dead-code kill-chain epic #2720)
```bash
# SOFT SLO — surfaced-only, NEVER CI-blocking. Flags any module that has sat
# wire-or-retire on the Target's committed ledger for >30 days past the 45-day
# grace window WITHOUT a wire-or-retire verdict — i.e. a stale decision the
# /hydra-wire-or-retire resolver (or the operator) has left unresolved. This is
# an observability nudge, not a gate: staleness must never punish an unrelated
# PR, so the check lives here, not in ci.yml.
#
# Read-only: parses the COMMITTED docs/agents/wiring-status.md; never regenerates
# it (regeneration is a Target-side `npm run deadcode:ledger` concern). A missing
# ledger degrades to a `quiet (ledger absent)` verdict and exits 0 — the check
# never makes the doctor itself fail. The verdict line is load-bearing:
#   quiet  — no wire-or-retire module >30d past grace (or ledger absent). Healthy.
#   flag   — one or more wire-or-retire modules are >30d past grace without a
#            verdict. Surface in the report; steer /hydra-wire-or-retire, do NOT
#            block anything.
python3 - "$HOME/hydra-betting/docs/agents/wiring-status.md" <<'PY'
import sys, os, re, datetime
ledger_path = sys.argv[1]
GRACE_DAYS, SLO_DAYS = 45, 30
today = datetime.date.today()
if not os.path.exists(ledger_path):
    print("kill-chain soft-SLO: quiet (ledger absent)")
    sys.exit(0)
breaches = []
for line in open(ledger_path):
    m = re.match(r'^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|\s*$', line)
    if not m or m.group(2).strip() != "wire-or-retire":
        continue
    try:
        d = datetime.date.fromisoformat(m.group(4).strip())
    except ValueError:
        continue  # unparseable date → age unknown → never flagged
    past_grace = (today - d).days - GRACE_DAYS
    if past_grace > SLO_DAYS:
        breaches.append((past_grace, m.group(1).strip()))
if not breaches:
    print("kill-chain soft-SLO: quiet (no wire-or-retire module >30d past grace)")
else:
    breaches.sort(reverse=True)
    print(f"kill-chain soft-SLO: FLAG — {len(breaches)} wire-or-retire module(s) >{SLO_DAYS}d past grace without a verdict:")
    for a, p in breaches[:5]:
        print(f"  {a}d past grace — {p}")
PY
# To smoke-test the FLAG path without waiting for a real stale row (AC: "fires on a
# synthetic >30-day stale row and stays quiet otherwise"), point it at a synthetic
# ledger — a >30d-past-grace last-touched date FLAGs, a recent one stays quiet:
#   printf '| `web/src/x.ts` | wire-or-retire | tests only | 2026-01-01 |\n' > /tmp/wl.md
#   python3 - /tmp/wl.md <<'PY'  ...same script...  PY   # -> FLAG
#   printf '| `web/src/x.ts` | wire-or-retire | tests only | '"$(date -I)"' |\n' > /tmp/wl.md
#   ...                                                    # -> quiet
```

### Timer Health
```bash
for timer in hydra-betting-ingest hydra-betting-scan hydra-checkpoint-refresh; do
  last=$(systemctl --user show ${timer}.timer -p LastTriggerUSec --value 2>/dev/null)
  next=$(systemctl --user show ${timer}.timer -p NextElapseUSecRealtime --value 2>/dev/null)
  active=$(systemctl --user is-active ${timer}.timer 2>/dev/null)
  echo "${timer}: active=${active} last=${last} next=${next}"
done
```

### Failed Service Root Cause
```bash
for svc in $(systemctl --user list-units --type=service --state=failed --no-legend 2>/dev/null | grep hydra | awk '{print $1}'); do
  echo "=== ${svc} ==="
  journalctl --user -u "${svc}" --no-pager -n 20 2>&1 \
    | grep -v "systemd\|Consumed\|Triggering\|Failed to start\|Failed with" | tail -5
done
```

### External API Reachability
```bash
echo -n "Polymarket Gamma: "; curl -s -o /dev/null -w "%{http_code}" "https://gamma-api.polymarket.com/markets?limit=1"
echo -n "  Kalshi: "; curl -s -o /dev/null -w "%{http_code}" "https://api.elections.kalshi.com/trade-api/v2/exchange/status"
echo -n "  Odds API: "; curl -s -o /dev/null -w "%{http_code}" "https://api.the-odds-api.com/v4/sports/?apiKey=$(grep ODDS_API_KEY ~/hydra-betting/.env.local 2>/dev/null | head -1 | cut -d= -f2 | tr -d '\"' | tr -d ' ')"
echo
```

### Docker Container Conflicts
```bash
grep -n "hydra-postgres\|grep -v" ~/.local/bin/hydra-docker-cleanup.sh 2>/dev/null \
  || echo "WARNING: cleanup script has no hydra-postgres exclusion"
```

## Phase 2: Diagnose

Only report issues actually present — don't speculate.

- **Cycle health**: Merge rate, fix:feat ratio trend, rollback clusters, repeated task titles
- **Deployed-build drift**: Is the drift verdict `drift`? Prod is running STALE code — deploy-on-merge did not restart the service (the "uptime 22h, status ok" trap). NEVER report a `drift` verdict as healthy. `settling` is a mid-flight deploy (re-check next run). `unknown` is information-only (service unreachable / detached origin). If a dirty-tree probable-cause is shown, that tracked modification is what blocked deploy.sh.
- **Blockers**: Dirty working tree blocking grounding? Grounding timeout (0/0 tests)? Stale cycles?
- **External access**: Did the external health check return non-200? Tunnel down?
- **Services**: Any in failed state? Crash loops? Missing module errors?
- **Failed service root cause**: Don't just report "service X failed" — read the actual error. Classify:
  - DB connection refused → is postgres running?
  - API validation error → upstream API changed? Test the API directly.
  - Module not found → broken dependency?
  - Rate limited → back off
- **Kill-chain soft SLO**: Did the wiring-ledger check emit `FLAG`? One or more wire-or-retire modules have sat >30 days past grace without a verdict — the `/hydra-wire-or-retire` decision is overdue. Surface it in the report and (Phase 3) steer `/hydra-wire-or-retire`; this is a SURFACED-only nudge, NEVER a gate — do not block or fail the doctor on it. `quiet` (including "ledger absent") is healthy.
- **Timer health**: Any timer not firing? Ingest not run in >15 min? Scanner not run in >35 min?
- **Database health**: Postgres in the compose project? Data being written? Connections exhausted?
- **External API health**: Polymarket/Kalshi/Odds API returning non-200? Explains service failures.
- **Docker conflicts**: Could cleanup scripts kill production containers?
- **Backlog**: Empty queue? Duplicate items? Stale blocked items?
- **Memory bloat**: Any agent at 25+ rules? Duplicate rules?
- **Alerts**: Stale alerts from resolved issues? Pattern alerts (consecutive_failures, low_merge_rate, file_rework, rollback_cluster)?
- **Tool currency**: Any tool reporting `outdated` (warning) — does the operator need to upgrade `gh`, switch Node, etc.? `unknown` is information-only — it means the doctor couldn't reach the upstream feed, not that something is wrong.
- **Disk pressure**: NVMe below 20GB? SSD filling up?
- **Redis**: Memory growing? Key count unusual?

## Phase 3: Fix (default — always apply quick wins)

Quick wins to apply automatically:
- Restart hydra-tunnel if external health check returns non-200
- Commit dirty working tree files (if they're Hydra executor changes)
- Restart failed services (after diagnosing root cause)
- Start postgres if missing: `cd ~/hydra && docker compose up -d postgres`
- Re-create ollama-embed if missing (issue #1812 — OpenViking's dense-embedding
  HOT path; a MISSING container means the depends_on chain was never pulled in):
  `cd ~/hydra && docker compose up -d` (bare bring-up pulls the whole chain;
  ollama-embed goes healthy after the ~270MB nomic-embed-text pull lands)
- Kill stale test containers: `docker ps --format '{{.Names}}' | grep test | xargs -r docker kill`
- Converge a `drift` verdict (prod stale): run `scripts/deploy.sh` from the
  `~/hydra` master checkout (rebuilds `dashboard/dist/` + restarts the
  service). If the drift check reported a dirty-tree probable-cause, first
  `git -C ~/hydra reset`/commit that tracked change so deploy.sh's dirty-tree
  guard doesn't re-abort — `docker/ov.conf` is a known spurious offender.
  (`settling` needs no action — re-check next run; `unknown` is a service
  reachability issue, not stale code.)
- Deduplicate agent memory rules
- Delete duplicate backlog items: `hydra backlog rm <id>`
- Dismiss stale alerts: `hydra alerts dismiss-all`

**Tool currency is NEVER auto-fixed.** The doctor reports drift and the operator decides whether/when to upgrade. CLI upgrades touch the operator's PATH, package manager, and shell environment — categorically outside Hydra's blast radius.

**Do NOT blindly restart services.** If a service fails due to a root cause (API down, DB missing, schema drift), restarting just fails again. Diagnose first, fix the cause, then restart.

## Phase 4: Report

```
## Hydra Doctor — <date>

### Score: X/10

### Status
<2-3 sentence summary>

### Metrics
| Metric | Value |
|--------|-------|
| ... | ... |

### Issues Found
1. **[severity] Title** — description. Root cause: <what's actually wrong>. Fixed: yes/no/needs-operator.

### Quick Wins Applied
- ...

### Operator Actions Needed
- ...
```

When reporting failed services, always include the root cause error message, not just "service X is failed".

## Silencing false positives — tool currency

If the operator deliberately runs a back-revved tool (e.g. holding `gh` at a specific minor to work around an upstream regression), the doctor's tool-currency check will keep emitting a `warning`-severity alert each run. Two options:

1. **Dismiss the alert** — `hydra alerts dismiss-all` (or dismiss individual via the dashboard). The next doctor run will re-emit if the drift persists; this is intentional. Use this when you plan to upgrade soon.
2. **Stop running the check with `--alert`** — drop the `--alert` flag from the Phase-1 collector line in the locally edited SKILL.md (or the playbook if path (b)) so the table still renders but no alert lands. Use this only for known-permanent back-rev policies; remember to add it back when the policy ends.

There is no per-tool suppression list yet — if that becomes a real maintenance burden, file a follow-up issue. The current shape favours visibility over silence.

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
