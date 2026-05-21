// ---------------------------------------------------------------------------
// /api/anchor — anchor-selection visibility endpoint
// ---------------------------------------------------------------------------
//
// Issue #424. Exposes the priority waterfall in `src/anchor-selection.ts` as
// a ranked list of work candidates with 0-1 confidence scores, so the
// upcoming `decide.py` decision brain (issue #426) can decide what to work
// on without re-implementing the chain. This endpoint is read-only and does
// NOT mutate Redis state — in particular it does not consume work-queue
// items or claim Kanban items. selectAnchor() remains the only path that
// actually claims work.
//
// Score derivation lives in `src/anchor-selection/scorer.ts` (pure helper).
// This file's job is to (a) enumerate candidates from each data source the
// priority chain consults, (b) load the signals needed to score each
// candidate, and (c) sort + slice the result.

import { Router } from "express";
import {
  scoreCandidate,
  type PriorityTier,
  type ScoreSignals,
} from "../anchor-selection.ts";
import {
  listRange,
  getWorkQueueItems,
  getString,
} from "../redis-adapter.ts";
import { _admin } from "../backlog.ts";
import { loadAnchorReflectionsRaw } from "../reflections/reflections.ts";
import {
  REFRAME_QUEUE,
  PRIOR_FAILURES_KEY,
  anchorKey as abandonmentCounterKey,
} from "../anchor-selection/constants.ts";

const { loadBacklog } = _admin;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const RESEARCH_THRESHOLD = 0.5; // when no candidate scores >= this, recommend research
const RECENT_UNBLOCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

interface CandidateBase {
  /**
   * Stable identifier for the candidate. For Kanban / spec / prior-failure
   * items this is the backlog item ID or task ID. For work-queue items
   * derived from research, it's the reference string. The decide.py side
   * uses this to dedupe across ticks.
   */
  issue: string | number;
  title: string;
  priority_tier: PriorityTier;
  last_updated: string | null;
  /** Anchor reference used for Redis lookups (abandonment counter, reflections). */
  anchorRef: string;
  /** Source-specific extras included in the output for visibility. */
  extras?: Record<string, any>;
  /** True when this candidate was recently unblocked (blocker just cleared). */
  blockerJustCleared?: boolean;
}

interface ScoredCandidate {
  issue: string | number;
  title: string;
  score: number;
  priority_tier: PriorityTier;
  reasons: string[];
  abandonments: number;
  last_updated: string | null;
}

