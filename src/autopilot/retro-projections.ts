/**
 * Retro-bundle **pure projections** — the side-effect-free derivation logic
 * that powers the per-run retrospective bundle (issue #918, epic #917).
 *
 * History: born inside `retro-bundle.ts`, extracted as this module (#1952),
 * de-relayed (#2341), split into three concern leaves behind a relay (#3090),
 * and re-folded back into this single module (#4574). The fold's evidence:
 * the leaves never gained the dedicated test files the split was justified on
 * (the cluster is exercised through the composed surface —
 * `test/retro-bundle.test.mts` + `test/retro-enrichment.test.mts`), both
 * post-split behaviour changes (#3738, #3834) edited every leaf in lockstep,
 * and the cluster's only production caller is `src/api/autopilot-runs.ts`
 * importing `assembleRetroBundle` from `retro-bundle.ts` — the four-file
 * indirection bought no independently-consumed seam. The public surface at
 * this path is UNCHANGED: consumers keep importing every symbol from
 * `./retro-projections.ts` with zero import-path churn.
 *
 * ANTI-OSCILLATION RULE (issue #4574): do NOT re-split this module on line
 * count alone. The lineage is extract (#1952) → de-relay (#2341) → split
 * (#3090) → re-fold (#4574); a future split is warranted ONLY when a second
 * production caller needs just one of the two concerns below in isolation.
 *
 * Two concerns live here, mirroring the pre-#3090 shape:
 *   - **dispatch-bucket classification** — `projectDispatches`,
 *     `flagDispatchesForDrill`, `bucketOf` (+ the module-private slot
 *     helpers). Characterizes an *individual* dispatch's outcome.
 *   - **cross-run cycle-id dedup + the PROVISIONAL→CONFIRMED confirmation
 *     protocol** — `dedupByCanonicalCycleId`, `collectProvisionalCycleIds`,
 *     `confirmDrillableCycleIds`. Groups dispatches across runs by canonical
 *     identity.
 *
 * Everything here is pure: zero Redis imports, zero `await`, no clock beyond
 * caller-supplied input — purity is enforced by the import boundary of this
 * module (the downstream `retro-enrichment.ts` / `retro-bundle.ts` own every
 * read), not merely documented.
 */

import { bucketCycleStatus } from "./cycle-status.ts";

// ---------------------------------------------------------------------------
// Dispatch projection shape
// ---------------------------------------------------------------------------

/**
 * One code-writing dispatch's outcome, projected from the run's turn timeline
 * joined to its cycle record + metrics sidecar. The unit
 * {@link flagDispatchesForDrill} operates on.
 */
