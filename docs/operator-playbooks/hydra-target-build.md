---
name: hydra-target-build
description: Run a complete Hydra development build — picks a task, plans, challenges, executes, verifies, merges, and syncs state. Delegates to a subagent for context window protection.
when_to_use: "When the user wants to build a feature, fix a bug, run a dev cycle, or says 'build', 'ship', 'execute'"
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*) WebSearch(*) WebFetch(*)
arguments: [task]
---

# Hydra Build

Run one complete Hydra development build operating as every agent (planner, skeptic, executor, reporter). You write the code yourself — do NOT call Codex or the Hydra scheduler.

To prevent context window saturation under `/loop`, delegate the build to a child:
- **Claude:** spawn an `Agent` with the build prompt below.
- **Codex:** `codex exec --skill hydra-target-build` as a subprocess.

The parent only does pre-flight + relays the summary. The child does the heavy work.

## Step 1: Pre-flight (parent context)

Before delegating, run:

**Concurrency check (Claude only — does NOT block on Codex cycles):**
```bash
CLAUDE_LOCK=$(docker exec hydra-redis-1 redis-cli GET hydra:cycle:active:claude 2>/dev/null)
if [ -n "$CLAUDE_LOCK" ]; then echo "BLOCKED: another Claude cycle running ($CLAUDE_LOCK)"; fi
```

**WIP limit check:**
```bash
hydra backlog ls | python3 -c "
import json,sys
d=json.load(sys.stdin)
ip=d.get('inProgress',[])
if len(ip) >= 3:
    print(f'BLOCKED: WIP limit reached ({len(ip)}/3 in-progress)')
    for i in ip: print(f'  {i[\"id\"]} — {i[\"title\"][:60]}')
    sys.exit(1)
"
```

If either fails, stop. Do not delegate.

## Step 2: Delegate

Spawn the child with the prompt below. Pass `$task` if provided. The child returns ONLY a summary table.

---

<child-prompt>
Full autonomy: pick the task, plan, challenge your own plan, execute, verify, merge, sync state, report. Don't ask the user. If you hit a blocker, solve it.

## CRITICAL SAFETY RULE — READ FIRST (issue #542)

Two repos are in play: `~/hydra` (orchestrator) and `~/hydra-betting` (target). The harness `isolation: "worktree"` ONLY creates a worktree of the orchestrator repo (`~/hydra`). Writes to `~/hydra-betting` paths bypass that isolation and land on the main hydra-betting checkout — that is the bug fixed by this preamble.

Before running ANY `git`, `npm`, `Edit`, or `Write` against the target repo:

1. Run `pwd` and `git rev-parse --git-dir`. If cwd is `/home/gabe/hydra-betting` (the main target tree), ABORT. If cwd is `/home/gabe/hydra-betting/web`, ABORT — same tree.
2. Create a dedicated hydra-betting worktree (Step 0.6 below) and `cd` into it.
3. Verify isolation: inside the new worktree, `git rev-parse --git-common-dir` must resolve to `/home/gabe/hydra-betting/.git` AND `git rev-parse --git-dir` must contain `.git/worktrees/`. ABORT otherwise.
4. From that point on, every Edit/Write/Bash file mutation against the target uses **the worktree path only** — never construct absolute paths under `/home/gabe/hydra-betting/...` directly. If you must use an absolute path, anchor it to `$TARGET_WT/...`.

No fallback. No `cd ~/hydra-betting` in any step below — those bare paths are historical and have been replaced by `$TARGET_WT` references. If `$TARGET_WT` is unset when a step needs it, ABORT — that means Step 0.6 was skipped.

### 0. Register cycle
```bash
CYCLE_ID="claude-cycle-$(date -u +%Y-%m-%d-%H%M)"
hydra raw POST /cycle/register "{\"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\"}"
```

### 0.6. Create hydra-betting worktree (issue #542)

Symmetric with how `hydra-dev` worktree-isolates `~/hydra`. The target repo (`~/hydra-betting`) is a separate git repo — the harness can't isolate it for us. Create one ourselves:

