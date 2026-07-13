// Health Type Vocabulary — the zero-logic leaf (issue #3230)
//
// The canonical Health Assessment type vocabulary, extracted verbatim out of the
// 551-line `src/health/diagnostics.ts` assessment module so the sibling modules
// that only need the TYPES (`rules.ts`, `fan-out.ts`, `skill-catalog.ts`,
// `wire.ts`) import them from a focused type-only leaf instead of pulling the
// full parse/assess/project pipeline — and the growing external-probe `import
// type` fan-in — into scope. `diagnostics.ts` now imports the vocabulary DOWN
// from here and keeps all assessment logic.
//
// This leaf follows the pattern already established by `event-bus-vocabulary.ts`
// (zero-side-effect type vocabulary for a domain) and `event-bus-stream-keys.ts`
// (zero-side-effect constant vocabulary): pure types and `import type`s, no
// logic, no I/O, no singleton. Every edge below is a compile-time-erased
// `import type` (or a downward pure-type import), so this module adds ZERO
// runtime coupling and cannot form an import cycle.
//
// Terminology (see CONTEXT.md): a **Health Snapshot** is the normalized internal
// model a rule may read; a **Health Diagnostic** is one finding; a **Health
// Assessment** is the folded result (diagnostics + status + summary). Distinct
// from **Builder Health** (capability trend) and the `/api/health` liveness
// boolean (process up).

// ---- External-probe type imports HealthSnapshot embeds --------------------
//
// Each of these `import type` edges landed here as a new health-probe category
// was added (issue #840 onward): a probe lands → its result type gets embedded
// in HealthSnapshot → this vocabulary grows an `import type` from the probe's
// home domain. They are ALL compile-time-erased (zero runtime coupling), so the
// pure parse seam (`diagnostics.ts`) that imports this leaf never value-imports
// the probe producers, preserving the acyclic dependency direction #840/#1771
// established.

// Issue #2492: HealthSnapshot.reflectionHealth carries the reflection-deposit
// health verdict. The projecting VALUE function (`projectReflectionHealth`)
// stays imported in diagnostics.ts (it is logic); only its report TYPE lives
// on the snapshot vocabulary here.
import type { ReflectionHealthReport } from "../metrics/reflection-health.ts";
// Issue #2023: HealthSnapshot.ovSearch.status names the OV-search probe's result
// vocabulary, owned by the ServiceProbe Adapter Seam. Issue #2278:
// HealthSnapshot.ollamaVlm carries the Tailnet Ollama VLM host probe result.
import type { OvSearchProbeStatus, OllamaVlmProbeResult } from "./probe.ts";
// Issue #2386: HealthSnapshot.skillCatalog carries the in-process OV
// skill-registration state so the two skill-catalog rules read it FROM the
// snapshot rather than calling getSkillCatalogState() out-of-band.
import type { SkillCatalogState } from "../knowledge-base/skill-registration.ts";
// Issue #2805: HealthSnapshot.darkOutcomes carries the dark leading-outcome
// verdicts (name + producerHint + metric file path) the wiring-liveness
// dark-outcome check produces, so the deep-health dark-outcome rule is a pure
// function of the snapshot like every other rule.
import type { OutcomeVerdict } from "../scheduler/chores/wiring-liveness-outcomes.ts";
// Issue #3251: HealthSnapshot.reflectionOutcomesLiveness carries the retired
// reflection-outcomes ledger's liveness verdict. The projecting VALUE function
// (`projectReflectionOutcomesLiveness`) stays imported in fan-out.ts (it is
// logic run at fan-out time over the probed ledger state); only its report TYPE
// lives on the snapshot vocabulary here.
import type { ReflectionOutcomesLivenessReport } from "./reflection-outcomes-liveness.ts";

