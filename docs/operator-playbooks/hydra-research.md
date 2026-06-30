---
name: hydra-research
description: Research improvement opportunities for the Hydra orchestrator itself. Analyzes codebase architecture, control loop efficiency, learning system, agent quality, and infrastructure to produce actionable GitHub issues.
when_to_use: "When the user says 'research hydra', 'improve the orchestrator', 'find orchestrator work', or when hydra-autopilot detects the orchestrator issue board is empty and the system has capacity."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*) WebSearch(*) WebFetch(*)
arguments: [focus]
---

# Hydra Research

Research improvement opportunities for the Hydra orchestrator (`~/hydra`). Produces structured GitHub issues that `/hydra-sweep` can triage and `/hydra-dev` can implement.

**Goal: keep the orchestrator issue board at 5+ ready-for-agent issues so `/hydra-dev` never idles.**

## Phase 1: Load Context (inline, parallel)

1. `~/hydra/CLAUDE.md` — architecture, conventions
2. `~/hydra/config/direction/architecture-review.md` — known issues, scores
3. `~/hydra/config/direction/priorities.md` — target project needs
4. `~/hydra/config/feedback/to-{planner,executor,skeptic}.md` — recurring problems (note: `to-skeptic.md` is now loaded only for the high-risk-review path; low/medium-risk uses the deterministic preflight gate)

Then live state (parallel):
```bash
cd ~/hydra && npm test 2>&1 | tail -5
wc -l ~/hydra/src/*.ts | sort -rn | head -15

hydra metrics --count 50 | python3 -c "
import json,sys
d=json.load(sys.stdin)
trend=d.get('trend',d.get('metrics',[]))
merged=sum(1 for m in trend if int(m.get('tasksMerged',0))>0)
failed=sum(1 for m in trend if int(m.get('tasksFailed',0))>0)
empty=sum(1 for m in trend if 'no task' in m.get('taskTitle','').lower() or 'skipped' in m.get('taskTitle','').lower())
rolled=sum(1 for m in trend if m.get('rolledBack') in ['true',True])
costs=[float(m.get('costUsd',0)) for m in trend]
print(f'Cycles: {len(trend)} | Merged: {merged} | Failed: {failed} | Empty: {empty} | Rolled: {rolled}')
print(f'Merge rate: {100*merged//max(len(trend),1)}% | Empty rate: {100*empty//max(len(trend),1)}%')
print(f'Total cost: \${sum(costs):.2f} | Cost/merge: \${sum(costs)/max(merged,1):.2f}')
"

gh issue list --repo gaberoo322/hydra --state open --json number,title,labels \
  --jq '.[] | "\(.number): [\(.labels | map(.name) | join(","))] \(.title)"'
gh issue list --repo gaberoo322/hydra --state closed --limit 30 --json number,title,closedAt \
  --jq '[.[] | select(.closedAt > "'$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)'")] | .[] | "\(.number): \(.title)"'
cd ~/hydra && git log --oneline -20
```

Compute **issue gap**: `gap = max(0, 5 - open_ready_for_agent_count)`. Aim to produce that many.

If `$focus` provided, weight analysis toward that area.

## Phase 2: Parallel Research (3 agents)

Spawn three researchers — Control Loop, Learning, Infrastructure. Each gets the full context and produces a JSON array of opportunities.

- **Claude:** `Task(...)` ×3 in one message.
- **Codex:** `codex exec --skill hydra-research-child` ×3 (each with focus=control_loop / learning / infrastructure).

### Agent 1: Control Loop & Efficiency
Investigate: empty cycle reduction, scope creep patterns, verification pipeline (mutation/JIT kill rates), plan cache hit rate, model routing accuracy, cycle-time bottleneck, cost optimization (caching, thread reuse, context compression).

Files: `control-loop.ts`, `pipeline-steps.ts`, `anchor-selection.ts`, `planner-prompt.ts`, `context-builder.ts`, `codex-runner.ts`, `verification.ts`, `plan-cache.ts`.

