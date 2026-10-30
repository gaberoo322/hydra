/**
 * Review-findings Redis seam (issue #5270, R1 of the two-pass review rollout;
 * ADR-0046 Decision 8).
 *
 * One Redis hash, `hydra:review-findings:rows` (field = deterministic row id,
 * value = JSON row), holds one row per QA review finding / pair-miss /
 * detector-gap. Two feeders write it: QA's route step at verdict time
 * (`source: "route"`) and the weekly reconcile harvest of GitHub verdict
 * comments (`source: "reconcile"`, `scripts/qa/review-findings-reconcile.ts`).
 * Both derive the id with the same pure function
 * (`reviewFindingRowId`, `src/qa/review-findings-extract.ts`), so re-running
 * either feeder is a no-op by construction.
 *
 * Write rules (INV-2): a route row is an upsert (HSET); a reconcile row is
 * HSETNX, so it can never overwrite ANY existing row and in particular never
 * a route row. Retention is enforced by reconcile (HDEL of rows older than 90
 * days), never on the read path. The key is module-private (the
 * `scope-violations.ts` precedent), so `src/redis/keys.ts` and the generated
 * redis-keys inventory are untouched.
 *
 * Write-only from QA's side, read-only from retro's side. Per ADR-0009 every
 * access from outside `src/redis/` goes through these accessors.
 */

import { getRedisConnection } from "./connection.ts";

/** Which feeder wrote the row. */
export type ReviewFindingSource = "route" | "reconcile";

export type ReviewFindingKind = "finding" | "pair-miss" | "detector-gap";

export type ReviewFindingSeverity = "high" | "medium" | "low";

interface ReviewFindingRowBase {
  /** PR the verdict is about (the trailer's `pr=`, never the comment's host). */
  pr: number;
  /** 1-based review round on that PR. */
  round: number;
  /** Head SHA reviewed (trailer `sha=`). */
  sha: string;
  /** ISO-8601 UTC timestamp the finding was recorded / the comment was posted. */
  at: string;
  source: ReviewFindingSource;
}

/** One per-finding row (a `### Findings` / follow-up table row). */
export interface FindingRow extends ReviewFindingRowBase {
  kind: "finding";
  severity: ReviewFindingSeverity;
  axis: "standards" | "spec";
  /** The one-line `file:line` cell as rendered (e.g. `PR body` for body findings). */
  location: string;
  /** Path half of `canonicalLocationKey(location)`; null for placeholders. */
  file: string | null;
  /** First `STD-*` rule token in the finding text; null when none. */
  rule: string | null;
  finding: string;
  reviewers: string[];
}

/** A B-only medium/high finding the pair-only counterfactual fold would miss. */
export interface PairMissRow extends ReviewFindingRowBase {
  kind: "pair-miss";
  severity: ReviewFindingSeverity;
  note?: string;
  /** Feeder-supplied discriminator so distinct same-round misses keep separate ids. */
  key?: string;
}

/** A one-way call the detector and the `Merge danger:` field did not flag. */
export interface DetectorGapRow extends ReviewFindingRowBase {
  kind: "detector-gap";
  gapClass: string;
  note?: string;
  /** Feeder-supplied unique key so distinct same-round gaps keep separate ids. */
  key?: string;
}

export type ReviewFindingRow = FindingRow | PairMissRow | DetectorGapRow;

/** A row together with its deterministic hash field. */
export interface StoredReviewFindingRow {
  id: string;
  row: ReviewFindingRow;
}

function reviewFindingsKey(): string {
  return "hydra:review-findings:rows";
}

/**
 * Write rows. `route` rows upsert (HSET); `reconcile` rows are HSETNX so they
 * never overwrite an existing row. Returns how many fields were newly created
 * or updated (HSETNX no-ops are not counted). Throws on a Redis error —
 * callers decide whether a failed record is fatal.
 */
export async function appendReviewFindingRows(
  entries: readonly StoredReviewFindingRow[],
): Promise<{ written: number }> {
  if (entries.length === 0) return { written: 0 };
  const r = getRedisConnection();
  const key = reviewFindingsKey();
  const pipe = r.pipeline();
  for (const { id, row } of entries) {
    const value = JSON.stringify(row);
    if (row.source === "route") pipe.hset(key, id, value);
    else pipe.hsetnx(key, id, value);
  }
  const results = await pipe.exec();
  let written = 0;
  for (let i = 0; i < entries.length; i++) {
    const res = Array.isArray(results) ? results[i] : null;
    if (!Array.isArray(res)) continue;
    if (res[0] != null) throw res[0] as Error;
    const entry = entries[i] as StoredReviewFindingRow;
    // HSET returns 1 for a new field, 0 for an overwrite; both are writes.
    if (entry.row.source === "route" || res[1] === 1) written++;
  }
  return { written };
}

/**
 * Read every stored row. Corrupt JSON is skipped with a loud log, never
 * thrown. Shape validation is the extractor's job (it reports `warnings`).
 */
export async function readReviewFindingRows(): Promise<StoredReviewFindingRow[]> {
  const r = getRedisConnection();
  const all = await r.hgetall(reviewFindingsKey());
  const out: StoredReviewFindingRow[] = [];
  for (const [id, raw] of Object.entries(all)) {
    try {
      out.push({ id, row: JSON.parse(raw) as ReviewFindingRow });
    } catch (err) {
      console.error(`[redis/review-findings] skipping corrupt row ${id}:`, err);
    }
  }
  return out;
}

/** HDEL the given row ids (reconcile's 90-day prune). Returns the delete count. */
export async function deleteReviewFindingRows(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = getRedisConnection();
  return r.hdel(reviewFindingsKey(), ...ids);
}
