/**
 * Retro-dispatch **bucket-classification** leaf (issue #3090) — the pure logic
 * that characterizes an *individual* dispatch's outcome. Split out of the
 * combined `retro-projections.ts` (issue #1952) so the "given dispatch records,
 * return bucketed + drill-flagged rows" concern lives apart from the cross-run
 * cycle-id dedup math (now in `retro-cycle-identity.ts`).
 *
 * This leaf owns:
 *   - `projectDispatches` — project the run's turn timeline into the flat
 *     per-dispatch list (cross-turn / cross-slot identity dedup, #1776/#1352)
 *   - `flagDispatchesForDrill` — pure drill-flag selector
 *   - `bucketOf` — the `status → bucket` derivation (wraps `bucketCycleStatus`)
 *   - the five module-private slot helpers (`prNumberFromAnchor` /
 *     `slotOfAction` / `slotStr` / `slotEpoch` / `enrichFromSlot`) — each called
 *     ONLY inside `projectDispatches`, so they stay unexported here.
 *
 * The shared `RetroDispatch` type is imported DOWN from the zero-IO leaf
 * `retro-dispatch-types.ts` — never sideways from the cycle-identity peer.
 *
 * Everything here is pure: zero Redis imports, zero `await`, no clock beyond
 * caller-supplied input.
 */

import { bucketCycleStatus } from "./cycle-status.ts";
import type { RetroDispatch } from "./retro-dispatch-types.ts";

// ---------------------------------------------------------------------------
// Drill-flag selector (pure)
// ---------------------------------------------------------------------------

/**
 * Pure selector — names the subset of dispatches whose full transcript a
 * downstream consumer should deep-read. A dispatch is flagged when it shows a
 * failure/stall/churn/error signal:
 *
 *   - `bucket === "failed"` — abandoned / aborted / timed-out / PR closed
 *     unmerged (the QA-fail and stall outcomes)
 *   - `regressionIntroduced` — merged but auto-reverted on regression (churn)
 *   - it carries an `abandonReason` — an explicit error/abort the cycle filed
 *
 * A merged, regression-free dispatch is NOT flagged — the happy path needs no
 * transcript drill. Pending dispatches (`status === null`) are not flagged:
 * nothing went wrong *yet*. Returns the flagged subset in input order so the
 * selection is deterministic.
 *
 * UNDRILLABLE EXCLUSION (issue #1184): a dispatch with an empty `cycleId` has no
 * transcript handle — the metrics/transcript enrichment loop skips it
 * (`if (!d.cycleId) continue;`), so flagging it produces a flag with nothing to
 * drill. Such a dispatch (the interrupted-run slots-snapshot-fallback case that
 * the #1168 backfill stamps with `run-interrupted`) is recorded
 * {@link RetroDispatch.undrillable} = true and EXCLUDED here, enforcing the
 * invariant `flagged === true` ⟹ `cycleId !== ""`. Visibility from #1168 is
 * preserved (the abandonReason stays on the dispatch); only the empty flag is
 * dropped.
 */
