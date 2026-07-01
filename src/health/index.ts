/**
 * Health Assessment domain — public barrel.
 *
 * The six sibling modules in this directory form the `/api/health/deep`
 * pipeline (probe fan-out → parse → rule-assess → project response). They were
 * collected here from flat `src/health-*.ts` files (issue #2123) to give the
 * family a structural home that mirrors `src/backlog/`, `src/github/`, and
 * `src/host-probe/`. The module boundaries and internal dependency graph are
 * unchanged; only file locations moved.
 *
 * This barrel re-exports the surface external consumers need so that
 * `src/api/health.ts` (the single route) and the per-module test files import
 * from `../health` / `../src/health` rather than reaching into each submodule.
 * Internal cross-imports between the modules stay relative (`./rules.ts`).
 */
export * from "./deployed-sha.ts";
export * from "./diagnostics.ts";
export * from "./fan-out.ts";
export * from "./probe.ts";
export * from "./rules.ts";
export * from "./skill-catalog.ts";
export * from "./wire.ts";
// Issue #2570: the WoL Adapter (WakeGate, readWolConfig, attempt*Wake, and the
// process-lifetime getWolGates()/resetWolGates() singleton lifecycle that the
// fan-out now reads its gate pair from). Re-exported through the barrel like the
// other modules so consumers go through `../health` rather than reaching into
// the submodule directly.
export * from "./wol.ts";
