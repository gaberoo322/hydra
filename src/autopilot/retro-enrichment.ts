/**
 * Retro-bundle **per-cycle dispatch enrichment join** — the focused
 * sub-coordinator `assembleRetroBundle` calls once it has projected the run's
 * turn timeline into a flat `RetroDispatch[]` and fetched the durable
 * dispatch-outcome records. Extracted out of the 552-line multi-source
 * assembler (issue #3055) so the cycle-record join concern is answerable in one
 * place instead of being interleaved with the fan-out reads.
 *
 * The join, per dispatch row, resolves `status` / `bucket` / `abandonReason` /
 * `regressionIntroduced` / `anchorReference` / `prNumber` by chaining through
 * three terminal-record sources in priority order:
 *
 *   1. **durable dispatch-outcome record** (issue #2942) — the primary
 *      status/bucket backfill: the reap-time `outcome` recordCycle persists
 *      (kept in lockstep with the cycle-hash status), read from the pre-fetched
 *      `outcomeByCycleId` map;
 *   2. **cycle-metrics sidecar** — the secondary source for the failure-shape
 *      fields (`abandonReason`, `regressionIntroduced`, `anchorReference`,
 *      `prNumber`) the drill selector needs;
 *   3. **cycle-hash** — the dark-tolerant tertiary fallback for `status` /
 *      `bucket` on a cycle that predates the record store.
 *
 * On top of the three-source read it owns the three post-join transforms the
 * assembler used to inline in its local scope:
 *
 *   - **provisional-cycleId confirmation** (issue #1352) — a snapshot-recovered
 *     candidate cycleId is kept ONLY if a terminal cycle record was confirmed to
 *     exist for it (`collectProvisionalCycleIds` / `confirmDrillableCycleIds`);
 *     an unconfirmed in-flight candidate is reset to `""` so it stays
 *     undrillable;
 *   - **post-enrichment canonical-cycleId dedup** (issue #1823) — two rows that
 *     resolved to the SAME real cycle post-hoc collapse into one
 *     (`dedupByCanonicalCycleId`);
 *   - **crash-term-reason backfill** (issue #975 / #1168) — a status-less
 *     dispatch on a non-clean termination gets a non-claiming
 *     `run-<term_reason>` abandonReason so a stalled dispatch is still visible.
 *
 * The enrichment is NOT a pass-through — it is the only place the three-source
 * join is computed (the deletion test in issue #3055). The assembler retains
 * ownership of the Redis fan-out (it supplies the pre-fetched outcome map + the
 * two live readers + the never-throw `safeSource` wrapper bound to the bundle's
 * `errors[]`); this module concentrates the join so a developer changing the
 * cycle-record schema, the provisional-confirmation logic, or the
 * `CRASH_TERM_REASONS` set edits one focused function, and a test for a single
 * join rule needs only this deps bag — no reflection / friction / stuck-signal
 * fan-out stub.
 */

import type { getCycleHash } from "../redis/cycle-tracking.ts";
import type { getCycleMetrics } from "../redis/cycle-metrics.ts";
import type { DispatchOutcomeRecord } from "../redis/dispatch-outcomes.ts";
// Issue #3628: the never-throw sub-source runner type is the shared
// `BoundSafeSource` promoted to `src/settled-fold.ts` — imported instead of
// re-declared here (see the `SafeSource` alias below).
import type { BoundSafeSource } from "../settled-fold.ts";
import {
  bucketOf,
  dedupByCanonicalCycleId,
  collectProvisionalCycleIds,
  confirmDrillableCycleIds,
  type RetroDispatch,
} from "./retro-projections.ts";

/**
 * `term_reason` values that mark a non-clean run termination — the run DIED
 * before its dispatches' terminal cycle status could be written. For a
 * dispatch left status-less on such a run, the join derives a failure-leaning
 * `abandonReason` (`run-<reason>`) so a stalled dispatch is still flagged for
 * drill (issue #975). `crash` / `killed` are the abnormal exits;
 * `failure_backstop` is the reap-on-exit cause for a run that stopped on a
 * failure. `interrupted` is the SIGTERM/exit-143 truncation (the common
 * terminator — 36/39 ended runs at the time of #1168): it kills the session
 * mid-turn just like a crash, leaving occupied slots status-less, so its
 * dispatches must be drilled too rather than silently dropped (issue #1168 —
 * an interrupted run was producing a structurally-empty retro that flagged 0
 * dispatches and deep-read nothing). Genuinely-clean stops (`budget` /
 * `wall_clock` / `idle`) are NOT here — a status-less dispatch there is
 * genuinely still pending and nothing abandoned it. `handoff` is ALSO not here
 * (it is a clean baton-pass, not a killed-mid-turn crash) but is handled by the
 * sibling {@link HANDOFF_TERM_REASONS} set (issue #3738): its in-flight
 * dispatches are lost to the learning loop all the same, so they get a
 * non-claiming `run-handoff` tag for visibility — a DIFFERENT thing from a
 * crash, distinguishable by the tag.
 */
