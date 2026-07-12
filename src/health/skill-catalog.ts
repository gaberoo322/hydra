// ---------------------------------------------------------------------------
// Skill-Catalog Health Seam (issue #1992; gate first added in #1968)
//
// The pure verdict over the in-process skill-catalog state produced by
// `registerSkills` (src/knowledge-base/skill-registration.ts). Extracted out of
// the Health Assessment pipeline (`src/health/diagnostics.ts`) into a focused
// module that owns ONE concern: "what defines a healthy skill catalog".
//
// Why a separate file (issue #1992): the skill-catalog health concern is the
// health of the Knowledge Base's in-process skill registration state — a
// structural view of `registerSkills`'s outcome, NOT a probe-marshalling input.
// `diagnostics.ts` is the `parseProbes` → `assessHealth` parse-pipeline
// seam (the data-OUT `projectHealthDeepResponse` leg split to wire.ts in
// #2039), deliberately import-free / no-I/O
// (#840). Its two callers for THIS concern (`rules.ts` and
// `api/health.ts`) now import from the module named after the concern rather
// than navigating the ~700-line pipeline module to find it.
//
// Coupling direction is one-way and correct: this module type-imports
// `HealthDiagnostic` from the zero-logic type leaf (issue #3230: it consumes the
// pipeline's output type); the pipeline never imports back. The input is
// decoupled from the producer's concrete type via the structural
// `SkillCatalogSnapshot` shape, so this module is unit-testable without standing
// up OpenViking and never touches the registry module — the I/O handler
// (api/health.ts) reads the live state and passes it in.

import type { HealthDiagnostic } from "./types.ts";

/** The structural shape `assessSkillCatalog` reads off the catalog state. */
export interface SkillCatalogSnapshot {
  /** Skills currently registered with OpenViking. */
  registered: number;
  /** Total skills the catalog expects. */
  total: number;
  /** true once a registration pass has finished (success OR failure). */
  completed: boolean;
  /** Last failure code per un-registered skill, for the diagnostic detail. */
  skills: Array<{ name: string; registered: boolean; lastError: string | null }>;
  /**
   * true when the last pass was DEFERRED because the Tailnet Ollama VLM backend
   * was down (issue #2277) — the empty catalog is a deliberate graceful
   * degradation (registrations skipped to avoid the timeout cascade), NOT the
   * #1968 "every POST failed under load" empty. Optional so callers that pre-date
   * the field default to the non-deferred (#1968) framing.
   */
  vlmDeferred?: boolean;
}

/** Folded verdict on the skill catalog: a status plus an optional diagnostic. */
export interface SkillCatalogAssessment {
  /** `ok` = all registered; `degraded` = some missing; `empty` = none registered. */
  status: "ok" | "degraded" | "empty";
  diagnostic: HealthDiagnostic | null;
}

/**
 * Pure health gate over the skill-catalog state (#1968). Distinguishes the
 * three operator-meaningful states:
 *  - `ok`       — every expected skill is registered (or no pass has run yet,
 *                 which is the pre-startup no-op: no alarm, registration is
 *                 still in flight).
 *  - `degraded` — a pass completed but some skills failed to register.
 *  - `empty`    — a pass completed and ZERO skills registered: the silent
 *                 knowledge-plane failure this issue exists to surface. Planners
 *                 run without skill context, degrading forecast quality.
 *
 * Never throws; reads only its argument.
 */
