/**
 * Anchor work queue Redis ops + OV-backed dedup utilities.
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "./keys.ts";
// Issue #954: the OV dedup search + work-item indexing route through the
// OpenViking Request Adapter — the same boundary and config (OPENVIKING_URL via
// ov-config.ts) every other OV caller uses, so these dedup fetches are no longer
// un-owned raw fetches the seam-check can't see. redis-seam-check forbids only
// redis/keys|kv|connection imports outside src/redis/; importing the OV adapter
// cross-family is seam-legal (this module already imported ov-config.ts).
import { ovPostJson, ovPostForm, isOvFailure } from "../knowledge-base/ov-request.ts";
import { getRedisConnection } from "./connection.ts";

/** Get the length of the work queue. */
export async function getWorkQueueLen(): Promise<number> {
  const r = getRedisConnection();
  return r.llen(redisKeys.anchorWorkQueue());
}

/** Get all items from the work queue. */
export async function getWorkQueueItems(): Promise<string[]> {
  const r = getRedisConnection();
  return r.lrange(redisKeys.anchorWorkQueue(), 0, -1);
}

/** Push an item to the work queue and index into OV for semantic dedup. */
export async function pushToWorkQueue(json: string): Promise<void> {
  const r = getRedisConnection();
  await r.rpush(redisKeys.anchorWorkQueue(), json);

  // Index reference into OV for future semantic dedup (fire-and-forget)
  try {
    const item = JSON.parse(json);
    const reference = item.reference || "";
    if (reference) {
      indexWorkItem(reference, item.source || "queue").catch((err: any) => {
        console.error(`[WorkQueue] Background indexWorkItem failed: ${err.message}`);
      });
    }
  } catch { /* intentional: don't fail queue push on index error */ }
}

// ---------------------------------------------------------------------------
// Work queue dedup utilities
// ---------------------------------------------------------------------------

/** Configurable semantic similarity threshold for dedup (0-1). Default 0.85. */
export const SEMANTIC_DEDUP_THRESHOLD = parseFloat(
  process.env.HYDRA_SEMANTIC_DEDUP_THRESHOLD || "0.85",
);

/**
 * Normalize a string for fuzzy comparison: lowercase, collapse whitespace, trim.
 */
export function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Check if two references are fuzzy duplicates.
 * Returns true if either is a case-insensitive substring of the other
 * (after whitespace normalization).
 */
