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
  // Proposals
  // ---------------------------------------------------------------------------
  proposalsIndex: () => "hydra:proposals:index",
  proposal: (id: string) => `hydra:proposals:${id}`,

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
  streamProposals: () => "hydra:proposals",
  streamNotifications: () => "hydra:notifications",
  streamDlq: () => "hydra:dlq",
  streamAgentStream: () => "hydra:agent-stream",

  // ---------------------------------------------------------------------------
  // Dynamic stream lookup (for GET /events/:stream)
  // ---------------------------------------------------------------------------
  stream: (name: string) => `hydra:${name}`,
};
