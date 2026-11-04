# Watchdog (issues #388, #397, #705, #727, #5094, #5099)

The consolidated `hydra-watchdog.timer` runs every 2 minutes (`OnUnitActiveSec=2min`). It merges the two formerly-separate watchdogs (service-liveness + autopilot-wedge) into one unit at the finer cadence — see #727/#728. The old `hydra-orchestrator-watchdog.timer` is retired/disabled.

- **Script source of truth:** `scripts/hydra-watchdog.sh` (deployed by `scripts/deploy.sh` to `~/.local/bin/hydra-watchdog.sh`); since #5099 it is only the timer entry, the CLI-start alarm and the node_modules-integrity check (under 300 lines). Every other check is a subcommand of `scripts/hydra-watchdog.ts` over `src/watchdog/`.
- **Unit files:** `scripts/systemd/hydra-watchdog.{service,timer}`.
- **Modification Tier: T3** (demoted infra, ADR-0015; CLAUDE.md tier table). The watchdog is a live recovery mechanism but is **not** Verifier Core: `src/untouchable.ts` lists it nowhere. (The older pre-ADR-0015 tier claim in the script header and this doc was stale and is gone.)

## How a tick runs

1. `hydra-watchdog.sh` resolves node (`HYDRA_WATCHDOG_NODE`, then `PATH`, then the newest `~/.nvm/versions/node/*/bin/node` — the systemd unit sets no PATH) and runs `hydra-watchdog.ts plan`. `plan` prints the check table, one tab-separated `subcommand<TAB>log-prefix<TAB>timeout-s` line per check, from `WATCHDOG_CHECKS` in `src/watchdog/checks.ts` (the ONE home of the table; tests import it to pin budget relations instead of regexing bash).
2. Each row runs as its own `timeout <timeout-s> node --experimental-strip-types scripts/hydra-watchdog.ts <subcommand>` process, so one crash or timeout never skips the others. A non-zero rc from a single check (a timeout) is ONE `WARN <sub> CLI FAILED (rc=N)` line under that check's prefix and never aborts the tick; it does not raise the CLI-start alarm.
3. The node_modules-integrity check runs on EVERY tick, whether or not the CLI started.
4. The script exits 0 always.

Tick order and wrapper bounds: liveness 300s, wedge 90s, disk 90s, deploy-drift 1200s (the opt-in `scripts/deploy.sh`), redis-backup 90s, skill-mirror 300s (the opt-in `scripts/sync-skills.sh`), claude-hooks 60s, launch-flow 90s (covers the 60s CLI force-exit), brief-missing 90s, origin-identity 120s.

## Check catalogue

| Check (journal prefix) | Asserts | Delivery | Dedup state | Module |
|---|---|---|---|---|
| liveness (`hydra-orchestrator-watchdog:`) | orchestrator healthy, scheduler ticking, tunnel up | restarts only (no page) | none | `src/watchdog/liveness.ts` |
| wedge (`hydra-autopilot-watchdog:`) | no frozen autopilot PID | SIGTERM then SIGKILL | none | `src/watchdog/wedge.ts` |
| disk (`hydra-disk-watchdog:`) | `/tmp`, `/dev/shm` inode/space use | Page `infra:tmpfs_exhausted` (critical), brief item (warn) | Operator Channel dedup | `src/watchdog/disk.ts` |
| deploy-drift (`hydra-deploy-drift-watchdog:`) | deployed SHA equals origin/master | log only (advisory); opt-in auto-deploy | epoch file marker | `src/watchdog/deploy-drift.ts` |
| redis-backup (`hydra-redis-backup-freshness-watchdog:`) | newest dump younger than 36h | in-band `infra:redis_backup_stale` + Page | Redis episode keys | `src/watchdog/redis-backup.ts` |
| skill-mirror (`hydra-skill-mirror-drift-watchdog:`) | live `~/.claude/skills` equals regenerated | log only; opt-in autofix | epoch file marker | `src/watchdog/skill-mirror.ts` |
| claude-hooks (`hydra-claude-hooks-watchdog:`) | every installer hook installed and registered | in-band `infra:claude_hooks_missing` (NOT a Page) | file marker | `src/watchdog/claude-hooks.ts` |
| launch-flow (`hydra-launch-flow-watchdog:`) | pace-gate streaks, GLM-sterile | Pages / in-band events | Redis episode keys | `src/watchdog/launch-flow.ts` |
| brief-missing (`hydra-brief-missing-watchdog:`) | a Morning Brief delivered in the last 26h | Page `brief:missing` | Redis anchor + fired keys | `src/watchdog/brief-missing.ts` |
| origin-identity (`hydra-origin-identity-watchdog:`) | `remote.origin.url` is the expected repo | in-band `infra:origin_identity_wrong` + Page | outcome file marker | `src/watchdog/origin-identity.ts` |
| node-modules-integrity (`hydra-node-modules-integrity-watchdog:`) | watched `node_modules` roots intact | in-band `infra:node_modules_wiped` + Page | Redis since/fired keys | `scripts/hydra-watchdog.sh` (bash) |
| CLI-start alarm (`hydra-watchdog-cli:`) | the CLI boots (`plan` succeeds) | Page `infra:watchdog_cli_failed` | file marker | `scripts/hydra-watchdog.sh` (bash) |

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