export function isFuzzyDuplicate(a: string, b: string): boolean {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Search OpenViking for semantically similar work items.
 * Returns the matched reference string if similarity exceeds threshold, or null.
 * Falls back gracefully -- returns null if OV is unavailable.
 */
export async function searchOVForDedup(
  reference: string,
  threshold: number = SEMANTIC_DEDUP_THRESHOLD,
): Promise<string | null> {
  // The adapter owns transport (URL join + auth + 5000ms timeout + error
  // classification) and never throws; this reader keeps the tag filter, the
  // score threshold, and the fall-through-to-fuzzy-only-on-failure semantics.
  const result = await ovPostJson<any>(
    "/api/v1/search/find",
    {
      query: reference,
      limit: 5,
      filter: { tags: ["hydra-work-item"] },
    },
    { timeout: 5000 },
  );
  if (isOvFailure(result)) {
    // OV unavailable -- fall through to fuzzy-only dedup (don't block queue operations)
    console.error(`[WorkQueue] Semantic dedup: OV unavailable, falling back to fuzzy-only -- ${result.code}`);
    return null;
  }
  const resources = result.data?.result?.resources || [];
  for (const r of resources) {
    const score = r.score ?? r.similarity ?? 0;
    if (score >= threshold) {
      const matchedRef = r.title || r.uri || "";
      console.log(`[WorkQueue] Semantic dedup: "${reference.slice(0, 80)}" matches "${matchedRef.slice(0, 80)}" (score=${score.toFixed(3)}, threshold=${threshold})`);
      return matchedRef;
    }
  }
  return null;
}

/**
 * Check if a reference already exists in the work queue (fuzzy match first,
 * then semantic dedup via OpenViking embeddings).
 * Returns the matched reference if found, or null if no duplicate.
 *
 * Fast path: fuzzy substring check catches obvious duplicates without OV.
 * Slow path: OV embedding search catches semantic duplicates (same work,
 * different words). OV unavailable falls through gracefully.
 */
export async function findWorkQueueDuplicate(reference: string): Promise<string | null> {
  // Fast path: fuzzy dedup against current queue items
  const items = await getWorkQueueItems();
  for (const raw of items) {
    try {
      const item = JSON.parse(raw);
      const existing = item.reference || "";
      if (isFuzzyDuplicate(reference, existing)) {
        return existing;
      }
    } catch { /* intentional: skip corrupt items */ }
  }

  // Slow path: semantic dedup via OV embeddings
  const semanticMatch = await searchOVForDedup(reference);
  if (semanticMatch) return semanticMatch;

  return null;
}

/**
 * Index a work item reference into OpenViking for future semantic dedup.
 * Tagged with "hydra-work-item" so dedup searches can filter to this namespace.
 * Fire-and-forget -- never throws, logs errors.
 */
export async function indexWorkItem(reference: string, source: string = "queue"): Promise<void> {
  try {
    const safeName = reference.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    const content = `# ${reference}\n\nSource: ${source}\nIndexed: ${new Date().toISOString()}`;

    // Upload as temp file then add as resource with tag
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([content], { type: "text/markdown" }),
      `work-item-${safeName}.md`,
    );

    const uploadResult = await ovPostForm<any>(
      "/api/v1/resources/temp_upload",
      formData,
      { timeout: 10000 },
    );

    if (isOvFailure(uploadResult)) {
      console.error(
        `[WorkQueue] indexWorkItem upload failed: ${uploadResult.code} body=${(uploadResult.body ?? "").slice(0, 200)}`,
      );
      return;
    }

    // OpenViking wraps responses as {status, result, error, telemetry}.
    // The temp_upload endpoint returns the path under `result.temp_path` —
    // older code read `uploadData.temp_path` directly and silently no-op'd
    // on every call (issue #313: 354 silent failures over 2 days). Read
    // both wrapped and legacy unwrapped shapes for safety.
    const uploadData = uploadResult.data;
    const result = uploadData?.result ?? {};
    const tempPath =
      result.temp_path ?? result.path ?? uploadData.temp_path ?? uploadData.path;
    if (!tempPath) {
      // Fail loud (CLAUDE.md convention): log the full response body so a
      // future API shape change is debuggable from logs alone.
      console.error(
        `[WorkQueue] indexWorkItem: no temp_path in upload response — body=${JSON.stringify(
          uploadData,
        ).slice(0, 300)}`,
      );
      return;
    }

    const addResult = await ovPostJson(
      "/api/v1/resources",
      {
        temp_path: tempPath,
        to: `viking://resources/hydra-work-items/${safeName}`,
        tags: ["hydra-work-item"],
      },
      { timeout: 15000 },
    );

    if (!isOvFailure(addResult)) {
      console.log(`[WorkQueue] Indexed work item into OV: "${reference.slice(0, 80)}" (source=${source})`);
    } else {
      console.error(
        `[WorkQueue] indexWorkItem add-resource failed: ${addResult.code} body=${(addResult.body ?? "").slice(0, 200)}`,
      );
    }
  } catch (err: any) {
    console.error(`[WorkQueue] indexWorkItem failed: ${err.message}`);
  }
}

/**
 * Clean the work queue on startup:
 * - Remove items with "COMPLETED:" prefix in their reference
 * - Deduplicate remaining items (keep first occurrence)
 */
export async function cleanWorkQueue(): Promise<{ removedCompleted: number; removedDuplicates: number }> {
  const r = getRedisConnection();
  const items = await getWorkQueueItems();
  let removedCompleted = 0;
  let removedDuplicates = 0;

  const toRemove: string[] = [];
  const seen: string[] = []; // normalized references we've seen

  for (const raw of items) {
    let ref = "";
    try {
      const item = JSON.parse(raw);
      ref = item.reference || "";
    } catch {
      ref = raw;
    }

    // Remove COMPLETED: items
    if (ref.startsWith("COMPLETED:") || ref.startsWith("completed:")) {
      toRemove.push(raw);
      removedCompleted++;
      continue;
    }

    // Dedup against previously seen items
    const normalized = normalizeForDedup(ref);
    const isDup = seen.some(s => isFuzzyDuplicate(ref, s));
    if (isDup) {
      toRemove.push(raw);
      removedDuplicates++;
    } else {
      seen.push(normalized);
    }
  }

  // Remove flagged items
  for (const val of toRemove) {
    await r.lrem(redisKeys.anchorWorkQueue(), 1, val);
  }

  if (removedCompleted > 0 || removedDuplicates > 0) {
    console.log(`[WorkQueue] Cleanup: removed ${removedCompleted} completed, ${removedDuplicates} duplicates`);
  }

  return { removedCompleted, removedDuplicates };
}
