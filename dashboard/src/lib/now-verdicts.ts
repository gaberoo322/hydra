/**
 * /now verdict tables for the recommendation controls (issue #5152,
 * ADR-0034 §8.3; registry keys `control:now/rec-dismiss` and
 * `control:now/rec-mute-class`).
 *
 * A pure leaf, sibling of lib/health-verdicts.ts: each function maps facts
 * RecommendationsPanel ALREADY holds (its own GET's `run_id`, its severity
 * picker's choice) onto one boolean per CONTROL_CHECKS id
 * (src/schemas/operator-actions.ts); lib/preconditions.ts joins them to the
 * registry's `{text, check}` lines, and any ✗ disables the trigger.
 * Unit-tested with node:test (test/now-recommendations.test.mts); the
 * dashboard ships no JSX test runner.
 */

export type Verdicts = Record<string, boolean>;

/** RecMuteClassBodySchema's closed severity enum — exactly these three. */
export const REC_SEVERITIES = ["info", "warn", "critical"] as const;
export type RecSeverity = (typeof REC_SEVERITIES)[number];

/**
 * The run id the panel's own GET returned, or null. Only a non-empty string
 * counts: `null` is the route's asserted "no current run", and anything else
 * (missing, malformed) is no evidence at all. The writes carry this value —
 * never the route's `current` alias — so a run that rolls over between the
 * read and the click can never take the write.
 */
export function readRunIdOf(data: { run_id?: unknown } | null | undefined): string | null {
  const runId = data?.run_id;
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

/** Per-row Dismiss: the panel's read named its run. */
export function recDismissVerdicts(readRunId: string | null | undefined): Verdicts {
  return { "rec-run-id-read": typeof readRunId === "string" && readRunId.length > 0 };
}

/**
 * The mute picker's recorded choice: the severity, plus the run id the
 * panel's read carried AT PICK TIME (the arm-time capture the page-local
 * control made at its "Mute <severity>…" click). The picker only records
 * this; the write fires through the registry control.
 */
export interface MuteChoice {
  severity: RecSeverity;
  runId: string | null;
}

/** Record a choice, pinning the run id read right now. An unknown severity
 * records nothing (null) — the closed enum is the route's vocabulary. */
export function chooseMute(severity: unknown, readRunId: string | null | undefined): MuteChoice | null {
  if (!(REC_SEVERITIES as readonly unknown[]).includes(severity)) return null;
  return {
    severity: severity as RecSeverity,
    runId: typeof readRunId === "string" && readRunId.length > 0 ? readRunId : null,
  };
}

/**
 * Mute severity: a severity is chosen (severity-chosen), and the run id the
 * write will carry — the choice's captured one — is real (rec-run-id-read).
 * With no choice yet, rec-run-id-read reflects the current read so the
 * checklist still says whether the panel knows its run.
 */
export function recMuteVerdicts(
  choice: MuteChoice | null | undefined,
  readRunId: string | null | undefined,
): Verdicts {
  const runId = choice ? choice.runId : readRunId;
  return {
    "rec-run-id-read": typeof runId === "string" && runId.length > 0,
    "severity-chosen": choice !== null && choice !== undefined && (REC_SEVERITIES as readonly string[]).includes(choice.severity),
  };
}

/** The context the IN_DASHBOARD_BODY builders read for a rec Dismiss —
 * `{run_id}` is built from `runId`. */
export function recDismissContext(readRunId: string | null | undefined): { runId: string | null } {
  return { runId: typeof readRunId === "string" && readRunId.length > 0 ? readRunId : null };
}

/** The context for Mute severity — the choice's captured run id and
 * severity; `{run_id, severity}` is built from it. */
export function recMuteContext(choice: MuteChoice | null | undefined): { runId: string | null; severity: RecSeverity | null } {
  return { runId: choice?.runId ?? null, severity: choice?.severity ?? null };
}
