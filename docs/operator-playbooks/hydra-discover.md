---
name: hydra-discover
description: Autonomous deep-discovery loop for the Hydra orchestrator — three-tier analysis (runtime diagnostics, behavioral cross-referencing, codebase + research deep dives) that publishes findings as structured GitHub issues.
when_to_use: "When the user says 'discover', 'find improvements', 'research hydra issues', 'patrol', or wants a discovery loop alongside /hydra-sweep."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*) WebSearch(*) WebFetch(*)
---

# Hydra Discover

Three-tier investigation depth — runtime diagnostics, behavioral analysis, codebase deep dives — producing high-quality GitHub issues backed by quantitative evidence. Pairs with `/hydra-sweep` (discover finds work, sweep advances it).

## Context management

On `/loop` each iteration:
1. Read `/tmp/hydra-discover-iteration.txt` (default 0)
2. Increment, write back
3. `/compact` (Claude) / fresh context (Codex)

Stateless by design — all cross-iteration state in files (counter) and external systems (issues, architecture-review.md).

Counter controls tier:
- Every iteration: Tier 1 + 2
- Every 3rd iteration: Tier 1 + 2 + 3

## Loop safety

- Check open AND recently closed (7 days) issues before creating new
- Limit to 0–2 new issues per iteration
- Tier 1+2 < 3 min; Tier 3 adds up to 5 min via subagents
- Never create vague issues without quantitative evidence
- Target project (`hydra-betting`) findings → `target-backlog` label (sweep queues to work queue, closes)

## Tier 1: Runtime (every iteration, parallel)

```bash
hydra metrics --count 50
hydra scheduler status
hydra health
hydra raw GET /backlog/counts
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:work-queue
systemctl --user list-units --type=service --state=failed 2>/dev/null | grep hydra
journalctl --user -u hydra-orchestrator.service --since "10 min ago" --no-pager 2>/dev/null | tail -80
docker ps --filter name=hydra --format "{{.Names}}: {{.Status}}" 2>/dev/null
```

Check: service down/unhealthy, redis disconnected, scheduler errors >0, failed units, log errors/panics, container restarts.

### Container-health evidence rule (issue #1755 — MANDATORY before filing)

