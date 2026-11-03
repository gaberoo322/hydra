Lifecycle seam core (ADR-0047 D2-D5, D7): closed state set and transition table as data, pure record-checked gate predicates, the verified writer spine, the Redis journal and dispatch-claim accessor, the shadow/enforce switch, and the `scripts/lifecycle.ts` CLI. No caller is migrated in this slice.

Tier: 3
Merge danger: one-way — persistent-state: introduces new Redis keyspaces (lifecycle journal/claim) written only by the new CLI; the detector fires on the claim DEL, and reverting leaves orphan keys that nothing reads (benign), but the journal is history that cannot be regenerated.
Glossary impact: none (terms are defined in ADR-0047; no CONTEXT.md edit in this PR)
ADR impact: none (implements ADR-0047)

## Files in scope

- `src/lifecycle/index.ts`
- `src/lifecycle/transitions.ts`
- `src/lifecycle/gates.ts`
- `src/lifecycle/reasons.ts`
- `src/lifecycle/seam.ts`
- `src/redis/lifecycle-journal.ts`
- `scripts/lifecycle.ts`
- `config/orchestrator/lifecycle-rollout.json`
- `test/lifecycle-transitions.test.mts`
- `test/lifecycle-gates.test.mts`
- `test/lifecycle-journal.test.mts`
- `test/fixtures/suite-count-baseline.json`

## Acceptance criteria

- [ ] `advance` performs a legal transition, journals it with source `cli`, and verifies the label after write — verified by: `npm run test:file -- test/lifecycle-gates.test.mts` exits 0
- [ ] An illegal or gate-failing transition in shadow still writes and journals `shadow-would-refuse:<reason>` — verified by: `npm run test:file -- test/lifecycle-gates.test.mts` exits 0
- [ ] Any exit from ready-for-human/parked/hitl-grill/needs-info is refused in both modes — verified by: `npm run test:file -- test/lifecycle-gates.test.mts` exits 0
- [ ] Claim is taken with SET NX; a second claim fails — verified by: `npm run test:file -- test/lifecycle-journal.test.mts` exits 0
- [ ] Unit tests cover the table, each gate and the journal; npm test and tsc pass — verified by: `npm run typecheck` and `npm run typecheck:test` exit 0

## Design-concept reconciliation

Artifact: `02dc301d0d2e3c07`

- INV-1: "INV-1 Closed state set:" — verified by: `file-contains: src/lifecycle/transitions.ts :: export const HUMAN_HOLD_STATES`
- INV-2: "INV-2 Table is data: `TRANSITIONS` is a readonly" — verified by: `file-contains: src/lifecycle/transitions.ts :: export const TRANSITIONS`
- INV-3: "INV-3 Human-hold exits are refused by the CLI" — verified by: `file-contains: test/lifecycle-gates.test.mts :: human-hold exit from`
- INV-4: "INV-4 Seam never throws and never falls back:" — verified by: `file-contains: src/lifecycle/seam.ts :: write-unverified`
- INV-5: "INV-5 Shadow writes, enforce refuses:" — verified by: `test: test/lifecycle-gates.test.mts :: "shadow: an illegal transition STILL writes and journals one refused row"`
- INV-6: "INV-6 Spine order is fixed:" — verified by: `file-contains: src/lifecycle/seam.ts :: const after = await deps.view(issue)`
- INV-7: "INV-7 Gate predicates are pure:" — verified by: `file-lacks: src/lifecycle/gates.ts :: node:fs`
- INV-8: "INV-8 Reason enums are closed:" — verified by: `file-contains: src/lifecycle/reasons.ts :: export const ADR5_REASONS`
- INV-9: "INV-9 Journal is append-only and bounded:" — verified by: `file-lacks: src/redis/lifecycle-journal.ts :: .lset(`
- INV-10: "INV-10 Retention follows issue state:" — verified by: `file-contains: src/redis/lifecycle-journal.ts :: DEFAULT_JOURNAL_CLOSE_TTL_SECONDS`
- INV-11: "INV-11 Claim is atomic and TTL-less:" — verified by: `file-contains: src/redis/lifecycle-journal.ts :: "NX"`
- INV-12: "INV-12 Mode resolution is total:" — verified by: `file-contains: config/orchestrator/lifecycle-rollout.json :: "lifecycle-seam": "shadow"`
- INV-13: "INV-13 No :4000 dependency:" — verified by: `file-lacks: scripts/lifecycle.ts :: localhost:4000`
- INV-14: "INV-14 No caller migrates and no label is create" — verified by: `file-lacks: src/lifecycle/seam.ts :: label create`
- INV-15: "INV-15 Suite-count baseline is regenerated in th" — verified by: `file-contains: test/fixtures/suite-count-baseline.json :: test/lifecycle-journal.test.mts`


## Notes

scope-justification: `docs/generated/*.json`, `test/fixtures/test-subject-baseline.json` and `.changelog/5310-lifecycle-seam-core.md` are mechanical regenerations the required `test` job demands (`npm run docs:inventories`, `test-subject-map --update-baseline`); the three new `test/lifecycle-*.test.mts` files each cover a distinct module (table, gates+spine, Redis journal). `npm test` on this branch is red only on `test/session-block.test.mts` (2 failures), which fails identically on origin/master.

Closes #5310
