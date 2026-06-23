/**
 * Merge→done reconciler (issue #1715).
 *
 * Closes the general "phantom work" hole that the reaper's merged-PR guard
 * (issue #1714) only covers for stale `inProgress` claims: when the build flow
 * misses its own done-stamp (agent crash after merge, reaper interference,
 * manual merges), the backlog item lingers in a non-done lane even though its
 * implementing PR verifiably merged. Confirmed instance: `item-490` sat in
 * `queued` for 9+ hours after hydra-betting PR #109 merged.
 *
 * The reconciler sweeps recently merged target PRs AND recent merge commits on
 * the target's default branch (cycle merges bypass PRs — e.g.
 * "merge: claude cycle — ... (item-485)"), extracts `item-NNN` references via
 * the same whole-word matcher the reaper uses (`itemMatchesOpenPr`), and moves
 * every referenced item found in a swept lane (`inProgress`/`queued`/`backlog`
 * — NEVER `blocked`, see `RECONCILE_LANES`) to `done`, stamping
 * `meta.reconciledAt` / `meta.reconciledFrom` plus the same
 * `completedAt`/`outcome`/`checked` fields `moveToDone` writes so done-lane
 * retention prunes the item normally.
 *
 * Contract (mirrors `reapStaleClaims`):
 *   - Fail closed on ambiguity: a `gh` outage on a feed returns `null` →
 *     that feed contributes nothing; both feeds down → complete no-op. An
 *     unreadable board (Redis error) aborts the sweep with what was done so
 *     far. An item is NEVER moved without a concrete merged reference.
 *   - Idempotent: the `done` lane is never scanned, so re-running over the
 *     same window finds nothing to move.
 *   - Never throws — returns a result object; per-item failures are logged
 *     and skipped (CLAUDE.md: never throw from merge/verification paths).
 *   - Auditable: each closure emits a `merged-item-reconciled` alert and is
 *     listed in the returned `reconciled` array.
 *
 * Invoked hourly from the Housekeeping chore set
 * (`src/scheduler/housekeeping.ts`, `merged-item-reconciler`) — the same
 * cadence home as the work-queue hygiene reconciler (#1690). Tests inject the
 * feeds via `opts` (same seam style as `reaper.ts` `opts.fetchOpenPrBlobs`).
 *
 * Stale-claim escalation (issue #2031). The merged-ref scan above only closes
 * items whose id/title appears in a recently-merged PR or merge-commit token.
 * Items shipped OUT-OF-BAND — by a different cycle, before a priority shift, or
 * by a now-retired claimant (e.g. `claimedBy: codex`) that never referenced the
 * item id — carry NO matching token, so the merged scan keeps them and the
 * claim path later re-serves shipped work (the `stale-backlog-claim-returns-
 * shipped-item` friction, escalated after 3 hits). The escalation pass catches
 * these by a STALENESS / RETIRED-CLAIMANT signal and routes them to `blocked`
 * (operator-visible) — NEVER silently to `done`. Staleness alone is not proof
 * of shipment, so it is an operator-attention escalation, not an auto-close:
 * this is the central design-concept invariant ("done requires a concrete
 * merged ref or explicit operator action; staleness → blocked"). It deliberately
 * re-uses the reaper's escalate-to-blocked posture (`CLAIM_REAP_ESCALATE_AFTER`)
 * rather than inventing a new lane.
 *
 * Subject fuzzy-match gate (issue #2110). The `item-NNN`/`#NNN` token scan
 * missed a large class of genuinely-SHIPPED items: dev cycles routinely ship an
 * item's work under a renamed title or a sibling item id (squash "claude cycle"
 * merges, item-412 shipping under item-455), carrying no matching token. A
 * 2026-06-18 operator triage found 24/26 stale escalations had actually shipped
 * (92% false-positive), burying the one truly-blocked item. So before escalating,
 * `escalateStaleItems` now checks whether any merged blob's subject COVERS the
 * item title via an ASYMMETRIC containment helper (`subjectCoveredBy`,
 * `merged-refs.ts`) — a hit IS a concrete merged ref, so the item reconciles to
 * `done` (reconciledFrom stamp) instead of escalating. The gate only suppresses
 * a would-be escalation; a near-miss still escalates, and an empty merged-ref
 * set makes the gate a no-op (feeds-down fail-closed contract preserved).
 */

