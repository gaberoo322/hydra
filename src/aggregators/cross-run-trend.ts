/**
 * Cross-run trend pure aggregator leaf (issue #3972, parent #3968).
 *
 * The numeric fold that answers "which dispatch class burns tokens without
 * shipping" over a rolling window of durable {@link DispatchOutcomeRecord}s. It
 * is PURE domain logic — it consumes already-read records (the rolling window
 * `listDispatchOutcomes({sinceMs})` returns) and produces the structured
 * `CrossRunTrend` payload. The Redis read stays in the seam
 * (`src/redis/dispatch-outcomes.ts`); this leaf owns only the count-and-score
 * fold. That is the exact split the issue names, mirroring the existing
 * `src/aggregators/cascade-routing.ts` (pure fold) / `src/redis/cascade-telemetry.ts`
 * (I/O seam) pair: only the `DispatchOutcomeRecord` TYPE is imported from the
 * redis seam here (a type-only import — no I/O function is pulled in, so a test
 * that asserts fold behaviour imports zero Redis runtime surface).
 *
 * Outcome bucketing delegates to the EXISTING {@link bucketDispatchOutcome}
 * taxonomy from `src/autopilot/cycle-status.ts` — there is NO second status set
 * defined in this file (issue #1919's "one canonical home" rule). A record whose
 * `outcome` is the LITERAL `merged` buckets `merged`; `completed`/`succeeded`
 * (the other `MERGED_STATUSES` members) bucket `completed`; `FAILED_STATUSES`
 * buckets `failed`; anything else (null, unknown, in-flight) buckets
 * `unaccounted` (issue #4856 — the #4343 read-side fix: autopilot reaps record
 * `completed` regardless of what the dispatch produced, so folding `completed`
 * into `merged` read every finished QA FAIL / no-op hand-off as a landed PR;
 * before #4856 this fold read 927/931 dispatches over 90 days as merged). The
 * four-way identity `dispatches == merged + completed + failed + unaccounted`
 * therefore holds for every `byClass` and `byRun` row by construction — the
 * fold never drops a record into a fifth bucket or silently folds one away.
 *
 * The {@link RANKING_SOUND_THRESHOLD} + `coverage.rankingSound` field gate any
 * class ranking derived from this fold: when too much of the window's token
 * spend is unattributable (records with a null `className`), a per-class
 * "burns tokens without shipping" ranking is not trustworthy and the flag says
 * so honestly rather than presenting a confidently-wrong league table.
 *
 * Pure constants + pure functions. No Redis, no clock, no I/O.
 */

import type { DispatchOutcomeRecord } from "../redis/dispatch-outcomes.ts";
import { bucketDispatchOutcome } from "../autopilot/cycle-status.ts";
// Issue #4392: the taxonomy-derived complement of reap.py's CYCLE_RECORD_SKILLS
// (a constant import — no I/O function is pulled in beyond the taxonomy's
// one-time classes.json load, so the fold stays Redis-free as documented).
import { CLASSES_WITHOUT_CYCLE_RECORD } from "../taxonomy/classes.ts";

// ---------------------------------------------------------------------------
// Window bound
// ---------------------------------------------------------------------------

/**
 * The rolling window the trend folds, `[windowStartMs, windowEndMs]`. Carried on
 * the trend so a consumer can see the span the fold covered. The assembler
 * derives it as `[now - DISPATCH_OUTCOME_TTL_SECONDS*1000, now]` so the fold
 * never asks the seam for TTL-reaped records (issue #3972 invariant).
 */
export interface CrossRunWindow {
  windowStartMs: number;
  windowEndMs: number;
}

// ---------------------------------------------------------------------------
// Coverage soundness threshold
// ---------------------------------------------------------------------------

/**
 * Minimum class-attributed token share for a per-class ranking to be
 * trustworthy (issue #3972). When the fraction of window tokens attributable to
 * a dispatch class (non-null `className`) is below this, `coverage.rankingSound`
 * is `false` and any class ranking derived from the fold MUST be withheld.
 *
 * A documented constant in the pure aggregator (not env-configurable) so the
 * fold stays free of `process.env` / I/O. A caller wanting a different bar
 * compares the raw `coverage.classAttributedTokenShare` field directly; this
 * constant only supplies `rankingSound`'s default semantics.
 */