export function assessSkillCatalog(snap: SkillCatalogSnapshot): SkillCatalogAssessment {
  // No pass has completed yet (fresh process, registration still in flight) —
  // treat as ok/in-flight so a slow startup isn't a false alarm.
  if (!snap.completed) {
    return { status: "ok", diagnostic: null };
  }
  if (snap.registered >= snap.total && snap.total > 0) {
    return { status: "ok", diagnostic: null };
  }

  const missing = snap.skills.filter((s) => !s.registered);
  const missingDetail = missing
    .map((s) => `${s.name}${s.lastError ? ` (${s.lastError})` : ""}`)
    .join(", ");

  // Issue #2277 — graceful-degradation path. The last pass was DEFERRED because
  // the Tailnet Ollama VLM backend was down: the orchestrator deliberately
  // SKIPPED the registrations (rather than burning the 4×3×120s timeout budget
  // against a handler that cannot answer while the VLM is offline). Report this
  // as `degraded` (warning, auto-recovering) — NOT the #1968 `empty` (error). It
  // is a known, self-healing condition: the hourly Housekeeping chore
  // re-registers once OV/VLM recovers, no restart needed. Surfacing it as `empty`
  // would mis-frame a deliberate degradation as a hard registration failure and
  // mis-route the operator to OpenViking load / a restart.
  if (snap.vlmDeferred) {
    return {
      status: "degraded",
      diagnostic: {
        severity: "warning",
        component: "intelligence",
        what: "OV skill catalog deferred (VLM backend down)",
        why: "The Tailnet Ollama VLM backend (gabes-desktop-1:11434) was down at registration time, so all skill registrations were SKIPPED to avoid the timeout cascade (#2277/#2269/#1831) — the catalog is empty by deliberate graceful degradation, not failed POSTs.",
        impact: "Planners run without skill context until the VLM recovers — degraded forecast quality; contributes to the no-task rate (#1832).",
        action: "Recover the Ollama VLM host (Wake-on-LAN: #1794) — see docs/operator-playbooks/ollama-recovery.md. Once it answers, the hourly Housekeeping chore re-registers the skills automatically (no restart needed).",
        autoRecovery: true,
      },
    };
  }

  if (snap.registered === 0) {
    return {
      status: "empty",
      diagnostic: {
        severity: "error",
        component: "intelligence",
        what: "OV skill catalog empty",
        why: "Every skill registration failed (typically OpenViking timing out / 5xx-ing under indexing load, #1924/#1831). The service started clean but the catalog is unpopulated.",
        impact: "Planners run without skill context — degraded forecast quality and contributes to the no-task rate (#1832).",
        action: `Check OpenViking load and restart the orchestrator once it recovers. Failed: ${missingDetail || "all skills"}.`,
        autoRecovery: false,
      },
    };
  }

  return {
    status: "degraded",
    diagnostic: {
      severity: "warning",
      component: "intelligence",
      what: `OV skill catalog partial (${snap.registered}/${snap.total})`,
      why: "Some skill registrations failed (transient OpenViking timeout / 5xx under load, #1924/#1831).",
      impact: "Planners relying on the missing skills run without their context.",
      action: `Restart the orchestrator once OpenViking recovers. Missing: ${missingDetail}.`,
      autoRecovery: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Registration-failure-rate alert (issue #2277)
//
// `assessSkillCatalog` above gates on the catalog POPULATION (ok / degraded /
// empty). The residual #2277 deliverable is a distinct concern: the registration
// FAILURE RATE of the last completed pass, correlated with the root cause the
// recurring outage points at — the Tailnet Ollama VLM backend being offline.
//
// The issue asked for "timeout monitoring on OV skill registration failures
// (alert if >10% in 5min window)". The orchestrator does not keep a rolling
// 5-minute window of per-attempt outcomes; the queryable signal it DOES carry is
// the per-pass `registered/total` rollup (skill-registration.ts, #1968). So the
// alert reads that completed-pass failure rate — `(total - registered) / total`
// — and fires when it crosses `REGISTRATION_FAILURE_RATE_THRESHOLD`. When the
// liveness probe (#2284) shows the VLM host `down`, the alert names that as the
// likely root cause and points at the Wake-on-LAN recovery path + the
// ollama-recovery operator playbook; otherwise it points at OpenViking load.
//
// This is ADDITIVE and strictly read-only: it consumes the existing
// `SkillCatalogSnapshot` plus the already-shipped `ollamaVlm` probe result, owns
// no new export on skill-registration.ts, and never mutates the catalog state.
// It is distinct from `assessSkillCatalog`'s empty/partial verdict — an `empty`
// catalog (rate 100%) ALSO trips this alert, but with the VLM-root-cause framing
// the population gate deliberately omits, so an operator sees both "catalog is
// empty" and "and here is why + how to recover". It fires `warning` (not
// `error`) so it never escalates the deep-health fold above the population gate's
// own severity — it annotates, it does not outrank.
// ---------------------------------------------------------------------------

/**
 * Failure-rate threshold above which the registration-failure-rate alert fires
 * (issue #2277: "alert if >10% in 5min window" — here applied to the last
 * completed pass's `(total - registered) / total`). A strict `>` so a single
 * failed skill out of four (25%) trips it but a fully-registered catalog (0%)
 * never does.
 */
const REGISTRATION_FAILURE_RATE_THRESHOLD = 0.1;

/** The VLM-liveness facet the failure-rate alert reads, mirroring `OllamaVlmProbeResult`. */
export interface VlmLiveness {
  /** `down` when the Tailnet Ollama VLM host did not answer its liveness probe (#2284). */
  status: "ok" | "down";
}

/**
 * Read-only registration-failure-rate alert (issue #2277). Returns a
 * `HealthDiagnostic` when the last completed registration pass left a failure
 * rate above {@link REGISTRATION_FAILURE_RATE_THRESHOLD}, else `null`.
 *
 * Reads ONLY its two arguments — the catalog snapshot and the VLM liveness facet
 * — and never throws (src/health convention). It does NOT mutate skill
 * registration state and adds no new export to skill-registration.ts; it is a
 * pure consumer of `getSkillCatalogState()` and the #2284 `ollamaVlm` probe.
 *
 * No alarm before a pass completes (`completed:false`) — registration is still
 * in flight, a slow startup is not a failure. A `total` of 0 (mis-seeded /
 * pre-pass) cannot have a meaningful rate, so it is treated as no-op.
 *
 * When the VLM host is `down`, the diagnostic names it as the likely root cause
 * (the #2277/#2269/#1831 cascade) and points at the Wake-on-LAN recovery path +
 * the ollama-recovery operator playbook. When the VLM host is reachable, it
 * points at OpenViking load instead — the failures are happening for a different
 * reason and the operator should not chase a red herring.
 */
export function assessRegistrationFailureRate(
  snap: SkillCatalogSnapshot,
  vlm: VlmLiveness,
): HealthDiagnostic | null {
  // No completed pass / no skills expected → no meaningful rate to alert on.
  if (!snap.completed || snap.total <= 0) return null;

  // Issue #2277 — when the last pass was DEFERRED (the orchestrator deliberately
  // skipped registration because the VLM was down), the population gate
  // `assessSkillCatalog` already emits the single degraded/VLM-down diagnostic.
  // Suppress the failure-rate alert here so the operator does not see TWO findings
  // for one deliberate degradation — there was no failed *registration* to rate
  // (nothing was POSTed), so a "100% failure rate" framing would be misleading.
  if (snap.vlmDeferred) return null;

  const failed = snap.total - snap.registered;
  const rate = failed / snap.total;
  if (rate <= REGISTRATION_FAILURE_RATE_THRESHOLD) return null;

  const pct = Math.round(rate * 100);
  const vlmDown = vlm.status === "down";

  // `warning`, deliberately NOT `error`: this alert ANNOTATES the population
  // verdict (assessSkillCatalog, which already folds empty→error / partial→
  // warning) with the failure-rate framing + the VLM root cause. It must not
  // ESCALATE the top-level deep-health status above what the population gate
  // decided — a partial catalog stays `degraded`, an empty one stays `unhealthy`
  // from the population rule's own `error`. So this rule contributes a
  // same-or-lower severity finding that adds the "why + how to recover" detail
  // without changing the fold.
  return {
    severity: "warning",
    component: "intelligence",
    what: `OV skill registration failure rate ${pct}% (${failed}/${snap.total} failed)`,
    why: vlmDown
      ? "The last skill-registration pass failed above the 10% alert threshold AND the Tailnet Ollama VLM backend (gabes-desktop-1:11434) is down — the recurring root-cause cascade (#2277/#2269/#1831): OpenViking blocks on VLM summarization, the /api/v1/skills endpoint times out, and registration burns its retries."
      : "The last skill-registration pass failed above the 10% alert threshold while the Ollama VLM backend is reachable — so the failures are NOT the usual VLM-offline cascade. OpenViking is likely overloaded/5xx-ing under indexing load (#1924/#1831).",
    impact:
      "Planners run without the missing skill context — degraded forecast quality and contributes to the no-task rate (#1832).",
    action: vlmDown
      ? "Recover the Ollama VLM host (Wake-on-LAN: #1794) — see docs/operator-playbooks/ollama-recovery.md. Once it answers, the hourly Housekeeping chore re-registers the missing skills (no restart needed)."
      : "Check OpenViking load (curl http://localhost:1933/health) and back off concurrent indexing; the failures will clear once OV stops 5xx-ing. See docs/operator-playbooks/ollama-recovery.md.",
    autoRecovery: vlmDown,
  };
}
