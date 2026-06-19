/**
 * Stale-claim reaper (issue #374).
 *
 * Distinct from `requeueStaleInProgressItems` in ./wip.ts — that function uses
 * `meta.startedAt` (date precision) and reclaims items the system has been
 * chewing on for >7 days. This file uses `claimedAt` (ISO timestamp, stamped
 * on every move-into-inProgress) and reclaims items whose claimant died — the
 * "Phase-A codex-removal orphaned 3 in-progress items" failure mode. Default
 * threshold 2h; tunable via HYDRA_CLAIM_MAX_AGE_MS.
 */

import {
  addToBacklogLane, removeFromBacklogLane, getBacklogLaneIds,
  incrClaimsReapedLifetime,
  incrClaimsReapedDay,
  setClaimsReapedLast,
} from "../redis/backlog.ts";
import { pushAlert } from "../redis/alerts.ts";
import {
  applyLaneTransition, getItem, saveItem, getLaneItems,
} from "./internal.ts";
import {
  type MergedRef,
  fetchOpenTargetPrRefs,
  fetchMergedTargetPrRefs,
  itemMatchesOpenPr,
} from "./target-pr-feed.ts";

// Re-exported for back-compat: `test/backlog.test.mts` and the reconciler reach
// the matcher through `reaper.ts`. Its canonical home is now `target-pr-feed.ts`
// (issue #2084); this static re-export keeps existing import sites green and
// statically traceable for knip/dead-code.
export { itemMatchesOpenPr };

const CLAIM_MAX_AGE_MS_DEFAULT = 2 * 60 * 60 * 1000;
const CLAIM_REAP_ESCALATE_AFTER = parseInt(process.env.HYDRA_CLAIM_REAP_ESCALATE_AFTER) || 3;
const CLAIMS_REAPED_DAY_TTL_S = 7 * 24 * 60 * 60;

export interface StaleClaim {
  id: string;
  title: string;
  claimedBy: string | null;
  claimedAt: string | null;
  claimedAgeMs: number;
  reapCount: number;
}

/**
 * Return inProgress items annotated with their current claim age. Does not
 * mutate any state. Used by `/api/backlog/stale-claims` so the operator and
 * dashboard can preview what the reaper would touch.
 */
export async function getStaleClaims(opts: { maxAgeMs?: number; now?: number } = {}): Promise<{
  all: StaleClaim[];
  stale: StaleClaim[];
  maxAgeMs: number;
}> {
  const maxAgeMs = opts.maxAgeMs ?? CLAIM_MAX_AGE_MS_DEFAULT;
  // Clock seam (issue #2157): only the stale-age predicate's reference clock is
  // injectable, so the age-threshold logic can be unit-tested without backdating
  // real Redis claimedAt state. Record-stamping wall-clock (reapedAt/blockedAt/
  // completedAt/metric-day-key/alert ts) stays real `new Date()`/`Date.now()`.
  const now = opts.now ?? Date.now();
  const items = await getLaneItems("inProgress");
  const all: StaleClaim[] = items.map((item: any) => {
    const claimedAtIso = item.claimedAt ?? null;
    const claimedAtMs = claimedAtIso ? new Date(claimedAtIso).getTime() : NaN;
    const ageMs = Number.isFinite(claimedAtMs) ? now - claimedAtMs : 0;
    return {
      id: item.id,
      title: item.title,
      claimedBy: item.claimedBy ?? null,
      claimedAt: claimedAtIso,
      claimedAgeMs: ageMs,
      reapCount: typeof item.meta?.reapCount === "number" ? item.meta.reapCount : 0,
    };
  });
  const stale = all.filter(c => c.claimedAgeMs > maxAgeMs);
  return { all, stale, maxAgeMs };
}