import {
  addToBacklogLane, removeFromBacklogLane, getBacklogLaneIds,
} from "../redis/backlog.ts";
import { pushAlert } from "../redis/alerts.ts";
import { applyLaneTransition, getItem, saveItem } from "./internal.ts";
import {
  type MergedRef,
  fetchMergedTargetPrRefs,
  fetchTargetMergeCommitRefs,
  itemMatchesOpenPr,
} from "./target-pr-feed.ts";
import { escalateStaleItems } from "./stale-escalation.ts";
import { RECONCILE_LANES } from "./reconcile-constants.ts";

// `MergedRef` moved to `target-pr-feed.ts` (issue #2084); re-export it for
// back-compat so unrelated import sites that referenced `reconciler.MergedRef`
// do not churn.
export type { MergedRef };

// `RECONCILE_LANES` moved to the leaf `reconcile-constants.ts` (issue #2387) to
// break the mutual import with `stale-escalation.ts` (which imported the
// constant back from here). Re-export it for back-compat so existing import
// sites that referenced `reconciler.RECONCILE_LANES` do not churn.
export { RECONCILE_LANES };

/**
 * Alert code raised when BOTH feeds are unavailable in a single run (issue
 * #2057). Pushed to `hydra:alerts` so the operator can distinguish "the
 * reconciler ran and found nothing merged" from "the reconciler has been
 * blind for hours because gh is down". A single-feed failure is only
 * WARN-logged (the other feed still gives partial coverage).
 */
export const RECONCILER_BOTH_FEEDS_DOWN_ALERT = "reconciler:both-feeds-down";

/**
 * One feed's outcome for a run: how many artifacts it examined and, on
 * failure, the (truncated) reason. `examined` is 0 on failure (we examined
 * nothing) and on a genuine empty feed alike — `failed` is the discriminator.
 */
interface FeedOutcome {
  refs: MergedRef[];
  examined: number;
  failed?: string;
}

/**
 * Normalize a `() => MergedRef[] | null` fetcher into a `FeedOutcome`. A `null`
 * return is the fetcher's "no information / gh outage" signal (its own
 * `console.error` already named the cause); we surface a generic reason here so
 * the health record / alert has something to show. A non-null array — even
 * empty — means the feed answered: `examined` is the array length, `failed` absent.
 */
async function runFeed(
  fetcher: () => Promise<MergedRef[] | null>,
  label: string,
): Promise<FeedOutcome> {
  let refs: MergedRef[] | null;
  try {
    refs = await fetcher();
  } catch (err: any) {
    // A fetcher should return null rather than throw, but never let a feed
    // exception abort the sweep (CLAUDE.md: never throw from these paths).
    const reason = `${label} feed threw: ${(err?.message ?? String(err)).slice(0, 160)}`;
    console.error(`[Backlog] reconcileMergedItems ${reason}`);
    return { refs: [], examined: 0, failed: reason };
  }
  if (refs === null) {
    return { refs: [], examined: 0, failed: `${label} feed unavailable (gh outage or malformed response)` };
  }
  return { refs, examined: refs.length };
}

/**
 * Sweep the reconcilable lanes (`inProgress`/`queued`/`backlog` — never
 * `blocked` or `done`) for items referenced by a recently merged target PR or
 * merge commit, and move each match to `done` with audit stamps.
 *
 * Options (test seam, mirrors `reapStaleClaims`):
 *   - `fetchMergedPrRefs`  — injectable merged-PR feed; default shells `gh`.
 *   - `fetchMergeCommitRefs` — injectable commit feed; default shells `gh`.
 *   - `now` — clock injection for the staleness predicate (tests pin the age).
 *
 * Returns:
 *   - `reconciled` — items moved to done, with the matched `ref` and the lane
 *     they were lifted from.
 *   - `escalated`  — items moved to `blocked` by the stale-claim escalation
 *     pass (issue #2031): unconfirmable-but-probably-shipped, NEVER auto-done.
 *   - `scanned`    — how many non-done items were inspected.
 *   - `feedsAvailable` — false when BOTH feeds returned `null` (gh outage);
 *     the merged→done sweep is a guaranteed no-op in that case, but the
 *     staleness escalation pass STILL runs (it reads only local item age /
 *     claimant and routes to the safe operator-attention `blocked` lane).
 *   - `feed` (issue #2057) — per-feed liveness: how many PRs/commits were
 *     examined and, on failure, the reason. Distinguishes "0 merged" from
 *     "fetcher broken".
 *   - `metrics` (issue #2057) — batch metrics: references matched, items that
 *     failed to move, and total `durationMs`.
 *   - `alert` (issue #2057) — present only on a critical failure (both feeds
 *     down). Also pushed to `hydra:alerts` so the operator is notified, not
 *     left to grep the journal.
 */
