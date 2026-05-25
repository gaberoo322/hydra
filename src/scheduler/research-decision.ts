/**
 * scheduler/research-decision.ts — Pure decision function for "should the
 * scheduler run a research cycle right now?"
 *
 * Extracted from the 200-line `maybeRunResearch()` in scheduler/loop.ts so
 * the policy can be unit-tested independently of Redis, work-queue state,
 * and the research subagent itself. The decision is the part that gets
 * tweaked most often; concentrating it here is the depth payoff.
 *
 * Shape:
 *
 *     loadResearchSnapshot()      [I/O, in loop.ts]
 *     → decideResearchAction()    [pure, in this file]
 *     → executeResearchAction()   [I/O, in loop.ts]
 *
 * `ResearchAction` is a discriminated union. Each variant carries the
 * drivers that produced it so operators reading
 * `/api/scheduler/status.lastResearchDecision` (or the dashboard, or
 * logs) can see *why* without re-deriving from environment values.
 *
 * Guard evaluation order matches the legacy `maybeRunResearch` for
 * behavioural compatibility — operators with existing intuition about
 * the scheduler's mood see the same outcomes.
 */

/**
 * Verdict from the research-floor capacity policy
 * (`src/scheduler/research-floor.ts::shouldForceResearchFloor`). The
 * decision treats the floor as a soft-gate override — when the floor
 * fires, queue/ratio/watermark gates are bypassed.
 */
export interface FloorVerdict {
  shouldFire: boolean;
  reason: string | null;
}

/**
 * Inputs to the decision. Everything pure: counts, thresholds, last-run
 * timestamps. No Redis, no clock side-effects. The decision reads `nowMs`
 * from the snapshot rather than calling `Date.now()` so tests are
 * deterministic.
 */
export interface ResearchSnapshot {
  /** Operator force-once flag has been consumed for this tick. */
  forced: boolean;
  /** Live (orphan-filtered) work-queue depth. */
  queueLen: number;
  /** Raw LLEN of the work queue. */
  queueLenTotal: number;
  /** Items excluded from `queueLen` as orphans (legacy producers removed). */
  orphanLen: number;
  researchCount24h: number;
  buildCount24h: number;
  /** Convenience: `researchCount24h / buildCount24h`, or `researchCount24h`
   *  if `buildCount24h === 0`. */
  ratio: number;
  /** Capacity-floor verdict computed by `shouldForceResearchFloor`. */
  floor: FloorVerdict;
  /** ms epoch of the last research claim, or null if never. */
  lastResearchAtMs: number | null;
  /** Minimum interval between research cycles. */
  researchMinIntervalMs: number;
  /** Wall-clock at snapshot time — used by the throttle check. */
  nowMs: number;
  /**
   * Today's daily spend, the rollover key, and the `source` discriminator
   * from the surrogate aggregator. `source` is propagated all the way to
   * the `skip:spend-cap` action so the operator-facing trace says *which*
   * accounting stream drove the decision.
   */
  dailySpend: {
    usd: number;
    date: string;
    source: "autopilot-surrogate" | "codex-recorded" | "mixed" | "none";
  };
  /** Daily spend cap (Infinity disables the gate). */
  dailySpendCap: number;
  /** Backlog lane totals; only `total` is consumed today. */
  backlog: { total: number; queued: number; inProgress: number };
  /** Configured queue-depth threshold above which queueLen suppresses research. */
  queueThreshold: number;
  /** Configured research:build ratio ceiling. */
  ratioMax: number;
  /** Low-watermark below which research is preferred over building. */
  lowWatermark: number;
}

/**
 * Decision verdict. Discriminated by `kind`; each variant carries enough
 * context to explain itself without referring back to the snapshot.
 *
 * Variant grouping:
 *   - `force-once` — operator override consumed; always runs.
 *   - `run`        — natural fire (queue is low, or capacity floor forced it).
 *   - `promote-backlog` — queue is low but the backlog has items waiting;
 *                        promote first, defer research to a later tick.
 *   - `skip`       — research suppressed; `reason` discriminates further.
 */
