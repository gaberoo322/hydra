---
date: 2026-04-30
reviewer: claude-architect
focus: general
overall_score: 6.1
---

# Hydra Architecture Review — 2026-04-30

## Executive Summary

Hydra is a working autonomous development system that has produced 2,810 merges with a 1.0% all-time revert rate, growing the target project from 154 to 3,041 tests. The core control loop (plan -> execute -> verify -> merge) is sound and produces correctly-scoped, tested code. However, **28% of cycles are wasted on "Planner produced no task"**, the knowledge system (OpenViking) returns zero results, the scheduler is stopped (not running autonomously), and research outpaces build capacity 3:1. The agent memory system works well (patterns auto-promote to feedback files) but the specs and Kanban systems are unused. Fixing the no-task waste alone would raise the effective merge rate from 56% to ~78%.

## Scorecard

| # | Dimension | Score | Key Finding |
|---|-----------|-------|-------------|
| 1 | Control Loop | 7 | 56% merge rate, 1.8% revert rate, but 28% no-task waste |
| 2 | Research Pipeline | 6 | 74% conversion rate, but 164 research cycles vs ~50 builds (3:1 imbalance) |
| 3 | Grounding & Verification | 8 | npm test + tsc gates work; 3,041 tests; worktree isolation active |
| 4 | Agent Quality | 6 | Good feedback files, but planner fails to produce a task 28% of the time |
| 5 | Autonomy | 4 | Scheduler stopped; only 1 scheduled cycle ever run; system is manual |
| 6 | Knowledge & Learning | 5 | Pattern memory works (91-hit scope-creep rule), but OpenViking returns empty |
| 7 | Architecture Fitness | 7 | Clean stack (37 files, 2 deps, Redis+systemd), manageable and testable |
| 8 | Cost Efficiency | 6 | $1.55/cycle avg, but 28% waste; $2.21 estimated per merged feature |

**Overall: 6.1/10**

## Key Findings

### What's Working

1. **Hard verification gates** -- npm test + tsc as non-negotiable merge gates is the right architecture. The 1.8% revert rate (24/1,353 in 14 days) proves it catches nearly all regressions before merge.

2. **Test growth is massive** -- From 154 to 3,041 passing tests. The executor is writing real, meaningful tests alongside features. This is rare in autonomous systems.

3. **Agent memory pattern system** -- The two-tier architecture (Redis patterns -> feedback file promotion at 5 hits) is well-designed and actively working. The planner's `scope-creep` pattern at 91 hits with auto-promotion to `to-planner.md` shows the system learning from real failures. Executor's `no-diff` (14 hits) and `verification-failure` (25 hits) patterns are similarly valuable.

4. **Scope-adaptive planning** -- Classifying tasks as quick-fix/standard/complex/high-risk and adjusting the pipeline (skip gates for quick-fix, add nano-model review for high-risk) is smart resource allocation.

5. **Deterministic preflight replacing full skeptic** -- Removing the Codex-powered skeptic agent in favor of a deterministic 4-point checklist was a good efficiency move. The old skeptic had a rubber-stamping problem; deterministic checks are more reliable.

6. **Research-to-queue conversion** -- 74% of research opportunities become queued work items. The research loop is productive at finding real work.

### What's Not Working

1. **"Planner produced no task" -- 28% of all cycles (14/50)**
   This is the single biggest efficiency problem. The planner is called with an anchor, spends ~61 seconds of frontier-model inference, and produces nothing. Most are `user-request` anchors. Root causes likely include:
   - Queue items that are already completed or too vague for the planner to act on
   - Anchors that reference completed priorities (the "completed" items in priorities.md)
   - Insufficient pre-validation of anchor actionability before invoking the planner

2. **OpenViking knowledge system is inert**
   `searchKnowledge()` in `codex-runner.ts` calls `/api/v1/search/find` -- it returns empty results every time. OpenViking's `/health` says it's healthy, but the search index appears empty. The `knowledge-indexer.ts` (208 lines) exists but isn't populating data that agents can find. This means **agents operate without any accumulated knowledge context** -- they only see the current grounding snapshot and their personality/feedback files.

3. **Scheduler is effectively unused**
   The scheduler shows `stopped` with only 1 cycle ever run. Despite 164 research cycles running, the build scheduler is not driving autonomous execution. The system requires manual `POST /cycle/start` to build anything. This undermines the core value proposition of an autonomous dev system.

