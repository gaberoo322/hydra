# Hydra Reference

On-demand reference material. Not loaded automatically — read when needed.

For module roles and file structure, explore `src/` directly — static inventories rot faster than code changes.

## Redis Keys

| Pattern | Purpose |
|---|---|
| `hydra:cycle:active` | Currently running cycle ID |
| `hydra:cycle:active:{source}` | Per-source cycle registration. Historically multi-source (`codex`, `claude`); post-2026-05-14 codex cut-over, only the `claude` source writes. 15-min TTL. |
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
| `hydra:scheduler:daily-spend` | Daily token-spend counter. Historically codex; post-cut-over, populated only when the Claude Code harness exposes per-call token usage. |
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

**Cycles** (`api/cycles.ts`): GET /cycle/status, GET /cycle/history, GET /cycle/report, POST /cycle/register, POST /cycle/complete
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
| `noise_epsilon` | no (default 0) | number | Absolute change below this is treated as no-move |

(The `stuckness_threshold_cycles` field was removed in ADR-0010 along with the detector it fed.)

**Source adapters:** `file` is implemented (reads a number from a path resolved against `HYDRA_ROOT`). `api`, `prometheus`, and `sql` are stubbed — they return `null` and log a warning rather than throwing, so downstream consumers (#244 holdback) treat them as no-data instead of synthetic regressions.

**Error handling:** `loadOutcomes()` never throws. Returns `{ ok: false, errors: string[] }` on parse / schema violations. Missing file is `{ ok: true, outcomes: [] }` so projects start with no outcomes declared without crashing.

**Dependency chain:** Foundational for ADR-0004 work-order — #244 (Tier-2 outcome holdback) imports `loadOutcomes` and `getOutcomeValue`.

## Candidate Feed (ADR-0016)

The `selectAnchor()` priority waterfall (a 13-tier chain in the retired
`src/anchor-selection/` family) was **deleted by ADR-0016**: it was orphaned at
both ends when ADR-0006 removed the in-process control loop, and ADR-0012 made
`decide.py` the single decisional brain. Retry / escalation / abandonment
policy — the product intent behind the Reframe Queue — belongs to `decide.py`,
not a dormant TypeScript store.

The live concept is the **Candidate Feed**: `src/anchor-candidates.ts`
(`getCandidateFeed(opts, deps?)`), served read-only at
`GET /api/anchor/candidates` (`src/api/anchor.ts` is a thin route over it). It
is *data the brain reads, not a decision the orchestrator makes*. One deep
module owns:

- **Enumeration** — the only two lanes with live writers: backlog kanban
  (`loadBacklog` — inProgress ∪ queued ∪ backlog) ∪ work-queue
  (`getWorkQueueItems`, fed by `POST /api/queue` + research auto-queue).
- **Scoring** — tier base (`kanban-queued` 0.85, `work-queue` 0.70) + freshness
  penalty (>14d, −0.15) + recent-reflection penalty (<24h, −0.20) +
  blocker-just-cleared bonus (+0.15), clamped to [0,1]. The abandonment penalty
  and the reframe / prior-failure / regression-hunt / codebase-health /
  priorities-doc tiers were dropped with their now-empty lanes.
- **Eligibility** — in-flight-PR 30-min suppression (#640), blocker-just-cleared
  detection, design-concept annotation (#628), and `research_recommended` (top
  score < 0.5, or no candidates).

`deps?` is injectable (`loadBacklog` / `getWorkQueueItems` / reflection reader /
design-concept reader) so the feed is the unit-test surface.

## ADR-0002 target swap (issue #258 / #259)

The orchestrator builds one Target Project per instance. The operator switches targets by editing two env vars and restarting the service. All path/name lookups should route through `src/target-config.ts` rather than reading the env directly.

| Var | Default | Effect |
|---|---|---|
| `HYDRA_PROJECT_WORKSPACE` | `<homedir>/<HYDRA_TARGET_NAME>` (with one-time warn) | Absolute path to the target workspace. Drives where `hydra-target-build` subagents run, where context-builder reads, where worktrees are rooted, etc. |
| `HYDRA_TARGET_NAME` | `hydra-betting` (with one-time warn) | Short slug used for the systemd unit name (`${name}-web.service`), the worktree directory prefix (`${name}-worktree`), and operator-instruction strings. |
| `HYDRA_TARGET_GITHUB_REPO` | `gaberoo322/hydra-betting` (with one-time warn) | GitHub repo identifier in `owner/repo` form. Drives commit-link URLs emitted by `notify.ts` (Telegram cycle-complete messages) and `digest.ts` (periodic digests). Read via `getTargetGithubRepo()` / `getTargetCommitUrl(sha)`. |
| `HYDRA_WORKSPACE` | — | **Deprecated.** Legacy alias for `HYDRA_PROJECT_WORKSPACE` (`context-builder.ts` historically read this). `getTargetWorkspace()` falls back to it with a one-time deprecation warning. Removed once #259 migrates the last caller. |

`src/target-config.ts` exposes six pure leaf-level helpers — `getTargetName()`, `getTargetWorkspace()`, `getTargetServiceName()`, `getTargetWorktreePrefix()`, `getTargetGithubRepo()`, `getTargetCommitUrl(sha)` — that memoize their warnings so each fires at most once per process. Per ADR-0002, the helpers return a single string each; no multi-target abstraction.

**Migration status:** issue #258 adds the helper module only — no existing callers are rewritten. The mechanical sweep of the ~17 callsites (and removal of the `HYDRA_WORKSPACE` shim) is tracked in issue #259.

## Codex OpenTelemetry (issue #199) — historical

> **Historical, kept for trace lookup.** The Codex CLI runtime was removed on
> 2026-05-14 ([ADR-0006](adr/0006-codex-cli-removed-autopilot-only.md)). No new
> OTel spans are emitted by Hydra. The `src/codex-otel.ts` helper and its
> `buildTraceUrl` function are intentionally retained so operators can still
> open the Grafana / Tempo / SigNoz drill-down for historical cycle IDs from
> the trace-UI link on `/cycles`. Once the trace-storage retention window on
> the historical spans expires, `src/codex-otel.ts` will be retired.

The Codex CLI emitted OTel traces and logs natively. Hydra correlated those with cycles by injecting per-call resource attributes into the spawned CLI process environment (`src/codex-otel.ts`, formerly wired through `src/codex-runner.ts`).

**Resource attributes that were added per agent call (historical):**

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

### Tier-3 operator runbook (issue #207)

Once the Tier-2 collector + Tempo are running (see "Self-hosted Tempo wiring" above) and one cycle has exported successfully, the operator-facing surface lives in two places:

1. **Grafana dashboard JSONs** in `docs/observability/`:
   - `grafana-hydra-overview.json` — per-agent latency p50/p95, token counts, model attribution, error rate, grouped by `hydra.agent_role`.
   - `grafana-hydra-cycle-drilldown.json` — pick a `hydra.cycle_id`, see all spans + planner-prompt vs executor-spans side-by-side.
   - Import via Grafana → Dashboards → Import → Upload JSON. Map the `tempo` datasource variable on the import screen. Both dashboards declare stable UIDs so they can be linked to.

2. **Link from the Hydra dashboard** (cycle detail → trace UI):
   - Set `HYDRA_TRACE_UI_URL` to a template containing `{cycleId}`, e.g. `http://localhost:3000/d/hydra-otel-cycle-drilldown/hydra-cycle-drill-down?var-cycle_id={cycleId}`.
   - When set, the Cycles page (`/cycles`) renders a "traces ↗" link next to the active cycle and each history row.
   - Resolution logic lives in `buildTraceUrl` in `src/codex-otel.ts` and is mirrored client-side; the dashboard pulls the template from `GET /api/observability/config`.
   - Templates without `{cycleId}` are tolerated: the orchestrator appends `?hydra_cycle_id=<id>` (or `&hydra_cycle_id=<id>` if the template already has a query string).

#### Find a failed cycle's traces

1. From the Hydra dashboard `/cycles` page, find the failed row (red status badge or `failed` / `rolled-back`). Note the cycle ID, or click the "traces ↗" link if `HYDRA_TRACE_UI_URL` is set.
2. Otherwise pull the cycle ID directly:
   ```bash
   journalctl --user -u hydra-orchestrator.service | grep -E "cycle (started|merged|failed|abandoned)" | tail -5
   # or
   curl -s http://localhost:4000/api/cycle/history?limit=10 | jq -r '.[] | "\(.cycleId)\t\(.status)"'
   ```
3. Open the cycle drill-down dashboard with `cycle_id` populated. The TraceQL filter is `{ resource.hydra.cycle_id = "<id>" }`. Useful follow-up queries:
   - Planner only: `{ resource.hydra.cycle_id = "<id>" && resource.hydra.agent_role = "planner" }`
   - Errors only: `{ resource.hydra.cycle_id = "<id>" && status = error }`
   - High-risk review (only present when it ran): `{ resource.hydra.cycle_id = "<id>" && resource.hydra.agent_role = "high-risk-review" }`
4. The planner span's events include the user prompt when Codex's `[otel] log_user_prompt = true` is set (see `scripts/otel/codex-config.example.toml`). Compare side-by-side with the executor span to debug preflight abandonment without grepping `journalctl`.

#### Enable / disable the exporter

Hydra-side gate is a single env var (`src/codex-otel.ts` → `isOtelEnabled`):

```bash
# Enable (also requires Codex CLI to be configured — see Self-hosted Tempo wiring)
sudo install -m 0600 -o root -g root /dev/stdin /etc/hydra/otel.env <<'EOF'
HYDRA_OTEL_ENABLED=true
OTEL_INGEST_KEY=<paste real value>
EOF
systemctl --user daemon-reload
systemctl --user restart hydra-orchestrator.service

# Disable (no edits to user-owned files; just blank the env file)
sudo install -m 0600 -o root -g root /dev/stdin /etc/hydra/otel.env <<'EOF'
HYDRA_OTEL_ENABLED=false
EOF
systemctl --user restart hydra-orchestrator.service
```

With `HYDRA_OTEL_ENABLED=false` (or unset), `buildCodexOtelEnv` returns `null` and the per-call env-injection path is skipped entirely — Codex CLI keeps its inherited env. Tier-2 containers can be left running or torn down independently.

#### Rotate the ingestion key

The key lives only in `/etc/hydra/otel.env` (chmod 600, root-owned). The `~/.codex/config.toml` references it as `${OTEL_INGEST_KEY}` (shell-style expansion) and the systemd unit picks it up via `EnvironmentFile=-/etc/hydra/otel.env`. Rolling it is one file write plus one restart:

```bash
sudo install -m 0600 -o root -g root /dev/stdin /etc/hydra/otel.env <<'EOF'
HYDRA_OTEL_ENABLED=true
OTEL_INGEST_KEY=<new value>
EOF
systemctl --user restart hydra-orchestrator.service
```

No edits to the user-owned Codex config or to the systemd unit are required.

#### Bump the sampling rate

Sampling happens in two places, and they have different bumping mechanics:

- **Codex CLI** (per-process tail sampling) — add `sampler = "always_on"` (the default) or `sampler = "traceidratio"` with a `sampler_arg = 0.5` (50%) in the `[otel]` block of `~/.codex/config.toml`. Restart the orchestrator for the change to be picked up on the next agent call.
- **Collector** (`scripts/otel/otel-collector.example.yaml`) — the example collector has no tail sampler; everything Codex sends is forwarded to Tempo. To add probabilistic sampling at the collector, drop in a `processors: probabilistic_sampler: sampling_percentage: 50` and reference it in the traces pipeline. Then `docker compose restart otel-collector`. The orchestrator doesn't need to know.

Spans are cheap until they hit Tempo's storage — start at 100% (default), only sample down if Tempo disk usage gets uncomfortable.

#### Span discovery — what to look for

| Cycle outcome | Where to look first |
|---|---|
| Preflight abandoned | Planner span only (no executor). The planner prompt/response shows what was proposed; preflight failure reasons are in the orchestrator logs, not in spans. |
| Verification failed → fixer ran | Sequence: planner → executor → fixer. Compare fixer prompt to executor diff. |
| High-risk review rejected | Sequence: planner → high-risk-review. The review span's response carries the reasoning. |
| Scope-out merge block | Executor span ran to completion; rejection happens in `src/scope-enforcement.ts` and is in journalctl, not spans. |
| Rolled back post-merge | Look for the executor span on the *next* cycle's lineage; the revert itself isn't an agent call. |

## Merge Gate — historical (issue #249, removed in PR-3 / #383)

The in-process `src/gate.ts` facade and its delegates (`verification.ts`,
`scope-enforcement.ts`, `runMutationGate` in `mutation.ts`,
`pipeline-steps.ts`, `post-merge.ts`, `control-loop.ts`) were deleted with
the codex-CLI cut-over (PR-3, issue #383). The merge gate is now
out-of-process: GitHub branch protection + CI quality gates
(`.github/workflows/ci.yml`, `scripts/ci/scope-check.ts`,
`scripts/ci/mutation-check.ts`, `tier-gate`) enforce the same proofs at PR
time. See [ADR-0006](./adr/0006-codex-cli-removed-autopilot-only.md) and
[`docs/quality-gates.md`](./quality-gates.md).

Issue #476 finished the residual cleanup: `src/scope-enforcement.ts` and
the in-cycle gate orchestration in `src/mutation.ts` (`runMutationGate`,
`MUTATION_DECISION`, `classifyNoSignalDecision`, `summarizeMutationTests`,
`getQuickFixKillThreshold`) were deleted. The CI gate keeps importing the
pure helpers (`runMutationTests`, `shouldSkipMutation`, `SKIP_PATTERNS`)
from `src/mutation.ts`.

## Modification Tiers (issue #243, ADR-0001 + ADR-0004 + ADR-0015)

Every PR is classified by blast radius on the monotonic ladder **T1 (shallowest) → T4 (deepest)** based on the files it touches; required verification depth ascends with the tier (ADR-0015 replaced the old "who merges this" framing with "how much verification it must clear", and renamed the deepest tier from *Untouchable Core* to *Verifier Core*). The classifier (`src/tier-classifier.ts`) is invoked by the `tier-gate` CI job and exposed at `GET /api/tier?files=a,b,c`.

| Tier | Policy | Paths |
|---|---|---|
| **T1 — Prompt-shaped** | Auto-merge if CI green | `config/agents/`, `config/feedback/`, subagent lesson files |
| **T2 — Skill / verification** | Auto-merge if CI green; **Outcome Holdback** (5-cycle watch + auto-revert if Target Outcomes regress) | `~/.claude/skills/`, `dashboard/`, `src/anchor-selection/` |
| **T3 — Core `src/` + demoted infra** | Operator merges (auto-merge unless the PR body carries a `scope-justification:`) | Everything else in `src/`, plus the ADR-0015-demoted infra paths: `src/grounding.ts`, `src/cost/`, the watchdog scripts, `scripts/deploy.sh` |
| **T4 — Verifier Core** | **Operator only** — `operator-approved` label required; CI blocks otherwise | The 5 self-referential files (`VERIFIER_CORE_PATHS` in `src/untouchable.ts`) |

**Multi-file PRs:** the highest tier wins (most verification / scrutiny).

**Verifier Core list (`VERIFIER_CORE_PATHS` / `isVerifierCore` in `src/untouchable.ts`):** `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`. ADR-0015 (#737) shrank the deepest tier to exactly these 5 self-referential files and demoted the former Tier-0 infra paths (`src/grounding.ts`, `src/cost/`, the watchdog scripts, `scripts/deploy.sh`) down to T3. The pre-#383 entries `src/gate.ts` / `src/verification.ts` / `src/post-merge.ts` / `src/control-loop.ts` / `src/redis-adapter.ts` no longer exist (removed with the codex cut-over). "Untouchable Core" is the retired name for the Verifier Core.

**The `operator-approved` label:** GitHub doesn't enforce per-user labels natively. The convention is that only the operator account (gaberoo322) applies it. The `tier-gate` CI job fails any T4 (Verifier Core) PR without the label; merging anyway requires admin override, which only the operator has. Do not attempt CODEOWNERS-based simulation — keep the gate dumb and auditable.

**Extending the T2 list:** add a path to `TIER_2_PREFIXES` or `TIER_2_FILES` in `src/tier-classifier.ts`. Note: `src/tier-classifier.ts` is itself a Verifier Core (T4) file, so the change requires `operator-approved`.

**Adding a Verifier Core path:** modify `VERIFIER_CORE_PATHS` in `src/untouchable.ts`. Same self-protection — the file is in its own list.

**CLI wrapper:** `npx tsx scripts/tier-classify.ts [--operator-approved] <file1> <file2> ...` prints JSON `{tier, reason, files, operatorApproved, perFile}` and exits 2 if a Verifier-Core (T4) path lacks the flag, 0 otherwise. Accepts piped input (`gh pr diff --name-only N | npx tsx scripts/tier-classify.ts`).

## Outcome Holdback — Post-merge Regression Check (issue #786, ADR-0004 step 4)

Tier-2 self-modifications ship as soon as CI is green, but the orchestrator then watches the **leading** Target Outcomes (declared in `config/direction/outcomes.yaml`, kind `leading`) for a watch window after the merge. If any leading outcome regresses unfavorably past its `noise_epsilon` vs the pre-merge baseline, the commit is **auto-reverted** via a `git revert` PR.

**This is the autopilot-only producer, not an in-process watcher.** The original in-process `src/holdback.ts` timer-watcher (with `src/post-merge.ts` / `src/control-loop.ts` wiring and the `hydra:tier2:disabled` kill switch) was **deleted in the ADR-0006 codex cut-over** and is gone. The replacement is the **hydra-qa Post-merge Regression Check** (`docs/operator-playbooks/hydra-qa.md` → "Post-merge Regression Check"): request-scoped work the autopilot poll loop dispatches *after* a merge — no timer, no sampler, no long-lived loop (reintroducing one is the orphaned-recorder failure mode that retired the stuckness detector, ADR-0010). Holdback is read-only with respect to merge; its only action is to open a revert PR.

Implementation seam:
- `src/holdback.ts` — request-scoped producer: `enrollHoldback` (snapshot baseline), `checkHoldback` (sample, detect regression, enforce cap, emit events, return a `decision`), `reportRevertFailed`.
- `src/redis/holdback.ts` — typed Redis accessor for the per-merge baseline + per-day revert counter (ADR-0009 seam).
- `src/outcomes.ts` — `snapshotLeadingOutcomes` / `detectRegressions` helpers (leading-only, null = no-data).
- `src/api/holdback.ts` — `POST /api/holdback/{enroll,check,revert-failed}`, the HTTP surface the playbook drives.
- `src/digest.ts` — the (previously orphaned) consumer of the holdback.* events.

### Redis state

| Key | Type | Purpose |
|---|---|---|
| `hydra:holdback:baseline:{commitSha}` | string (JSON `HoldbackBaseline`) | Pre-merge snapshot of the leading outcomes + window/tier/prNumber. TTL `HYDRA_HOLDBACK_BASELINE_TTL_SECONDS` (default 14d). |
| `hydra:holdback:reverts:{YYYY-MM-DD}` | counter | Per-UTC-day revert tally; reverts suppressed once it reaches `HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY` (default 3). 7d TTL. |

### Events

Published on `STREAMS.NOTIFICATIONS` (consumed by `src/digest.ts`):

- `holdback.reverted` — a leading outcome regressed and the revert was warranted. Payload: `{commitSha, prNumber, regressedOutcomes}`.
- `holdback.cap-reached` — per-day revert cap hit; the regression was surfaced but the revert suppressed. Payload: `{commitSha, prNumber, regressedOutcomes}`.
- `holdback.revert_failed` — the playbook's `git revert` / PR-open failed after a warranted revert. Payload: `{commitSha, reason}`.

### Tunables (named, env-overridable — ADR-0005)

Defaults live in `src/redis/holdback.ts`; documented in `config/direction/outcomes.yaml`:

- `HYDRA_HOLDBACK_WINDOW_CYCLES` (default 5) — T2-floor watch window length in cycles. #741 layers a tier-aware map on top.
- `HYDRA_HOLDBACK_MAX_REVERTS_PER_DAY` (default 3) — global per-UTC-day revert cap.
- `HYDRA_HOLDBACK_BASELINE_TTL_SECONDS` (default 14d) — baseline-record TTL.
- `HYDRA_HOLDBACK_CYCLE_MS` (default 1h) — wall-clock per cycle, used to decide when a window has elapsed.

### Behavior guarantees

- **Terminal outcomes are excluded.** Only `kind: leading` outcomes drive the holdback decision — terminal outcomes are too slow for the window (ADR-0004; `outcomes.yaml` schema comment).
- **Adapter outages are no-data, not regressions.** A null reading on either side of the comparison never counts as a regression ("no false revert").
- **Enroll only fires when at least one leading outcome adapter returned data.** An all-null baseline makes every future regression unknowable, so such a merge sits as "no signal" rather than a false holdback.
- **Regression = unfavorable move past epsilon.** A favorable move, or a move within `noise_epsilon`, is not a regression.
- **Per-day revert cap precedes any revert.** Once the cap is reached the producer emits `holdback.cap-reached` and suppresses further reverts for the UTC day. The cap counter fails closed on a Redis error (treats the cap as reached) — a runaway revert loop is far more expensive than missing one revert.

### Scope (recap)

This issue (#786) is the **T2 floor**: only T2 merges are enrolled (the default 5-cycle window). Broadening enrollment to T3/T4 with tier-aware windows is the sibling issue **#741**, which depends on this producer. T1 (prompt-shaped) merges are never enrolled.

## Cost reconciliation (issue #296) — historical

> **Historical, scoped to codex-era data.** With the Codex CLI runtime
> removed on 2026-05-14 ([ADR-0006](adr/0006-codex-cli-removed-autopilot-only.md))
> there is no on-disk JSONL session log to replay. `src/cost/reconciliation.ts`
> still runs and can produce reports for *dates that fall in the codex era*; for
> dates after the cut-over it returns an empty result (no session files match).
> The module and its `GET /api/cost/reconciliation` endpoint are retained so
> operators can answer historical forensic questions; a follow-up issue will
> retire them along with `src/codex-otel.ts`.

Hydra's local cost accounting has two independent figures that historically disagreed by ~200x:
- `/api/scheduler/status.dailySpendUsd` — rolling counter incremented per agent call
- sum of `/api/metrics` `costMicrodollars` — per-cycle metrics aggregation

`src/cost/reconciliation.ts` adds a third, independent figure: replay Codex CLI's own on-disk session JSONL logs, aggregate authoritative token counts per model, and multiply by `MODEL_PRICING` from the historical pricing table. The three figures can then be compared to find which side of Hydra's accounting drifted.

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `CODEX_HOME` | `~/.codex` | Root of Codex's local state. The module reads sessions from `${CODEX_HOME}/sessions/{YYYY}/{MM}/{DD}/*.jsonl`. |

### Kill switch

Setting `hydra:cost-reconciliation:disabled` to `"1"` or `"true"` in Redis short-circuits `reconcileDailyCosts()` before any filesystem work. Used to disable the future scheduler hook if the disk walk becomes a hotspot.

### JSONL schema dependency

Verified against Codex CLI 0.125.0:
- One file per CLI turn, path `${CODEX_HOME}/sessions/{YYYY}/{MM}/{DD}/rollout-{iso-timestamp}-{uuid}.jsonl`
- Each line is a JSON object with a `type` discriminator. Two types matter:
  - `turn_context` — carries the active model in `payload.model` (fallback: `payload.collaboration_mode.settings.model`)
  - `event_msg` with `payload.type === "token_count"` — carries authoritative usage in `payload.info.total_token_usage.{input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens}`
- `total_token_usage` is **cumulative** within the session; the last `token_count` event with non-null `info` is the session total. Earlier events are subsets and must not be summed.

If the CLI changes this schema, the parser at the top of `src/cost/reconciliation.ts` documents the contract and tests in `test/cost-reconciliation.test.mts` will catch regressions in the cumulative-vs-incremental handling.

### Pricing source

`~/.codex/models_cache.json` was inspected and does **not** carry pricing — only model slugs and reasoning levels. The reconciliation falls back to `MODEL_PRICING` from `codex-runner.ts` (same hardcoded rates Hydra uses today). Token counts are independent; dollar figures share Hydra's rate table. A follow-up issue should source pricing from a stable upstream so the $-figure is also independent.

### Redis state

- `hydra:cost:reconciliation:{YYYY-MM-DD}` — JSON-encoded `ReconciliationResult`, 90-day TTL
- `hydra:cost:reconciliation:index` — sorted set of date strings, score = UTC epoch-ms of that date

### API

`GET /api/cost/reconciliation` — returns `{ history: ReconciliationResult[] }` newest first.
- `?limit=N` — number of days returned, 1..30 (default 30)
- `?run=YYYY-MM-DD` — runs a fresh reconciliation for that date instead of reading history (operator forensic on-demand; idempotent within the day)

### Deferred (follow-up issues)

- Scheduler hook for once-per-UTC-day automatic runs (against `date - 1`)
- `cost.reconciliation.divergence` event published when any pair diverges by `> DIVERGENCE_THRESHOLD` (10%)
- Digest section surfacing divergence events from the digest window
- Dashboard panel with the three-number side-by-side and 30-day trend

## Model Tiers

The orchestrator no longer routes per-call models — model selection is the harness's job. Claude Code dispatches subagents on whichever model the operator's subscription chooses. Tiers below are for accounting/limits visibility only.

| Tier | Model (Claude Code) | Typical use |
|---|---|---|
| frontier | claude-opus (1M context) | hydra-dev, hydra-target-build, hydra-research, hydra-architect — deep multi-file edits and design work |
| balanced | claude-sonnet | hydra-sweep, hydra-target-sweep, hydra-qa, hydra-doctor — board/health work with structured outputs |
| fast | claude-haiku | hydra-discover, hydra-target-discover, lesson-capture hooks, classification — small/fast/cheap calls |

Quota accounting flows through the **Cost** module and **Subscription Usage Tracker** (see `CONTEXT.md`); the legacy dollar-denominated `hydra:scheduler:daily-spend` surrogate was retired (see `docs/historical/`).

## Learning System (operational)

Conceptual definitions live in `CONTEXT.md` (**Pattern Memory**, **Reflections**, **Knowledge Base**). This is the operational detail.

**OpenViking-primary, Redis-fallback. Three tiers:**

1. **OpenViking (primary):** each autopilot tick / subagent dispatch creates an OV session (`ov-session.ts`); interactions are logged as session messages. At close, `ovSession.commit()` triggers memory extraction — OV stores learned patterns as searchable embeddings. Subagents query `getAgentContext()` / `searchKnowledge()`.
2. **Redis patterns (fallback):** consolidated patterns in `hydra:memory:{agent}:patterns` with hit counts. At `PROMOTION_THRESHOLD` (3, exported from `src/pattern-memory/agent-memory.ts`) a pattern auto-promotes to a durable lesson file (`~/.claude/skills/<skill>/lessons.md`) AND opens a `meta-friction` GitHub issue (issue #512). Stale one-offs pruned after 14 days.
3. **Episodic reflections:** on subagent failure, a structured reflection is stored in `hydra:reflections:{ref}` (7-day TTL); re-injected when the same anchor/file is retried.

**Cue taxonomy (issue #524)** — two QA cues, split because they describe different things. The per-cue table is `src/pattern-memory/escalation.ts::CUE_ESCALATION_THRESHOLDS`:
- `acceptance-criterion-unmet` — true defect; threshold 3, auto-promotes to `to-planner.md` + escalates to a GitHub issue.
- `acceptance-criterion-deferred` — only verifiable post-deploy/runtime/by-operator (metadata, not a defect); threshold 20+, does NOT write a rule to `to-planner.md`. Migrate pre-split entries with `bash scripts/cleanup/reclassify-deferred-acs.sh --apply`.

## Config (`~/hydra/config/`) — git-tracked

Operator edits these (or uses the dashboard):

- `config/direction/vision.md` — **target product** vision (prose)
- `config/direction/outcomes.yaml` — structured **Target Outcomes** metrics (ADR-0003)
- `config/orchestrator/vision.md` — **orchestrator-self** vision (trade-offs when ambiguous)
- `config/direction/priorities.md` — what to work on next (refreshed by `/hydra-target-research`)
- `config/direction/goals.md` — high-level goals
- `config/research/` — research agent configs (director, domain/technical/market researchers, strategist)

Runtime state is all in Redis (see the **Redis Keys** section above). The legacy in-process agent personalities and `config/feedback/to-*.md` files were retired with the codex cut-over — see `docs/historical/`.

## Deploy recipe

Runs automatically on merge to master via a self-hosted GitHub Actions runner on this server:

1. `git pull --ff-only origin master`
2. `npm ci` (orchestrator deps)
3. `bash scripts/sync-skills.sh` (regenerate `~/.claude/skills/` from playbooks — fails fast on non-zero exit; introduced in #433 after the 2026-05-15 silent-wedge incident)
4. `cd dashboard && npm ci && npm run build` (dashboard static assets)
5. `systemctl --user restart hydra-orchestrator.service`
6. Health check: `curl http://localhost:4000/api/health`

**Operator setup (one-time):** `bash scripts/setup-git-hooks.sh` installs an opt-in `post-merge` hook that re-runs `scripts/sync-skills.sh` when a `git pull` brings in `docs/operator-playbooks/*.md` changes. Remove with `--remove`.

**Subagent session-id capture hook (issue #692):** the project-scoped `~/hydra/.claude/settings.json` registers a `SessionStart` hook (`scripts/hooks/session-start-capture.sh`) that reads the new session's transcript, extracts the hidden `<!-- hydra-dispatch v1 skill=… dispatchId=… runId=… -->` sentinel the autopilot injects into every dispatched subagent prompt, and POSTs it to `POST /api/dispatches/subagent` — registering the session into `hydra:dispatches:subagent:{sessionId}` (24h TTL, indexed at `hydra:dispatches:subagent:index`), making a live subagent session recoverable to `(skill, dispatchId, runId, startedAt)`. No install step — the file is checked in and Claude Code loads project settings automatically inside `~/hydra`. Sessions without the sentinel (a human running `claude`) silently no-op. Best-effort: a Redis/HTTP outage, missing sentinel, or missing `jq` logs to stderr and exits 0 without blocking the session; re-running for the same session is an idempotent no-op. Smoke-test: `redis-cli zrange hydra:dispatches:subagent:index 0 -1 WITHSCORES` should show a fresh entry within ~5s of the autopilot dispatching a `hydra-dev` subagent.

**Emergency manual deploy:** `./scripts/deploy.sh`. Never deploy by restarting the service without building the dashboard first — Express serves `dashboard/dist/`, so stale builds mean stale UI.
