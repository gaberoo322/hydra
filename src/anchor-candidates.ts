// ---------------------------------------------------------------------------
// Candidate Feed — the single deep module that owns "pick the next anchor".
// ---------------------------------------------------------------------------
//
// ADR-0016. This replaces the retired `selectAnchor()` priority waterfall.
// The live concept is a *Candidate Feed*: ranked, scored data the decision
// brain (`decide.py`) reads at `GET /api/anchor/candidates`. It is DATA, not
// a decision — retry / escalation / abandonment policy belongs to decide.py
// per ADR-0012, not to this module.
//
// One interface — `getCandidateFeed(opts, deps?)` — owns all three concerns
// that used to be scattered across the 20-file anchor-selection family and a
// parallel re-implementation in `api/anchor.ts`:
//
//   1. Enumeration — the only two lanes with live writers:
//        - backlog kanban (`loadBacklog`)  — inProgress ∪ queued ∪ backlog
//        - work-queue     (`getWorkQueueItems`)
//      The retired reframe / prior-failure / abandonment lanes are gone
//      (ADR-0016: they were never written in production).
//
//   2. Scoring — tier base + freshness penalty + recent-reflection penalty +
//      blocker-just-cleared bonus, clamped to [0,1]. The abandonment penalty
//      is DROPPED (dead lane). The `PriorityTier` union is the two live
//      values only: `kanban-queued`, `work-queue`.
//
//   3. Eligibility — in-flight-PR 30-min suppression, merged-by-cycle
//      suppression (issue #882), blocker-just-cleared detection,
//      design-concept annotation, and the research_recommended threshold.
//
// The route over this module (`src/api/anchor.ts`) is thin: parse query →
// `getCandidateFeed` → add `generated_at` → `res.json`.
//
// `deps` is injectable so the feed is the test surface: stub `loadBacklog`,
// `getWorkQueueItems`, reflection lookups, the design-concept reader, and the
// clock to exercise enumeration + scoring + eligibility end-to-end without a
// Redis fixture.

import { getTargetGithubRepo } from "./target-config.ts";
import { execFileViaSeam } from "./github/exec-file-compat.ts";
import { getWorkQueueItems } from "./redis/work-queue.ts";
import { loadBacklog } from "./backlog/reads.ts";
import { loadAnchorReflectionsRaw } from "./reflections/reflections.ts";
import {
  getDesignConcept,
  gateCheck,
  isFresh as isDesignConceptFresh,
  type DesignConcept,
} from "./design-concept.ts";

// ---------------------------------------------------------------------------
// Scoring policy — the tier ladder + penalty/bonus weights.
// ---------------------------------------------------------------------------

/**
 * The two live priority tiers. ADR-0016 shrank this union from the 11-tier
 * waterfall to the only lanes that have a live writer: Kanban-queued items and
 * the operator/research work-queue.
 */
export type PriorityTier = "kanban-queued" | "work-queue";

/**
 * Base score for each live tier. Higher = more deserving of attention.
 * Calibrated so a fresh kanban / work-queue item scores well above the
 * research threshold (0.5) while still leaving room for penalties, and so an
 * empty board flips `research_recommended` to true.
 */
export const PRIORITY_TIER_BASE_SCORE: Record<PriorityTier, number> = {
  "kanban-queued": 0.85,
  "work-queue":    0.70,
};

const RESEARCH_THRESHOLD = 0.5; // top score below this → recommend research
const FRESHNESS_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const RECENT_REFLECTION_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const FRESHNESS_PENALTY = 0.15;
const REFLECTION_PENALTY = 0.20;
const BLOCKER_CLEARED_BONUS = 0.15;
const RECENT_UNBLOCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// In-flight PR freshness window (issue #640). When an inProgress backlog item
// carries a `claimedBy = "pr-<number>"` marker claimed within this window, the
// candidate is hidden from the feed by default so decide.py doesn't re-dispatch
// onto an anchor whose PR is still awaiting CI + merge. 30 min covers the
// typical CI + operator-merge window while still surfacing genuinely stuck
// items (a PR left open overnight resurfaces the next day, ready to retry).
const IN_FLIGHT_PR_FRESHNESS_MS = 30 * 60 * 1000; // 30 min