4. **Research outpaces execution 3:1**
   164 research cycles have produced opportunities, but only ~50 build cycles have consumed them. The work queue has 6 items including 3 duplicates of the same task. Research is producing faster than execution can consume, leading to stale queue items.

5. **Specs and Kanban are hollow**
   Zero active specs. All Kanban lanes (queued, inProgress, blocked, triage, done) are at 0 items. These systems exist architecturally but aren't being used. Work flows through the queue and research loop, bypassing the Kanban entirely.

6. **Work queue has duplicates**
   "Add stream freshness route-quality scoring" appears 3 times in the queue. There's also a "COMPLETED:" item still in the queue. Queue hygiene is poor.

## Recommendations

### Quick Wins (< 1 day)

**1. Pre-validate anchors before calling the planner**
- **What**: Before invoking the frontier-model planner, check if the anchor reference matches a completed item in `priorities.md` (the "What's been completed" section) or if the queue item is stale/duplicate. Skip the cycle with a fast abort instead of burning $1.55 on a no-task result.
- **Why**: Eliminates 28% waste -> improves effective merge rate from 56% to ~78%. Saves ~$21/50 cycles.
- **Evidence**: 14/50 cycles produced "Planner produced no task", all consuming ~61s of frontier inference.
- **Files**: `control-loop.ts` (before `runPlannerAgent`), `anchor-selection.ts` (add staleness check)
- **Risk**: Low -- worst case is skipping a legitimate anchor, which circuit-breaker already handles via reframe.
- **Dependency**: None.

**2. Deduplicate work queue on insertion**
- **What**: Add a dedup check in `POST /queue` and in the research loop's auto-queue path. Compare `reference` field against existing queue items before inserting.
- **Why**: Prevents wasted cycles on duplicate work. Currently 3/6 queue items are the same task.
- **Evidence**: "Add stream freshness route-quality scoring" appears 3 times in the queue.
- **Files**: `api.ts` (POST /queue handler), `research-loop.ts` (auto-queue logic)
- **Risk**: None -- dedup is purely additive.
- **Dependency**: None.

**3. Diagnose and fix OpenViking search**
- **What**: Check if the knowledge indexer is actually running and indexing documents. Verify the search endpoint `/api/v1/search/find` works. The indexer may have a configuration or API version mismatch.
- **Why**: Agents currently operate without knowledge context. Fixing this means planners and executors get relevant prior work, reducing redundant proposals and improving code quality.
- **Evidence**: `searchKnowledge()` returns empty; OpenViking `/health` is ok but search yields 0 results.
- **Files**: `knowledge-indexer.ts`, `codex-runner.ts:374-406`
- **Risk**: Low -- OpenViking is a separate service; fixing its integration doesn't affect the core loop.
- **Dependency**: OpenViking must be running (it is).

### Medium Efforts (1-5 days)

