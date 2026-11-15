---
name: hydra-doctor
description: Comprehensive Hydra system health check — diagnoses orchestrator, services, cycles, backlog, infrastructure, and applies fixes.
when_to_use: "When the user wants a health check, asks what's wrong, says 'fix hydra', or wants to know the system status"
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [focus]
---

# Hydra Doctor

Comprehensive health check of the Hydra autonomous orchestrator. You have full conversation context — use it.

**Default behavior: diagnose AND fix.** Always apply quick wins unless the operator says "no fix" or "diagnose only".

If the operator provided a focus area (`$focus`), weight your analysis toward that.

## Phase 1: Collect (run in parallel)

Every block prints raw output; none of them parses anything.

### Collectors
```bash
cd ~/hydra && npx tsx scripts/ops-collect.ts --collectors cycles,board,alerts,memory,redis-server,timers,redis-backup,journal-errors,target-git,kill-chain --text --count 20 2>/dev/null || echo "ops-collect unavailable"
```
One line per collector, detail rows indented; field meanings: `npx tsx scripts/ops-collect.ts --help`. A line reading `<collector>: <code> (<reason>)` means no data for that probe, so keep going; `ops-collect unavailable` means the CLI crashed: a finding.

- The first line is `target:`. `<unresolved>` is a Target-config finding; the Target collectors then print `skipped (Target unresolved)` and the rest still run.
- `cycles` carries `coverage.classesNotRecorded`: those classes write no cycle record, so their absence is not a zero.
- `timers` lists every repo-owned timer and the Target's timers; each `TIMER NOT ENABLED`, `TIMER NEVER FIRED` or `TIMER NOT SCHEDULED` entry is a finding.
- `kill-chain` prints `quiet` or `FLAG`. It is surfaced only and never a gate.

### Core health
```bash
hydra health
hydra scheduler status
curl -s -o /dev/null -w "External: %{http_code}\n" https://admin.clawstreetbets.xyz/api/health
```
The `curl` line checks the public tunnel.

### Deployed-build drift
```bash
cd ~/hydra && npx tsx scripts/deploy-drift-check.ts --text --alert 2>/dev/null || echo "deploy-drift check unavailable"
```
Read-only. The verdict line is what matters:

- `in-sync`: the running build is `origin/master`.
- `settling`: a deploy is probably mid-flight; re-check next run.
- `drift`: prod is running stale code even though health says ok. A `probable cause: ... dirty tree` note names the tracked modification that blocked the deploy.
- `unknown`: a SHA could not be resolved (service down, detached origin). Information only.

### Tool currency
```bash
cd ~/hydra && npx tsx scripts/tool-currency-check.ts --table --alert 2>/dev/null || echo "tool-currency check unavailable"
```
Read-only. `unknown` means the upstream feed was unreachable, not that a tool is wrong.

### Services
```bash
systemctl --user list-units --type=service --state=running,failed 2>/dev/null | grep hydra
```
For each unit listed as `failed`, read its own log before diagnosing:
```bash
journalctl --user -u <failed-unit> --no-pager -n 20
```

### Working tree, disk, database
```bash
git -C ~/hydra status --short | head -10
df -h / /mnt/hydra-ssd 2>/dev/null | tail -2
cd ~/hydra && docker compose ps postgres --format '{{.Name}} {{.Status}}'
cd ~/hydra && docker compose exec -T postgres psql -U hydra -d hydra -t -c "SELECT 'pg_connections: ' || count(*) || '/' || current_setting('max_connections') FROM pg_stat_activity;"
```
A dirty `~/hydra` tree blocks `scripts/deploy.sh`. Postgres is compose infra the Target also uses; probe the container and its connection pool only (Target table freshness belongs to `hydra-target-discover`).

### Docker cleanup exclusion
```bash
grep -n "hydra-postgres" ~/.local/bin/hydra-docker-cleanup.sh
```
No match means the cleanup script could remove the production Postgres container.

## Phase 2: Diagnose

Report only what the output shows.

- **Cycles**: merge rate, fix-to-feature split, repeated task titles.
- **Deployed-build drift**: never report a `drift` verdict as healthy.
- **Blockers**: a dirty `~/hydra` tree; stale cycles.
- **External access**: a non-200 from the tunnel check.
- **Services**: for each failed unit, name the root-cause error from its log, not just "service X failed". Classify: DB connection refused (is Postgres running?), API validation error (did the upstream API change?), module not found (broken dependency), rate limited (back off).
- **Kill-chain**: `FLAG` means a wire-or-retire verdict is overdue; steer `/hydra-wire-or-retire`. It never blocks or fails the doctor.
- **Timers**: every `timers` finding; a Target timer with no last or next run; a skipped Target line.
- **Redis backup**: a `stale` or `NONE FOUND` line.
- **Database**: Postgres missing from the compose project; connections near the limit.
- **Board**: empty ready lane, duplicate issues, stale blocked issues; a `truncated` board makes every count a floor.
- **Agent memory**: an agent with 0 patterns (learning may be broken), an unusually large `bytes`, an entry under `failed`.
- **Alerts**: alerts that the live state contradicts.
- **Tool currency**: any `outdated` tool.
- **Disk and Redis**: NVMe below 20GB, SSD filling up, Redis memory near `maxmemory`, an unusual key count.

## Phase 3: Fix (default: apply quick wins)

Report-only, never act:

- A dirty `~/hydra` working tree. Never reset, stash or commit it; it may hold the operator's uncommitted work.
- Stray or stale containers and processes. Never kill by name or pattern: the CI runners share this host and user.
- Outdated tools. Never upgrade one; the operator decides.
- Duplicate agent-memory patterns.

Quick wins:

- Restart hydra-tunnel when external check is non-200.
- Restart a failed service only after fixing its root cause; a blind restart fails again.
- Start Postgres if missing: `cd ~/hydra && docker compose up -d postgres`.
- Converge a `drift` verdict only by running `scripts/deploy.sh` from the `~/hydra` master checkout. If the drift check names a dirty-tree cause, report the path instead.
- Close a duplicate board issue: `gh issue close <N> --repo gaberoo322/hydra --comment "Duplicate of #<other>" --reason "not planned"`.
- Dismiss stale alerts: `hydra alerts dismiss-all`.

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

## Silencing a tool-currency warning

A deliberately back-revved tool re-raises its warning alert on every run. Dismiss it with `hydra alerts dismiss-all`; it returns while the drift persists. There is no per-tool suppression list.

## Slot lifecycle events

Every tool call in this skill emits a `subagent_tool_call` event through `scripts/autopilot/hooks/on-subagent-tool-call.sh`, registered by the sibling `hydra-doctor.settings.json`. The hook never propagates an error into this session; `test/on-subagent-tool-call.test.mts` pins its behaviour.