A `docker ps` status string is a *lead*, not evidence — transcribed or misread
status strings filed a false unhealthy-but-serving bug against a container that
was healthy the whole time (#1755). Before filing ANY container-health finding:

1. **Capture machine evidence in the same diagnostic pass** — embed the
   verbatim output of:

   ```bash
   docker inspect --format '{{json .State.Health}}' <container-name>
   date -u +%Y-%m-%dT%H:%M:%SZ
   ```

   into the finding body (the full Health JSON: `Status`, `FailingStreak`,
   recent `Log` entries with exit codes), plus the UTC timestamp of capture.

2. **False-premise guard — do NOT file when `Health.Status != "unhealthy"`.**
   If the captured `Status` is `healthy` (or `starting`), there is no
   container-health bug, whatever the `docker ps` column appeared to say.
   A transient probe stall that self-recovers is not a finding; with the
   Health JSON captured at observation time, any *real* flap is
   self-evidencing (`FailingStreak` > 0, failing probe log entries).

3. **Liveness ≠ functional health.** The OV container healthcheck is a cheap
   self-contained probe (curl 127.0.0.1:1933/health *inside* the container,
   inherited from the ghcr.io/volcengine/openviking:main image — compose
   defines no healthcheck stanza for openviking). Do not propose round-trip
   probes through external dependencies (Ollama/Tailnet) as healthcheck
   replacements: dependency degradation belongs to the Health Diagnostic
   rules at /api/health/deep, not container liveness. Do not propose
   docker-compose.yml healthcheck edits without a reproduced,
   evidence-captured defect.

## Tier 2: Behavioral (every iteration)

### 2a. Anchor-type breakdown
Per anchor type from last 50 metrics: cycles, merge rate, empty rate, avg duration, regressions.

Alerts:
- Any anchor type >50% empty over 5+ cycles → performance finding
- Any anchor type 0% merge over 5+ cycles → architectural finding
- Overall empty rate >25% → performance finding

### 2a-impact. Outcome-impact ranking — the reverse loop (issue #3283)

The 2a breakdown above is **notice-based**: it ranks anchor types by what agents
*observe* (empty rate, merge rate, duration). This step adds the missing
**impact-based** signal — what actually *moved outcomes* — so discovery steers
toward high-impact areas, not merely high-notice ones (epic #2628 finding #6:
"discovery is self-referential").

Read the outcome-attribution spine's impact ranking — the ridge estimator's
per-metric marginal effects (#2630) folded across every leading metric, oriented
by each metric's direction into a *favorable* effect and divided by a tier cost
proxy:

```bash
hydra raw GET /attribution/impact          # top producer classes by impact-per-cost
# or cap the list:  hydra raw GET /attribution/impact?topN=5
```

The ledger grain is **producer CLASS** (e.g. `dev_orch`, `discover`, `arch`), not
anchor type — the spine attributes outcome deltas to the class that produced the
merge, so this ranking is class-grained. Each row is `{producerClass,
favorableImpact, meanTier, impactPerCost, identifiabilitySuspect,
belowNoiseFloor, contributions[]}`. **Never read `impactPerCost` as a bare
number** — a row with `identifiabilitySuspect:true` means "cannot tell"
(collinear/near-constant column) and a row with `belowNoiseFloor:true` means
"measured but within exogenous drift". Trust only rows where BOTH flags are
`false`.

How to use it:

- **`metricCount: 0`** → the ledger is dark (no impact signal yet); fall back to
  the notice-based 2a signal alone and do NOT fabricate impact claims.
- **A high-`impactPerCost`, non-suspect producer class** is a *high-leverage
  area*: when you file a finding that touches that class's code path, cite the
  impact delta as justification ("high outcome delta per cost", not just "noticed
  a pattern"). This is the primary success criterion of #3283 — at least one
  discovery candidate per 3 iterations should be impact-justified.
- **A low/negative-`impactPerCost` producer class that is ALSO high-notice** (high
  cycle count / cost) is a *waste candidate*: work is flowing there but not
  moving outcomes — a stronger finding than notice alone.

Include the cited `impactPerCost` (and the flags) verbatim in any finding's
Evidence section.

### 2b. Cost & efficiency
From metrics: cost/merged feature, cost of empty cycles, plan cache hit rate, grounding duration trend, thread reuse rate.

Alerts:
- Cost/merge >$5 → efficiency finding
- Empty-cycle cost >30% of total → waste finding
- Grounding duration up >20% over 20 cycles → performance finding

### 2c. Backlog & queue health
```bash
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:processing
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:prior-failures
docker exec hydra-redis-1 redis-cli LLEN hydra:anchors:reframe-queue
```

Alerts: processing >0 when no cycle running (crash recovery), prior_failures >5, reframe >3, work_queue growing across iterations.

## Tier 3: Codebase deep dive (every 3rd iteration)

Only investigate areas Tier 1+2 flagged. Skip if nothing flagged.

- **Claude:** `Agent(subagent_type: "Explore", ...)` parallel.
- **Codex:** Multiple `codex exec --skill explore-area` subprocesses, each with a focus.

### 3a. Targeted source analysis

Map findings to files:
- High empty cycles → `src/anchor-selection.ts`, `src/planner-prompt.ts`
- Recurring scope creep → `src/control-loop.ts` `runExecutorAgent()`
- Verification failures cluster → `src/verifier.ts`, `src/preflight.ts`
- High cost → `src/codex-runner.ts` (model routing, thread reuse, caching)

Look for: files >500 lines, functions >100 lines, stale TODOs, stale `// intentional:` comments, hardcoded values, silent error handling, missing tests.

### 3b. Cross-module coupling
```bash
grep -r "redis\.\(hset\|hget\|lrange\|zadd\|del\|get\|set\)" ~/hydra/src/ --include="*.ts" -l | wc -l
grep -r "from.*task-tracker" ~/hydra/src/ --include="*.ts" -l | wc -l
wc -l ~/hydra/src/*.ts | sort -rn | head -10
```

Compare against architecture-review.md baselines.

### 3c. External research (only when warranted)

| Problem | Search query |
|---|---|
| High empty cycle rate | "LLM agent pre-filtering anchor quality scoring 2026" |
| Recurring scope creep | "autonomous coding agent scope enforcement techniques" |
| Test quality plateau | "mutation testing AI generated code meta JiT 2026" |
| High cost per merge | "LLM model routing classifier cascade cost optimization" |
| Learning not improving | "agent episodic memory reinforcement learning from failures" |

Include sources in issue body.

## Dedup and issue creation

### Dedup

Gather the **shared backfill dedup baseline** — open issues across EVERY
backfill label set + issues closed in the last 7 days — then run each candidate
through the SAME deterministic helper `hydra-architecture-scan` uses, so the two
classes that co-fire on `orch_backfill_idle` can't disagree at the margin and
double-file the same finding (issue #2554):

```bash
# Open issues across the WHOLE backfill set — NOT just discover's own
# needs-triage. The collision partner is hydra-architecture-scan (label
# `architecture-scan`); cleanup_orch (label `cleanup-scan`) co-fires too. All
# three plus generic `enhancement` belong in the baseline so discover sees what
# architecture-scan / cleanup just filed THIS idle window.
mapfile -t BASELINE_TITLES < <(
  { gh issue list --state open --json number,title \
      --jq '.[] | .title'
    gh issue list --state closed --json number,title,closedAt \
      --jq '[.[] | select(.closedAt > (now - 7*24*3600 | todate))] | .[] | .title'
  } )

# Per candidate finding title $CANDIDATE:
node --experimental-strip-types scripts/ci/issue-dedup.ts \
  "$CANDIDATE" "${BASELINE_TITLES[@]}"
# → {"duplicate":true,"matchedTitle":"...","overlap":0.71}  → SKIP or COMMENT on the matched issue
# → {"duplicate":false,"overlap":0.2}                       → file it
```

`isDuplicateIssue` (`scripts/ci/issue-dedup.ts`) keys on normalised word-set
Jaccard overlap >50% — the historical "word overlap >50% → SKIP" rule, now a
shared, testable function instead of an eyeball. `duplicate: true` → SKIP or
COMMENT on the matched existing issue. After you decide to FILE a candidate,
append its title to `BASELINE_TITLES` before checking the next so two findings
within THIS run also dedup against each other. The
**`hydra-discover` ↔ `hydra-architecture-scan` co-fire on `orch_backfill_idle`
is the primary motivating collision** this baseline closes — see the
**Backfill dedup baseline** note in `hydra-autopilot.md`.

### Issue formats

All three formats stamp the `Source: …` provenance footer from the shared
helper (`scripts/hydra/footer.sh`, issue #2556). It is composed OUTSIDE the
single-quoted heredoc so the `<<'EOF'` injection-safety quoting is preserved
(the helper expands the live timestamp; the heredoc body stays literal). Source
the lib once at the top of the dispatch, then call `hydra_issue_footer
hydra-discover 'tier N'` after each closing `EOF` (replace `tier N` with the
real tier).

```bash
. ~/hydra/scripts/hydra/footer.sh
```

**Bug / health:**
```bash
gh issue create --title "..." --label "needs-triage" --body "$(cat <<'EOF'
## Problem
## Evidence
## Impact
## Suggested fix
---
EOF
)
$(hydra_issue_footer hydra-discover 'tier N')"
```

**Improvement:**
```bash
gh issue create --title "..." --label "needs-triage" --body "$(cat <<'EOF'
## Problem Statement
## Evidence
## Proposed Solution
## Success Criteria
## Implementation Notes
- Files: ...
- Domain terms: ...
- ADR conflicts: ...
- Estimated scope: small/medium/large
## Research References
---
EOF
)
$(hydra_issue_footer hydra-discover 'tier N')"
```

**Target project finding:**
```bash
gh issue create --title "..." --label "target-backlog" --body "$(cat <<'EOF'
## Problem
## Evidence
## Suggested fix
## Context for orchestrator
---
EOF
)
$(hydra_issue_footer hydra-discover 'tier N')"
```

## Calibration

Create issue only if ALL true:
1. Quantitative evidence (metric/count/measurement)
2. Pattern, not incident (multiple cycles or modules)
3. Actionable (concrete next step, not "investigate further")
4. Not already tracked (dedup passed)
5. Correctly scoped (orchestrator → `needs-triage`; target → `target-backlog`)

Otherwise log in summary, don't create.

## Summary output (every iteration)

```
[hydra-discover] Tier 1+2 (iteration N). Checked 50 cycles.
  Health: OK | Empty rate: 18% | Merge rate: 62% | Cost: $X.XX/merge
  Findings: 0 health, 1 perf, 0 arch
  Created: #42 (codebase-health anchor filtering). Skipped: 1 (#6).
```

Tier 3:
```
[hydra-discover] Tier 1+2+3 (iteration N). Deep dive triggered by: high empty rate.
  Explored: anchor-selection.ts, planner-prompt.ts, codex-runner.ts
  Research: classifier cascade techniques (3 sources)
  Findings: 1 arch (planner context missing anchor-type-specific enrichment)
  Created: #48. Skipped: 0.
```

## Domain context
- `~/hydra/CONTEXT.md` — canonical vocabulary
- `~/hydra/docs/adr/` — don't contradict existing ADRs
- `~/hydra/config/direction/architecture-review.md` — baselines, known issues

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
