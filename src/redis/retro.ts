/**
 * Retrospective seen-list + recurrence ledger Redis seam (issue #919, epic #917).
 *
 * The `/hydra-retro` skill synthesises a per-run retrospective and emits a
 * tiered, capped set of improvement proposals (≤2 GitHub issues for code-level
 * gotchas, ≤1 gated PR for high-confidence + recurrence-gated prompt/doc
 * fixes, artifact-only notes below the bar). Two pieces of cross-run state keep
 * that emit conservative:
 *
 *   1. **Seen-list** (`hydra:retro:seen`) — a dedup ledger keyed by a stable,
 *      kebab-case `cue`. A cue present here was already turned into an
 *      issue/PR on a prior run, so a later run SKIPS it rather than re-filing
 *      the same gotcha. This is the persisted half of the dedup contract; the
 *      other half is the live open + 7-day-closed GitHub issue scan the skill
 *      runs at emit time. Mirrors `src/redis/scout.ts`'s tool seen-list.
 *
 *   2. **Recurrence counter** (`hydra:retro:recurrence`) — a per-cue integer
 *      incremented once per run a cue is OBSERVED. The prompt-shaped-fix gate
 *      (the single gated PR) only fires for cues seen ≥3× across runs/friction
 *      observations, the recurrence threshold the epic mandates. Counting is
 *      independent of emission so a cue can clear the gate even on a run where
 *      it wasn't itself emitted.
 *
 * Both key families are GLOBAL (not per-run) and NOT TTLed — a retrospective
 * gotcha recurs across runs, so per-run scoping or expiry would defeat the
 * dedup + recurrence gates. The pure caps/dedup/recurrence-gate logic that
 * CONSUMES a snapshot of these ledgers lives in
 * `scripts/ci/hydra-retro-emit.ts`; this module is the typed Redis seam those
 * snapshots are read through and the emit decisions are written back through.
 *
 * Per CLAUDE.md / ADR-0009, all Redis access from outside `src/redis/` MUST go
 * through a typed accessor here — never raw `redis/keys` / `redis/kv`.
 */

import { redisKeys } from "./keys.ts";
import { hashGetAll, hashIncrBy, hashSetField } from "./kv.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The emit lane a retrospective finding was routed to. */
export type RetroEmitKind = "issue" | "pr" | "artifact";

/**
 * One seen-list entry — the persisted record that a cue was already emitted on
 * a prior run, so it is never re-proposed. Redis stores this JSON-encoded as
 * the hash value (field = cue).
 */
export interface RetroSeenEntry {
  /** Stable kebab-case cue (the dedup key; matches the friction-store grammar). */
  cue: string;
  /** Which lane the finding was routed to when it was emitted. */
  decision: RetroEmitKind;
  /** Autopilot run that produced the emit. */
  runId: string;
  /** GitHub issue/PR number (or other locator) the emit produced, when known. */
  ref: string | null;
  /** ISO-8601 UTC timestamp the entry was written. */
  at: string;
}

// ---------------------------------------------------------------------------
// Seen-list (dedup ledger)
// ---------------------------------------------------------------------------

/**
 * Read the full seen-list as a `cue -> RetroSeenEntry` map. Corrupt (non-JSON)
 * values are skipped with a logged warning rather than throwing, so one bad
 * write can't blind the whole dedup gate. Returns `{}` when the ledger is
 * empty.
 */
export async function getRetroSeen(): Promise<Record<string, RetroSeenEntry>> {
  const raw = await hashGetAll(redisKeys.retroSeen());
  const out: Record<string, RetroSeenEntry> = {};
  for (const [cue, value] of Object.entries(raw)) {
    try {
      out[cue] = JSON.parse(value) as RetroSeenEntry;
    } catch (err) {
      console.error(
        `[retro] skipping corrupt seen-list entry for cue "${cue}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

/**
 * Record that `cue` was emitted on this run, so future runs skip it. Idempotent
 * on the cue — re-recording overwrites the prior entry (last write wins, which
 * is the freshest emit locator). The caller supplies `at`; defaulting it here
 * would make the write non-deterministic for tests.
 */
export async function recordRetroSeen(entry: RetroSeenEntry): Promise<void> {
  await hashSetField(redisKeys.retroSeen(), entry.cue, JSON.stringify(entry));
}

/** True iff `cue` has already been emitted on a prior run. */
export async function isRetroSeen(cue: string): Promise<boolean> {
  const seen = await getRetroSeen();
  return Object.prototype.hasOwnProperty.call(seen, cue);
}

// ---------------------------------------------------------------------------
// Recurrence counter (gate input)
// ---------------------------------------------------------------------------

/**
 * Read the full recurrence ledger as a `cue -> count` map. Non-numeric values
 * coerce to 0 rather than NaN so the gate logic stays total. Returns `{}` when
 * empty.
 */
export async function getRetroRecurrence(): Promise<Record<string, number>> {
  const raw = await hashGetAll(redisKeys.retroRecurrence());
  const out: Record<string, number> = {};
  for (const [cue, value] of Object.entries(raw)) {
    const n = Number.parseInt(value, 10);
    out[cue] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

/**
 * Increment the recurrence count for `cue` by `delta` (default 1) and return
 * the new count. Called once per run a cue is observed — independent of whether
 * the cue is emitted — so the count reflects cross-run recurrence.
 */
export async function bumpRetroRecurrence(cue: string, delta = 1): Promise<number> {
  return hashIncrBy(redisKeys.retroRecurrence(), cue, delta);
}
