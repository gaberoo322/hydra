# Executor Guidance

Your job is to make the smallest high-confidence code change that correctly completes the approved task.

Do not redesign the system unless the task explicitly requires it.
Do not broaden scope while implementing.
Do not "clean up" unrelated code just because you noticed it.

## Core implementation rule

Prefer narrow, verifiable improvements to existing execution, persistence, reconciliation, risk-control, and auditability paths.

When partial infrastructure already exists, extend and harden it instead of replacing it from first principles.

## Implementation priorities

When implementing, prioritize:
1. correctness of execution state
2. persistence integrity
3. reconciliation and restart safety
4. bankroll and exposure enforcement
5. clear test coverage
6. operator trust and auditability

## Preferred implementation style

- make the smallest diff that solves the task
- reuse existing project patterns unless they are clearly broken
- add or update tests close to the changed behavior
- prefer explicit validation over optimistic assumptions
- fail closed when execution state is uncertain
- preserve idempotency where relevant
- preserve or improve crash recovery behavior
- preserve existing sportsbook behavior unless the task explicitly changes it

## Avoid these implementation mistakes

- broad refactors unrelated to the task
- introducing shared abstractions too early
- changing many files when one or two would do
- adding new framework patterns without necessity
- weakening validation to make tests pass
- relying on in-memory state when persisted authoritative state exists or should exist
- silently changing behavior without test updates
- modifying unrelated sportsbook code during prediction-market work unless necessary

## Testing expectations

For most tasks, add or update tests that cover:
- the changed execution path
- malformed or edge-case inputs where relevant
- persistence or state-transition behavior where relevant
- risk-control behavior if the task touches bankroll, fills, or open orders

If a task cannot be tested well, keep the scope especially narrow and explain the verification approach clearly.

## Test performance rules

Tests run in parallel across 8 threads. Every slow test delays every grounding step and every verification step across every cycle. Write tests that are fast by default.

**Mandatory:**
- Use `vi.useFakeTimers()` (NOT `{ shouldAdvanceTime: true }`) for any test involving delays, retries, backoff, or polling. Advance time explicitly with `vi.advanceTimersByTimeAsync()`. Real `setTimeout` delays waste wall-clock time.
- Mock all external HTTP calls with `vi.fn()` / `vi.stubGlobal("fetch", ...)`. Never make real network requests in tests.
- Mock `execFile` / `spawn` for tests that would invoke CLI tools or subprocesses.
- Do NOT use `fileParallelism: false` or `{ sequential: true }` on test files unless there is a proven shared-state conflict. Tests run in parallel.

**Preferred patterns:**
- Test pure functions directly rather than testing through API routes when possible.
- Use factory functions for test fixtures instead of deep object literals repeated across tests.
- Keep individual test cases under 500ms. If a test takes >1s, it likely needs fake timers or better mocking.
- For database tests that use Docker containers: share the container across tests in the same file via `beforeAll`, not per-test setup.

**Avoid:**
- Real `setTimeout`/`setInterval` delays in test code — use fake timers.
- Spinning up Docker containers per-test when per-file works.
- Large snapshot tests that slow down assertion comparison.
- `test.each` with >20 cases in a single parameterized block — split into focused groups.

## If the task touches execution or venue behavior

Be especially careful about:
- acknowledgement parsing
- fill handling
- partial fills
- open-order accounting
- fee-aware calculations
- fixed-point or decimal correctness
- restart or retry semantics
- duplicate submission or duplicate persistence risks

## If uncertain

If there is a choice between:
- a clever abstraction
- and a direct explicit implementation

choose the direct explicit implementation unless the abstraction is clearly required by the task.

## Stack preferences

- TypeScript strict mode — no `any`, no type assertions unless justified
- Named exports over default exports
- shadcn/ui + Tailwind CSS for frontend components
- Co-locate tests with source files (foo.ts → foo.test.ts)
- Keep components under 150 lines — split if larger

## Definition of success

A successful implementation:
- changes as little as necessary
- leaves the repo more trustworthy than before
- is backed by tests or concrete verification
- does not create hidden drift in adjacent systems

## Test Count Delta Reporting

When a cycle changes code but the reported test count does not increase, explicitly state why in the completion summary: whether existing tests were modified, existing coverage already exercised the change, or the task was non-code/config-only. Include the exact test command that covers the changed behavior.

## High-Risk Live Enforcement Test-Count Guard

When a task is high-risk and touches live submit, buying power, balances, account limits, or stake enforcement, treat any test-count decrease as a blocking issue even if `npm test`, `tsc`, and build pass. Before pushing, compare the grounded starting test count with the final count. If the count decreased, either restore equivalent coverage or document the exact removed obsolete tests and why no behavior coverage was lost in the commit message.

## Stability-window pruning trigger

When the last 20 cycles show zero failures, zero abandonments, and zero regressions, treat additional executor-specific prevention rules as a last resort. Before adding or following new ceremony-heavy guidance, check whether the same safety outcome is already enforced by hard verification (`npm test`, `tsc`, `npm run build`) or existing tests. If yes, prefer the smaller implementation path and explicitly call out stale or redundant executor guidance for operator review instead of compounding it with another rule.

## Ranking And Gating Logic Guardrail
- When a task changes ranking, scoring, survivability, ordering, or candidate-gating behavior, start by adding or updating a focused regression test that pins the exact invariant the change is meant to affect.
- If your implementation causes the total discovered test count to drop or makes an existing suite disappear, stop and investigate before continuing; do not hand that state to verification as a normal outcome.
- In your completion summary, name the specific test file(s) that prove the ranking or gating behavior changed intentionally.

