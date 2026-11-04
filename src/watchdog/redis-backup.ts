/**
 * watchdog/redis-backup.ts — the REDIS BACKUP FRESHNESS check (issue #5098, epic
 * #5094, slice 4/5; ADR-0040 Decision 2 shape). Ported from
 * `run_redis_backup_freshness` in scripts/hydra-watchdog.sh (#4604).
 *
 * The nightly dump is the ONLY off-volume copy of all orchestrator state. This
 * check flags a missing or stale `hydra-redis-*.rdb.gz`. It runs on the shared
 * episode tracker (`./episode.ts`) with `thresholdMs: 0`: the staleness window
 * IS the streak, so it fires on the first stale/missing tick, once per episode,
 * and resolves only when the fired marker existed.
 *
 * `infra:redis_backup_stale` is a module constant, deliberately NOT registered in
 * event-bus-vocabulary / ALERT_TYPES (the alert surface does not change; same as
 * disk.ts's DISK_PAGE_KIND).
 */

import { STREAMS } from "../event-bus-stream-keys.ts";
import type { EventBus } from "../event-bus.ts";
import type { OperatorChannel } from "../operator-channel/channel.ts";
import type { OperatorMessage } from "../operator-channel/message.ts";
import { redisBackupEpisodeKeys } from "../redis/watchdog-episodes.ts";
import { runEpisode, type EpisodeStore } from "./episode.ts";

export const REDIS_BACKUP_LOG_PREFIX = "hydra-redis-backup-freshness-watchdog:";

/** Wrapper bound (INV-14): one backup-dir scan, a systemctl probe, the Redis episode ops and the channel. */
export const REDIS_BACKUP_TIMEOUT_S = 90;

/** The event type and the Page kind (dedupKey == kind). */
export const REDIS_BACKUP_STALE_KIND = "infra:redis_backup_stale";
export const REDIS_BACKUP_EVENT_SOURCE = "watchdog-redis-backup-freshness";
export const REDIS_BACKUP_CORRELATION_ID = "redis-backup-freshness";

export const DEFAULT_REDIS_BACKUP_DIR = "/mnt/hydra-ssd/backups/redis";
export const DEFAULT_REDIS_BACKUP_STALE_HOURS = 36;
export const REDIS_BACKUP_TIMER_UNIT = "hydra-redis-backup.timer";

export interface RedisBackupConfig {
  backupDir: string;
  staleHours: number;
}

/** The newest dump directly under the backup dir (integer-second mtime). */
export interface NewestBackup {
  name: string;
  mtimeS: number;
}

export interface RedisBackupDeps {
  files: {
    /** Newest `hydra-redis-*.rdb.gz` directly under `dir` (non-recursive); `null` for a missing/unreadable dir or no match. */
    newestBackup(dir: string): NewestBackup | null;
  };
  host: {
    /** `systemctl --user is-enabled <timer>`; `"unknown"` on failure. Visibility only. */
    timerState(unit: string): Promise<string>;
  };
  store: EpisodeStore;
  channel: Pick<OperatorChannel, "page" | "resolve">;
  bus: Pick<EventBus, "publish">;
  clock: { nowMs(): number };
  log: (line: string) => void;
}

export type RedisBackupVerdict =
  | { stale: false; ageS: number }
  | { stale: true; reason: "missing" | "stale"; ageS: number };

/** Parse BACKUP_STALE_HOURS: a non-negative integer, else the default (36). */
export function parseStaleHours(raw: string | undefined): number {
  return raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_REDIS_BACKUP_STALE_HOURS;
}

/** Pure verdict: no dump is `missing` (age 0); a dump at or past the threshold is `stale`. */
export function decideRedisBackup(newest: NewestBackup | null, nowS: number, staleHours: number): RedisBackupVerdict {
  if (newest === null) return { stale: true, reason: "missing", ageS: 0 };
  const ageS = Math.max(0, nowS - newest.mtimeS);
  return ageS >= staleHours * 3600 ? { stale: true, reason: "stale", ageS } : { stale: false, ageS };
}

