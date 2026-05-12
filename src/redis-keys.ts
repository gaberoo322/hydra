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
  // Specs
  // ---------------------------------------------------------------------------
  specsIndex: () => "hydra:specs:index",
  spec: (slug: string) => `hydra:specs:${slug}`,
  // Spec-starvation instrumentation (issue #301) — tracks how often the spec
  // tier is passed over and why, plus the running "cycles since a spec was
  // last served" gauge used by the capacity-floor.
  specsPassedReasons: () => "hydra:specs:passed-reasons",
  specsCyclesSinceServed: () => "hydra:specs:cycles-since-served",
  specsLastServedAt: () => "hydra:specs:last-served-at",

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

  // Research capacity floor (issue #327) — sibling of #245 (self-improvement
  // floor) and #308 (spec capacity-floor). Tracks how often the floor fires,
  // when it last fired, the empty-result streak, and the suppression deadline
  // applied after two consecutive forced-empty cycles.
  researchFloorStats: () => "hydra:scheduler:research-floor:stats",
  researchFloorLastTriggeredAt: () => "hydra:scheduler:research-floor:last-triggered-at",
  researchFloorEmptyStreak: () => "hydra:scheduler:research-floor:empty-streak",
  researchFloorSuppressedUntil: () => "hydra:scheduler:research-floor:suppressed-until",

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
