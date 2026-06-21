/**
 * Atomic queued-lane claim — Lua script ensures two concurrent consumers
 * either claim different items or one gets a `wip-limit` / `empty` signal.
 */

import { claimNextQueuedBacklogItem, addToBacklogLane, removeFromBacklogLane } from "../redis/backlog.ts";
import { WIP_LIMIT, applyLaneTransition, saveItem } from "./internal.ts";
import {
  isMergedWork,
  loadMergedAnchorRefsImpl,
  type MergedAnchorRefsLoader,
} from "./merged-refs.ts";
// PR-deliverability gate (issue #2282) — pure predicate, no I/O. The atomic
// claim mirrors the candidate feed: an anchor that is host-systemd-only /
// operator-gated / live-data is deliverable by no code-writing dispatch, so a
// pop-head claim skips it (reconciling it OUT of the queue) and a targeted claim
// returns `not-pr-deliverable` rather than handing the session a guaranteed
// no-op.
import { requiresNonPrDispatch } from "./candidate-eligibility.ts";

/**
 * Injectable dependencies for `claimNextQueuedItem`.
 *
 * `loadMergedAnchorRefs` is the merged-anchor-refs seam (issue #1969): the
 * production default is `loadMergedAnchorRefsImpl` (TTL-cached `gh pr list`
 * scan), but tests can substitute a sync-returning stub so they don't fork a
 * real `gh` process. Matches the injectable-deps pattern already used in
 * `getCandidateFeed` / `reconcileWorkQueue`.
 *
 * `maxShippedSkips` caps the retry loop that discards already-shipped queue
 * items before returning `empty`. Default 5 is generous enough to drain a
 * fully-stale burst while keeping the hot path O(1) for healthy queues.
 */
export interface ClaimDeps {
  loadMergedAnchorRefs?: MergedAnchorRefsLoader;
  maxShippedSkips?: number;
}

/** How many stale-shipped items the claim loop will skip before giving up. */
const DEFAULT_MAX_SHIPPED_SKIPS = 5;

const LUA_CLAIM_NEXT_QUEUED = `
-- KEYS[1] = hydra:backlog:lane:queued
-- KEYS[2] = hydra:backlog:items
-- KEYS[3] = hydra:backlog:lane:inProgress
-- ARGV[1] = timestamp score for inProgress
-- ARGV[2] = WIP limit
-- ARGV[3] = targeted item id, or '' for pop-head (issue #1682)

-- Check WIP count. Runs BEFORE the branch: targeting selects WHICH queued
-- item is claimed — it never bypasses claim policy.
local wipCount = redis.call('ZCARD', KEYS[3])
if wipCount >= tonumber(ARGV[2]) then
  return cjson.encode({blocked = "wip-limit", count = wipCount})
end

local id
if ARGV[3] ~= '' then
  -- Targeted claim: ZREM doubles as the lane-membership check AND the atomic
  -- removal — 0 means the item is not in the queued lane right now. HEXISTS
  -- distinguishes "exists but in another lane" (not-queued) from "no such
  -- item" (not-found).
  local removed = redis.call('ZREM', KEYS[1], ARGV[3])
  if removed == 0 then
    if redis.call('HEXISTS', KEYS[2], ARGV[3]) == 1 then
      return cjson.encode({blocked = "not-queued", id = ARGV[3]})
    end
    return cjson.encode({blocked = "not-found", id = ARGV[3]})
  end
  id = ARGV[3]
else
  -- Pop-head: peek first queued item (sorted set is ordered by score =
  -- priority/timestamp).
  local ids = redis.call('ZRANGE', KEYS[1], 0, 0)
  if #ids == 0 then
    return cjson.encode({blocked = "empty"})
  end

  -- Atomic remove from queued — if another consumer beat us, ZREM returns 0
  local removed = redis.call('ZREM', KEYS[1], ids[1])
  if removed == 0 then
    return cjson.encode({blocked = "race"})
  end
  id = ids[1]
end

-- Add to inProgress
redis.call('ZADD', KEYS[3], ARGV[1], id)

-- Return item data
local raw = redis.call('HGET', KEYS[2], id)
if not raw then
  return cjson.encode({blocked = "missing-data", id = id})
end
return raw
`;

