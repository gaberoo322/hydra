/**
 * Anchor Confidence Scorer — predicts whether an anchor will produce a
 * mergeable task before calling the planner.
 *
 * Two-tier scoring:
 *   Tier 1: Deterministic heuristics (free, instant)
 *   Tier 2: Nano-model classifier for ambiguous scores (0.3–0.7)
 *
 * Never throws — returns a result object so callers decide how to handle.
 */

import { getTracker } from "./task-tracker.ts";
import { redisKeys } from "./redis-keys.ts";
import { runAgent } from "./codex-runner.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnchorScoreResult {
  score: number;
  reason: string;
  tier: "heuristic" | "classifier";
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ANCHOR_MIN_CONFIDENCE = parseFloat(
  process.env.ANCHOR_MIN_CONFIDENCE || "0.4",
);

const CLASSIFIER_LOW = 0.3;
const CLASSIFIER_HIGH = 0.7;

// ---------------------------------------------------------------------------
// Tier 1: Deterministic heuristic scoring
// ---------------------------------------------------------------------------

/**
 * Score an anchor using deterministic heuristics only.
 * Pure function over the anchor + grounding — no LLM calls, no cost.
 */
export function scoreHeuristic(anchor: any, grounding: any): AnchorScoreResult {
  const type: string = anchor?.type || "";

  switch (type) {
    // failing-test: always actionable — tests are red and must be fixed
    case "failing-test":
      return { score: 1.0, reason: "Failing tests are always actionable", tier: "heuristic" };

    // prior-failure: may fail again but worth retrying with new context
    case "prior-failure":
      return { score: 0.6, reason: "Prior failure — retry with new context", tier: "heuristic" };

    // reframe: fresh approach after circuit breaker — worth attempting
    case "reframe":
      return { score: 0.7, reason: "Reframe — fresh approach after repeated failure", tier: "heuristic" };

    // regression-hunt: self-play validation of recent merges
    case "regression-hunt":
      return { score: 0.8, reason: "Regression hunt — adversarial testing of recent merges", tier: "heuristic" };

    // research: check the queue item still exists
    case "research":
      return scoreResearchAnchor(anchor);

    // user-request: validate that the reference is non-empty and not stale
    case "user-request":
      return scoreUserRequestAnchor(anchor);

    // codebase-health: require a specific signal in grounding
    case "codebase-health":
      return scoreCodebaseHealthAnchor(anchor, grounding);

    // issue: TODO/FIXME markers — verify markers still exist in grounding
    case "issue":
      return scoreIssueAnchor(anchor, grounding);

    // doc: priorities doc fallback — lower confidence, often produces empty cycles
    case "doc":
      return { score: 0.5, reason: "Priorities doc fallback — may lack specific signal", tier: "heuristic" };

    default:
      return { score: 0.5, reason: `Unknown anchor type "${type}" — using neutral score`, tier: "heuristic" };
  }
}

function scoreResearchAnchor(anchor: any): AnchorScoreResult {
  // Research items should have a reference and context
  if (!anchor.reference || anchor.reference.trim().length === 0) {
    return { score: 0, reason: "Research anchor has no reference", tier: "heuristic" };
  }
  return { score: 0.8, reason: "Research opportunity with valid reference", tier: "heuristic" };
}

function scoreUserRequestAnchor(anchor: any): AnchorScoreResult {
  const ref = (anchor.reference || "").trim();

  // No reference = stale / invalid
  if (!ref) {
    return { score: 0, reason: "User-request anchor has empty reference", tier: "heuristic" };
  }

  // Check for completed marker
  if (ref.toLowerCase().startsWith("completed:")) {
    return { score: 0, reason: "User-request already marked completed", tier: "heuristic" };
  }

  // Has context or description — higher confidence the request is well-formed
  if (anchor.context || anchor.description) {
    return { score: 0.9, reason: "User-request with context/description", tier: "heuristic" };
  }

  // Reference exists but no enrichment — moderate confidence
  return { score: 0.6, reason: "User-request with reference but no description", tier: "heuristic" };
}

function scoreCodebaseHealthAnchor(anchor: any, grounding: any): AnchorScoreResult {
  // Codebase-health requires a specific signal: failing test, typecheck error,
  // or TODO markers. Without a signal, the planner rarely produces work.

  // Failing tests present — there's a concrete problem
  if (grounding?.failingTests?.length > 0) {
    return { score: 0.8, reason: "Codebase-health with failing tests present", tier: "heuristic" };
  }

  // Typecheck errors present
  if (grounding?.typecheckReport?.exitCode !== 0) {
    return { score: 0.7, reason: "Codebase-health with typecheck errors", tier: "heuristic" };
  }

  // TODO markers present — signals known gaps
  if (grounding?.todoMarkers?.length > 0) {
    return { score: 0.5, reason: `Codebase-health with ${grounding.todoMarkers.length} TODO markers`, tier: "heuristic" };
  }

  // No specific signal — historically 83% empty
  return { score: 0, reason: "Codebase-health with no specific signal (no failing tests, typecheck errors, or TODOs)", tier: "heuristic" };
}

