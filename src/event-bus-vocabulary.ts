// ---------------------------------------------------------------------------
// Notification event vocabulary Seam (issue #1985) — the notification
// sub-alphabet of the Event Bus alphabet (CONTEXT.md).
//
// `src/event-bus.ts` owns the *stream-key* alphabet (STREAMS / RETAINED_STREAMS
// / CONSUMER_GROUPS) AND the Redis-connected `EventBus` class. This module owns
// the *notification event* sub-alphabet that was previously co-located there:
//
//   - `NOTIFICATION_EVENT_TYPES` — the closed event-type string map (issue #1182).
//   - `NotificationEventType`    — the union of its values.
//   - `NotificationEventPayload` — the payload-field contract (issue #1915).
//
// Why a separate file: this module has ZERO import-time side effects — it does
// NOT import `./redis/connection.ts` (or anything that transitively calls
// `getRedisConnection()`), so the pure formatter modules (notify-format,
// digest-format, alert-grammar, cycle-completed-reactor) and their tests can
// derive their event interfaces from this vocabulary WITHOUT pulling the Redis
// connection into scope at parse/load time. `event-bus.ts` imports the symbols
// BACK from here (a value + a type), keeping a single source of truth.
//
// On-wire event-type strings and payload field shapes are byte-identical to the
// pre-extraction `event-bus.ts` definitions — this is a pure type/value
// relocation, zero behaviour change.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Notification event vocabulary — the typed `type` discriminator (issue #1182).
//
// `NOTIFICATION_EVENT_TYPES` is the SINGLE SOURCE OF TRUTH for every event
// type that flows on the `NOTIFICATIONS` (and internal `DLQ`) stream. It is a
// frozen `const` map — mirroring `STREAMS` in event-bus.ts — so:
//
//   - `NotificationEventType` (below) is the closed union of its values.
//   - Every formatter that switches on the event type
//     (`notify.ts` formatMessage, `index.ts` formatAlertMessage + ALERT_TYPES,
//     `digest.ts` critical list) references these named members instead of raw
//     string literals. A typo on a member name is then a compile error, and
//     adding a new event type is a one-line edit here that surfaces every
//     affected formatter as a non-exhaustive switch / missing arm.
//
// The on-wire string values are UNCHANGED — this is a type-safety pass over the
// existing vocabulary, not a behaviour change.
// ---------------------------------------------------------------------------
const NOTIFICATION_EVENT_TYPES = {
  // --- Cycle lifecycle ---
  CYCLE_START: "cycle:start",
  CYCLE_COMPLETED: "cycle:completed",
  CYCLE_STALLED: "cycle:stalled",
  CYCLE_FAILED: "cycle:failed",
  CYCLE_AUTO_KILLED: "cycle:auto_killed",
  CYCLE_STALE_PRIORITIES: "cycle:stale_priorities",
  CYCLE_ROLLBACK: "cycle:rollback",
  CYCLE_ROLLBACK_FAILED: "cycle:rollback_failed",
  CYCLE_ROLLED_BACK: "cycle:rolled_back",
  CYCLE_OPERATOR_BLOCKED: "cycle:operator_blocked",

  // --- Task events ---
  TASK_REJECTED: "task:rejected",
  TASK_VERIFICATION_FAILED: "task:verification_failed",
  TASK_DRIFT_DETECTED: "task:drift_detected",
  TASK_MERGE_FAILED: "task:merge_failed",
  TASK_SHELVED: "task:shelved",

  // --- Scheduler ---
  SCHEDULER_STOPPED: "scheduler:stopped",
  SCHEDULER_BACKLOG_EMPTY: "scheduler:backlog_empty",
  SCHEDULER_PAUSED_REPETITION: "scheduler:paused_repetition",
  SCHEDULER_ERROR: "scheduler:error",

  // --- Research / Architect ---
  RESEARCH_COMPLETED: "research:completed",
  ARCHITECT_REVIEW_COMPLETED: "architect:review_completed",

  // --- Deploy ---
  DEPLOY_COMPLETED: "deploy:completed",
  DEPLOY_FAILED: "deploy:failed",

  // --- DLQ / consumer health ---
  DLQ_ALERT: "dlq:alert",
  DLQ_ENTRY: "dlq:entry",
  CONSUMER_DEAD: "consumer:dead",

  // --- Operator review pickup (issue #745) ---
  REVIEW_PICKUP_READY: "review:pickup_ready",

  // --- Launch-flow watchdog signals (issue #3848, epic #3844) ---
  // Published by the watchdog's run_launch_flow block (a direct enveloped
  // redis-cli XADD from bash — the ADR-0017 Category A on-wire shape
  // EventBus.publish constructs) at the exact tick a sustained-streak fired
  // marker transitions absent→present. quota/latency are ALSO in ALERT_TYPES
  // (dashboard alert via the notification-consumer's compile-checked grammar);
  // pause is deliberately withheld from ALERT_TYPES (digest line only).
  LAUNCH_QUOTA_STRETCH: "launch:quota_stretch",
  LAUNCH_LATENCY_BREACH: "launch:latency_breach",
  LAUNCH_PAUSE_FORGOTTEN: "launch:pause_forgotten",

  // --- Infra integrity watchdog signals (issue #4175) ---
  // Published by the watchdog's run_node_modules_integrity block (a direct
  // enveloped redis-cli XADD from bash, same ADR-0017 Category A shape as the
  // launch-flow signals above) the instant a watched node_modules install
  // root is found broken (absent, missing .bin/, below the entry floor, or
  // missing the referenced binary) — see scripts/hydra-watchdog.sh's
  // "## NODE MODULES INTEGRITY" block. In both ALERT_TYPES and
  // CRITICAL_EVENT_TYPES: a wiped install under a live money-critical service
  // warrants both the dashboard alert and the immediate digest line.
  INFRA_NODE_MODULES_WIPED: "infra:node_modules_wiped",

  // --- GLM dev-drainer zero-throughput watchdog signal (issue #3868) ---
  // Published by the watchdog's run_launch_flow block (same ADR-0017
  // Category A enveloped XADD from bash as the launch-flow signals above)
  // when the drainer is LIVE BUT STERILE: fresh hydra:glm:drainer:active
  // heartbeat, at least one glm-eligible + ready-for-agent issue queued
  // (work to drain), and ZERO drainer PRs — the shared issue-#4048
  // OR-predicate (glm-authored label OR worktree-agent-glm-* head branch) —
  // created in the trailing window, sustained past the streak threshold.
  // In both ALERT_TYPES and CRITICAL_EVENT_TYPES: while the heartbeat is
  // fresh the #3754 partition hides the queued work from the Opus lane, so
  // a sterile drainer silently starves the whole board (observed #3863).
  GLM_DRAINER_STERILE: "glm:drainer_sterile",

  // --- Learning-system pattern alerts ---
  PATTERN_LOW_MERGE_RATE: "pattern:low_merge_rate",
  PATTERN_CONSECUTIVE_FAILURES: "pattern:consecutive_failures",
  PATTERN_RECURRING_REGRESSIONS: "pattern:recurring_regressions",
  PATTERN_ANCHOR_STUCK: "pattern:anchor_stuck",
  PATTERN_TEST_DECLINE: "pattern:test_decline",
  PATTERN_HIGH_ABANDONMENT: "pattern:high_abandonment",
} as const;

