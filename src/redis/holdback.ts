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
// Tunables (ADR-0005 — named, not magic literals; env-overridable so #741 can
// layer a tier-aware window map on top without editing code).
// ---------------------------------------------------------------------------

/**
 * Default watch window length in autopilot cycles for the T2 floor (ADR-0004
 * step-4 default + `outcomes.yaml` schema comment). This is the **floor** of
 * the tier-aware window map (#741): deeper tiers watch at least as long. See
 * {@link windowCyclesForTier} for the carry-up.
 */
export const HOLDBACK_WINDOW_CYCLES = numFromEnv("HYDRA_HOLDBACK_WINDOW_CYCLES", 5);

/**
 * Tier-aware watch windows (#741, ADR-0015 monotonic ladder). Outcome Holdback
 * "carries up" the ladder: every tier deeper than T1 enrolls, and the deeper
 * the blast radius the longer the post-merge watch. The window is monotonic in
 * tier depth — `window(T4) >= window(T3) >= window(T2)` — with the existing
 * 5-cycle T2 value as the floor (clamped at read time, so a misconfigured env
 * override can never make a deeper tier watch for *less* time).
 *
 * Defaults: T2=5 (floor), T3=7, T4=10. All env-overridable (ADR-0005 — named,
 * not magic literals), documented in `config/direction/outcomes.yaml`.
 */
export const HOLDBACK_WINDOW_CYCLES_T3 = numFromEnv("HYDRA_HOLDBACK_WINDOW_CYCLES_T3", 7);
export const HOLDBACK_WINDOW_CYCLES_T4 = numFromEnv("HYDRA_HOLDBACK_WINDOW_CYCLES_T4", 10);

/**
 * The tiers that enroll in Outcome Holdback. T1 (prompt-shaped) is exempt — too
 * low signal-to-noise for a leading-outcome watch to attribute regressions
 * (ADR-0004 reasoning, preserved by ADR-0015). The carry-up applies to
 * **T2, T3, T4 only**.
 */
const HOLDBACK_ENROLLED_TIERS: ReadonlyArray<number> = [2, 3, 4];

/**
 * True when a merge of the given post-#767 monotonic tier enrolls in Outcome
 * Holdback. T1 → false; T2/T3/T4 → true; null/unknown → false (a merge whose
 * tier we cannot resolve is treated as "no signal" rather than over-watched —
 * matches the no-false-holdback posture elsewhere in this seam).
 */
export function isEnrolledTier(tier: number | null | undefined): boolean {
  return tier != null && HOLDBACK_ENROLLED_TIERS.includes(tier);
}

/**
 * The watch-window length (in autopilot cycles) for a merged diff's tier.
 *
 * Monotonic and floor-clamped: T2 is the floor (`HOLDBACK_WINDOW_CYCLES`), T3
 * is at least the T2 window, and T4 is at least the T3 window — even if an
 * operator's env override would otherwise invert the order. T1 and
 * null/unknown fall back to the T2 floor (they never actually enroll; this is
 * a safe default for any caller that asks anyway).
 */
export function windowCyclesForTier(tier: number | null | undefined): number {
  const t2 = HOLDBACK_WINDOW_CYCLES;
  if (tier === 3) return Math.max(HOLDBACK_WINDOW_CYCLES_T3, t2);
  if (tier === 4) {
    const t3 = Math.max(HOLDBACK_WINDOW_CYCLES_T3, t2);
    return Math.max(HOLDBACK_WINDOW_CYCLES_T4, t3);
  }
  // T2, T1, null/unknown → the floor.
  return t2;
}

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
export const HOLDBACK_BASELINE_TTL_SECONDS = numFromEnv(
  "HYDRA_HOLDBACK_BASELINE_TTL_SECONDS",
  14 * 24 * 60 * 60,
);

/** Per-day revert-counter TTL — 7 days of audit headroom past the UTC day. */
export const HOLDBACK_REVERT_COUNT_TTL_SECONDS = 7 * 24 * 60 * 60;

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One leading-outcome reading captured at enroll time. */
export interface HoldbackBaselineReading {
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
