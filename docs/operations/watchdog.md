# Watchdog (issues #388, #397, #705, #727)

The consolidated `hydra-watchdog.timer` runs every 2 minutes (`OnUnitActiveSec=2min`). It merges the two formerly-separate watchdogs (service-liveness + autopilot-wedge) into one unit at the finer cadence — see #727/#728. The old `hydra-orchestrator-watchdog.timer` is retired/disabled.

- **Script source of truth:** `scripts/hydra-watchdog.sh` (deployed by `scripts/deploy.sh` to `~/.local/bin/hydra-watchdog.sh`).
- **Unit files:** `scripts/systemd/hydra-watchdog.{service,timer}`.
- **Tier 0 / Untouchable Core** (ADR-0001) — a live recovery mechanism. Two independent blocks, each with its own stale threshold; a short-circuit in one does not skip the other.

## Block 1 — service liveness (stale threshold: 15 min)

Now the TypeScript CLI `scripts/hydra-watchdog.ts` subcommand `liveness` (issue #5096), run FIRST on every tick, before the wedge CLI, through `run_watchdog_cli` in the bash entry (`timeout 300`, which must nest the redis-down path: two restarts capped at 90s each plus the 5s settle and pings; a missing node or a non-zero exit is ONE `WARN liveness CLI FAILED (rc=N)` line, never an aborted tick). It detects when `hydra-orchestrator.service` reports `active (running)` but has silently stopped making progress. Four pure predicates in `src/watchdog/liveness.ts` — `decideLiveness` (the cheap inputs, in the bash order), `decideRedisRecovery`, `decidePendingWork`, `decideTunnel` — and one impure `runLiveness` over typed ports (`LivenessHost` / `LivenessHttp` / `LivenessRedis` / `LivenessWork` / `LivenessClock` in `src/watchdog/ports.ts`; no `node:child_process` — systemctl and `flock` go through the Host-Probe Adapter, including its first write method `restartService`). It exits 0 on every verdict and error and works with the orchestrator down.

1. Redis (`PING`) not answering: restart `hydra-docker.service`, re-ping, then restart the orchestrator (Check 0, ahead of the boot-window guards on purpose).
2. Boot-window guards (#4415): skip the tick while the unit's activation is younger than `HYDRA_WATCHDOG_STARTUP_GRACE_SECONDS` (default 60, `0` disarms) or while `HYDRA_DEPLOY_LOCK` (default `/tmp/hydra-deploy.lock`) is held. An unreadable activation age or lock probe fails OPEN.
3. `/api/health` unreachable, `status != ok`, or `redis: false`: restart the orchestrator.
4. Scheduler stuck — `running: true` but `lastTickAt` is stale (>15 min, `SCHEDULER_TICK_STALE_S`) AND `/api/health`'s `cycle` field is not `running`. The predicate is shared with `/api/health/deep`'s "Idle Nm" diagnostic (`src/health/tick-liveness.ts`), so the route reports what the watchdog acts on. Liveness keys off `lastTickAt`, **not** `lastCycleAt` (removed with the scheduler-junk-drawer retirement). The old second read of `/api/cycle/status` is dropped; the cycle guard reads the `cycle` field already fetched from `/api/health`.
5. Scheduler stopped (`running: false`): left alone while the deliberate-stop marker is present or unreadable; inside the first 300 s of uptime it is a startup window; otherwise pending work (open `ready-for-agent` / `needs-research` / `needs-triage` board issues plus the anchor work-queue, via the Turn Snapshot's `countOpenBoard`) is read ONLY then. Work waiting, or a failed read ("could not read is never no work", #3794), restarts the scheduler via `POST /api/scheduler/start` (not a service restart).
6. Cloudflare tunnel unreachable while the orchestrator is healthy: restart `hydra-tunnel.service`.

## Block 2 — autopilot wedge (stale threshold: 25 min)

PID-kill logic for a wedged autopilot session, now the TypeScript CLI `scripts/hydra-watchdog.ts` (subcommand `wedge`; pure `decideWedge` + `runWedge` over typed ports in `src/watchdog/`; issue #5095). The timer's bash entry runs it from the deployed checkout and tolerates a broken runtime as a WARN. Thresholds live in `src/autopilot/stale-thresholds.ts` (the CLI's `thresholds` subcommand prints them as JSON). Tests use an in-memory fake of the ports, not env hooks. **Do not shorten the SIGKILL threshold.**

## Block 3 — tmpfs exhaustion (issue #5327)

The TypeScript CLI `scripts/hydra-watchdog.ts` (subcommand `disk`; pure `decideDisk` + `runDisk` in `src/watchdog/disk.ts`), run right after the wedge CLI under `timeout 60`. It reads `statfs` for `/tmp` and `/dev/shm` and grades **inode** use and **space** use independently: warn at ≥80%, critical at ≥95% (the 2026-10-31 outage was 100% inodes with 8.6G free). Each (mount, level) pages the Operator Channel as `infra:tmpfs_exhausted` with dedupKey `infra:tmpfs_exhausted:<mount>:<level>`, so the channel's edge-triggered dedup is the episode tracker (one page, a 6h reminder, one "recovered"). A level resolves only once both dimensions drop 5 points below its threshold (hysteresis: no flapping at the line); a critical mount holds its warn key. The page names the top inode consumers by name prefix (`du --inodes -x -a -d1`, 20s cap). Read-only — it never deletes anything. Env: `HYDRA_WATCHDOG_DISK_PATHS` (comma list), `HYDRA_WATCHDOG_DISK_WARN_PCT`, `HYDRA_WATCHDOG_DISK_CRITICAL_PCT`.

## Respecting deliberate operator stops (issue #388)

`POST /scheduler/stop` writes a `stopReason: "deliberate"` flag (persisted in Redis as `hydra:scheduler:deliberate-stop`, 24h TTL so it survives a service bounce). When the watchdog sees this flag it leaves the scheduler stopped. The liveness CLI reads the Redis marker through its TS owner (`src/scheduler/stop-marker.ts`), **not** the `/api/scheduler/status` `stopReason`: once the 24 h TTL expires the guard lifts even though the in-memory `stopReason` may still read `deliberate`, and an unreadable marker is treated as present (no restart) — the historical failure mode was the watchdog ticking the scheduler back on within ~2 minutes of every operator stop.

Auto-pause reasons (`circuit-breaker`, `error-cap`) do NOT set this flag, so the watchdog can still recover from genuine self-stops. `POST /scheduler/start` clears the flag explicitly. The flag also self-clears after 24h so a forgotten stop can't permanently disable the watchdog.