export interface RetroDispatch {
  /**
   * The cycle id (transcript handle) this dispatch resolved to, or `""` when
   * none exists. An action/outcome-joined dispatch carries the recorded
   * `outcome.cycleId`. A snapshot-only dispatch (the crashed/interrupted-run
   * case) RECOVERS a candidate from the slot's `task_id` — the same id reap
   * sends on its durable `cycle-record` write — and `assembleRetroBundle`
   * keeps it ONLY if a terminal cycle record is confirmed to exist (issue
   * #1352, the genuinely-completed-but-interrupted dispatch); an unconfirmed
   * candidate (a slot still in-flight when the run was interrupted) is reset to
   * `""` so it stays {@link undrillable}. INVARIANT: `cycleId !== ""` is the
   * drillability gate — a flagged dispatch always has a non-empty cycleId.
   */
  cycleId: string;
  /** Autopilot turn this dispatch was launched on, when known. */
  turn_n: number | null;
  /** Dispatched skill (`hydra-dev`, ...), when the action carried it. */
  skill: string | null;
  /** The dispatched anchor reference (`issue-918`, ...), when known. */
  anchorReference: string | null;
  /** PR number opened by the dispatch, when known. */
  prNumber: string | null;
  /**
   * The dispatch slot key this dispatch occupied (`dev_orch`, `qa_orch`,
   * `dev_target`, ...), when known — read off the dispatch action's `slot`
   * field or the `slots_snapshot` entry key. `null` when the slot could not be
   * recovered. Carried through the projection so the post-enrichment identity
   * dedup can collapse snapshot-derived rows that share NO durable `cycleId`
   * but DO share a slot — a dispatch occupying one slot for N turns whose
   * per-turn snapshot rows all land `cycleId: ""` (the #3738 double-count case).
   * The dedup keys empty-cycleId rows on {@link occupancyId} first (the slot's
   * `task_id`, which distinguishes distinct same-slot occupancies — issue
   * #3834), and falls back to this bare slot only for identity-less snapshots
   * (the #3738 population). Identity-bearing rows (non-empty cycleId) dedup on
   * the cycleId; the slot is only the last-resort surrogate for the
   * empty-cycleId, empty-occupancyId population.
   */
  slot: string | null;
  /**
   * Per-occupancy identity for empty-cycleId rows — the pre-formatted identity
   * string `projectDispatches` keys its cross-turn `byIdentity` map on:
   * `id:<task_id>` (the harness agent hash, globally unique per dispatch) when
   * the slot carries a `task_id`, else `epoch:<slot>@<started_epoch>` when only
   * a start instant is recoverable; `null` when neither was recoverable (an
   * identity-less snapshot — the #3738 fallback population). Reusing the SAME
   * string the projection's cross-turn collapse uses means the two dedup passes
   * — `projectDispatches`'s `byIdentity` map and `dedupByCanonicalCycleId`'s
   * post-confirm pass — key on one identity space and can never disagree about
   * "the same occupancy". **Distinct from {@link cycleId}**: this is an
   * occupancy identity, NOT a transcript handle, so
   * {@link confirmDrillableCycleIds} MUST NOT touch it (it blanks only
   * `cycleId`). Carried through the projection precisely because step 2 of
   * the bundle pipeline blanks the candidate `cycleId` (recovered from the same
   * `task_id`) on every in-flight dispatch of a `handoff` run — without a
   * separate survivor, the post-confirm dedup would lose the only thing
   * distinguishing N genuinely-distinct sequential dispatches into one slot
   * (issue #3834). {@link dedupByCanonicalCycleId} composes the empty-cycleId
   * key as `${slot}::${occupancyId}`, falling back to the bare {@link slot}
   * when this is `null`, so distinct same-slot occupancies survive as distinct
   * rows while one dispatch occupying a slot for N turns (same `task_id`
   * across turns) still collapses to one (#3738).
   */
  occupancyId: string | null;
  /** Cycle status (`merged`, `failed`, `abandoned`, ...) or `null` if pending. */
  status: string | null;
  /** Coarse bucket derived from `status`. `null` == still pending. */
  bucket: "merged" | "failed" | null;
  /** Abandon reason recorded on the cycle metrics sidecar, when present. */
  abandonReason: string | null;
  /** Whether the cycle introduced a regression (from the metrics sidecar). */
  regressionIntroduced: boolean;
  /**
   * Whether {@link flagDispatchesForDrill} selected this dispatch for a
   * transcript drill (failed / churned / errored / crashed-stall). Materialised
   * onto the served bundle by `assembleRetroBundle` AFTER the crash
   * abandonReason backfill, so a consumer reading the JSON (which cannot call
   * the pure TS selector) sees the flag directly. `projectDispatches` leaves it
   * `false`; the assemble loop is the sole writer (issue #1094).
   *
   * INVARIANT (issue #1184): `flagged === true` ⟹ `cycleId !== ""`. A flagged
   * dispatch always has a transcript handle to drill — an empty-cycleId
   * dispatch is recorded {@link undrillable} instead of flagged.
   */
  flagged: boolean;
  /**
   * `true` when this dispatch has NO terminal record attributable to the run —
   * i.e. it carries neither a resolved `status` NOR a non-empty `cycleId`
   * transcript handle. Issue #1184 introduced the flag for the empty-cycleId
   * failure/abort case; issue #3738 broadened it to count ANY unresolved row
   * (a still-in-flight dispatch on a `handoff` run has no failure signal
   * either, yet its outcome is just as lost). After the #1352 confirm-or-drop
   * pass a non-empty `cycleId` IS a confirmed terminal record, so "no terminal
   * record" reduces to `status === null && cycleId === ""`. This is the
   * population a handoff / crashed / budget-exhausted run's in-flight dispatch
   * falls into: the run ended before its terminal cycle status was written, and
   * no consumer re-reads a closed run, so its outcome is permanently lost to the
   * learning loop. Recording it `undrillable` (and EXCLUDING it from the
   * flagged/drill subset — there is no transcript to read) lets the retro
   * summary say "0 drilled because N unresolved" instead of reporting a false
   * clean on exactly the runs it exists to learn from (issue #3738). A resolved
   * dispatch (status set OR cycleId-bearing) is always `undrillable: false`.
   */
  undrillable: boolean;
}

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
 * Compute the per-occupancy identity (issue #3834) for a slot snapshot, reusing
 * the EXACT pre-formatted identity strings `projectDispatches` already keys its
 * cross-turn `byIdentity` map on — so the projection-time cross-turn collapse
 * and `dedupByCanonicalCycleId`'s post-confirm empty-cycleId pass key on the
 * literal same identity space and can never disagree about what counts as "the
 * same occupancy" (the grilled design concept's binding rationale):
 *   - `id:<task_id>`        when the slot carries a `task_id` (globally unique
 *                           per dispatch) — the durable dispatch identity;
 *   - `epoch:<slot>@<epoch>` the `epochKey` fallback when no `task_id` is
 *                           present (same slot + same start instant is
 *                           definitionally the same occupancy);
 *   - `null`                 when neither is recoverable (identity-less — the
 *                           #3738 fallback population).
 * This value is carried on {@link RetroDispatch.occupancyId};
 * `dedupByCanonicalCycleId` composes the full dedup key as
 * `${slot}::${occupancyId}` (the slot prefix disambiguates the epoch facet
 * across slots; for the globally-unique task_id facet it is redundant but
 * harmless, and keeps both facets uniform). It is DISTINCT from the candidate
 * `cycleId` even though both are seeded from the same `task_id`: the
 * confirmation protocol blanks `cycleId` but must leave this identity intact,
 * so the post-confirm dedup can still tell distinct same-slot occupancies apart.
 */
function occupancyIdOf(taskId: string | null, epochKey: string | null): string | null {
  if (taskId) return `id:${taskId}`;
  if (epochKey) return epochKey; // already `epoch:<slot>@<epoch>`
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
  occupancyId: string | null,
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
  // Per-occupancy identity (issue #3834): carry the slot's task_id/epoch as a
  // NON-drillable identity, distinct from cycleId, so it survives the
  // confirmation protocol's cycleId blank. existing-values-wins keeps the
  // first-projected identity canonical (consistent with earliest-turn-
  // canonical; a task_id and a slot@epoch for the same occupancy collapse onto
  // the same row at projection time via the cross-turn identity map, so the
  // two facets never compete for distinct rows here).
  if (!d.occupancyId && occupancyId) d.occupancyId = occupancyId;
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
      const slot = slotOfAction(a);
      const dispatch: RetroDispatch = {
        cycleId,
        turn_n: turnN,
        skill: typeof a.skill === "string" ? a.skill : null,
        anchorReference,
        prNumber,
        slot,
        // The action carries no slot task_id; the per-occupancy identity is
        // filled from the same-turn slots_snapshot below (enrichFromSlot), or
        // from a later turn's snapshot via the cross-turn identity map.
        occupancyId: null,
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
      // provisional→confirmed protocol, below) called by assembleRetroBundle
      // after its enrichment loop.
      const slotTaskId = slotStr(slotObj, "task_id");
      const epoch = slotEpoch(slotObj);
      const epochKey = epoch ? `epoch:${slot}@${epoch}` : null;
      // Per-occupancy identity (issue #3834): the pre-formatted `id:<task_id>`
      // / `epoch:<slot>@<epoch>` identity key (same string the byIdentity map
      // keys on), carried separately from the candidate cycleId so it survives
      // the confirmation protocol's blank.
      const occupancyId = occupancyIdOf(slotTaskId, epochKey);
      const existing = bySlot.get(slot);
      if (existing) {
        // Same-turn (turn, slot) merge: enrich the action-derived row's null
        // fields — action values win. Then register the row's durable identity
        // so later turns' snapshots of the SAME occupancy dedup onto it
        // (issue #1776), even when the action's cycleId and the slot's task_id
        // diverge (the epoch key covers that).
        enrichFromSlot(existing, slotSkill, slotAnchor, slotTaskId, occupancyId);
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
        enrichFromSlot(crossTurnPrior, slotSkill, slotAnchor, slotTaskId, occupancyId);
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
        slot,
        occupancyId,
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

// ---------------------------------------------------------------------------
// Cross-run cycle-id dedup + provisional tracking (pure)
// ---------------------------------------------------------------------------

/**
 * Final identity-keyed dedup over the already-enriched dispatch rows (issue
 * #1823). The projection-time `byIdentity` map in `projectDispatches`
 * dedups on the identity present ON THE ACTION at projection time. But for a
 * multi-turn cycle whose durable `cycleId` only resolves from the cycle-metrics
 * sidecar POST-HOC (the Target-build / sidecar-backfilled-cycleId path), the
 * action-time identity is absent or per-turn, so each turn's action emits its
 * own `RetroDispatch`. After `assembleRetroBundle`'s metrics-sidecar
 * enrichment loop has stamped the canonical `cycleId` (and status/anchor/PR)
 * onto every row, two rows that resolved to the SAME real cycle now share a
 * non-empty `cycleId` — so a SECOND, post-enrichment dedup pass keyed on that
 * backfilled identity collapses them into one row, where the action-time map
 * could not (it never saw the backfilled id).
 *
 * Contract (mirrors the projection-time merge):
 *   - Keyed on the non-empty `cycleId` (the durable transcript handle). An
 *     EMPTY-cycleId row carries no durable CYCLE identity, so it dedups on its
 *     per-occupancy identity instead: `occupancyId` (the pre-formatted
 *     `id:<task_id>` / `epoch:<slot>@<epoch>` identity key the projection
 *     already keys its cross-turn map on — issue #3834), falling back to the
 *     bare `slot` only when that key is null (the #3738 identity-less-snapshot
 *     population). This is the crux of #3834: by the time this pass runs,
 *     `confirmDrillableCycleIds` has blanked the candidate `cycleId` (itself
 *     recovered from the slot's `task_id`) on every in-flight dispatch of a
 *     `handoff` run, so the bare-slot fallback #3738 introduced would collapse
 *     N genuinely-distinct sequential dispatches into one slot into a single
 *     row. Keying on the `task_id`-derived `occupancyId` — which the confirm
 *     pass does NOT touch — keeps distinct occupancies distinct (different
 *     `task_id` → different key) while one dispatch occupying a slot for N
 *     turns (same `task_id` across turns → same key) still collapses to one.
 *     A row with neither a cycleId, an occupancyId, NOR a recoverable slot is
 *     left untouched (conservative — two distinct empty-cycleId slots are
 *     never merged).
 *   - EARLIEST-turn row is canonical (a `null` turn_n sorts last, so a
 *     turn-bearing row wins over an unknown-turn duplicate). Later same-cycleId
 *     rows are dropped after UNIONING their non-null fields onto the canonical
 *     row — so a field only a later turn resolved (a PR-shaped anchor, a
 *     backfilled abandonReason) is preserved while the row count drops to one.
 *   - `regressionIntroduced` ORs across the merged rows (any turn that saw a
 *     regression makes the merged dispatch a regression).
 *   - Pure + order-stable: returns the surviving rows in first-seen order, so
 *     the bundle's `dispatches[]` ordering is deterministic.
 *
 * Operates in place on the passed array's members for the union, but returns a
 * NEW filtered array (the dropped duplicates are removed). The flagged /
 * undrillable materialisation runs AFTER this pass, so each real cycle is
 * flagged at most once — closing the #1823 double-count.
 */
export function dedupByCanonicalCycleId(dispatches: RetroDispatch[]): RetroDispatch[] {
  // Non-empty-cycleId rows dedup on the cycleId (the durable transcript
  // handle) — the #1823 post-enrichment identity collapse. Empty-cycleId rows
  // carry no durable CYCLE identity, but the slots-snapshot fallback can still
  // emit one row PER TURN a slot stays occupied (the dispatch's task_id was
  // never confirmed, so the #1352 confirm-or-drop blanked it back to ""). A
  // SECOND map keys those rows on their per-occupancy identity — occupancyId
  // (the pre-formatted `id:<task_id>` / `epoch:<slot>@<epoch>` identity key),
  // carried separately from cycleId precisely so it survives the confirm-or-
  // drop (issue #3834). Keying on the task_id keeps N genuinely-distinct sequential
  // dispatches into one slot from collapsing into a single row (the #3738
  // bare-slot fallback overshot into that under-count), while one dispatch
  // occupying a slot for N turns (same task_id across turns) still collapses.
  // An identity-less snapshot (occupancyId null) falls back to the bare slot
  // (#3738). A row with neither a cycleId, an occupancyId, NOR a recoverable
  // slot has no surrogate to match on and is left untouched (conservative —
  // never silently merge two possibly-distinct dispatches).
  const byCycleId = new Map<string, RetroDispatch>();
  const byOccupancy = new Map<string, RetroDispatch>();
  const survivors: RetroDispatch[] = [];
  /** Adopt the earlier turn_n onto `canonical` (the first-seen survivor) and
   *  union `dropped`'s fields onto it.
   *
   *  Field sourcing is split by shape (issue #3834, reconciled against the
   *  design concept):
   *   - IDENTITY-shaped (skill, anchorReference, prNumber): sourced as
   *     `earlier.<field> ?? later.<field>`, where earlier/later are determined
   *     by `turn_n` — NOT by array order. The caller's input may be newest-
   *     first, so the first-seen `canonical` is not necessarily the earliest
   *     turn; sourcing from the earlier turn keeps these fields consistent with
   *     `turn_n` itself (already corrected to the earliest), and a later turn
   *     still fills a field the earlier turn left null (`??`).
   *   - OUTCOME-shaped (status/bucket, abandonReason, regressionIntroduced) and
   *     the occupancyId merge-fill keep their direction-independent fill-null /
   *     OR semantics: a later turn may still be the one that resolves a status,
   *     an abandon reason, or a regression flag. */
  const unionInto = (canonical: RetroDispatch, dropped: RetroDispatch): void => {
    const cTurn = canonical.turn_n ?? Number.POSITIVE_INFINITY;
    const dTurn = dropped.turn_n ?? Number.POSITIVE_INFINITY;
    const droppedIsEarlier = dTurn < cTurn;
    // The canonical row is always the one already in `survivors` (first-seen);
    // we only adopt the earlier turn_n onto it so it reports the dispatching
    // turn, never a later occupancy turn.
    if (droppedIsEarlier) canonical.turn_n = dropped.turn_n;
    const earlier = droppedIsEarlier ? dropped : canonical;
    const later = droppedIsEarlier ? canonical : dropped;
    // Identity-shaped fields: earlier turn wins, later fills a null.
    canonical.skill = earlier.skill ?? later.skill;
    canonical.anchorReference = earlier.anchorReference ?? later.anchorReference;
    canonical.prNumber = earlier.prNumber ?? later.prNumber;
    // Outcome-shaped fields: direction-independent fill-null / OR.
    if (canonical.status === null && dropped.status !== null) {
      canonical.status = dropped.status;
      canonical.bucket = dropped.bucket;
    }
    if (!canonical.abandonReason && dropped.abandonReason)
      canonical.abandonReason = dropped.abandonReason;
    if (!canonical.occupancyId && dropped.occupancyId)
      canonical.occupancyId = dropped.occupancyId;
    if (dropped.regressionIntroduced) canonical.regressionIntroduced = true;
  };
  for (const d of dispatches) {
    if (d.cycleId) {
      const prior = byCycleId.get(d.cycleId);
      if (!prior) {
        byCycleId.set(d.cycleId, d);
        survivors.push(d);
      } else {
        unionInto(prior, d);
      }
      continue;
    }
    // Empty-cycleId row: dedup on the per-occupancy identity (#3834) when
    // present — `${slot}::${occupancyId}` (occupancyId is the pre-formatted
    // `id:<task_id>` / `epoch:<slot>@<epoch>` key), which confirmDrillableCycleIds
    // leaves intact even as it blanks the candidate cycleId. Distinct same-slot
    // occupancies (different task_id → different key) survive as distinct rows;
    // one occupancy across N turns (same task_id → same key) still collapses.
    // Fall back to the bare slot (#3738) only when no per-occupancy identity was
    // recoverable (occupancyId null); no slot at all → leave untouched.
    const occKey = d.occupancyId !== null ? `${d.slot}::${d.occupancyId}` : d.slot;
    if (occKey) {
      const prior = byOccupancy.get(occKey);
      if (!prior) {
        byOccupancy.set(occKey, d);
        survivors.push(d);
      } else {
        unionInto(prior, d);
      }
      continue;
    }
    survivors.push(d);
  }
  return survivors;
}

// ---------------------------------------------------------------------------
// PROVISIONAL→CONFIRMED cycle-id confirmation protocol (issue #1352 / #2547)
//
// `projectDispatches` recovers a CANDIDATE cycleId from a snapshot-only
// dispatch's slot `task_id` (the crashed/interrupted-run case) — the same id
// reap sends on its durable `cycle-record` write. That candidate is PROVISIONAL:
// it is a real transcript handle ONLY if a terminal cycle record was actually
// written for it (the genuinely-completed-but-interrupted dispatch); a slot
// still in-flight when the run died has a task_id but no terminal record.
//
// Before #2547 this protocol lived as four inline mutation sites inside
// `assembleRetroBundle`'s local scope — a `provisionalCycleIds` Set built from
// the projection, a `confirmedCycleIds` Set accreted during the Redis
// enrichment loop, a confirm-or-drop pass that blanked unconfirmed candidates,
// and the downstream `undrillable` derivation. A caller reading the
// `projectDispatches` → `RetroDispatch[]` seam could not tell that the
// dispatches had to be enriched-then-confirmed in that exact sequence, nor that
// the provisional/confirmed sets even existed. These two pure functions move
// the "what counts as a drillable transcript handle" rule into the Interface:
// the assembler still owns the Redis terminal-record reads (it accretes the
// `confirmed` set during enrichment), but the provisional-set derivation and
// the confirm-or-drop transition are now named, directly-testable stages.
// ---------------------------------------------------------------------------

/**
 * Pure half 1 of the confirmation protocol (issue #1352 / #2547). Collect the
 * set of PROVISIONAL candidate cycleIds from the freshly-projected dispatches —
 * the snapshot-recovered candidates that need a terminal-record confirmation
 * before they can be trusted as transcript handles.
 *
 * A cycleId is provisional iff it is non-empty AND its status is still `null`
 * at projection time. An action/outcome-joined dispatch always carries a
 * resolved `status` alongside its cycleId (a clean transcript handle that needs
 * no confirmation), so only a snapshot-recovered candidate (recovered from the
 * slot's `task_id`, which `projectDispatches` leaves `status: null`) satisfies
 * this predicate. MUST be called on the projection BEFORE the enrichment loop
 * mutates `status`, since the predicate keys on the pre-enrichment `status`.
 *
 * Pure + total: no Redis, no clock, no mutation of the input.
 */
export function collectProvisionalCycleIds(
  dispatches: readonly RetroDispatch[],
): Set<string> {
  return new Set<string>(
    dispatches.filter((d) => d.cycleId && d.status === null).map((d) => d.cycleId),
  );
}

/**
 * Pure half 2 of the confirmation protocol (issue #1352 / #2547). Confirm-or-
 * drop the PROVISIONAL candidate cycleIds: a provisional candidate that the
 * enrichment loop did NOT confirm (no terminal cycle record materialised — the
 * slot was still in-flight when the run was interrupted) has no transcript
 * handle, so its `cycleId` is reset to `""` in place, leaving it
 * {@link RetroDispatch.undrillable}. A CONFIRMED candidate (a
 * genuinely-completed dispatch on an interrupted run — the case #1352
 * unstarves) keeps its cycleId and becomes drillable through the normal flag
 * machinery. A NON-provisional (action-derived) cycleId is never dropped: its
 * handle came from a recorded outcome.
 *
 * `provisional` is the set from {@link collectProvisionalCycleIds} (captured
 * before enrichment); `confirmed` is the set the assembler's enrichment loop
 * accreted (a candidate is confirmed once a terminal cycle record — status,
 * abandonReason, or regression — is seen for it). Mutates the `cycleId` field
 * of unconfirmed-provisional rows in place and returns the same array for
 * chaining; no Redis, no clock.
 */
export function confirmDrillableCycleIds(
  dispatches: RetroDispatch[],
  provisional: ReadonlySet<string>,
  confirmed: ReadonlySet<string>,
): RetroDispatch[] {
  for (const d of dispatches) {
    if (!d.cycleId) continue;
    if (provisional.has(d.cycleId) && !confirmed.has(d.cycleId)) {
      // Unconfirmed candidate: no terminal cycle record materialised. Drop the
      // handle so the dispatch is recorded undrillable (the pre-#1352 shape).
      d.cycleId = "";
    }
  }
  return dispatches;
}
