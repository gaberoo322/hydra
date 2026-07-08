/**
 * Outcome-attribution VOID phase (issue #3001, epic #2628). Extracted from the
 * former monolithic `subscribe.ts` chore coordinator as a focused single-concept
 * leaf.
 *
 * ## What this phase does
 *
 * VOID — drain the reverted-merge registry (`hydra:attribution:reverted`,
 * written by Outcome Holdback when it reverts a merge): for each entry, APPEND a
 * compensating void tombstone naming the reverted PR/commit (the append-only
 * ledger forbids delete, so a void is an append the #2630 estimator honors by
 * excluding the matching rows), then remove the entry.
 *
 * The append-only-ledger invariant (a void is an APPEND, never a delete/trim)
 * and FAIL-LOUD (every failure `console.error`'s with the `[attribution]`
 * prefix and increments `result.errors`; the phase never throws) are unchanged
 * by the split — this leaf owns exactly the two smallest seams the phase needs:
 * `redis/attribution-ledger` and `redis/attribution-reverted`.
 */

import {
  type AttributionLedger,
  type VoidMarker,
} from "../redis/attribution-ledger.ts";
import {
  listRevertedMerges,
  removeRevertedMerge,
  type RevertedMerge,
} from "../redis/attribution-reverted.ts";
import type { AttributionRecordResult } from "./subscribe.ts";

/** Context for the VOID phase ({@link voidRevertedMerges}). */
export interface VoidRevertsCtx {
  ledger: AttributionLedger;
  listRevertedFn: typeof listRevertedMerges;
  removeRevertedFn: typeof removeRevertedMerge;
  nowMs: number;
  result: AttributionRecordResult;
}

/** Per-revert slice of {@link VoidRevertsCtx} used by {@link voidOneRevert}. */
type VoidOneRevertCtx = Pick<
  VoidRevertsCtx,
  "ledger" | "removeRevertedFn" | "nowMs" | "result"
>;

export async function voidRevertedMerges(ctx: VoidRevertsCtx): Promise<void> {
  const listed = await ctx.listRevertedFn();
  if (listed.ok === false) {
    console.error(`[attribution] record: listRevertedMerges failed: ${listed.error}`);
    ctx.result.errors += 1;
    return;
  }
  if (listed.reverts.length === 0) return;

  for (const revert of listed.reverts) {
    await voidOneRevert(revert, ctx);
  }
}

async function voidOneRevert(
  revert: RevertedMerge,
  ctx: VoidOneRevertCtx,
): Promise<void> {
  const marker: VoidMarker = {
    kind: "void",
    voidedPrNumber: revert.prNumber,
    voidedCommitSha: revert.commitSha,
    reason: "holdback-revert",
    recordedAt: ctx.nowMs,
  };
  const res = await ctx.ledger.appendVoidMarker(marker);
  if (res.ok === false) {
    console.error(
      `[attribution] record: appendVoidMarker failed for pr=${revert.prNumber} sha=${revert.commitSha}: ${res.error}`,
    );
    ctx.result.errors += 1;
    return; // leave the entry to retry next tick
  }
  ctx.result.voidsAppended += 1;
  await ctx.removeRevertedFn({ commitSha: revert.commitSha, prNumber: revert.prNumber });
}
