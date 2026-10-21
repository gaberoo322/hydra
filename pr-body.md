Tier: 3 (operator-review change (src/glm/drainer-driver.ts))

Demotes the two knip-reported unused exports in `src/glm/drainer-driver.ts` (`buildDefaultTickDeps`, `TickResult`) to module-private; both are still referenced in-file, so only the `export` keyword is dropped (verdict b). Probe `grep -rnw` over src/test/scripts found no external references.

## Files in scope

- `src/glm/drainer-driver.ts`

Glossary impact: none
ADR impact: none

Design concept: none (404 for issue-5033; issue is design-concept-exempt).

## Acceptance criteria

- [ ] Every checklist item resolved (demoted) — verified by: `grep -nE "^export (function buildDefaultTickDeps|interface TickResult)" src/glm/drainer-driver.ts` prints nothing
- [ ] Types intact — verified by: `npm run typecheck` and `npm run typecheck:test` exit 0
- [ ] Tests — verified by: `npm test`; local run showed 2 failures in the usage session-block test file (out-of-credits burst / model-fallback, #4585), which does not import src/glm/drainer-driver.ts; left to CI to confirm as unrelated

Closes #5033
