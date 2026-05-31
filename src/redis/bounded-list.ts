/**
 * bounded-list.ts — a shared bounded-JSON-list deep primitive (ADR-0017
 * Category C).
 *
 * Several modules keep a small rolling history under a single Redis list key
 * with the identical mechanics: push newest-first, trim to a max length, read
 * newest-first, and tolerate (skip) corrupt entries on read. Each had inlined
 * `lpush` + `ltrim` + `lrange` + a hand-rolled tolerant `JSON.parse`. ADR-0017
 * extracts that mechanism here so the Category-C reimplementations adopt one
 * primitive instead of reaching the raw connection individually.
 *
 * This file lives inside the `src/redis/*` family, so it is a sanctioned owner
 * of the raw connection — it imports `connection.ts` directly. It must NOT
 * pull in `keys.ts` / `kv.ts` in a family-rule-violating way; the key is
 * supplied by the caller (the caller owns its key namespace).
 *
 * Mechanics only — NO domain validation. `read()` returns every entry that
 * parses as JSON (skipping only JSON-corrupt strings). Domain validity
 * filtering (e.g. "does this entry have the fields I expect?") stays at the
 * call site, where the entry type is known.
 */

import { getRedisConnection } from "./connection.ts";

/**
 * A bounded, newest-first JSON list backed by a single Redis list key.
 *
 * @param key - The Redis list key (caller owns the namespace).
 * @param max - Hard cap on stored entries. `push` trims to this length.
 */
export function boundedJsonList<T = unknown>(key: string, max: number) {
  return {
    /**
     * Push an entry to the front (newest-first) and trim to `max` entries.
     * `lpush` + `ltrim(0, max - 1)` — the same two-command sequence the
     * inline reimplementations used.
     */
    async push(entry: T): Promise<void> {
      const r = getRedisConnection();
      await r.lpush(key, JSON.stringify(entry));
      await r.ltrim(key, 0, max - 1);
    },

    /**
     * Read up to `limit` entries, newest-first. Entries that fail to parse as
     * JSON are skipped (tolerant read) — corruption never throws. Domain
     * validity filtering is the caller's responsibility.
     *
     * @param limit - Max entries to read. Defaults to `max`. Clamped to >= 1.
     */
    async read(limit: number = max): Promise<T[]> {
      const r = getRedisConnection();
      const raw: string[] = await r.lrange(key, 0, Math.max(limit, 1) - 1);
      const out: T[] = [];
      for (const s of raw) {
        try {
          out.push(JSON.parse(s) as T);
        } catch {
          /* intentional: skip unparseable entries (tolerant read) */
        }
      }
      return out;
    },

    /** Delete the entire list. */
    async clear(): Promise<void> {
      const r = getRedisConnection();
      await r.del(key);
    },
  };
}