export function createAnchorRouter() {
  const router = Router();

  // GET /api/anchor/candidates?limit=N
  router.get("/anchor/candidates", async (req, res) => {
    try {
      const requestedLimit = parseInt(String(req.query.limit ?? ""), 10);
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

      const candidates: CandidateBase[] = [];
      const now = Date.now();

      // ---------------------------------------------------------------------
      // Source 1: Kanban backlog/queued/inProgress lanes
      // ---------------------------------------------------------------------
      try {
        const lanes = await loadBacklog();
        const kanbanLanes: Array<[string, PriorityTier]> = [
          // inProgress items first — they were the most recently claimed and
          // remain valid candidates if they get released back.
          ["inProgress", "kanban-queued"],
          ["queued", "kanban-queued"],
          ["backlog", "kanban-queued"],
        ];
        for (const [lane, tier] of kanbanLanes) {
          const items = (lanes as any)[lane] || [];
          for (const item of items) {
            const blocker = isBlockerJustCleared(item, now);
            candidates.push({
              issue: item.id,
              title: item.title,
              priority_tier: tier,
              last_updated: item.movedAt || item.meta?.addedAt || null,
              anchorRef: item.title,
              blockerJustCleared: blocker,
              extras: { lane, priority: item.priority ?? 0 },
            });
          }
        }
      } catch (err: any) {
        console.error(`[AnchorAPI] Kanban enumeration failed: ${err.message}`);
      }

      // ---------------------------------------------------------------------
      // Source 2 (active specs) retired in issue #513.
      // ---------------------------------------------------------------------

      // ---------------------------------------------------------------------
      // Source 3: Work queue (POST /queue or research auto-queue)
      // ---------------------------------------------------------------------
      try {
        const raw = await getWorkQueueItems();
        for (const r of raw) {
          let item: any;
          try { item = JSON.parse(r); } catch { continue; }
          const ref = item.reference || item.description;
          if (!ref) continue;
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
        console.error(`[AnchorAPI] Work queue enumeration failed: ${err.message}`);
      }

      // ---------------------------------------------------------------------
      // Source 4: Reframe queue
      // ---------------------------------------------------------------------
      try {
        const rawItems = await listRange(REFRAME_QUEUE, 0, -1);
        for (const r of rawItems) {
          let item: any;
          try { item = JSON.parse(r); } catch { continue; }
          const ref = item.anchorReference || item.originalTaskId || item.originalTitle;
          if (!ref) continue;
          candidates.push({
            issue: item.originalTaskId || ref,
            title: item.originalTitle || ref,
            priority_tier: "reframe-queue",
            last_updated: item.escalatedAt || null,
            anchorRef: ref,
            extras: { totalAttempts: item.totalAttempts, lastReason: item.lastReason },
          });
        }
      } catch (err: any) {
        console.error(`[AnchorAPI] Reframe queue enumeration failed: ${err.message}`);
      }

      // ---------------------------------------------------------------------
      // Source 5: Prior failures
      // ---------------------------------------------------------------------
      try {
        const rawItems = await listRange(PRIOR_FAILURES_KEY, 0, -1);
        for (const r of rawItems) {
          let item: any;
          try { item = JSON.parse(r); } catch { continue; }
          if (!item.taskId) continue;
          candidates.push({
            issue: item.taskId,
            title: item.title || item.taskId,
            priority_tier: "prior-failure",
            last_updated: item.timestamp || null,
            anchorRef: item.taskId,
            extras: { retryCount: item.retryCount, reason: item.reason },
          });
        }
      } catch (err: any) {
        console.error(`[AnchorAPI] Prior failures enumeration failed: ${err.message}`);
      }

      // ---------------------------------------------------------------------
      // Score each candidate
      // ---------------------------------------------------------------------
      const scored: ScoredCandidate[] = [];
      for (const c of candidates) {
        const abandonments = await loadAbandonments(c.anchorRef);
        const lastReflectionAt = await loadLastReflectionAt(c.anchorRef);

        const signals: ScoreSignals = {
          priorityTier: c.priority_tier,
          lastUpdated: c.last_updated,
          abandonments,
          lastReflectionAt,
          blockerJustCleared: c.blockerJustCleared,
          now,
        };
        const { score, reasons } = scoreCandidate(c, signals);

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
          abandonments,
          last_updated: c.last_updated,
        });
      }

      // Sort by score desc, tiebreak by tier priority (already encoded in score)
      // then by last_updated desc (fresher first).
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const at = a.last_updated ? new Date(a.last_updated).getTime() : 0;
        const bt = b.last_updated ? new Date(b.last_updated).getTime() : 0;
        return bt - at;
      });

      const top = scored.slice(0, limit);
      const research_recommended = top.length === 0 || top[0].score < RESEARCH_THRESHOLD;

      res.json({
        candidates: top,
        research_recommended,
        total_evaluated: scored.length,
        generated_at: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error(`[AnchorAPI] /anchor/candidates failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect a recently-cleared blocker. A backlog item is "blocker just cleared"
 * when its meta still carries a blockedReason (it WAS blocked) but its
 * current lane is no longer "blocked", AND the most recent lane transition
 * (movedAt) is within the last 24h. This catches dependency-merge cascades
 * where the operator (or hydra-sweep) re-opens a blocked item.
 */
function isBlockerJustCleared(item: any, now: number): boolean {
  if (!item?.meta?.blockedReason) return false;
  if (item.lane === "blocked") return false;
  if (!item.movedAt) return false;
  const movedAt = new Date(item.movedAt).getTime();
  if (!Number.isFinite(movedAt)) return false;
  return (now - movedAt) < RECENT_UNBLOCK_THRESHOLD_MS;
}

/**
 * Load the abandonment counter for an anchor reference. Returns 0 when no
 * counter is present (the common case for first-attempt items).
 */
async function loadAbandonments(anchorRef: string): Promise<number> {
  try {
    const raw = await getString(abandonmentCounterKey(anchorRef));
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch (err: any) {
    console.error(`[AnchorAPI] abandonment load failed for "${anchorRef.slice(0, 60)}": ${err.message}`);
    return 0;
  }
}

/**
 * Load the most recent reflection timestamp for an anchor reference, or
 * null when none exist. Uses the existing learning/reflections.ts adapter
 * — no new direct Redis access.
 */
async function loadLastReflectionAt(anchorRef: string): Promise<string | null> {
  try {
    const reflections = await loadAnchorReflectionsRaw(anchorRef);
    if (reflections.length === 0) return null;
    // Reflections are stored oldest-first; the last entry is most recent.
    const latest = reflections[reflections.length - 1];
    return latest.timestamp || null;
  } catch (err: any) {
    console.error(`[AnchorAPI] reflection load failed for "${anchorRef.slice(0, 60)}": ${err.message}`);
    return null;
  }
}
