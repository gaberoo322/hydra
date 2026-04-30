---
date: 2026-04-30
reviewer: claude-architect
focus: full system review (third in session, post-implementation)
overall_score: 7.1
prior_score: 7.4
prior_date: 2026-04-30
---

# Hydra Architecture Review — 2026-04-30 (Evening)

## Executive Summary

This is the third review in the current session. Since the 7.4 review earlier today, 8 recommendations were implemented: executor scope creep fix, scope enforcement gate (Step 6.9), planner reframe with priorities.md, executor mutation self-check, adversarial validation precision tracking, worktree isolation, periodic regression hunt anchor, and a full build cycle that fixed 19 failing tests + 37 typecheck errors. Despite these implementations, the evidence shows several have not yet taken effect. The merge rate dropped from 78% to 56% (28/50), "Planner produced no task" failures surged to 28% (14/50), scope creep remains at 14-15 files per merge because the planner emits empty `scopeBoundary.in` (bypassing the gate entirely), and the scheduler is currently stopped. The revert rate remains ~1.6/day (11 in 7 days). The system has more safety gates than ever but key ones are not wired correctly, and the planner is struggling to find work despite 7 priority items.

**Score adjustment: 7.4 -> 7.1 (-0.3).** The drop reflects degraded merge rate, planner starvation, and scope gate bypass — partially offset by improved test health and architecture maturity.

## Scorecard

| # | Dimension | Score | Delta | Key Finding |
|---|-----------|-------|-------|-------------|
| 1 | Control Loop | 6.5/10 | -1.0 | Merge rate dropped 78%->56%. 14 "no task" cycles. Scope gate bypassed. |
| 2 | Research Pipeline | 8/10 | +0 | 74% conversion, 62 opportunities, 46 auto-queued. Stable and productive. |
| 3 | Grounding & Verification | 7.5/10 | +0 | 71 orchestrator tests pass. MT live but AV absent from recent merges. 11 reverts/7d. |
| 4 | Agent Quality | 5/10 | -1.0 | 28% of cycles produce no task. Planner emits empty scopeBoundary. Repeated tasks. |
| 5 | Autonomy | 7/10 | -0.5 | Scheduler stopped. No failed services. 1450 commits/7d shows high throughput when running. |
| 6 | Knowledge & Learning | 6.5/10 | +0.5 | 9 patterns, 188 total hits (up from 170). Pattern system active and growing. |
| 7 | Architecture Fitness | 8.5/10 | +0.5 | 41 source files, 71 tests, 34 config files. Worktree isolation added. Clean modules. |
| 8 | Cost Efficiency | 7/10 | -1.0 | $1.60/cycle avg but 45% of recent spend is on "no task" cycles ($0.71-$1.64 each wasted). |

**Overall: 7.1/10** (down from 7.4)

## Key Findings

### What's Working

1. **Architecture is the strongest dimension.** 41 TypeScript source files across well-separated concerns, 71 regression tests (all passing), 34 config files for operator control. The control loop at 1299 lines is manageable with clear step numbering. Worktree isolation, mutation testing, adversarial validation, scope enforcement, and preflight gates are all structurally present.

2. **Research pipeline is reliable.** 10 recent research cycles found 62 opportunities and auto-queued 46 (74% conversion). priorities.md was updated by the research cycle with Polymarket CLOB V2 urgency, regulatory awareness, and well-structured priority items. The "DO NOT re-propose" section prevents churn.

3. **Test health recovered.** The build cycle fixed all 19 failing tests and 37 typecheck errors. The target project has 3037 tests (up from 2997 — delta +40 in the window). Orchestrator has 71 tests, all green.

4. **Learning system is growing.** 9 patterns across 3 agents with 188 cumulative hits (up from 170). The pattern-to-feedback auto-promotion is working. Planner has 5 patterns (119 hits), executor 2 (39 hits), skeptic 2 (30 hits).

5. **Cost per productive cycle is reasonable.** Merged cycles cost ~$1.60 avg. The recent architecture improvements (scope-adaptive planning, model routing) keep per-cycle costs controlled.

### What's Not Working

1. **Scope enforcement gate is completely bypassed.** The Step 6.9 gate requires `task.scopeBoundary.in.length > 0`, but the planner is emitting empty `scopeBoundary` objects. All 10 recent reality reports show `0 planned` files. The gate literally never fires. This is the most critical finding — a safety gate was implemented but is structurally inert because the planner doesn't populate the field it depends on.

