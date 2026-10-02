---
status: accepted
---

# ADR-0042: `src/cost/` is layered by purity, with a test-enforced import rule

`src/cost/` (the **Cost** module and **Subscription Usage Tracker**) holds 18 files and about
8,300 lines. Six issues split its old monolith along seams (#1896 config, #1909 token-math,
#1377 eligibility, #1971 transcript-scan, #2279 snapshot-assembly, #3071 types, plus
`oauth-read-cache.ts`), but none of them wrote down the resulting layering. The only
documentation was the file headers, 20 of whose claims no longer match the code
(`docs/research/2026-09-27-src-cost-phase-map.md` §4). No rule constrained imports, so four
upward edges crept in. The barrel's docblock said "everything goes through `index.ts`",
yet four `src/` files and one script bypassed it. The test file,
`test/usage-tracker.test.mts` (5,615 lines), was never split when its source was.

Wayfinder map #4516 settled the shape across four tickets: the layer model (#4704), the
phase map (#4705), the decomposition (#4706) and the test topology (#4707). This ADR
records the rules that outlive the implementation epic. **It governs `src/cost/` only**
(Decision 10). ADR-0021 still governs **Pace Gate** *behaviour*, which none of this changes.

## Decision

### Decision 1 — Layers are ordered by purity, not by pipeline stage

Read the layers bottom-up. A file imports only from its own layer or a lower one:

| Layer | Files |
|---|---|
| L1 vocabulary + math | `token-math`, `token-breakdown`, `types`, `oauth-meter-shape` |
| L2 config | `config` |
| L3 pure folds | `eligibility`, `transcript-fold`, `snapshot-assembly` (`eligibility` sits below `snapshot-assembly`) |
| — purity line — | |
| L4 I/O sources | `oauth-usage`, `oauth-read-cache`, `transcript-scan`, `surrogate`, `usage-by-issue` |
| L5 coordinators | `usage-tracker`, `eligibility-usage` |
| L6 derived reads | `cost-by-class`, `cost-per-merged-pr`, `class-cost-efficiency`, `weighted-quota-estimate` |
| barrel | `index` (re-exports only) |

The rule covers **type-only imports too**. A type-only back-edge is exactly how
`types.ts → transcript-scan.ts` crept in, so it gets no exemption. `surrogate` and
`usage-by-issue` import nothing else from `src/cost/`, but both do Redis I/O, so they sit
in L4 and are not leaves.

Why purity and not pipeline order (scan → assemble → eligibility)? With pipeline order,
`snapshot-assembly → eligibility` (`deriveHardStop`) is a back-edge that has to be
blessed. With purity order it is an edge inside L3, and nothing has to be blessed.

### Decision 2 — The purity line is a value-import ban

L1–L3 import no **values** from `node:fs*`, `node:child_process`, `node:net`,
`node:http(s)`, `../redis/*` or `../transcript-store`. `process.env` reads and
`../logger.ts` are allowed below the line. **Type-only** imports from `../redis/*` are
allowed: `transcript-fold.ts` takes `FileParseMemoEntry` that way.

### Decision 3 — A test enforces the rule; dependency-cruiser only mirrors it

`test/cost-layers.test.mts` runs in the required `test` job and is the blocking lane. It
does not exist yet: epic #4780 adds it (slice #4783), together with the dependency-cruiser
rule and `src/cost/CONTEXT.md` below. Until it lands, nothing mechanically enforces this
ADR. The test holds the layer table as a `const` and asserts five things:

1. every `src/cost/*.ts` file belongs to exactly one layer, so a new file fails until
   someone classifies it;
2. every import inside `src/cost/`, value or type, points to the same layer or a lower one;
3. the purity line from Decision 2 holds;
4. value imports inside `src/cost/` form no cycles;
5. the outside edge from Decision 4 holds.

A `src/cost` rule is added to `.dependency-cruiser.cjs` as an **advisory visual twin**. The
dep-boundary lane exits 0, and an advisory workflow cannot block a PR. `src/cost/CONTEXT.md`,
created by the epic from #4704's draft, mirrors the table, and the two are edited together.

### Decision 4 — The barrel contract: L1–L2 direct, L3 and above through `index.ts`

Code in `src/` and `scripts/` may import L1–L2 files directly. L3 and above must go through
`index.ts`. `test/` is exempt. `getEligibilityUsage` joins the barrel. This replaces the old
"everything through the barrel" docblock, which never matched reality.

### Decision 5 — Upward edges are removed by moving vocabulary down, never by blessing

`deriveHardStop` stays in `eligibility.ts`. The four upward edges on master
(`types → transcript-scan`, `eligibility → eligibility-usage`,
`snapshot-assembly → oauth-usage`, `snapshot-assembly → transcript-scan`) are cleared in
three moves:

- the types (`EligibilityUsageInput`, `ScanResult`, `CachedOAuthRead`, `OAuthUsageData`,
  `OAuthUsageResult`, `OAuthUsageErrorCode`) go into `types.ts`, which stays types-only;
- `types.ts` imports `DispatchKind` from `token-breakdown.ts` (L1), where it is defined,
  instead of through `transcript-scan.ts`'s re-export;
- the pure OAuth meter helpers go into a new L1 file, `oauth-meter-shape.ts`.

The old paths keep re-exports. A future upward edge gets the same treatment. The layer
table has no exception list.

### Decision 6 — `transcriptScan` stays direct I/O; its pure phases move into `transcript-fold.ts`

`transcriptScan` is **not** converted to an ADR-0040-style `run*` over injected
`readdir`/`stat`/`readFile` deps. The #2188 concept already rejected a deps bag here, and
the walk tests use a real temp dir. Only its pure phases move down, into the new L3 file
`transcript-fold.ts`:

- `parseTranscriptFile(content, cutoff7d, attribute)`: its skill attribution is injected, so
  the path- and session-keyed cache stays on the I/O side;
- `ScanAccumulator` + `foldFileContribution`: the **only** code that mutates the scan
  accumulators, shared by the memo-hit and memo-miss paths;
- the pure `firstUserMessageText` and `sumSessionTokens`, moved down from
  `transcript-scan.ts`.

`transcript-scan.ts` keeps re-exports at the old names (the #3513 precedent). The per-line
closure `foldParsedLine` and the duplicated 24h and cross-tab blocks are deleted.

The acceptance bar is a **byte-identical `ScanResult`**. This is a behaviour-preserving
restructure, not a verbatim move. Two existing differences between the paths are
deliberately kept: the log-only model-name placeholders on replay, and a replay that
leaves the session skill cache empty (#4778 tracks that separately). Characterization
tests for the walk-level gaps land before any `src/` change.

### Decision 7 — `assembleSnapshot` takes a defaulted calibration record; its body is not split

Its 10 direct env reads are gathered into `readSnapshotCalibration()` in `config.ts`.
The record arrives as an optional 4th argument whose default reads at call time, so env
semantics are unchanged. `deriveHardStop` keeps its own env read. The **Weekly Reset Anchor**
is read once by the scan and again by assembly. That double read is **documented, not
removed**, because threading it through `ScanResult` would change the boundary type. It is
documented in `src/cost/CONTEXT.md`: `ScanResult.sinceResetEntries` is empty unless the
anchor is set.

### Decision 8 — Tests live with the source file that defines the function

A test suite belongs in the test file of the source file that **defines** its function
under test, not the file that re-exports it. `usage-tracker.test.mts` keeps only the
`getUsage` suites, as the coordinator's integration test. This matters beyond tidiness:
since #4504 the mutation gate runs only a mutant's related tests (direct importers plus
basename matches, capped at 8). A suite homed next to its function's owner is always in
that set. A suite homed in a large integration file that imports through a re-export can
fall out of it.

### Decision 9 — `config.ts` stays one L2 env-reader leaf

It is 734 lines and 51 exports, and every one is a pure env reader or a `DEFAULT_*`
constant. The whole file sits in one layer, so splitting it gives the layer guard nothing
to enforce, and splitting by consumer would scatter the readers. The GLM-owned readers
inside it belong to ADR-0040's epic, not to this ADR.

### Decision 10 — Scope: normative inside `src/cost/` only

The purity-ordered layer table plus its drift-guard test is a **reusable pattern**, not a
repo-wide convention. Other `src/<domain>/` modules are not out of compliance for lacking
one. A module that adopts it writes its own table and test. One module does not yet make a
convention.

## Alternatives considered

- **Pipeline-stage layering.** Rejected: it turns `deriveHardStop` into a blessed
  back-edge (Decision 1).
- **Exempting type-only imports from the direction rule.** Rejected: that is the route by
  which the first upward edge arrived.
- **Dependency-cruiser as the enforcer.** Rejected: its lane is advisory and cannot block
  a PR. A `test/*.test.mts` can.
- **Splitting `config.ts` by consumer.** Rejected (Decision 9).