// Merged-by-cycle suppression (issue #882). The in-flight window above hides
// anchors with a *fresh, still-open* PR claim, but a claude dev-cycle that
// merges its work leaves NO lingering open PR — the `claimedBy = "pr-<n>"`
// marker is on a closed/merged PR, or the work merged via a target-tree commit
// with no kanban claim at all. Those shipped items kept resurfacing at the top
// of the feed (score 0.85), starving dev_target and tricking research into
// re-promoting completed work. We now also suppress any candidate whose
// identity matches a recently-MERGED PR (orchestrator OR target repo). The
// lookback window is wide enough to cover the period a stale work-queue /
// kanban entry can linger after its work shipped, but bounded so the merged-PR
// scan stays cheap.
const MERGED_LOOKBACK_DAYS = 30;
// How many recent merged PRs to scan per repo. The maker-stack staleness in
// #882 surfaced from items merged within the last few dozen PRs; 100 gives a
// comfortable margin without an unbounded `gh` page walk.
const MERGED_PR_SCAN_LIMIT = 100;
// TTL-bounded cache for the merged-PR scan (issue #882, QA remediation). The
// route `/api/anchor/candidates` is on the decide.py hot path; without a cache
// every request shelled out to `gh pr list` twice (once per repo, 15s timeout
// each) synchronously. A 60s in-memory TTL collapses the burst of polls a
// single decide.py tick fires into one scan while still picking up freshly
// merged PRs within a minute. Mirrors the `CACHE_TTL_MS` idiom in
// `src/cost/usage-tracker.ts`. The merged set is small (token strings) and the
// staleness window is bounded, so an in-memory cache is safe across requests.
const MERGED_SCAN_CACHE_TTL_MS = 60_000;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export interface ScoreSignals {
  /** Tier the candidate belongs to. */
  priorityTier: PriorityTier;
  /** ISO timestamp of the candidate's most recent update (movedAt, queuedAt, …). */
  lastUpdated?: string | null;
  /**
   * Most recent reflection timestamp (ISO) for this anchor's reference, if any.
   * A recent (<24h) reflection means the anchor was tried and failed lately —
   * downscore so the brain doesn't immediately re-pick a just-failed anchor.
   */
  lastReflectionAt?: string | null;
  /**
   * True when the anchor was recently unblocked: a `blockedReason` is present
   * in meta but the lane is no longer "blocked" AND movedAt is within 24h.
   * Upscore — a dependency just cleared.
   */
  blockerJustCleared?: boolean;
  /** Override of "now" for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

export interface ScoreResult {
  score: number;
  reasons: string[];
}

/**
 * Score a candidate anchor on a 0-1 scale. Pure — pass the tier and observable
 * signals; returns the score plus human-readable reasons.
 *
 * Degrades gracefully (returns 0, never throws) on an unknown tier so the feed
 * keeps serving.
 */
export function scoreCandidate(signals: ScoreSignals): ScoreResult {
  const reasons: string[] = [];
  const base = PRIORITY_TIER_BASE_SCORE[signals.priorityTier];

  if (base === undefined) {
    console.error(`[CandidateFeed] Unknown priority tier: ${signals.priorityTier}`);
    return { score: 0, reasons: ["unknown-tier"] };
  }

  let score = base;
  reasons.push(`tier:${signals.priorityTier}(+${base.toFixed(2)})`);

  const now = signals.now ?? Date.now();

  // Freshness penalty
  if (signals.lastUpdated) {
    const ageMs = now - new Date(signals.lastUpdated).getTime();
    if (Number.isFinite(ageMs) && ageMs > FRESHNESS_THRESHOLD_MS) {
      score -= FRESHNESS_PENALTY;
      const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
      reasons.push(`stale:${ageDays}d(-${FRESHNESS_PENALTY.toFixed(2)})`);
    } else {
      reasons.push("fresh");
    }
  }

  // Recent reflection penalty
  if (signals.lastReflectionAt) {
    const age = now - new Date(signals.lastReflectionAt).getTime();
    if (Number.isFinite(age) && age < RECENT_REFLECTION_THRESHOLD_MS) {
      score -= REFLECTION_PENALTY;
      reasons.push(`recent-failure(-${REFLECTION_PENALTY.toFixed(2)})`);
    }
  }

  // Blocker-just-cleared bonus
  if (signals.blockerJustCleared) {
    score += BLOCKER_CLEARED_BONUS;
    reasons.push(`blocker-cleared(+${BLOCKER_CLEARED_BONUS.toFixed(2)})`);
  }

  // Clamp to [0, 1]
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Per-candidate design-concept annotation (issue #628).
// ---------------------------------------------------------------------------

/**
 * Design-concept annotation surfaced per candidate. decide.py's
 * `design_concept_orch` selector consumes this block:
 *   - present  — artifact exists in `hydra:design-concept:{anchorRef}`
 *   - isFresh  — within DESIGN_CONCEPT_MAX_AGE_MS of createdAt
 *   - status   — `draft` | `approved` | `stale` | null (when absent)
 *   - gateOk   — `gateCheck(d, now).ok`
 */
export interface CandidateDesignConcept {
  present: boolean;
  isFresh: boolean;
  status: "draft" | "approved" | "stale" | null;
  gateOk: boolean;
}

// ---------------------------------------------------------------------------
// Public result shapes.
// ---------------------------------------------------------------------------

export interface ScoredCandidate {
  issue: string | number;
  title: string;
  score: number;
  priority_tier: PriorityTier;
  reasons: string[];
  last_updated: string | null;
  /** Anchor reference used for Redis lookups — surfaced so decide.py can
   *  stamp the dispatch with the canonical key. */
  anchorRef: string;
  designConcept: CandidateDesignConcept;
}

export interface CandidateFeed {
  candidates: ScoredCandidate[];
  research_recommended: boolean;
  total_evaluated: number;
  in_flight_suppressed: number;
  /**
   * Count of candidates suppressed because their work already MERGED with no
   * lingering open PR (issue #882). Parallel to `in_flight_suppressed`, which
   * only covers anchors with a fresh open-PR claim.
   */
  merged_suppressed: number;
}

export interface GetCandidateFeedOpts {
  /** Max candidates returned (1..MAX_LIMIT). Defaults to DEFAULT_LIMIT. */
  limit?: number;
  /** Suppress inProgress items with a fresh `pr-<n>` claim. Defaults to true. */
  excludeInFlight?: boolean;
  /**
   * Suppress candidates whose work already MERGED with no open PR (issue #882).
   * Defaults to true. Callers that need the raw view pass excludeMerged=false.
   */
  excludeMerged?: boolean;
  /** Override of "now" for deterministic tests. Defaults to Date.now(). */
  now?: number;
}

/**
 * Injectable dependencies — the test surface. Stub any subset; the rest fall
 * back to the production adapters. A failing reflection / design-concept read
 * degrades that one field; it never drops a candidate (ADR-0016 invariant).
 */
export interface CandidateFeedDeps {
  loadBacklog: () => Promise<Record<string, any[]>>;
  getWorkQueueItems: () => Promise<string[]>;
  loadLastReflectionAt: (anchorRef: string) => Promise<string | null>;
  loadDesignConcept: (anchorRef: string, now: number) => Promise<CandidateDesignConcept>;
  /**
   * Return the set of normalized identifiers for work that already MERGED
   * within the lookback window, with no lingering open PR (issue #882). Each
   * entry is a normalized token a candidate identity can match against:
   * issue numbers (`"882"`), item references (`"item-322"`), and normalized
   * PR titles. Must never throw — an unreachable VCS/`gh` degrades to an empty
   * set (suppress nothing) so the feed keeps serving.
   */
  loadMergedAnchorRefs: () => Promise<Set<string>>;
}

// ---------------------------------------------------------------------------
// Internal enumeration shape.
// ---------------------------------------------------------------------------

interface CandidateBase {
  issue: string | number;
  title: string;
  priority_tier: PriorityTier;
  last_updated: string | null;
  anchorRef: string;
  extras?: Record<string, any>;
  blockerJustCleared?: boolean;
}

const ABSENT_DESIGN_CONCEPT: CandidateDesignConcept = {
  present: false,
  isFresh: false,
  status: null,
  gateOk: false,
};

/**
 * Production reflection reader. Returns the most recent reflection timestamp
 * for an anchor reference, or null. Never throws.
 */
async function loadLastReflectionAtImpl(anchorRef: string): Promise<string | null> {
  try {
    const reflections = await loadAnchorReflectionsRaw(anchorRef);
    if (reflections.length === 0) return null;
    // Reflections are stored oldest-first; the last entry is most recent.
    const latest = reflections[reflections.length - 1];
    return latest.timestamp || null;
  } catch (err: any) {
    console.error(`[CandidateFeed] reflection load failed for "${anchorRef.slice(0, 60)}": ${err.message}`);
    return null;
  }
}

/**
 * Production design-concept reader + projection. Always returns a fully
 * populated block (even when no artifact exists). On any Redis failure returns
 * the "no artifact" projection rather than throwing — a failing annotation
 * must NEVER drop a candidate from the feed.
 */
async function loadDesignConceptImpl(
  anchorRef: string,
  now: number,
): Promise<CandidateDesignConcept> {
  if (!anchorRef) return ABSENT_DESIGN_CONCEPT;
  try {
    const dc: DesignConcept | null = await getDesignConcept(anchorRef);
    if (!dc) return ABSENT_DESIGN_CONCEPT;
    const fresh = isDesignConceptFresh(dc, now);
    const gate = gateCheck(dc, now);
    return {
      present: true,
      isFresh: fresh,
      // `stale` is a derived label: artifact exists but aged out of freshness.
      status: fresh ? dc.status : "stale",
      gateOk: gate.ok,
    };
  } catch (err: any) {
    console.error(
      `[CandidateFeed] design-concept load failed for "${anchorRef.slice(0, 60)}": ${err.message}`,
    );
    return ABSENT_DESIGN_CONCEPT;
  }
}

// ---------------------------------------------------------------------------
// Merged-by-cycle reader (issue #882).
// ---------------------------------------------------------------------------

// The production default routes the merged-PR scan through the GitHub CLI
// Adapter seam (issue #899). The `exec` parameter on loadMergedAnchorRefsImpl
// remains the injectable test seam — this only changes the default.
const execFile = execFileViaSeam;

// The orchestrator's own repo. A literal is fine here — Hydra IS this repo, so
// it is not a swappable target (mirrors `ORCHESTRATOR_REPO` in
// `src/autopilot/pr-lifecycle-bridge.ts`). The TARGET repo, by contrast, MUST
// resolve through the swap seam (`getTargetGithubRepo()`) per ADR-0013.
const ORCHESTRATOR_REPO = "gaberoo322/hydra";

/**
 * Repos whose merged PRs can ship a candidate's work. The orchestrator board
 * (`dev_orch`) and the target board (`dev_target`) both feed the candidate
 * feed, so both repos are scanned (issue #882: "applies to both orch and
 * target candidate surfaces"). Resolved at CALL TIME — the target repo flows
 * through the `target-config.ts` swap seam (ADR-0013/ADR-0002) rather than a
 * hardcoded literal, so the merged-scan follows a target swap. Mirrors
 * `defaultRepos()` in `src/autopilot/pr-lifecycle-bridge.ts`.
 */
function mergedScanRepos(): readonly string[] {
  return [ORCHESTRATOR_REPO, getTargetGithubRepo()];
}

/**
 * Pure helper — exported for tests. Build the normalized identifier token-set
 * a merged PR contributes to the suppression set. A candidate is suppressed
 * when ANY of its identity tokens (see `candidateMergedTokens`) intersects this
 * set. We harvest:
 *   - every `#NNN` issue reference in the PR title + body (so a `Closes #882`
 *     marks issue 882's anchor merged),
 *   - every `item-NNN` reference (the target work-queue identity),
 *   - the normalized PR title itself (so a kanban anchor whose title equals the
 *     PR title is caught even without an explicit issue ref).
 */
export function mergedTokensFromPr(title: string, body: string): string[] {
  const tokens = new Set<string>();
  const haystack = `${title || ""}\n${body || ""}`;
  for (const m of haystack.matchAll(/#(\d+)\b/g)) tokens.add(m[1]);
  for (const m of haystack.matchAll(/\bitem-(\d+)\b/gi)) tokens.add(`item-${m[1]}`);
  const normTitle = normalizeIdentity(title);
  if (normTitle) tokens.add(normTitle);
  return [...tokens];
}

/**
 * Pure helper — exported for tests. Normalize a free-text identity for
 * comparison: lowercase, collapse whitespace, trim. Mirrors
 * `normalizeForDedup` in the work-queue adapter so the two dedup surfaces stay
 * consistent.
 */
export function normalizeIdentity(s: string): string {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Pure helper — exported for tests. Derive the identity tokens a candidate
 * matches against the merged-set. A candidate is "merged work" when any of
 * these is present in the merged-token set:
 *   - its `issue` field as a bare string (orchestrator issue number),
 *   - any `item-NNN` reference found in its issue/title/anchorRef,
 *   - its normalized title / anchorRef.
 */
export function candidateMergedTokens(c: {
  issue: string | number;
  title: string;
  anchorRef: string;
}): string[] {
  const tokens = new Set<string>();
  const issueStr = String(c.issue ?? "").trim();
  // A bare numeric issue id (kanban anchor) matches a `#NNN` merge ref.
  if (/^\d+$/.test(issueStr)) tokens.add(issueStr);
  const fields = [issueStr, c.title || "", c.anchorRef || ""];
  for (const f of fields) {
    for (const m of f.matchAll(/\bitem-(\d+)\b/gi)) tokens.add(`item-${m[1]}`);
    const norm = normalizeIdentity(f);
    if (norm) tokens.add(norm);
  }
  return [...tokens];
}

/**
 * Pure helper — exported for tests. True when the candidate's identity tokens
 * intersect the merged-work token set. Empty merged-set → never suppresses.
 */
export function isMergedWork(
  c: { issue: string | number; title: string; anchorRef: string },
  mergedRefs: ReadonlySet<string>,
): boolean {
  if (mergedRefs.size === 0) return false;
  for (const tok of candidateMergedTokens(c)) {
    if (mergedRefs.has(tok)) return true;
  }
  return false;
}

/**
 * TTL-bounded cache entry for the merged-PR scan (issue #882 QA remediation).
 * `null` until the first successful-or-empty scan. We cache the resolved token
 * set plus the wall-clock time it was stored so a burst of decide.py polls
 * within `MERGED_SCAN_CACHE_TTL_MS` reuses one `gh` round-trip.
 */
interface MergedScanCacheEntry {
  refs: Set<string>;
  storedAt: number;
}
let mergedScanCache: MergedScanCacheEntry | null = null;

/**
 * Test-only: clear the merged-scan TTL cache so each test observes a cold
 * fetch. Not for production use (the production path lets the TTL expire).
 */
export function __resetMergedScanCacheForTests(): void {
  mergedScanCache = null;
}

/**
 * Production merged-refs reader. Scans recent merged PRs on both the
 * orchestrator and target repos via `gh pr list --state merged`, harvesting
 * the normalized identity tokens each PR ships (`mergedTokensFromPr`). Never
 * throws — a `gh` failure on one repo logs and contributes nothing; total
 * failure yields an empty set (suppress nothing), exactly degrading to the
 * pre-#882 behaviour on a miss.
 *
 * TTL-bounded (issue #882 QA remediation): a fresh cache entry (younger than
 * `MERGED_SCAN_CACHE_TTL_MS`) short-circuits the `gh` shell-out so the hot
 * `/api/anchor/candidates` path doesn't fork `gh` on every request. Pass
 * `nowMs` for deterministic tests; defaults to `Date.now()`.
 *
 * Exported (with the injectable `exec` + `nowMs` seam) so the TTL-cache
 * behaviour is unit-testable without forking a real `gh`.
 */
export async function loadMergedAnchorRefsImpl(
  exec: typeof execFile = execFile,
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  if (mergedScanCache && nowMs - mergedScanCache.storedAt < MERGED_SCAN_CACHE_TTL_MS) {
    return mergedScanCache.refs;
  }

  const merged = new Set<string>();
  // gh's --search uses GitHub's `merged:>=YYYY-MM-DD` qualifier.
  const since = new Date(nowMs - MERGED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  for (const repo of mergedScanRepos()) {
    try {
      const { stdout } = await exec(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          repo,
          "--state",
          "merged",
          "--search",
          `merged:>=${since}`,
          "--limit",
          String(MERGED_PR_SCAN_LIMIT),
          "--json",
          "title,body",
        ],
        { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      );
      for (const tok of mergedTokensFromGhJson(stdout)) merged.add(tok);
    } catch (err: any) {
      console.error(
        `[CandidateFeed] merged-PR scan failed for ${repo}: ${err?.message || err}`,
      );
    }
  }
  // Cache even an empty/degraded result: a `gh` outage should not be retried
  // on every hot-path request within the TTL window. The set self-heals on the
  // next scan after the TTL expires.
  mergedScanCache = { refs: merged, storedAt: nowMs };
  return merged;
}

/**
 * Pure helper — exported for tests. Parse a `gh pr list --json title,body`
 * payload into the union of merged-identity tokens. Returns [] on any
 * structural problem (never throws).
 */
export function mergedTokensFromGhJson(jsonStdout: string): string[] {
  if (!jsonStdout || !jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = new Set<string>();
  for (const pr of parsed) {
    if (!pr || typeof pr !== "object") continue;
    const title = typeof (pr as any).title === "string" ? (pr as any).title : "";
    const body = typeof (pr as any).body === "string" ? (pr as any).body : "";
    for (const tok of mergedTokensFromPr(title, body)) out.add(tok);
  }
  return [...out];
}

function resolveDeps(deps?: Partial<CandidateFeedDeps>): CandidateFeedDeps {
  return {
    loadBacklog: deps?.loadBacklog ?? loadBacklog,
    getWorkQueueItems: deps?.getWorkQueueItems ?? getWorkQueueItems,
    loadLastReflectionAt: deps?.loadLastReflectionAt ?? loadLastReflectionAtImpl,
    loadDesignConcept: deps?.loadDesignConcept ?? loadDesignConceptImpl,
    loadMergedAnchorRefs: deps?.loadMergedAnchorRefs ?? (() => loadMergedAnchorRefsImpl()),
  };
}

// ---------------------------------------------------------------------------
// Eligibility helpers.
// ---------------------------------------------------------------------------

/**
 * Detect an in-flight PR claim on a backlog item (issue #640). The convention:
 * when a code-writing skill opens a PR for a kanban anchor it marks the item
 * `claimedBy = "pr-<number>"` so the next decide.py tick doesn't re-dispatch.
 * "Fresh" is bounded by IN_FLIGHT_PR_FRESHNESS_MS so a long-open PR eventually
 * resurfaces.
 */
function isInFlightPR(item: any, now: number): boolean {
  if (!item?.claimedBy) return false;
  if (typeof item.claimedBy !== "string") return false;
  if (!item.claimedBy.startsWith("pr-")) return false;
  if (!item.claimedAt) return false;
  const claimedAt = new Date(item.claimedAt).getTime();
  if (!Number.isFinite(claimedAt)) return false;
  return (now - claimedAt) < IN_FLIGHT_PR_FRESHNESS_MS;
}

/**
 * Detect a recently-cleared blocker: meta still carries a `blockedReason`
 * (it WAS blocked) but the current lane is no longer "blocked", AND the most
 * recent lane transition (movedAt) is within the last 24h.
 */
function isBlockerJustCleared(item: any, now: number): boolean {
  if (!item?.meta?.blockedReason) return false;
  if (item.lane === "blocked") return false;
  if (!item.movedAt) return false;
  const movedAt = new Date(item.movedAt).getTime();
  if (!Number.isFinite(movedAt)) return false;
  return (now - movedAt) < RECENT_UNBLOCK_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// The feed.
// ---------------------------------------------------------------------------

/**
 * Build the Candidate Feed: enumerate the two live lanes, score each candidate,
 * annotate with the design-concept block, sort by score desc (tiebreak by
 * freshness), slice to `limit`, and compute `research_recommended`.
 *
 * Never throws — enumeration failures on a single lane are logged and that lane
 * contributes nothing, the rest of the feed still builds.
 */
export async function getCandidateFeed(
  opts: GetCandidateFeedOpts = {},
  deps?: Partial<CandidateFeedDeps>,
): Promise<CandidateFeed> {
  const d = resolveDeps(deps);
  const now = opts.now ?? Date.now();
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0
    ? Math.min(opts.limit as number, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const excludeInFlight = opts.excludeInFlight !== false; // defaults to true
  const excludeMerged = opts.excludeMerged !== false; // defaults to true

  // Load the merged-work token set once up front (issue #882). A failing /
  // unreachable reader degrades to an empty set — suppress nothing, exactly the
  // pre-#882 behaviour — and never aborts the feed.
  let mergedRefs: Set<string> = new Set();
  if (excludeMerged) {
    try {
      mergedRefs = await d.loadMergedAnchorRefs();
    } catch (err: any) {
      console.error(`[CandidateFeed] merged-refs load failed: ${err.message}`);
      mergedRefs = new Set();
    }
  }

  const candidates: CandidateBase[] = [];
  let inFlightSuppressed = 0;
  let mergedSuppressed = 0;

  // -------------------------------------------------------------------------
  // Lane 1: Kanban backlog/queued/inProgress lanes.
  // -------------------------------------------------------------------------
  try {
    const lanes = await d.loadBacklog();
    const kanbanLanes: Array<[string, PriorityTier]> = [
      // inProgress items first — most recently claimed, still valid if released.
      ["inProgress", "kanban-queued"],
      ["queued", "kanban-queued"],
      ["backlog", "kanban-queued"],
    ];
    for (const [lane, tier] of kanbanLanes) {
      const items = (lanes as any)[lane] || [];
      for (const item of items) {
        if (excludeInFlight && isInFlightPR(item, now)) {
          inFlightSuppressed++;
          continue;
        }
        if (
          excludeMerged &&
          isMergedWork(
            { issue: item.id, title: item.title ?? "", anchorRef: item.title ?? "" },
            mergedRefs,
          )
        ) {
          mergedSuppressed++;
          continue;
        }
        candidates.push({
          issue: item.id,
          title: item.title,
          priority_tier: tier,
          last_updated: item.movedAt || item.meta?.addedAt || null,
          anchorRef: item.title,
          blockerJustCleared: isBlockerJustCleared(item, now),
          extras: { lane, priority: item.priority ?? 0 },
        });
      }
    }
  } catch (err: any) {
    console.error(`[CandidateFeed] Kanban enumeration failed: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Lane 2: Work queue (POST /queue or research auto-queue).
  // -------------------------------------------------------------------------
  try {
    const raw = await d.getWorkQueueItems();
    for (const r of raw) {
      let item: any;
      try { item = JSON.parse(r); } catch { continue; }
      const ref = item.reference || item.description;
      if (!ref) continue;
      if (
        excludeMerged &&
        isMergedWork({ issue: ref, title: ref, anchorRef: ref }, mergedRefs)
      ) {
        mergedSuppressed++;
        continue;
      }
      candidates.push({
        issue: ref,
        title: ref,
        priority_tier: "work-queue",
        last_updated: item.queuedAt || null,
        anchorRef: ref,
        extras: { source: item.source || "operator", reason: item.reason },
      });
    }
  } catch (err: any) {
    console.error(`[CandidateFeed] Work queue enumeration failed: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Score + annotate each candidate.
  // -------------------------------------------------------------------------
  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    // A failing annotation degrades that one field — it must NEVER drop a
    // candidate (ADR-0016 invariant). The production readers already catch
    // internally; wrapping here also shields against an injected dep that
    // throws, so the feed seam keeps the invariant regardless of the dep.
    let lastReflectionAt: string | null = null;
    try {
      lastReflectionAt = await d.loadLastReflectionAt(c.anchorRef);
    } catch (err: any) {
      console.error(`[CandidateFeed] reflection annotation failed for "${c.anchorRef.slice(0, 60)}": ${err.message}`);
    }
    let designConcept: CandidateDesignConcept = ABSENT_DESIGN_CONCEPT;
    try {
      designConcept = await d.loadDesignConcept(c.anchorRef, now);
    } catch (err: any) {
      console.error(`[CandidateFeed] design-concept annotation failed for "${c.anchorRef.slice(0, 60)}": ${err.message}`);
    }

    const { score, reasons } = scoreCandidate({
      priorityTier: c.priority_tier,
      lastUpdated: c.last_updated,
      lastReflectionAt,
      blockerJustCleared: c.blockerJustCleared,
      now,
    });

    // Surface extras alongside structured reasons for operator visibility.
    if (c.extras) {
      for (const [k, v] of Object.entries(c.extras)) {
        if (v !== undefined && v !== null && v !== "") {
          reasons.push(`${k}:${String(v).slice(0, 40)}`);
        }
      }
    }

    scored.push({
      issue: c.issue,
      title: c.title,
      score: Math.round(score * 1000) / 1000,
      priority_tier: c.priority_tier,
      reasons,
      last_updated: c.last_updated,
      anchorRef: c.anchorRef,
      designConcept,
    });
  }

  // Sort by score desc, tiebreak by last_updated desc (fresher first).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.last_updated ? new Date(a.last_updated).getTime() : 0;
    const bt = b.last_updated ? new Date(b.last_updated).getTime() : 0;
    return bt - at;
  });

  const top = scored.slice(0, limit);
  const research_recommended = top.length === 0 || top[0].score < RESEARCH_THRESHOLD;

  return {
    candidates: top,
    research_recommended,
    total_evaluated: scored.length,
    in_flight_suppressed: inFlightSuppressed,
    merged_suppressed: mergedSuppressed,
  };
}