## Reusing Existing Coverage For Thin Slices
- When a task is a low-risk presentation, reporting, or field-plumbing change, existing automated coverage may satisfy the test requirement if the changed path is already exercised by hard verification.
- Do not add brittle assertion-only tests solely to increase the test count. Instead, state which existing verification command covers the path and why that coverage is sufficient.
- Add or update tests when the change affects logic, branching, validation, persistence, or any behavior not already exercised by the existing suite.

## Polymarket Migration Compatibility

When changing Polymarket auth, SDK request shapes, environment variable names, or terminal fill parsing, add or update compatibility tests for both the legacy and new field names before committing. Treat removal of an accepted alias or env name as a breaking change unless the task explicitly requests the removal and verification proves every caller was migrated.

## Scanner/Header Cleanup Verification

When executing a scanner-driven header or missing-docs cleanup task, run the same scanner or discovery command that identified the target files both before and after the edit when available. Before committing, confirm that every file in the task scope has disappeared from the scanner output or now reports the expected header fields. If the scanner still reports any touched file, fix that file before pushing; do not rely on the full test suite alone for scanner cleanup tasks.

## Failing-Test Anchor Discipline

When executing a `failing-test` anchored task, spend the first pass proving the smallest reproducible failure before editing code. Run the narrowest relevant test command or file-level command first, note the failing assertion/setup point in the cycle notes, and make the first code change target that observed failure only. If the narrow repro does not fail, stop expanding blindly: record that mismatch and switch to identifying the telemetry/test-selection discrepancy before implementing.

## Test Discovery Invariant

- Treat the grounded test-count baseline as a release invariant, not a nice-to-have.
- If your verification run discovers materially fewer tests than grounding (for example, thousands dropping to low hundreds), stop immediately and investigate before committing.
- Do not treat a green run as valid when it only passed because test discovery or test selection changed unintentionally.
- When the task intentionally changes test invocation or test layout, call out the expected test-count delta explicitly in your notes and verify why the new count is correct.

## Status-surface contract checks
- When a task removes, renames, or remaps externally consumed health or session states (for example operator-health, SDK preflight, or API status payloads), add or update a focused contract test that proves the expected downstream state set before shipping the production change.
- If you cannot write a passing contract test for the state transition in the same cycle, stop and escalate instead of guessing at status compatibility.

## Reuse First On Live Recovery Mutations
- When a task touches live recovery, unwind, or other state-changing arbitrage flows, inspect the codebase for an existing executor or shared mutation helper before writing new control flow.
- If an existing executor can satisfy the task with thin wiring, reuse it and add tests at the integration seam instead of reimplementing recovery behavior.
- If the task would require inventing a new mutation path after that search, stop and escalate rather than guessing through a high-risk flow.

## Stop On Grounding Regressions\n- If your task is not anchored to an already-failing test and your local grounding gets worse than cycle start, stop feature work and isolate the regression before continuing.\n- Treat any drop in discovered/passing test count as a blocking signal, even if the remaining verification commands still pass. Restore the original baseline or hand back the exact failing command and minimal repro.\n- For high-risk execution or recovery-flow changes, run the nearest existing recovery/execution test coverage before final verification so regressions surface before commit, not after merge review.

## Frontend UI Patterns

When touching any file under `web/src/app/` or `web/src/components/`:

1. **Read `web/src/DESIGN_SYSTEM.md` first.** It defines the canonical colors, spacing, components, and banned patterns. Follow it exactly.
2. **Dark theme only.** Page backgrounds are `bg-gray-950`, cards are `bg-gray-900 border border-gray-800 rounded-xl`. Never use `bg-white`, `bg-slate-*`, or `shadow-sm`.
3. **Use shared components.** Buttons: `components/ui/button.tsx`. Inputs: `components/ui/input.tsx`. Selects: `components/ui/select.tsx`. Never inline button or input styles — add a new variant to the component if needed.
4. **Consistent cards.** `rounded-xl border border-gray-800 bg-gray-900 p-4` for top-level cards. `rounded-lg bg-gray-800/50 p-3` for nested sub-cards.
5. **SiteNav on every page.** Import from `@/components/nav`. Do not create custom navigation.
6. **Status colors follow the system.** Emerald for success, amber for warning, red for error, blue for info. Use the opacity pattern: `text-{color}-400 bg-{color}-400/10 border-{color}-400/30`.
7. **No new CSS classes in globals.css** without operator approval. Use Tailwind utilities.

## Auto-Promoted Rules

### verification-failure (25x since 2026-04-19)
Run `npm test` and `npm run typecheck` before committing.
Last: cycle-2026-04-27-0825 (cycle-2026-04-27-0825: Verification failed on tests pass. Error: Command failed: npm test
)
<!-- auto-promoted 2026-04-29 -->

### no-diff (6x since 2026-04-26)
Actually write code and commit. Previous attempt produced zero changes.
Last: cycle-2026-04-28-1746 (cycle-2026-04-28-1746: "Align Polymarket US adapter audit fixture with CTF V2 order struct" — no files modified)
<!-- auto-promoted 2026-04-28 -->

Rules below were auto-promoted from agent memory after proving themselves
across multiple cycles. They represent durable patterns, not one-off incidents.
