---
name: hydra-target-discover
description: Runtime diagnostic discovery for the target project (hydra-betting). Checks API health, execution metrics, database state, and production logs to find anomalies. Creates target-backlog issues for findings.
when_to_use: "When the user says 'check target health', 'target discover', 'production health', or wants runtime diagnostics on the hydra-betting project. Also dispatched by hydra-autopilot."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
---

# Hydra Target Discover

Runtime diagnostic discovery for `~/hydra-betting`. Complements `/hydra-discover` (orchestrator) by monitoring target's production behavior — API health, execution metrics, DB state.

## Context management

On `/loop`, run `/compact` (Claude) / restart context (Codex) at start.

## Process

### 1. Collect (parallel)

```bash
# Web service health
curl -s http://localhost:3333/api/health 2>/dev/null || echo "UNREACHABLE"
systemctl --user status hydra-betting-web.service 2>&1 | head -5

# Recent API errors
journalctl --user -u hydra-betting-web.service --since "30 min ago" --no-pager 2>&1 \
  | grep -iE "error|fail|reject|crash|500|404|timeout" | grep -v "DeprecationWarning" | tail -15

# Database health
docker exec hydra-postgres-1 psql -U hydra -d hydra -t -c "
  SELECT 'last_ingest: ' || COALESCE(max(started_at)::text, 'NEVER') FROM sportsbook_ingestion_runs
  UNION ALL SELECT 'venue_orders_24h: ' || count(*) FROM venue_orders WHERE submitted_at > now() - interval '24 hours'
  UNION ALL SELECT 'arb_runs_24h: ' || count(*) FROM arbitrage_runs WHERE created_at > now() - interval '24 hours'
  UNION ALL SELECT 'pg_connections: ' || count(*) || '/' || current_setting('max_connections') FROM pg_stat_activity;" 2>/dev/null

# Execution metrics
docker exec hydra-postgres-1 psql -U hydra -d hydra -t -c "
  SELECT status, count(*) FROM arbitrage_runs
  WHERE created_at > now() - interval '24 hours'
  GROUP BY status ORDER BY count(*) DESC;" 2>/dev/null

# Timer health
for timer in hydra-betting-ingest hydra-betting-scan hydra-checkpoint-refresh; do
  active=$(systemctl --user is-active ${timer}.timer 2>/dev/null)
  last=$(systemctl --user show ${timer}.timer -p LastTriggerUSec --value 2>/dev/null)
  echo "${timer}: active=${active} last=${last}"
done

# External API reachability
echo -n "Kalshi: ";     curl -s -o /dev/null -w "%{http_code}" "https://api.elections.kalshi.com/trade-api/v2/exchange/status"
echo -n "  Polymarket: "; curl -s -o /dev/null -w "%{http_code}" "https://gamma-api.polymarket.com/markets?limit=1"
echo

# Test health (cached, hourly)
if [ ! -f /tmp/hydra-target-test-cache.txt ] || [ $(( $(date +%s) - $(stat -c %Y /tmp/hydra-target-test-cache.txt 2>/dev/null || echo 0) )) -gt 3600 ]; then
  cd ~/hydra-betting/web && npm test 2>&1 | tail -3 > /tmp/hydra-target-test-cache.txt
fi
cat /tmp/hydra-target-test-cache.txt

# DB disk usage
docker exec hydra-postgres-1 psql -U hydra -d hydra -t -c "SELECT pg_size_pretty(pg_database_size('hydra'));" 2>/dev/null

# Stale data
docker exec hydra-postgres-1 psql -U hydra -d hydra -t -c "
  SELECT 'stale_snapshots: ' || count(*) FROM market_snapshots
  WHERE fetched_at < now() - interval '2 hours' AND fetched_at > now() - interval '24 hours';" 2>/dev/null
```

### 2. Analyze patterns

**Service:** unreachable / restart loop / build failures (>5 min activating) / high mem (>2GB)
**API errors:** 500s in routes / timeout patterns (external API degradation) / auth failures
**DB:** connections approaching max / no recent ingest (timer failure) / size growing rapidly
**Execution:** stuck arb runs (non-terminal >1h) / high venue-order failure rate / settlement orphans
**Timers:** any inactive / last trigger >2× expected interval
**External APIs:** non-200 from Kalshi/Polymarket / rate limit indicators

### 3. Create issues

Only if ALL true:
1. Quantitative — backed by number/count/measurement
2. Persistent — not a one-time blip
3. Actionable — concrete fix
4. Not already tracked — dedup against `target-backlog`:
   ```bash
   gh issue list --repo gaberoo322/hydra --label "target-backlog" --state open --json number,title --jq '.[].title'
   gh issue list --repo gaberoo322/hydra --state closed --json number,title,closedAt \
     --jq '[.[] | select(.closedAt > "'$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)'")] | .[].title'
   ```

```bash
gh issue create --repo gaberoo322/hydra --title "..." --label "target-backlog" --body "$(cat <<'EOF'
## Problem
## Evidence
## Suggested fix
## Context for orchestrator
---
Source: hydra-target-discover | $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
)"
```

Limit: 0–2 per iteration.

### 4. Report

```
[hydra-target-discover] <ts>
  Web service: OK/DEGRADED/DOWN
  Database: OK (N connections, Xh since last ingest)
  Timers: N/N active
  External APIs: Kalshi=200 Polymarket=200
  Tests: N passing
  Findings: N health, N data, N execution
  Created: #N (title). Skipped: N (already tracked).
```
