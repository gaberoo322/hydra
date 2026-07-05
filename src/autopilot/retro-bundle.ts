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
 */

import {
  getRun,
} from "./runs.ts";
import { getCycleHash } from "../redis/cycle-tracking.ts";
import { getCycleMetrics } from "../redis/cycle-metrics.ts";
import { getAllRecommendations } from "../redis/recommendations.ts";
import { loadAnchorReflections } from "../reflections/per-anchor.ts";
import { listFrictionPatterns } from "../pattern-memory/agent-memory.ts";
import { getAutopilotHealth } from "../aggregators/autopilot-health.ts";
import type { StuckSignal } from "./run-health.ts";
import type { MemoryPattern } from "../pattern-memory/agent-memory.ts";
// Pure projection surface — moved to `retro-projections.ts` (issue #1952). The
// assembler below uses these directly from their canonical home; callers that
// want the projections import them from `retro-projections.ts` too (issue
// #2341 retired the back-compat re-export that once relayed them through here).
import {
  bucketOf,
  projectDispatches,
  dedupByCanonicalCycleId,
  collectProvisionalCycleIds,
  confirmDrillableCycleIds,
  flagDispatchesForDrill,
} from "./retro-projections.ts";
import type { RetroDispatch } from "./retro-projections.ts";

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

/**
 * `term_reason` values that mark a non-clean run termination — the run died
 * before its dispatches' terminal cycle status could be written. For a
 * dispatch left status-less on such a run, the assembler derives a
 * failure-leaning `abandonReason` (`run-<reason>`) so a stalled dispatch is
 * still flagged for drill (issue #975). `crash` / `killed` are the abnormal
 * exits; `failure_backstop` is the reap-on-exit cause for a run that stopped
 * on a failure. `interrupted` is the SIGTERM/exit-143 truncation (the common
 * terminator — 36/39 ended runs at the time of #1168): it kills the session
 * mid-turn just like a crash, leaving occupied slots status-less, so its
 * dispatches must be drilled too rather than silently dropped (issue #1168 —
 * an interrupted run was producing a structurally-empty retro that flagged 0
 * dispatches and deep-read nothing). Genuinely-clean stops (`budget` /
 * `wall_clock` / `idle`) are NOT here — a status-less dispatch on a clean stop
 * is genuinely still pending and must stay unflagged.
 */
