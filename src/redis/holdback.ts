/**
 * Outcome-Holdback Redis seam (issue #786, ADR-0004 step 4).
 *
 * The **Post-merge Regression Check** (the Outcome Holdback *producer*) needs
 * two pieces of durable runtime state, both of which live here behind the
 * ADR-0009 typed accessor so the producer never touches `new Redis()` or a raw
 * `redis/kv` import (Redis-seam rule; `scripts/ci/redis-seam-check.ts`):
 *
 *   1. A **per-merge baseline snapshot** of the leading Target Outcomes,
 *      captured at enroll time (right after a merge) and read back on every
 *      poll-loop check until the watch window elapses. Keyed by the merged
 *      commit SHA, with a TTL that comfortably outlives the watch window so a
 *      stalled poll loop can never resurrect an ancient baseline.
 *
 *   2. A **per-UTC-day revert counter** enforcing the ADR-0004 step-4 global
 *      cap. Once the cap is hit the producer emits `holdback.cap-reached` and
 *      SUPPRESSES further reverts for the day rather than reverting — bounding
 *      blast radius if many merges regress on the same day.
 *
 * This is NOT a resurrected in-process watcher. There is no timer, no sampler,
 * no long-lived loop here — only request-scoped read/write helpers invoked by
 * the hydra-qa post-merge path (dispatched by the autopilot poll loop). The
 * orphaned-recorder failure mode that retired the stuckness detector (ADR-0010)
 * and the deleted `src/holdback.ts` in-process watcher (removed in the ADR-0006
 * cut-over) is precisely what this seam avoids.
 *
 * Per CLAUDE.md conventions: every function here is best-effort with respect to
 * the caller's flow — a Redis error is logged with the `[holdback]` prefix and
 * surfaces as a structured result, never a thrown exception that could break a
 * merge (Outcome Holdback is read-only with respect to merge).
 */

import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Tunables (ADR-0005 — named, not magic literals; env-overridable).
//
// The tier-enrollment POLICY (which tiers enroll, and each tier's watch-window
// length) was extracted to `src/holdback-policy.ts` (issue #2671) — those are
// pure predicates with no Redis I/O and did not belong in this Redis Adapter.
// This file keeps only storage-side tunables: the per-day revert cap, TTLs.
// ---------------------------------------------------------------------------

/**
 * Global per-UTC-day auto-revert cap (ADR-0004 step-4). Beyond this the
 * producer emits `holdback.cap-reached` and suppresses further reverts for the
 * day; additional regressions are surfaced in the digest, not acted on.
 */
export const HOLDBACK_MAX_REVERTS_PER_DAY = numFromEnv("HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY", 3);

/**
 * Baseline-record TTL in seconds. Must outlive the longest plausible watch
 * window (cycles × real time per cycle) with generous headroom so a stalled
 * poll loop can't act on a stale baseline, yet bounded so Redis stays tidy.
 * 14 days mirrors the historical in-process record TTL (docs/reference.md).
 */
const HOLDBACK_BASELINE_TTL_SECONDS = numFromEnv(
  "HYDRA_HOLDBACK_BASELINE_TTL_SECONDS",
  14 * 24 * 60 * 60,
);

/** Per-day revert-counter TTL — 7 days of audit headroom past the UTC day. */
const HOLDBACK_REVERT_COUNT_TTL_SECONDS = 7 * 24 * 60 * 60;

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Key builders (ADR-0009 — key shape lives in the seam).
// ---------------------------------------------------------------------------

/** Per-commit baseline record. JSON `HoldbackBaseline`. TTL-stamped. */
export function holdbackBaselineKey(commitSha: string): string {
  return `hydra:holdback:baseline:${commitSha}`;
}

/** Per-UTC-day revert counter. INT string. */
function holdbackRevertCountKey(date: string): string {
  return `hydra:holdback:reverts:${date}`;
}

/**
 * Pending-enroll registry (issue #2622). A single Redis HASH, one field per
 * `prNumber` (field = `String(prNumber)`), value = JSON `PendingEnrollEntry`.
 *
 * This is the durable record of PRs the autopilot has ARMED for auto-merge but
 * that have not yet landed+enrolled. It is deliberately a DIFFERENT key from
 * {@link holdbackBaselineKey}: a pending entry exists BEFORE landing and is
 * keyed by prNumber (no commit SHA yet); a baseline exists AFTER landing and is
 * keyed by commit SHA. Conflating "armed" with "watched" would break the
 * #2623 merge-completion watcher's semantics.
 *
 * A HASH (not a LIST) so upsert-by-prNumber is idempotent for free: `HSET` on
 * the same field overwrites in place, `HGETALL` lists all in one call, `HDEL`
 * removes one. Mirrors the `src/redis/autopilot-runs.ts` hash pattern.
 */
