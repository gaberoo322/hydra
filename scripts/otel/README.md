# Self-hosted Tempo wiring for Hydra OTel (Tier-2 backend)

Example artifacts the operator copies onto the host to make `HYDRA_OTEL_ENABLED=true` actually ship traces somewhere. Nothing here is auto-installed.

The Hydra-side env-var contract (`HYDRA_OTEL_ENABLED`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`) and the resource attributes hydra injects per agent call (`hydra.cycle_id`, `hydra.agent_role`, ...) are documented in `docs/reference.md` ("Codex OpenTelemetry"). This README only covers the host-side install.

## Files

| File | Where it goes on the host |
|---|---|
| `docker-compose.example.yml` | `~/hydra-otel/docker-compose.yml` (or wherever you keep operator-owned compose stacks) |
| `tempo.example.yaml` | next to the compose file, mounted into the Tempo container |
| `otel-collector.example.yaml` | next to the compose file, mounted into the collector container |
| `codex-config.example.toml` | merge the `[otel]` block into `~/.codex/config.toml` |
| `hydra-orchestrator.otel.env.example` | `/etc/hydra/otel.env` (root-owned, chmod 600) |
| `hydra-orchestrator.otel.dropin.conf.example` | `~/.config/systemd/user/hydra-orchestrator.service.d/otel.conf` |

The compose file uses a bridge network with ports bound to `127.0.0.1` only. The collector and Tempo are not reachable from the LAN.

## Install order

Run these in order. Each step is independently testable; if one fails, the next won't have working inputs.

### 1. Start the containers

```bash
mkdir -p ~/hydra-otel && cd ~/hydra-otel
cp /path/to/hydra/scripts/otel/docker-compose.example.yml ./docker-compose.yml
cp /path/to/hydra/scripts/otel/tempo.example.yaml         ./tempo.example.yaml
cp /path/to/hydra/scripts/otel/otel-collector.example.yaml ./otel-collector.example.yaml

docker compose -f docker-compose.yml config    # schema check
docker compose up -d
docker compose ps                              # both services Up
```

Validate the collector parsed its config (one-time sanity check, do not wire into CI):

```bash
docker compose exec otel-collector /otelcol-contrib --config=/etc/otelcol-contrib/config.yaml --dry-run
```

### 2. Merge the Codex `[otel]` block

Edit `~/.codex/config.toml` and append the `[otel]` section from `codex-config.example.toml`. The header value uses `${OTEL_INGEST_KEY}` shell-style expansion so the secret stays in the EnvironmentFile (step 3) rather than this user-owned file.

### 3. Write the secret file

```bash
sudo install -d -m 0755 -o root -g root /etc/hydra
sudo install -m 0600 -o root -g root /dev/stdin /etc/hydra/otel.env <<'EOF'
HYDRA_OTEL_ENABLED=true
OTEL_INGEST_KEY=<paste real value here>
EOF
```

`HYDRA_OTEL_ENABLED=true` is what flips the Hydra orchestrator into per-call env injection (see `src/codex-otel.ts`). Rolling the key later only needs a rewrite of this file + `systemctl restart` — no edits to user-owned config.

### 4. Install the systemd drop-in

```bash
install -d ~/.config/systemd/user/hydra-orchestrator.service.d
cp /path/to/hydra/scripts/otel/hydra-orchestrator.otel.dropin.conf.example \
   ~/.config/systemd/user/hydra-orchestrator.service.d/otel.conf
```

The `EnvironmentFile=-/etc/hydra/otel.env` leading dash makes systemd tolerant of a missing file — a botched install will not take the orchestrator down.

### 5. Reload and restart

```bash
systemctl --user daemon-reload
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -n 50 --no-pager
```

### 6. Run one cycle and verify

Wait for or trigger one Hydra cycle, then query Tempo. Grafana is the usual entry point; pointed directly at Tempo's API on `http://127.0.0.1:3200` you can run a TraceQL query:

```
{ resource.hydra.cycle_id = "<paste-recent-cycle-id>" }
```

You should see one trace per agent call in the cycle (planner, executor, optionally fixer / high-risk-review), each carrying `resource.hydra.agent_role` and the other `hydra.*` attributes.

## Rollback

Remove the drop-in and restart. Hydra's OTel injection is gated entirely on `HYDRA_OTEL_ENABLED` — with no env file loaded, the env var is unset and behavior reverts to pre-#199 (no per-call env injection, no exporter traffic).

```bash
rm ~/.config/systemd/user/hydra-orchestrator.service.d/otel.conf
systemctl --user daemon-reload
systemctl --user restart hydra-orchestrator.service
```

The containers can be left running or torn down independently (`docker compose -f ~/hydra-otel/docker-compose.yml down`); they have no effect on Hydra when Hydra isn't exporting.