2. **Planner starvation is the dominant failure mode.** 14 of 50 cycles (28%) end with "Planner produced no task" — up from 8/50 (16%) in the prior review. The planner reframe prompt now includes priorities.md and accomplishments, but this may have paradoxically made the planner *more* conservative (seeing the completed list and concluding work is done). 9 of the last 20 cycles (45%) produced no task.

3. **Merge rate declined significantly.** 56% (28/50) vs 78% (39/50) in the prior review. The 20 abandoned cycles are almost entirely planner starvation, not execution failures (only 1 failed, 1 rolled back).

4. **Repeated task thrashing.** "Publish KXNBA first-live-run reconciliation proof fixture" was attempted 3 times. This suggests either the task is poorly specified, the executor can't complete it, or the drift detection isn't catching near-duplicates.

5. **Adversarial validation is absent from recent merges.** All 5 recent reality reports show "no-AV". Only 1 of 5 shows mutation testing (100% kill rate). The gates exist but aren't consistently executing.

6. **Revert rate unchanged.** 11 reverts in 7 days (~1.6/day). The new safety gates (scope enforcement, worktree isolation, MT, AV) haven't had enough runtime to impact this, but the scope gate bypass means the most common issue type (scope creep) remains unguarded.

## Comparison to State of the Art (2026)

### vs. Hermes Agent (Nous Research)
Hermes Agent's learning loop distills successful procedures into reusable skill documents, achieving 40% faster task completion with self-created skills vs fresh instances. Hydra's WHEN/CHECK/BECAUSE pattern system is functionally similar but less sophisticated — it records failure patterns rather than successful procedures. The key gap: Hydra learns what NOT to do (188 prevention hits) but doesn't encode what WORKS (no "skill" equivalent).

### vs. Meta JiT Testing
Meta's Just-in-Time testing achieves 4x bug detection through mutation testing integrated into the code review loop. Hydra's mutation testing is architecturally present but inconsistently executed (1 of 5 recent merges had MT). The executor mutation self-check instruction was added but isn't producing visible results in reality reports.

### vs. Industry Mutation Testing Thresholds
Gartner recommends 70% mutation score for critical paths, 50% for standard features. Hydra's single observed cycle achieved 100% kill rate, but the sample size (1 cycle, 2 mutants) is too small to draw conclusions. The threshold should be set and enforced once more data accumulates.

### vs. Anthropic Agentic Coding Trends
The 2026 Agentic Coding Trends Report emphasizes context engineering over prompt design. Hydra's planner starvation problem is fundamentally a context engineering failure — the planner has the priorities.md content but lacks sufficient context about what remains undone vs what was completed. The "completed" list may be crowding out the "todo" list in the context window.

## Recommendations

### Quick Wins (< 1 day)

**1. Fix scope gate bypass: planner must emit scopeBoundary.in** (CRITICAL)
- **What**: In `planner-prompt.ts`, make `scopeBoundary.in` a required field in the task schema and add a post-planner validation that rejects tasks with empty `scopeBoundary.in`. If the planner doesn't specify files, synthesize from the task description.
- **Why**: The Step 6.9 scope gate was built but never fires because `task.scopeBoundary.in` is always empty. This is a wiring defect, not a design defect.
- **Evidence**: All 10 recent reality reports show `scopeBoundary: {}` and 14-15 files of scope creep per merge.
- **Impact**: Would immediately activate the scope enforcement gate for future cycles.

**2. Fix planner starvation by restructuring prompt context** (HIGH)
- **What**: In the planner prompt, put the priority TODO items BEFORE the completed list. Limit the completed list to the last 5 items (not all 17). Add an explicit instruction: "If priorities.md has uncompleted items, you MUST propose work on one of them."
- **Why**: 45% of recent cycles produce no task. The completed list (17 items) may be anchoring the planner to believe work is done. Priority ordering in the prompt matters for LLM attention.
- **Evidence**: "Planner produced no task" is the #1 repeated title (14 of 50 cycles).
- **Impact**: Could recover 10+ cycles per 50 from "no task" to productive.

**3. Restart the scheduler** (IMMEDIATE)
- **What**: `curl -X POST http://localhost:4000/api/scheduler/start`
- **Why**: Scheduler is stopped. 0 errors, so this is a clean restart.
- **Evidence**: Scheduler status shows `running: false`, `cyclesRun: 13`, `consecutiveErrors: 0`.

### Medium Efforts (1-5 days)