/**
 * Atomically claim a queued item and move it to inProgress. Uses a Lua script
 * so no two concurrent consumers claim the same item.
 *
 * - `itemId` absent → claim the highest-priority queued item (pop-head, the
 *   pre-#1682 behavior, byte-compatible for existing callers).
 * - `itemId` present → claim exactly that item if it is in the queued lane;
 *   otherwise `{claimed:false, reason:"not-queued"|"not-found"}` (issue
 *   #1682 — the route maps these to 409/404).
 *
 * Both variants share the WIP check, race semantics, and the metadata-stamp +
 * persist tail below — no drift between targeted and pop-head claims.
 *
 * Issue #1969 — shipped-item filter: after a successful atomic claim, the item
 * is checked against the merged-anchor-refs seam (`MergedAnchorRefs`). If the
 * item is already merged/shipped, it is reconciled to `done` and the loop
 * retries the pop-head claim (up to `deps.maxShippedSkips` times). This
 * eliminates the guaranteed no-op dispatch that occurred when a stale
 * `claimedBy` row from a prior epoch surfaced at the top of the queue. Only
 * the pop-head variant retries; targeted claims (`itemId` present) return
 * `{claimed:false, reason:"already-shipped"}` immediately so callers can
 * give clear feedback rather than silently redirecting to another item.
 *
 * Issue #2282 — PR-deliverability filter: a claimed item flagged
 * host-systemd-only / operator-gated / live-data (`requiresNonPrDispatch`) is
 * deliverable by no code-writing dispatch, so it is routed OUT of the claim
 * hot-path — but the work is real (it belongs to the operator/deploy path), so
 * per the `issue-2282` design-concept invariant[1] it is RE-QUEUED to the
 * `queued` lane at a TAIL score rather than reconciled to `done` or moved to
 * `blocked`. A tail score sorts the item last, so it won't immediately re-pop
 * on the next claim, yet it stays claimable by the operator/deploy path that
 * CAN deliver it. (rejectedAlternatives[4] explicitly declined the blocked
 * lane: blocked moves carry operator semantics + a required reason; a
 * skip-and-requeue is lighter and reversible — no `blockedReason` is set.)
 * Pop-head retries the next queued item (sharing the `maxShippedSkips`
 * budget); a targeted claim returns `{claimed:false, reason:"not-pr-deliverable"}`.
 * This filter runs BEFORE the shipped-item check (a stale undeliverable anchor
 * never even reaches the `gh`-backed merged scan).
 */
