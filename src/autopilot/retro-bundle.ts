/**
 * Run-tree retro-bundle — a never-throw, read-only assembler that, given an
 * autopilot `run_id`, joins the run's lifecycle data into one structured
 * "retro bundle" for the per-run retrospective system (issue #918, epic #917).
 *
 * The bundle composes, all read-only, from existing seams:
 *   - the **run record** (status, term_reason, turns, dispatches) and the
 *     per-turn **dispatch decisions + reasons** — `autopilot/runs.getRun`
 *   - per-**cycle records** (status / merged-failed counts / abandon_reason /
 *     regression) — `redis/cycle-tracking.getCycleHash` joined with the
 *     `redis/cycle-metrics.getCycleMetrics` sidecar (abandonReason,
 *     regressionIntroduced, anchorReference, prNumber live there)
 *   - **QA verdicts / failure narratives** — the per-anchor reflection blocks
 *     (`reflections/per-anchor.loadAnchorReflections`), the live record of
 *     "what was attempted, why it failed" a retry consumes (there is no
 *     separate QA-verdict store; QA posts verdicts as PR comments and the
 *     fixable signal is the reflection narrative)
 *   - the **#890 stuck-signals** — `aggregators/autopilot-health.getAutopilotHealth`
 *   - the **recommendation-engine recs** emitted during the run —
 *     `redis/recommendations.getAllRecommendations`
 *   - the **friction-pattern store** — `pattern-memory/agent-memory.listFrictionPatterns`
 *
 * Contracts (CLAUDE.md):
 *   - **Never throws.** Every sub-source is wrapped; a missing or failing
 *     source yields a partial bundle, a logged `console.error`, and a typed
 *     entry in `bundle.errors[]` — never a throw. Mirrors the
 *     merge/grounding/verification result-object convention.
 *   - **Read-only.** No Redis write, no run-state mutation.
 *
 * The pure {@link flagDispatchesForDrill} selector names the subset of
 * dispatches whose full transcript a downstream consumer should drill into
 * (failed QA, stalled, churned, or errored) so transcripts are read only for
 * the dispatches that went wrong — the signals-first / drill-on-flag input
 * strategy that bounds the retrospective's token cost (epic #917).
 *
 * The pure projection surface ({@link projectDispatches},
 * {@link dedupByCanonicalCycleId}, {@link flagDispatchesForDrill}, the
 * {@link RetroDispatch} type, and the supporting pure helpers) lives in the
 * sibling `retro-projections.ts` (issue #1952), mirroring the
 * `runs.ts` / `run-projections.ts` split (issue #1183) — import those symbols
 * from there. This file's only public surface is the side-effectful assembler
 * {@link assembleRetroBundle} (the only thing that touches Redis); issue #2341
 * retired the back-compat re-export that once relayed the projections through
 * here once the migration window closed.
 *
 * The per-cycle dispatch enrichment join — the three-source terminal-record
 * chain (durable outcome record → cycle-metrics sidecar → cycle-hash), the
 * provisional-cycleId confirm-or-drop, the post-enrichment canonical-cycleId
 * dedup, and the crash-term-reason backfill — lives in the sibling
 * `retro-enrichment.ts` leaf (issue #3055). `assembleRetroBundle` supplies the
 * pre-fetched outcome map + the two live readers + the never-throw
 * `safeSource` wrapper and calls `enrichDispatchesWithCycleData` once, so the
 * assembler stays a thin fan-out coordinator: project turns → fan out
 * sub-sources → enrich → flag → drill reflections → build bundle.
 */

import {
  getRun,
} from "./run-reads.ts";
import { getCycleHash } from "../redis/cycle-tracking.ts";
import { getCycleMetrics } from "../redis/cycle-metrics.ts";
// Issue #2942: the durable per-dispatch outcome record recordCycle writes at
// reap time — the bundle reads it instead of re-deriving outcome/tokens
// through the per-dispatch getCycleHash join wherever a record exists.
import {
  getDispatchOutcomesForRun,
  type DispatchOutcomeRecord,
  type DispatchOutcomeListResult,
} from "../redis/dispatch-outcomes.ts";
import { getAllRecommendations } from "../redis/recommendations.ts";
import { loadAnchorReflections } from "../reflections/per-anchor.ts";
import { listFrictionPatterns } from "../pattern-memory/index.ts";
import { getAutopilotHealth } from "../aggregators/autopilot-health.ts";
import type { StuckSignal } from "./run-health.ts";
import type { MemoryPattern } from "../pattern-memory/index.ts";
import { logger } from "../logger.ts";
// Pure projection surface — moved to `retro-projections.ts` (issue #1952). The
// assembler below uses these directly from their canonical home; callers that
// want the projections import them from `retro-projections.ts` too (issue
// #2341 retired the back-compat re-export that once relayed them through here).
import {
  projectDispatches,
  flagDispatchesForDrill,
} from "./retro-projections.ts";
import type { RetroDispatch } from "./retro-projections.ts";
// Issue #3055: the per-cycle dispatch enrichment join — the three-source
// terminal-record chain (durable outcome record → cycle-metrics sidecar →
// cycle-hash), the provisional-cycleId confirm-or-drop, the post-enrichment
// canonical-cycleId dedup, and the crash-term-reason backfill — is a focused
// leaf so the assembler stays a thin fan-out coordinator + composition.
import { enrichDispatchesWithCycleData } from "./retro-enrichment.ts";

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

