# `src/cost/` — Cost module map

*A module map, not a glossary — **Cost**, **Subscription Usage Tracker**, **Quota Weight**,
**Pace Gate**, **Pacing Curve**, **Weekly Reset Anchor** are defined in the root
[`CONTEXT.md`](../../CONTEXT.md).*

Relevant decisions: [ADR-0021](../../docs/adr/0021-usage-paced-autopilot-pace-gate.md) (Pace Gate
behaviour — this map does not change it) and
[ADR-0042](../../docs/adr/0042-src-cost-is-layered-by-purity-with-a-test-enforced-import-rule.md)
(the layering below and its enforcement).

## Layering — ordered by purity

Read bottom-up. A file imports only from its own layer or a lower one, and that includes
type-only imports. Everything at or below the purity line is I/O-free: env reads and
`../logger.ts` are allowed, but not fs, network, child processes, Redis or the transcript store.
[`test/cost-layers.test.mts`](../../test/cost-layers.test.mts) (ADR-0042 Decision 3) enforces this
table as a blocking lane; the `cost-layer-*` rules in `.dependency-cruiser.cjs` mirror it
advisory-only. Edit the test's `COST_LAYERS` const and this table together.

| Layer | Files | Owns |
|---|---|---|
| L1 vocabulary + math | `token-math.ts` | Model families, quota weights, token arithmetic, reset-window projection |
| | `token-breakdown.ts` | `TokenBreakdown` folds, the `DispatchKind` vocabulary, skill/dispatch-kind derivation |
| | `types.ts` | Types-only shapes: `UsageSnapshot`, `ScanResult`, `EligibilityUsageInput`, OAuth meter shapes |
| | `oauth-meter-shape.ts` | Pure OAuth meter body parse + ok/failure guards + endpoint constants |
| L2 config | `config.ts` | Every `HYDRA_USAGE_*` env reader and its `DEFAULT_*` |
| L3 pure folds | `eligibility.ts` | Admission verdict: hard stops (`deriveHardStop`), pacing shed, 5h throttle, overlays |
| | `snapshot-assembly.ts` | `assembleSnapshot`: folds a `ScanResult` + OAuth read into a `UsageSnapshot` |
| ─ purity line ─ | | |
| L4 I/O sources | `oauth-usage.ts` | The OAuth meter fetch (`readOAuthUsage`) |
| | `oauth-read-cache.ts` | Cached/backed-off meter reads |
| | `transcript-scan.ts` | The `~/.claude/projects` JSONL walk + parse memo |
| | `surrogate.ts` | Per-day subagent token counters (Redis) |
| | `usage-by-issue.ts` | Dispatch cost join by issue (Redis) |
| L5 coordinators | `usage-tracker.ts` | `getUsage`: scan + meter + assembly + weekly snapshot |
| | `eligibility-usage.ts` | `getEligibilityUsage`: meter-only admission input (never scans) |
| L6 derived reads | `cost-by-class.ts`, `class-cost-efficiency.ts`, `cost-per-merged-pr.ts`, `weighted-quota-estimate.ts` | Rollups over the snapshot + surrogate counters |
| barrel | `index.ts` | Re-exports only |

Layers are ordered by purity, not pipeline stage (ADR-0042 Decision 1): `deriveHardStop` stays in
`eligibility.ts`, `snapshot-assembly.ts → eligibility.ts` is an edge inside L3, and nothing is
blessed. A future upward edge is cleared by moving vocabulary DOWN, never by adding an exception
(Decision 5) — the layer table has no exception list.

## Importing from outside `src/cost/`

L1–L2 may be imported directly. Everything in L3 and above goes through `index.ts` (ADR-0042
Decision 4). The same test enforces this for `src/` and `scripts/`; `test/` is exempt.

## Documented double read — the Weekly Reset Anchor

`ScanResult.sinceResetEntries` is empty unless the **Weekly Reset Anchor** is set: the anchor is
read once by the scan and again by assembly (ADR-0042 Decision 7). That double read is deliberate
— threading it through `ScanResult` would change the boundary type.