/** Drop everything outside the bash `tr -dc 'a-zA-Z0-9_.:-'` set. */
function sanitize(reason: string): string {
  return reason.replace(/[^a-zA-Z0-9_.:-]/g, "");
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One watchdog tick of the redis-backup freshness check. Never throws. */
export async function runRedisBackup(deps: RedisBackupDeps, config: RedisBackupConfig): Promise<void> {
  const say = (line: string): void => deps.log(`${REDIS_BACKUP_LOG_PREFIX} ${line}`);
  try {
    const thrMs = config.staleHours * 3600 * 1000;

    const timer = await deps.host.timerState(REDIS_BACKUP_TIMER_UNIT);
    if (timer !== "enabled") {
      say(
        `WARN ${REDIS_BACKUP_TIMER_UNIT} is not enabled (state=${timer}) — no scheduled Redis backup is running; scripts/deploy.sh installs+enables it (issue #4604)`,
      );
    }

    const nowMs = deps.clock.nowMs();
    const newest = deps.files.newestBackup(config.backupDir);
    const verdict = decideRedisBackup(newest, Math.floor(nowMs / 1000), config.staleHours);
    if (newest !== null) {
      say(
        `newest backup: ${newest.name} (age ${verdict.ageS}s ≈ ${Math.floor(verdict.ageS / 3600)}h; stale threshold ${config.staleHours}h)`,
      );
    }
    const reason = verdict.stale ? verdict.reason : "";
    if (verdict.stale) {
      say(
        `WARNING REDIS BACKUP STALE — ${reason} in ${config.backupDir} (threshold ${config.staleHours}h); orchestrator state is not being backed up off-volume (issue #4604)`,
      );
    }
    const ageMs = verdict.ageS * 1000;

    await runEpisode(
      deps.store,
      redisBackupEpisodeKeys(),
      { signal: "redis-backup", member: verdict.stale, nowMs, thresholdMs: 0 },
      {
        log: (line) => say(line),
        onBelowThreshold: () => {
          /* intentional: threshold 0 — a member tick always fires or is already fired, never below */
        },
        onFire: async () => {
          try {
            await deps.bus.publish(STREAMS.NOTIFICATIONS, {
              type: REDIS_BACKUP_STALE_KIND,
              source: REDIS_BACKUP_EVENT_SOURCE,
              correlationId: REDIS_BACKUP_CORRELATION_ID,
              payload: { signal: "redis-backup", reason: sanitize(reason), durationMs: ageMs, thresholdMs: thrMs },
            });
            say(`in-band delivery published (best-effort) for stale redis backup (type=${REDIS_BACKUP_STALE_KIND} -> ${STREAMS.NOTIFICATIONS})`);
          } catch (err) {
            say(`WARN in-band delivery FAILED (best-effort — detection state is unchanged): ${msg(err)}`);
          }
          const page: OperatorMessage = {
            severity: "page",
            kind: REDIS_BACKUP_STALE_KIND,
            title: `Redis backup ${sanitize(reason)} (threshold ${config.staleHours}h)`,
            facts: [
              { label: "reason", value: sanitize(reason) },
              { label: "age_ms", value: String(ageMs) },
              { label: "threshold_ms", value: String(thrMs) },
              { label: "backup_dir", value: config.backupDir },
            ],
            links: [],
            dedupKey: REDIS_BACKUP_STALE_KIND,
          };
          try {
            await deps.channel.page(page);
            say(`operator-channel page ok for '${REDIS_BACKUP_STALE_KIND}'`);
          } catch (err) {
            say(`WARN operator-channel page FAILED for '${REDIS_BACKUP_STALE_KIND}' (best-effort — detection state is unchanged): ${msg(err)}`);
          }
        },
        onRecover: async () => {
          say("redis backup fresh again — clearing the staleness episode (dedup re-armed)");
          try {
            await deps.channel.resolve(REDIS_BACKUP_STALE_KIND, "Redis backup fresh again");
          } catch (err) {
            say(`WARN operator-channel resolve FAILED for '${REDIS_BACKUP_STALE_KIND}' (best-effort — detection state is unchanged): ${msg(err)}`);
          }
        },
      },
    );

    say(`redis-backup-freshness tick processed (backup_dir=${config.backupDir}, timer=${timer}, now_ms=${nowMs})`);
  } catch (err) {
    say(`WARN redis-backup tick failed: ${msg(err)}`);
  }
}
