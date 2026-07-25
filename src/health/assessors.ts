// Health Assessors — named multi-policy rule bodies (issue #3634)
//
// The complex, multi-policy diagnostic rule bodies extracted out of the `RULES`
// array in `src/health/rules.ts` into named, individually-testable assessor
// functions. This mirrors the `src/health/skill-catalog.ts` precedent
// (`assessSkillCatalog` / `assessRegistrationFailureRate`): a focused module
// that owns diagnostic POLICY — thresholds, multi-metric detail formatting, and
// the narrative why/impact/action strings — as pure functions of a NARROW
// `HealthSnapshot` slice.
//
// Each assessor takes only the fields it reads (not the full 30-field snapshot)
// and returns `HealthDiagnostic | null` — exactly the shape a `RULES` array
// element expects — so a unit test stubs just the slice, never a full snapshot.
// In `rules.ts` each extracted rule becomes a thin same-slot pass-through
// `(s) => assessX(s.slice)`, preserving the load-bearing array ordering that
// `diagnostics.ts` runs (and quotes `diagnostics[0].what` from).
//
// Only the multi-policy rules with independent test identity are extracted here.
// Genuinely-shallow one-liner rules (killed, redis-down, emergency-brake,
// disk/mem-crit, revert-rate, the generic svc iterator, …) stay inline in
// `rules.ts` — extracting them would add indirection without test/locality
// payoff. The `SVC_PROBES_WITH_BESPOKE_RULES` registration/sequencing policy
// stays in `rules.ts`; `assessEmbedBackendProbe` below covers only the bespoke
// embed-backend diagnostic.
//
// Coupling direction is one-way and correct (mirrors skill-catalog.ts): this
// module type-imports the health type vocabulary from the zero-logic leaf
// `types.ts` only — no new runtime deps (ADR-0005), no value import back into
// the assessment pipeline, so the acyclic dependency graph is preserved. Every
// assessor is a pure total function that never throws (src/health convention;
// "reads only its argument").

import type { HealthDiagnostic, ServiceProbeMap } from "./types.ts";
// Issue #3634: ReflectionHealthReport and OutcomeVerdict are the slice types the
// assessors read. types.ts type-imports them from their home domains but does not
// re-export them, so assessors.ts imports them from the same producer modules —
// preserving the acyclic, compile-time-erased type-leaf dependency direction
// (mirrors how types.ts itself sources them).
import type { ReflectionHealthReport } from "../metrics/reflection-health.ts";
import type { OutcomeVerdict } from "../scheduler/chores/wiring-liveness-outcomes.ts";

// ---------------------------------------------------------------------------
// assessEmbedBackendProbe (issue #2131)
//
// A BESPOKE rule for the OpenViking dense-embedding + VLM backend (the gaming-PC
// Ollama endpoint reached over Tailscale, #980/#1795). The #2013 `embed-backend`
// probe (probeEmbedBackend → folds an ov-service-down / ov-timeout on the
// embedding-exercising `search/find` transport to "failed") already lands a keyed
// svcProbes["embed-backend"] entry. The generic "external service not running"
// iterator (still inline in rules.ts) WOULD cover it, but with a generic message
// that neither names the offline backend nor points at the recovery path. The
// 2026-06-18 outage (#2104/#2064/#1831) showed the cost: a fully-offline backend
// surfaced only as the benign `info` "OV search slow", so nothing operator-facing
// escalated. This bespoke `warning` is the loud, actionable signal that gap needs —
// it names the offline embedding/VLM backend and points at the Wake-on-LAN recovery
// path (#1794). It is excluded from the generic iterator (SVC_PROBES_WITH_BESPOKE_RULES
// in rules.ts) so the degraded backend is reported exactly once. The slow-but-reachable
// case is untouched: a slow OV search still folds the ovSearch probe to "timeout" →
// `info` "OV search slow" (the embed-backend probe only fails on a transport-level
// ov-service-down / ov-timeout — OV answering at all, even slowly, reads "running"),
// so no false alert fires.
export function assessEmbedBackendProbe(svcProbes: ServiceProbeMap): HealthDiagnostic | null {
  return svcProbes["embed-backend"]?.status === "failed"
    ? {
        severity: "warning",
        component: "embed-backend",
        what: "Embedding/VLM backend unreachable",
        why: "The OpenViking dense-embedding + VLM backend (the gaming-PC Ollama endpoint, gabes-desktop-1:11434, reached over Tailscale — #980/#1795) did not answer the embedding-exercising search probe. OpenViking itself may be up while this backend is offline.",
        impact: "Knowledge-plane search degrades to empty and the learning indexer stalls — agents run cycles with reduced context until the backend recovers.",
        action: "Wake/check the gaming PC (Wake-on-LAN recovery: #1794). Verify the backend: curl -m5 http://gabes-desktop-1:11434/api/tags. See OpenViking embedding/VLM backend split in docs/reference.md.",
        autoRecovery: true,
      }
    : null;
}

