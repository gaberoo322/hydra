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
// `HealthDiagnostic` from the pipeline seam (it consumes the pipeline's output
// type); the pipeline never imports back. The input is decoupled from the
// producer's concrete type via the structural `SkillCatalogSnapshot` shape, so
// this module is unit-testable without standing up OpenViking and never touches
// the registry module — the I/O handler (api/health.ts) reads the live state
// and passes it in.

import type { HealthDiagnostic } from "./diagnostics.ts";

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
