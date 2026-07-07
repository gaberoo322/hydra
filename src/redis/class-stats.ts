/**
 * Per-class yield-scoreboard Redis seam (issue #2943).
 *
 * The rolling class scoreboard (`src/autopilot/class-stats.ts`) is DERIVED from
 * the per-dispatch outcome records (#2942) + the spine estimate, but the
 * autopilot turn reads a single pre-computed snapshot rather than re-deriving it
 * every collect-state tick. This seam persists that snapshot at
 * `hydra:autopilot:class-stats:7d` (a single JSON blob, refreshed on a cadence)
 * and reads it back.
 *
 * Storage shape: one string key holding the JSON-serialised {@link ClassScoreboard}.
 * A short TTL (2h) makes the snapshot self-expire so a stalled refresher can
 * never serve a week-old board silently — a missing key reads back `null` and the
 * caller recomputes (the API view computes fresh on every request and only writes
 * the snapshot as a cache).
 *
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`) — no `new Redis()`, no `redis/kv` import
 * outside `src/redis/`. Every function is best-effort: a Redis error is logged
 * with the `[class-stats]` prefix and surfaces as a structured result / null,
 * never a thrown exception.
 */

import { getRedisConnection } from "./connection.ts";
import type { ClassScoreboard } from "../autopilot/class-stats.ts";

/** The single snapshot key. JSON {@link ClassScoreboard}. */
export function classStatsKey(): string {
  return "hydra:autopilot:class-stats:7d";
}

/**
 * Snapshot TTL: 2h. The scoreboard is a cache of a derivation, refreshed on a
 * cadence; expiring it means a wedged refresher serves `null` (recompute) rather
 * than a silently-stale board.
 */
export const CLASS_STATS_TTL_SECONDS = 2 * 3600;

export type PutClassScoreboardResult = { ok: true } | { ok: false; error: string };

/**
 * Persist the scoreboard snapshot (SET + TTL). Best-effort — returns a
 * structured result, never throws.
 */
export async function putClassScoreboard(
  scoreboard: ClassScoreboard,
): Promise<PutClassScoreboardResult> {
  try {
    const r = getRedisConnection();
    await r.set(
      classStatsKey(),
      JSON.stringify(scoreboard),
      "EX",
      CLASS_STATS_TTL_SECONDS,
    );
    return { ok: true };
  } catch (err: any) {
    const msg = `[class-stats] putClassScoreboard failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Read the persisted scoreboard snapshot, or `null` when the key is absent /
 * expired / malformed. Best-effort — never throws.
 */
export async function getClassScoreboard(): Promise<ClassScoreboard | null> {
  try {
    const r = getRedisConnection();
    const raw: string | null = await r.get(classStatsKey());
    if (!raw) return null;
    return JSON.parse(raw) as ClassScoreboard;
  } catch (err: any) {
    console.error(
      `[class-stats] getClassScoreboard failed: ${err?.message || String(err)}`,
    );
    return null;
  }
}