export const CRASH_TERM_REASONS: ReadonlySet<string> = new Set([
  "crash",
  "killed",
  "failure_backstop",
  "interrupted",
]);

/**
 * `term_reason` values that mark a CLEAN baton-pass whose in-flight dispatches
 * are nonetheless lost to the retro learning loop (issue #3738). A `handoff`
 * run ended (its pace-gate window closed) while dispatches were still in
 * flight; their terminal cycle status was never written to THIS run, and no
 * consumer re-reads a closed run, so the dispatch's outcome is permanently
 * unattributed — `hydra-retro` reported `flagged: 0, undrillable: 0` on exactly
 * the runs it exists to learn from. Unlike a {@link CRASH_TERM_REASONS}
 * termination the dispatch did NOT die mid-turn, so this is a SEPARATE set: a
 * handoff-pending row is tagged non-claiming `run-handoff` (status stays null,
 * never a positive outcome) for VISIBILITY only, keeping it distinguishable
 * from a crashed row's `run-<reason>`. It is counted `undrillable` downstream,
 * never flagged (no transcript handle to drill).
 */
export const HANDOFF_TERM_REASONS: ReadonlySet<string> = new Set(["handoff"]);

/**
 * Never-throw sub-source runner, threaded in from the assembler so a failed
 * cycle-metrics / cycle-hash read lands in the bundle's `errors[]` exactly as
 * every other sub-source does. The assembler binds it to the bundle's
 * `errors[]` before passing it in, so this module never touches the error
 * array directly.
 *
 * Issue #3628: this is the shared {@link BoundSafeSource} — the `errors`-bound
 * `safeSource` closure — promoted to `src/settled-fold.ts` (the single home for
 * the never-throw degrade-and-log family). This module previously re-declared
 * the type locally with an explicit "mirrors `assembleRetroBundle`'s private
 * `safeSource`" comment; it now imports the real type instead. `SafeSource` is
 * re-exported here as the local name callers/tests in this module already use.
 */
export type SafeSource = BoundSafeSource;

/**
 * Injectable deps for the enrichment join. The assembler wires the live
 * readers + the pre-fetched outcome map + the bound `safeSource`; tests
 * override only what a single join rule needs — no reflection / friction /
 * stuck-signal stub required (the leverage the extraction buys, issue #3055).
 */
export interface EnrichDispatchesDeps {
  /** Cycle-metrics sidecar reader (abandonReason / regression / anchor / PR). */
  readCycleMetrics: typeof getCycleMetrics;
  /** Cycle-hash reader — the dark-tolerant status/bucket fallback. */
  readCycleHash: typeof getCycleHash;
  /**
   * The pre-fetched durable dispatch-outcome records keyed by cycleId (issue
   * #2942) — the PRIMARY status/bucket backfill source, tried before the
   * cycle-hash read.
   */
  outcomeByCycleId: ReadonlyMap<string, DispatchOutcomeRecord>;
  /**
   * The run's `term_reason` — drives the crash-term-reason backfill. `""` (or
   * any clean stop) skips the backfill.
   */
  termReason: string;
  /** Never-throw sub-source runner bound to the bundle's `errors[]`. */
  safeSource: SafeSource;
}

/**
 * Enrich each projected dispatch row from its terminal cycle record — the
 * three-source join (durable outcome record → cycle-metrics sidecar →
 * cycle-hash), the provisional-cycleId confirm-or-drop, the post-enrichment
 * canonical-cycleId dedup, and the crash-term-reason backfill — and return the
 * enriched (and deduplicated) dispatch array.
 *
 * Never throws: every Redis read goes through the passed `safeSource`, so a
 * failing reader records an `errors[]` entry (in the assembler's array) and
 * yields a partial enrichment, never a throw. Mutates the passed rows in place
 * for the field backfill (the projection surface's established contract) and
 * returns a NEW array from the dedup pass (dropped duplicates removed).
 */