**4. Add positive skill memory (not just failure patterns)**
- **What**: When a cycle merges successfully with zero scope creep and no operator revert within 24h, extract a "SKILL" pattern: WHEN [task type] / DO [approach] / BECAUSE [it worked]. Inject these into the planner prompt alongside WHEN/CHECK/BECAUSE prevention rules.
- **Why**: Hermes Agent achieves 40% faster completion with procedural skill memory. Hydra only learns from failures (188 prevention hits) but never encodes what works. This is a structural gap vs state-of-art.
- **Evidence**: 28 merged cycles in 50 — each is a potential skill source that's currently discarded.
- **Dependency**: `trackMergedCommit` + `checkRevertCorrelation` (already implemented) can gate skill creation on "no revert within 24h."

**5. Enforce mutation testing and adversarial validation execution**
- **What**: Add a reality report check: if `mutationTesting` is null for a merged standard/complex task, log a warning and investigate why the gate was skipped. Add a metric for MT/AV execution rate.
- **Why**: Only 1 of 5 recent merges had mutation testing. 0 of 5 had adversarial validation. These gates exist but aren't consistently firing — the system has verification theater.
- **Evidence**: Reality reports show "no-MT" and "no-AV" for 4 of 5 recent merges.

**6. Add task-level deduplication for the repeated KXNBA fixture task**
- **What**: The drift detection should check not just title similarity but also the specific files/modules involved. "Publish KXNBA first-live-run reconciliation proof fixture" was attempted 3 times — drift detection should have caught attempts 2 and 3.
- **Evidence**: 3 attempts at the same task title in recent cycles.

### Strategic Shifts (1-2 weeks)

**7. Restructure planner from "find work" to "select from menu"**
- **What**: Instead of having the planner read priorities.md and decide what to do, present it with a structured menu of ready-to-start tasks (from the work queue + priorities). The planner's job becomes "pick the best one and scope it" rather than "find something to work on." This is the difference between a generator and a selector.
- **Why**: The "find work" model fails 28% of the time. A menu-based approach eliminates "no work" cycles entirely — if the menu is empty, the system knows to run research instead of wasting a planner call.
- **Impact**: Could eliminate all "no task" abandonments and save ~$1/cycle * 14 cycles = $14 per 50 cycles.
- **Risk**: Medium — requires restructuring the anchor selection to pre-build task candidates.

**8. Implement operator revert feedback loop**
- **What**: When `checkRevertCorrelation` detects a revert of a Hydra-merged commit, automatically: (a) extract the commit diff, (b) classify the revert reason (scope creep, semantic error, test gap, formatting), (c) create a WHEN/CHECK/BECAUSE pattern, (d) queue a follow-up task to write a test that would have caught the issue.
- **Why**: 11 reverts in 7 days. Each revert is a learning opportunity that's currently wasted. The adversarial validation precision tracking was added but the upstream signal (what was the revert actually about?) isn't being captured.
- **Evidence**: `trackMergedCommit` and `checkRevertCorrelation` are implemented but don't close the loop back to agent memory or test generation.

## Delta from Prior Review (2026-04-30 earlier)

| Recommendation | Status | Impact |
|---------------|--------|--------|
| #1 Fix executor scope creep with git checkout | Implemented | Not measurable yet — scope creep persists because scopeBoundary.in is empty |
| #2 Fix failed prediction-market-cron | Resolved | No failed services |
| #3 Improve planner "no work" rate | Implemented (priorities.md in reframe) | **Backfired** — no-task rate rose from 16% to 28% |
| #4 Integrate mutation testing in executor loop | Implemented (rule 4b) | Not visible in reality reports yet |
| #5 Add scope-enforcement gate | Implemented (Step 6.9) | **Bypassed** — planner emits empty scopeBoundary |
| #6 Add adversarial validation tracking | Implemented (trackMergedCommit) | Too early to measure |
| #7 Executor workspace isolation (worktrees) | Implemented | Too early to measure scope creep impact |
| #8 Self-play regression hunt | Implemented (every 10 merges) | Not yet triggered |

**Score change: 7.4 -> 7.1 (-0.3)**

The score drop is driven by three factors: (1) merge rate declined from 78% to 56%, (2) planner starvation worsened from 16% to 28%, and (3) the scope enforcement gate — the most impactful recommendation from the prior review — is structurally bypassed. The architectural improvements are real and well-implemented, but two of them need wiring fixes before they can produce results.

## Next Review Triggers

Re-run this assessment when any of these occur:
1. Scope gate fires for the first time (scopeBoundary.in populated by planner)
2. Planner starvation drops below 10% (prompt restructuring working)
3. 3+ consecutive merges with mutation testing results (MT gate consistent)
4. Revert rate drops below 5 per 7-day window
5. 50 cycles with scheduler running continuously
6. 14 days from this review (2026-05-14)
