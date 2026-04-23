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

## Vercel Cron Schedule Constraint (DEPLOY-BLOCKING)

This project runs on Vercel's Hobby plan. **Every cron schedule in `vercel.json` MUST be daily or less frequent** — use `0 0 * * *` (once daily at midnight UTC). Hourly schedules like `0 * * * *` are rejected by Vercel and block ALL deploys for the entire project, not just the cron route. If your task adds or modifies a cron entry in `vercel.json`, double-check the schedule field before committing. This rule has been violated before and caused deploy outages.
