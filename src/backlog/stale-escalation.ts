/**
 * Stale-claim escalation pass (issue #2031), extracted from the merge→done
 * reconciler (issue #2138) into its own Module.
 *
 * The merged-ref scan in `reconciler.ts` only closes items whose id/title
 * appears in a recently-merged PR or merge-commit token. Items shipped
 * OUT-OF-BAND — by a different cycle, before a priority shift, or by a
 * now-retired claimant (e.g. `claimedBy: codex`) that never referenced the item
 * id — carry NO matching token, so the merged scan keeps them and the claim
 * path later re-serves shipped work (the `stale-backlog-claim-returns-shipped-
 * item` friction, escalated after 3 hits). This pass catches these by a
 * STALENESS / RETIRED-CLAIMANT signal and routes them to `blocked`
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
 * `escalateStaleItems` checks whether any merged blob's subject COVERS the item
 * title via an ASYMMETRIC containment helper (`subjectCoveredBy`,
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
import { subjectCoveredBy } from "./merged-refs.ts";
import { type MergedRef } from "./target-pr-feed.ts";
import { RECONCILE_LANES } from "./reconcile-constants.ts";
import { staleEscalationVerdict } from "./stale-escalation-policy.ts";

// The pure escalation POLICY — the age computation (`itemAgeMs`), the verdict
// predicate (`staleEscalationVerdict`), and their tunables
// (`STALE_ESCALATE_AFTER_MS`, `RETIRED_CLAIMANTS`) — lives in the zero-I/O
// sibling `stale-escalation-policy.ts` (issue #2678), mirroring the
// `holdback.ts → outcome-regression.ts` split. `escalateStaleItems` below is the
// Redis-touching coordinator: it delegates the *decision* to the policy leaf,
// then applies the lane transitions / alerts. The policy predicates (`itemAgeMs`,
// `staleEscalationVerdict`) are re-exported here for back-compat so existing
// callers/tests importing them from this path keep working; the bare tunables
// (`STALE_ESCALATE_AFTER_MS`, `RETIRED_CLAIMANTS`) are policy internals — import
// them from `stale-escalation-policy.ts` directly if ever needed.
export {
  itemAgeMs,
  staleEscalationVerdict,
} from "./stale-escalation-policy.ts";

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
 *
 * Subject fuzzy-match gate (issue #2110). `refs` is the same merged-ref set the
 * merged→done sweep used. Before escalating a stale item, we check whether any
 * merged blob's subject COVERS the item title (asymmetric `subjectCoveredBy`).
 * A renamed/sibling-id shipment carries no `item-NNN` token (so the token scan
 * missed it) but its title words are still covered by the merged subject — that
 * is a concrete merged ref, so the item reconciles to `done` (with a
 * `reconciledFrom` audit stamp) instead of escalating to `blocked`. The gate
 * ONLY suppresses a would-be escalation: a near-miss (coverage below threshold)
 * still escalates, and an item with neither a token nor a subject match still
 * escalates (no regression to the genuine-stale path — item-502 surfaces). When
 * `refs` is empty (feeds down/quiet) the gate is a no-op, preserving the
 * feeds-down fail-closed contract.
 */
export async function escalateStaleItems(now: number, refs: MergedRef[] = []): Promise<{
  escalated: Array<{ id: string; title: string; fromLane: string; reason: string }>;
  reconciled: Array<{ id: string; title: string; fromLane: string; ref: string }>;
  scanned: number;
}> {
  const escalated: Array<{ id: string; title: string; fromLane: string; reason: string }> = [];
  const reconciled: Array<{ id: string; title: string; fromLane: string; ref: string }> = [];
  let scanned = 0;

  for (const lane of RECONCILE_LANES) {
    let ids: string[];
    try {
      ids = await getBacklogLaneIds(lane);
    } catch (err: any) {
      console.error(`[Backlog] escalateStaleItems could not read lane ${lane}: ${err.message}`);
      return { escalated, reconciled, scanned };
    }

    for (const id of ids) {
      try {
        const item = await getItem(id);
        if (!item) continue;
        scanned++;

        const verdict = staleEscalationVerdict(item, now);
        if (!verdict.escalate) continue;

        // Subject fuzzy-match gate (issue #2110): before escalating, see if a
        // merged blob's subject covers this item's title — i.e. the work
        // shipped under a renamed/sibling title with no matching item-NNN token.
        // A hit is a concrete merged ref, so reconcile to done instead.
        const title = typeof item.title === "string" ? item.title : "";
        const subjectMatch = refs.find((r) => subjectCoveredBy(title, r.blob));
        if (subjectMatch) {
          await removeFromBacklogLane(lane, id);
          item.checked = true;
          item.meta = {
            ...item.meta,
            reconciledAt: new Date().toISOString(),
            reconciledFrom: subjectMatch.ref,
            reconciledBy: "subject-match",
            completedAt: new Date().toISOString().split("T")[0],
            outcome: "merged",
          };
          applyLaneTransition(item, "done");
          await saveItem(item);
          await addToBacklogLane("done", -Date.now(), id);

          console.warn(
            `[Backlog] Reconciled ${id} ("${title.slice(0, 60)}") ${lane} → done — merged ${subjectMatch.ref} subject-matches this item's title (issue #2110)`,
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
                  reconciledFrom: subjectMatch.ref,
                  reconciledBy: "subject-match",
                },
              }),
              100,
            );
          } catch (err: any) {
            console.error(`[Backlog] escalateStaleItems subject-match alert publish failed for ${id}: ${err.message}`);
          }

          reconciled.push({ id, title: item.title, fromLane: lane, ref: subjectMatch.ref });
          continue;
        }

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

  return { escalated, reconciled, scanned };
}
