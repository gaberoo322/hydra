/**
 * Attribution reverted-merge registry Redis seam (issue #2632; split out of the
 * former mixed-concern `attribution.ts` in issue #2916).
 *
 * Owns ONLY the reverted-merge registry: a single Redis HASH, one field per
 * reverted merge (field = commit SHA when known, else `pr-<n>`), value = JSON
 * {@link RevertedMerge}. This is the VOID-phase substrate of the three-phase
 * attribution model — the DURABLE revert signal the recorder chore consumes to
 * VOID a reverted PR's attribution rows. It is NOT the append-only ledger
 * (`attribution-ledger.ts`) and NOT the open-window hash
 * (`attribution-windows.ts`); the three state spaces are orthogonal.
 *
 * It is deliberately a registry rather than a live `holdback.reverted` event
 * subscriber: the design (issue #2632) rejects a long-lived EventBus.consume()
 * loop (ADR-0006/0010/0012 — no orphaned recorder). Outcome Holdback marks a
 * merge reverted here (writer side) and the Housekeeping-cadence chore drains it
 * (reader side), appending a compensating void tombstone for each — the same
 * write-a-registry / drain-at-cadence shape the pending-enroll registry uses.
 * TTL-stamped (shared ledger TTL) so a drained-but-not-removed entry can't
 * linger forever.
 *
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`) — no `new Redis()`, no `redis/kv` import
 * outside `src/redis/`. Per CLAUDE.md conventions every function is best-effort:
 * a Redis error is logged with the `[attribution]` prefix and surfaces as a
 * structured result (or a silent no-op for cleanup), never a thrown exception
 * (this only records intent; it never reverts anything).
 */

import { getRedisConnection } from "./connection.ts";
import { ATTRIBUTION_LEDGER_TTL_SECONDS } from "./attribution-constants.ts";

// ---------------------------------------------------------------------------
// Key builder (ADR-0009 — key shape lives in the seam).
// ---------------------------------------------------------------------------

/** The single reverted-merge registry hash key. JSON {@link RevertedMerge} values. */
export function attributionRevertedKey(): string {
  return "hydra:attribution:reverted";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A merge Outcome Holdback reverted (issue #2632). The recorder chore drains
 * these and appends one void tombstone per entry, then removes it.
 */
export interface RevertedMerge {
  /** PR number of the reverted merge, if known. */
  prNumber: number | null;
  /** Commit SHA of the reverted merge, if known. */
  commitSha: string | null;
  /** Epoch ms the revert was recorded. */
  revertedAt: number;
}

export type MarkRevertedResult = { ok: true } | { ok: false; error: string };
export type ListRevertedResult =
  | { ok: true; reverts: RevertedMerge[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Registry-entry field key for a reverted merge (SHA preferred, else `pr-<n>`). */
function revertedField(entry: { commitSha: string | null; prNumber: number | null }): string | null {
  if (entry.commitSha && entry.commitSha.length > 0) return entry.commitSha;
  if (entry.prNumber != null) return `pr-${entry.prNumber}`;
  return null;
}

/**
 * Register a merge as reverted so the recorder chore voids its attribution rows
 * (issue #2632). Idempotent on the merge key. Best-effort — returns a structured
 * result, never throws (this only records intent; it never reverts anything).
 */
export async function markMergeReverted(entry: RevertedMerge): Promise<MarkRevertedResult> {
  const field = revertedField(entry);
  if (field == null) {
    return { ok: false, error: "markMergeReverted: commitSha or prNumber is required" };
  }
  try {
    const r = getRedisConnection();
    const key = attributionRevertedKey();
    await r.hset(key, field, JSON.stringify(entry));
    await r.expire(key, ATTRIBUTION_LEDGER_TTL_SECONDS);
    return { ok: true };
  } catch (err: any) {
    const msg = `[attribution] markMergeReverted failed for ${field}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * List every pending reverted-merge entry. A malformed field is skipped
 * (logged). Best-effort — returns a structured result, never throws.
 */
export async function listRevertedMerges(): Promise<ListRevertedResult> {
  try {
    const r = getRedisConnection();
    const hash = await r.hgetall(attributionRevertedKey());
    const reverts: RevertedMerge[] = [];
    for (const [field, raw] of Object.entries(hash) as Array<[string, string]>) {
      try {
        reverts.push(JSON.parse(raw) as RevertedMerge);
      } catch (err: any) {
        console.error(
          `[attribution] listRevertedMerges: skipping malformed field ${field}: ${err?.message || String(err)}`,
        );
      }
    }
    return { ok: true, reverts };
  } catch (err: any) {
    const msg = `[attribution] listRevertedMerges failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Remove a reverted-merge entry once its void tombstone has been appended.
 * Best-effort cleanup — a stale entry just re-appends an (idempotent) void on
 * the next tick, which the estimator dedupes by merge identity.
 */
export async function removeRevertedMerge(
  entry: { commitSha: string | null; prNumber: number | null },
): Promise<void> {
  const field = revertedField(entry);
  if (field == null) return;
  try {
    const r = getRedisConnection();
    await r.hdel(attributionRevertedKey(), field);
  } catch (err: any) {
    /* intentional: removing a drained revert entry is best-effort cleanup; a
       stale entry re-appends an idempotent void next tick. */
    console.error(`[attribution] removeRevertedMerge failed for ${field}: ${err?.message || String(err)}`);
  }
}

/** Test-only: clear the reverted-merge registry. */
export async function _resetReverted(): Promise<void> {
  const r = getRedisConnection();
  await r.del(attributionRevertedKey());
}
