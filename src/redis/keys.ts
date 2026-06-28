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
  cycle: (id: string) => `hydra:cycle:${id}`,
  // Index of cycle IDs scored by Date.now() — written by the autopilot
  // cycle-record endpoint (issue #430). /api/cycle/history continues to
  // read the per-cycle hashes via KEYS, but the index lets dashboards and
  // downstream consumers paginate without an O(N) scan.
  cycleIndex: () => "hydra:cycle:index",
  cycleTasks: (id: string) => `hydra:cycle:${id}:tasks`,
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
  // Retrospective seen-list + recurrence ledger (issue #919, epic #917).
  //
  // The /hydra-retro skill synthesises a per-run retrospective and, when a
  // gotcha clears the bar, files a capped emit (GitHub issue / gated PR /
  // artifact-only note). To keep the same gotcha from being re-proposed on the
  // next run, every emit decision is recorded against a stable, kebab-case
  // `cue` (the same cue grammar the friction store uses, so the two ledgers
  // line up). Two key families, both global (not per-run): a retrospective
  // gotcha recurs ACROSS runs, so a per-run scope would defeat the recurrence
  // gate.
  //
  // `retroSeen`: hash, field=cue, value=JSON {decision, runId, ref, at}. The
  //   dedup ledger — a cue present here was already emitted, so a later run
  //   skips it (mirrors `scoutToolsConsidered`). NOT TTLed; a gotcha resolved
  //   long ago should still be one lookup away so we never re-file it.
  //
  // `retroRecurrence`: hash, field=cue, value=INT-string. The recurrence
  //   counter — incremented once per run a cue is OBSERVED (independent of
  //   whether it was emitted). The prompt-shaped-fix gate fires only when a
  //   cue's count is ≥3 (seen across ≥3 runs/friction observations), the
  //   recurrence threshold the epic mandates. NOT TTLed for the same reason.
  //
  // Restored by issue #1041: #1007 deleted these as knip-dead, but the only
  // caller is the live /hydra-retro SKILL.md (markdown invisible to static
  // analysis), which broke retro_orch at runtime. Do not re-delete on a knip
  // sweep without checking docs/operator-playbooks/hydra-retro.md.
  // ---------------------------------------------------------------------------
  retroSeen: () => "hydra:retro:seen",
  retroRecurrence: () => "hydra:retro:recurrence",

  // ---------------------------------------------------------------------------
  // Dispatch registries (issue #618 operator namespace; issue #692 subagent
  // namespace). The key builders for both namespaces are inlined in
  // `src/redis/dispatches.ts` rather than here — the ADR-0009 seam-check is
  // satisfied by builders that live anywhere under `src/redis/`, and inlining
  // keeps the two sibling namespaces symmetric in one file. This reservation
  // comment exists so the prefixes are discoverable from the central key
  // surface even though the functions live next door:
  //
  //   hydra:dispatches:operator:{id}         + :index   (operator-launched)
  //   hydra:dispatches:subagent:{sessionId}  + :index   (Agent-tool subagents)
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------
  metricsIndex: () => "hydra:metrics:index",
  metrics: (cycleId: string) => `hydra:metrics:${cycleId}`,

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------
  // `realityReport` / `realityReportIndex` removed in #965 — the reality-report
  // subsystem was write-dead (saveRealityReport had zero callers; the writer was
  // a codex control-loop artifact, retired under ADR-0006/ADR-0012). The read
  // path (API route, CLI, context-builder continuity, knowledge-indexer poll)
  // was deleted with it. Residual `hydra:reports:reality:*` keys may remain in
  // Redis but are no longer read or written.
  summaryReport: (suffix: string) => `hydra:reports:summary:${suffix}`,
  // `researchReport` / `researchReportIndex` removed in #863 — the in-process
  // research read surface (research-loop.ts + redis/research-reports.ts) was
  // deleted as the last remnant of the retired codex research subsystem
  // (#342/#706). Residual `hydra:reports:research:*` keys remain in Redis but
  // are no longer read or written.

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------
  memoryPatterns: (agent: string) => `hydra:memory:${agent}:patterns`,
  memoryLastConsolidation: () => "hydra:memory:last-consolidation",
  // Issue #1876 — daily idempotency stamp for the stale-Redis-key sweep chore
  // folded out of the cleanup.ts in-process timer into housekeeping. Mirrors
  // memoryLastConsolidation: the hourly housekeeping invocation runs the sweep
  // at most once per day, skipping the remaining 23 invocations.
  cleanupLastDaily: () => "hydra:cleanup:last-daily",
  // Issue #512 — Friction patterns. Same shape as memoryPatterns but a
  // distinct namespace so soft-friction items captured from subagents don't
  // pollute the planner/executor learning sets that drive prompt promotion.
  frictionPatterns: (skill: string) => `hydra:friction:${skill}:patterns`,

  // ---------------------------------------------------------------------------
  // Reflections
  // ---------------------------------------------------------------------------
  reflectionPrefix: () => "hydra:reflections:",
  reflection: (normalizedRef: string) => `hydra:reflections:${normalizedRef}`,

  // ---------------------------------------------------------------------------
  // Backlog
  // ---------------------------------------------------------------------------
  backlogItems: () => "hydra:backlog:items",
  backlogCounter: () => "hydra:backlog:counter",
  backlogLane: (lane: string) => `hydra:backlog:lane:${lane}`,
  // By-title secondary index (issue #2500): Hash mapping exact item.title → itemId
  // so the title-based lane mutations in src/backlog/lanes.ts resolve an id with a
  // single HGET instead of scanning whole lanes. A derived, rebuildable index over
  // the canonical items hash — the lane-index reconciler repairs it FROM the hash.
  backlogTitleIndex: () => "hydra:backlog:title-index",

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
  // `schedulerDailySpend` (`hydra:scheduler:daily-spend`) removed in #704: its
  // writer + budget-threshold bridge were deleted in #703, and its sole
  // surviving reader (`src/cost/surrogate.ts` legacy back-compat path) was
  // removed in #704. The live cost guardrail is `src/cost/usage-tracker.ts`.
  // `schedulerResearchEvents` (`hydra:scheduler:research-events`) and
  // `schedulerBuildEvents` (`hydra:scheduler:build-events`) removed in #2488:
  // their only callers were the research/build event-count accessors deleted in
  // the same change, themselves dead since #706 (research-floor decision plane).
  // `schedulerResearchForceOnce` (`hydra:scheduler:research-force-once`) removed
  // in #2489: its writer `setResearchForceOnce` (the only caller) was retired
  // with the orphaned POST /research/force endpoint once #706 deleted the reader.
  schedulerCyclesRun: () => "hydra:scheduler:cycles-run",
  schedulerCyclesMerged: () => "hydra:scheduler:cycles-merged",
  schedulerCyclesFailed: () => "hydra:scheduler:cycles-failed",
  // Issue #1919: cycles whose recorded status fell in NEITHER MERGED_STATUSES
  // nor FAILED_STATUSES (recordCycle's bucketed===null else-branch). Makes the
  // run = merged + failed + unaccounted identity a first-class, queryable
  // counter instead of an inferred subtraction.
  schedulerCyclesUnaccounted: () => "hydra:scheduler:cycles-unaccounted",
  schedulerStateVersion: () => "hydra:scheduler:state-version",
  // Issue #388: deliberate-stop marker. Set when the operator calls
  // POST /scheduler/stop so the watchdog can distinguish operator stops
  // from self-stops (zero-output breaker / error cap) and refuse to
  // auto-restart the former. 24h TTL so a stale flag eventually clears
  // itself if start() is never called explicitly.
  schedulerDeliberateStop: () => "hydra:scheduler:deliberate-stop",

  // Issue #745: edge-trigger armed-state for the /hydra-review pickup-set
  // phone-notify hook. Holds "1" while the pickup set is NON-EMPTY (a
  // notification already fired and is suppressed). Absent means the set is
  // empty and the hook is re-armed to fire on the next empty -> non-empty
  // transition. A plain string flag, not a JSON blob.
  reviewPickupArmed: () => "hydra:review:pickup-armed",

  // Issue #744: operator-only emergency brake. A persistent flag (no TTL —
  // it must be held until the operator explicitly clears it, unlike the
  // 60s-TTL merge-lock) that, while engaged, forces ALL auto-merge to pause
  // regardless of tier/depth verdict and routes every open PR to the
  // /hydra-review pickup set. The SOLE write path is the operator-facing API
  // route (src/api/autopilot-control.ts); decide.py and collect-state.sh only READ
  // it. Stored as a JSON blob `{engaged, since, engagedBy}` so /health can
  // surface "since when / by whom" for incident audit. Absent => disengaged
  // (default-off).
  emergencyBrake: () => "hydra:autopilot:emergency-brake",

  // Issue #988: operator-only autopilot pause. A persistent flag (no TTL — it
  // must be held until the operator explicitly clears it) that, while set,
  // pauses hydra-autopilot with a DRAIN: the launcher (pace-gate.sh) skips
  // spawning a new run and the brain (decide.py) emits no new dispatches,
  // while in-flight subagents finish their atomic unit. INDEPENDENT of and
  // composes with the emergency-brake (which is merge-only). The SOLE write
  // path is the operator-facing API route (src/api/autopilot-control.ts); decide.py
  // and collect-state.sh only READ it (folded into /api/usage/eligibility).
  // Stored as a JSON blob `{paused, since}` (no attribution). Absent =>
  // not paused (default-off, fail-safe to running).
  autopilotPaused: () => "hydra:autopilot:paused",

  // Issue #1089: session-limit hard-block reset instant. Recorded (by the
  // reap-on-exit path via the API) when the autopilot exits with
  // `You've hit your session limit · resets <t>`; the value is the epoch-ms the
  // rolling SESSION window resets. UNLIKE the operator pause, this carries a
  // TTL set to the reset instant (+ a small buffer) so it SELF-CLEARS once the
  // quota resets — a stale block can never wedge autopilot off. Folded into
  // /api/usage/eligibility as `reasons.sessionBlockedUntil`; while it is a
  // future instant the launcher (pace-gate.sh) skips relaunch into the
  // exhausted quota. Absent => no block (default-off, fail-safe to running).
  autopilotSessionBlock: () => "hydra:autopilot:session-blocked-until",

  // Issue #673 budget-threshold idempotency sentinel removed in #703 along
  // with the dead budget-threshold bridge that wrote it. The bridge polled
  // `hydra:scheduler:daily-spend` (no live writer) and never emitted.

  // Research capacity-floor keys (issue #327) were removed in #706 (scheduler
  // fold PR-1/4) together with the research-decision plane that read/wrote
  // them. Residual `hydra:scheduler:research-floor:*` keys are no longer read
  // or written.

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

  // ---------------------------------------------------------------------------
  // Pattern Detector
  // ---------------------------------------------------------------------------
  alerts: () => "hydra:alerts",

  // ---------------------------------------------------------------------------
  // Merge→done reconciler health (issue #2057)
  // Last-run snapshot of the merged-item reconciler so the scheduler-status
  // endpoint can surface feed liveness + batch metrics without re-running the
  // sweep. Single JSON blob, overwritten each hourly run; 2-day TTL so a
  // stopped scheduler leaves a visibly stale (then absent) record rather than
  // a permanently-fresh-looking one.
  // ---------------------------------------------------------------------------
  reconcilerHealth: () => "hydra:backlog:reconciler:health",

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

  // Weekly usage-snapshot chore cadence stamp (issue #2404). Mirrors
  // `digestLastWeekly` — a weekly time-guard read at the housekeeping
  // composition level so the per-skill rollup is persisted at most once per
  // ISO week.
  usageSnapshotLastWeekly: () => "hydra:metrics:usage-snapshot:last-weekly",

  // ---------------------------------------------------------------------------
  // Regression Hunt
  // ---------------------------------------------------------------------------
  regressionHuntLast: () => "hydra:regression-hunt:last",

  // ---------------------------------------------------------------------------
  // Event Streams
  // ---------------------------------------------------------------------------
  streamNotifications: () => "hydra:notifications",
  streamDlq: () => "hydra:dlq",
  streamAgentStream: () => "hydra:agent-stream",

  // ---------------------------------------------------------------------------
  // Dynamic stream lookup (for GET /events/:stream)
  // ---------------------------------------------------------------------------
  stream: (name: string) => `hydra:${name}`,
};