/**
 * Reap stale claims: move inProgress items whose `claimedAt` is older than
 * `maxAgeMs` back to `queued` (or to `blocked` if they've been reaped
 * `CLAIM_REAP_ESCALATE_AFTER` times — likely a crash-loop, operator needs to
 * see it). Stamps `meta.reapedAt`, `meta.reapReason`, `meta.previousClaimedBy`
 * and increments `meta.reapCount`. Emits a `stale-claim-reaped` alert per item
 * and increments the lifetime + per-day `claims-reaped` counters.
 *
 * **Open-PR guard (issue #490).** Before reaping any item, the reaper fetches
 * the list of OPEN PRs in the target repo and skips any item whose ID (or
 * exact title) appears in a PR title/body. This prevents the "reaper
 * re-queues an item that already has an open implementing PR" failure mode,
 * which cost 76k tokens in a duplicate dev_target dispatch on 2026-05-17. The
 * check is best-effort: a `gh` outage falls back to time-only reaping
 * (over-reap once rather than wedge a slot). Tests inject the PR feed via
 * `opts.fetchOpenPrRefs` so they don't shell out.
 *
 * **Merged-PR guard (issue #1714).** After the open-PR check, a stale item
 * whose ID (or exact title) appears in a recently MERGED target PR is moved
 * to `done` — not back to `queued`. This closes the gap where a build agent
 * merges its PR and dies before releasing the claim: the open-PR guard no
 * longer matches (the PR is closed), so the pre-#1714 reaper re-queued
 * verifiably finished work as a phantom item (item-490, 2026-06-10). Order of
 * checks: open-PR skip first (work in flight), then merged-PR → done, then
 * default re-queue. Same fail-open posture: a `gh` outage on the merged
 * fetch falls back to time-only reaping. Tests inject via
 * `opts.fetchMergedPrRefs`.
 *
 * Both feeds now share the `MergedRef` shape and one injection contract with
 * the reconciler (issue #2084): the feeds live in `target-pr-feed.ts` and the
 * matcher reads each ref's `.blob`. The reaper does not use the `.ref` audit
 * handle — it only needs the searchable text — but unifying on `MergedRef`
 * collapses the two historical feed contracts into one.
 *
 * Returns `{ reaped, reapedToDone, skippedOpenPr }`. `skippedOpenPr` lists
 * items the open-PR guard preserved and `reapedToDone` lists items the
 * merged-PR guard completed, so operators and tests can audit the decisions.
 *
 * Never throws — Redis errors during metric/alert publication are logged and
 * swallowed so a metrics outage can't leave a wedged WIP slot.
 */
