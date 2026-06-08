/**
 * Calibration-outcome Redis seam (issue #1121).
 *
 * Owns the `hydra:anchors:calibration:*` key family: the ZSET index
 * `hydra:anchors:calibration:index` (cycleIds scored by recordedAt ms) and the
 * per-cycle record key `hydra:anchors:calibration:{cycleId}`.
 *
 * The historical WRITER (`recordCalibrationOutcome` in the retired
 * `anchor-scorer.ts`, deleted in ADR-0016) is gone, so this lane is no longer
 * populated — the only live consumer is the `calibration-trend` aggregator,
 * which now reads through this typed accessor instead of dynamically importing
 * the raw connection (the issue #1121 dynamic-import seam bypass). A dedicated
 * module is the sanctioned ADR-0017 exception: no existing write-owner module
 * holds the `hydra:anchors:calibration:*` key shapes, so extending an unrelated
 * owner would mis-attribute ownership; this is the single conceptual owner.
 *
 * **Never throws on the index walk** is the caller's contract, not this
 * module's — these accessors surface Redis errors to the caller, which wraps
 * the read in its own try/catch and degrades to an empty series.
 */

import { getRedisConnection } from "./connection.ts";

const CALIBRATION_INDEX_KEY = "hydra:anchors:calibration:index";

function calibrationRecordKey(cycleId: string): string {
  return `hydra:anchors:calibration:${cycleId}`;
}

/**
 * One `{cycleId, raw}` tuple read off the calibration index window: `cycleId`
 * is the index member, `raw` is the unparsed stored JSON for that record (or
 * null when the key vanished between the index read and the GET). The caller
 * owns the JSON parse + shape narrowing into its `CalibrationRecord` type.
 */
export interface CalibrationRecordRaw {
  cycleId: string;
  raw: string | null;
}

/**
 * ZRANGEBYSCORE the calibration index for cycleIds whose recordedAt (ms) falls
 * in `[startMs, endMs]`, then GET each record key, returning one
 * `{cycleId, raw}` tuple per indexed cycle (in index order). The window
 * boundaries are inclusive, matching the prior ZRANGEBYSCORE call this replaces.
 */
export async function readCalibrationRecordsRaw(
  startMs: number,
  endMs: number,
): Promise<CalibrationRecordRaw[]> {
  const r = getRedisConnection();
  const cycleIds = await r.zrangebyscore(CALIBRATION_INDEX_KEY, startMs, endMs);
  if (!Array.isArray(cycleIds) || cycleIds.length === 0) return [];

  const out: CalibrationRecordRaw[] = [];
  for (const cycleId of cycleIds) {
    const raw = await r.get(calibrationRecordKey(cycleId));
    out.push({ cycleId, raw });
  }
  return out;
}