```bash
TARGET_WT="/dev/shm/hydra-worktrees/hydra-betting-worktree-${CYCLE_ID}"
mkdir -p "$(dirname "$TARGET_WT")"

# Ensure base is fresh before branching off.
git -C ~/hydra-betting fetch origin main --prune
git -C ~/hydra-betting worktree add -b "feature/${CYCLE_ID}" "$TARGET_WT" origin/main

cd "$TARGET_WT"

# Verify isolation — ABORT if either check fails. Do NOT proceed on the main checkout.
COMMON_DIR=$(git rev-parse --git-common-dir)
GIT_DIR=$(git rev-parse --git-dir)
case "$COMMON_DIR" in
  /home/gabe/hydra-betting/.git|*/hydra-betting/.git) ;;
  *) echo "ABORT: hydra-betting worktree common-dir is $COMMON_DIR (expected ~/hydra-betting/.git)" >&2; exit 1 ;;
esac
case "$GIT_DIR" in
  *"/.git/worktrees/"*) ;;
  *) echo "ABORT: hydra-betting cwd is not a worktree (git-dir=$GIT_DIR)" >&2; exit 1 ;;
esac

# Worktrees do not share node_modules with the main checkout — install once per worktree.
# Cost: ~30–60s. Acceptable; this is the price of parallel-safe target builds.
(cd "$TARGET_WT/web" && npm ci --prefer-offline --no-audit --no-fund)
```