export async function reapStaleClaims(opts: {
  maxAgeMs?: number;
  now?: number;
  fetchOpenPrRefs?: () => Promise<MergedRef[] | null>;
  fetchMergedPrRefs?: () => Promise<MergedRef[] | null>;
} = {}): Promise<{
  reaped: Array<{ id: string; title: string; ageMs: number; escalated: boolean }>;
  reapedToDone: Array<{ id: string; title: string; ageMs: number }>;
  skippedOpenPr: Array<{ id: string; title: string; ageMs: number }>;
  maxAgeMs: number;
}> {
  const maxAgeMs = opts.maxAgeMs ?? CLAIM_MAX_AGE_MS_DEFAULT;
  // Clock seam (issue #2157): injects ONLY the stale-predicate comparison clock
  // (ageMs = now - claimedAtMs; ageMs <= maxAgeMs). Every record-stamping
  // wall-clock below — reapedAt, blockedAt, completedAt, the per-day metric key,
  // setClaimsReapedLast, and the alert ts — deliberately stays real-time so the
  // audit trail records true wall-clock even under an injected `now`.
  const now = opts.now ?? Date.now();
  const ids = await getBacklogLaneIds("inProgress");
  const reaped: Array<{ id: string; title: string; ageMs: number; escalated: boolean }> = [];
  const reapedToDone: Array<{ id: string; title: string; ageMs: number }> = [];
  const skippedOpenPr: Array<{ id: string; title: string; ageMs: number }> = [];

  const prFetcher = opts.fetchOpenPrRefs ?? fetchOpenTargetPrRefs;
  const openPrRefs = await prFetcher();
  const mergedFetcher = opts.fetchMergedPrRefs ?? fetchMergedTargetPrRefs;
  const mergedPrRefs = await mergedFetcher();
  // The matcher reads searchable text; map each ref to its `.blob`. `null`
  // (feed unavailable) stays `null` so the fail-open guards below skip the check.
  const prBlobs = openPrRefs?.map((r) => r.blob) ?? null;
  const mergedPrBlobs = mergedPrRefs?.map((r) => r.blob) ?? null;

  for (const id of ids) {
    const item = await getItem(id);
    if (!item) continue;

    const claimedAtIso = item.claimedAt;
    if (!claimedAtIso) continue;
    const claimedAtMs = new Date(claimedAtIso).getTime();
    if (!Number.isFinite(claimedAtMs)) continue;
    const ageMs = now - claimedAtMs;
    if (ageMs <= maxAgeMs) continue;

    if (prBlobs && itemMatchesOpenPr(item, prBlobs)) {
      console.warn(
        `[Backlog] Skipping reap of ${id} ("${(item.title || "").slice(0, 60)}") — open PR in target repo references this item. claimedBy=${item.claimedBy ?? "?"} ageMs=${ageMs}`,
      );
      skippedOpenPr.push({ id, title: item.title, ageMs });
      continue;
    }

    if (mergedPrBlobs && itemMatchesOpenPr(item, mergedPrBlobs)) {
      // Merged-PR guard (issue #1714): the work is verifiably complete — the
      // claimant merged its PR and died before releasing the claim. Move the
      // item to done (mirroring moveToDone's completedAt/outcome/checked
      // stamps so done-retention prunes it) instead of re-queuing a phantom.
      const previousClaimedBy = item.claimedBy ?? null;
      const reapCount = (typeof item.meta?.reapCount === "number" ? item.meta.reapCount : 0) + 1;
      const reapReason = "stale-claim-merged";

      await removeFromBacklogLane("inProgress", id);
      item.checked = true;
      item.meta = {
        ...item.meta,
        reapedAt: new Date().toISOString(),
        reapReason,
        previousClaimedBy,
        reapCount,
        completedAt: new Date().toISOString().split("T")[0],
        outcome: "merged",
      };
      applyLaneTransition(item, "done");
      await saveItem(item);
      await addToBacklogLane("done", -Date.now(), id);

      console.warn(
        `[Backlog] Reaped stale claim ${id} ("${(item.title || "").slice(0, 60)}") to DONE — merged PR in target repo references this item. claimedBy=${previousClaimedBy ?? "?"} ageMs=${ageMs} threshold=${maxAgeMs} reapCount=${reapCount}`,
      );

      try {
        await incrClaimsReapedLifetime();
        const isoDate = new Date().toISOString().split("T")[0];
        await incrClaimsReapedDay(isoDate, CLAIMS_REAPED_DAY_TTL_S);
        await setClaimsReapedLast(new Date().toISOString());
      } catch (err: any) {
        console.error(`[Backlog] reapStaleClaims metrics failed for ${id}: ${err.message}`);
      }

      try {
        await pushAlert(
          JSON.stringify({
            type: "stale-claim-reaped",
            ts: new Date().toISOString(),
            payload: {
              itemId: id,
              title: item.title,
              previousClaimedBy,
              claimedAt: claimedAtIso,
              ageMs,
              maxAgeMs,
              reapCount,
              reapReason,
              targetLane: "done",
              escalated: false,
            },
          }),
          100,
        );
      } catch (err: any) {
        console.error(`[Backlog] reapStaleClaims alert publish failed for ${id}: ${err.message}`);
      }

      reapedToDone.push({ id, title: item.title, ageMs });
      continue;
    }

    const previousClaimedBy = item.claimedBy ?? null;
    const reapCount = (typeof item.meta?.reapCount === "number" ? item.meta.reapCount : 0) + 1;
    const escalate = reapCount >= CLAIM_REAP_ESCALATE_AFTER;
    const targetLane = escalate ? "blocked" : "queued";
    const reapReason = "stale-claim";

    await removeFromBacklogLane("inProgress", id);
    item.meta = {
      ...item.meta,
      reapedAt: new Date().toISOString(),
      reapReason,
      previousClaimedBy,
      reapCount,
      ...(escalate
        ? {
            blockedAt: new Date().toISOString().split("T")[0],
            blockedReason: `repeatedly-reaped (${reapCount}x): claim by ${previousClaimedBy ?? "unknown"} aged ${Math.round(ageMs / 1000)}s past ${Math.round(maxAgeMs / 1000)}s threshold`,
          }
        : {}),
    };
    applyLaneTransition(item, targetLane);
    await saveItem(item);
    await addToBacklogLane(targetLane, Date.now(), id);

    console.warn(
      `[Backlog] Reaped stale claim ${id} ("${(item.title || "").slice(0, 60)}") — claimedBy=${previousClaimedBy ?? "?"} ageMs=${ageMs} threshold=${maxAgeMs} reapCount=${reapCount} → ${targetLane}`,
    );

    try {
      await incrClaimsReapedLifetime();
      const isoDate = new Date().toISOString().split("T")[0];
      await incrClaimsReapedDay(isoDate, CLAIMS_REAPED_DAY_TTL_S);
      await setClaimsReapedLast(new Date().toISOString());
    } catch (err: any) {
      console.error(`[Backlog] reapStaleClaims metrics failed for ${id}: ${err.message}`);
    }

    try {
      await pushAlert(
        JSON.stringify({
          type: "stale-claim-reaped",
          ts: new Date().toISOString(),
          payload: {
            itemId: id,
            title: item.title,
            previousClaimedBy,
            claimedAt: claimedAtIso,
            ageMs,
            maxAgeMs,
            reapCount,
            targetLane,
            escalated: escalate,
          },
        }),
        100,
      );
    } catch (err: any) {
      console.error(`[Backlog] reapStaleClaims alert publish failed for ${id}: ${err.message}`);
    }

    reaped.push({ id, title: item.title, ageMs, escalated: escalate });
  }

  return { reaped, reapedToDone, skippedOpenPr, maxAgeMs };
}
