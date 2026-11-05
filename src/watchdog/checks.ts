/**
 * watchdog/checks.ts — the ONE home of the watchdog's per-check table (issue
 * #5099, epic #5094, slice 5/5).
 *
 * `scripts/hydra-watchdog.sh` is the timer entry: it asks `hydra-watchdog.ts
 * plan` for this table (one tab-separated line per check) and runs every row as
 * its own `timeout <timeoutS> node … hydra-watchdog.ts <subcommand>` process, so
 * one crash or timeout never skips the others. Tests import the array to pin
 * the budget relations instead of regexing bash.
 *
 * Order is the tick order. Timeouts are the wrapper bounds each check's own
 * force-exit timer sits just under.
 */

import { BRIEF_MISSING_LOG_PREFIX, BRIEF_MISSING_TIMEOUT_S } from "./brief-missing.ts";
import { CLAUDE_HOOKS_LOG_PREFIX, CLAUDE_HOOKS_TIMEOUT_S } from "./claude-hooks.ts";
import { DEPLOY_DRIFT_LOG_PREFIX, DEPLOY_DRIFT_TIMEOUT_S } from "./deploy-drift.ts";
import { DISK_LOG_PREFIX } from "./disk.ts";
import { LAUNCH_FLOW_LOG_PREFIX } from "./launch-flow.ts";
import { LIVENESS_LOG_PREFIX } from "./liveness.ts";
import { ORIGIN_IDENTITY_LOG_PREFIX, ORIGIN_IDENTITY_TIMEOUT_S } from "./origin-identity.ts";
import { REDIS_BACKUP_LOG_PREFIX, REDIS_BACKUP_TIMEOUT_S } from "./redis-backup.ts";
import { SKILL_MIRROR_LOG_PREFIX, SKILL_MIRROR_TIMEOUT_S } from "./skill-mirror.ts";
import { WEDGE_LOG_PREFIX } from "./wedge.ts";

export interface WatchdogCheck {
  /** The `hydra-watchdog.ts <subcommand>` that runs the check. */
  readonly subcommand: string;
  /** The journal prefix the check logs under (and bash WARNs under). */
  readonly logPrefix: string;
  /** The `timeout` bound, seconds. */
  readonly timeoutS: number;
}

export const WATCHDOG_CHECKS: readonly WatchdogCheck[] = [
  { subcommand: "liveness", logPrefix: LIVENESS_LOG_PREFIX, timeoutS: 300 },
  { subcommand: "wedge", logPrefix: WEDGE_LOG_PREFIX, timeoutS: 90 },
  // 20s-capped `du --inodes` walk plus the channel calls.
  { subcommand: "disk", logPrefix: DISK_LOG_PREFIX, timeoutS: 90 },
  // The opt-in auto-deploy path runs scripts/deploy.sh.
  { subcommand: "deploy-drift", logPrefix: DEPLOY_DRIFT_LOG_PREFIX, timeoutS: DEPLOY_DRIFT_TIMEOUT_S },
  { subcommand: "redis-backup", logPrefix: REDIS_BACKUP_LOG_PREFIX, timeoutS: REDIS_BACKUP_TIMEOUT_S },
  // The opt-in autofix path runs scripts/sync-skills.sh.
  { subcommand: "skill-mirror", logPrefix: SKILL_MIRROR_LOG_PREFIX, timeoutS: SKILL_MIRROR_TIMEOUT_S },
  { subcommand: "claude-hooks", logPrefix: CLAUDE_HOOKS_LOG_PREFIX, timeoutS: CLAUDE_HOOKS_TIMEOUT_S },
  // 90s covers the 60s CLI force-exit (LAUNCH_FLOW_FORCE_EXIT_MS).
  { subcommand: "launch-flow", logPrefix: LAUNCH_FLOW_LOG_PREFIX, timeoutS: 90 },
  { subcommand: "brief-missing", logPrefix: BRIEF_MISSING_LOG_PREFIX, timeoutS: BRIEF_MISSING_TIMEOUT_S },
  { subcommand: "origin-identity", logPrefix: ORIGIN_IDENTITY_LOG_PREFIX, timeoutS: ORIGIN_IDENTITY_TIMEOUT_S },
];

/** The `plan` subcommand output: `<subcommand>\t<logPrefix>\t<timeoutS>` per check, in tick order. */
export function formatWatchdogPlan(checks: readonly WatchdogCheck[] = WATCHDOG_CHECKS): string {
  return checks.map((c) => `${c.subcommand}\t${c.logPrefix}\t${c.timeoutS}`).join("\n");
}