export const RANKING_SOUND_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/**
 * The four-way outcome split for one class (or the unattributable bucket).
 * `merged` is the LITERAL `merged` status only (a confirmed merge);
 * `completed` buckets `completed`/`succeeded` via {@link bucketDispatchOutcome}
 * — a finished session with NO confirmed merge (issue #4856: before the split,
 * these counted as merged and every normally-ended dispatch read as a landed
 * PR); `failed` likewise; `unaccounted` is everything else (null / unknown /
 * in-flight). The identity `dispatches == merged + completed + failed +
 * unaccounted` holds by construction.
 */
interface CrossRunOutcomeCounts {
  merged: number;
  completed: number;
  failed: number;
  unaccounted: number;
}

/**
 * One per-class row of the trend. The {@link UNATTRIBUTABLE_CLASS_KEY} row
 * (className === null records) is a first-class member of this array — never
 * dropped or silently folded into another class.
 */
interface CrossRunClassRow {
  /**
   * The dispatch class (`dev_orch`, ...), or {@link UNATTRIBUTABLE_CLASS_KEY}
   * for records whose `className` is null (unparseable cycleId / unknown class).
   */
  className: string;
  /** Skill the class dispatches (taxonomy join). `null` when the class is unknown. */
  skill: string | null;
  /**
   * Total dispatches for the class. Always
   * `merged + completed + failed + unaccounted`.
   */
  dispatches: number;
  /**
   * Sum of raw `tokens` over the class's records (null tokens contribute 0).
   * Raw token counts — NOT the CONTEXT.md `Quota Weight` (a distinct,
   * model-weighted metric); do not conflate the two.
   */
  tokens: number;
  /**
   * The four-way outcome split.
   * `dispatches === merged + completed + failed + unaccounted`.
   */
  outcomes: CrossRunOutcomeCounts;
  /**
   * Mean tokens of the class's literal-`merged` dispatches: the sum of their
   * tokens ÷ the merged count, rounded (the same subset-sum convention the
   * sibling `cascade-routing.ts` fold uses for `avgCostDeltaPerEscalation`).
   * After #4856 only a CONFIRMED merge (`status === "merged"`) contributes —
   * which makes this field a documented LOWER BOUND, not the class's true cost
   * per finished session: the `completed → merged` upgrade is posted by the
   * merge-watch backstop over a bounded horizon, so a genuinely-merged dispatch
   * can still be recorded `completed`. Read it as "confirmed-merge cost"; for
   * the class's cost per finished session use {@link tokensPerCompletion}.
   * `0` when the class has no literal-merged records (a non-PR class like
   * `qa_orch` ALWAYS reads 0 here — that is correct, not a bug).
   */
  tokensPerMerged: number;
  /**
   * Mean tokens of the class's FINISHED dispatches — literal-`merged` PLUS
   * `completed` — rounded (issue #4856 INV-4: the cross-class "cost per
   * finished session" number). Unlike {@link tokensPerMerged} this is not
   * sensitive to the merge-reconcile horizon, so it is comparable across PR-
   * producing and non-PR classes alike. `0` when the class has neither.
   */
  tokensPerCompletion: number;
}

/**
 * One per-run row of the trend. Only records with a non-null `runIdPrefix`
 * contribute (a run grouping requires a run identity; a null-prefix record has
 * none — precedented by `getDispatchOutcomesForRun`'s by-design exclusion).
 */
interface CrossRunRunRow {
  /** First 8 hex chars of the dispatching run's run_id (the cycleId-embedded prefix). */
  runIdPrefix: string;
  /** Dispatches attributed to the run. */
  dispatches: number;
  /** Sum of raw `tokens` over the run's records (null tokens contribute 0). */
  tokens: number;
  /**
   * The run's four-way outcome split.
   * `dispatches === merged + completed + failed + unaccounted` (issue #4856).
   */
  outcomes: CrossRunOutcomeCounts;
  /**
   * Terminal merge rate: `merged / (merged + completed + failed)`, rounded to
   * 3dp (issue #4856 INV-4 — `completed` counts in the DENOMINATOR: a finished
   * unmerged dispatch is a settled outcome that failed to ship, not an
   * unresolved one; only `unaccounted`/in-flight records are excluded so a
   * not-yet-settled dispatch never dilutes the rate, matching the cascade
   * `postEscalationMergeRate` convention). `0` when the run has no terminal
   * dispatches.
   */
  mergedRate: number;
}