// ---- Service Probe Map — the extensible external-service health record ----
//
// Issue #1869: `HealthSnapshot["svcProbes"]` used to be a hard-coded two-field
// struct (`{ vikingdb, openviking }`). Adding a third monitored service (e.g.
// the local Ollama embedding backend) meant edits in four places — the type,
// parseProbes' default, the wire projection, and the api/health.ts fan-out —
// plus a fifth in service-strip.ts. The field name named an implementation
// detail (a two-slot struct), not the domain concept: "the health of the
// external services the orchestrator depends on", a SET that can grow.
//
// Replacing the named duet with a string-keyed map concentrates the
// "what services exist" enumeration in the api/health.ts fan-out. The named
// keys (`"vikingdb"`, `"openviking"`) become map entries; diagnostic rules read
// `s.svcProbes["vikingdb"]?.status` via a keyed lookup that does NOT require a
// struct-field edit to add a new service. The on-wire field names in
// `/health/deep` are preserved for backward compatibility (out of scope per the
// issue): the projection reads the map by key.

/** One external-service probe result: liveness status + optional latency. */
export interface ServiceProbe {
  status: string;
  latencyMs?: number | null;
}

/**
 * The health of the external services the orchestrator depends on — an
 * extensible map keyed by service name (`"vikingdb"`, `"openviking"`, …) rather
 * than a fixed struct. Adding a new monitored service is a one-entry edit to the
 * api/health.ts probe fan-out (push a key + result), with no type, default, or
 * rule-set struct-field edits. A missing key reads `undefined` — rules guard
 * with optional chaining, so an absent probe is treated as "not failed".
 */
export type ServiceProbeMap = Record<string, ServiceProbe>;

// ---- Health Snapshot — the normalized internal model ---------------------

export interface HealthSnapshot {
  health: { status: string; redis: boolean; cycle: string; uptime: number };
  sched: {
    running: boolean;
    cyclesRun?: number;
    cyclesMerged?: number;
    cyclesFailed?: number;
    mergeRate?: number;
    consecutiveErrors: number;
    lastError?: string | null;
    lastCycleAt?: string | null;
    intervalHuman?: string;
  };
  // Issue #1869: extensible keyed map, not a fixed `{ vikingdb, openviking }`
  // struct — a new monitored service is a one-entry edit to the api/health.ts
  // fan-out, not a four-file struct-field change.
  svcProbes: ServiceProbeMap;
  queueDepth: number;
  blCounts: {
    triage: number;
    backlog: number;
    inProgress: number;
    blocked: number;
    done: number;
    total: number;
  };
  patterns: { planner: number; executor: number; skeptic: number };
  reflCount: number;
  // Issue #3270: the attribution ledger row count, probed at fan-out time so the
  // deep-health attribution-ledger-dark rule (rules.ts) is a pure function of the
  // snapshot. A count of 0 after the chore has been wired (post-#3113 fix) signals
  // the ledger population never fired — the exact dark-ledger symptom the issue
  // diagnoses. Honest-zero on a probe failure (the probe already returned 0).
  attributionLedgerCount: number;
  // Issue #2492: the reflection-deposit-health verdict over the recent
  // cycle-metrics window — the SAME projection GET /api/learning/reflection-health
  // serves, derived in parseProbes from the metrics-probe trend already collected
  // (a pure tally; no new I/O, no second cycle-record writer). Carried on the
  // snapshot so the deep-health reflection rule (rules.ts) is pure over `s` like
  // every other rule, surfacing the verdict as a NON-ALARM info diagnostic where
  // operators look — closing the discoverability gap that kept re-filing this as
  // a phantom bug (#1912→#2450→#2467→#2492).
  reflectionHealth: ReflectionHealthReport;
  // Issue #2386: the in-process OV skill-registration state (registered/total/
  // completed/skills/vlmDeferred), read live at fan-out time and carried here so
  // the two skill-catalog rules are pure over the snapshot — "what state did the
  // rules read?" is answerable from HealthSnapshot alone. Joins patterns/reflCount
  // as the other in-process (non-deep-probe) reads that flow through the pipeline.
  skillCatalog: SkillCatalogState;
  // Issue #2805: the dark leading-outcome verdicts from the wiring-liveness
  // dark-outcome check, read live at fan-out time and carried here so the
  // deep-health dark-outcome rule is pure over the snapshot. A `dark` verdict
  // carries the producerHint + metric file path (`query`) the rule surfaces
  // (success-criterion 2). An empty array is honest-none (no dark outcome, or the
  // check could not run) — the rule no-ops, never a phantom alarm.
  darkOutcomes: OutcomeVerdict[];
  // Issue #3251: the retired reflection-outcomes ledger's liveness verdict, read
  // live at fan-out time and carried here so the deep-health reflection-outcomes
  // rule is pure over the snapshot. Its default (`retired-empty`) is honest-none
  // — the rule fires a plain INFO explaining the retirement (turning an invisible
  // corpse into a self-documenting signal so the discover/arch-review loop stops
  // re-filing the phantom), and only escalates to a WARNING on the surprising
  // `unexpected-live-tail`. Mirrors the #2492/#2805 discoverability deepenings.
  reflectionOutcomesLiveness: ReflectionOutcomesLivenessReport;
  ovSearch: { status: OvSearchProbeStatus; latencyMs: number | null; resultCount: number };
  // Issue #2278: the Tailnet Ollama VLM host (gabes-desktop-1:11434) liveness
  // probe. A DIRECT reachability check of the host OpenViking uses for its
  // vision/indexing model — distinct from the OV-internal embed-backend probe.
  // `down` surfaces the recurring silent skill-catalog failure (#2277/#2269/…).
  ollamaVlm: OllamaVlmProbeResult;
  redisInfo: {
    memoryHuman: string;
    connectedClients: number;
    uptimeSeconds: number;
  } | null;
  emergencyBrake: { engaged: boolean; since?: number; engagedBy?: string };
  disk: { availableGb: number; totalGb: number; usedPercent: number };
  mem: { totalGb: number; availableGb: number; usedPercent: number };
  sysd: { orchestrator: string; watchdog: string; targetWeb: string };
  // Raw counts, NOT just rates — rules guard on mergedN>=3 and trend.length>=5.
  recent: {
    cycleCount: number;
    mergeRate: number;
    failedRate: number;
    noTaskRate: number;
    revertRate: number;
    mergedN: number;
    noTaskN: number;
    revertN: number;
    avgDurationMs: number;
    avgDurationHuman: string;
  };
}