// ---------------------------------------------------------------------------
// assessReflectionHealth (issue #2492)
//
// Surface the reflection-deposit-health verdict through the deep-health fold so
// an operator checking /api/health/deep sees it where they look — closing the
// discoverability gap that kept re-filing a NON-bug (#1912→#2450→#2467→#2492).
// The full verdict ALWAYS rides the wire envelope (intelligence.reflectionHealth),
// so this assessor deliberately fires NOTHING on the honest `all-none-empty-store` /
// `healthy` / `no-data` states — a 100%-`none` distribution on an empty reflection
// store is the EXPECTED steady state of a high-merge-rate run (reflections are
// produced only on a non-merged failure), NOT an alarm; folding it to `degraded`
// would BE the false alarm the design-concept invariant forbids (mirrors the
// #2386/#2278 honest-none-never-phantom-alarm discipline). It fires a single INFO
// (never warning/error) ONLY on `served-but-bucketed-none`: a cycle DID carry a
// present reflectionSources deposit yet still bucketed `none` — the genuine
// candidate false-none worth an operator's eye (deposit/read plumbing), distinct
// from the honest empty store.
export function assessReflectionHealth(
  reflectionHealth: ReflectionHealthReport,
): HealthDiagnostic | null {
  return reflectionHealth.verdict === "served-but-bucketed-none"
    ? {
        severity: "info",
        component: "intelligence",
        what: "Reflection deposit served but bucketed 'none'",
        why: reflectionHealth.note,
        impact:
          "A reflection deposit landed yet did not register as applied context — a candidate false-none (distinct from the EXPECTED all-none of an empty store on a high-merge run, which is not surfaced here). Learning-context telemetry may under-count what reached a retry.",
        action:
          "Inspect the deposit/read path: GET /api/learning/reflection-health for the full distribution; confirm reap.py reflection_sources forwarding and the per-anchor/by-file read seam (src/reflections/index.ts).",
        autoRecovery: true,
      }
    : null;
}

// ---------------------------------------------------------------------------
// assessDarkLeadingOutcomes (issue #2805)
//
// Surface a DARK leading outcome (a `kind: leading` outcome whose reading is null —
// no data ever produced) through the deep-health fold so an operator watching
// /api/health/deep sees the vision's primary-path blindness where they look. The
// full dark-outcome check runs at fan-out time and lands on the snapshot
// (s.darkOutcomes); this assessor is a PURE function of that slice (Invariant 5) —
// no I/O. Advisory WARNING severity, never critical (Invariant 7): a dark leading
// outcome is silent Outcome-Holdback blindness (every baseline carries value:null),
// NOT a process fault. The why/action carry the producerHint + metric file path
// (query) so the operator knows WHICH producer is dark and where it should write
// (Invariant 6). Fires only when at least one leading outcome reads dark; an all-live
// (or empty) slice no-ops — honest-none, never a phantom alarm (mirrors the
// #2492/#2386 discipline).
export function assessDarkLeadingOutcomes(
  darkOutcomes: OutcomeVerdict[],
): HealthDiagnostic | null {
  const dark = (darkOutcomes || []).filter((v) => v.status === "dark");
  if (dark.length === 0) return null;
  const detail = dark
    .map((v) => `${v.name} (${v.producerHint}) → should write ${v.query}`)
    .join("; ");
  return {
    severity: "warning",
    component: "intelligence",
    what: `Dark leading outcome${dark.length > 1 ? "s" : ""}: ${dark.map((v) => v.name).join(", ")}`,
    why: `A kind:leading outcome has read null (no data ever produced). ${detail}`,
    impact:
      "Silent Outcome-Holdback blindness — every holdback baseline carries value:null for this outcome, so the system cannot tell whether its learning improves the vision's primary-path metric.",
    action:
      "Diagnose the named producer chain and bring it live; the wiring-liveness dark-outcome alarm (issue #2805) auto-files a needs-triage issue once the outcome has been continuously dark for 7+ days.",
    autoRecovery: false,
  };
}

// ---------------------------------------------------------------------------
// assessAttributionLedger (issue #3270)
//
// Warn when the attribution ledger is empty. The attribution spine (epic #2628)
// was designed to populate `hydra:attribution:ledger` with per-merge observation
// rows as soon as PRs land and their windows close. An empty ledger after the
// wiring (post-#3113 ordering fix) signals the producer flow never fired — the
// exact symptom issue #3270 diagnoses. Advisory: surfaces as a WARNING (not error)
// so an operator is alerted without blocking the pipeline. Fires only when
// count === 0 (never on partial population); the honest-zero default on probe
// failure means this assessor no-ops when the probe itself fails (honest-none,
// never a phantom alarm).
export function assessAttributionLedger(
  attributionLedgerCount: number,
): HealthDiagnostic | null {
  if (attributionLedgerCount > 0) return null;
  return {
    severity: "warning" as const,
    component: "intelligence",
    what: "Attribution ledger is empty — merger→ledger flow never fired",
    why: "The outcome-attribution spine (epic #2628) wires `runAttributionRecord` as a housekeeping chore (issue #2632) to populate `hydra:attribution:ledger` with per-merge observation rows. The ledger has 0 rows, meaning the producer flow (open window on PR landing → close window after duration → append row) has not completed a single cycle. The issue #3113 ordering fix (attribution-record before holdback-merge-watch in housekeeping.ts) must be applied AND at least one PR must have landed AND its window must have elapsed.",
    impact: "The ridge estimator (#2630) and per-class scoreboard (#2943) have no data — `estimateMarginalEffects` returns empty results and the outcome-attribution spine is dark despite the wiring existing.",
    action: "Check `runAttributionRecord` logs (`journalctl --user -u hydra-orchestrator.service | grep '\[attribution\]'`). Verify: (1) holdback pending-enroll registry has/had entries (`HGETALL hydra:holdback:pending-enroll`); (2) attribution-record chore runs BEFORE holdback-merge-watch in housekeeping.ts (issue #3113); (3) at least one window has elapsed (`HGETALL hydra:attribution:windows`).",
    autoRecovery: false,
  };
}