/**
 * Attribution-plane quality of the fold — reports BOTH dimensions the issue
 * requires: (a) run attribution (`recordsRead` vs `indexMembers`) and
 * (b) class attribution (`classAttributedRecords` + token percentage). The
 * {@link rankingSound} flag gates any class ranking derived from the fold.
 */
interface CrossRunCoverage {
  /**
   * Every decoded dispatch-outcome record read in the window — the raw count
   * folded. The run-attribution denominator paired with `indexMembers`.
   */
  recordsRead: number;
  /**
   * Records carrying a non-null `runIdPrefix` — genuine harness-stamped
   * dispatch entries attributable to a run. The dispatch-outcomes seam's
   * documented non-dispatch record families (bare UUID, bare hex task id,
   * `agent-<hex>` harness id) carry no decodable run and so never count here.
   * Named `indexMembers` for the attribution plane: `dispatch-outcomes.ts`
   * exposes no raw pre-decode ZSET cardinality and is out of scope for this
   * change, so this is the honest read-derived figure — never a fabricated
   * estimate.
   */
  indexMembers: number;
  /** Run-attribution rate: `indexMembers / recordsRead` (0 when none read). */
  attributionRate: number;
  /**
   * Records carrying a non-null `className` — attributable to a dispatch class.
   * The class-attribution count paired with `classAttributedTokenShare`.
   */
  classAttributedRecords: number;
  /**
   * Sum of raw `tokens` over class-attributed records (non-null `className`).
   * Raw token counts, NOT the CONTEXT.md `Quota Weight`.
   */
  classAttributedTokens: number;
  /** Sum of raw `tokens` over ALL records in the window (attributed + unattributable). */
  totalTokens: number;
  /**
   * Class-attributed token share: `classAttributedTokens / totalTokens`
   * (0 when there are no tokens). The soundness signal for `rankingSound`.
   */
  classAttributedTokenShare: number;
  /**
   * `true` when `classAttributedTokenShare >= {@link RANKING_SOUND_THRESHOLD}`
   * (0.5). GATES any class ranking derived from this fold: below the threshold,
   * too much of the window's token spend is unattributable for a per-class
   * "burns tokens without shipping" ranking to be trustworthy. Conservatively
   * `false` when there are no tokens at all (nothing sound to rank).
   */
  rankingSound: boolean;
  /**
   * Dispatch classes that structurally never appear in this fold's inputs —
   * their completions fire no cycle-record (reap.py's `CYCLE_RECORD_SKILLS`
   * gate), and dispatch-outcome records are written by that same path, so no
   * record can carry them however often they dispatch (issue #4392: three
   * false "producers dark" alarms, #4388 the latest, from consumers reading
   * this fold's byClass as class liveness). Static taxonomy-derived constant
   * (`CLASSES_WITHOUT_CYCLE_RECORD`) — identical on the empty trend. Class
   * liveness comes from `GET /api/autopilot/runs` (`turns[].actions[]`).
   */
  classesNotRecorded: string[];
}

/** The assembled cross-run trend payload (issue #3972). */
export interface CrossRunTrend {
  /** Inclusive lower bound of the fold window (epoch ms). */
  windowStartMs: number;
  /** Inclusive upper bound of the fold window (epoch ms). */
  windowEndMs: number;
  /**
   * Per-class rows, the "which class burns tokens without shipping" league
   * table. Always includes the {@link UNATTRIBUTABLE_CLASS_KEY} row when any
   * null-`className` record was read. Sorted by descending `tokens`, then
   * `className` asc, for a deterministic order.
   */
  byClass: CrossRunClassRow[];
  /**
   * Per-run rows. Excludes null-`runIdPrefix` records (no run identity).
   * Sorted by descending `tokens`, then `runIdPrefix` asc.
   */
  byRun: CrossRunRunRow[];
  /** Attribution-plane quality + ranking-soundness gate. */
  coverage: CrossRunCoverage;
}

/**
 * The `className` reported for the unattributable bucket — records whose
 * `className` is null (unparseable cycleId / unknown class). A first-class
 * `byClass` row keyed by this string; never dropped or silently folded away.
 */
export const UNATTRIBUTABLE_CLASS_KEY = "unattributable";

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