**Subagent-activity shield (issue #5349).** A parent that dispatched its wave and is waiting on completions writes no heartbeat, and SIGTERMing it kills every in-flight subagent (they run inside the parent process). So when the heartbeat age is already at or past the threshold and state.json has occupied slots, the check reads the newest `hydra:autopilot:slot-events` entries (`src/redis/slot-events.ts`, 5s bound). If an `event=subagent_tool_call` entry whose `task_id` equals an occupied slot's `task_id` is younger than the threshold, the verdict is `waiting-on-subagents` (journal line `waiting on live subagents ...`, deliberately without the token `STALE`) and nothing is signalled. Unknown activity (Redis down, read failure or timeout) never shields. The shield ends once the heartbeat age reaches `WATCHDOG_SUBAGENT_SHIELD_CEILING_S` (3h). Healthy ticks and slot-less runs never touch Redis. Count real kills with `grep "hydra-autopilot-watchdog: STALE"`.

## Block 3 — tmpfs exhaustion (issue #5327)

The TypeScript CLI `scripts/hydra-watchdog.ts` (subcommand `disk`; pure `decideDisk` + `runDisk` in `src/watchdog/disk.ts`), run right after the wedge CLI under `timeout 90`. It reads `statfs` for `/tmp` and `/dev/shm` and grades **inode** use and **space** use independently: warn at ≥80%, critical at ≥95% (the 2026-10-31 outage was 100% inodes with 8.6G free). Only **critical** pages (`infra:tmpfs_exhausted`, dedupKey `infra:tmpfs_exhausted:<mount>:critical`), edge-only (paged when `isOpen(key) !== true`; the 6h reminder is the one documented exception); **warn** is a once-per-episode Morning Brief item (`infra:tmpfs_pressure`), closed silently, so a warn->critical->ok episode yields one "recovered". A level resolves only once both dimensions drop 5 points below its threshold (hysteresis: no flapping at the line); a critical mount holds its warn key. The page names the top inode consumers by name prefix (`du --inodes -x -a -d1`, 20s cap). Read-only — it never deletes anything. Env: `HYDRA_WATCHDOG_DISK_PATHS` (comma list), `HYDRA_WATCHDOG_DISK_WARN_PCT`, `HYDRA_WATCHDOG_DISK_CRITICAL_PCT`.

## Block 4 — launch flow (issue #5097, epic #3844)

The TypeScript CLI `scripts/hydra-watchdog.ts` subcommand `launch-flow` (pure `decideLaunchFlow` + `runLaunchFlow` in `src/watchdog/launch-flow.ts`), run from the bash entry through `run_watchdog_cli` under `timeout 90` (the CLI also arms an unref'd 60 s force-exit and always exits 0). It reads the pace-gate last-tick hash ONCE (`getPaceGateLastTick()` in `src/redis/launch-flow.ts`; never `/api/`, so it works with the service down) and asks, per signal, whether the condition has been SUSTAINED past its threshold: `fail-safe` / `meter-dark` / `quota` / `pause` from the reason (`classifyLaunchSignal`), `latency` from `latency_ms` over budget, and `glm-sterile` from a four-way AND read cheap to expensive (fresh drainer heartbeat via `getGlmDrainerLiveness`, a fresh pick verdict via `getGlmDrainerLastPick` no older than the writer's TTL, a positive-integer `picked`, zero drainer PRs in the trailing window via the typed `WatchdogGithub.countDrainerPrsCreatedSince` — one `gh api` REST call, the only one).

The streak/dedup rule is written ONCE in `src/watchdog/episode.ts` (`decideEpisode` + `runEpisode` over an `EpisodeStore` port and a `{since, fired}` key pair from a `src/redis/` builder): a member SET-NXes `since` and fires once when `now - since >= threshold`, with the `fired` marker set BEFORE delivery; a non-member calls the recovered page only if `fired` existed, then DELs both. The per-signal `since` / `fired` key names (built by `launchFlowSinceKey` / `launchFlowFiredKey` in `src/redis/launch-flow.ts`) are unchanged across the port. A failed read never mutates: an unreadable last-tick, a thrown episode read, or a failed drainer-PR query leaves the affected anchors and markers untouched with a WARN.

Delivery at the fire edge: `fail-safe` / `meter-dark` page through the Operator Channel module in-process (no bus publish; the Orchestrator is unproven); `quota` / `latency` / `pause` / `glm-sterile` publish the enveloped event through `EventBus.publish()` (source `watchdog-launch-flow`) plus one page with dedupKey == kind. Env (names and defaults unchanged): `HYDRA_WATCHDOG_LAUNCH_{FAILSAFE,METER_DARK,QUOTA,PAUSE,LATENCY_BREACH,GLM_STERILE}_SECONDS`, `HYDRA_WATCHDOG_LAUNCH_LATENCY_BUDGET_MS`, `HYDRA_WATCHDOG_LAUNCH_GLM_STERILE_WINDOW_HOURS`, `HYDRA_WATCHDOG_LAUNCH_NOW_MS`. The `HYDRA_WATCHDOG_LAUNCH_NOTIFY_STREAM` rebind and the `HYDRA_REDIS_HOST/PORT/DB` redis-cli hooks are gone for this block (the TS reads `REDIS_URL`). Tests: `test/watchdog-launch-flow.test.mts` and `test/launch-flow-delivery.test.mts` run the real functions over in-memory ports (`test/_helpers/launch-flow-fakes.mts`); no bash is spawned.

## Respecting deliberate operator stops (issue #388)

`POST /scheduler/stop` writes a `stopReason: "deliberate"` flag (persisted in Redis as `hydra:scheduler:deliberate-stop`, 24h TTL so it survives a service bounce). When the watchdog sees this flag it leaves the scheduler stopped. The liveness CLI reads the Redis marker through its TS owner (`src/scheduler/stop-marker.ts`), **not** the `/api/scheduler/status` `stopReason`: once the 24 h TTL expires the guard lifts even though the in-memory `stopReason` may still read `deliberate`, and an unreadable marker is treated as present (no restart) — the historical failure mode was the watchdog ticking the scheduler back on within ~2 minutes of every operator stop.

Auto-pause reasons (`circuit-breaker`, `error-cap`) do NOT set this flag, so the watchdog can still recover from genuine self-stops. `POST /scheduler/start` clears the flag explicitly. The flag also self-clears after 24h so a forgotten stop can't permanently disable the watchdog.

## Blocks 5-8 — deploy drift, Redis backup, skill mirror, origin identity (issue #5098, epic #5094)

Each is its own `scripts/hydra-watchdog.ts` subcommand (`deploy-drift`, `redis-backup`, `skill-mirror`, `origin-identity`) over a pure decide + run in `src/watchdog/<check>.ts`, so a crash or timeout in one never skips the others; the CLI always exits 0. Wrapper bounds: deploy-drift 1200s (the opt-in `scripts/deploy.sh`), skill-mirror 300s, origin-identity 120s, redis-backup 90s. Log prefixes, env names and defaults are unchanged; the bash-only injection hooks are retired because the fake ports replace them.

- **Deploy drift / skill mirror** keep their epoch-seconds FILE markers (`${HYDRA_WATCHDOG_DRIFT_STATE_DIR:-/tmp}/hydra-watchdog-drift-since`, `.../hydra-watchdog-skill-mirror-drift-since`). SHAs come from `src/health/deployed-sha.ts` (`nextDriftFirstSeen`; `DEPLOY_DRIFT_GRACE_SECONDS` is the grace default). Advisory by default; the opt-in actions share `drift-gate.ts` and clear their marker BEFORE running.
- **Redis backup** runs on the shared episode tracker (threshold 0) over the since/fired key pair built by `redisBackupEpisodeKeys()` (names unchanged); `infra:redis_backup_stale` is a module constant, not an alert type.
- **Origin identity** dedups by outcome transition against the `hydra-origin-identity.since` file (`<first> <outcome> <lastAttempt>`), written only after `EventBus.publish` returns a stream id. Repairs are `git -C $HYDRA_ROOT` through `src/github/git.ts` only; the URL rule has one home, `src/github/remote-url.ts`. `scripts/claude-hooks/git-remote-fence.sh` never handles a URL and is unchanged.

Tests run the real functions over `test/_helpers/watchdog-drift-fakes.mts`; no bash is spawned.

## Block 9 — claude hooks (issue #5064, ported by #5099)

`hydra-watchdog.ts claude-hooks` over `src/watchdog/claude-hooks.ts` (pure `decideClaudeHooks` + `runClaudeHooks` over typed ports). `scripts/setup-claude-hooks.sh --list` (run through the Host-Probe Adapter's `runInstallerList`) is the single source of the expected `name|matcher` entries; the check alarms when a hook is missing as a file under the installed hooks dir (`file-missing:<n>`), not registered in settings.json's `hooks.PreToolUse` with an EXACT `matcher` and a `bash <dir>/<name>` command (`unregistered:<n>`), or settings.json is absent/unparseable (`settings-unreadable`, parsed with `JSON.parse`; python3 is no longer a dependency). Strictly read-only; `bash scripts/deploy.sh` (or `bash scripts/setup-claude-hooks.sh`) is the fix. Every tooling failure is a WARN and a skip.

Delivery is ONE in-band `infra:claude_hooks_missing` bus event per episode (source `watchdog-claude-hooks`, correlationId `claude-hooks`); it is deliberately not a Page. Dedup is the FILE `${HYDRA_WATCHDOG_CLAUDE_HOOKS_STATE_DIR:-/tmp}/hydra-claude-hooks-missing.since`, written only AFTER the publish returns a stream id (retry-until-delivered), and removed once everything is present. It does not use the Redis episode tracker, whose fired marker is set BEFORE delivery. Env: `HYDRA_WATCHDOG_CLAUDE_HOOKS_SETUP`, `_DIR`, `_STATE_DIR`, `_NOTIFY_STREAM`, `HYDRA_WATCHDOG_CLAUDE_SETTINGS`.

## Block 10 — Morning Brief missing (issue #5048, ported by #5099)

`hydra-watchdog.ts brief-missing` over `src/watchdog/brief-missing.ts` (pure `decideBriefMissing` returning page / still-missing / resolve / fresh / grace, plus `runBriefMissing`). It pages `brief:missing` ONCE when no brief has been delivered for `HYDRA_WATCHDOG_BRIEF_STALE_HOURS` (default 26, base 10) and resolves when one lands, independent of the scheduler's running state (the brief rides the scheduler tick, so every way it goes silent is a way the orchestrator could not report it). It reads the brief's only timing state, `hydra:operator-channel:brief:last-sent` (`getBriefLastSent`). Cold start: with no stamp, `hydra:autopilot:brief-missing:absent-since` is anchored with SET NX at the first observing tick and the threshold is measured from it (reason `never-delivered`); the anchor is deleted once a stamp appears. `hydra:autopilot:brief-missing:fired` is set BEFORE the page; resolve runs only when it existed. A thrown Redis read is "unreachable": WARN and NO state mutation (the liveness check owns Redis-down). The page goes through the in-process Operator Channel. Env: `HYDRA_WATCHDOG_BRIEF_STALE_HOURS`, `HYDRA_WATCHDOG_BRIEF_NOW_MS` (injectable clock).

## Block 11 — node_modules integrity (issue #4175; stays in bash by decision)

The only decision block left in `scripts/hydra-watchdog.sh`, kept in bash on purpose: it watches the runtime the CLI needs, so it must run when `node_modules` is wiped. Origin: on 2026-08-19 a `/dev/shm` worktree's `web/node_modules` symlink reached back through the main checkout and a destructive install wiped `/home/gabe/hydra-betting/web/node_modules`, taking six money-critical Target services down for ~70 minutes with no signal.

Per watched root it asserts the structural invariant the incident violated: the root exists, contains `.bin/`, holds at least `HYDRA_WATCHDOG_NM_ENTRY_FLOOR` (default 20) top-level entries, and `.bin/<HYDRA_WATCHDOG_NM_REQUIRED_BIN>` (default `tsx`) is executable. Reasons: `root-absent`, `no-bin-dir`, `below-entry-floor:N<F`, `missing-binary:tsx`. Roots: `$HOME/hydra/node_modules` always, plus the live Target's (`<workspace>/<appSubdir>/node_modules`, via `scripts/target/print-target-facts.ts`, best effort — fail OPEN on Target coverage only); `HYDRA_WATCHDOG_NM_ROOTS` (colon-separated) overrides. Threshold is 0: the fired marker is set on the first bad tick. Redis keys `hydra:autopilot:node-modules-integrity:{since,fired}:<sig>` (SET NX since, DEL both on recovery; a failed read never mutates). Delivery: an enveloped in-band XADD (`infra:node_modules_wiped`, source `watchdog-node-modules-integrity`, to `HYDRA_WATCHDOG_NM_NOTIFY_STREAM`, default `hydra:notifications`) plus a Page via `operator-notify` (`HYDRA_WATCHDOG_OPERATOR_NOTIFY` overrides the binary), and a `resolve` on recovery only when the fired marker existed. Env also: `HYDRA_REDIS_HOST/PORT/DB` (the single `rc_read`/`rc_write` pair; `HYDRA_REDIS_DB` is numeric or 0), `HYDRA_WATCHDOG_NM_NOW_MS`. The script holds exactly one `rc_*` pair, one `log` helper and one `deliver_page`, shared with the CLI-start alarm.

## Block 12 — CLI-start alarm (issue #5099)

Raised from bash when node is unresolvable OR `hydra-watchdog.ts plan` exits non-zero or prints nothing. `plan` statically imports the same module graph as every check, so a boot failure (broken `node_modules`, `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` in `src/watchdog/`, nvm drift) means every ported check is disarmed; it is the startability probe. On fire: one `operator-notify page --kind infra:watchdog_cli_failed --dedup-key infra:watchdog_cli_failed` with facts `reason=node-missing|plan-failed` and `rc=N`, deduped by the FILE marker `${HYDRA_WATCHDOG_CLI_ALARM_STATE_DIR:-/tmp}/hydra-watchdog-cli-failed.since`, written only when `operator-notify` exits 0 (a failed delivery retries next tick). On the next tick whose `plan` succeeds with the marker present, `operator-notify resolve` runs and the marker is removed (kept if the resolve fails). The alarm is Redis-free on purpose, so it works with Redis and the orchestrator down. `infra:watchdog_cli_failed` is on the closed page list (ADR-0045 Decision 3).

**Honest limit.** When node itself is missing or `node_modules` is broken, `operator-notify` (a TS CLI) cannot boot either, so the page degrades to the journal WARN. The node_modules-integrity check's bash-native XADD is the signal for that case, which is why it stays in bash.

## Verifying a deploy

After a deploy, one full timer cycle should show every `WATCHDOG_CHECKS` prefix plus the node-modules-integrity prefix and no `watchdog CLI failed to start` / `CLI FAILED` line:

```bash
journalctl --user -u hydra-watchdog.service --since '<deploy time>' --no-pager
```

Never run the real tick from a worktree: it restarts services and kills PIDs.
