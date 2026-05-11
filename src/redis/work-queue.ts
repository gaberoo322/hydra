/**
 * Anchor work queue Redis ops + OV-backed dedup utilities.
 * Extracted from redis-adapter.ts (issue #269).
 */

import { redisKeys } from "../redis-keys.ts";
// Issue #231: shared OV connection config — no local literal default.
import { OPENVIKING_URL as OV_DEDUP_URL, OPENVIKING_API_KEY as OV_DEDUP_KEY } from "../learning/ov-config.ts";
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

/** Remove an item from the work queue. */
export async function removeFromWorkQueue(value: string): Promise<number> {
  const r = getRedisConnection();
  return r.lrem(redisKeys.anchorWorkQueue(), 1, value);
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
  try {
    const res = await fetch(`${OV_DEDUP_URL}/api/v1/search/find`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": OV_DEDUP_KEY },
      body: JSON.stringify({
        query: reference,
        limit: 5,
        filter: { tags: ["hydra-work-item"] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const resources = data?.result?.resources || [];
    for (const r of resources) {
      const score = r.score ?? r.similarity ?? 0;
      if (score >= threshold) {
        const matchedRef = r.title || r.uri || "";
        console.log(`[WorkQueue] Semantic dedup: "${reference.slice(0, 80)}" matches "${matchedRef.slice(0, 80)}" (score=${score.toFixed(3)}, threshold=${threshold})`);
        return matchedRef;
      }
    }
    return null;
  } catch (err: any) {
    // OV unavailable -- fall through to fuzzy-only dedup (don't block queue operations)
    console.error(`[WorkQueue] Semantic dedup: OV unavailable, falling back to fuzzy-only -- ${err.message}`);
    return null;
  }
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

    const uploadRes = await fetch(`${OV_DEDUP_URL}/api/v1/resources/temp_upload`, {
      method: "POST",
      headers: { "X-Api-Key": OV_DEDUP_KEY },
      body: formData,
      signal: AbortSignal.timeout(10000),
    });

    if (!uploadRes.ok) {
      console.error(`[WorkQueue] indexWorkItem upload failed: ${uploadRes.status}`);
      return;
    }

    const uploadData = await uploadRes.json() as any;
    const tempPath = uploadData.temp_path || uploadData.path;
    if (!tempPath) {
      console.error(`[WorkQueue] indexWorkItem: no temp_path in upload response`);
      return;
    }

    const addRes = await fetch(`${OV_DEDUP_URL}/api/v1/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": OV_DEDUP_KEY },
      body: JSON.stringify({
        temp_path: tempPath,
        to: `viking://resources/hydra-work-items/${safeName}`,
        tags: ["hydra-work-item"],
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (addRes.ok) {
      console.log(`[WorkQueue] Indexed work item into OV: "${reference.slice(0, 80)}" (source=${source})`);
    } else {
      console.error(`[WorkQueue] indexWorkItem add-resource failed: ${addRes.status}`);
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
