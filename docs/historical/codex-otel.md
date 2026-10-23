# Codex OpenTelemetry (issue #199)

> **Retired by / replaced by.** Moved verbatim from `docs/reference.md` (issue #4599, audit REF-15). The Codex CLI runtime was removed on 2026-05-14 (ADR-0006), so no new Hydra OTel spans are emitted; this runbook is the only record of the Tempo wiring that `scripts/otel/` and `docs/observability/` still support.


> **Historical, kept for trace lookup.** The Codex CLI runtime was removed on
> 2026-05-14 ([ADR-0006](../adr/0006-codex-cli-removed-autopilot-only.md)). No new
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