// ---- Health Diagnostic — one finding -------------------------------------

export type HealthSeverity = "critical" | "error" | "warning" | "info";

export interface HealthDiagnostic {
  severity: HealthSeverity;
  component: string;
  what: string;
  why: string;
  impact: string;
  action: string;
  autoRecovery: boolean;
}

// ---- Health Assessment — the folded result -------------------------------

export interface HealthAssessment {
  diagnostics: HealthDiagnostic[];
  status: "healthy" | "degraded" | "unhealthy" | "critical";
  summary: string;
}

// ---- ProbeInputs — named record replacing the integer-indexed settled array --
//
// Issue #1771: the GET /health/deep handler fans out 19 probes in a
// Promise.allSettled([]) positional array, then passed the raw settled array to
// parseProbes(), which extracted values by integer subscript (settled[0]...[16]).
// The integer subscripts were a shared secret between api/health.ts and
// diagnostics.ts documented only in comments.
//
// Fix: the handler's assembleProbeInputs() (in fan-out.ts, the I/O owner)
// maps the settled results into this named record immediately after the fan-out,
// then passes it to parseProbes() and projectHealthDeepResponse(). Only the
// named-record TYPE lives here in the pure vocabulary leaf (#840); the
// integer-indexed mapping stays in the I/O handler. Adding a probe is now a new
// named field — the compiler enforces that the builder (fan-out.ts) and both
// consumers agree by name.
//
// Index 3 (cycle) is handler-only and not part of ProbeInputs.
//
// Issue #1833: every field below carries the shape its probe actually produces,
// `| null` for the rejected-settle case (assembleProbeInputs' `val()` returns
// null when a settle rejected). The field types are the SAME shapes parseProbes
// already reasons about via its `|| default` reads and projectHealthDeepResponse
// reads — they reuse the local HealthSnapshot sub-shapes so the pure seam stays
// import-free (no coupling back to the I/O-layer producer modules), keeping the
// dependency direction #840/#1771 established. A probe field renamed on the I/O
// side (fan-out.ts) is now a compile error at assembleProbeInputs rather than
// a silent runtime miss caught only by a `|| default`.

