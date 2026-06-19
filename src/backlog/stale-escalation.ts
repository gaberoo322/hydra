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
import { RECONCILE_LANES } from "./reconciler.ts";

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