function holdbackPendingEnrollKey(): string {
  return "hydra:holdback:pending-enroll";
}

/**
 * Per-PR "already processed on landing" marker (issue #2623). One field per
 * `prNumber` in a single HASH, value = the landing commit SHA (informational).
 * Set the first time the merge-completion watcher sees a pending PR's merge land
 * and fires the enroll + cycle-record enrichment; consulted on every subsequent
 * tick so those two merge-coupled writes fire **at most once per PR** even if the
 * pending entry's `HDEL` failed and the entry is re-observed. Distinct from the
 * per-commit baseline (`enrollHoldback` is itself idempotent on the SHA) — this
 * marker also guards the cycle-record enrichment, which is idempotent on cycleId
 * but which we still only want to fire once from this path.
 */
function holdbackEnrolledMarkerKey(): string {
  return "hydra:holdback:enrolled-marker";
}

/**
 * Merge-completion watcher health (issue #2623). A single JSON blob — the chore
 * is the sole writer, the scheduler-status surface the sole reader — recording
 * the last run's pending-depth + wall-clock stamp so the mechanism is observable
 * rather than silent (mirrors the reconciler-health pattern, #2057).
 */
function holdbackMergeWatchHealthKey(): string {
  return "hydra:holdback:merge-watch:health";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One leading-outcome reading captured at enroll time. */
interface HoldbackBaselineReading {
  name: string;
  /** Favorable direction for `value` — used to detect *unfavorable* moves. */
  direction: "up" | "down";
  /** Absolute change below this is treated as no-move. */
  noiseEpsilon: number;
  /** Snapshot value, or null if the adapter returned no data at enroll time. */
  value: number | null;
}

/** The per-merge baseline persisted at enroll time. */
export interface HoldbackBaseline {
  commitSha: string;
  /** PR number that merged, if known (informational; revert keys off SHA). */
  prNumber: number | null;
  /** Tier the merged diff classified as (post-#767 monotonic T1–T4). */
  tier: number | null;
  /** Epoch ms the baseline was captured. */
  enrolledAt: number;
  /** Watch window length in cycles for this enrollment. */
  windowCycles: number;
  /** Snapshot of the leading outcomes at merge time. */
  leading: HoldbackBaselineReading[];
}

export type RecordBaselineResult =
  | { ok: true }
  | { ok: false; error: string };

export type LoadBaselineResult =
  | { ok: true; baseline: HoldbackBaseline | null }
  | { ok: false; error: string };

/**
 * One entry in the pending-enroll registry (issue #2622): a PR the autopilot has
 * armed for auto-merge but that has not yet landed+enrolled. Keyed (in the hash)
 * by `prNumber`. `tier` is nullable to mirror the enroll schema's tier semantics
 * (a merge whose tier we cannot yet resolve is still recordable as "armed").
 */
export interface PendingEnrollEntry {
  prNumber: number;
  tier: number | null;
  cycleId: string;
  /** Epoch ms the entry was registered. */
  registeredAt: number;
}

export type PendingEnrollAddResult =
  | { ok: true }
  | { ok: false; error: string };

export type PendingEnrollListResult =
  | { ok: true; entries: PendingEnrollEntry[] }
  | { ok: false; error: string };

/**
 * Last-run health snapshot for the merge-completion watcher chore (issue #2623).
 * Single JSON blob behind the seam (ADR-0017); the chore is the sole writer.
 */
export interface MergeWatchHealthRecord {
  /** ISO timestamp of the run that wrote this record. */
  ranAt: string;
  /** How many pending-enroll entries were in the registry at run start. */
  pendingDepth: number;
  /** How many landed PRs were enrolled+enriched this run. */
  landed: number;
  /** How many landed T1/unknown-tier PRs were dropped without enrolling. */
  droppedExempt: number;
  /** How many entries were left untouched (PR still open / no merge commit). */
  stillOpen: number;
}

// ---------------------------------------------------------------------------
// Baseline accessors
// ---------------------------------------------------------------------------

/**
 * Persist the pre-merge baseline for `commitSha`. Idempotent: re-enrolling the
 * same SHA overwrites and re-stamps the TTL (a re-run of the post-merge check
 * for the same merge is harmless). Best-effort — returns a structured result.
 */
export async function recordBaseline(baseline: HoldbackBaseline): Promise<RecordBaselineResult> {
  if (!baseline.commitSha) {
    return { ok: false, error: "recordBaseline: commitSha is required" };
  }
  try {
    const r = getRedisConnection();
    await r.set(
      holdbackBaselineKey(baseline.commitSha),
      JSON.stringify(baseline),
      "EX",
      HOLDBACK_BASELINE_TTL_SECONDS,
    );
    return { ok: true };
  } catch (err: any) {
    const msg = `[holdback] recordBaseline failed for ${baseline.commitSha}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Read the baseline for `commitSha`. Returns `{ ok: true, baseline: null }`
 * when no enrollment exists (expired or never recorded) — the caller treats
 * that as "nothing to watch", never as an error.
 */
export async function loadBaseline(commitSha: string): Promise<LoadBaselineResult> {
  try {
    const r = getRedisConnection();
    const raw = await r.get(holdbackBaselineKey(commitSha));
    if (raw == null) return { ok: true, baseline: null };
    const parsed = JSON.parse(raw) as HoldbackBaseline;
    return { ok: true, baseline: parsed };
  } catch (err: any) {
    const msg = `[holdback] loadBaseline failed for ${commitSha}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/** Remove a baseline once its window has resolved (passed or reverted). */
export async function clearBaseline(commitSha: string): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.del(holdbackBaselineKey(commitSha));
  } catch (err: any) {
    /* intentional: clearing a resolved baseline is best-effort cleanup; the
       TTL guarantees eventual removal even if this DEL fails. */
    console.error(`[holdback] clearBaseline failed for ${commitSha}: ${err?.message || String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Per-day revert-cap accessors
// ---------------------------------------------------------------------------

/** UTC YYYY-MM-DD for a Date. Exported for tests + the producer. */
export function utcDateKey(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Current revert count for `date` (UTC). Missing reads as 0. */
export async function getRevertCount(date: string = utcDateKey()): Promise<number> {
  try {
    const r = getRedisConnection();
    const raw = await r.get(holdbackRevertCountKey(date));
    return typeof raw === "string" ? Number(raw) || 0 : 0;
  } catch (err: any) {
    console.error(`[holdback] getRevertCount failed for ${date}: ${err?.message || String(err)}`);
    // Fail closed: report the cap as already reached so a Redis blip can never
    // license an unbounded revert run. "No false revert" > "no missed revert".
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Increment the revert counter for `date` and stamp its TTL. Returns the new
 * total. Best-effort — on Redis error returns MAX_SAFE_INTEGER so the caller's
 * cap check fails closed (treats the cap as reached).
 */
export async function incrRevertCount(date: string = utcDateKey()): Promise<number> {
  try {
    const r = getRedisConnection();
    const key = holdbackRevertCountKey(date);
    const total = await r.incr(key);
    await r.expire(key, HOLDBACK_REVERT_COUNT_TTL_SECONDS);
    return total;
  } catch (err: any) {
    console.error(`[holdback] incrRevertCount failed for ${date}: ${err?.message || String(err)}`);
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Test-only: clear a day's revert counter. */
export async function _resetRevertCount(date: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(holdbackRevertCountKey(date));
}

// ---------------------------------------------------------------------------
// Pending-enroll registry accessors (issue #2622)
// ---------------------------------------------------------------------------

/**
 * Register (or upsert) a PR the autopilot has armed for auto-merge. Idempotent
 * on `prNumber`: a second call for the same prNumber overwrites the field in
 * place (single entry, updated), never appends a duplicate. Best-effort — a
 * Redis error is logged with the `[holdback]` prefix and returned as a
 * structured result, never thrown (this path only records intent; it never
 * arms, blocks, or performs a merge).
 */
export async function pendingEnrollAdd(entry: PendingEnrollEntry): Promise<PendingEnrollAddResult> {
  if (!Number.isInteger(entry.prNumber) || entry.prNumber <= 0) {
    return { ok: false, error: "pendingEnrollAdd: prNumber must be a positive integer" };
  }
  try {
    const r = getRedisConnection();
    await r.hset(holdbackPendingEnrollKey(), String(entry.prNumber), JSON.stringify(entry));
    return { ok: true };
  } catch (err: any) {
    const msg = `[holdback] pendingEnrollAdd failed for pr ${entry.prNumber}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * List every armed-but-not-landed pending entry. Returns them sorted by
 * `prNumber` ascending for a stable read. A malformed hash field is skipped
 * (logged) rather than failing the whole list — one bad entry can never blind
 * the caller to the rest.
 */
export async function pendingEnrollList(): Promise<PendingEnrollListResult> {
  try {
    const r = getRedisConnection();
    const hash = await r.hgetall(holdbackPendingEnrollKey());
    const entries: PendingEnrollEntry[] = [];
    for (const [field, raw] of Object.entries(hash) as Array<[string, string]>) {
      try {
        entries.push(JSON.parse(raw) as PendingEnrollEntry);
      } catch (err: any) {
        console.error(
          `[holdback] pendingEnrollList: skipping malformed field ${field}: ${err?.message || String(err)}`,
        );
      }
    }
    entries.sort((a, b) => a.prNumber - b.prNumber);
    return { ok: true, entries };
  } catch (err: any) {
    const msg = `[holdback] pendingEnrollList failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Remove a pending entry once its PR has landed (or been abandoned). Best-effort
 * cleanup consumed by the #2623 merge-completion watcher — harmless if the field
 * is already gone.
 */
export async function pendingEnrollRemove(prNumber: number): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.hdel(holdbackPendingEnrollKey(), String(prNumber));
  } catch (err: any) {
    /* intentional: removing a landed pending entry is best-effort cleanup; a
       stale field is harmless and the #2623 watcher re-reconciles on its next
       pass. */
    console.error(`[holdback] pendingEnrollRemove failed for pr ${prNumber}: ${err?.message || String(err)}`);
  }
}

/** Test-only: clear the entire pending-enroll registry. */
export async function _resetPendingEnroll(): Promise<void> {
  const r = getRedisConnection();
  await r.del(holdbackPendingEnrollKey());
}

// ---------------------------------------------------------------------------
// Merge-completion watcher: per-PR enrolled marker (issue #2623)
// ---------------------------------------------------------------------------

/**
 * True when this PR's landing has ALREADY been processed (enroll + cycle-record
 * enrichment fired) by the merge-completion watcher. Consulted before firing the
 * merge-coupled writes so they happen at most once per PR — even if a prior
 * tick's `pendingEnrollRemove` failed and the entry is re-observed. On a Redis
 * error returns `true` (fail closed: never double-enroll on a blip; the pending
 * entry is left in place so a healthy later tick can re-check and drop it).
 */
export async function wasEnrolledMarked(prNumber: number): Promise<boolean> {
  try {
    const r = getRedisConnection();
    const v = await r.hget(holdbackEnrolledMarkerKey(), String(prNumber));
    return v != null;
  } catch (err: any) {
    console.error(
      `[holdback] wasEnrolledMarked failed for pr ${prNumber}: ${err?.message || String(err)}`,
    );
    return true;
  }
}

/**
 * Record that this PR's landing has been processed (enroll + enrichment fired),
 * so a re-observed entry never re-fires them. Value is the landing commit SHA
 * (informational). Best-effort — a write failure is logged and returned as a
 * structured result, never thrown; the caller only removes the pending entry
 * once the mark succeeded, so a failed mark leaves the entry to retry next tick.
 */
export async function markEnrolled(
  prNumber: number,
  commitSha: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = getRedisConnection();
    await r.hset(holdbackEnrolledMarkerKey(), String(prNumber), commitSha);
    return { ok: true };
  } catch (err: any) {
    const msg = `[holdback] markEnrolled failed for pr ${prNumber}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/** Test-only: clear the entire enrolled-marker hash. */
export async function _resetEnrolledMarker(): Promise<void> {
  const r = getRedisConnection();
  await r.del(holdbackEnrolledMarkerKey());
}

// ---------------------------------------------------------------------------
// Merge-completion watcher: observability health (issue #2623)
// ---------------------------------------------------------------------------

/** TTL on the health record — 2 days, longer than the hourly run cadence so a
 * present record is always the genuine last run, but short enough that a
 * long-stopped scheduler's record ages out (mirrors reconciler-health, #2057). */
const MERGE_WATCH_HEALTH_TTL_SEC = 2 * 24 * 60 * 60;

/**
 * Persist the merge-completion watcher's last-run health snapshot (best-effort;
 * the chore already logs, so a write failure here must never abort it).
 */
export async function setMergeWatchHealth(record: MergeWatchHealthRecord): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.set(
      holdbackMergeWatchHealthKey(),
      JSON.stringify(record),
      "EX",
      MERGE_WATCH_HEALTH_TTL_SEC,
    );
  } catch (err: any) {
    /* intentional: health persistence is observability, not correctness — a
       write failure is logged and swallowed so the watcher's own work stands. */
    console.error(`[holdback] setMergeWatchHealth failed: ${err?.message || String(err)}`);
  }
}

/** Read the merge-completion watcher's last-run health snapshot, or `null` if
 * none/expired or the stored value is unparseable. */
export async function getMergeWatchHealth(): Promise<MergeWatchHealthRecord | null> {
  try {
    const r = getRedisConnection();
    const raw = await r.get(holdbackMergeWatchHealthKey());
    if (!raw) return null;
    return JSON.parse(raw) as MergeWatchHealthRecord;
  } catch (err: any) {
    console.error(`[holdback] getMergeWatchHealth: unreadable health record: ${err?.message || String(err)}`);
    return null;
  }
}
