Tier: 3 (operator-review change (scripts/autopilot/render-dispatch.py, docs/operator-playbooks/hydra-autopilot.md, test/autopilot-render-dispatch.test.mts, +1 more))

Tighten `FORWARD_FIX_CONTRACT` (and its playbook mirror): step 2 now requires a blocking behaviour-changing finding to be resolved by a commit that also adds a red-without-the-fix test plus a sibling-shape pin; step 5 drops the softer "as the change requires" line for the full dev verification trio and requires the PR comment to name both tests. No sixth step; no other files touched.

## Files in scope

- scripts/autopilot/render-dispatch.py
- docs/operator-playbooks/hydra-autopilot.md
- test/autopilot-render-dispatch.test.mts
- .changelog/5036-forward-fix-test-with-fix.md

Glossary impact: none
ADR impact: none

## Design-concept reconciliation

Artifact: `c7e9cac82226`

- INV-1: "INV-1 Parity: FORWARD_FIX_CONTRACT in scripts/autopilot/render-dispatch.py" — verified by: `test: test/autopilot-render-dispatch.test.mts :: "the forward-fix contract's five steps are the playbook's five (same bold step titles, same order)"`
- INV-2: "INV-2 No softer line: the phrase 'as the change requires' appears nowhere" — verified by: `test: test/autopilot-render-dispatch.test.mts :: "a forward-fix resolves a code finding with a test and verifies with the full dev trio (#5036)"`
- INV-3: "INV-3 Test-with-fix: step 2's resolution clause states that a blocking" — verified by: `file-contains: docs/operator-playbooks/hydra-autopilot.md :: nearest sibling shape that must keep its old verdict`
- INV-4: "INV-4 Blast radius: no sixth step; DEV_VERIFY_RULES, decide.py, reap.py," — verified by: `manual: diff touches only the render-dispatch.py contract string, the playbook mirror, the test and a changelog fragment`
- INV-5: "INV-5 Tests: the regression lands as needle assertions in test/autopilot-render-dispatch.test.mts" — verified by: `test: test/autopilot-render-dispatch.test.mts :: "a forward-fix resolves a code finding with a test and verifies with the full dev trio (#5036)"`

## Acceptance

- [ ] Contract carries the test-with-fix rule — verified by: `npm run test:file -- test/autopilot-render-dispatch.test.mts` exits 0
- [ ] No "as the change requires" remains — verified by: `git grep -c "as the change requires" -- scripts docs` returns nothing

Closes #5036

🤖 Generated with [Claude Code](https://claude.com/claude-code)
