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
| `hydra:stuckness:cooldown:{outcome}` | Cooldown flag (30-min TTL ≈ 5 cycles). Suppresses stuckness-driven re-selection of the same outcome. Issue #253. |
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
**Outcomes** (`api/outcomes.ts`): GET /outcomes — declared Target Outcomes + current readings (issue #241)

## Target Outcomes (issue #241, ADR-0003 + ADR-0004)

`config/direction/outcomes.yaml` declares the structured contract between target vision (prose) and orchestrator behavior (code). Loader: `src/outcomes.ts`. API: `GET /api/outcomes`.

**Schema (per outcome):**

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | yes | string | Unique identifier; lowercase + dashes |
| `kind` | yes | `leading` \| `terminal` | `leading` = usable inside Tier-2 5-cycle holdback windows; `terminal` = ultimate goal, too slow for holdback |
| `direction` | yes | `up` \| `down` | Favorable direction for the value |
| `source` | yes | `prometheus` \| `api` \| `sql` \| `file` | Adapter dispatch in `getOutcomeValue` |
| `query` | yes | string | Source-specific lookup (URL path, file path, SQL string, prom expression) |
| `baseline` | yes | number | Starting reference |
| `target` | yes | number | Goal value |
| `stuckness_threshold_cycles` | yes | number | Cycles without sustained favorable movement before #242 fires |
| `noise_epsilon` | no (default 0) | number | Absolute change below this is treated as no-move |

**Source adapters:** `file` is implemented (reads a number from a path resolved against `HYDRA_ROOT`). `api`, `prometheus`, and `sql` are stubbed — they return `null` and log a warning rather than throwing, so downstream consumers (#242 stuckness, #244 holdback) treat them as no-data instead of synthetic regressions.

**Error handling:** `loadOutcomes()` never throws. Returns `{ ok: false, errors: string[] }` on parse / schema violations. Missing file is `{ ok: true, outcomes: [] }` so projects start with no outcomes declared without crashing.

**Dependency chain:** Foundational for ADR-0004 work-order — #242 (stuckness detector) and #244 (Tier-2 outcome holdback) import `loadOutcomes` and `getOutcomeValue`.

## Anchor Selection Priority

Order enforced by `selectAnchor()` in `src/anchor-selection.ts`:

1. **Explicit operator request** — `opts.anchor`
2. **Stuckness-driven research** (#253) — when any fired outcome from `getAllStuckness()` lacks a cooldown entry. Builds a `research`-type anchor with reference `outcome-stuckness:<name>` and `domain: orchestrator-self-improvement`. Leading outcomes outrank terminal; within a kind, most-stuck wins (lex name tiebreak). Sets 30-min cooldown (~5 cycles) to prevent thrashing on the same signal. Enforces ADR-0003 vision vector 1.
3. **Kanban queued lane** — atomic Lua claim, WIP-gated
4. **Active specs** — next unchecked task from oldest active spec
5. **Failing tests** — from grounding
6. **Typecheck errors** — from grounding
7. **Work queue** (`POST /api/queue`, research auto-queue) — LMOVE to processing
8. **Reframe queue** — repeated failures awaiting diagnosis
9. **Prior failures** — Redis-tracked; cap 2 retries
10. **TODO/FIXME markers** — from codebase
11. **Regression hunt** — every 10 merges
12. **Codebase health** — reductive improvements
13. **Priorities doc** — `config/direction/priorities.md`, auto-refreshed if stale

**Notifications stream emits** `anchor.selected.stuckness` `{outcomeName, cycles, threshold, kind}` when slot 2 fires (issue #253). Dashboard + digest consume via existing `hydra:notifications` subscription.

## ADR-0002 target swap (issue #258 / #259)

The orchestrator builds one Target Project per instance. The operator switches targets by editing two env vars and restarting the service. All path/name lookups should route through `src/target-config.ts` rather than reading the env directly.

| Var | Default | Effect |
|---|---|---|
| `HYDRA_PROJECT_WORKSPACE` | `<homedir>/<HYDRA_TARGET_NAME>` (with one-time warn) | Absolute path to the target workspace. Drives where Codex executes, where context-builder reads, where worktrees are rooted, etc. |
| `HYDRA_TARGET_NAME` | `hydra-betting` (with one-time warn) | Short slug used for the systemd unit name (`${name}-web.service`), the worktree directory prefix (`${name}-worktree`), and operator-instruction strings. |
| `HYDRA_TARGET_GITHUB_REPO` | `gaberoo322/hydra-betting` (with one-time warn) | GitHub repo identifier in `owner/repo` form. Drives commit-link URLs emitted by `notify.ts` (Telegram cycle-complete messages) and `digest.ts` (periodic digests). Read via `getTargetGithubRepo()` / `getTargetCommitUrl(sha)`. |
| `HYDRA_WORKSPACE` | — | **Deprecated.** Legacy alias for `HYDRA_PROJECT_WORKSPACE` (`context-builder.ts` historically read this). `getTargetWorkspace()` falls back to it with a one-time deprecation warning. Removed once #259 migrates the last caller. |

`src/target-config.ts` exposes six pure leaf-level helpers — `getTargetName()`, `getTargetWorkspace()`, `getTargetServiceName()`, `getTargetWorktreePrefix()`, `getTargetGithubRepo()`, `getTargetCommitUrl(sha)` — that memoize their warnings so each fires at most once per process. Per ADR-0002, the helpers return a single string each; no multi-target abstraction.

**Migration status:** issue #258 adds the helper module only — no existing callers are rewritten. The mechanical sweep of the ~17 callsites (and removal of the `HYDRA_WORKSPACE` shim) is tracked in issue #259.

## Codex OpenTelemetry (issue #199)

The Codex CLI emits OTel traces and logs natively. Hydra correlates those with cycles by injecting per-call resource attributes into the spawned CLI process environment (`src/codex-otel.ts`, wired through `src/codex-runner.ts`).

**Resource attributes added per agent call:**

| Attribute | Source | Example |
|---|---|---|
| `hydra.cycle_id` | `correlationId` passed to `runAgent()` | `cycle-2026-05-09-1234` |
| `hydra.agent_role` | `agentName` | `planner`, `executor`, `fixer`, `meta`, `high-risk-review` |
| `hydra.task_id` | `taskId` | backlog item ID / spec task slug |
| `hydra.model_tier` | requested tier | `frontier`, `codex`, `mini`, `local` |
| `hydra.model` | resolved model | `gpt-5.5`, `gpt-5.3-codex`, `gpt-5.4-mini`, `gemma-4-26b` |
| `hydra.complexity` | classifier output | `quick-fix`, `standard`, `complex`, `high-risk` |

**Environment variables (Hydra orchestrator):**

| Var | Default | Effect |
|---|---|---|
| `HYDRA_OTEL_ENABLED` | `false` | When `true` (or `1`), Hydra constructs a per-call Codex with merged OTel env. When unset/false, behavior is unchanged (singleton Codex, no env injection). |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Base attrs merged with `hydra.*` (hydra wins on collision). Use for deployment.environment, team, etc. |
| `OTEL_SERVICE_NAME` | `hydra-codex` | Defaulted only if operator hasn't set one. |

**Codex CLI configuration (`~/.codex/config.toml`):**

```toml
[otel]
log_user_prompt = true

[otel.exporter.otlp-grpc]
endpoint = "https://ingest.eu.signoz.cloud:443"
# Headers loaded from env so the ingestion key never lands in git
```

Set the ingestion key out-of-band:

```bash
export OTEL_EXPORTER_OTLP_HEADERS="signoz-ingestion-key=$(cat ~/.codex/signoz.key)"
```

**Self-hosted Tempo wiring:** the operator-chosen Tier-2 backend (issue #206) is self-hosted Tempo behind an otel-collector. Ready-to-copy example artifacts live in `scripts/otel/`:

- `scripts/otel/docker-compose.example.yml` — otel-collector-contrib + Tempo on a bridge network, both ports bound to `127.0.0.1` only.
- `scripts/otel/otel-collector.example.yaml` — OTLP/gRPC in on 4317, OTLP/HTTP out to Tempo on 4318; passes `hydra.*` resource attributes through unchanged.
- `scripts/otel/tempo.example.yaml` — minimal single-binary Tempo with local-filesystem trace storage.
- `scripts/otel/codex-config.example.toml` — the `[otel]` block for `~/.codex/config.toml`; ingest key referenced as `${OTEL_INGEST_KEY}` (shell-style env expansion) so the secret stays out of this file.
- `scripts/otel/hydra-orchestrator.otel.env.example` — systemd EnvironmentFile template (`/etc/hydra/otel.env`, chmod 600).
- `scripts/otel/hydra-orchestrator.otel.dropin.conf.example` — systemd drop-in for `~/.config/systemd/user/hydra-orchestrator.service.d/otel.conf`; uses `EnvironmentFile=-/etc/hydra/otel.env` (leading dash = tolerant of a missing file).
- `scripts/otel/README.md` — operator runbook: install order, dry-run validation commands, rollback.

**Secrets via EnvironmentFile, not the unit file:** `OTEL_INGEST_KEY` lives in `/etc/hydra/otel.env`, not in `hydra-orchestrator.service` or in `~/.codex/config.toml`. Rationale: rolling the key only requires rewriting that file and `systemctl restart`, never editing the user-owned service unit or Codex config. The Codex toml references the key via `${OTEL_INGEST_KEY}` expansion so the value is resolved at process start from systemd's loaded environment.

**Verifying:** with OTel enabled, run a single cycle, grab the cycle ID from `journalctl --user -u hydra-orchestrator.service` (or `/api/cycle/status`), then run this TraceQL query against Tempo (via Grafana or directly against the API on `127.0.0.1:3200`):

```traceql
{ resource.hydra.cycle_id = "<cycle-id>" }
```

You should get one trace per agent call (planner, executor, optionally fixer / high-risk-review), each carrying `resource.hydra.agent_role`, `resource.hydra.model_tier`, `resource.hydra.complexity`. Group by `resource.hydra.agent_role` for per-agent latency / token counts.

## Merge Gate (`src/gate.ts`) (issue #249, ADR-0001 work-order step 6)

The merge gate is the operator-only Tier-0 surface the control loop calls for every merge-proof step. `src/gate.ts` is a thin facade — it names and exposes the gate-proof contract; the underlying logic still lives in `verification.ts` / `mutation.ts` / `scope-enforcement.ts` / `cost-cap.ts` / `pipeline-steps.ts` / `redis-adapter.ts` and evolves under their own tier rules. The gate's contract is Tier-0; the loop body that calls it (`control-loop.ts`) and the logic the gate delegates to (where allowed) can evolve through normal PR flow.

| Function | Step | Delegates to |
|---|---|---|
| `gateGrounding(workspace, opts?)` | 1b / post-merge re-ground | `groundProject` in `grounding.ts` |
| `gateVerify(ctx, task, diff, execResult, complexity, filesInScope, criteriaCount, taskId)` | 6 through 6.9 | `runVerificationPipeline` in `verification.ts` |
| `gateScopeEnforcement(ctx, task, verification, taskId)` | 6.9 — >80% out-of-scope blocks merge | `runScopeEnforcement` in `scope-enforcement.ts` |
| `gateMutationKillRate(ctx, task, verification, execResult, complexity, filesInScope, criteriaCount, taskId)` | 6.7 — <30% kill rate blocks non-quick-fix | `runMutationGate` in `mutation.ts` |
| `gateAcquireMergeLock(cycleId, ttlSeconds?)` | 7 — Redis lock (60s TTL) | `acquireMergeLock` in `redis-adapter.ts` |
| `gateReleaseMergeLock()` | 7 + finally safety-net | `releaseMergeLock` in `redis-adapter.ts` |
| `gateMergeToMain(projectDir, cycleId, explicitFeatureBranch?)` | 7 — `git merge --no-ff` + push | `mergeToMain` in `pipeline-steps.ts` |
| `gateRollback(projectDir, commitSha, reason)` | 8 — `git revert -m 1` + push when tests regress | inline (revert mechanics live in `gate.ts`) |
| `gateCheckCostCap(ctx, task, taskId, checkpoint)` | 4.5 / 5.5 — per-cycle $-cap | `runCostCapCheck` in `cost-cap.ts` |
| `getPerCycleCostCapUsd()` | logging | re-exported from `cost-cap.ts` |
| `gateGetMergeLockHolder()` | diagnostics | re-exported from `redis-adapter.ts` |

**Invariants:**
- The control loop and `pipeline-steps.ts` / `post-merge.ts` import from `gate.ts` for every gate-proof call site. Reaching around the gate (e.g. importing `groundProject` directly for a post-merge re-ground) is a contract violation; it cannot be enforced by the type system, so reviewers check it and `test/gate-surface.test.mts` pins the named exports.
- `gate.ts` is listed in `UNTOUCHABLE_PATHS` (`src/untouchable.ts`) — any change to the facade requires `operator-approved`.
- The gate adds no behavior. Pure refactor — same tests pass before and after.

## Modification Tiers (issue #243, ADR-0001 + ADR-0004)

Every PR is classified into one of four tiers based on the files it touches. The classifier (`src/tier-classifier.ts`) is invoked by the `tier-gate` CI job and exposed at `GET /api/tier?files=a,b,c`.

| Tier | Policy | Paths |
|---|---|---|
| **0 — Untouchable Core** | Operator-approved label required; CI blocks otherwise | See `src/untouchable.ts` (canonical list) |
| **1 — Auto-merge, no holdback** | Ships if CI green | `config/agents/`, `config/feedback/` |
| **2 — Auto-merge with outcome holdback** | Ships if CI green; auto-revert if Target Outcomes regress for 5 cycles (holdback impl is a follow-up issue) | `.claude/skills/`, `dashboard/`, `src/anchor-selection.ts` |
| **3 — Operator review** | Default; operator merges | Everything else in `src/`, new agent roles, etc. |

**Multi-file PRs:** Tier 0 short-circuits everything else. Otherwise the highest tier number wins (most operator scrutiny).

**Tier 0 list (`UNTOUCHABLE_PATHS`):** `src/gate.ts` (proactive — protected before extraction), `src/grounding.ts`, `src/verification.ts`, `src/post-merge.ts`, `src/redis-adapter.ts`, `src/cost-cap.ts`, `src/control-loop.ts`, `scripts/deploy.sh`, `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `scripts/tier-classify.ts`, `src/untouchable.ts`, `src/tier-classifier.ts`. Out-of-repo: `~/.local/bin/hydra-orchestrator-watchdog.sh` (the watchdog script — `gh pr diff` won't surface it, so it's protected by location rather than by the classifier).

**The `operator-approved` label:** GitHub doesn't enforce per-user labels natively. The convention is that only the operator account (gaberoo322) applies it. The `tier-gate` CI job fails any Tier-0 PR without the label; merging anyway requires admin override, which only the operator has. Do not attempt CODEOWNERS-based simulation — keep the gate dumb and auditable.

**Extending the Tier-2 list:** add a path to `TIER_2_PREFIXES` or `TIER_2_FILES` in `src/tier-classifier.ts`. Note: `src/tier-classifier.ts` is itself Tier 0, so the change requires `operator-approved`.

**Adding a Tier-0 path:** modify `UNTOUCHABLE_PATHS` in `src/untouchable.ts`. Same self-protection — the file is in its own list.

**CLI wrapper:** `npx tsx scripts/tier-classify.ts [--operator-approved] <file1> <file2> ...` prints JSON `{tier, reason, files, operatorApproved, perFile}` and exits 2 if Tier 0 without the flag, 0 otherwise. Accepts piped input (`gh pr diff --name-only N | npx tsx scripts/tier-classify.ts`).
