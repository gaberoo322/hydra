Tier: 3 (operator-review change (test/watchdog-launch-flow.test.mts, .changelog/5114-launch-flow-sweep-delivery-ns.md))

The launch-flow suite's orphan sweep SCANs `hydra:test:launch-flow-*`, but its pid parser only recognised `launch-flow-<pid>-<uuid8>`. The sibling suite's `launch-flow-delivery-<pid>-<uuid8>` namespaces parsed to null, counted as dead, and were DELeted mid-run. The pid regex now accepts the optional `delivery-` segment, so a live delivery namespace is skipped by the same `/proc/<pid>` liveness check.

## Files in scope

- test/watchdog-launch-flow.test.mts
- .changelog/5114-launch-flow-sweep-delivery-ns.md

Glossary impact: none
ADR impact: none

Design concept: none exists for issue-5114 (404), so no reconciliation section applies.

## Acceptance

- [ ] A planted live-pid `launch-flow-delivery-<livepid>-*` key is recognised as live and not swept — verified by: `npm run test:file -- test/watchdog-launch-flow.test.mts` exits 0 (subtest "a live launch-flow-delivery suite's namespace is never swept (#5114)")
- [ ] Both suites pass and npm test passes — verified by: `npm test` shows `# fail 2`, both in `test/session-block.test.mts` (out-of-credits cases), which fail identically on origin/master (pre-existing, unrelated).

Closes #5114

🤖 Generated with [Claude Code](https://claude.com/claude-code)
