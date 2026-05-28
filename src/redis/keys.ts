/**
 * Redis Key Generators — centralized key string generation.
 *
 * Every Redis key used by the orchestrator is generated here.
 * No Redis dependency — pure string functions only.
 *
 * Naming convention: hydra:{domain}:{id}
 */

export const redisKeys = {
  // ---------------------------------------------------------------------------
  // Cycles
  // ---------------------------------------------------------------------------
  cycleActive: () => "hydra:cycle:active",
  cycleLast: () => "hydra:cycle:last",
  cycle: (id: string) => `hydra:cycle:${id}`,
  // Index of cycle IDs scored by Date.now() — written by the autopilot
  // cycle-record endpoint (issue #430). /api/cycle/history continues to
  // read the per-cycle hashes via KEYS, but the index lets dashboards and
  // downstream consumers paginate without an O(N) scan.
  cycleIndex: () => "hydra:cycle:index",
  cycleTasks: (id: string) => `hydra:cycle:${id}:tasks`,
  cycleAgents: (id: string) => `hydra:cycle:${id}:agents`,
  cycleCosts: (id: string) => `hydra:cycle:${id}:costs`,
  cycleActiveSource: (source: string) => `hydra:cycle:active:${source}`,

  // ---------------------------------------------------------------------------
  // Autopilot runs (issue #497, parent #496) — dashboard observability layer.
  // One row per `/hydra-autopilot` invocation. Schema written at run-start by
  // scripts/autopilot/bootstrap.sh (Phase 0), mutated at run-end by
  // scripts/autopilot/term-check.py, and read by GET /api/autopilot/runs/current.
  // 7d TTL on both the per-run hash and the index, matching the cycle-record
  // pattern.
  // ---------------------------------------------------------------------------
  autopilotRun: (runId: string) => `hydra:autopilot:run:${runId}`,
  autopilotRunsIndex: () => "hydra:autopilot:runs:index",
  // Per-run turn timeline (issue #498, slice 2). One JSON member per decision
  // turn, score = turn_n so reads use ZREVRANGEBYSCORE for monotonic ordering
  // and the (run_id, turn_n) idempotency check is a single ZRANGEBYSCORE
  // lookup. Rows are immutable — outcomes are joined on read from cycle
  // records, never patched back into the turn row. 7d TTL matches the run
  // hash, refreshed alongside it on each write.
  autopilotRunTurns: (runId: string) => `hydra:autopilot:run:${runId}:turns`,

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------
  task: (id: string) => `hydra:task:${id}`,
  taskEvidence: (taskId: string, state: string) => `hydra:task:${taskId}:evidence:${state}`,

  // ---------------------------------------------------------------------------
  // Dependencies
  // ---------------------------------------------------------------------------
  depsCompleted: () => "hydra:deps:completed",
  depsIndex: () => "hydra:deps:index",
  depsHeld: (id: string) => `hydra:deps:held:${id}`,

  // ---------------------------------------------------------------------------
  // Anchors
  // ---------------------------------------------------------------------------
  anchorWorkQueue: () => "hydra:anchors:work-queue",
  anchorProcessing: () => "hydra:anchors:processing",
  anchorPriorFailures: () => "hydra:anchors:prior-failures",
  anchorReframeQueue: () => "hydra:anchors:reframe-queue",
  // Reframe-starvation instrumentation (issue #377) — mirrors the spec-tier
  // starvation gauge. Tracks how often the reframe lane is passed over, the
  // reason it lost, and the running "cycles since reframe last served" gauge
  // consumed by the capacity-floor.
  anchorReframePassedReasons: () => "hydra:anchors:reframe-passed-reasons",
  anchorReframeCyclesSinceServed: () => "hydra:anchors:reframe-cycles-since-served",
  anchorReframeLastServedAt: () => "hydra:anchors:reframe-last-served-at",
  anchorAbandonmentCount: (ref: string) => `hydra:anchors:abandonment-count:${ref}`,
  anchorPermSkip: (ref: string) => `hydra:anchors:perm-skip:${ref}`,
  anchorResolvedHealth: (ref: string) => `hydra:anchors:resolved-health:${ref}`,
  anchorCalibration: (cycleId: string) => `hydra:anchors:calibration:${cycleId}`,
  anchorCalibrationIndex: () => "hydra:anchors:calibration:index",

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------
  metricsIndex: () => "hydra:metrics:index",
  metrics: (cycleId: string) => `hydra:metrics:${cycleId}`,

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------
  realityReport: (id: string) => `hydra:reports:reality:${id}`,
  realityReportIndex: () => "hydra:reports:reality:index",
  summaryReport: (suffix: string) => `hydra:reports:summary:${suffix}`,
  researchReport: (id: string) => `hydra:reports:research:${id}`,
  researchReportIndex: () => "hydra:reports:research:index",

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------
  memoryPatterns: (agent: string) => `hydra:memory:${agent}:patterns`,
  memoryRules: (agent: string) => `hydra:memory:${agent}:rules`,
  memoryLastConsolidation: () => "hydra:memory:last-consolidation",
  // Issue #512 — Friction patterns. Same shape as memoryPatterns but a
  // distinct namespace so soft-friction items captured from subagents don't
  // pollute the planner/executor learning sets that drive prompt promotion.
  frictionPatterns: (skill: string) => `hydra:friction:${skill}:patterns`,

  // ---------------------------------------------------------------------------
  // Reflections
  // ---------------------------------------------------------------------------
  reflectionPrefix: () => "hydra:reflections:",
  reflection: (normalizedRef: string) => `hydra:reflections:${normalizedRef}`,
  reflectionOutcomes: () => "hydra:learning:reflection:outcomes",

  // ---------------------------------------------------------------------------
  // Backlog
  // ---------------------------------------------------------------------------
  backlogItems: () => "hydra:backlog:items",
  backlogCounter: () => "hydra:backlog:counter",
  backlogLane: (lane: string) => `hydra:backlog:lane:${lane}`,

  // ---------------------------------------------------------------------------
  // Specs — RETIRED (issue #513). The Specs subsystem was deleted; key
  // builders were removed. Existing `hydra:specs:*` keys remain in Redis
  // but are no longer read or written. See scripts/cleanup/retire-specs.sh
  // for one-shot cleanup.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------
  schedulerState: () => "hydra:scheduler:state",
  schedulerDailySpend: () => "hydra:scheduler:daily-spend",
  schedulerResearchEvents: () => "hydra:scheduler:research-events",
  schedulerBuildEvents: () => "hydra:scheduler:build-events",
  schedulerResearchForceOnce: () => "hydra:scheduler:research-force-once",
  schedulerCyclesRun: () => "hydra:scheduler:cycles-run",
  schedulerCyclesMerged: () => "hydra:scheduler:cycles-merged",
  schedulerCyclesFailed: () => "hydra:scheduler:cycles-failed",
  schedulerStateVersion: () => "hydra:scheduler:state-version",
  // Issue #388: deliberate-stop marker. Set when the operator calls
  // POST /scheduler/stop so the watchdog can distinguish operator stops
  // from self-stops (zero-output breaker / error cap) and refuse to
  // auto-restart the former. 24h TTL so a stale flag eventually clears
  // itself if start() is never called explicitly.
  schedulerDeliberateStop: () => "hydra:scheduler:deliberate-stop",

  // Issue #673: budget-threshold idempotency sentinel. Written via SETNX
  // by `src/autopilot/budget-threshold-bridge.ts` on the first crossing
  // of a given (UTC-day, threshold-pct) pair so the bridge emits exactly
  // one event per threshold per day. 30h TTL — longer than a UTC day so
  // the sentinel survives daylight-saving-style boundary jitter, short
  // enough to keep Redis tidy.
  budgetThresholdSeen: (isoDate: string, thresholdPct: number) =>
    `hydra:autopilot:budget-threshold:${isoDate}:${thresholdPct}`,

  // Research capacity floor (issue #327) — sibling of #245 (self-improvement
  // floor) and #308 (spec capacity-floor). Tracks how often the floor fires,
  // when it last fired, the empty-result streak, and the suppression deadline
  // applied after two consecutive forced-empty cycles.
  researchFloorStats: () => "hydra:scheduler:research-floor:stats",
  researchFloorLastTriggeredAt: () => "hydra:scheduler:research-floor:last-triggered-at",
  researchFloorEmptyStreak: () => "hydra:scheduler:research-floor:empty-streak",
  researchFloorSuppressedUntil: () => "hydra:scheduler:research-floor:suppressed-until",

  // ---------------------------------------------------------------------------
  // Tool Scout (issue #484)
  // Per-tool seen-list ledger consumed by /hydra-tool-scout. One hash per
  // canonical-slug tracking decision history so re-runs of the scout don't
  // re-propose the same tool. Schema documented in src/scout/seen-list.ts.
  // Keys are intentionally NOT TTLed — re-eval eligibility is computed from
  // the hash fields, not from key expiry.
  // ---------------------------------------------------------------------------
  scoutToolsConsidered: (slug: string) => `hydra:scout:tools-considered:${slug}`,

  // Tool Scout — Phase B calendar walk (issue #485).
  //
  // `scoutLastCalendarWalk`: ISO-8601 UTC timestamp of the most recent
  //   weekly walk dispatch. Read by collect-state.sh to compute the
  //   `scout_walk_due` signal (true when >7d old). Not TTLed — the value
  //   is a heartbeat, not a session record.
  //
  // `scoutCategoryLastWalked`: ISO-8601 UTC timestamp of the most recent
  //   scout dispatch for a given category slug. Per-category cooldown
  //   (default 30d) is computed against this. One key per category.
  //
  // `scoutStatsDaily`: hash of per-day per-category counters (candidates
  //   surfaced / filtered / filed / dropped / rejected). 14d TTL — the
  //   `/api/scout/stats` endpoint window is "last week" so two weeks of
  //   retention is enough headroom.
  scoutLastCalendarWalk: () => "hydra:scout:last-calendar-walk",
  scoutCategoryLastWalked: (category: string) => `hydra:scout:category-last-walked:${category}`,
  scoutStatsDaily: (isoDate: string) => `hydra:scout:stats:${isoDate}`,

  // Tool Scout — Phase B cost-cap gate (issue #532).
  //
  // Per-day per-class scout token spend mirror, written by
  // `collect-state.sh` from the existing `hydra:metrics:tokens:by-skill:
  // daily:<DATE>[hydra-tool-scout]` surrogate (issue #394 accumulator).
  // The gate in `scripts/autopilot/decide.py:_select_for_signal("scout_orch")`
  // reads this via `state.scout_spend_usd_today` and suppresses dispatch
  // when daily scout spend ≥ `scout_cost_share * daily_spend_cap_usd`.
  //
  // Value is an INT-string of tokens consumed today by `hydra-tool-scout`
  // dispatches; the dollar conversion uses `HYDRA_TOKEN_USD_RATE` at the
  // emitter (collect-state.sh) so the gate's input is already in USD. 7d
  // TTL keeps Redis tidy; one week of audit headroom matches the
  // `/api/scout/stats` window.
  scoutSpendDaily: (isoDate: string) => `hydra:scout:spend:${isoDate}`,

  // Tool Scout — Phase C alert-driven trigger (issue #486).
  //
  // `scoutDispatches`: Redis stream of audit-trail entries — one XADD per
  //   scout invocation (calendar OR alert). Fields documented in
  //   src/scout/alert-listener.ts. Read by `/api/scout/dispatches`.
  //   Capped via MAXLEN ~ 1000 so the stream stays bounded.
  //
  // `scoutAlertCursor`: ISO-8601 UTC timestamp — the most recent alert
  //   timestamp the alert-listener has already processed. Acts as a
  //   high-water-mark cursor over `hydra:alerts` so re-runs of the
  //   listener don't re-fire on alerts they already handled. Not TTLed.
  //
  // `scoutPatternLastFired`: ISO-8601 UTC of the most recent scout
  //   dispatch attributed to a given alert pattern (debouncing key —
  //   24h cap per pattern). One key per pattern, TTL 48h (twice the
  //   dedup window so a forgotten pattern self-cleans).
  scoutDispatches: () => "hydra:scout:dispatches",
  scoutAlertCursor: () => "hydra:scout:alert-cursor",
  scoutPatternLastFired: (pattern: string) => `hydra:scout:pattern-last-fired:${pattern}`,

  // ---------------------------------------------------------------------------
  // Locks
  // ---------------------------------------------------------------------------
  mergeLock: () => "hydra:merge:lock",
  workspaceLock: () => "hydra:workspace:lock",

  // ---------------------------------------------------------------------------
  // Plan Cache
  // ---------------------------------------------------------------------------
  planCachePrefix: () => "hydra:plans:cache:",
  planCache: (hash: string) => `hydra:plans:cache:${hash}`,
  // Persisted stats — survive restarts so multi-day hit-rate can be measured
  // (issue #325). Lifetime counters use a single key per metric; per-day
  // counters use ISO-date suffix (UTC) with 7-day TTL for a rolling 24h view.
  planCacheStatLifetime: (metric: string) => `hydra:plans:cache:stats:${metric}`,
  planCacheStatDay: (metric: string, isoDate: string) =>
    `hydra:plans:cache:stats:${metric}:${isoDate}`,
  // Miss-reason histogram (issue #363). Hash keys are reasons (see
  // PlanCacheMissReason), values are counts. Lifetime + per-day variants
  // mirror the per-metric counter scheme above.
  planCacheMissReasonsLifetime: () => `hydra:plans:cache:miss-reasons`,
  planCacheMissReasonsDay: (isoDate: string) =>
    `hydra:plans:cache:miss-reasons:${isoDate}`,

  // ---------------------------------------------------------------------------
  // Adversarial Validation
  // ---------------------------------------------------------------------------
  adversarialTracking: () => "hydra:adversarial:tracking",
  adversarialStats: () => "hydra:adversarial:stats",

  // ---------------------------------------------------------------------------
  // Pattern Detector
  // ---------------------------------------------------------------------------
  alerts: () => "hydra:alerts",
  patternDetectorCooldowns: () => "hydra:pattern-detector:cooldowns",

  // ---------------------------------------------------------------------------
  // Stale-claim reaper (issue #374)
  // Lifetime + per-day (UTC isoDate, 7-day TTL) counters of claims released
  // because their claimedAt age exceeded HYDRA_CLAIM_MAX_AGE_MS.
  // ---------------------------------------------------------------------------
  claimsReapedLifetime: () => "hydra:metrics:claims-reaped",
  claimsReapedDay: (isoDate: string) => `hydra:metrics:claims-reaped:${isoDate}`,
  claimsReapedLast: () => "hydra:metrics:claims-reaped:last",

  // ---------------------------------------------------------------------------
  // Blocked Escalation
  // ---------------------------------------------------------------------------
  blockedLastEscalation: () => "hydra:blocked:last-escalation",

  // ---------------------------------------------------------------------------
  // Digest
  // ---------------------------------------------------------------------------
  digestLastWeekly: () => "hydra:digest:last-weekly",

  // ---------------------------------------------------------------------------
  // Regression Hunt
  // ---------------------------------------------------------------------------
  regressionHuntLast: () => "hydra:regression-hunt:last",

  // ---------------------------------------------------------------------------
  // Event Streams
  // ---------------------------------------------------------------------------
  streamCycle: () => "hydra:cycle",
  streamTasks: () => "hydra:tasks",
  streamMeta: () => "hydra:meta",
  streamNotifications: () => "hydra:notifications",
  streamDlq: () => "hydra:dlq",
  streamAgentStream: () => "hydra:agent-stream",

  // ---------------------------------------------------------------------------
  // Dynamic stream lookup (for GET /events/:stream)
  // ---------------------------------------------------------------------------
  stream: (name: string) => `hydra:${name}`,
};
