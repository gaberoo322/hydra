/**
 * Anchor Confidence Scorer — predicts whether an anchor will produce a
 * mergeable task before calling the planner.
 *
 * Two-tier deterministic scoring (issue #346):
 *   Tier 1: Type-based heuristic baseline (free, instant, pure)
 *   Tier 2: Deterministic refinement on ambiguous baselines (0.3–0.7) using:
 *     - anchor research-score (if present on the anchor)
 *     - prior-failure retry count (older retries weighted lower)
 *     - priorities.md keyword overlap (alignment with current direction)
 *     - reframe-queue presence (escalated work gets a small bump)
 *
 * Phase A of the codex-removal refactor: this used to call a nano-model
 * classifier via `runAgent` from codex-runner. The classifier returned ~$0.001
 * per anchor and was non-deterministic, which made tests fragile and audit
 * trails noisy. Anchor scoring is a weighted combination of known signals —
 * not a reasoning task — so we now derive the same shape entirely from data.
 *
 * Output shape is identical to the prior implementation so call sites are
 * unchanged: `{ score, reason, tier: "heuristic" | "classifier" }`. The
 * "classifier" tier is now produced by the deterministic refinement step (it
 * remains in the type union to preserve backward compatibility with stored
 * calibration data and logs).
 *
 * Never throws — returns a result object so callers decide how to handle.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setCalibrationOutcome } from "./redis-adapter.ts";

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

const REFINEMENT_LOW = 0.3;
const REFINEMENT_HIGH = 0.7;

// Refinement weight bounds. Each signal can shift the score by at most ±this
// fraction; combined refinement is clamped to [0, 1]. Kept small so the
// type-based heuristic remains the dominant signal.
const RESEARCH_SCORE_WEIGHT = 0.15;
const PRIOR_FAILURE_PENALTY = 0.05; // per attempt
const PRIOR_FAILURE_MAX_PENALTY = 0.20; // cap penalty contribution
const PRIORITIES_ALIGNMENT_BONUS = 0.10;
const REFRAME_QUEUE_BONUS = 0.05;

// ---------------------------------------------------------------------------
// Tier 1: Type-based heuristic scoring (pure)
// ---------------------------------------------------------------------------

/**
 * Score an anchor using deterministic heuristics only.
 * Pure function over the anchor + grounding — no I/O, no cost.
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
// Tier 2: Deterministic refinement (pure given inputs)
// ---------------------------------------------------------------------------

/**
 * Extract an anchor's research-score in [0, 1] from any of the locations
 * researchers may stash it. Returns null if no score is present.
 */
export function extractResearchScore(anchor: any): number | null {
  if (!anchor || typeof anchor !== "object") return null;
  const candidates: any[] = [
    anchor.researchScore,
    anchor.research_score,
    anchor.score,
    anchor.context?.researchScore,
    anchor.context?.research_score,
    anchor.context?.score,
  ];
  for (const raw of candidates) {
    if (raw == null) continue;
    const n = typeof raw === "number" ? raw : parseFloat(raw);
    if (Number.isFinite(n)) {
      // Accept either 0–1 or 0–100 ranges (researchers historically use both).
      if (n > 1 && n <= 100) return Math.max(0, Math.min(1, n / 100));
      return Math.max(0, Math.min(1, n));
    }
  }
  return null;
}

/**
 * Extract a prior-attempt count from an anchor. Returns 0 when nothing is
 * present (the safe default — we only penalise observed retries).
 */
