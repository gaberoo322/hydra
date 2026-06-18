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

// `MergedRef` moved to `target-pr-feed.ts` (issue #2084); re-export it for
// back-compat so unrelated import sites that referenced `reconciler.MergedRef`
// do not churn.
export type { MergedRef };

/**
 * Lanes the reconciler sweeps. `blocked` is deliberately EXCLUDED (design-concept
 * invariant 3): it is an operator-attention lane — a blocked item with a merged
 * PR still needs its blocker resolved by a human/agent decision, never a silent
 * auto-done. The blocked-item re-escalation chore surfaces merged-but-blocked
 * items instead. `done` is excluded for idempotency.
 */
const RECONCILE_LANES = ["inProgress", "queued", "backlog"] as const;

/**
 * Stale-claim escalation tunables (issue #2031).
 *
 * `STALE_ESCALATE_AFTER_MS` — an item in a reconcilable lane older than this
 * (by `movedAt`, falling back to `claimedAt` / `meta.addedAt`) is a strong
 * probably-shipped-or-obsolete signal the merged-token scan cannot confirm.
 * Generous by design (14d) so genuinely-pending work is not escalated: this is
 * a last-resort "no one has touched this in two weeks" sweep, not a churn knob.
 *
 * `RETIRED_CLAIMANTS` — claimants whose existence on an item is itself a
 * staleness signal regardless of age. `codex` is retired (ADR-0006); an item
 * still `claimedBy: codex` is from a pre-removal cycle and was either shipped
 * out-of-band or abandoned. Comma-separated, lower-cased, env-overridable.
 */
const STALE_ESCALATE_AFTER_MS =
  parseInt(process.env.HYDRA_RECONCILE_STALE_ESCALATE_MS) || 14 * 24 * 60 * 60 * 1000;
const RETIRED_CLAIMANTS: string[] = (process.env.HYDRA_RETIRED_CLAIMANTS ?? "codex")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/**
 * Best-effort age (ms) of an item, oldest-known timestamp first. Reads the same
 * fields the candidate-eligibility / index-reconciler age logic does:
 * `movedAt` (every lane transition), then `claimedAt`, then `meta.addedAt`.
 * Returns `null` when no parseable timestamp exists — an item we cannot age is
 * NEVER escalated (fail-open).
 *
 * Exported for tests so the staleness predicate can be exercised without Redis.
 */
export function itemAgeMs(
  item: { movedAt?: unknown; claimedAt?: unknown; meta?: { addedAt?: unknown } },
  now: number = Date.now(),
): number | null {
  const candidates = [item?.movedAt, item?.claimedAt, item?.meta?.addedAt];
  for (const c of candidates) {
    if (typeof c !== "string" || !c) continue;
    const t = new Date(c).getTime();
    if (Number.isFinite(t)) return now - t;
  }
  return null;
}

/**
 * Decide whether an item is an UNCONFIRMABLE-but-probably-shipped staleness
 * escalation candidate (issue #2031). True when EITHER:
 *   - it is claimed by a retired claimant (e.g. `codex`, ADR-0006) — a
 *     pre-removal-cycle artifact, regardless of age; OR
 *   - it is older than `STALE_ESCALATE_AFTER_MS` (default 14d).
 *
 * Returns `{ escalate, reason }` so the caller can stamp an
 * operator-actionable `blockedReason`. `escalate: false` ⇒ leave the item
 * exactly where it is. NEVER returns a "move to done" verdict — staleness is
 * not proof of shipment (design-concept invariant).
 *
 * Exported for tests.
 */
