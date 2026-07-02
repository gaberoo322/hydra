/**
 * Stale-claim escalation POLICY (issue #2678), extracted from the Redis
 * coordinator in `src/backlog/stale-escalation.ts`.
 *
 * This module owns the *pure* escalation decision: the age computation
 * (`itemAgeMs`) and the escalation predicate (`staleEscalationVerdict`), plus
 * their tunable constants (`STALE_ESCALATE_AFTER_MS`, `RETIRED_CLAIMANTS`).
 * All three are pure — they take plain item structs and a clock, and return
 * numbers / booleans / strings. Zero Redis, zero I/O, zero network, zero event
 * bus. Importing this module never opens a connection.
 *
 * It mirrors the `src/holdback.ts → src/outcome-regression.ts` split (issue
 * #2507): the pure policy leaf sits beside the Redis-touching coordinator, one
 * unidirectional edge (`stale-escalation.ts` imports the policy from here, never
 * the reverse). The coordinator half — `escalateStaleItems`, which reads lane
 * ids, loads/saves items, transitions lanes, and publishes alerts — stays in
 * `stale-escalation.ts` and delegates the *decision* to `staleEscalationVerdict`
 * here, then applies the Redis side-effects.
 *
 * Per CLAUDE.md conventions: the pure helpers never throw and never move an item
 * on uncertainty — an unageable item (no parseable timestamp) with a non-retired
 * claimant returns `escalate: false` (fail-open), and staleness NEVER yields a
 * "move to done" verdict (staleness is not proof of shipment — the central
 * design-concept invariant carried over from #2031).
 */

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
export const STALE_ESCALATE_AFTER_MS =
  parseInt(process.env.HYDRA_RECONCILE_STALE_ESCALATE_MS) || 14 * 24 * 60 * 60 * 1000;
export const RETIRED_CLAIMANTS: string[] = (process.env.HYDRA_RETIRED_CLAIMANTS ?? "codex")
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