export function flagDispatchesForDrill(dispatches: RetroDispatch[]): RetroDispatch[] {
  return dispatches.filter(
    (d) =>
      d.cycleId !== "" &&
      (d.bucket === "failed" ||
        d.regressionIntroduced === true ||
        (typeof d.abandonReason === "string" && d.abandonReason.length > 0)),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers (pure)
// ---------------------------------------------------------------------------

export function bucketOf(status: string | null): "merged" | "failed" | null {
  return bucketCycleStatus(status);
}

/**
 * Extract a bare PR number from an anchor string. The slot snapshot's `anchor`
 * carries the dispatched reference verbatim (e.g. a `qa_orch` slot reads
 * `PR#970`, a `dev_orch` slot reads `#961`); a PR-shaped anchor yields the
 * digits for `prNumber`, an issue-shaped one yields `null` (its number is the
 * issue ref, not a PR). Returns `null` when no PR-shaped token is present.
 * Used only as a slots_snapshot fallback — an action/outcome `prNumber`
 * always wins.
 */
function prNumberFromAnchor(anchor: string | null): string | null {
  if (!anchor) return null;
  // Only PR-shaped anchors carry a PR number: `PR#970` / `pr#970` / `PR970`.
  const m = /\bpr\s*#?\s*(\d+)\b/i.exec(anchor);
  return m ? m[1] : null;
}

/** Read the dispatched slot key off a dispatch action, when it carries one. */
function slotOfAction(a: any): string | null {
  return typeof a?.slot === "string" && a.slot.length > 0 ? a.slot : null;
}

/**
 * Read a string field off a slot-snapshot entry, tolerating non-object /
 * non-string members (a malformed slot map must never throw — it yields the
 * prior action-derived dispatch, per the never-throw / read-only invariant).
 */
function slotStr(slotObj: unknown, key: string): string | null {
  if (!slotObj || typeof slotObj !== "object") return null;
  const v = (slotObj as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Read the slot-snapshot entry's `started_epoch` as a string key component,
 * tolerating number and string encodings (the snapshot serialises it as a
 * number; a string round-trip must not break identity matching). `null` when
 * absent/malformed.
 */
function slotEpoch(slotObj: unknown): string | null {
  if (!slotObj || typeof slotObj !== "object") return null;
  const v = (slotObj as Record<string, unknown>)["started_epoch"];
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.length > 0) return v;
  return null;
}

/**
 * Fill a dispatch's null fields from a slot-snapshot entry. Existing values
 * always win (action-join / earliest-turn canonical row), so this is
 * enrich-only — used both for the same-turn `(turn, slot)` merge and for the
 * cross-turn identity merge (issue #1776).
 */
function enrichFromSlot(
  d: RetroDispatch,
  slotSkill: string | null,
  slotAnchor: string | null,
  slotTaskId: string | null,
): void {
  if (!d.skill && slotSkill) d.skill = slotSkill;
  if (!d.anchorReference && slotAnchor) d.anchorReference = slotAnchor;
  if (!d.prNumber) {
    const pr = prNumberFromAnchor(slotAnchor);
    if (pr) d.prNumber = pr;
  }
  // Only fill a candidate cycleId when it is still empty — an action/outcome-
  // carried cycleId always wins (clean-run identity).
  if (!d.cycleId && slotTaskId) d.cycleId = slotTaskId;
}

// ---------------------------------------------------------------------------
// Dispatch projection (pure)
// ---------------------------------------------------------------------------

/**
 * Project the run's turn timeline into the flat per-dispatch list. Pulls the
 * dispatch identity (cycleId / skill / anchor) off each `type === "dispatch"`
 * action and the joined `outcome` (attached by `fetchTurnsWithJoins`), then
 * reconciles each turn's `slots_snapshot` (slot key → `{skill, anchor,
 * task_id, ...}`) as a FALLBACK that only fills fields the action left null.
 *
 * The real dispatch action carries the anchor nested under
 * `prompt_args.anchor` (not the top-level `anchorReference` the legacy join
 * read) and carries no `cycleId`, while the resolvable identity lives in
 * `slots_snapshot`; without this reconciliation `anchorReference` / `skill` /
 * `prNumber` came back null and `flagDispatchesForDrill` flagged nothing
 * (issue #975).
 *
 * Merge is keyed by `(turn, slot)`, NOT concatenated: a slot already
 * represented by an action enriches that RetroDispatch's null fields; a slot
 * present ONLY in `slots_snapshot` (the crashed-run case, where the dispatch
 * action was never recorded) becomes a NEW RetroDispatch. One real dispatch →
 * exactly one RetroDispatch, so a clean run with action-carried identity is
 * byte-identical (action values win, no double-count).
 *
 * CROSS-TURN dedup (issue #1776): the `(turn, slot)` merge alone duplicated a
 * dispatch that occupied its slot for N turns — the dispatching turn emitted
 * one row, and every later turn's `slots_snapshot` saw an occupied slot with
 * no same-turn action and emitted a NEW row (run 69442b4c: 16 rows for ~9
 * real dispatches). So the projection also keeps a cross-turn identity map
 * keyed on the durable dispatch identity — the slot's `task_id` / the
 * recorded `cycleId` (the same id, per #1352), with `slot@started_epoch` as a
 * fallback when no task_id is present. The EARLIEST-turn row is canonical: a
 * later turn's snapshot for an already-projected identity only enriches that
 * row's null fields (e.g. a later snapshot may carry a PR-shaped anchor) and
 * never emits a second row. A slot re-dispatched with a NEW identity (new
 * task_id / started_epoch) still projects a new row, and an identity-less
 * snapshot entry (neither task_id nor started_epoch) degrades to the
 * pre-#1776 per-turn behaviour — there is nothing durable to match on.
 *
 * A snapshot-only dispatch additionally seeds a CANDIDATE `cycleId` from the
 * slot's `task_id` (issue #1352) — the same id reap sends on its durable
 * `cycle-record` write, so it is the transcript handle for a dispatch that
 * genuinely completed before the run was interrupted. The candidate is
 * PROVISIONAL: `assembleRetroBundle` confirms a terminal cycle record
 * exists for it and resets it back to `""` (undrillable) if not. This
 * projection only recovers the candidate; it does not read Redis.
 *
 * Pure over the already-fetched turns — `slots_snapshot` is already on each
 * turn member, so there is no Redis round-trip here.
 */
export function projectDispatches(
  turns: Array<Record<string, unknown>>,
): RetroDispatch[] {
  const out: RetroDispatch[] = [];
  // Cross-turn identity map (issue #1776): durable-identity key → the
  // canonical (earliest-turn) RetroDispatch. Keys are namespaced so a task_id
  // can never collide with a slot@epoch composite:
  //   `id:<task_id|cycleId>`        — the durable dispatch identity
  //   `epoch:<slot>@<started_epoch>` — fallback when no task_id is present
  //                                    (same slot + same start instant is
  //                                    definitionally the same occupancy)
  const byIdentity = new Map<string, RetroDispatch>();
  /** Register first-wins — the earliest-turn row stays canonical. */
  const registerIdentity = (key: string | null, d: RetroDispatch): void => {
    if (key && !byIdentity.has(key)) byIdentity.set(key, d);
  };
  for (const turn of turns) {
    const turnN =
      typeof turn.turn_n === "number" && Number.isFinite(turn.turn_n)
        ? (turn.turn_n as number)
        : null;
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
    const slotsSnapshot =
      turn.slots_snapshot && typeof turn.slots_snapshot === "object"
        ? (turn.slots_snapshot as Record<string, unknown>)
        : {};

    // Track which slot keys an action already projected, so the slots_snapshot
    // fold enriches those in place rather than emitting a duplicate.
    const bySlot = new Map<string, RetroDispatch>();

    for (const a of actions) {
      if (!a || a.type !== "dispatch") continue;
      const outcome = a.outcome && typeof a.outcome === "object" ? a.outcome : null;
      const cycleId =
        (outcome && typeof outcome.cycleId === "string" && outcome.cycleId) ||
        (typeof a.cycleId === "string" && a.cycleId) ||
        (typeof a.autopilotTurnId === "string" && a.autopilotTurnId) ||
        "";
      const status =
        outcome && typeof outcome.status === "string" ? (outcome.status as string) : null;
      const prNumber =
        outcome && outcome.prNumber != null ? String(outcome.prNumber) : null;
      // Anchor priority: top-level anchorReference/anchor/issueRef (legacy join
      // shape) then the real action's nested prompt_args.anchor.
      const anchorReference =
        (typeof a.anchorReference === "string" && a.anchorReference) ||
        (typeof a.anchor === "string" && a.anchor) ||
        (typeof a.issueRef === "string" && a.issueRef) ||
        (a.prompt_args &&
          typeof a.prompt_args === "object" &&
          typeof (a.prompt_args as any).anchor === "string" &&
          (a.prompt_args as any).anchor) ||
        null;
      const dispatch: RetroDispatch = {
        cycleId,
        turn_n: turnN,
        skill: typeof a.skill === "string" ? a.skill : null,
        anchorReference,
        prNumber,
        status,
        bucket: bucketOf(status),
        // abandonReason / regression are enriched from the metrics sidecar
        // join in the assemble loop; default to the no-signal values here.
        abandonReason: null,
        regressionIntroduced: false,
        // flagged is materialised in the assemble loop after the crash
        // abandonReason backfill — projection cannot know the final signal yet.
        flagged: false,
        // undrillable is materialised in the assemble loop (issue #1184) — it
        // depends on the final cycleId, which the metrics-sidecar enrichment can
        // backfill. Default to drillable here.
        undrillable: false,
      };
      const slot = slotOfAction(a);
      // Cross-turn dedup (issue #1776): an identity already projected on an
      // earlier turn never emits a second row — the action only enriches the
      // canonical row's null fields. (In practice a dispatch action is
      // recorded once, on the dispatching turn; this guard is defensive.)
      const prior = cycleId ? byIdentity.get(`id:${cycleId}`) : undefined;
      if (prior) {
        if (!prior.skill && dispatch.skill) prior.skill = dispatch.skill;
        if (!prior.anchorReference && anchorReference) prior.anchorReference = anchorReference;
        if (!prior.prNumber && prNumber) prior.prNumber = prNumber;
        if (prior.status === null && status !== null) {
          prior.status = status;
          prior.bucket = bucketOf(status);
        }
        if (slot && !bySlot.has(slot)) bySlot.set(slot, prior);
        continue;
      }
      out.push(dispatch);
      if (slot && !bySlot.has(slot)) bySlot.set(slot, dispatch);
      registerIdentity(cycleId ? `id:${cycleId}` : null, dispatch);
    }

    // Fold the slots_snapshot in: enrich an action-derived dispatch's null
    // fields, or emit a new dispatch for a slot the actions never recorded
    // (the crashed-run case). Action-join wins when present, so this only fills
    // nulls — clean-run behaviour is byte-identical.
    for (const [slot, slotObj] of Object.entries(slotsSnapshot)) {
      if (slotObj == null) continue; // empty slot — nothing dispatched here.
      const slotSkill = slotStr(slotObj, "skill");
      const slotAnchor = slotStr(slotObj, "anchor");
      // The slot carries the dispatch's `task_id` — the SAME id `reap.py` sends
      // as the `cycleId` on its durable `cycle-record` write (issue #1352). It
      // is a *candidate* transcript handle, not yet a confirmed one: a slot
      // still occupied when the session was interrupted has a task_id but no
      // terminal cycle record. The assemble loop confirms it by reading the
      // cycle metrics/hash and DROPS it back to "" if no terminal record
      // exists, so an in-flight slot stays undrillable. See
      // `confirmDrillableCycleIds` (the named confirm-or-drop stage of the
      // provisional→confirmed protocol, in `retro-cycle-identity.ts`) called by
      // assembleRetroBundle after its enrichment loop.
      const slotTaskId = slotStr(slotObj, "task_id");
      const epoch = slotEpoch(slotObj);
      const epochKey = epoch ? `epoch:${slot}@${epoch}` : null;
      const existing = bySlot.get(slot);
      if (existing) {
        // Same-turn (turn, slot) merge: enrich the action-derived row's null
        // fields — action values win. Then register the row's durable identity
        // so later turns' snapshots of the SAME occupancy dedup onto it
        // (issue #1776), even when the action's cycleId and the slot's task_id
        // diverge (the epoch key covers that).
        enrichFromSlot(existing, slotSkill, slotAnchor, slotTaskId);
        registerIdentity(slotTaskId ? `id:${slotTaskId}` : null, existing);
        registerIdentity(existing.cycleId ? `id:${existing.cycleId}` : null, existing);
        registerIdentity(epochKey, existing);
        continue;
      }
      // Cross-turn dedup (issue #1776): this slot has no same-turn action, but
      // the SAME dispatch (same task_id, or same slot+started_epoch) may have
      // been projected on an earlier turn — a dispatch occupying its slot for
      // N turns appears in N snapshots. Enrich the canonical earliest-turn row
      // instead of emitting a duplicate.
      const crossTurnPrior =
        (slotTaskId ? byIdentity.get(`id:${slotTaskId}`) : undefined) ??
        (epochKey ? byIdentity.get(epochKey) : undefined);
      if (crossTurnPrior) {
        enrichFromSlot(crossTurnPrior, slotSkill, slotAnchor, slotTaskId);
        // Register any identity facet this snapshot revealed that the earlier
        // turn's entry lacked (e.g. first turn had no started_epoch).
        registerIdentity(slotTaskId ? `id:${slotTaskId}` : null, crossTurnPrior);
        registerIdentity(epochKey, crossTurnPrior);
        continue;
      }
      // A slot member with no matching action that carries NO usable identity
      // (a malformed string/number/array, or an object with neither skill nor
      // anchor) is skipped rather than synthesised as an all-null phantom
      // dispatch (never-throw / read-only invariant: a garbage slot map yields
      // the prior action-derived dispatches, not a junk row).
      if (!slotSkill && !slotAnchor) continue;
      // Slot present only in the snapshot — the dispatch action was never
      // recorded (a crash/interrupt truncated the turn). Synthesise a
      // RetroDispatch so the dispatch is still attributable. Seed the candidate
      // cycleId from the slot's task_id (issue #1352): if a terminal cycle
      // record exists for it (the genuinely-completed dispatch on an
      // interrupted run), the assemble loop keeps it and the dispatch becomes
      // drillable; if not (still in-flight), the loop resets it to "" and it
      // stays undrillable.
      const dispatch: RetroDispatch = {
        cycleId: slotTaskId ?? "",
        turn_n: turnN,
        skill: slotSkill,
        anchorReference: slotAnchor,
        prNumber: prNumberFromAnchor(slotAnchor),
        status: null,
        bucket: null,
        abandonReason: null,
        regressionIntroduced: false,
        flagged: false,
        undrillable: false,
      };
      out.push(dispatch);
      bySlot.set(slot, dispatch);
      registerIdentity(slotTaskId ? `id:${slotTaskId}` : null, dispatch);
      registerIdentity(epochKey, dispatch);
    }
  }
  return out;
}
