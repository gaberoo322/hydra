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
 *     (`reflections/reflections.loadAnchorReflections`), the live record of
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
 */

import {
  getRun,
  MERGED_STATUSES,
  FAILED_STATUSES,
} from "./runs.ts";
import { getCycleHash } from "../redis/cycle-tracking.ts";
import { getCycleMetrics } from "../redis/cycle-metrics.ts";
import { getAllRecommendations } from "../redis/recommendations.ts";
import { loadAnchorReflections } from "../reflections/reflections.ts";
import { listFrictionPatterns } from "../pattern-memory/agent-memory.ts";
import { getAutopilotHealth } from "../aggregators/autopilot-health.ts";
import type { StuckSignal } from "../schemas/now-page.ts";
import type { MemoryPattern } from "../pattern-memory/agent-memory.ts";

// ---------------------------------------------------------------------------
// Bundle shape
// ---------------------------------------------------------------------------

/** One sub-source that failed to load — surfaced instead of thrown. */
export interface RetroBundleError {
  /** Stable, machine-readable source name, e.g. `"run-record"`, `"friction"`. */
  source: string;
  /** The error message (best-effort string coercion). */
  detail: string;
}

/**
 * One code-writing dispatch's outcome, projected from the run's turn timeline
 * joined to its cycle record + metrics sidecar. The unit
 * {@link flagDispatchesForDrill} operates on.
 */
export interface RetroDispatch {
  /** The cycle id this dispatch resolved to (or the synthesised turn key). */
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
}

/** A per-anchor reflection narrative attached to a flagged dispatch. */
export interface RetroReflection {
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
 */
export function flagDispatchesForDrill(dispatches: RetroDispatch[]): RetroDispatch[] {
  return dispatches.filter(
    (d) =>
      d.bucket === "failed" ||
      d.regressionIntroduced === true ||
      (typeof d.abandonReason === "string" && d.abandonReason.length > 0),
  );
}

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
    console.error(`[retro-bundle] sub-source failed (${source}): ${detail}`);
    errors.push({ source, detail });
    return fallback;
  }
}

function bucketOf(status: string | null): "merged" | "failed" | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (MERGED_STATUSES.has(s)) return "merged";
  if (FAILED_STATUSES.has(s)) return "failed";
  return null;
}

/**
 * Project the run's turn timeline into the flat per-dispatch list. Pulls the
 * dispatch identity (cycleId / skill / anchor) off each `type === "dispatch"`
 * action and the joined `outcome` (attached by `fetchTurnsWithJoins`). Pure
 * over the already-fetched turns — no Redis here.
 */
export function projectDispatches(
  turns: Array<Record<string, unknown>>,
): RetroDispatch[] {
  const out: RetroDispatch[] = [];
  for (const turn of turns) {
    const turnN =
      typeof turn.turn_n === "number" && Number.isFinite(turn.turn_n)
        ? (turn.turn_n as number)
        : null;
    const actions: any[] = Array.isArray(turn.actions) ? (turn.actions as any[]) : [];
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
      out.push({
        cycleId,
        turn_n: turnN,
        skill: typeof a.skill === "string" ? a.skill : null,
        anchorReference:
          (typeof a.anchorReference === "string" && a.anchorReference) ||
          (typeof a.anchor === "string" && a.anchor) ||
          (typeof a.issueRef === "string" && a.issueRef) ||
          null,
        prNumber,
        status,
        bucket: bucketOf(status),
        // abandonReason / regression are enriched from the metrics sidecar
        // join below; default to the no-signal values here.
        abandonReason: null,
        regressionIntroduced: false,
      });
    }
  }
  return out;
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

  // 2. Per-dispatch projection from the turn timeline.
  const dispatches = projectDispatches(turns);

  // 3. Enrich each dispatch from its cycle metrics sidecar (abandonReason,
  //    regressionIntroduced) — getRun's join already attached status/PR, but
  //    the sidecar carries the failure-shape fields the drill selector needs.
  for (const d of dispatches) {
    if (!d.cycleId) continue;
    const metrics = await safeSource(
      "cycle-metrics",
      errors,
      {} as Record<string, string>,
      () => readCycleMetrics(d.cycleId),
    );
    if (metrics && typeof metrics === "object") {
      if (typeof metrics.abandonReason === "string" && metrics.abandonReason.length > 0) {
        d.abandonReason = metrics.abandonReason;
      }
      d.regressionIntroduced = metrics.regressionIntroduced === "true";
      // Backfill status/anchor from the metrics sidecar when the turn join
      // didn't carry them (e.g. a cycle recorded out-of-band of a turn).
      if (!d.status) {
        const hash = await safeSource(
          "cycle-record",
          errors,
          {} as Record<string, string>,
          () => readCycleHash(d.cycleId),
        );
        if (hash && typeof hash.status === "string" && hash.status.length > 0) {
          d.status = hash.status;
          d.bucket = bucketOf(d.status);
        }
      }
      if (!d.anchorReference && typeof metrics.anchorReference === "string") {
        d.anchorReference = metrics.anchorReference || null;
      }
      if (!d.prNumber && typeof metrics.prNumber === "string" && metrics.prNumber.length > 0) {
        d.prNumber = metrics.prNumber;
      }
    }
  }

  // 4. Reflections — only for the FLAGGED (drill-worthy) dispatches that carry
  //    an anchor. This is the "QA verdict / why it failed" narrative and the
  //    drill-on-flag bound keeps the read fan-out to the dispatches that went
  //    wrong.
  const flagged = flagDispatchesForDrill(dispatches);
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
      // A non-JSON rec value is a corrupt write; keep the raw string so the
      // bundle is still legible rather than silently dropping it.
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
    reflections,
    stuckSignals,
    recommendations,
    frictionPatterns,
    errors,
  };
}