**4. Throttle research-to-build ratio**
- **What**: Add a ratio constraint to the scheduler: don't run another research cycle until the build queue is below a threshold (e.g., 3 items). Currently research runs unthrottled while builds are manual.
- **Why**: 164 research cycles vs ~50 builds creates a growing backlog of stale opportunities. Research should feed execution, not outrun it.
- **Evidence**: 3:1 research-to-build ratio, duplicate queue items from repeated research.
- **Files**: `scheduler.ts` (cycle selection logic), `research-loop.ts`
- **Risk**: Could slow research discovery during active build periods. Mitigate with operator override.
- **Dependency**: Queue dedup (recommendation #2) should land first.

**5. Wire mutation testing into the verification step**
- **What**: `mutation-testing.ts` exists but it's unclear if it's actually called during cycles. Wire it into `runVerification()` for standard and complex tasks: after tests pass, inject a mutation into the changed files and verify tests catch it.
- **Why**: Meta's JIT testing shows 4x higher bug detection with mutation-validated tests. This would catch the category of regressions that cause the 1.8% revert rate -- cases where tests pass but don't actually validate the change.
- **Evidence**: Meta's paper (arXiv 2601.22832), Hydra's existing module, 24 reverts in 14 days.
- **Files**: `mutation-testing.ts`, `verifier.ts`, `control-loop.ts` (verification step)
- **Risk**: Medium -- mutation testing adds latency. Only run on standard/complex tasks, not quick-fix.
- **Dependency**: None.

**6. Activate the scheduler with build cycles**
- **What**: Start the scheduler and configure it to alternate between research and build cycles based on queue depth. Build when queue > 0, research when queue <= 2.
- **Why**: The system's autonomous value comes from running continuously. With fixes #1-#3 in place, the loop is reliable enough to run unattended.
- **Evidence**: Scheduler has run only 1 cycle. All execution is manual POST /cycle/start.
- **Files**: `scheduler.ts`
- **Risk**: Medium -- need confidence in the pre-validation (fix #1) before auto-running. Start with a low cadence (15-min intervals).
- **Dependency**: Fixes #1, #2, #3.

### Strategic Shifts (1-2 weeks)

**7. Adopt Reflexion-style episodic memory for failed cycles**
- **What**: When a cycle fails (no-task, abandoned, verification failure), generate a natural-language reflection: what was attempted, why it failed, what should be different next time. Store these reflections and inject them as context when the same anchor is retried.
- **Why**: The Darwin Godel Machine improved from 20% to 50% on SWE-bench by adding "a history of what has been tried before and why it failed." Princeton's Reflexion framework shows that natural-language self-critique outperforms random retry. Hydra's current circuit-breaker escalates after 3 failures, but doesn't carry forward WHY something failed.
- **Evidence**: 28% no-task rate, 12% other-abandoned rate. DGM paper (arXiv 2505.22954), Reflexion framework.
- **Files**: New module or extension to `agent-memory.ts`, integration in `control-loop.ts`
- **Risk**: Reflection quality depends on the model. Use nano-tier for cost efficiency.
- **Dependency**: None, but benefits from fix #3 (knowledge system) for storage.

**8. Implement diff-aware test generation at verification time**
- **What**: Following Meta's JIT testing pattern: when the executor produces a diff, generate additional tests specifically targeting the changed code paths. Use mutation testing to validate these tests actually catch faults.
- **Why**: The current verification only runs existing tests. Diff-aware generation ensures new code is tested for the specific behaviors it introduces, not just that it doesn't break existing tests. Meta reports 4x bug detection improvement.
- **Evidence**: Meta's JIT testing (Engineering at Meta, Feb 2026), 22,126 tests evaluated with 4x catch rate.
- **Files**: New module integrating `mutation-testing.ts` + `verifier.ts` + executor prompt
- **Risk**: High cost per cycle (additional LLM call for test generation). Use codex-tier model. Only for standard/complex tasks.
- **Dependency**: Fix #5 (mutation testing integration).

## Comparison to State of the Art

| Dimension | Hydra | State of Art | Gap |
|-----------|-------|-------------|-----|
| Merge rate | 56% (effective) | Aider 49.2%, OpenHands 77.6% (SWE-bench) | Comparable but different benchmarks |
| Architecture | Planner/Executor/Verifier | Same triad pattern | Aligned |
| Model routing | 3-tier (frontier/codex/nano) | 90/10 cascade (87% savings) | Hydra does this |
| Verification | npm test + tsc | Meta JIT + mutation (4x detection) | Gap: no JIT testing |
| Self-improvement | Pattern memory + promotion | Reflexion + DGM (episodic memory) | Gap: no episodic failure memory |
| Knowledge | OpenViking (broken) | Continuum Memory / editable RAG | Gap: system is inert |
| Research -> Code | 74% conversion | GROUNDING.md / epistemic docs | Hydra has priorities.md (similar) |
| Autonomy | Manual (scheduler stopped) | Long-running autonomous loops | Gap: not running autonomously |
| Cost | $1.55/cycle, $2.21/merge | 60-80% reduction possible with caching | Gap: no prompt caching |

**Hydra's architectural choices are sound** -- the Planner/Executor/Verifier triad, model routing, deterministic preflight, and pattern memory all align with industry best practices. The gaps are primarily in **operational activation** (scheduler stopped, OpenViking dead, specs unused) rather than architectural design. The system has been carefully engineered but is underutilized.

## Next Review Triggers

Re-run this assessment when:
1. The scheduler has been running for 7+ continuous days
2. 100+ additional build cycles have completed
3. OpenViking is fixed and agents are getting knowledge context
4. Mutation testing is wired into the verification loop
5. The no-task rate drops below 10%
6. Major architectural changes are proposed (new agent types, new model tiers, etc.)
