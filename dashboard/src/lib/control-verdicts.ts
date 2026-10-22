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