const CRASH_TERM_REASONS: ReadonlySet<string> = new Set([
  "crash",
  "killed",
  "failure_backstop",
  "interrupted",
]);

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

  // 2. Per-dispatch projection from the turn timeline. `let`, because the
  //    post-enrichment identity dedup (step 3c, issue #1823) returns a filtered
  //    array once the canonical cycleId has been backfilled onto each row.
  let dispatches = projectDispatches(turns);

  // 3. Enrich each dispatch from its cycle metrics sidecar (abandonReason,
  //    regressionIntroduced) — getRun's join already attached status/PR, but
  //    the sidecar carries the failure-shape fields the drill selector needs.
  //
  //    Issue #1352: a snapshot-only dispatch on an interrupted/crashed run
  //    carries a CANDIDATE cycleId derived from the slot's task_id (the same id
  //    reap uses on its durable cycle-record write). We must confirm a TERMINAL
  //    cycle record actually exists for that candidate before trusting it as a
  //    transcript handle — a slot still in-flight when the session died has a
  //    task_id but no terminal record. The cycle hash's `status` is the
  //    authoritative "this dispatch reached a terminal cycle state" marker; the
  //    metrics sidecar's failure-shape fields (abandonReason / regression) are
  //    a secondary terminal-record signal. We read the hash for a status-less
  //    candidate so we can confirm-or-drop it (step 3a below resets an
  //    unconfirmed candidate back to "" so it stays undrillable).
  // A cycleId is "action-derived" — a clean transcript handle that needs no
  // confirmation — when it came from a dispatch action/outcome. Those always
  // carry a resolved `status`/`bucket` from the outcome join, so a non-empty
  // cycleId paired with a non-null status at projection time is a real handle.
  // A snapshot-derived CANDIDATE (recovered from the slot's task_id, issue
  // #1352) starts status:null / bucket:null, so it is PROVISIONAL: we keep its
  // handle only if the metrics-sidecar / cycle-hash read confirms a terminal
  // cycle record was durably written (the genuinely-completed-but-interrupted
  // dispatch). Capture provenance BEFORE enrichment mutates status — the
  // `collectProvisionalCycleIds` stage names this rule in the projection
  // Interface (issue #2547) instead of inlining it in the assembler's scope.
  const provisionalCycleIds = collectProvisionalCycleIds(dispatches);
  const confirmedCycleIds = new Set<string>();
  for (const d of dispatches) {
    if (!d.cycleId) continue;
    const metrics = await safeSource(
      "cycle-metrics",
      errors,
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
      // Backfill status/anchor from the metrics sidecar when the turn join
      // didn't carry them (e.g. a cycle recorded out-of-band of a turn, OR a
      // snapshot-only dispatch whose cycleId we recovered from the task_id).
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
          terminalRecordSeen = true;
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

  // 3a. Confirm-or-drop PROVISIONAL candidate cycleIds (issue #1352). The
  //     `confirmDrillableCycleIds` stage (issue #2547) names this confirm-or-
  //     drop transition in the projection Interface: a snapshot-only dispatch
  //     whose recovered task_id-cycleId pointed at NO terminal cycle record (the
  //     slot was still in-flight when the run was interrupted) has its cycleId
  //     reset to "" so it stays undrillable, exactly as before #1352; a
  //     confirmed candidate (a genuinely-completed dispatch on an interrupted
  //     run) keeps its cycleId and becomes drillable through the normal flag
  //     machinery below; a NON-provisional (action-derived) cycleId is never
  //     dropped (its handle came from a recorded outcome).
  confirmDrillableCycleIds(dispatches, provisionalCycleIds, confirmedCycleIds);

  // 3c. Post-enrichment identity dedup (issue #1823). The projection-time
  //     `byIdentity` map deduped on the identity present ON THE ACTION; a
  //     multi-turn cycle whose durable `cycleId` only resolves from the
  //     cycle-metrics sidecar POST-HOC (the Target-build / sidecar-backfilled
  //     path) was therefore projected as one row PER TURN — each turn's action
  //     carried no shared action-time identity, so the action-time map never
  //     merged them. Now that the enrichment loop above has stamped the
  //     canonical cycleId / status / anchor / abandonReason onto every row, two
  //     rows that resolved to the SAME real cycle share a non-empty cycleId, so
  //     this final identity-keyed pass collapses them into one (earliest-turn
  //     canonical, non-null fields unioned). Runs BEFORE the flag/undrillable
  //     materialisation so each real failed cycle is flagged exactly once
  //     instead of being double-counted (the #1776-incomplete defect). An
  //     empty-cycleId row (undrillable / interrupted-run case) has no durable
  //     identity and is left untouched.
  dispatches = dedupByCanonicalCycleId(dispatches);

  // 3b. Best-effort status derivation for a non-clean termination. When a run
  //     crashed (term_reason=crash) or was killed, its dispatches' terminal
  //     cycle status was never written, so they'd stay status=null and
  //     flagDispatchesForDrill would skip them — exactly the run #975 hit. For
  //     a still-occupied slot on a crashed run we derive a failure-leaning
  //     status from the run term_reason so the stalled dispatch becomes
  //     flaggable. We do NOT claim `merged` (that would be a false success on a
  //     run whose terminal status was never recorded); we tag the safe
  //     `errored` abandonReason instead, leaving the status itself null so we
  //     never misreport a positive outcome. Genuinely-idle slots are absent
  //     from slots_snapshot (null), so they were never projected and stay
  //     unflagged.
  const termReason =
    runView && typeof (runView as any).term_reason === "string"
      ? ((runView as any).term_reason as string)
      : "";
  if (CRASH_TERM_REASONS.has(termReason)) {
    for (const d of dispatches) {
      // Only fill dispatches whose terminal outcome was never resolved — an
      // action/cycle that DID record a status keeps it (action-join wins).
      if (d.status === null && d.bucket === null && !d.abandonReason) {
        d.abandonReason = `run-${termReason}`;
      }
    }
  }

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
    reflections,
    stuckSignals,
    recommendations,
    frictionPatterns,
    errors,
  };
}
