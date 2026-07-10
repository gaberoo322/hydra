/**
 * Retro-dispatch **shared type leaf** — the zero-IO home of the `RetroDispatch`
 * type, the single surface shared by the two retro-projection concern modules
 * (`retro-dispatch-classifier.ts` and `retro-cycle-identity.ts`).
 *
 * Extracted (issue #3090) so the classifier and the cycle-identity leaves both
 * import `RetroDispatch` DOWN from this lower-abstraction leaf rather than one
 * peer importing it sideways from the other — the same shared-primitive
 * direction the `run-result.ts` extraction (#3087) and the `health-signals/
 * common.ts` domain-type leaf established. There is NO lateral
 * classifier ⇄ cycle-identity import edge: the only cross-concern coupling is
 * this type, and it lives beneath both.
 *
 * Zero IO: no Redis imports, no `await`, no clock — a pure type declaration
 * with no runtime surface of its own.
 */

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
   * `true` when this dispatch carries a failure/abort signal but has NO
   * transcript handle to drill — i.e. `cycleId === ""` (issue #1184). The
   * empty-cycleId slots-snapshot-fallback population (the interrupted-run case:
   * the slots snapshot carries no cycleId, and the metrics/transcript
   * enrichment loop skips it via `if (!d.cycleId) continue;`) gets the #1168
   * `run-interrupted` abandonReason backfill for visibility, but cannot be
   * drilled — there is no transcript to read. So we record it `undrillable` and
   * EXCLUDE it from the flagged/drill subset rather than flagging an undrillable
   * dispatch (#1168 went from "flags zero" to "flags N undrillable"; this closes
   * the chain). The retro skill can then honestly report "recorded N
   * undrillable, flagged-for-drill 0" instead of reading zero transcripts on N
   * flags. A drillable (cycleId-bearing) dispatch is always `undrillable: false`.
   */
  undrillable: boolean;
}
