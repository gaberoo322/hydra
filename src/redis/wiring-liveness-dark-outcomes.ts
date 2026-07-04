/**
 * Wiring-liveness DARK-OUTCOME persistence seam (issue #2805; epic #2286 /
 * Outcome-Attribution Spine #2628 follow-up to #2753).
 *
 * The #2753 dark-outcome check (`src/scheduler/chores/wiring-liveness-outcomes.ts`)
 * detects a declared `kind: leading` outcome whose current reading is `null`
 * (DARK — never produced) or present-but-old (STALE). It is stateless: it can say
 * "this outcome is dark RIGHT NOW", but not "this outcome has been continuously
 * dark for >=7 days". #2805 adds that durability: an alarm should fire (file a
 * `needs-triage` issue) ONLY after a sustained dark window, and the same issue
 * must NOT be re-filed on every hourly chore tick.
 *
 * This module is the typed accessor (ADR-0009 — Redis access from outside
 * `src/redis/` goes through a typed accessor here, never a raw `new Redis()` /
 * `redis/keys` / `redis/kv` import) for two per-outcome markers:
 *
 *   1. FIRST-SEEN-DARK timestamp (`hydra:wiring-liveness:dark-since:<name>`) —
 *      the epoch-ms at which an outcome was FIRST observed dark in the current
 *      dark streak. Set on the first tick an outcome reads dark; CLEARED the
 *      moment it reads live again (stateless recovery, mirroring the output
 *      below-floor check). The sustained-dark duration is `now - dark-since`.
 *
 *   2. FILED marker (`hydra:wiring-liveness:dark-filed:<name>`) — a per-outcome
 *      dedup marker (mirroring `hydra:holdback:enrolled-marker`) set once the
 *      needs-triage issue has been filed for the current dark streak, so the
 *      alarm is idempotent across hourly ticks. CLEARED on recovery alongside the
 *      first-seen timestamp, so a future dark streak files a fresh issue.
 *
 * Mechanics only — it stores and returns plain values (a timestamp, a boolean).
 * The 7-day threshold policy and the DARK/STALE verdict policy stay in the pure
 * chore layer; this accessor never re-implements them. Never throws past the
 * ioredis client's own error surface — callers fold Redis failures into the
 * chore's never-throw result.
 */

import { getRedisConnection } from "./connection.ts";

/**
 * Key for the FIRST-SEEN-DARK timestamp of one leading outcome. Keyed by the
 * outcome's declared `name` (unique per the outcomes schema), so two dark
 * outcomes track independent streaks. The value is an epoch-ms string.
 */
function darkSinceKey(outcomeName: string): string {
  return `hydra:wiring-liveness:dark-since:${outcomeName}`;
}

/**
 * Key for the FILED dedup marker of one leading outcome. Presence means "the
 * needs-triage issue for the CURRENT dark streak has already been filed" — the
 * idempotency guard that stops re-filing every tick. Value is unimportant (a
 * marker); presence is the signal.
 */
function filedMarkerKey(outcomeName: string): string {
  return `hydra:wiring-liveness:dark-filed:${outcomeName}`;
}

/**
 * Read the first-seen-dark epoch-ms for `outcomeName`, or `null` when no dark
 * streak is currently being tracked (the outcome is live, or has never been
 * dark). A non-numeric stored value coerces to `null` (defensive — the field is
 * only ever written as a number by {@link markDarkSince}).
 */
export async function getDarkSince(outcomeName: string): Promise<number | null> {
  const r = getRedisConnection();
  const raw = await r.get(darkSinceKey(outcomeName));
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Record `nowMs` as the first-seen-dark epoch-ms for `outcomeName`, but ONLY if
 * no streak is already being tracked (SET NX semantics). This makes the streak
 * anchor STABLE across ticks: the first dark tick sets it, every subsequent dark
 * tick is a no-op, so `now - dark-since` grows to reflect the true sustained-dark
 * duration. Returns the epoch-ms that is now in effect (the pre-existing anchor
 * if one was already set, else `nowMs`).
 */
export async function markDarkSince(outcomeName: string, nowMs: number): Promise<number> {
  const r = getRedisConnection();
  // SET key value NX → only sets if absent; returns "OK" when it set, null when
  // the key already existed. Either way the effective anchor is then read back.
  await r.set(darkSinceKey(outcomeName), String(nowMs), "NX");
  const effective = await getDarkSince(outcomeName);
  // effective is non-null here (we either just set it or it pre-existed); the
  // `?? nowMs` guards a pathological read-after-write race.
  return effective ?? nowMs;
}

/**
 * Clear BOTH the first-seen-dark timestamp and the filed dedup marker for
 * `outcomeName`. Called the moment the outcome reads live again — the stateless
 * recovery contract: a recovered outcome leaves no residue, so a future dark
 * streak starts a fresh anchor and files a fresh issue. Idempotent (deleting an
 * absent key is a no-op).
 */
export async function clearDarkStreak(outcomeName: string): Promise<void> {
  const r = getRedisConnection();
  await r.del(darkSinceKey(outcomeName), filedMarkerKey(outcomeName));
}

/**
 * Whether a needs-triage issue has already been filed for `outcomeName`'s CURRENT
 * dark streak. `true` means "already filed — do not re-file this tick".
 */
export async function isDarkOutcomeFiled(outcomeName: string): Promise<boolean> {
  const r = getRedisConnection();
  return (await r.exists(filedMarkerKey(outcomeName))) === 1;
}

/**
 * Set the filed dedup marker for `outcomeName`'s current dark streak. Called
 * exactly once per streak, right after the needs-triage issue is filed, so the
 * next hourly tick reads {@link isDarkOutcomeFiled} `true` and skips the file.
 * The marker clears on recovery via {@link clearDarkStreak}.
 */
export async function markDarkOutcomeFiled(outcomeName: string): Promise<void> {
  const r = getRedisConnection();
  await r.set(filedMarkerKey(outcomeName), "1");
}
