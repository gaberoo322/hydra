/**
 * src/glm/drainer-config.ts — the GLM dev-drainer's environment overrides,
 * read in one place (ADR-0040 Decision 2; epic #4681, issue #4682).
 *
 * Every name here is the SAME `HYDRA_*` name `scripts/glm/drainer-loop.sh`
 * reads, with the same default, so the bash and TypeScript layers agree
 * while the migration is mid-flight. Dry-run is the environment variable
 * `HYDRA_GLM_DRAINER_DRY_RUN=1`, read once here — never an argv flag.
 *
 * `HYDRA_GLM_DRAINER_PAUSED_URL` is deliberately absent: the gate phase reads
 * the operator pause from Redis via `getAutopilotPaused()` (ADR-0040
 * Decision 2), so the HTTP pause URL retired with the bash
 * `is_operator_paused` it configured.
 *
 * Pure: no I/O, never throws. A non-integer numeric override falls back to
 * its default rather than propagating `NaN` into a comparison.
 */

/** Default daily PR cap (bash: `DAILY_CAP=${HYDRA_GLM_DRAINER_DAILY_CAP:-5}`). */
export const DEFAULT_DAILY_CAP = 5;

/** Default per-issue timeout retry cap (issue #4337 INV-6). */
export const DEFAULT_TIMEOUT_RESUME_CAP = 2;

export interface DrainerConfig {
  /** `HYDRA_GLM_DRAINER_REPO_ROOT`; `null` = the caller's own checkout. */
  repoRoot: string | null;
  /** `HYDRA_AUTOPILOT_REPO` — shared with recover-stale.sh. */
  repo: string;
  /** `HYDRA_GLM_DRAINER_DRY_RUN=1`. */
  dryRun: boolean;
  /** `HYDRA_GLM_DRAINER_LOCKFILE` — the flock file (flock itself stays in bash). */
  lockfile: string;
  /** `HYDRA_GLM_DRAINER_CAP_DIR` — home of the cap, timeout and quota-block files. */
  capDir: string;
  /** `HYDRA_GLM_DRAINER_DAILY_CAP`. */
  dailyCap: number;
  /** `HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP`. */
  timeoutResumeCap: number;
  /** `HYDRA_GLM_DRAINER_WORKTREE_ROOT`. */
  worktreeRoot: string;
  /** `HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET` (issue #4273). */
  quotaResetTzOffset: string;
  /** `HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL`. */
  designConceptUrl: string;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

/** Read the drainer's overrides from `env` (defaults match drainer-loop.sh). */
export function loadDrainerConfig(env: NodeJS.ProcessEnv = process.env): DrainerConfig {
  return {
    repoRoot: env.HYDRA_GLM_DRAINER_REPO_ROOT || null,
    repo: env.HYDRA_AUTOPILOT_REPO || "gaberoo322/hydra",
    dryRun: env.HYDRA_GLM_DRAINER_DRY_RUN === "1",
    lockfile: env.HYDRA_GLM_DRAINER_LOCKFILE || "/tmp/hydra-glm-drainer.lock",
    capDir: env.HYDRA_GLM_DRAINER_CAP_DIR || "/tmp",
    dailyCap: nonNegativeInt(env.HYDRA_GLM_DRAINER_DAILY_CAP, DEFAULT_DAILY_CAP),
    timeoutResumeCap: nonNegativeInt(
      env.HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP,
      DEFAULT_TIMEOUT_RESUME_CAP,
    ),
    worktreeRoot:
      env.HYDRA_GLM_DRAINER_WORKTREE_ROOT || "/home/gabe/hydra/.claude/worktrees",
    quotaResetTzOffset: env.HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET || "+0800",
    designConceptUrl:
      env.HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL || "http://localhost:4000/api/design-concepts",
  };
}
