/**
 * source-index.ts — durable content-hash dedup map for the OpenViking
 * source-indexer (issue #1123).
 *
 * The source-indexer (`src/knowledge-base/source-indexer.ts`) hashes every
 * source/docs/test file it uploads to OpenViking and tracks `path -> sha1` so
 * it can skip re-embedding unchanged content. Before #1123 that map lived ONLY
 * in an in-memory `Map` that reset on every process restart. The orchestrator
 * bounces dozens of times a day (pace-gate/autopilot relaunch churn), so each
 * restart re-uploaded the whole modified-window tree — ~13k "Indexed text:"
 * lines/day, all re-vectorizing content OV already had, burning local Ollama
 * embedding cycles for zero new information.
 *
 * This seam persists the map to a single Redis hash (`hydra:knowledge:
 * source-hashes`, field=absolute path, value=sha1 hex) through the ADR-0009
 * typed accessor so the indexer never touches `new Redis()` or a raw
 * `redis/kv` import (Redis-seam rule; `scripts/ci/redis-seam-check.ts`). The
 * in-memory `Map` stays as a hot read cache — these accessors only hydrate it
 * on startup and write through on each successful index, so the per-file hot
 * path never adds a Redis round-trip on a cache hit.
 *
 * Per CLAUDE.md conventions every function here is best-effort with respect to
 * the indexer's flow — a Redis error is logged with the `[source-index]` prefix
 * and surfaces as a graceful no-op (empty map / failed-but-non-fatal write),
 * never a thrown exception. The indexer degrades EXACTLY as the pre-#1123
 * in-memory-only path did on a miss: it re-uploads. A persistence outage costs
 * redundant embeddings, never a crash.
 */

import { getRedisConnection } from "./connection.ts";

/**
 * Single hash holding the whole `path -> sha1` dedup map. Not TTLed — a stale
 * entry for a since-deleted file is harmless (it is simply never read again),
 * and the map must outlive arbitrarily long restart gaps to do its job. The
 * field count is bounded by the indexed file count (low thousands), so the
 * hash stays small.
 */
function sourceHashesKey(): string {
  return "hydra:knowledge:source-hashes";
}

/**
 * Load the full persisted `path -> sha1` map. Returns an empty Map on a miss
 * (never-persisted) OR on any Redis error — the caller (the indexer) treats an
 * empty map exactly as the pre-#1123 fresh in-memory cache: every file looks
 * un-indexed and gets re-uploaded. Best-effort: a load failure degrades to the
 * old wasteful-but-correct behavior, never a crash.
 */
export async function loadSourceHashes(): Promise<Map<string, string>> {
  try {
    const r = getRedisConnection();
    const raw: Record<string, string> = await r.hgetall(sourceHashesKey());
    const out = new Map<string, string>();
    if (raw) {
      for (const [path, hash] of Object.entries(raw)) {
        if (path && hash) out.set(path, hash);
      }
    }
    return out;
  } catch (err: any) {
    console.error(
      `[source-index] loadSourceHashes failed: ${err?.message || String(err)}`,
    );
    return new Map();
  }
}

/**
 * Write through a single `path -> sha1` entry after a successful index. The
 * in-memory cache is the source of truth for the hot-path read; this only keeps
 * the durable copy in sync so the NEXT process restart can skip the file.
 * Best-effort — a write failure is logged and swallowed: the worst case is one
 * redundant re-upload after the next restart, the exact pre-#1123 behavior.
 */
export async function persistSourceHash(path: string, hash: string): Promise<void> {
  if (!path || !hash) return;
  try {
    const r = getRedisConnection();
    await r.hset(sourceHashesKey(), path, hash);
  } catch (err: any) {
    /* intentional: persistence is best-effort. A failed write only costs one
       redundant re-embed of this file after the next restart — never a crash,
       never a blocked index. */
    console.error(
      `[source-index] persistSourceHash failed for ${path}: ${err?.message || String(err)}`,
    );
  }
}

/**
 * Count the persisted `path -> sha1` entries (issue #2267). A non-zero count
 * means a previous process believed it had indexed that many source files and
 * a fresh start will skip re-uploading them. The staleness detector in
 * `learning-lifecycle.ts` uses this as the cache-side half of "the cache claims
 * coverage but OpenViking is empty" — a count of 0 means a cold cache that the
 * indexer will populate normally, so there is nothing stale to clear.
 *
 * Best-effort: returns 0 on any Redis error (degrading to "no cache to clear",
 * which is the safe direction — the indexer simply re-uploads on a miss).
 */
export async function countSourceHashes(): Promise<number> {
  try {
    const r = getRedisConnection();
    const n = await r.hlen(sourceHashesKey());
    return typeof n === "number" ? n : 0;
  } catch (err: any) {
    console.error(
      `[source-index] countSourceHashes failed: ${err?.message || String(err)}`,
    );
    return 0;
  }
}

/**
 * Drop the entire persisted `path -> sha1` dedup map (issue #2267). Called ONLY
 * by the lifecycle staleness detector when it has confirmed OpenViking was reset
 * out from under the cache (a populated cache but OV holds no indexed source
 * resources). Deleting the single hash is atomic — there is no half-deleted
 * intermediate state that could double-index — so the next `runSourceInitialPass`
 * sees an empty cache and re-uploads the whole modified-window tree, repopulating
 * OpenViking.
 *
 * Best-effort: a delete failure is logged and reported as `false` so the caller
 * can leave the in-memory cache untouched and try again on the next restart,
 * never a crash and never a blocked startup. Returns whether the clear succeeded.
 */
export async function clearSourceHashes(): Promise<boolean> {
  try {
    const r = getRedisConnection();
    await r.del(sourceHashesKey());
    return true;
  } catch (err: any) {
    console.error(
      `[source-index] clearSourceHashes failed: ${err?.message || String(err)}`,
    );
    return false;
  }
}