function scoreIssueAnchor(anchor: any, grounding: any): AnchorScoreResult {
  // Issue anchors come from TODO/FIXME markers — verify markers still exist
  if (grounding?.todoMarkers?.length > 0) {
    return { score: 0.7, reason: "Issue anchor with active TODO/FIXME markers", tier: "heuristic" };
  }
  return { score: 0.3, reason: "Issue anchor but no TODO markers in grounding", tier: "heuristic" };
}

// ---------------------------------------------------------------------------
// Tier 2: Nano-model classifier (cheap, for ambiguous heuristic scores)
// ---------------------------------------------------------------------------

async function runClassifier(
  anchor: any,
  grounding: any,
  heuristicResult: AnchorScoreResult,
): Promise<AnchorScoreResult> {
  const prompt = `You are a build-cycle quality gate. Given an anchor and grounding context, predict whether this anchor is likely to produce a mergeable task.

Anchor type: ${anchor.type}
Anchor reference: ${anchor.reference}
Heuristic score: ${heuristicResult.score}
Heuristic reason: ${heuristicResult.reason}
Grounding summary:
- Tests: ${grounding?.testReport?.passed || 0} passing, ${grounding?.testReport?.failed || 0} failing
- Typecheck: ${grounding?.typecheckReport?.exitCode === 0 ? "clean" : "errors"}
- TODO markers: ${grounding?.todoMarkers?.length || 0}

Respond with ONLY a JSON object (no markdown): {"score": <0.0-1.0>, "reason": "<one sentence justification>"}`;

  try {
    const result = await runAgent({
      agentName: "anchor-scorer",
      personality: null,
      prompt,
      model: "nano",
      taskId: null,
      correlationId: null,
      workDir: null,
    });

    if (result.exitCode !== 0 || !result.output) {
      console.error(`[AnchorScorer] Classifier returned exit ${result.exitCode} — falling back to heuristic`);
      return heuristicResult;
    }

    // Parse classifier output — extract JSON from response
    const jsonMatch = result.output.match(/\{[\s\S]*?"score"\s*:\s*[\d.]+[\s\S]*?\}/);
    if (!jsonMatch) {
      console.error("[AnchorScorer] Classifier output not valid JSON — falling back to heuristic");
      return heuristicResult;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const score = Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
    const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "Classifier provided no reason";

    return { score, reason, tier: "classifier" };
  } catch (err: any) {
    console.error(`[AnchorScorer] Classifier failed: ${err.message} — falling back to heuristic`);
    return heuristicResult;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score an anchor's confidence of producing a mergeable task.
 *
 * Two tiers:
 *   1. Deterministic heuristics (free, instant) — always runs
 *   2. Nano-model classifier — only for ambiguous heuristic scores (0.3–0.7)
 *
 * Never throws — returns a result object.
 */
export async function scoreAnchor(
  anchor: any,
  grounding: any,
): Promise<AnchorScoreResult> {
  // Tier 1: deterministic heuristics
  const heuristic = scoreHeuristic(anchor, grounding);

  // Tier 2: classifier for ambiguous scores only
  if (heuristic.score > CLASSIFIER_LOW && heuristic.score < CLASSIFIER_HIGH) {
    console.log(`[AnchorScorer] Ambiguous heuristic score ${heuristic.score} for [${anchor?.type}] — running classifier`);
    return runClassifier(anchor, grounding, heuristic);
  }

  return heuristic;
}

/**
 * Record the calibration outcome after a cycle completes.
 * Stores the predicted confidence vs actual outcome for ongoing calibration.
 */
export async function recordCalibrationOutcome(
  cycleId: string,
  anchor: any,
  scoreResult: AnchorScoreResult,
  actualOutcome: "merged" | "failed" | "abandoned" | "no-task",
): Promise<void> {
  try {
    const r = getTracker().redis;
    const key = redisKeys.anchorCalibration(cycleId);
    await r.set(
      key,
      JSON.stringify({
        cycleId,
        anchorType: anchor?.type,
        anchorReference: anchor?.reference,
        predictedScore: scoreResult.score,
        tier: scoreResult.tier,
        reason: scoreResult.reason,
        actualOutcome,
        recordedAt: new Date().toISOString(),
      }),
      "EX",
      30 * 24 * 60 * 60, // 30-day TTL
    );
    await r.zadd(redisKeys.anchorCalibrationIndex(), Date.now(), cycleId);
  } catch (err: any) {
    console.error(`[AnchorScorer] Failed to record calibration outcome: ${err.message}`);
  }
}

/**
 * The configured minimum confidence threshold.
 */
export function getMinConfidence(): number {
  return ANCHOR_MIN_CONFIDENCE;
}
