/**
 * The GLM dev-drainer's environment-override configuration (ADR-0040
 * Decision 2, issue #4682 — the gate-phase tracer bullet).
 *
 * One module reads every `HYDRA_GLM_DRAINER_*` override **using the same
 * names `scripts/glm/drainer-loop.sh` reads**, with the same defaults, so the
 * bash layer and the TypeScript phases agree for as long as the migration is
 * mid-flight (ADR-0040's interim contract). When the `tick` mode eventually
 * collapses `main()` this module becomes the single reader; until then BOTH
 * layers reading the identical env name is exactly the guarantee.
 *
 * Scope note (issue #4682 / ADR-0040 count discrepancy): the issue and ADR
 * both say "the 12 `HYDRA_GLM_DRAINER_*` overrides", but the bash script
 * reads exactly **10** distinct names today (grep
 * `HYDRA_GLM_DRAINER_[A-Z_]*` against `scripts/glm/drainer-loop.sh`). All 10
 * are read here — including `HYDRA_GLM_DRAINER_PAUSED_URL`, whose only bash
 * consumer (`is_operator_paused`) this slice deletes: the gate phase reads
 * the pause flag through the Redis seam (`getAutopilotPaused`) instead, so
 * the URL override is retained here as an owned-but-currently-unconsumed
 * field rather than silently dropped (deleting it would orphan any external
 * docs that still mention the name; a later phase either gives it a consumer
 * or removes it). `HYDRA_AUTOPILOT_REPO` is deliberately NOT read here: it is
 * not a `HYDRA_GLM_DRAINER_*` name, and `recover-stale.sh` shares it
 * deliberately ("one override affects both", per its own header comment).
 *
 * Parsing rules mirror bash's observable behaviour, not its error text:
 * a numeric override is used verbatim; an unparseable one fails OPEN the
 * same way the bash arithmetic comparisons did (e.g. `[[ 7 -ge abc ]]` is an
 * arithmetic error, i.e. false, i.e. "not exhausted"), which here means the
 * cap/risk limit becomes effectively unbounded (`Infinity`) rather than
 * falling back to the default — a misconfigured cap must not silently become
 * the default cap.
 */

import { readFileSync } from "node:fs";

/** The drainer's full environment-derived configuration. */
export interface DrainerConfig {
  /** Which checkout's scripts/src this tick uses (`HYDRA_GLM_DRAINER_REPO_ROOT`). */
  repoRoot: string;
  /** Dry-run: every mutating action logs `would-<action>` and no-ops (`HYDRA_GLM_DRAINER_DRY_RUN=1`). */
  dryRun: boolean;
  /**
   * The operator-pause HTTP endpoint override (`HYDRA_GLM_DRAINER_PAUSED_URL`).
   * Owned but currently unconsumed: the gate phase reads the pause flag via
   * the Redis seam (`getAutopilotPaused`), not HTTP — see the header comment.
   */
  pausedUrl: string;
  /** Design-concepts API base (`HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL`). */
  designConceptUrl: string;
  /** flock lockfile path (`HYDRA_GLM_DRAINER_LOCKFILE`). */
  lockfile: string;
  /** Directory holding the daily-cap counter, quota-block file, timeout counters (`HYDRA_GLM_DRAINER_CAP_DIR`). */
  capDir: string;
  /** Daily PR cap (`HYDRA_GLM_DRAINER_DAILY_CAP`, default 5). `Infinity` when unparseable (fail-open). */
  dailyCap: number;
  /** Per-issue timeout-resume cap (`HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP`, default 2). `Infinity` when unparseable. */
  timeoutResumeCap: number;
  /** Where authoring worktrees are created (`HYDRA_GLM_DRAINER_WORKTREE_ROOT`). */
  worktreeRoot: string;
  /** Timezone offset for z.ai 429 reset clauses (`HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET`, default +0800). */
  quotaResetTzOffset: string;
}

/**
 * Parse a non-negative integer override. Returns `Infinity` for anything
 * unparseable or negative-but-not-numeric-shaped — the fail-open direction
 * the bash arithmetic comparisons had (see header). A legitimately negative
 * value (e.g. `DAILY_CAP=-1`) parses fine and is returned verbatim; bash
 * honoured it too (`count >= -1` is always true, i.e. always exhausted).
 */
function parseCountOverride(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/**
 * Read the drainer config from an environment (injectable for tests; the
 * default callers pass `process.env`). Names and defaults mirror
 * `scripts/glm/drainer-loop.sh`'s top-of-file block exactly.
 */
export function readDrainerConfig(env: NodeJS.ProcessEnv): DrainerConfig {
  return {
    repoRoot: env.HYDRA_GLM_DRAINER_REPO_ROOT ?? "",
    dryRun: env.HYDRA_GLM_DRAINER_DRY_RUN === "1",
    pausedUrl:
      env.HYDRA_GLM_DRAINER_PAUSED_URL ??
      "http://localhost:4000/api/autopilot/paused",
    designConceptUrl:
      env.HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL ??
      "http://localhost:4000/api/design-concepts",
    lockfile: env.HYDRA_GLM_DRAINER_LOCKFILE ?? "/tmp/hydra-glm-drainer.lock",
    capDir: env.HYDRA_GLM_DRAINER_CAP_DIR ?? "/tmp",
    dailyCap: parseCountOverride(env.HYDRA_GLM_DRAINER_DAILY_CAP ?? "5"),
    timeoutResumeCap: parseCountOverride(
      env.HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP ?? "2",
    ),
    worktreeRoot:
      env.HYDRA_GLM_DRAINER_WORKTREE_ROOT ??
      "/home/gabe/hydra/.claude/worktrees",
    quotaResetTzOffset:
      env.HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET ?? "+0800",
  };
}

/** The committed CLI entrypoint's config — read once per driver invocation. */
export function defaultDrainerConfig(): DrainerConfig {
  return readDrainerConfig(process.env);
}

// ---------------------------------------------------------------------------
// File-backed state paths (ADR-0040 Decision 3: the daily cap count and the
// quota block keep today's `$CAP_DIR` paths and formats — behaviour-preserving
// by design, so a live quota block survives the cut-over tick). These helpers
// are the TypeScript side of the two path formats `scripts/glm/drainer-loop.sh`
// still inlines in its KEPT writers (`cap_increment`, `record_quota_block_if_429`);
// `test/glm-gate.test.mts` pins the cross-layer string parity so the pair can
// never drift silently (the LOCKSTEP-comment replacement ADR-0040 Decision 5
// prescribes).
// ---------------------------------------------------------------------------

/** UTC calendar date (`YYYY-MM-DD`) for a wall-clock instant — `date -u +%F`'s format. */
export function todayUtc(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Path of the date-stamped daily-cap counter file. */
export function dailyCapFilePath(capDir: string, todayUtcDate: string): string {
  return `${capDir}/hydra-glm-drainer-daily-cap-${todayUtcDate}`;
}

/** Path of the z.ai quota-block epoch file (issue #4273). */
export function quotaBlockFilePath(capDir: string): string {
  return `${capDir}/hydra-glm-drainer-quota-blocked-until`;
}

/**
 * Epoch-seconds → `YYYY-MM-DDTHH:MM:SSZ`, byte-compatible with the bash
 * `date -u -d "@<epoch>" +%Y-%m-%dT%H:%M:%SZ` formatting the loop's log lines
 * used (no millisecond component). Best-effort log formatting only.
 */
export function epochToIsoUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Read a small state file's trimmed contents; "" when missing (ENOENT). */
export function readStateFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err: any) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }
}