export function staleEscalationVerdict(
  item: { claimedBy?: unknown; movedAt?: unknown; claimedAt?: unknown; meta?: { addedAt?: unknown } },
  now: number = Date.now(),
): { escalate: boolean; reason: string } {
  const claimedBy = typeof item?.claimedBy === "string" ? item.claimedBy.trim() : "";
  if (claimedBy && RETIRED_CLAIMANTS.includes(claimedBy.toLowerCase())) {
    return {
      escalate: true,
      reason:
        `unconfirmable-shipped: claimed by retired claimant "${claimedBy}" with no matching merged PR/commit ` +
        `(probably shipped out-of-band or abandoned) — operator: confirm shipped → done, else requeue`,
    };
  }
  const ageMs = itemAgeMs(item, now);
  if (ageMs !== null && ageMs > STALE_ESCALATE_AFTER_MS) {
    const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
    return {
      escalate: true,
      reason:
        `unconfirmable-shipped: no activity for ${days}d (> ${Math.round(STALE_ESCALATE_AFTER_MS / (24 * 60 * 60 * 1000))}d) ` +
        `and no matching merged PR/commit — operator: confirm shipped → done, else requeue`,
    };
  }
  return { escalate: false, reason: "" };
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
}> {
  const reconciled: Array<{ id: string; title: string; fromLane: string; ref: string }> = [];
  const escalated: Array<{ id: string; title: string; fromLane: string; reason: string }> = [];
  let scanned = 0;
  const now = opts.now ?? Date.now();

  const prFetcher = opts.fetchMergedPrRefs ?? fetchMergedTargetPrRefs;
  const commitFetcher = opts.fetchMergeCommitRefs ?? fetchTargetMergeCommitRefs;
  const prRefs = await prFetcher();
  const commitRefs = await commitFetcher();
  const feedsAvailable = prRefs !== null || commitRefs !== null;

  // Fail closed on the merged→done path: no feed information → never move
  // anything to done. The staleness escalation pass below is independent of the
  // feeds (it routes only to the safe `blocked` lane) and still runs.
  const refs: MergedRef[] = [...(prRefs ?? []), ...(commitRefs ?? [])];
  if (refs.length === 0) {
    const esc = await escalateStaleItems(now);
    return { reconciled, escalated: esc.escalated, scanned: esc.scanned, feedsAvailable };
  }

  for (const lane of RECONCILE_LANES) {
    let ids: string[];
    try {
      ids = await getBacklogLaneIds(lane);
    } catch (err: any) {
      // Unreadable board → stop sweeping; report what was done so far rather
      // than guessing at lane membership.
      console.error(`[Backlog] reconcileMergedItems could not read lane ${lane}: ${err.message}`);
      return { reconciled, escalated, scanned, feedsAvailable };
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
        console.error(`[Backlog] reconcileMergedItems failed on item ${id}: ${err.message}`);
      }
    }
  }

  // Staleness escalation runs AFTER the merged→done sweep so any item that had
  // a concrete merged ref has already left the lane — escalation only ever
  // considers the unconfirmable remainder.
  const esc = await escalateStaleItems(now);
  scanned += esc.scanned;

  return { reconciled, escalated: esc.escalated, scanned, feedsAvailable };
}

/**
 * Stale-claim escalation pass (issue #2031). Sweeps the same reconcilable lanes
 * (`inProgress`/`queued`/`backlog` — never `blocked`/`done`) and moves any item
 * that `staleEscalationVerdict` flags as unconfirmable-but-probably-shipped to
 * the `blocked` lane with an operator-actionable `meta.blockedReason`. NEVER
 * moves anything to `done` — staleness is not proof of shipment.
 *
 * Mirrors the merged sweep's posture exactly:
 *   - Fail-open: an unreadable lane stops the sweep with what was done so far;
 *     an unageable item (no parseable timestamp) and a non-retired claimant are
 *     simply skipped. Uncertainty never moves an item.
 *   - Never throws — per-item failures are logged and skipped.
 *   - Idempotent: `blocked` is not a swept lane, so a re-run finds nothing new.
 *   - Auditable: each escalation emits a `stale-item-escalated` alert.
 *
 * Separated from the merged loop (rather than inlined) so the merged→done path
 * keeps its fail-closed-on-outage contract while escalation runs unconditionally
 * on local age/claimant data.
 */
async function escalateStaleItems(now: number): Promise<{
  escalated: Array<{ id: string; title: string; fromLane: string; reason: string }>;
  scanned: number;
}> {
  const escalated: Array<{ id: string; title: string; fromLane: string; reason: string }> = [];
  let scanned = 0;

  for (const lane of RECONCILE_LANES) {
    let ids: string[];
    try {
      ids = await getBacklogLaneIds(lane);
    } catch (err: any) {
      console.error(`[Backlog] escalateStaleItems could not read lane ${lane}: ${err.message}`);
      return { escalated, scanned };
    }

    for (const id of ids) {
      try {
        const item = await getItem(id);
        if (!item) continue;
        scanned++;

        const verdict = staleEscalationVerdict(item, now);
        if (!verdict.escalate) continue;

        await removeFromBacklogLane(lane, id);
        item.meta = {
          ...item.meta,
          blockedAt: new Date().toISOString().split("T")[0],
          blockedReason: verdict.reason,
          staleEscalatedAt: new Date().toISOString(),
          staleEscalatedFrom: lane,
        };
        applyLaneTransition(item, "blocked");
        await saveItem(item);
        await addToBacklogLane("blocked", Date.now(), id);

        console.warn(
          `[Backlog] Escalated stale item ${id} ("${(item.title || "").slice(0, 60)}") ${lane} → blocked — ${verdict.reason}`,
        );

        try {
          await pushAlert(
            JSON.stringify({
              type: "stale-item-escalated",
              ts: new Date().toISOString(),
              payload: {
                itemId: id,
                title: item.title,
                fromLane: lane,
                blockedReason: verdict.reason,
              },
            }),
            100,
          );
        } catch (err: any) {
          console.error(`[Backlog] escalateStaleItems alert publish failed for ${id}: ${err.message}`);
        }

        escalated.push({ id, title: item.title, fromLane: lane, reason: verdict.reason });
      } catch (err: any) {
        console.error(`[Backlog] escalateStaleItems failed on item ${id}: ${err.message}`);
      }
    }
  }

  return { escalated, scanned };
}
