---
name: hydra-target-discover
description: Runtime diagnostic discovery for the target project (hydra-betting). Checks API health, execution metrics, database state, and production logs to find anomalies. Files needs-triage issues on the gaberoo322/hydra-betting board for findings.
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

# Production route crawl (issue #2735) — curl every nav-registry route against
# the LIVE service and report per-route status. This is the ONLY tier that
# catches data-drift 500s: the four recent operator-visible outages
# (item-737/738 and siblings) rendered fine in CI but crashed against real
# production data. PR-time CI never sees the production database, so a runtime
# curl crawl is the only place this class of failure surfaces. Curl-tier only —
# no browser (browser smoke is the CI tier, #2733). Dry-run here just prints the
# per-route table; --apply (step 3) files the deduped, capped needs-triage issues
# on the Target board (gaberoo322/hydra-betting, ADR-0031).
npx tsx ~/hydra/scripts/ci/target-route-crawl.ts

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
**Route crawl:** any non-200 in the per-route table is a data-drift page crash — filed deterministically by the crawl runner (see step 3), one deduped item per route
**DB:** connections approaching max / no recent ingest (timer failure) / size growing rapidly
**Execution:** stuck arb runs (non-terminal >1h) / high venue-order failure rate / settlement orphans
**Timers:** any inactive / last trigger >2× expected interval
**External APIs:** non-200 from Kalshi/Polymarket / rate limit indicators

### 3. Create issues

**Route crawl (deterministic, issue #2735).** For the production route crawl,
do NOT hand-roll the issue creation — run the emitter, which owns the dedup,
the per-run cap, and the error-digest body (the #1449 "invoke the runner, not a
loop" lesson):

```bash
# files at most ROUTE_CRAWL_EMIT_CAP deduped needs-triage issues on the Target
# board (gaberoo322/hydra-betting, ADR-0031 — REST-first dedup, never
# gh --json/GraphQL), one per non-200 route; a healthy crawl files nothing; a
# downed service files nothing (that's the health check's job, not per-route drift)
npx tsx ~/hydra/scripts/ci/target-route-crawl.ts --apply
```

**Health / data / execution findings (judgment).** Only if ALL true:
1. Quantitative — backed by number/count/measurement
2. Persistent — not a one-time blip
3. Actionable — concrete fix
4. Not already tracked — dedup lexically against the open Target board (ADR-0031
   Decision 5 — lexical `gh issue list --search`; the underlying reads draw from
   the REST search pool, never `gh --json`/GraphQL, Decision 6):
   ```bash
   REPO=gaberoo322/hydra-betting
   # Open board titles (any lane):
   gh api "repos/$REPO/issues?state=open&per_page=100" \
     --jq '.[] | select(has("pull_request")|not) | .title'
   # Recently-closed titles (last 7 days) to avoid re-filing just-shipped work:
   gh api "repos/$REPO/issues?state=closed&since=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)&per_page=100" \
     --jq '.[] | select(has("pull_request")|not) | .title'
   ```

The `Source: …` provenance footer comes from the shared helper
(`scripts/hydra/footer.sh`, issue #2556) — composed OUTSIDE the single-quoted
heredoc so the `<<'EOF'` injection-safety quoting is preserved. Findings file to
the **Target board (`gaberoo322/hydra-betting`)** with `needs-triage` (ADR-0031 —
`target-backlog` was the orch-side routing label and is not part of the Target's
own board vocabulary):

```bash
. ~/hydra/scripts/hydra/footer.sh
gh issue create --repo gaberoo322/hydra-betting --title "..." --label "needs-triage" --body "$(cat <<'EOF'
## Problem
## Evidence
## Suggested fix
## Context for the target build
---
EOF
)
$(hydra_issue_footer hydra-target-discover)"
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
