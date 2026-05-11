// ---------------------------------------------------------------------------
// Anchor-selection shared constants & key helpers
// ---------------------------------------------------------------------------
//
// Split out of the original 1,176-line src/anchor-selection.ts (issue #288)
// so each domain sub-module can import only the keys/thresholds it needs
// without dragging the full priority chain along. No logic lives here — only
// the constants and tiny key-builder functions used across modules.

import { resolve } from "node:path";

export const CONFIG_PATH =
  process.env.HYDRA_CONFIG_PATH ||
  resolve(process.env.HOME!, "hydra", "config");

// ---------------------------------------------------------------------------
// Redis keys & thresholds
// ---------------------------------------------------------------------------

export const MAX_PRIOR_FAILURE_RETRIES = 2;
export const MAX_CONSECUTIVE_ABANDONMENTS = 3;
export const REFRAME_QUEUE = "hydra:anchors:reframe-queue";
export const WORK_QUEUE = "hydra:anchors:work-queue";
export const PROCESSING_QUEUE = "hydra:anchors:processing";
export const PRIOR_FAILURES_KEY = "hydra:anchors:prior-failures";
export const ABANDONMENT_COUNTER_PREFIX = "hydra:anchors:abandonment-count:";
export const ABANDONMENT_COUNTER_TTL = 86400; // 24h — auto-expire stale counters

// Prior-failure escalation thresholds (issue #18, #93)
export const PRIOR_FAILURE_AGE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24h — items older than this are auto-escalated
export const PRIOR_FAILURE_CAP = 10; // hard cap — oldest items escalated to reframe when exceeded

// Reframe queue cap + TTL (issue #57)
export const REFRAME_QUEUE_CAP = 20;
export const REFRAME_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const REFRAME_INTERLEAVE_INTERVAL = 5; // force reframe every Nth cycle when queue non-empty

// Confidence gate for codebase-health anchors (issue #147)
// Health anchors without grounding signal (failing tests or type errors) are
// low-confidence — they tend to produce "Planner produced no task" abandonments.
export const HEALTH_CONFIDENCE_THRESHOLD = 0.5;

// Drift pre-filter (issue #233)
export const DRIFT_PREFILTER_LOOKBACK = 50;
export const DRIFT_PREFILTER_THRESHOLD = 0.7;
// Eligible anchor sources — the three where post-planner drift fires today.
export const DRIFT_PREFILTER_TYPES = new Set([
  "user-request",
  "research",
  "reframe",
  "doc",
]);

// Stuckness cooldown (issue #253, ADR-0003 vision vector 1)
export const STUCKNESS_COOLDOWN_PREFIX = "hydra:stuckness:cooldown:";
export const STUCKNESS_COOLDOWN_TTL_SECONDS = 30 * 60; // ~5 cycles at average pace

// Codebase-health permanent-skip & metrics index
export const PERM_SKIP_PREFIX = "hydra:anchors:perm-skip:";
export const METRICS_INDEX_KEY = "hydra:metrics:index";
export const REGRESSION_HUNT_LAST_KEY = "hydra:regression-hunt:last";

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

export function taskKey(id: string): string {
  return `hydra:task:${id}`;
}

export function anchorKey(anchorRef: string | undefined | null): string {
  return (
    ABANDONMENT_COUNTER_PREFIX +
    (anchorRef || "unknown").replace(/\s+/g, "-").slice(0, 120)
  );
}

export function stucknessCooldownKey(outcomeName: string): string {
  return (
    STUCKNESS_COOLDOWN_PREFIX + outcomeName.replace(/\s+/g, "-").slice(0, 120)
  );
}
