# Watchdog (issues #388, #397, #705, #727)

The consolidated `hydra-watchdog.timer` runs every 2 minutes (`OnUnitActiveSec=2min`). It merges the two formerly-separate watchdogs (service-liveness + autopilot-wedge) into one unit at the finer cadence — see #727/#728. The old `hydra-orchestrator-watchdog.timer` is retired/disabled.

- **Script source of truth:** `scripts/hydra-watchdog.sh` (deployed by `scripts/deploy.sh` to `~/.local/bin/hydra-watchdog.sh`).
- **Unit files:** `scripts/systemd/hydra-watchdog.{service,timer}`.
- **Tier 0 / Untouchable Core** (ADR-0001) — a live recovery mechanism. Two independent blocks, each with its own stale threshold; a short-circuit in one does not skip the other.

## Block 1 — service liveness (stale threshold: 15 min)

Detects when `hydra-orchestrator.service` reports `active (running)` but has silently stopped making progress:

1. `/api/health` doesn't return 200, or returns `redis: false`.
2. Scheduler stuck — `running: true` but `lastTickAt` is stale (>15 min) AND no cycle is currently in progress. Liveness keys off `lastTickAt` (the heartbeat of the housekeeping loop), **not** `lastCycleAt` — the latter was removed in the scheduler-junk-drawer retirement (follow-up to ADR-0010). Ticks run every 5 min, so 15 min ≈ 3× safety margin.
3. Skips the restart if `/cycle/status` is `running` (a legitimate long operation may hold the loop).

## Block 2 — autopilot wedge (stale threshold: 25 min)

PID-kill logic for a wedged autopilot session (with the `HYDRA_AUTOPILOT_WATCHDOG_*` test hooks). **Do not shorten the SIGKILL threshold.**

## Respecting deliberate operator stops (issue #388)

`POST /scheduler/stop` writes a `stopReason: "deliberate"` flag (persisted in Redis as `hydra:scheduler:deliberate-stop`, 24h TTL so it survives a service bounce). When the watchdog sees this flag it leaves the scheduler stopped — the historical failure mode was the watchdog ticking the scheduler back on within ~2 minutes of every operator stop.

Auto-pause reasons (`circuit-breaker`, `error-cap`) do NOT set this flag, so the watchdog can still recover from genuine self-stops. `POST /scheduler/start` clears the flag explicitly. The flag also self-clears after 24h so a forgotten stop can't permanently disable the watchdog.
