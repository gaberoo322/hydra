# Hydra Reference

On-demand reference material. Not loaded automatically — read when needed.

For module roles and file structure, explore `src/` directly — static inventories rot faster than code changes.

## Redis Keys

| Pattern | Purpose |
|---|---|
| `hydra:cycle:active` | Currently running cycle ID |
| `hydra:cycle:active:{source}` | Per-source cycle registration (codex, claude). 15-min TTL. |
| `hydra:cycle:last` | Last completed cycle ID |
| `hydra:cycle:{id}` | Cycle hash (status, timestamps, counts) |
| `hydra:cycle:{id}:agents` | Agent runs for this cycle |
| `hydra:cycle:{id}:costs` | Token costs for this cycle |
| `hydra:task:{id}` | Task hash (state, evidence, scope) |
| `hydra:task:{id}:evidence:{state}` | Evidence chain per state transition |
| `hydra:anchors:work-queue` | Redis list -- items to work on (LMOVE to processing) |
| `hydra:anchors:processing` | Redis list -- items being processed (crash recovery) |
| `hydra:anchors:prior-failures` | Redis list -- failed tasks for retry |
| `hydra:anchors:reframe-queue` | Redis list -- tasks needing diagnosis after repeated failure |
| `hydra:anchors:abandonment-count:{ref}` | Counter per anchor, 24h TTL. Circuit breaker at 3. |
| `hydra:merge:lock` | Short-lived merge serialization lock (60s TTL) |
| `hydra:metrics:{id}` | Cycle metrics hash |
| `hydra:metrics:index` | Sorted set of cycle IDs by timestamp |
| `hydra:scheduler:state` | Persisted scheduler throttle state |
| `hydra:scheduler:daily-spend` | Daily codex spend counter |
| `hydra:backlog:items` | Hash -- backlog item data |
| `hydra:backlog:lane:{lane}` | Sorted set -- items per Kanban lane |
| `hydra:backlog:counter` | Monotonic ID counter for backlog items |
| `hydra:memory:{agent}:patterns` | String -- consolidated JSON patterns (15-slot rolling buffer) |
| `hydra:memory:last-consolidation` | Timestamp of last memory consolidation |
| `hydra:reflections:{ref}` | List -- episodic failure reflections (7-day TTL) |
| `hydra:reports:reality:{id}` | String -- reality report JSON |
| `hydra:reports:reality:index` | Sorted set -- reality report IDs |
| `hydra:reports:summary:*` | String -- cycle summary (2-day TTL) |
| `hydra:reports:research:*` | String -- research report JSON |
| `hydra:reports:research:index` | Sorted set -- research report IDs |
| `hydra:proposals:{id}` | Hash -- proposal data |
| `hydra:proposals:index` | Sorted set -- proposal IDs |
| `hydra:specs:*` | Hash -- spec data (30-day TTL) |
| `hydra:specs:index` | Sorted set -- spec IDs |
| `hydra:plans:cache:{hash}` | Cached plan results (LRU) |
| `hydra:alerts` | List -- dashboard alerts (kept 100) |
| `hydra:adversarial:stats` | Adversarial validation statistics |
| `hydra:adversarial:tracking` | Merge tracking for revert correlation |
| `hydra:regression-hunt:last` | Timestamp of last regression hunt (3-day cooldown) |
| `hydra:pattern-detector:cooldowns` | Pattern detector alert cooldowns |
| `hydra:blocked:last-escalation` | Timestamp of last blocked-item escalation |
| `hydra:deps:completed` | Completed dependency tracking |
| `hydra:deps:index` | Dependency index |
| `hydra:digest:last-weekly` | Timestamp of last weekly digest |
| `hydra:workspace:lock` | Workspace access lock |

## Event Bus

Redis Streams-based event bus (`src/event-bus.ts`). Streams:

| Stream | Purpose |
|---|---|
| `hydra:cycle` | Cycle start events |
| `hydra:tasks` | Task events (legacy) |
| `hydra:meta` | Meta analysis triggers |
| `hydra:proposals` | Proposal lifecycle events |
| `hydra:notifications` | All notifications (consumed by Telegram digest) |
| `hydra:dlq` | Dead letter queue (after 3 failed deliveries) |

Consumer groups: meta, orchestrator, telegram, dlq-processor. WebSocket broadcast to connected dashboard clients.

## API Endpoints (port 4000, all under /api)

Routes are split into domain sub-routers in `src/api/`. Each file exports a `create*Router(eventBus?)` factory.

**Cycles** (`api/cycles.ts`): POST /cycle/start, GET /cycle/status, GET /cycle/history, GET /cycle/report, POST /cycle/register, POST /cycle/complete
**Tasks** (`api/tasks.ts`): GET /tasks, GET /tasks/:id, GET /tasks/:id/evidence
**Queue** (`api/queue.ts`): POST /queue `{reference, reason, context}`, GET /queue
**Scheduler** (`api/scheduler.ts`): POST /scheduler/start, POST /scheduler/stop, GET /scheduler/status
**Research** (`api/research.ts`): POST /research/start, GET /research/latest, GET /research/history, POST /research/veto
**Backlog** (`api/backlog.ts`): GET /backlog, GET /backlog/counts, POST /backlog, POST /backlog/enhance, PATCH /backlog/:id, PATCH /backlog/:id/move, POST /backlog/:id/approve, GET /backlog/:id/children, DELETE /backlog/:id, POST /backlog/claim
**Specs** (`api/specs.ts`): GET /specs, GET /specs/:slug, POST /specs, POST /specs/:slug/archive
**Proposals** (`api/proposals.ts`): GET /proposals, POST /proposals/:id/approve, POST /proposals/:id/reject
**Metrics** (`api/metrics.ts`): GET /metrics, GET /spending, GET /summary, POST /metrics/record
**Health** (`api/health.ts`): GET /health, GET /health/services, GET /health/deep, GET /recommendations
**Misc** (`api/misc.ts`): Meta, goals, config, alerts, events, memory, merge locks, plan cache, digest, grounding, OpenViking, calibration, env, OpenAI proxy, webhooks, kill