interface ClassAcc {
  className: string;
  skill: string | null;
  merged: number;
  completed: number;
  failed: number;
  unaccounted: number;
  tokens: number;
  /** Sum of tokens over the class's literal-merged dispatches only (the tokensPerMerged numerator). */
  mergedTokens: number;
  /** Sum of tokens over merged + completed dispatches (the tokensPerCompletion numerator). */
  completionTokens: number;
}

interface RunAcc {
  dispatches: number;
  tokens: number;
  merged: number;
  completed: number;
  failed: number;
  unaccounted: number;
}

/** Coerce a record's `tokens` to a finite number, else treat as 0 contribution. */
function tokenOf(rec: DispatchOutcomeRecord): number {
  return typeof rec.tokens === "number" && Number.isFinite(rec.tokens)
    ? rec.tokens
    : 0;
}

/**
 * Fold a rolling window of dispatch-outcome records into a {@link CrossRunTrend}.
 * PURE — no Redis, no clock, no I/O.
 *
 * Rates are 0 (never NaN) when their denominator is 0. The four-way
 * `dispatches == merged + completed + failed + unaccounted` identity holds for
 * every `byClass` and `byRun` row by construction (every record lands in
 * exactly one bucket). The
 * window bounds are carried through verbatim from `window`; this leaf does not
 * derive them (the assembler does, from the clock + `DISPATCH_OUTCOME_TTL_SECONDS`).
 */
