/**
 * Redis Adapter — facade re-exporting domain-grouped Redis primitives.
 *
 * The original 1582-line file was split into `src/redis/*` modules in
 * issue #269. This shim preserves the existing import surface so callers
 * can continue `import { fn } from "./redis-adapter.ts"` while we migrate
 * them to the domain-specific paths in follow-up PRs.
 *
 * Domain modules:
 *   - redis/connection.ts        — singleton + workspace lock
 *   - redis/plan-cache.ts        — plan cache entries
 *   - redis/cycle-metrics.ts     — metrics index, cycle costs
 *   - redis/reality-reports.ts   — reality report storage + index
 *   - redis/backlog.ts           — backlog lanes + items
 *   - redis/proposals.ts         — proposal hashes + index
 *   - redis/agent-memory.ts      — pattern persistence + cooldowns
 *   - redis/reflections.ts       — reflection buffer + per-anchor + outcomes
 *   - redis/utility.ts           — scan, ttl, type, batch delete, hash field get
 *   - redis/alerts.ts            — alert list
 *   - redis/adversarial.ts       — adversarial-validation tracking
 *   - redis/calibration.ts       — anchor calibration outcomes
 *   - redis/cycle-tracking.ts    — cycle hash + sources + merge lock
 *   - redis/research-reports.ts  — research report storage + index
 *   - redis/health-anchor.ts     — resolved-health anchor marker
 *   - redis/work-queue.ts        — anchor work queue + OV dedup
 *   - redis/scheduler.ts         — scheduler counters + atomic claim + state
 *   - redis/kv.ts                — generic string/list/hash/zset/set/pipeline
 */

// Connection + workspace lock
export {
  getRedisConnection,
  getRedisSubscriber,
  closeRedisConnections,
  acquireWorkspaceLock,
  releaseWorkspaceLock,
} from "./redis/connection.ts";

// Reality reports
export {
  getRecentReportIds,
  getRealityReport,
  getReportIdsByScore,
  getReportScore,
  getRecentReportIdsDesc,
  saveRealityReport,
  trimRealityReports,
} from "./redis/reality-reports.ts";

// Anchor calibration
export { setCalibrationOutcome } from "./redis/calibration.ts";

// Pattern detector cooldowns + agent memory
export {
  getMemoryPatterns,
  getPatternCooldown,
  setPatternCooldown,
  loadPatternsRaw,
  savePatternsRaw,
  getOldRulesCount,
  patternsExist,
  getOldRules,
  deleteOldRules,
} from "./redis/agent-memory.ts";

// Alerts
export { pushAlert } from "./redis/alerts.ts";

// Adversarial-validation tracking
export {
  pushTrackedMerge,
  getTrackedMerges,
  setAdversarialStats,
} from "./redis/adversarial.ts";

// Cycle metrics + costs
export {
  getCycleAgentRuns,
  setCycleMetrics,
  getRecentMetricIds,
  getCycleMetrics,
  pruneMetricsIndex,
  getMetricsIndexSize,
  trimMetricsIndex,
  getRecentMetricIdsDesc,
  getCycleCostMicrodollars,
  getCycleCosts,
} from "./redis/cycle-metrics.ts";

// Plan cache
export {
  getPlanCacheEntry,
  setPlanCacheEntry,
  deletePlanCacheEntry,
  findPlanCacheKeys,
} from "./redis/plan-cache.ts";

// Reflections (buffer + per-anchor + outcomes)
export {
  pushReflection,
  getReflectionBuffer,
  replaceReflectionBuffer,
  pushAnchorReflection,
  getAnchorReflections,
  deleteReflectionKey,
  pushReflectionOutcome,
  getReflectionOutcomes,
  setReflectionKeyTTL,
} from "./redis/reflections.ts";

// Utility (scan, ttl, type, batch delete, hash field get)
export {
  scanKeys,
  getKeyTTL,
  getKeyType,
  deleteKeys,
  deleteKeysBatch,
  hashGet,
} from "./redis/utility.ts";

// Backlog
export {
  getBacklogLaneWithScores,
  getBacklogItem,
  moveBacklogItem,
  incrBacklogCounter,
  getBacklogItemRaw,
  saveBacklogItem,
  removeBacklogItem,
  getBacklogLaneIds,
  getBacklogLaneCount,
  addToBacklogLane,
  removeFromBacklogLane,
  evalScript,
} from "./redis/backlog.ts";

// Proposals
export {
  getProposalHash,
  saveProposalHash,
  getProposalIdsDesc,
  getProposalIdsAsc,
  deleteProposal,
  removeProposalFromIndex,
  getProposalIdsByTimeRange,
} from "./redis/proposals.ts";

// Cycle tracking + merge lock
export {
  setCycleActive,
  clearCycleActive,
  setCycleLast,
  initCycleHash,
  updateCycleHash,
  refreshCycleTTL,
  registerCycleSource,
  releaseCycleSource,
  acquireMergeLock,
  getMergeLockHolder,
  releaseMergeLock,
} from "./redis/cycle-tracking.ts";

// Research reports
export {
  saveResearchReport,
  getResearchReport,
  getRecentResearchIds,
  trimResearchReports,
} from "./redis/research-reports.ts";

// Resolved health-anchor
export {
  markHealthAnchorResolved,
  isHealthAnchorResolved,
} from "./redis/health-anchor.ts";

// Anchor work queue + OV dedup
export {
  getWorkQueueLen,
  getWorkQueueItems,
  countLiveWorkQueueItems,
  isLiveWorkQueueItem,
  LIVE_WORK_QUEUE_SOURCES,
  pushToWorkQueue,
  removeFromWorkQueue,
  SEMANTIC_DEDUP_THRESHOLD,
  normalizeForDedup,
  isFuzzyDuplicate,
  searchOVForDedup,
  findWorkQueueDuplicate,
  indexWorkItem,
  cleanWorkQueue,
} from "./redis/work-queue.ts";

// Scheduler
export {
  recordResearchEvent,
  recordBuildEvent,
  getResearchEventCount24h,
  getBuildEventCount24h,
  setResearchForceOnce,
  consumeResearchForceOnce,
  incrSchedulerCyclesRun,
  getSchedulerCyclesRun,
  incrSchedulerCyclesMerged,
  getSchedulerCyclesMerged,
  incrSchedulerCyclesFailed,
  getSchedulerCyclesFailed,
  atomicClaimResearch,
  getLastResearchAtMs,
  setLastResearchAt,
  saveSchedulerStateVersioned,
  getSchedulerStateVersion,
} from "./redis/scheduler.ts";

// Generic key/value/list/hash/zset/set/pipeline ops
export {
  getString,
  setString,
  delKey,
  setNX,
  incrKey,
  expireKey,
  keyExists,
  findKeys,
  redisInfo,
  hashGetAll,
  hashSet,
  hashSetField,
  hashDel,
  hashIncrBy,
  listLen,
  listRange,
  listRPush,
  listLPush,
  listLPop,
  listRem,
  listMove,
  listSet,
  listTrim,
  zRange,
  zRevRange,
  zAdd,
  zRem,
  zCard,
  setMembers,
  setAdd,
  setRem,
  createPipeline,
} from "./redis/kv.ts";
