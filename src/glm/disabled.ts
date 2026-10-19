/**
 * src/glm/disabled.ts — the GLM lane's durable operator off switch.
 *
 * The lane is OFF while a sentinel file exists (default
 * `$HOME/.config/hydra-glm/disabled`, beside the off-git z.ai credential
 * file). Deleting it turns the lane back on. A file, not a Redis flag or a
 * hand `systemctl disable`, because `scripts/deploy.sh` re-enables
 * `hydra-glm-drainer.timer` on every master merge: the sentinel is the one
 * input every layer can read without the service being up. It survives
 * deploys, and nothing in the repo ever writes it.
 *
 * Readers, all with this same path rule:
 *   - `scripts/deploy.sh` — disables the timer instead of enabling it
 *   - `scripts/glm/drainer-loop.sh` — exits before flock (no heartbeat)
 *   - `src/glm/gate.ts` — the `disabled` gate verdict (no heartbeat)
 *   - `src/scheduler/chores/glm-eligibility-sweep.ts` — stamps no labels
 *   - `scripts/glm-beachhead-report.sh` — prints a DISABLED line
 *
 * Writing no heartbeat is what hands the work back: the drainer heartbeat
 * goes stale after 45 minutes, so the GLM partition goes inactive and
 * `glmLane` routes every `glm-eligible` row to the Claude lane (fail-open,
 * #3754). Removing a credential instead would keep the heartbeat fresh while
 * authoring nothing, which starves those rows.
 *
 * `HYDRA_GLM_DISABLED_FILE` overrides the path. The test launcher
 * (`scripts/test/redis-db-launch.mjs`) points it at a path that never exists,
 * so a live sentinel on the shared CI host cannot leak into the suite.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The env override for the sentinel path. */
export const GLM_DISABLED_FILE_ENV = "HYDRA_GLM_DISABLED_FILE";

/** The sentinel's path relative to `$HOME`. */
export const GLM_DISABLED_FILE_RELATIVE = ".config/hydra-glm/disabled";

/**
 * The sentinel path for `env`: the override if set, else under `env.HOME`.
 * `null` when neither is set — there is nowhere to look, so the lane is on.
 * Pure: reads only the `env` it is handed.
 */
export function glmDisabledFilePath(env: NodeJS.ProcessEnv): string | null {
  const override = env[GLM_DISABLED_FILE_ENV];
  if (override) return override;
  if (env.HOME) return join(env.HOME, GLM_DISABLED_FILE_RELATIVE);
  return null;
}

/** True when the operator has switched the GLM lane off. */
export function isGlmLaneDisabled(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const path = glmDisabledFilePath(env);
  return path !== null && exists(path);
}