export function rollupCrossRunTrend(
  records: readonly DispatchOutcomeRecord[],
  window: CrossRunWindow,
): CrossRunTrend {
  const classMap = new Map<string, ClassAcc>();
  const runMap = new Map<string, RunAcc>();

  let recordsRead = 0;
  let indexMembers = 0;
  let classAttributedRecords = 0;
  let classAttributedTokens = 0;
  let totalTokens = 0;

  for (const rec of records) {
    // Defensive: skip a malformed slot (the seam already decodes to records, so
    // this is belt-and-suspenders mirroring cascade-routing.ts). recordsRead
    // counts only the records actually folded.
    if (!rec || typeof rec !== "object") continue;
    recordsRead += 1;

    const tokens = tokenOf(rec);
    totalTokens += tokens;

    const isRunAttributed =
      typeof rec.runIdPrefix === "string" && rec.runIdPrefix !== "";
    if (isRunAttributed) indexMembers += 1;

    const isClassAttributed =
      typeof rec.className === "string" && rec.className !== "";
    if (isClassAttributed) {
      classAttributedRecords += 1;
      classAttributedTokens += tokens;
    }

    // Four-way bucket via the EXISTING taxonomy (no second status set here —
    // #1919). bucketDispatchOutcome returns null for a status in NEITHER set →
    // unaccounted; `completed` (not literal `merged`) for completed/succeeded
    // (#4856).
    const bucket = bucketDispatchOutcome(rec.outcome);

    // byClass row — null className collapses into the unattributable bucket.
    const key = isClassAttributed
      ? (rec.className as string)
      : UNATTRIBUTABLE_CLASS_KEY;
    let classAcc = classMap.get(key);
    if (!classAcc) {
      classAcc = {
        className: key,
        // First non-null skill seen for the class wins (deterministic given the
        // seam's newest-first order); null for the unattributable bucket.
        skill: isClassAttributed ? (rec.skill ?? null) : null,
        merged: 0,
        completed: 0,
        failed: 0,
        unaccounted: 0,
        tokens: 0,
        mergedTokens: 0,
        completionTokens: 0,
      };
      classMap.set(key, classAcc);
    } else if (classAcc.skill === null && rec.skill) {
      classAcc.skill = rec.skill;
    }
    if (bucket === "merged") {
      classAcc.merged += 1;
      classAcc.mergedTokens += tokens;
      classAcc.completionTokens += tokens;
    } else if (bucket === "completed") {
      classAcc.completed += 1;
      classAcc.completionTokens += tokens;
    } else if (bucket === "failed") {
      classAcc.failed += 1;
    } else {
      classAcc.unaccounted += 1;
    }
    classAcc.tokens += tokens;

    // byRun row — only run-attributed records (null prefix has no run identity).
    if (isRunAttributed) {
      const prefix = rec.runIdPrefix as string;
      let runAcc = runMap.get(prefix);
      if (!runAcc) {
        runAcc = {
          dispatches: 0,
          tokens: 0,
          merged: 0,
          completed: 0,
          failed: 0,
          unaccounted: 0,
        };
        runMap.set(prefix, runAcc);
      }
      runAcc.dispatches += 1;
      runAcc.tokens += tokens;
      if (bucket === "merged") runAcc.merged += 1;
      else if (bucket === "completed") runAcc.completed += 1;
      else if (bucket === "failed") runAcc.failed += 1;
      else runAcc.unaccounted += 1;
    }
  }

  const byClass: CrossRunClassRow[] = [];
  for (const acc of classMap.values()) {
    const finished = acc.merged + acc.completed;
    byClass.push({
      className: acc.className,
      skill: acc.skill,
      dispatches: acc.merged + acc.completed + acc.failed + acc.unaccounted,
      tokens: acc.tokens,
      outcomes: {
        merged: acc.merged,
        completed: acc.completed,
        failed: acc.failed,
        unaccounted: acc.unaccounted,
      },
      tokensPerMerged:
        acc.merged > 0 ? Math.round(acc.mergedTokens / acc.merged) : 0,
      tokensPerCompletion:
        finished > 0 ? Math.round(acc.completionTokens / finished) : 0,
    });
  }
  // Deterministic order: biggest token burner first, tie-broken by class name.
  byClass.sort(
    (a, b) => b.tokens - a.tokens || (a.className < b.className ? -1 : 1),
  );

  const byRun: CrossRunRunRow[] = [];
  for (const [runIdPrefix, acc] of runMap) {
    // INV-4 (#4856): completed counts in the denominator — a finished unmerged
    // dispatch is a settled outcome, not an unresolved one.
    const terminal = acc.merged + acc.completed + acc.failed;
    byRun.push({
      runIdPrefix,
      dispatches: acc.dispatches,
      tokens: acc.tokens,
      outcomes: {
        merged: acc.merged,
        completed: acc.completed,
        failed: acc.failed,
        unaccounted: acc.unaccounted,
      },
      mergedRate:
        terminal > 0 ? Math.round((acc.merged / terminal) * 1000) / 1000 : 0,
    });
  }
  byRun.sort(
    (a, b) => b.tokens - a.tokens || (a.runIdPrefix < b.runIdPrefix ? -1 : 1),
  );

  const attributionRate = recordsRead > 0 ? indexMembers / recordsRead : 0;
  const classAttributedTokenShare =
    totalTokens > 0 ? classAttributedTokens / totalTokens : 0;
  const rankingSound = classAttributedTokenShare >= RANKING_SOUND_THRESHOLD;

  return {
    windowStartMs: window.windowStartMs,
    windowEndMs: window.windowEndMs,
    byClass,
    byRun,
    coverage: {
      recordsRead,
      indexMembers,
      attributionRate,
      classAttributedRecords,
      classAttributedTokens,
      totalTokens,
      classAttributedTokenShare,
      rankingSound,
      // Issue #4392: static blind-spot label, identical on every fold.
      classesNotRecorded: [...CLASSES_WITHOUT_CYCLE_RECORD],
    },
  };
}

/**
 * An empty (zero-record) trend for a window — the honest "nothing in the
 * window" value: valid shape, empty rows, zero coverage, and NOT ranking-sound
 * (there is nothing sound to rank). Used as the never-throw fallback when the
 * rolling-window read fails, so `bundle.crossRunTrend` is always present and a
 * failure is signalled by `bundle.errors[]` instead of an absent field.
 */
export function emptyCrossRunTrend(window: CrossRunWindow): CrossRunTrend {
  return {
    windowStartMs: window.windowStartMs,
    windowEndMs: window.windowEndMs,
    byClass: [],
    byRun: [],
    coverage: {
      recordsRead: 0,
      indexMembers: 0,
      attributionRate: 0,
      classAttributedRecords: 0,
      classAttributedTokens: 0,
      totalTokens: 0,
      classAttributedTokenShare: 0,
      rankingSound: false,
      // Issue #4392: the blind-spot label ships even on the empty trend — an
      // empty window must still say which classes can never appear in it.
      classesNotRecorded: [...CLASSES_WITHOUT_CYCLE_RECORD],
    },
  };
}