export async function enrichDispatchesWithCycleData(
  dispatches: RetroDispatch[],
  deps: EnrichDispatchesDeps,
): Promise<RetroDispatch[]> {
  const { readCycleMetrics, readCycleHash, outcomeByCycleId, termReason, safeSource } = deps;

  // Capture PROVISIONAL provenance BEFORE the enrichment loop mutates `status`.
  // A snapshot-recovered candidate (issue #1352) starts status:null; an
  // action/outcome-joined dispatch always carries a resolved status alongside
  // its cycleId, so only the snapshot candidate is provisional. The
  // `collectProvisionalCycleIds` stage names this rule (issue #2547).
  const provisionalCycleIds = collectProvisionalCycleIds(dispatches);
  const confirmedCycleIds = new Set<string>();

  // Three-source terminal-record join, per dispatch row. The metrics-sidecar
  // read carries the failure-shape fields; the durable outcome record is the
  // primary status backfill (issue #2942) with the cycle-hash read as the
  // dark-tolerant fallback. `terminalRecordSeen` accretes the confirmation
  // signal for the provisional confirm-or-drop below.
  for (const d of dispatches) {
    if (!d.cycleId) continue;
    const metrics = await safeSource(
      "cycle-metrics",
      {} as Record<string, string>,
      () => readCycleMetrics(d.cycleId),
    );
    let terminalRecordSeen = d.status !== null; // action-join already terminal
    if (metrics && typeof metrics === "object") {
      if (typeof metrics.abandonReason === "string" && metrics.abandonReason.length > 0) {
        d.abandonReason = metrics.abandonReason;
        terminalRecordSeen = true;
      }
      d.regressionIntroduced = metrics.regressionIntroduced === "true";
      if (d.regressionIntroduced) terminalRecordSeen = true;
      // Backfill status/bucket from the durable dispatch-outcome record (issue
      // #2942) when the turn join didn't carry them (e.g. a cycle recorded
      // out-of-band of a turn, OR a snapshot-only dispatch whose cycleId we
      // recovered from the task_id). The record's `outcome` IS the cycle-hash
      // status (recordCycle keeps them in lockstep, including the
      // completed→merged upgrade), so it replaces the per-dispatch getCycleHash
      // read; the hash read stays as the dark-tolerant fallback for cycles that
      // predate the record store.
      if (!d.status) {
        const durable = outcomeByCycleId.get(d.cycleId);
        if (durable) {
          d.status = durable.outcome;
          d.bucket = bucketOf(d.status);
          terminalRecordSeen = true;
        } else {
          const hash = await safeSource(
            "cycle-record",
            {} as Record<string, string>,
            () => readCycleHash(d.cycleId),
          );
          if (hash && typeof hash.status === "string" && hash.status.length > 0) {
            d.status = hash.status;
            d.bucket = bucketOf(d.status);
            terminalRecordSeen = true;
          }
        }
      }
      if (!d.anchorReference && typeof metrics.anchorReference === "string") {
        d.anchorReference = metrics.anchorReference || null;
      }
      if (!d.prNumber && typeof metrics.prNumber === "string" && metrics.prNumber.length > 0) {
        d.prNumber = metrics.prNumber;
      }
    }
    if (terminalRecordSeen) confirmedCycleIds.add(d.cycleId);
  }

  // Confirm-or-drop PROVISIONAL candidate cycleIds (issue #1352 / #2547). A
  // snapshot-only dispatch whose recovered task_id-cycleId pointed at NO
  // terminal cycle record (the slot was still in-flight when the run was
  // interrupted) has its cycleId reset to "" so it stays undrillable; a
  // confirmed candidate keeps its cycleId and becomes drillable; a
  // NON-provisional (action-derived) cycleId is never dropped.
  confirmDrillableCycleIds(dispatches, provisionalCycleIds, confirmedCycleIds);

  // Post-enrichment identity dedup (issue #1823). Now that the loop above has
  // stamped the canonical cycleId / status / anchor / abandonReason onto every
  // row, two rows that resolved to the SAME real cycle share a non-empty
  // cycleId, so this final identity-keyed pass collapses them into one
  // (earliest-turn canonical, non-null fields unioned). Runs BEFORE the
  // flag/undrillable materialisation (the assembler's next step) so each real
  // failed cycle is flagged exactly once.
  const deduped = dedupByCanonicalCycleId(dispatches);

  // Best-effort visibility tag for a dispatch whose terminal cycle status was
  // never written (issues #975 / #1168 / #3738). When a run terminated while a
  // dispatch was still in flight, that dispatch's outcome was never recorded on
  // the run, so it would stay status=null and `flagDispatchesForDrill` would
  // skip it — silently absent from the bundle. For a still-occupied slot we tag
  // a non-claiming `run-<term_reason>` abandonReason (leaving status null so we
  // never misreport a positive outcome) so the unresolved dispatch stays
  // VISIBLE (counted undrillable downstream). Two populations, kept
  // distinguishable by the tag:
  //   - CRASH_TERM_REASONS (#975/#1168): the run DIED mid-turn (crash / killed
  //     / interrupted / failure_backstop) — a failure-leaning tag.
  //   - HANDOFF_TERM_REASONS (#3738): the run HANDED OFF mid-flight (a clean
  //     baton-pass, not a crash) — its in-flight dispatch is lost to the
  //     learning loop all the same, so it gets a non-claiming visibility tag.
  // Genuinely-clean stops (budget / wall_clock / idle) tag nothing — a
  // status-less dispatch there is genuinely still pending and nothing abandoned
  // it (still counted undrillable if it has no terminal record, just untagged).
  const abandoning = CRASH_TERM_REASONS.has(termReason) || HANDOFF_TERM_REASONS.has(termReason);
  if (abandoning) {
    for (const d of deduped) {
      // Only fill dispatches whose terminal outcome was never resolved — an
      // action/cycle that DID record a status keeps it (action-join wins).
      if (d.status === null && d.bucket === null && !d.abandonReason) {
        d.abandonReason = `run-${termReason}`;
      }
    }
  }

  return deduped;
}