export async function claimNextQueuedItem(
  claimedBy: string,
  itemId?: string,
  deps: ClaimDeps = {},
): Promise<{
  claimed: boolean;
  item?: any;
  reason?: string;
  count?: number;
}> {
  const loadMergedRefs = deps.loadMergedAnchorRefs ?? loadMergedAnchorRefsImpl;
  const maxSkips = deps.maxShippedSkips ?? DEFAULT_MAX_SHIPPED_SKIPS;

  // Fetch the merged-ref set ONCE per call so all retry iterations share the
  // same snapshot (avoids thundering `gh` round-trips on a stale queue).
  // Never throws — `loadMergedAnchorRefsImpl` degrades to empty on failure.
  let mergedRefs: ReadonlySet<string>;
  try {
    mergedRefs = await loadMergedRefs();
  } catch {
    /* intentional: merged-refs load failure degrades to an empty suppression set */
    mergedRefs = new Set<string>();
  }

  // Pop-head retry loop (issue #1969): when the claimed item is already
  // shipped, reconcile it to `done` and retry. Capped at `maxSkips` to
  // guard against a fully-stale queue consuming unbounded WIP slots.
  let shippedSkipped = 0;
  while (true) {
    const result = await claimNextQueuedBacklogItem(LUA_CLAIM_NEXT_QUEUED, Date.now(), WIP_LIMIT, itemId);

    if (!result) return { claimed: false, reason: "no-result" };

    // Parse the Lua return value first. A failure here is a corrupt Redis write
    // (poisoned `hydra:backlog:items` entry) — distinct from the legitimate
    // `blocked` paths below — and MUST surface loudly rather than stall the queue
    // invisibly (CLAUDE.md fail-loud; issue #1122). The result-object contract is
    // preserved (we never throw from the claim path).
    let parsed: any;
    try {
      parsed = JSON.parse(result);
    } catch (err) {
      console.error(
        `[backlog/claim] corrupt queue item — JSON.parse failed (claimedBy=${claimedBy}). ` +
          `The item was already removed from the queued lane by the Lua claim and is now orphaned. ` +
          `Raw value: ${truncate(result)}`,
        err,
      );
      return { claimed: false, reason: "parse-error" };
    }

    if (parsed.blocked) {
      return { claimed: false, reason: parsed.blocked, count: parsed.count };
    }

    // Issue #2282 — PR-deliverability filter. An anchor that is host-systemd-
    // only / operator-gated / live-data is deliverable by NO code-writing
    // dispatch; serving it burns a guaranteed ground+analyse+release cycle. The
    // pure `requiresNonPrDispatch` predicate reads declarative flags off the
    // item (no I/O). Unlike the shipped-item filter below, the work is NOT done
    // — it belongs to the operator/deploy path — so per the design-concept
    // invariant[1] the item is RE-QUEUED to the `queued` lane at a TAIL score
    // (sorts last, won't re-pop on the very next claim) rather than reconciled
    // to `done` or moved to `blocked`. It stays claimable by the operator/
    // deploy path that CAN deliver it, with no `blockedReason` stamped
    // (rejectedAlternatives[4]: skip-and-requeue is lighter + reversible than a
    // blocked move, which carries operator semantics and a required reason).
    //   - Targeted claim: return `not-pr-deliverable` (no silent redirect).
    //   - Pop-head: re-queue at tail + retry the next queued item (capped by the
    //     same maxShippedSkips budget so a fully-undeliverable queue terminates).
    if (requiresNonPrDispatch(parsed)) {
      try {
        await removeFromBacklogLane("inProgress", parsed.id);
        applyLaneTransition(parsed, "queued", { claimedBy: null });
        await saveItem(parsed);
        // Tail score: the queued lane sorts ASCENDING (the Lua pop-head reads
        // `ZRANGE 0 0` = lowest score), and normal queued items score at
        // `Date.now()`. Doubling guarantees this re-queued item outranks every
        // normal timestamp so it sorts LAST, while still ordering successive
        // skips relative to each other (a later skip lands after an earlier one).
        const tailScore = Date.now() * 2;
        await addToBacklogLane("queued", tailScore, parsed.id);
        console.error(
          `[backlog/claim] not-pr-deliverable-skip: item ${parsed.id} ("${truncate(parsed.title ?? "", 60)}") ` +
            `is host-systemd / operator-gated / live-data — re-queued at tail for the operator/deploy path ` +
            `(claimedBy=${claimedBy}, skip=${shippedSkipped + 1}/${maxSkips})`,
        );
      } catch (err) {
        console.error(
          `[backlog/claim] not-pr-deliverable-skip: failed to re-queue item ${parsed.id} to queued — leaving in inProgress`,
          err,
        );
      }

      // Targeted claim: don't silently redirect to a different item.
      if (itemId !== undefined) {
        return { claimed: false, reason: "not-pr-deliverable" };
      }

      // Pop-head: retry, but only up to maxSkips times to avoid infinite loops.
      shippedSkipped++;
      if (shippedSkipped >= maxSkips) {
        console.error(
          `[backlog/claim] not-pr-deliverable-skip: hit maxShippedSkips (${maxSkips}) — returning empty (claimedBy=${claimedBy})`,
        );
        return { claimed: false, reason: "empty" };
      }
      continue;
    }

    // Issue #1969 — shipped-item filter. Check whether the item's identity
    // tokens match a recently-merged PR. We call `candidateMergedTokens` with
    // the same mapping `anchor-candidates.ts` uses (`issue: item.id`, title
    // twice). If it matches, skip the item:
    //   - Targeted claim: return `already-shipped` so the caller gets a clear
    //     diagnostic (no silent redirect to a different item).
    //   - Pop-head: reconcile to `done` and retry from the top of the loop
    //     (the Lua script will pop the next queued item on the next iteration).
    if (
      mergedRefs.size > 0 &&
      isMergedWork(
        { issue: String(parsed.id ?? ""), title: parsed.title ?? "", anchorRef: parsed.title ?? "" },
        mergedRefs,
      )
    ) {
      // Reconcile the already-shipped item to `done` so it stays off the queue
      // permanently. The Lua script has already atomically moved it from
      // `queued` → `inProgress`; we complete the transition here.
      try {
        await removeFromBacklogLane("inProgress", parsed.id);
        applyLaneTransition(parsed, "done", { claimedBy: null });
        await saveItem(parsed);
        const doneScore = -Date.now();
        await addToBacklogLane("done", doneScore, parsed.id);
        console.error(
          `[backlog/claim] shipped-item-skip: item ${parsed.id} ("${truncate(parsed.title ?? "", 60)}") ` +
            `already merged — reconciled to done (claimedBy=${claimedBy}, skip=${shippedSkipped + 1}/${maxSkips})`,
        );
      } catch (err) {
        console.error(
          `[backlog/claim] shipped-item-skip: failed to reconcile item ${parsed.id} to done — leaving in inProgress`,
          err,
        );
      }

      // Targeted claim: don't silently redirect to a different item.
      if (itemId !== undefined) {
        return { claimed: false, reason: "already-shipped" };
      }

      // Pop-head: retry, but only up to maxSkips times to avoid infinite loops.
      shippedSkipped++;
      if (shippedSkipped >= maxSkips) {
        console.error(
          `[backlog/claim] shipped-item-skip: hit maxShippedSkips (${maxSkips}) — returning empty (claimedBy=${claimedBy})`,
        );
        return { claimed: false, reason: "empty" };
      }
      continue;
    }

    // Raw item JSON — stamp lane metadata and persist. A failure persisting the
    // claimed item is distinct from a parse failure: the item parsed fine but the
    // write-back (e.g. a Redis seam error) failed. Log it and return a result
    // object — the claim path never throws (issue #1122 implementation note).
    try {
      parsed.meta = {
        ...parsed.meta,
        startedAt: new Date().toISOString().split("T")[0],
        claimedBy,
      };
      applyLaneTransition(parsed, "inProgress", { claimedBy });
      await saveItem(parsed);
      return { claimed: true, item: parsed };
    } catch (err) {
      console.error(
        `[backlog/claim] failed to persist claimed item (claimedBy=${claimedBy}, id=${parsed?.id}). ` +
          `The Lua claim already moved it into the inProgress lane, so it is now in inProgress without ` +
          `refreshed claim metadata.`,
        err,
      );
      return { claimed: false, reason: "save-error" };
    }
  }
}

/** Bound the raw-value context so an oversized corrupt blob can't flood the log. */
function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars total)` : s;
}