Output: ≥5 opportunities as `[{"title","category":"efficiency","priority","description","acceptance_criteria":[...],"files":[...]}]`. When a finding naturally decomposes into multiple vertical slices, surface them as a `slices: [...]` array on the opportunity object (see **Epic vs. flat decision rule** below) so Phase 4 can route the finding through `hydra-prd`.

### Agent 2: Learning & Knowledge
Investigate: agent memory recording / promotion / consolidation, OpenViking search quality and indexer health, episodic reflection injection, feedback file staleness, pattern detection accuracy, knowledge gaps.

Files: `learning.ts`, `redis-adapter.ts`, `context-builder.ts`, `pattern-detector.ts`, `prompt-evolution.ts`.

Output: ≥5 opportunities (`category: "learning"`).

### Agent 3: Infrastructure & Reliability
Investigate: test coverage gaps, silent catch blocks, redis-adapter migration progress, route validation, dashboard health, scheduler interval tuning, watchdog coverage, code quality (large files, dead code).

Output: ≥5 opportunities (`category: "infrastructure"`).

## Phase 3: Synthesis (inline)

### 3a. Deduplicate
- Drop items matching open issues (>50% title overlap)
- Drop items matching recently closed issues
- Merge duplicates across researchers

### 3b. Score and rank by:
1. Merge-rate impact (heaviest weight)
2. Cost efficiency
3. Autonomy gain
4. Scope size (smaller = higher)

### 3c. Filter
- Drop anything contradicting an ADR
- Drop broad refactors without specific criteria

## Phase 4: Create Issues

For each surviving opportunity (top N where N = issue gap, max 5), decide whether it ships as a **flat** GitHub issue or routes through **`hydra-prd`** to emit a parent epic + tracer-bullet children. The rule below is the contract `hydra-research` honours; the unit-testable helper lives in `scripts/ci/epic-shape-classifier.ts`.

### Epic vs. flat decision rule

A finding is **epic-shaped** — route through `hydra-prd` — if ALL of:

- The finding's vertical-slice decomposition produces **≥3** distinct slices
- The slices share a **common rationale** (one problem statement covers all of them)
- The slices have **inter-dependencies** (at least one `dependsOn` / "blocked by" relationship between siblings)

A finding is **flat-shaped** — skip `hydra-prd`, file directly with `gh issue create` — if:

- It is **1–2 slices** total, OR
- The slices are **mutually independent** with no shared rationale (parallel small wins)

When neither *all three* epic conditions nor the strict flat conditions hold (e.g. ≥3 slices with shared rationale but no deps, or ≥3 slices with deps but no rationale), the rule still routes through `hydra-prd`: either rationale alone or sequencing alone is enough to justify a parent narrative. See `classifyEpicShape` in `scripts/ci/epic-shape-classifier.ts` for the verbatim decision tree and `test/epic-shape-classifier.test.mts` for the matrix of cases this guards against drifting.

### Escape hatches

- **Operator override.** A finding may carry an explicit `epic: false` flag (force flat) or `epic: true` (force epic) on the opportunity object. The classifier honours either override; if `epic: true` is set on a <3-slice finding, the classifier returns `flat` with `forcedEpicTooSmall: true` so the playbook can warn the operator instead of producing a malformed PRD.
- **`hydra-prd` failure.** If the `hydra-prd` invocation fails (e.g. `gh` rate limit, `/api/tier` unreachable, malformed PRD validation error), this skill MUST fall back to filing **flat** issues with a comment on each child linking the orphaned siblings (`Related: #N (other slices in the same finding)`). No silent drop — every slice becomes a GitHub issue either way. The fallback path logs the original `hydra-prd` failure to stderr so the operator can re-run later if desired.

### 4a. Classify each finding

For each opportunity emerging from synthesis, call the classifier (one-shot, no network):

```bash
node --experimental-strip-types -e '
  const { classifyEpicShape } = require("./scripts/ci/epic-shape-classifier.ts");
  const finding = JSON.parse(process.env.FINDING_JSON);
  const verdict = classifyEpicShape(finding);
  console.log(JSON.stringify(verdict));
'
```

Or equivalently from a TS driver:

```ts
import { classifyEpicShape } from "./scripts/ci/epic-shape-classifier.ts";
const verdict = classifyEpicShape(finding);
if (verdict.shape === "epic") {
  // route to hydra-prd
} else {
  // file flat (with optional cross-link comments on related siblings)
}
```

