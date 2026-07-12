/**
 * Reflection-outcomes ledger liveness projection (issue #3251).
 *
 * Pure projection of the RETIRED `hydra:learning:reflection:outcomes` ledger's
 * residual state (read by `redis/reflections.ts` `probeReflectionOutcomesLedger`)
 * into a deep-health verdict. Mirrors `metrics/reflection-health.ts`: the I/O
 * (the ZSET read) happens at fan-out time; THIS module is a pure function of the
 * probed state + a clock, so the deep-health rule that consumes it stays a pure
 * function of the Health Snapshot.
 *
 * Why this exists — the observability gap, not a bug:
 *   The reflection-outcomes ledger's WRITER died at 5b6683e (#1006) and its
 *   READER was swept in #1655 (PR #1686) as an ADR-0023 "producers cut, consumers
 *   kept" corpse. It is DELIBERATELY RETIRED. But a frozen tail lingers in Redis
 *   (no TTL), and its last-entry timestamp (2026-05-13) reads, to any
 *   architecture-review/discover pass that does NOT know the retirement history,
 *   as a live-but-broken producer — re-filing the phantom (issue #3251). This
 *   projection makes the retirement VISIBLE and SELF-DOCUMENTING on the health
 *   surface so the loop stops re-filing it, exactly the discoverability deepening
 *   #2492 (reflection-deposit health) and #2805 (dark outcomes) established.
 *
 * Verdicts (NONE is an alarm — this is an INFO-only signal, mirroring the
 * #2492/#2805 honest-none-never-phantom-alarm discipline):
 *   - `retired-empty`        — no ledger key in Redis (fully swept). Expected.
 *   - `retired-frozen-tail`  — a stale tail lingers (present, last write older
 *                              than the freshness window). Expected — this is the
 *                              exact state #3251 misread as "producer disconnected".
 *   - `unexpected-live-tail` — a tail whose newest entry is WITHIN the freshness
 *                              window. This should NOT happen (there is no writer);
 *                              a fresh entry means something is unexpectedly
 *                              writing the retired key — worth an operator's eye.
 */

import type { ReflectionOutcomesLedgerState } from "../redis/reflections.ts";

/**
 * Freshness window (ms) below which a present ledger's newest entry counts as an
 * UNEXPECTED live write rather than a frozen tail. Default 24h mirrors the
 * dark-outcome grace window (`DEFAULT_OUTCOME_MAX_STALE_MS`): an entry older than
 * this is the expected frozen corpse; a newer one is a surprise writer.
 */
export const REFLECTION_OUTCOMES_FRESH_MS = 24 * 60 * 60 * 1000;

export type ReflectionOutcomesLivenessVerdict =
  | "retired-empty"
  | "retired-frozen-tail"
  | "unexpected-live-tail";

export interface ReflectionOutcomesLivenessReport {
  verdict: ReflectionOutcomesLivenessVerdict;
  /** Members remaining in the retired ledger (0 when swept). */
  count: number;
  /** Newest entry's epoch-ms, or null when absent/empty/unscored. */
  latestEntryMs: number | null;
  /** Age of the newest entry in ms at projection time, or null when absent. */
  ageMs: number | null;
  /** Human-readable note explaining the verdict (surfaced by the rule). */
  note: string;
}

export interface ProjectReflectionOutcomesLivenessOpts {
  /** Clock (ms) for deterministic staleness in tests. Defaults to Date.now(). */
  now?: () => number;
  /** Freshness window (ms). Defaults to {@link REFLECTION_OUTCOMES_FRESH_MS}. */
  freshMs?: number;
}

/**
 * Pure projection of the probed ledger state into a liveness report. Never
 * throws — every input shape maps to a verdict.
 *
 * An absent/empty ledger → `retired-empty`. A present tail whose newest entry is
 * older than `freshMs` (or has no parseable score) → `retired-frozen-tail` (the
 * expected corpse #3251 misread). A present tail whose newest entry is WITHIN
 * `freshMs` → `unexpected-live-tail` (there is no writer, so a fresh entry is a
 * surprise). Only the last is ever surfaced as anything but plain-info.
 */
export function projectReflectionOutcomesLiveness(
  state: ReflectionOutcomesLedgerState,
  opts: ProjectReflectionOutcomesLivenessOpts = {},
): ReflectionOutcomesLivenessReport {
  const nowMs = (opts.now ?? Date.now)();
  const freshMs = opts.freshMs ?? REFLECTION_OUTCOMES_FRESH_MS;

  if (!state.present || state.count <= 0) {
    return {
      verdict: "retired-empty",
      count: 0,
      latestEntryMs: null,
      ageMs: null,
      note: "Retired reflection-outcomes ledger is empty/absent (writer removed #1006, reader swept #1655) — expected.",
    };
  }

  const latestEntryMs = state.latestEntryMs;
  const ageMs =
    latestEntryMs !== null && Number.isFinite(latestEntryMs) ? nowMs - latestEntryMs : null;

  // A parseable, fresh newest entry is the only surprising case: no writer
  // exists, so a within-window write means something is unexpectedly touching
  // the retired key. A missing/unparseable score degrades to frozen-tail (the
  // value is not evidence of a fresh write).
  if (ageMs !== null && ageMs >= 0 && ageMs < freshMs) {
    return {
      verdict: "unexpected-live-tail",
      count: state.count,
      latestEntryMs,
      ageMs,
      note: "Retired reflection-outcomes ledger has a fresh entry, but it has no writer (retired #1006/#1655) — something is unexpectedly writing the retired key.",
    };
  }

  return {
    verdict: "retired-frozen-tail",
    count: state.count,
    latestEntryMs,
    ageMs,
    note: "Retired reflection-outcomes ledger holds a stale frozen tail (no writer since #1006; reader swept #1655) — expected; NOT a disconnected producer.",
  };
}