/** One sub-source that failed to load — surfaced instead of thrown. */
interface RetroBundleError {
  /** Stable, machine-readable source name, e.g. `"run-record"`, `"friction"`. */
  source: string;
  /** The error message (best-effort string coercion). */
  detail: string;
}

/** A per-anchor reflection narrative attached to a flagged dispatch. */
interface RetroReflection {
  anchorReference: string;
  /** Prompt-ready markdown narrative; `""` when no prior reflections exist. */
  formatted: string;
  /** Number of prior-failure reflections composed into `formatted`. */
  count: number;
}

/** The assembled retro bundle. Always returned — never thrown. */
export interface RetroBundle {
  run_id: string;
  /** ISO timestamp the bundle was assembled. */
  generatedAt: string;
  /**
   * `true` when the run record itself loaded; `false` means the run is
   * unknown / unreadable and every downstream join was skipped.
   */
  runFound: boolean;
  /** The projected run record (status, term_reason, turns, dispatches, ...). */
  run: Record<string, unknown> | null;
  /** Per-turn dispatch decisions + reasons (the run's turn timeline). */
  turns: Array<Record<string, unknown>>;
  /** Per-dispatch outcomes, projected + joined from the turn timeline. */
  dispatches: RetroDispatch[];
  /**
   * The durable per-dispatch outcome records for this run (issue #2942) —
   * the reap-time `{run, turn, class, skill, outcome, tokens, durationMs}`
   * join recordCycle persists, read via `getDispatchOutcomesForRun` instead
   * of being re-derived per retro. Empty when the run predates the record
   * store (dark-tolerant: the getCycleHash fallback join above still fills
   * `dispatches[]`).
   */
  dispatchOutcomes: DispatchOutcomeRecord[];
  /**
   * Per-anchor reflection narratives for the FLAGGED dispatches only — the
   * "QA verdict / why it failed" signal a retrospective acts on. Bounded to
   * the drill subset so we don't fan out a reflection read per dispatch.
   */
  reflections: RetroReflection[];
  /** The #890 stuck-signals (ranked) at bundle-assembly time. */
  stuckSignals: StuckSignal[];
  /** Recommendation-engine recs emitted during the run (raw hash values). */
  recommendations: unknown[];
  /** Friction-pattern store snapshot across the known dispatch skills. */
  frictionPatterns: MemoryPattern[];
  /** Sub-sources that failed to load. Empty on a fully-clean assembly. */
  errors: RetroBundleError[];
}

/**
 * Injectable readers — defaults wire the live Redis/aggregator seams. Tests
 * override individual readers to pin behavior (and to assert the never-throw
 * contract by making a reader reject). Mirrors `AutopilotHealthDeps`.
 */
export interface RetroBundleDeps {
  now?: Date;
  readRun?: typeof getRun;
  readCycleHash?: typeof getCycleHash;
  readCycleMetrics?: typeof getCycleMetrics;
  /** Issue #2942: the durable per-dispatch outcome-record read. */
  readDispatchOutcomes?: typeof getDispatchOutcomesForRun;
  readRecommendations?: typeof getAllRecommendations;
  readAnchorReflections?: typeof loadAnchorReflections;
  readFrictionPatterns?: typeof listFrictionPatterns;
  readStuckSignals?: typeof getAutopilotHealth;
  /**
   * Skills whose friction stores are folded into the bundle. Defaults to the
   * code-writing + verification dispatch skills the autopilot runs.
   */
  frictionSkills?: string[];
}

