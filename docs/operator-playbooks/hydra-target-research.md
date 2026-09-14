---
name: hydra-target-research
description: Run a full Hydra research cycle using Claude as the researcher instead of Codex agents. Reads the operator vision, grounds the project, researches opportunities across domain/technical/market dimensions, writes updated priorities.md and roadmap.md, and queues work items.
when_to_use: "When the user wants to run a research cycle, reprioritize work, or discover new opportunities for the Target."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Agent(*) WebSearch(*) WebFetch(*)
arguments: [focus]
---

# Hydra Target Research Cycle (Parallel)

Full research cycle for the Hydra autonomous orchestrator. Output drives what Hydra builds next. Replaces normal Codex-based research with higher-quality Claude-driven analysis.

**Goal: keep backlog at 30+ items so build cycles never stall waiting for work.**

## Resolve the Target seam (run this first)

@include _fragments/target-seam-preamble.md

**Vocabulary.** When you name a backlog item, a queued work item, or an "opportunity" in any of the researcher outputs below, use the target's canonical vocabulary — `$TARGET_WS/CONTEXT-MAP.md` and the per-context `CONTEXT.md` files. Don't invent synonyms. If the noun you need isn't in the glossary, that's a signal: either the work isn't well-formed yet (leave it for grilling) or you've found a genuine gap (note it in the report's "Operator actions needed" section). The READ contract is documented in `$TARGET_WS/docs/agents/domain.md`.

## Phase 1: Load Context (parallel)

Files:
1. `~/hydra/config/direction/vision.md`
2. `~/hydra/config/direction/goals.md`
3. `~/hydra/config/direction/priorities.md`
4. `~/hydra/config/direction/roadmap.md`
5. `~/hydra/config/feedback/to-planner.md`
6. `$TARGET_WS/CONTEXT.md` and `$TARGET_WS/direction/vision.md` — the target's OWN domain framing; the researcher prompts below deliberately carry no domain vocabulary of their own (issue #4411, INV-8) — read these first for what this target's domain, technical stack, and market actually are.

Live state (parallel):
```bash
TEST_CMD=$(jq -r '.verify.test' "$TARGET_WS/.hydra/manifest.json")
( cd "$TARGET_APP_DIR" && eval "$TEST_CMD" 2>&1 | tail -5 )

# Board state — GitHub Issues on $TARGET_GH_REPO (ADR-0031). REST only
# (gh api repos/...), never gh --json / GraphQL on the hot path (Decision 6).
REPO="$TARGET_GH_REPO"
TOTAL_ACTIVE=0
for lane in ready-for-agent in-progress blocked needs-triage; do
  n=$(gh api --paginate "repos/$REPO/issues?state=open&labels=$lane&per_page=100" \
        --jq '[.[] | select(has("pull_request")|not)] | length' 2>/dev/null \
        | python3 -c "import sys; print(sum(int(x) for x in sys.stdin.split() if x.strip()))" 2>/dev/null || echo 0)
  echo "$lane: $n"
  TOTAL_ACTIVE=$((TOTAL_ACTIVE + n))
done
echo "TOTAL ACTIVE BOARD: $TOTAL_ACTIVE (target: 30+)"

hydra metrics --count 20 | python3 -c "
import json,sys
d=json.load(sys.stdin)
trend=d.get('trend',d.get('metrics',[]))
merged=sum(1 for m in trend if int(m.get('tasksMerged',0))>0)
titles=[m.get('taskTitle','') for m in trend if m.get('taskTitle')]
print(f'Last 20 cycles: {merged} merged')
print('Recently merged:')
for t in titles[:10]: print(f'  - {t[:80]}')
"

git -C "$TARGET_WS" log --oneline -10
```

Compute **backlog gap**: `gap = max(0, 30 - $TOTAL_ACTIVE)` (the open-board active count from the loop above).

If `$focus` provided, pass it to ALL researcher agents.

## Phase 2: Parallel Research (5 agents)

Spawn **5 researchers in parallel**:
- **Claude:** ONE message with 5 `Agent` tool calls (parallel).
- **Codex:** 5 `codex exec --skill target-researcher` subprocesses with different focus args.

Each gets: full vision, current priorities, "What's been completed", recently merged titles, backlog gap, focus, and instruction to output JSON arrays. Each ALSO gets `$TARGET_WS/CONTEXT.md` and `$TARGET_WS/direction/vision.md` — the domain specifics (what market/product/protocol this target operates in, which vendor APIs it integrates, what "edge" or "quality" means for it) live there, not in this playbook (INV-8, issue #4411): a target-neutral research framework hardcoding one target's domain vocabulary is exactly the swap-readiness defect #4411 fixes.

### Agent 1: Domain Researcher
```
Research the target's OWN domain for new opportunities. Read $TARGET_WS/CONTEXT.md
and $TARGET_WS/direction/vision.md FIRST for what this target's domain actually is
(the product/market/protocol it operates in, its data sources, its notion of
"edge" or competitive advantage) — do not assume a domain; this prompt is
target-neutral by design (issue #4411).

Within that domain, look for:
- New data sources, feeds, or APIs the target could integrate
- Changes in the target's operating environment (new features, rules, fee/policy
  changes from any vendor/platform it depends on)
- Structural/mechanical opportunities specific to the target's domain (whatever
  "edge" or "quality" means there, per its own CONTEXT.md)

Output: [{"title","category":"domain","priority","description","why_now","done_when"}]
≥8 opportunities. Be specific — name exact APIs, data sources, mechanics (as
named in the target's own docs, never invented).
```

### Agent 2: Technical Researcher
```
Audit the target's codebase ($TARGET_APP_DIR):
- Architecture gaps: missing tests, fragile modules, untested execution paths
- Dependency health: outdated, deprecation warnings, security advisories
- Performance: slow queries, N+1, unindexed lookups in hot paths
- Type safety: any casts, missing validations, schema-validation gaps
- Test coverage: 0-coverage modules
- Code quality: large files, dead code
- Infrastructure: migrations, Redis hygiene, log noise

Explore $TARGET_APP_DIR/src/ via Glob/Grep/Read.
Output: [{"title","category":"technical","priority","description","why_now","done_when"}]
≥8 opportunities. Reference specific files and line numbers.
```

### Agent 3: Market Researcher
```
External changes bearing on the target's domain (read $TARGET_WS/CONTEXT.md /
direction/vision.md first for which vendors/platforms/regulators are relevant —
this prompt names none, by design, issue #4411):
- API changelogs / new endpoints for any vendor the target integrates
- Regulatory or policy changes relevant to the target's domain
- Competitor landscape, market structure changes
- Data vendor changes: coverage, quality, pricing
- Execution: latency benchmarks, reliability, rate limits of any dependency

WebSearch for current info.
Output: [{"title","category":"market","priority","description","why_now","done_when"}]
≥6 opportunities.
```

### Agent 4: Execution & Risk
```
Execution quality and risk, scoped to whatever the target's manifest declares as
its riskCritical.surface ($TARGET_WS/.hydra/manifest.json) — read that first so
this stays grounded in the target's OWN risk model rather than an assumed one:
- Execution quality: fill/completion rates, latency, partial-failure handling
- Risk controls: limits, correlation/exposure tracking, guardrails
- Reconciliation: settlement/completion state, orphan/stuck-state detection
- Recovery: crash recovery, partial-unwind, idempotency gaps
- Monitoring: latency tracking, outcome attribution, alerting gaps
- Live readiness: blockers to the target's next production-readiness milestone

Explore the manifest's riskCritical.surface paths under $TARGET_APP_DIR.
Output: [{"title","category":"execution","priority","description","why_now","done_when"}]
≥6 opportunities.
```

### Agent 5: Operator Experience
```
Operator workflow + dashboard:
- Dashboard gaps: data exists but isn't surfaced
- Navigation: page accessibility, workflow flow
- Monitoring: at-a-glance operational visibility into what matters for this target
- Alerting: condition triggers
- Configuration: settings that should be UI-configurable
- Onboarding: confusing parts for new operator

Explore $TARGET_APP_DIR/src/app/ (or the target's declared UI root).
Output: [{"title","category":"operator","priority","description","why_now","done_when"}]
≥5 opportunities.
```

## Phase 3: Synthesis (inline)

### 3a. Deduplicate
Remove exact/near duplicates. Merge same-work-different-angle. Keep version with most specific description and `done_when`.

### 3b. Score by vision's 6 decision vectors
1. Sharpen forecasts
2. Compress time-to-signal
3. Deepen structural understanding
4. Improve execution discipline
5. Protect the operation
6. Close the learning loop

Multi-vector items rank higher. Read the target's own `direction/vision.md` for which category of opportunity it weights highest within its domain.

### 3c. Filter completed
Drop anything matching "What's been completed" or recently merged.

### 3d. Classify
- **Top 7** → `priorities.md` (replacing current priority tasks)
- **Next 5–8 high-priority** → filed as `ready-for-agent` issues on the board (`gh issue create`)
- **Remaining medium** → filed as `needs-triage` issues
- **Low-priority** → filed as `needs-triage` issues (the sweep promotes the well-described ones)

## Phase 4: Write outputs

The two direction docs live at `$TARGET_WS/direction/priorities.md` and
`$TARGET_WS/direction/roadmap.md`. They are **git-tracked** files in the
target repo with an established `research(direction):` PR history — write
them there, never to a scratch location, and never gitignore them.

### 1. `priorities.md`
Full replacement of `$TARGET_WS/direction/priorities.md`, frontmatter `updated`, `refreshedBy: claude-research`, `tags`. Include current state summary, top 7, "What's been completed" (carry forward + add new), "What NOT to work on", regulatory awareness if relevant.

### 2. `roadmap.md`
Update existing `$TARGET_WS/direction/roadmap.md` — check off completed epics, add new ones, add milestones.

### 3. Commit the direction docs — branch + PR, NEVER leave them uncommitted (issue #1913)

The target's web service **builds and deploys from the `$TARGET_WS` main
checkout** (per the manifest's `verify.build`), and the deploy path
fast-forward-merges `main → origin/main` against that same checkout. If a
research cycle writes `direction/{priorities,roadmap}.md` and **stops without
committing**, the main checkout is left dirty and the ff-merge **aborts on the
dirty tree** — forcing a manual `stash → ff-merge → pop → restart` dance every
cycle (a documented recurrence on a prior Target).

So this step is **mandatory and not optional**: the research cycle owns
committing its own output. Land the edits on a dedicated feature branch and open
a `research(direction):` PR — the SAME branch → PR → CI → emulated-merge-gate
path every other Target change uses. **Never push direct to `main`**, and
**never gitignore the docs** (they are tracked operator-facing artifacts the
orchestrator reads as live state, with a deliberate commit history).

```bash
cd "$TARGET_WS"
# Only proceed if a direction doc actually changed this cycle.
if [ -n "$(git status --porcelain -- direction/priorities.md direction/roadmap.md)" ]; then
  DATE_TAG=$(date +%Y-%m-%d)
  BRANCH="research/direction-${DATE_TAG}-$(date +%s)"
  git checkout -b "$BRANCH"
  git add direction/priorities.md direction/roadmap.md
  git commit -m "research(direction): refresh priorities + roadmap (${DATE_TAG})"
  git push -u origin "$BRANCH"
  # Open the PR (emulated auto-merge: poll-to-green then merge per the target's
  # merge-on-green setup — do NOT --auto bypass CI on a free-private repo).
  gh pr create --repo "$TARGET_GH_REPO" \
    --title "research(direction): refresh priorities + roadmap (${DATE_TAG})" \
    --body-file /dev/stdin <<'PRBODY'
Automated `/hydra-target-research` direction-doc refresh.

Updates `direction/priorities.md` and `direction/roadmap.md` with this cycle's
re-prioritised top-7 + roadmap milestones.

Committing on a branch + PR (not leaving the docs uncommitted in the main
deploy checkout) so the deploy fast-forward merge never aborts on a dirty
tree — fixes the recurring stash-pop hazard (orchestrator issue #1913).
PRBODY
  git checkout main   # return the deploy checkout to a clean main
else
  echo "No direction-doc changes this cycle — nothing to commit."
fi
```

After this step, `git -C "$TARGET_WS" status --porcelain -- direction/` MUST
be empty. The deploy path then sees a clean tree and the ff-merge succeeds with
no manual stash dance. Leaving `direction/{priorities,roadmap}.md` uncommitted
in the main checkout is the exact regression this step exists to prevent — do
not skip it, and do not "fix" a dirty tree later by gitignoring or stashing the
docs (that orphans their tracked history / silently discards a cycle's output).

### 4. File items as GitHub issues (ADR-0031)

Items are filed on the **GitHub-Issues board (`$TARGET_GH_REPO`)** via `gh issue create`, not the retired Redis work-queue / `/backlog` API. **Dedup before filing** with a lexical `gh issue list --search` (ADR-0031 Decision 5 — lexical, not OpenViking semantic dedup); skip a candidate whose significant words already match an open issue.

```bash
REPO="$TARGET_GH_REPO"

# Dedup guard: skip if a lexically-similar open issue already exists.
# REST search pool only (gh api search/issues), never gh --json/GraphQL
# (ADR-0031 Decision 6 — keep the money-critical Target loop off the saturated
# GraphQL pool).
file_if_new() {  # $1=title  $2=body  $3=extra label (ready-for-agent | needs-triage)
  local title="$1" body="$2" label="$3"
  local q hit
  q=$(printf '%s' "repo:$REPO is:issue is:open in:title \"$title\"" | jq -sRr @uri)
  hit=$(gh api "search/issues?q=$q" --jq '.total_count' 2>/dev/null || echo 0)
  if [ "${hit:-0}" != "0" ]; then
    echo "skip (lexical dup): $title"; return 0
  fi
  gh issue create --repo "$REPO" --title "$title" --body "$body" --label "$label"
}
```

High-priority (5–8) → `ready-for-agent`:
```bash
file_if_new "<title>" "<why>" ready-for-agent
```

Medium / low (10–20) → `needs-triage`:
```bash
file_if_new "<title>" "<context>" needs-triage
```

**Target: total active open board ≥30.**

## Phase 5: Report

```
## Research Cycle — <date>

### Backlog: <before> → <after> items

### Findings by dimension
- Domain: <count> — <key finding>
- Technical: <count> — <key finding>
- Market: <count> — <key finding>
- Execution: <count> — <key finding>
- Operator: <count> — <key finding>

### Queued: <N> to work queue, <M> to triage

### Priority changes
- Added: ...
- Removed: ...
- Reordered: ...

### Operator actions needed
- ...
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
