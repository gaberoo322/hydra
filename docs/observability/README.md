# Hydra observability — Tier-3 dashboard panels (issue #207)

Dashboard-as-code: Grafana dashboard JSONs the operator imports into their own Grafana instance after the Tier-2 backend (`scripts/otel/` — otel-collector + Tempo) is up. Nothing in this folder is wired up automatically — Hydra ships the panel definitions, the operator imports them.

The operator-facing runbook (how to enable / disable, key rotation, sampling, drill-down query examples) lives in `docs/reference.md` under "Codex OpenTelemetry — Tier-3 operator runbook (issue #207)".

## Files

| File | Purpose |
|---|---|
| `grafana-hydra-overview.json` | Per-agent-role latency (p50/p95), token counts, model attribution, error rate. Grouped by `hydra.agent_role` (planner / executor / fixer / high-risk-review). Variables: Tempo datasource, deployment.environment, `hydra.model_tier`. |
| `grafana-hydra-cycle-drilldown.json` | Drill-down by `hydra.cycle_id`. Shows all spans for the cycle, then planner spans side-by-side with executor spans (with prompt + response when Codex's `log_user_prompt = true`), plus a fixer / high-risk-review panel. |

## Importing into Grafana

1. Grafana → **Dashboards** → **Import** → **Upload JSON file**.
2. Pick the file from this folder.
3. On the import screen, map the `tempo` datasource variable to your Tempo datasource (the example wiring in `scripts/otel/docker-compose.example.yml` calls it `Tempo`).
4. Save. Both dashboards land at the `uid` declared in the JSON (`hydra-otel-overview`, `hydra-otel-cycle-drilldown`) — link to them from elsewhere using those UIDs.

## Linking from the Hydra dashboard

Set `HYDRA_TRACE_UI_URL` on the orchestrator to point at the cycle-drill-down dashboard with `{cycleId}` as a placeholder. The Cycles page renders a "traces ↗" link next to the active cycle and each history row when this is set.

```bash
# Example for the self-hosted Tempo wiring in scripts/otel/
HYDRA_TRACE_UI_URL='http://localhost:3000/d/hydra-otel-cycle-drilldown/hydra-cycle-drill-down?var-cycle_id={cycleId}'
```

If `{cycleId}` is omitted from the template the orchestrator falls back to appending `?hydra_cycle_id=<id>` so the link still resolves to a useful page. Templates that already include a query string get `&hydra_cycle_id=<id>` instead.

## Backend-portability notes

The Tempo TraceQL queries assume the Hydra resource attributes (`resource.hydra.cycle_id`, `resource.hydra.agent_role`, `resource.hydra.model_tier`, `resource.hydra.model`) are passed through unchanged by the otel-collector. The example collector config in `scripts/otel/otel-collector.example.yaml` does this.

For SigNoz / Jaeger / other backends: the underlying signals (resource attributes + span events) are vendor-neutral, but the query language differs. Treat the JSON here as a structural reference (what to filter on, how to group) rather than a literal import target.

## Scope notes (issue #207 acceptance)

- **Default dashboard panels** — shipped as JSON in this folder. Operator-action required: import into their Grafana.
- **Cycle drill-down** — same import path.
- **Operator runbook** — `docs/reference.md` "Codex OpenTelemetry — Tier-3 operator runbook (issue #207)".
- **Dashboard URL link from Hydra cycle-detail** — done. Set `HYDRA_TRACE_UI_URL` to enable.