### 4b. Epic-shaped path — invoke hydra-prd

Build a `PrdInput` JSON object from the finding (see `scripts/ci/hydra-prd-render.ts` for the schema):

```json
{
  "title": "<parent epic title>",
  "problem": "<problem statement using Hydra glossary terms>",
  "rationale": "<why ship this now; link to Target Outcomes / Modification Tier>",
  "expectedGlossaryTerms": ["Orchestrator", "Target", "Modification Tier"],
  "sourceRef": "hydra:reports:research:<ISO timestamp>",
  "slices": [
    {
      "title": "<slice title>",
      "whatToBuild": "<prose>",
      "acceptanceCriteria": ["...", "..."],
      "filesInScope": ["src/...", "test/..."],
      "filesOutOfScope": ["..."],
      "dependsOn": [1]
    }
  ]
}
```

Write the input to `/tmp/hydra-research-prd-<finding-id>.json` and invoke the skill:

```bash
# Dry-run first (default) to surface validation errors / vocabulary gaps.
/hydra-prd --input=/tmp/hydra-research-prd-<finding-id>.json

# Apply once the dry-run looks clean.
/hydra-prd --apply --input=/tmp/hydra-research-prd-<finding-id>.json
```

If `hydra-prd` exits non-zero on `--apply` (e.g. `gh issue create` 422 mid-batch, `/api/tier` down), fall back to the flat path for the remaining slices and post cross-link comments on every child that was created.

### 4c. Flat-shaped path — gh issue create per slice

For findings the classifier routes flat, file each slice as its own GitHub issue with the canonical agent-ready body:

The `Source: …` provenance footer comes from the shared helper
(`scripts/hydra/footer.sh`, issue #2556) — composed OUTSIDE the single-quoted
heredoc so the `<<'EOF'` injection-safety quoting is preserved:

```bash
. ~/hydra/scripts/hydra/footer.sh
gh issue create --repo gaberoo322/hydra --title "..." --label "needs-triage" --body "$(cat <<'EOF'
## Summary
<1-2 sentences>

## Current behavior
<file:line references>

## Desired behavior

## Acceptance criteria
- [ ] <specific, testable>
- [ ] ...

## Files in scope
- `src/<file>.ts` — <what changes>

## Files out of scope

## Implementation notes

---
EOF
)
$(hydra_issue_footer hydra-research)"
```

Issues MUST have acceptance criteria — `/hydra-dev` requires them.

When the flat path runs as a `hydra-prd` **fallback** (Step 4b failed), append a `## Related` section listing the sibling issue numbers so the orphaned siblings stay discoverable:

```
## Related

These slices were originally part of one finding but were filed flat because `hydra-prd` invocation failed:

- #<sibling-1>
- #<sibling-2>
```

## Phase 5: Report

```
## Hydra Research — <date>

### Issue board: <before> → <after> ready-for-agent

### Findings by dimension
- Efficiency: <count> — <key finding>
- Learning: <count> — <key finding>
- Infrastructure: <count> — <key finding>

### Routing summary
- Epic-shaped (routed through /hydra-prd): <count> findings → <count> parent epics + <count> children
- Flat-shaped (direct gh issue create): <count> issues
- hydra-prd fallbacks (flat with cross-links): <count> (if any)

### Issues created
- #N: <title> (priority, category)

### Deduped/skipped
- <title> — already tracked in #N

### Operator actions needed
- <strategic decisions surfaced>
```

## Rate limiting

Expensive (3 parallel research agents + codebase exploration). Skip if last run <60 min ago:
```bash
LAST=$(cat /tmp/hydra-last-orchestrator-research.txt 2>/dev/null)
NOW=$(date -u +%s)
if [ -n "$LAST" ]; then
  AGE=$((NOW - $(date -u -d "$LAST" +%s)))
  [ "$AGE" -lt 3600 ] && echo "Skipping — last run ${AGE}s ago" && exit 0
fi
date -u +%Y-%m-%dT%H:%M:%SZ > /tmp/hydra-last-orchestrator-research.txt
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