`scripts/branch-prune.sh` (issue #443) sweeps `/dev/shm/hydra-worktrees/hydra-betting-worktree-*` so we don't have to clean these up on the happy path. We DO remove the worktree in Step 9 on success — leaking is only acceptable on crash.

### 0.5. Drift check
```bash
hydra metrics --count 10 | python3 -c "
import json,sys
d=json.load(sys.stdin)
recent=[m.get('taskTitle','') for m in d.get('trend',[]) if int(m.get('tasksMerged',0))>0]
if recent:
    print('Recently merged (do NOT re-propose):')
    for t in recent[:10]: print(f'  - {t}')
"
```

### 1. Ground (read-only, in $TARGET_WT/web/)
```bash
cd "$TARGET_WT/web"
npm test
npm run typecheck
git log --oneline -5
git status --short
```

Load context (parallel):
- `~/hydra/config/direction/priorities.md`
- `~/hydra/config/direction/vision.md`
- `~/hydra/config/feedback/to-planner.md`
- `~/hydra/config/feedback/to-executor.md`
- `hydra backlog ls`
- `docker exec hydra-redis-1 redis-cli LRANGE "hydra:anchors:work-queue" 0 4`
- `hydra memory planner` && `hydra memory executor`

### 2. Anchor (select task)

If operator gave a task, use it. Otherwise priority order:
1. Work queue: `docker exec hydra-redis-1 redis-cli LRANGE hydra:anchors:work-queue 0 0`
2. Failing tests
3. Typecheck errors
4. Queued backlog (atomic claim — prevents Codex collision):
   ```bash
   CLAIMED=$(hydra raw POST /backlog/claim '{"claimedBy":"claude"}')
   ```
   `claimed: false` → fall through to step 5.
5. Priorities doc (skip "What's been completed").

Cross-reference drift check. Skip if recently merged.

### 3. Plan (planner role)

Read `~/hydra/config/agents/planner.md` and `~/hydra/config/feedback/to-planner.md`. Read relevant source. Design ONE bounded task:
- ≤5 files, 3–5 testable criteria, scope boundary, advances vision, hard verification commands.

Complexity:
- **quick-fix** (≤2 files, ≤3 criteria, failing-test): skip skeptic.
- **standard** (3–5 files, 4–8 criteria): full ceremony.
- **complex** (>5 files): split.

### 3.5. Self-declare scope (issue #396)

Because hydra-target-build picks its own task — there is no GitHub issue with a pre-existing scope contract — the child MUST write its own scope contract before opening the PR. This is the subagent-side replacement for the deleted `reconcilePlanVsActual()` step (control-loop step 6.5, removed in PR #400).

Compute the in-scope list from the plan's `scopeBoundary.in`. Record it locally so it can be embedded in the PR body in Step 7:

```bash
SCOPE_IN_LIST=$(cat <<'EOF'
- `web/src/foo.ts`
- `web/src/foo/`
EOF
)
```

If executing requires touching a file outside the planned scope (shared fixture, adjacent import), record a justification rationale at the same time:

```bash
SCOPE_JUSTIFICATIONS=$(cat <<'EOF'
scope-justification: `web/src/test-helpers.ts` — shared fixture required by the new test
EOF
)
```

CI's `scope-check` gate (`.github/workflows/ci.yml` in the orchestrator repo, mirrored in the target repo if present) reads these sections from the PR body. Skipping this step doesn't block the build today (no hard requirement on PR body shape for target-repo PRs), but it's how the orchestrator learns the subagent's intended blast radius — and it's the contract reviewers + `hydra-qa` use to spot scope creep.

### 4. Skeptic (skip for quick-fix)

Read `~/hydra/config/agents/skeptic.md`. Challenge:
1. Anchored to real artifact?
2. Duplicating recent work? (`git log --oneline -20`)
3. Scope bounded? >5 files → reject.
4. Verification hard? (shell commands, not "review")
5. Smallest possible move?
6. Before deleting: `grep -rn "from.*['\"].*<filename>" src/`

If rejected, replan narrower.

### 5. Execute

Read `~/hydra/config/agents/executor.md` and `~/hydra/config/feedback/to-executor.md`.

Step 0.6 already created `$TARGET_WT` on branch `feature/$CYCLE_ID` off `origin/main`. Stay in that worktree — do NOT `cd ~/hydra-betting`, do NOT `git checkout main`, do NOT `git pull` from the main checkout (that's the race that #542 is fixing).

```bash
cd "$TARGET_WT"
git status --short    # must be clean — we just branched off origin/main
```

**Path discipline for Edit/Write tools (issue #542):** every `file_path` argument MUST be either repo-relative (e.g. `web/src/foo.ts`) when cwd is `$TARGET_WT`, OR an absolute path anchored to `$TARGET_WT/...`. Do NOT construct paths like `/home/gabe/hydra-betting/web/...` — those bypass the worktree and write to the main checkout (the exact bug behind #542).

Rules:
- Smallest change wins (20 lines > 200 lines).
- Tests mandatory — write alongside.
- Match existing patterns.
- NEVER delete `src/lib/providers/` or `src/lib/execution/`.
- NEVER "cleanup" / "remove unused" commits.
- Migrations: update `drizzle/meta/_journal.json`.
- `vi.mock("server-only", () => ({}))` in tests importing server modules.
- Read `web/AGENTS.md` — Next.js 16 APIs may differ from training.
- **Stay in scope.** If you must touch a file outside the Step 3.5 in-scope list, append it to `SCOPE_JUSTIFICATIONS` with a one-line reason before continuing.
- **Co-located glossary rule.** Treat any `CONTEXT.md` sibling of a file you're editing as required reading before the edit. Use that file's canonical vocabulary in identifiers, variable names, test names, and comments. The design-concept artifact (if present at `hydra:design-concept:$ANCHOR`) already carries the issue-relevant terms forward — the co-located read is the residual case for files the artifact didn't anticipate.

### 6. Verify (NOT an agent)
```bash
cd "$TARGET_WT/web"
npm run typecheck    # must pass
npm test             # must pass; count must not decrease
```

After the first edit batch, sanity-check that the edits actually landed in the worktree (cheap canary against the #542 ghost-edit symptom):
```bash
( cd "$TARGET_WT" && git diff --name-only ) | head
# If this is empty when Edit calls were made, edits leaked to the main checkout —
# ABORT and do not push. Run `git -C ~/hydra-betting status --short` to confirm.
```

Fail → fix → re-verify. After 2 failed fixes, abandon branch.

For orchestrator changes (~/hydra/): `node --check src/<file>.ts` + `npm test` + restart service.

### 6.5. Glossary / ADR gate (per target `docs/agents/domain.md`)

Before opening the code PR (or pushing the feature branch), answer the WRITE protocol's two yes/no questions documented in `~/hydra-betting/docs/agents/domain.md`. Both answers go in the code PR body (or merge commit body, for direct-to-main merges) **even when both are "none"** — the declaration is the audit trail.

```
Glossary impact: <term — one-line gloss | none>
ADR impact:     <one-line description | none>
```

If "Glossary impact" is not `none`:
- Identify the right file per the target's domain.md ("Where the glossary/ADR change lands" section).
- Open a **separate** PR from a sibling branch (`feature/$CYCLE_ID-glossary` off the same base) containing **only** the CONTEXT.md / CONTEXT-MAP.md delta.
- Label it `ubiquitous-language`.
- Reference its number from the code PR body. Do NOT bundle the glossary change into the code PR.

If "ADR impact" is not `none`:
- Same separate-PR pattern. ADR file is `docs/adr/NNNN-kebab-slug.md` or `web/src/lib/<context>/docs/adr/NNNN-kebab-slug.md` per scope.
- Same `ubiquitous-language` label. Same code-PR reference.

Gating discipline: the criteria are deliberately strict. **Both** ADR criteria must hold (hard-to-reverse AND surprising-to-a-reader AND has a real trade-off). Glossary updates fire only when you can write the one-line gloss now — if you can't, there's no glossary entry to add. Most builds will declare `none / none` — that's the expected steady state. The design-concept gate (hydra-grill) already caught the anticipated terms upfront; this step covers only the residual case where new vocabulary surfaced during implementation.

### 7. Merge (with merge lock)

Before merging, if this build went via a PR (orchestrator-side changes), the PR body MUST include the self-declared scope captured in Step 3.5:

```markdown
## Self-declared scope

The build picked this task autonomously — these are the files the planner intended to touch:

## Files in scope

$SCOPE_IN_LIST

$SCOPE_JUSTIFICATIONS
```

For direct-to-main merges (target repo), embed the same block in the merge commit message body so reviewers can audit blast radius after the fact:

```bash
for attempt in 1 2 3; do
  LOCK=$(hydra raw POST /merge/lock "{\"cycleId\":\"$CYCLE_ID\"}")
  if echo "$LOCK" | python3 -c 'import json,sys;sys.exit(0 if json.load(sys.stdin).get("acquired") else 1)' 2>/dev/null; then break; fi
  sleep $((attempt * 10))
done

# Push the worktree's feature branch first so the main checkout can merge a remote ref.
( cd "$TARGET_WT" && git push -u origin "feature/$CYCLE_ID" )

# Merge on the main checkout — the worktree itself is on the feature branch, so we
# can't merge into main from inside it. The merge-lock serialises this step across
# concurrent dispatches.
cd ~/hydra-betting
git fetch origin main
git checkout main && git pull --ff-only origin main
git merge --no-ff "feature/$CYCLE_ID" -m "merge: claude cycle — <task title>" \
  -m "## Files in scope" -m "$SCOPE_IN_LIST" -m "$SCOPE_JUSTIFICATIONS"
git push origin main
git branch -d "feature/$CYCLE_ID"

hydra raw POST /merge/unlock
```

### 7.5. Deploy + post-deploy health
```bash
systemctl --user restart hydra-betting-web.service

for i in $(seq 1 18); do
  STATUS=$(systemctl --user is-active hydra-betting-web.service 2>/dev/null)
  [ "$STATUS" = "active" ] && break
  sleep 5
done

if [ "$STATUS" != "active" ]; then
  echo "DEPLOY FAILED: service not active after 90s"
  journalctl --user -u hydra-betting-web.service --no-pager -n 20 2>&1 | grep -iE "error|fail|exit" | tail -5
  cd ~/hydra-betting    # revert runs against the main checkout — merge has already landed there
  git revert --no-edit -m 1 HEAD
  git push origin main
  systemctl --user restart hydra-betting-web.service
  echo "REVERTED: deploy failure"
fi

if [ "$STATUS" = "active" ]; then
  sleep 5
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3333/api/health)
  [ "$HTTP" != "200" ] && echo "DEPLOY WARNING: /api/health=$HTTP" && \
    journalctl --user -u hydra-betting-web.service --since "2 min ago" --no-pager 2>&1 | grep -iE "error|unhandled|reject" | tail -5
fi
```

Don't fail the cycle on a degraded health check (warning OK). DO fail + revert if service won't start.

### 8. Post-merge verify (auto-rollback)
```bash
npm test    # compare to pre-merge
```

Regression → revert + restart + report.

### 8.5. Worktree cleanup (issue #542)

On success, remove the hydra-betting worktree we created in Step 0.6. On failure, `scripts/branch-prune.sh` will GC it on the next daily sweep — leaking is acceptable on crash but not on the happy path.

```bash
git -C ~/hydra-betting worktree remove --force "$TARGET_WT" 2>&1 || \
  echo "warn: worktree remove failed for $TARGET_WT — branch-prune.sh will GC it later"
```

### 9. State sync (critical)

Move backlog item to done:
```bash
TASK_TITLE="<title>"
ITEM_ID=$(hydra backlog ls | python3 -c "
import json,sys
d=json.load(sys.stdin)
title=sys.argv[1].lower()
for lane in ['inProgress','queued','backlog']:
    for item in d.get(lane,[]):
        if title in item.get('title','').lower() or item.get('title','').lower() in title:
            print(item['id']); sys.exit(0)
print('')" "$TASK_TITLE")
[ -n "$ITEM_ID" ] && hydra backlog move "$ITEM_ID" done
```

Record completion:
```bash
hydra queue add "COMPLETED: <task title>" -d "Merged by Claude build"
```

Record metrics (shared with Codex):
```bash
hydra raw POST /metrics/record "{
  \"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\",
  \"tasksAttempted\":1,\"tasksMerged\":1,\"tasksFailed\":0,
  \"testsBefore\":$TESTS_BEFORE,\"testsAfter\":$TESTS_AFTER,
  \"filesChanged\":$FILES_CHANGED,\"totalDurationMs\":$DURATION_MS,
  \"taskTitle\":\"$TASK_TITLE\",\"anchorType\":\"$ANCHOR_TYPE\",
  \"regressionIntroduced\":false
}"
```

Publish event:
```bash
hydra raw POST /events/publish "{
  \"type\":\"cycle:completed\",\"correlationId\":\"$CYCLE_ID\",
  \"payload\":{\"source\":\"claude\",\"taskTitle\":\"$TASK_TITLE\",\"commitSha\":\"$COMMIT_SHA\",\"merged\":true,\"testDelta\":$((TESTS_AFTER - TESTS_BEFORE))}
}"
```

Complete cycle registration:
```bash
hydra raw POST /cycle/complete "{\"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\",\"status\":\"completed\"}"
```

On failure — lesson capture for shared learning (issue #392).
This is the only post-cycle writer to `hydra:memory:executor:patterns` for
Claude-driven builds after #383 deletes codex-runner. The endpoint forwards
to `recordPattern()` so the existing 3-hit auto-promotion to
`config/feedback/to-executor.md` keeps working.
```bash
# Pick the cue that matches the failure mode:
#   verification-failure | no-diff | rollback
CUE="verification-failure"   # change per failure mode
hydra raw POST /memory/subagent-lesson "{
  \"skill\":\"hydra-target-build\",
  \"outcome\":\"$CUE\",
  \"cue\":\"$CUE\",
  \"context\":\"$CYCLE_ID: $TASK_TITLE — <what failed>\",
  \"cycleId\":\"$CYCLE_ID\"
}"
```

API failures: log but don't fail the build. The endpoint is idempotent on
`(skill, outcome, cue)` — multiple calls for the same logical event merge
into one pattern (hit count increments).

### 9.5. Friction Report (issue #512 — ALWAYS, even on success)

The child agent ALSO emits a `## Friction Report` section in its return,
even on a clean merge. Each item is a piece of soft friction the agent
worked around without failing — captured so successor dispatches don't
re-discover it.

**Child-prompt contract (the dispatched BG agent MUST emit this):**

```markdown
## Friction Report

- cue: stale-local-master-ref
  workaround: used origin/master for diff base
  context: git rev-parse origin/master
- cue: vitest-flake-in-foo-spec
  workaround: re-ran the specific suite; passed on second attempt
  context: src/foo/__tests__/foo.spec.ts
```

Rules:
- `cue` MUST be kebab-case, stable across runs.
- `workaround` is exactly one line.
- `context` is exactly one line.
- If no friction worth noting, emit `- (none)`.

**Parent post-flight:**

After the BG returns, parse each `## Friction Report` item and POST to
`/api/memory/subagent-friction`:

```bash
hydra raw POST /memory/subagent-friction "{
  \"skill\":\"hydra-target-build\",
  \"cue\":\"$CUE\",
  \"workaround\":\"$WORKAROUND\",
  \"context\":\"$CONTEXT\",
  \"cycleId\":\"$CYCLE_ID\"
}"
```

Idempotent on `(skill, cue)`. When the same cue crosses the
`PROMOTION_THRESHOLD` (3 hits), a `meta-friction` GitHub issue is
auto-opened (or comment-bumped). Failure to POST is logged but never
fails the build.

### 10. Report (summary table only)

| Step | Result |
|------|--------|
| Ground | X tests passing, typecheck status |
| Anchor | task title (anchor type) |
| Plan | scope: N files, M criteria |
| Self-declared scope | N in-scope, M justified out-of-scope |
| Skeptic | approved/skipped (reason) |
| Verify | test count change (before → after) |
| Merge | commit SHA |
| State sync | backlog item moved / not found |
</child-prompt>

## Context

- **Hydra orchestrator**: `~/hydra/` (TS, ESM, node:test)
- **Target**: `~/hydra-betting/web/` (Next.js 16, vitest, 3100+ tests)
- **Config**: `~/hydra/config/direction/` and `~/hydra/config/feedback/`
- **Personalities**: `~/hydra/config/agents/`
- **Backlog/API**: `bin/hydra` → http://localhost:4000
- **Redis**: `docker exec hydra-redis-1 redis-cli`
- **Stack**: Next.js 16, React 19, Tailwind 4, Zod 4, Drizzle, vitest

Read `web/AGENTS.md` before assuming Next.js conventions — APIs may differ from training data. Use atomic backlog claims, merge locks, metrics, and events for parallel execution with Codex cycles.