export type ResearchAction =
  | { kind: "force-once" }
  | {
      kind: "run";
      reason: "queue-low" | "floor-fire";
      queueLen: number;
      floorReason?: string;
    }
  | {
      kind: "promote-backlog";
      needed: number;
      queueLen: number;
      backlogAvailable: number;
    }
  | {
      kind: "skip";
      reason: "queue-not-low";
      queueLen: number;
      threshold: number;
    }
  | {
      kind: "skip";
      reason: "ratio-cap";
      ratio: number;
      max: number;
      researchCount24h: number;
      buildCount24h: number;
    }
  | {
      kind: "skip";
      reason: "low-watermark";
      queueLen: number;
      watermark: number;
    }
  | {
      kind: "skip";
      reason: "throttled";
      lastResearchAtMs: number;
      minIntervalMs: number;
      remainingMs: number;
    }
  | {
      kind: "skip";
      reason: "spend-cap";
      spentUsd: number;
      capUsd: number;
      /** Which accounting stream contributed the `spentUsd` value. Useful
       *  for diagnosing "the gate fired but I expected the number to be
       *  zero" — `source: "none"` means HYDRA_TOKEN_USD_RATE is unset
       *  *and* no legacy recordSpend has happened today. */
      source: "autopilot-surrogate" | "codex-recorded" | "mixed" | "none";
    };

/**
 * Decide what the scheduler should do this tick.
 *
 * Options:
 *   - `skipBacklogPromotion`: set on a re-decide after `promote-backlog`
 *     returned 0 promoted items. Skips the promote branch and falls
 *     through to throttle/spend/run gates, matching the legacy
 *     `maybeRunResearch` behaviour where a backlog with 0 promotable
 *     items doesn't block research.
 */
export function decideResearchAction(
  snap: ResearchSnapshot,
  opts: { skipBacklogPromotion?: boolean } = {},
): ResearchAction {
  // 1. Operator force-once bypasses every throttle.
  if (snap.forced) return { kind: "force-once" };

  const floorFiring = snap.floor.shouldFire;

  // 2. Queue-depth gate. Floor can override.
  if (snap.queueLen >= snap.queueThreshold && !floorFiring) {
    return {
      kind: "skip",
      reason: "queue-not-low",
      queueLen: snap.queueLen,
      threshold: snap.queueThreshold,
    };
  }

  // 3. Ratio gate. Only kicks in once any research has been recorded today.
  //    Floor can override.
  if (snap.researchCount24h > 0 && snap.ratio > snap.ratioMax && !floorFiring) {
    return {
      kind: "skip",
      reason: "ratio-cap",
      ratio: snap.ratio,
      max: snap.ratioMax,
      researchCount24h: snap.researchCount24h,
      buildCount24h: snap.buildCount24h,
    };
  }

  // 4. Low-watermark gate. Prefer building over researching when the queue
  //    has any meaningful depth. Floor can override.
  if (snap.queueLen >= snap.lowWatermark && !floorFiring) {
    return {
      kind: "skip",
      reason: "low-watermark",
      queueLen: snap.queueLen,
      watermark: snap.lowWatermark,
    };
  }

  // 5. Backlog promotion. When the queue is low and the backlog has items,
  //    promotion is preferred over research — research is for *generating*
  //    work, not for sidelining work that's already triaged.
  //    Skipped on re-decide (caller already tried this branch and got 0).
  //    Skipped when the floor is firing — the floor's whole purpose is to
  //    run research even when there's other work.
  if (!opts.skipBacklogPromotion && !floorFiring && snap.backlog.total > 0) {
    const needed = Math.max(0, snap.queueThreshold - snap.queueLen);
    return {
      kind: "promote-backlog",
      needed,
      queueLen: snap.queueLen,
      backlogAvailable: snap.backlog.total,
    };
  }

  // 6. Throttle: minimum interval between research cycles. Read-only here;
  //    execute step still performs the atomic claim to be TOCTOU-safe under
  //    concurrent schedulers (which shouldn't exist but the guard is cheap).
  if (snap.lastResearchAtMs !== null) {
    const sinceMs = snap.nowMs - snap.lastResearchAtMs;
    if (sinceMs < snap.researchMinIntervalMs) {
      return {
        kind: "skip",
        reason: "throttled",
        lastResearchAtMs: snap.lastResearchAtMs,
        minIntervalMs: snap.researchMinIntervalMs,
        remainingMs: snap.researchMinIntervalMs - sinceMs,
      };
    }
  }

  // 7. Daily spend cap. Hard gate; even the floor can't punch through.
  if (snap.dailySpend.usd >= snap.dailySpendCap) {
    return {
      kind: "skip",
      reason: "spend-cap",
      spentUsd: snap.dailySpend.usd,
      capUsd: snap.dailySpendCap,
      source: snap.dailySpend.source,
    };
  }

  // 8. Run. Either the floor demanded it, or the queue is genuinely low.
  return {
    kind: "run",
    reason: floorFiring ? "floor-fire" : "queue-low",
    queueLen: snap.queueLen,
    ...(floorFiring && snap.floor.reason ? { floorReason: snap.floor.reason } : {}),
  };
}
