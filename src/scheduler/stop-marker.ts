/**
 * Deliberate-stop marker leaf (extracted from `heartbeat.ts`, issue #3500).
 *
 * Owns the **deliberate-stop marker contract** — the single place that answers
 * "what does each `stopReason` mean, what Redis TTL enforces the marker, and
 * what is its on-the-wire payload shape?". Extracted from the 675-line
 * `HeartbeatController` so this named domain concept (issue #388) is answerable
 * in one leaf with no timer lifecycle, no counter rehydration, and no
 * rolling-rate deps in scope. Mirrors the `rolling-rates.ts` /
 * `status-projection.ts` / `tick-stagnation-alert.ts` extraction precedent
 * (#2974 / #3371): the leaf owns the *contract* (the "how" — serialize/parse +
 * the TTL + the typed Redis wrappers); the controller keeps the *decision* (the
 * "when" — which reasons persist a marker) and the in-memory discriminant
 * fields (`stopReason` / `deliberateStoppedAt` stay on `HeartbeatState` because
 * `getStatus()` projects them off the state snapshot).
 *
 * The leaf becomes the single importer of the deliberate-stop Redis accessors
 * from `src/redis/scheduler.ts`; `heartbeat.ts` stops importing them for this
 * concern and instead imports this leaf's pure/typed surface.
 */

import { logger } from "../logger.ts";
import {
  getSchedulerDeliberateStop,
  setSchedulerDeliberateStop,
  clearSchedulerDeliberateStop,
} from "../redis/scheduler.ts";

/**
 * The reason a stop occurred — the discriminant the watchdog reads to decide
 * whether to auto-restart (issue #388).
 *
 *   - "deliberate"      — POST /scheduler/stop (operator intent). A 24h Redis
 *                         marker is written; the watchdog must NOT auto-restart.
 *   - "circuit-breaker" — auto-pause (consecutive-no-op-merge halt). NO marker
 *                         written; the watchdog SHOULD restart once work queues.
 *   - "error-cap"       — auto-pause (consecutive errors). NO marker written;
 *                         the watchdog SHOULD restart. Same recovery contract as
 *                         circuit-breaker.
 *   - null              — never stopped, or the last action was `start()`.
 *
 * (`"shutdown"` is a stop *input* reason handled by the controller — SIGTERM /
 * SIGINT process exit — but it is never a persisted marker value, so it is not
 * part of this discriminant type.)
 */
export type StopReason = "deliberate" | "circuit-breaker" | "error-cap" | null;

/**
 * The on-the-wire shape of the deliberate-stop marker persisted to Redis
 * (`hydra:scheduler:deliberate-stop`). JSON-serialized on write, parsed +
 * validated on rehydrate.
 */
export interface DeliberateStopMarker {
  reason: string;
  stoppedAt: string;
}

/**
 * TTL for the deliberate-stop Redis marker (issue #388). 24h is the
 * operator-friendly maximum — if the operator forgets to restart the scheduler
 * within a day, the marker self-clears so the watchdog regains the ability to
 * recover from genuine self-stops.
 */
export const DELIBERATE_STOP_TTL_SECONDS = 24 * 60 * 60;

/**
 * Serialize a deliberate-stop marker for the Redis write. Pure — the single
 * definition of the marker's on-the-wire shape (folds the inline `JSON.stringify`
 * that used to live in `HeartbeatController.stop()`).
 */
export function serializeDeliberateStopMarker(reason: string, stoppedAt: string): string {
  const marker: DeliberateStopMarker = { reason, stoppedAt };
  return JSON.stringify(marker);
}

/**
 * Parse a raw Redis marker string into its `{ reason, stoppedAt }` fields, or
 * `null` when the marker is absent, malformed JSON, or missing/mistyped fields.
 * Pure — folds the inline `try { JSON.parse(...) }` + `typeof` guard block that
 * used to live in `HeartbeatController.loadSchedulerState()`.
 *
 * Never throws: a malformed marker is treated as "no marker" (returns null)
 * rather than crashing rehydration, matching the fail-safe rehydrate contract.
 */
export function parseDeliberateStopMarker(raw: string | null): DeliberateStopMarker | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.reason === "string" &&
      typeof parsed.stoppedAt === "string"
    ) {
      return { reason: parsed.reason, stoppedAt: parsed.stoppedAt };
    }
    return null;
  } catch (err: any) {
    logger.error({ err }, "failed to parse deliberate-stop marker");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Typed Redis wrappers — the leaf is now the single importer of the raw
// deliberate-stop accessors from `src/redis/scheduler.ts`. `heartbeat.ts`
// imports these as the production defaults for its (unchanged) flat dep fields
// `getSchedulerDeliberateStop` / `setSchedulerDeliberateStop` /
// `clearSchedulerDeliberateStop`. The adapter seam itself is out of scope and
// unmodified (issue #3500 Files-out-of-scope).
// ---------------------------------------------------------------------------

/** Read the raw deliberate-stop marker string, or null when absent / expired. */
export function readDeliberateStop(): Promise<string | null> {
  return getSchedulerDeliberateStop();
}

/** Persist a deliberate-stop marker string with the given TTL (seconds). */
export function writeDeliberateStop(payload: string, ttlSeconds: number): Promise<void> {
  return setSchedulerDeliberateStop(payload, ttlSeconds);
}

/** Clear the deliberate-stop marker. */
export function clearDeliberateStop(): Promise<void> {
  return clearSchedulerDeliberateStop();
}