export async function reconcileMergedItems(opts: {
  fetchMergedPrRefs?: () => Promise<MergedRef[] | null>;
  fetchMergeCommitRefs?: () => Promise<MergedRef[] | null>;
  now?: number;
} = {}): Promise<{
  reconciled: Array<{ id: string; title: string; fromLane: string; ref: string }>;
  escalated: Array<{ id: string; title: string; fromLane: string; reason: string }>;
  scanned: number;
  feedsAvailable: boolean;
  feed: {
    prs: { examined: number; failed?: string };
    commits: { examined: number; failed?: string };
  };
  metrics: { referencesFound: number; movesFailed: number; durationMs: number };
  alert?: { code: string; message: string };
}> {
  const startedAt = opts.now ?? Date.now();
  const reconciled: Array<{ id: string; title: string; fromLane: string; ref: string }> = [];
  const escalated: Array<{ id: string; title: string; fromLane: string; reason: string }> = [];
  let scanned = 0;
  let referencesFound = 0;
  let movesFailed = 0;
  const now = opts.now ?? Date.now();

  const prFetcher = opts.fetchMergedPrRefs ?? fetchMergedTargetPrRefs;
  const commitFetcher = opts.fetchMergeCommitRefs ?? fetchTargetMergeCommitRefs;
  const prOutcome = await runFeed(prFetcher, "merged-PR");
  const commitOutcome = await runFeed(commitFetcher, "merge-commit");
  const feed = {
    prs: { examined: prOutcome.examined, ...(prOutcome.failed ? { failed: prOutcome.failed } : {}) },
    commits: { examined: commitOutcome.examined, ...(commitOutcome.failed ? { failed: commitOutcome.failed } : {}) },
  };
  const feedsAvailable = !prOutcome.failed || !commitOutcome.failed;

  // Observability (issue #2057): a single-feed failure is WARN-logged (partial
  // coverage remains); a both-feeds-down failure is a critical alert pushed to
  // hydra:alerts so the operator is notified, not left to grep the journal.
  let alert: { code: string; message: string } | undefined;
  if (prOutcome.failed && commitOutcome.failed) {
    const message = `Both reconciler feeds unavailable — merge→done sweep is blind. PRs: ${prOutcome.failed}; commits: ${commitOutcome.failed}`;
    alert = { code: RECONCILER_BOTH_FEEDS_DOWN_ALERT, message };
    console.error(`[Backlog] reconcileMergedItems CRITICAL: ${message}`);
    try {
      await pushAlert(
        JSON.stringify({ type: RECONCILER_BOTH_FEEDS_DOWN_ALERT, ts: new Date().toISOString(), payload: { message } }),
        100,
      );
    } catch (err: any) {
      console.error(`[Backlog] reconcileMergedItems both-feeds-down alert publish failed: ${err.message}`);
    }
  } else if (prOutcome.failed) {
    console.warn(`[Backlog] reconcileMergedItems single-feed failure (merged-PR feed): ${prOutcome.failed}`);
  } else if (commitOutcome.failed) {
    console.warn(`[Backlog] reconcileMergedItems single-feed failure (merge-commit feed): ${commitOutcome.failed}`);
  }

  // Fail closed on the merged→done path: no feed information → never move
  // anything to done. The staleness escalation pass below is independent of the
  // feeds (it routes only to the safe `blocked` lane) and still runs.
  const refs: MergedRef[] = [...prOutcome.refs, ...commitOutcome.refs];
  if (refs.length === 0) {
    const esc = await escalateStaleItems(now, refs);
    return {
      reconciled,
      escalated: esc.escalated,
      scanned: esc.scanned,
      feedsAvailable,
      feed,
      metrics: { referencesFound: 0, movesFailed: 0, durationMs: Date.now() - startedAt },
      ...(alert ? { alert } : {}),
    };
  }

  for (const lane of RECONCILE_LANES) {
    let ids: string[];
    try {
      ids = await getBacklogLaneIds(lane);
    } catch (err: any) {
      // Unreadable board → stop sweeping; report what was done so far rather
      // than guessing at lane membership.
      console.error(`[Backlog] reconcileMergedItems could not read lane ${lane}: ${err.message}`);
      return {
        reconciled,
        escalated,
        scanned,
        feedsAvailable,
        feed,
        metrics: { referencesFound, movesFailed, durationMs: Date.now() - startedAt },
        ...(alert ? { alert } : {}),
      };
    }

    for (const id of ids) {
      try {
        const item = await getItem(id);
        if (!item) continue;
        scanned++;

        // Per-ref matching (rather than one big blob array) so the closure is
        // attributable: the FIRST matching ref is stamped as reconciledFrom.
        const match = refs.find((r) => itemMatchesOpenPr(item, [r.blob]));
        if (!match) continue;
        referencesFound++;

        await removeFromBacklogLane(lane, id);
        item.checked = true;
        item.meta = {
          ...item.meta,
          reconciledAt: new Date().toISOString(),
          reconciledFrom: match.ref,
          completedAt: new Date().toISOString().split("T")[0],
          outcome: "merged",
        };
        applyLaneTransition(item, "done");
        await saveItem(item);
        await addToBacklogLane("done", -Date.now(), id);

        console.warn(
          `[Backlog] Reconciled ${id} ("${(item.title || "").slice(0, 60)}") ${lane} → done — merged ${match.ref} references this item`,
        );

        try {
          await pushAlert(
            JSON.stringify({
              type: "merged-item-reconciled",
              ts: new Date().toISOString(),
              payload: {
                itemId: id,
                title: item.title,
                fromLane: lane,
                reconciledFrom: match.ref,
              },
            }),
            100,
          );
        } catch (err: any) {
          console.error(`[Backlog] reconcileMergedItems alert publish failed for ${id}: ${err.message}`);
        }

        reconciled.push({ id, title: item.title, fromLane: lane, ref: match.ref });
      } catch (err: any) {
        // The item matched a merged ref (referencesFound already counted it)
        // but the move failed mid-way — surface it in the batch metrics rather
        // than only the journal, so a recurring permissions/Redis fault is
        // visible on the status page.
        movesFailed++;
        console.error(`[Backlog] reconcileMergedItems failed on item ${id}: ${err.message}`);
      }
    }
  }

  // Staleness escalation runs AFTER the merged→done sweep so any item that had
  // a concrete merged ref has already left the lane — escalation only ever
  // considers the unconfirmable remainder. `refs` is threaded in so the
  // escalation pass can apply the subject fuzzy-match gate (issue #2110): an
  // item whose TITLE is covered by a merged blob shipped under a renamed/sibling
  // title and reconciles to done instead of escalating.
  const esc = await escalateStaleItems(now, refs);
  scanned += esc.scanned;

  // A subject-matched item is reconciled to done from inside the escalation
  // pass; surface those closures in the top-level `reconciled` array so the
  // caller / status page sees one unified merged→done list.
  for (const r of esc.reconciled) reconciled.push(r);
  // Subject-matched closures are successful merged→done reconciliations, so they
  // must count toward `referencesFound` to preserve the #2057 invariant
  // (`reconciled.length === referencesFound - movesFailed`); the escalation pass
  // only returns items it actually moved to done, so none of these are failures.
  referencesFound += esc.reconciled.length;

  return {
    reconciled,
    escalated: esc.escalated,
    scanned,
    feedsAvailable,
    feed,
    metrics: { referencesFound, movesFailed, durationMs: Date.now() - startedAt },
    ...(alert ? { alert } : {}),
  };
}