const DEFAULT_FRICTION_SKILLS = [
  "hydra-dev",
  "hydra-qa",
  "hydra-target-build",
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toDetail(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

/**
 * Run a sub-source reader under the never-throw contract. On rejection: log
 * with context, push a typed entry onto `errors`, and return `fallback`.
 */
async function safeSource<T>(
  source: string,
  errors: RetroBundleError[],
  fallback: T,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const detail = toDetail(err);
    logger.error({ source, err }, "[retro-bundle] sub-source failed");
    errors.push({ source, detail });
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Assemble the retro bundle for `runId`. Never throws — a missing or failing
 * sub-source yields a partial bundle plus a logged + recorded error. When the
 * run record itself is unreadable, `runFound` is `false` and the run-scoped
 * joins are skipped (but the run-agnostic sources — stuck-signals, friction —
 * are still attempted, since they remain useful context).
 */
export async function assembleRetroBundle(
  runId: string,
  deps: RetroBundleDeps = {},
): Promise<RetroBundle> {
  const readRun = deps.readRun ?? getRun;
  const readCycleHash = deps.readCycleHash ?? getCycleHash;
  const readCycleMetrics = deps.readCycleMetrics ?? getCycleMetrics;
  const readDispatchOutcomes = deps.readDispatchOutcomes ?? getDispatchOutcomesForRun;
  const readRecommendations = deps.readRecommendations ?? getAllRecommendations;
  const readAnchorReflections = deps.readAnchorReflections ?? loadAnchorReflections;
  const readFrictionPatterns = deps.readFrictionPatterns ?? listFrictionPatterns;
  const readStuckSignals = deps.readStuckSignals ?? getAutopilotHealth;
  const frictionSkills = deps.frictionSkills ?? DEFAULT_FRICTION_SKILLS;
  const generatedAt = (deps.now ?? new Date()).toISOString();

  const errors: RetroBundleError[] = [];

  // 1. Run record + turn timeline (the spine of the bundle).
  const runResult = await safeSource(
    "run-record",
    errors,
    null as Awaited<ReturnType<typeof getRun>> | null,
    () => readRun(runId),
  );

  let runView: Record<string, unknown> | null = null;
  let turns: Array<Record<string, unknown>> = [];
  let runFound = false;
  if (runResult && runResult.ok) {
    runFound = true;
    runView = runResult.run;
    turns = Array.isArray(runResult.turns) ? runResult.turns : [];
  } else if (runResult && !runResult.ok && runResult.code !== "not-found") {
    // A genuine read error (not a clean 404) — record it so the bundle's
    // partial-ness is legible. A `not-found` is a normal empty bundle.
    errors.push({ source: "run-record", detail: runResult.detail || runResult.code });
  }

  // 1a. The durable per-dispatch outcome records for this run (issue #2942).
  //     Run-scoped like the cycle joins, so skipped when the run is unknown.
  //     Never-throw: the accessor returns a result object, and an ok:false
  //     lands in bundle.errors[] like any other failed sub-source. Records are
  //     BOTH exposed on the bundle (the retro's per-dispatch outcome + tokens
  //     source, replacing the re-derived join) AND used below as the primary
  //     status-backfill source (the getCycleHash read stays as the
  //     dark-tolerant fallback for cycles that predate the record store).
  let dispatchOutcomes: DispatchOutcomeRecord[] = [];
  if (runFound) {
    const outcomesResult = await safeSource<DispatchOutcomeListResult>(
      "dispatch-outcomes",
      errors,
      { ok: true, records: [] },
      () => readDispatchOutcomes(runId),
    );
    if (outcomesResult.ok === true) {
      dispatchOutcomes = outcomesResult.records;
    } else {
      // The accessor is itself never-throw and surfaced a structured failure —
      // record it like any other failed sub-source (partial bundle, no throw).
      errors.push({ source: "dispatch-outcomes", detail: outcomesResult.error });
    }
  }
  const outcomeByCycleId = new Map<string, DispatchOutcomeRecord>(
    dispatchOutcomes.map((rec) => [rec.cycleId, rec]),
  );

  // 2. Per-dispatch projection from the turn timeline, then the per-cycle
  //    enrichment join (issue #3055 extracted the join into `retro-enrichment`).
  //    The enricher owns the three-source terminal-record chain (durable
  //    outcome record → cycle-metrics sidecar → cycle-hash), the #1352
  //    provisional-cycleId confirm-or-drop, the #1823 post-enrichment
  //    canonical-cycleId dedup, and the #975/#1168 crash-term-reason backfill,
  //    returning the enriched + deduplicated dispatch array. It reads Redis
  //    only through the never-throw `safeSource` (bound to `errors[]` here), so
  //    a failing cycle read still yields a partial bundle, never a throw.
  const projected = projectDispatches(turns);
  const termReason =
    runView && typeof (runView as any).term_reason === "string"
      ? ((runView as any).term_reason as string)
      : "";
  const dispatches = await enrichDispatchesWithCycleData(projected, {
    readCycleMetrics,
    readCycleHash,
    outcomeByCycleId,
    termReason,
    safeSource: (source, fallback, fn) => safeSource(source, errors, fallback, fn),
  });

  // 4. Reflections — only for the FLAGGED (drill-worthy) dispatches that carry
  //    an anchor. This is the "QA verdict / why it failed" narrative and the
  //    drill-on-flag bound keeps the read fan-out to the dispatches that went
  //    wrong.
  const flagged = flagDispatchesForDrill(dispatches);
  // Materialise the drill-flag onto the served dispatches. The bundle's JSON
  // consumers (the hydra-retro skill curls the endpoint and cannot call the
  // pure TS selector) read `dispatches[].flagged` directly, and the
  // SKILL.md contract is that `dispatches[]` already carries the flagged
  // signal. Without this write-back every served dispatch reported
  // `flagged: undefined` and the rollup was `flagged: 0` even on a crashed run
  // where every dispatch carried `abandonReason: run-crash` (issue #1094).
  // flagDispatchesForDrill returns members of `dispatches` (filter, not map),
  // so mutating them here is mutating the served objects in place.
  for (const d of flagged) d.flagged = true;
  // Materialise the undrillable signal onto the served dispatches (issue
  // #1184). A dispatch with a failure/abort signal but an EMPTY cycleId has no
  // transcript handle to drill — the metrics/transcript enrichment loop above
  // skips it (`if (!d.cycleId) continue;`). The #1168 `run-interrupted`
  // backfill stamps such empty-cycleId slots-snapshot-fallback dispatches, but
  // they cannot be drilled. So we EXCLUDE them from the flagged subset (the
  // selector's `cycleId !== ""` clause already does this — they stay
  // flagged:false) and record them undrillable:true so the JSON consumer can
  // honestly count "recorded N undrillable, flagged-for-drill 0" rather than
  // reading zero transcripts on N flags. This is the same in-place mutation of
  // the served objects as the flagged write-back above, keeping the served
  // bundle and the pure selector in agreement. Invariant: a flagged dispatch
  // always has cycleId !== "" (a transcript handle), and an undrillable
  // dispatch is never flagged.
  const hasFailureSignal = (d: RetroDispatch): boolean =>
    d.bucket === "failed" ||
    d.regressionIntroduced === true ||
    (typeof d.abandonReason === "string" && d.abandonReason.length > 0);
  for (const d of dispatches) {
    d.undrillable = d.cycleId === "" && hasFailureSignal(d);
  }
  const reflections: RetroReflection[] = [];
  const seenAnchors = new Set<string>();
  for (const d of flagged) {
    const anchor = d.anchorReference;
    if (!anchor || seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    const block = await safeSource(
      "reflections",
      errors,
      { content: "", count: 0 },
      () => readAnchorReflections(anchor),
    );
    reflections.push({
      anchorReference: anchor,
      formatted: block.content,
      count: block.count,
    });
  }

  // 5. Stuck-signals (#890) — run-agnostic; always attempted.
  const stuckSignals = await safeSource<StuckSignal[]>(
    "stuck-signals",
    errors,
    [],
    () => readStuckSignals(),
  );

  // 6. Recommendation-engine recs emitted during the run.
  const recsHash = await safeSource(
    "recommendations",
    errors,
    {} as Record<string, string>,
    () => readRecommendations(runId),
  );
  const recommendations: unknown[] = [];
  for (const raw of Object.values(recsHash || {})) {
    try {
      recommendations.push(JSON.parse(raw));
    } catch {
      /* intentional: a non-JSON rec value is a corrupt write; keep the raw
         string so the bundle is still legible rather than silently dropping it */
      recommendations.push(raw);
    }
  }

  // 7. Friction-pattern store across the known dispatch skills.
  const frictionPatterns: MemoryPattern[] = [];
  for (const skill of frictionSkills) {
    const patterns = await safeSource<MemoryPattern[]>(
      "friction",
      errors,
      [],
      () => readFrictionPatterns(skill),
    );
    for (const p of patterns) frictionPatterns.push(p);
  }

  return {
    run_id: runId,
    generatedAt,
    runFound,
    run: runView,
    turns,
    dispatches,
    dispatchOutcomes,
    reflections,
    stuckSignals,
    recommendations,
    frictionPatterns,
    errors,
  };
}
