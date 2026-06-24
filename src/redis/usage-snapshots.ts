/**
 * Weekly Usage Snapshot Redis seam — typed accessor for the persisted per-ISO-week
 * per-skill token rollup (issue #2404).
 *
 * This is the FIRST stored state in the otherwise pure read-side **Cost**
 * projection (the Subscription Usage Tracker, `src/cost/usage-tracker.ts`, stays
 * Redis-free per ADR-0021 / CONTEXT.md). The single new WRITE the issue allows is
 * performed by the weekly Housekeeping chore (`src/scheduler/chores/usage-weekly-snapshot.ts`)
 * THROUGH this accessor — never `new Redis()`, never from the tracker, never from
 * the `/api/usage` route (the redis-seam rule).
 *
 * Key shape mirrors the existing daily-token convention in `src/redis/cost.ts`
 * (`hydra:metrics:tokens:*:daily:<DATE>`): a per-ISO-week JSON-encoded value at
 *   `hydra:metrics:usage-snapshot:weekly:<ISO-WEEK>`  (e.g. `2026-W26`)
 * with EXPIRE = 30 days (2_592_000s) set on every write, matching the daily keys'
 * 30-day TTL discipline. Old weeks self-expire — only the immediately-prior week
 * is read for the week-over-week trend, so a rolling ~4-week history is enough and
 * nothing accumulates unbounded.
 *
 * The persisted payload is the per-skill RAW token total (sum over model families
 * of the current rolling-7d `bySkillByModel` cross-tab at the moment the chore
 * runs) — RAW counts only, no quota-weight, no USD, matching the read-only posture
 * of the cross-tab it projects.
 */

import { getRedisConnection } from "./connection.ts";

/** TTL for a weekly snapshot — 30 days, mirroring the daily-token-key convention. */
export const WEEKLY_SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Redis key for a given ISO-week's usage snapshot. */
export function usageWeeklySnapshotKey(isoWeek: string): string {
  return `hydra:metrics:usage-snapshot:weekly:${isoWeek}`;
}

/**
 * The persisted weekly snapshot value.
 *
 * `bySkill` maps a dispatching-skill name to its RAW total tokens over the
 * rolling-7d window at the instant the snapshot was taken. `isoWeek` is the
 * ISO-week label the snapshot is keyed under (carried in the value too so a
 * reader never has to re-derive it from the key). `takenAt` is the ISO-8601
 * instant the chore sampled the tracker.
 */
export interface WeeklyUsageSnapshot {
  isoWeek: string;
  takenAt: string;
  bySkill: Record<string, number>;
}

/**
 * Derive the ISO-8601 week label (`<ISO-YEAR>-W<WW>`) for a given instant.
 *
 * ISO-8601 weeks start on Monday and week 1 is the week containing the first
 * Thursday of the year (equivalently, the week containing January 4th). The
 * ISO YEAR can differ from the calendar year for days near the year boundary
 * (e.g. 2027-01-01 may fall in `2026-W53`), which is exactly why the year is
 * derived from the Thursday of the target week, not from the input date.
 *
 * Pure: no Redis, no `Date.now()` — the instant is the argument. UTC-based so
 * the label is stable regardless of the host timezone.
 */
export function isoWeekLabel(at: Date): string {
  // Work in UTC. Copy so we never mutate the caller's Date.
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // ISO weekday: Mon=1 .. Sun=7 (getUTCDay is Sun=0 .. Sat=6).
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Shift to the Thursday of this week — its calendar year is the ISO year.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  // Week number = ceil of the day-of-year of that Thursday / 7.
  const yearStart = Date.UTC(isoYear, 0, 1);
  const dayOfYear = Math.floor((d.getTime() - yearStart) / (24 * 60 * 60 * 1000)) + 1;
  const week = Math.ceil(dayOfYear / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Persist the per-skill weekly snapshot for `isoWeek`, stamping the 30-day TTL.
 *
 * Idempotent on the ISO-week key: a same-week re-run simply overwrites the
 * value (the weekly chore guard means it normally fires at most once per week,
 * but an overwrite is harmless). Best-effort by the seam convention — callers
 * (the chore) decide how to report a Redis outage; this never throws beyond
 * what ioredis itself surfaces.
 */
export async function writeWeeklyUsageSnapshot(snapshot: WeeklyUsageSnapshot): Promise<void> {
  const r = getRedisConnection();
  const key = usageWeeklySnapshotKey(snapshot.isoWeek);
  await r.set(key, JSON.stringify(snapshot), "EX", WEEKLY_SNAPSHOT_TTL_SECONDS);
}

/**
 * Read the weekly snapshot for `isoWeek`, or `null` when none is stored (the
 * key is absent or its value fails to parse — a corrupt value degrades to a
 * clean miss rather than throwing, so a single bad write can't wedge the WoW
 * derivation, which treats a miss as "no prior week").
 */
export async function readWeeklyUsageSnapshot(isoWeek: string): Promise<WeeklyUsageSnapshot | null> {
  const r = getRedisConnection();
  const raw = await r.get(usageWeeklySnapshotKey(isoWeek));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as WeeklyUsageSnapshot;
    if (parsed && typeof parsed === "object" && parsed.bySkill && typeof parsed.bySkill === "object") {
      return parsed;
    }
    return null;
  } catch (err: any) {
    // Fail loud (repo convention) but degrade to a clean miss — a corrupt
    // stored value must not throw out of the read-side projection path.
    console.error(
      `[usage-snapshots] failed to parse weekly snapshot for ${isoWeek}: ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Read the snapshot for the ISO-week immediately PRIOR to `at` (i.e. `at - 7d`).
 * This is the single read the week-over-week trend needs — `getUsage()` calls
 * it BEFORE the pure `assembleSnapshot()` and injects the result, preserving the
 * tracker's no-IO contract. Returns `null` when no prior snapshot exists (the
 * first-ever week, or after the 30-day TTL aged it out).
 */
export async function readPriorWeekUsageSnapshot(at: Date): Promise<WeeklyUsageSnapshot | null> {
  const priorWeek = isoWeekLabel(new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000));
  return readWeeklyUsageSnapshot(priorWeek);
}