export function extractPriorAttempts(anchor: any): number {
  if (!anchor || typeof anchor !== "object") return 0;
  const candidates: any[] = [
    anchor.priorFailureCount,
    anchor.priorAttempts,
    anchor.retryCount,
    anchor.attempts,
    anchor.totalAttempts,
    anchor.context?.priorFailureCount,
    anchor.context?.retryCount,
  ];
  for (const raw of candidates) {
    if (raw == null) continue;
    const n = typeof raw === "number" ? raw : parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 0;
}

/**
 * Token-overlap alignment with the live priorities.md (cached). Returns a
 * value in [0, 1] indicating fraction of priorities tokens that appear in the
 * anchor reference. Returns 0 when no priorities content is available.
 */
export function alignmentScore(reference: string, prioritiesContent: string | null): number {
  if (!reference || !prioritiesContent) return 0;
  const refTokens = simpleTokenSet(reference);
  if (refTokens.size === 0) return 0;
  const priorityTokens = priorityKeywords(prioritiesContent);
  if (priorityTokens.size === 0) return 0;
  let hits = 0;
  for (const tok of refTokens) {
    if (priorityTokens.has(tok)) hits++;
  }
  // Normalise by anchor reference length so a short reference matching one
  // priority keyword counts more than a long reference matching one.
  return hits / refTokens.size;
}

// Stopwords kept tiny and intentional — same minimal set used by the
// anchor-actionability gate so behavior stays consistent.
const STOPWORDS = new Set([
  "the", "and", "for", "from", "into", "with", "that", "this", "than", "then",
  "are", "was", "were", "have", "has", "had", "but", "not", "you", "your",
  "our", "their", "its", "ist", "use", "using", "based", "via", "per", "off",
  "out", "any", "all", "new", "old", "add", "fix", "make", "set", "get", "run",
  "to", "of", "in", "on", "is", "by", "at", "an", "a", "or", "be", "as", "it",
]);

function simpleTokenSet(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function priorityKeywords(content: string): Set<string> {
  // Use only the "# Priority tasks" section so completed entries don't bleed
  // into alignment scoring. Fall back to the whole doc if the section heading
  // isn't present (older priorities.md formats).
  const section = content.match(/#\s*Priority tasks[\s\S]*?(?=\n#\s|$)/i);
  const body = section ? section[0] : content;
  return simpleTokenSet(body);
}

/**
 * Apply deterministic refinement to an ambiguous heuristic score using the
 * extracted signals. Pure function — exported for direct testing.
 */
export function refineScore(
  heuristic: AnchorScoreResult,
  anchor: any,
  context: {
    prioritiesContent: string | null;
    reframeQueueDepth: number;
  },
): AnchorScoreResult {
  const adjustments: string[] = [];
  let score = heuristic.score;

  // Research score (centred on 0.5: above adds, below subtracts). A score of
  // exactly 0.5 is neutral and contributes nothing — don't promote to
  // classifier tier in that case.
  const research = extractResearchScore(anchor);
  if (research !== null && Math.abs(research - 0.5) > 1e-9) {
    const delta = (research - 0.5) * 2 * RESEARCH_SCORE_WEIGHT;
    score += delta;
    adjustments.push(`research-score ${research.toFixed(2)} (${delta >= 0 ? "+" : ""}${delta.toFixed(2)})`);
  }

  // Prior-failure penalty.
  const attempts = extractPriorAttempts(anchor);
  if (attempts > 0) {
    const penalty = Math.min(PRIOR_FAILURE_MAX_PENALTY, attempts * PRIOR_FAILURE_PENALTY);
    score -= penalty;
    adjustments.push(`${attempts} prior-attempt${attempts === 1 ? "" : "s"} (-${penalty.toFixed(2)})`);
  }

  // Priorities-doc alignment bonus.
  const reference = typeof anchor?.reference === "string" ? anchor.reference : "";
  const alignment = alignmentScore(reference, context.prioritiesContent);
  if (alignment > 0) {
    const bonus = alignment * PRIORITIES_ALIGNMENT_BONUS;
    score += bonus;
    adjustments.push(`priorities-alignment ${alignment.toFixed(2)} (+${bonus.toFixed(2)})`);
  }

  // Reframe-queue presence: small bump when the system already escalated this
  // work, signalling the operator-level interest is high.
  if (context.reframeQueueDepth > 0 && anchor?.type === "reframe") {
    score += REFRAME_QUEUE_BONUS;
    adjustments.push(`reframe-queue active (+${REFRAME_QUEUE_BONUS.toFixed(2)})`);
  }

  const clamped = Math.max(0, Math.min(1, score));

  if (adjustments.length === 0) {
    // No refinement signals fired — keep the heuristic result verbatim.
    return heuristic;
  }

  return {
    score: clamped,
    reason: `${heuristic.reason} | refined: ${adjustments.join(", ")}`,
    tier: "classifier",
  };
}

// ---------------------------------------------------------------------------
// Priorities.md reader (cached, never throws)
// ---------------------------------------------------------------------------

const PRIORITIES_CACHE_TTL_MS = 60_000;
let prioritiesCache: { content: string | null; loadedAt: number } | null = null;

/**
 * Cached read of `config/direction/priorities.md`. Returns `null` on any
 * error (the caller treats missing priorities content as "no alignment
 * signal"). Cache TTL is 60s so operator edits become visible within the
 * minute without re-reading the file on every cycle.
 *
 * Exported for tests that want to bust the cache.
 */
export function resetPrioritiesCache(): void {
  prioritiesCache = null;
}

async function loadPrioritiesContent(): Promise<string | null> {
  const now = Date.now();
  if (prioritiesCache && now - prioritiesCache.loadedAt < PRIORITIES_CACHE_TTL_MS) {
    return prioritiesCache.content;
  }
  try {
    const configDir = process.env.HYDRA_CONFIG_PATH || resolve(process.env.HOME!, "hydra", "config");
    const path = join(configDir, "direction", "priorities.md");
    const content = await readFile(path, "utf-8");
    prioritiesCache = { content, loadedAt: now };
    return content;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error(`[AnchorScorer] priorities.md read failed (proceeding without alignment): ${err?.message ?? err}`);
    }
    prioritiesCache = { content: null, loadedAt: now };
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reframe-queue depth lookup (best-effort, never throws)
// ---------------------------------------------------------------------------

async function loadReframeQueueDepth(): Promise<number> {
  try {
    // Dynamic import to keep the heuristic path free of redis startup cost
    // when only `scoreHeuristic` is exercised (the common case in tests).
    const adapter = await import("./redis-adapter.ts");
    const fn = (adapter as any).listLen ?? (adapter as any).llen;
    if (typeof fn !== "function") return 0;
    const depth = await fn("hydra:reframe:queue");
    return typeof depth === "number" && depth >= 0 ? depth : 0;
  } catch (err: any) {
    // Redis unavailable in tests/local — refinement just skips the reframe bump.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score an anchor's confidence of producing a mergeable task.
 *
 * Two tiers:
 *   1. Type-based heuristic (always)
 *   2. Deterministic refinement on ambiguous heuristic scores (0.3–0.7):
 *      research-score, prior-attempt penalty, priorities alignment, reframe
 *      presence. All signals are pure functions of available data — no LLM.
 *
 * Never throws — returns a result object.
 */
export async function scoreAnchor(
  anchor: any,
  grounding: any,
): Promise<AnchorScoreResult> {
  // Tier 1: deterministic type-based heuristic
  const heuristic = scoreHeuristic(anchor, grounding);

  // Tier 2: refinement only for ambiguous scores. Avoids unnecessary I/O
  // (priorities.md read, Redis lookup) when the heuristic is already
  // confident in either direction.
  if (heuristic.score <= REFINEMENT_LOW || heuristic.score >= REFINEMENT_HIGH) {
    return heuristic;
  }

  const [prioritiesContent, reframeQueueDepth] = await Promise.all([
    loadPrioritiesContent(),
    loadReframeQueueDepth(),
  ]);

  return refineScore(heuristic, anchor, { prioritiesContent, reframeQueueDepth });
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
    const data = JSON.stringify({
      cycleId,
      anchorType: anchor?.type,
      anchorReference: anchor?.reference,
      predictedScore: scoreResult.score,
      tier: scoreResult.tier,
      reason: scoreResult.reason,
      actualOutcome,
      recordedAt: new Date().toISOString(),
    });
    await setCalibrationOutcome(cycleId, data, 30 * 24 * 60 * 60);
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