/**
 * The two persisted-metrics fields parseProbes' `recent` pipeline reads off the
 * index-6 metrics probe. Only `trend` is consumed (the per-cycle rollup rows);
 * `stats` rides along from getAggregateStats but no rule reads it, so it stays
 * loosely typed. Each trend row's numeric fields arrive as strings (Redis hash
 * values) — parseProbes coerces with parseInt — so they're typed string|number.
 */
export interface ProbeMetricsInput {
  trend?: Array<{
    tasksMerged?: string | number;
    tasksFailed?: string | number;
    taskTitle?: string;
    rolledBack?: string | boolean;
    totalDurationMs?: string | number;
  }>;
  stats?: unknown;
}

export interface ProbeInputs {
  basicHealth: HealthSnapshot["health"] | null;
  serviceProbes: HealthSnapshot["svcProbes"] | null;
  scheduler: HealthSnapshot["sched"] | null;
  queueDepth: number | null;
  backlogCounts: HealthSnapshot["blCounts"] | null;
  metrics: ProbeMetricsInput | null;
  disk: HealthSnapshot["disk"] | null;
  mem: HealthSnapshot["mem"] | null;
  sysdOrchestrator: string | null;
  sysdWatchdog: string | null;
  sysdTargetWeb: string | null;
  patterns: HealthSnapshot["patterns"] | null;
  reflections: number | null;
  // Issue #3270: the attribution ledger LLEN, read at fan-out time (async probe,
  // NOT a direct in-memory read). `| null` on a rejected settle — parseProbes
  // coalesces to 0 (honest-none: the rule sees "empty", never a phantom populated
  // ledger). Pairs with the deep-health attribution-ledger-dark rule in rules.ts.
  attributionLedgerCount: number | null;
  // Issue #2386: the in-process OV skill-catalog state, read synchronously at
  // fan-out time (NOT a Promise.allSettled probe — it is a pure in-memory copy,
  // never I/O). `| null` so a fan-out that cannot resolve it degrades to the
  // parseProbes safe default (an un-run, empty catalog → the two skill-catalog
  // rules no-op) exactly as a rejected async probe would.
  skillCatalog: HealthSnapshot["skillCatalog"] | null;
  // Issue #2805: the dark leading-outcome verdicts, read at fan-out time (NOT a
  // Promise.allSettled probe — it is a direct never-throwing chore read like the
  // skill-catalog state). `| null` so a fan-out that cannot resolve it degrades
  // to the parseProbes empty-array default (the dark-outcome rule no-ops),
  // honest-none exactly as a rejected async probe would.
  darkOutcomes: HealthSnapshot["darkOutcomes"] | null;
  // Issue #3251: the retired reflection-outcomes ledger's liveness report,
  // PROJECTED at fan-out time from the raw ZSET probe (like the darkOutcomes
  // direct read — the projection needs a clock, so it runs in the I/O owner, not
  // in the clock-free parseProbes seam). `| null` so a fan-out that cannot
  // resolve it degrades to the parseProbes honest-none default
  // (`retired-empty` → the rule fires the plain retirement INFO), exactly as a
  // rejected async probe would.
  reflectionOutcomesLiveness: HealthSnapshot["reflectionOutcomesLiveness"] | null;
  ovSearch: HealthSnapshot["ovSearch"] | null;
  // Issue #2278: the Tailnet Ollama VLM host liveness probe result. `| null` on a
  // rejected settle (the never-throwing probe folds its own failures to a `down`
  // result, so null only ever means the whole settle rejected upstream).
  ollamaVlm: HealthSnapshot["ollamaVlm"] | null;
  redisInfo: HealthSnapshot["redisInfo"];
  emergencyBrake: HealthSnapshot["emergencyBrake"] | null;
  // Indices 17/18: consumed by projectHealthDeepResponse for OV quality trends.
  // projectHealthDeepResponse passes both straight onto the wire as `unknown`
  // (ovSearchTrend/knowledgeContext) — the persisted-rollup shapes live in the
  // I/O-layer ov-search-metrics module, so they stay `unknown` here to avoid
  // importing that producer type into the pure seam.
  ovSearchWindow: unknown;
  knowledgeContext: unknown;
}
