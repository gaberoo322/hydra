/**
 * Page verdict tables for the live precondition checklist (issue #4629,
 * ADR-0034 §8.3; design-concept 821e48ed INV-4/INV-14).
 *
 * Each function maps facts a page ALREADY reads onto one boolean per
 * CONTROL_CHECKS id (src/schemas/operator-actions.ts) its controls use; the
 * affordance joins the table to the registry's `{text, check}` lines through
 * lib/preconditions.ts (a missing id fails closed to ✗). Extracted from the
 * pages so every row of every table is unit-tested with node:test
 * (test/operator-actions-affordance.test.mts) — the dashboard ships no JSX
 * test runner. One exported function per page surface; a new page's table is
 * a sibling function here.
 */

/** The relabel targets the server schema accepts (RELABEL_TARGETS' mirror,
 * src/schemas/autopilot-board.ts). */
export const RELABEL_TARGETS: readonly string[] = Object.freeze([
  "needs-triage",
  "needs-info",
  "ready-for-human",
  "blocked",
]);

export type Verdicts = Record<string, boolean>;

/** The row facts GET /autopilot/work-queue projects (WorkQueueRow subset). */
export interface WorkRowFacts {
  lane?: string;
  hasScopeSection?: boolean;
  openBlockers?: readonly number[];
}

/**
 * /work — one queue row's checks. Reads only the server-computed row facts
 * (never a client-side body parse): `hasScopeSection` is the shared parser's
 * verdict and `openBlockers` the resolved open strict refs.
 */
export function rowVerdicts(row: WorkRowFacts, relabelTarget: string | undefined): Verdicts {
  return {
    // Every queue row comes from the open-issues scan (GET /autopilot/work-queue
    // reads open issues only) — closed issues never reach this table, and the
    // server gate re-checks CLOSED on write.
    "issue-open": true,
    "not-already-ready": row.lane !== "ready-for-agent",
    "has-scope-section": row.hasScopeSection === true,
    "no-open-blocker": Array.isArray(row.openBlockers) && row.openBlockers.length === 0,
    "relabel-target-chosen":
      typeof relabelTarget === "string" && RELABEL_TARGETS.includes(relabelTarget),
  };
}

/** /work — the reopen-by-number input is the only fact. */
export function reopenVerdicts(reopenNumber: string): Verdicts {
  const n = Number(reopenNumber);
  return { "issue-number-entered": reopenNumber !== "" && Number.isInteger(n) && n >= 1 };
}

/** The enrol-state row fact /work's holdback panel reads (HoldbackEnrolState). */
export interface EnrolRowFacts {
  state?: string;
}

/**
 * /work — one holdback enrol row's check (issue #5164): "Enrol now" is a
 * re-attempt of a FAILED automation step, so it is enabled only on a literal
 * `failed` row state.
 */
export function enrolVerdicts(row: EnrolRowFacts): Verdicts {
  return { "holdback-enrol-failed": row.state === "failed" };
}

/** The two /health flags the controls check (the /health payload subset). */
export interface HealthFacts {
  autopilotPause?: { paused?: boolean; ok?: boolean } | null;
  emergencyBrake?: { engaged?: boolean; ok?: boolean } | null;
}

/**
 * /health — the pause and brake checks. `trusted` is false while the /health
 * read is loading or UNKNOWN; then, or when a flag is absent or carries
 * `ok:false`, nothing is verified and every state check is false (✗).
 */
export function healthVerdicts(data: HealthFacts | null | undefined, trusted: boolean): Verdicts {
  const pause = data?.autopilotPause;
  const brake = data?.emergencyBrake;
  const pauseVerified = trusted === true && pause != null && pause.ok !== false;
  const brakeVerified = trusted === true && brake != null && brake.ok !== false;
  return {
    "pause-state-verified": pauseVerified,
    "autopilot-running": pauseVerified && pause!.paused !== true,
    "autopilot-paused": pauseVerified && pause!.paused === true,
    "brake-state-verified": brakeVerified,
    "brake-off": brakeVerified && brake!.engaged !== true,
    "brake-engaged": brakeVerified && brake!.engaged === true,
  };
}

/** The CONTROL_CHECKS ids of the /work design-concept approve control, in
 * registry order (issue #5163; src/schemas/operator-actions.ts). */
export const DESIGN_CONCEPT_CHECKS: readonly string[] = Object.freeze([
  "dc-artifact-stored",
  "dc-status-draft",
  "dc-handoff-hash-matches",
]);

/** The approve-preconditions payload subset the verdict table reads. */
export interface DesignConceptPreFacts {
  preconditions?: ReadonlyArray<{ check?: string | null; ok?: boolean }> | null;
}

/**
 * /work — the design-concept approve control's checks (issue #5163). One
 * boolean per `preconditions[i].check` the server-evaluated read returned,
 * set to `ok === true`. FAIL-CLOSED: when `trusted` is false (the read is
 * loading / unknown / stale) or the payload is absent, every `dc-*` id is
 * present and false, so the affordance disables exactly like the old
 * `enabled` guard. A line whose `check` is missing produces no key, which
 * lib/preconditions.ts renders ✗.
 */
export function designConceptVerdicts(
  pre: DesignConceptPreFacts | null | undefined,
  trusted: boolean,
): Verdicts {
  const out: Verdicts = {};
  for (const id of DESIGN_CONCEPT_CHECKS) out[id] = false;
  if (trusted !== true || pre == null || !Array.isArray(pre.preconditions)) return out;
  for (const line of pre.preconditions) {
    if (typeof line?.check === "string" && line.check !== "") out[line.check] = line.ok === true;
  }
  return out;
}