/**
 * The closed union of every notification event type the bus vocabulary owns.
 * Derived from `NOTIFICATION_EVENT_TYPES` so the map is the only place a value
 * is declared.
 */
type NotificationEventType =
  (typeof NOTIFICATION_EVENT_TYPES)[keyof typeof NOTIFICATION_EVENT_TYPES];

// ---------------------------------------------------------------------------
// Notification event PAYLOAD vocabulary — the single source of truth for the
// payload-field shapes that flow on the NOTIFICATIONS stream (issue #1915).
//
// `NOTIFICATION_EVENT_TYPES` above owns the event-type *strings*; this type
// owns the *payload fields* those events carry. The three pure formatters
// (`notify-format.ts` formatMessage, `digest-format.ts` buildDigestMessage,
// `notification-consumer.ts` formatAlertMessage) each read an overlapping
// subset of these fields. Issues #1857 / #1835 / #1889 each independently
// declared a per-formatter typed interface to convert a runtime field-miss
// into a compile error — the same fix applied three times to the same field
// vocabulary. This type concentrates that vocabulary in one place: each
// formatter now derives its event interface by `Pick`-ing the subset of
// fields it reads from `NotificationEventPayload`, so a renamed payload field
// is a one-file edit here and the formatters update without a three-file hunt.
//
// `payload` stays OPEN (`Record<string, unknown> & {…}`) because the bus
// carries the full event vocabulary; the named fields are only the union of
// the subsets the formatters narrow on. A producer renaming a READ field is
// caught at every formatter that `Pick`s it; a producer adding an *unread*
// field is not constrained. Every field is optional — each formatter gates on
// the event type before dereferencing — so a per-formatter `Pick` over these
// stays assignable from the loose bus-fed shape (preserving the
// `NotificationEvent → AlertGrammarEvent` assignability the consumer relies on).
//
// On-wire payloads are UNCHANGED — this is a type-locality pass over the
// existing field vocabulary, not a behaviour change.
// ---------------------------------------------------------------------------
type NotificationEventPayload = Record<string, unknown> & {
  // --- Cycle lifecycle ---
  cycleId?: string;
  task?: { finalState?: string; title?: string };
  grounding?: {
    before?: { passed?: number | string };
    after?: { passed?: number | string };
  };
  commitSha?: string;
  filesChanged?: unknown[];
  rolledBack?: boolean;
  rollbackRisk?: string;
  durationMs?: number;
  total?: number | string;
  completed?: number | string;
  failed?: number;
  elapsed?: string;
  inProgress?: number;
  error?: string;
  ttl?: string;
  tasksTimedOut?: number;
  message?: string;
  // --- Task events ---
  taskId?: string;
  taskTitle?: string;
  title?: string;
  reason?: string;
  failedSteps?: string[];
  drift?: { reason?: string };
  // --- Rollback ---
  revertedCommit?: string;
  testsBefore?: number | string;
  testsAfter?: number | string;
  regressedOutcomes?: unknown;
  // --- Scheduler ---
  cyclesRun?: number;
  suggestion?: string;
  recentTitles?: string[];
  consumer?: string;
  restarts?: number;
  // --- Research / Architect ---
  projectName?: string;
  opportunityCount?: number;
  autoQueued?: number;
  duration?: string;
  cost?: string;
  topOpportunities?: string[];
  summary?: string;
  researchCyclesReviewed?: number;
  executionCyclesReviewed?: number;
  updatesApplied?: number;
  calibration?: string;
  // --- Cycle merge flag (top-level, as emitted by the reap path) ---
  merged?: boolean;
  // --- DLQ ---
  originalStream?: string;
  eventType?: string;
  deliveryCount?: number;
  // --- Review pickup ---
  count?: number;
  firstTitle?: string;
  firstUrl?: string;
  // --- Operator blocked ---
  unblockCommands?: string[];
  blockedReason?: string;
  reescalation?: boolean;
  blockedDays?: number | string;
  // --- Launch-flow watchdog signals (issue #3848) ---
  signal?: string;
  thresholdMs?: number;
};

export { NOTIFICATION_EVENT_TYPES };
export type { NotificationEventType, NotificationEventPayload };
