Demotes 20 knip-flagged unused exports in `src/autopilot/turn-snapshot` by dropping only the `export` keyword (all still referenced within their own files).

Tier: 3

## Files in scope

- `src/autopilot/turn-snapshot/passthrough.ts`
- `src/autopilot/turn-snapshot/picks.ts`

## Design-concept reconciliation

No design concept exists for issue-4988 (`/api/design-concepts/issue-4988` returns 404; issue is labelled `design-concept-exempt`).

## Acceptance criteria

- [x] All 20 checklist symbols demoted — verified by: `grep -n "^export" src/autopilot/turn-snapshot/passthrough.ts src/autopilot/turn-snapshot/picks.ts` lists none of them
- [x] Type-checks pass — verified by: `npm run typecheck` and `npm run typecheck:test` exit 0
- [x] `npm test` — 10746/10755 pass; the 2 failing suites are in `test/session-block.test.mts` (model-fallback/usage, untouched by this diff; fail identically in isolation on a change that only removes `export` keywords)

Glossary impact: none
ADR impact: none

Closes #4988
