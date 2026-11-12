/**
 * host-probe/probe.ts — the typed accessors of the **Host-Probe Adapter** seam
 * (issue #939). Sibling to `src/github/gh.ts`/`git.ts`: the only legitimate
 * callers of the private spawn primitive in `exec.ts`, exposing typed,
 * discriminated, never-throw `ProbeResult<T>` accessors to the rest of `src/`.
 *
 * Owns three things the `/api/health/deep` handler used to inline:
 *   1. The host-binary argv (`df -B1 --output=avail,size,pcent /`, `free -b`,
 *      `systemctl --user is-active <unit>`).
 *   2. The `df`/`free` columnar parse — lifted verbatim from `parseProbes`
 *      (`src/health-diagnostics.ts`), so the byte-level numbers are unchanged.
 *   3. The failure→result mapping that replaces the old `.catch(() => null)` /
 *      `.catch(() => "unknown")` sentinels with a discriminated `code`.
 *
 * Never throws (CLAUDE.md external-process boundary discipline).
 */

import {
  dfBin,
  duBin,
  freeBin,
  flockBin,
  bashBin,
  systemctlBin,
  runProbe,
  classifyProbeFailure,
  isProbeFailure,
  type ProbeResult,
  type ProbeExecOptions,
} from "./exec.ts";
import { logger } from "../logger.ts";

export { isProbeFailure, isProbeOk } from "./exec.ts";
export type { ProbeResult } from "./exec.ts";

/** Normalized disk reading. Gibibytes, rounded to one decimal — matches the old inline parse. */
export interface DiskUsage {
  availableGb: number;
  totalGb: number;
  usedPercent: number;
}

/** Normalized memory reading. Gibibytes, rounded to one decimal — matches the old inline parse. */
export interface MemUsage {
  totalGb: number;
  availableGb: number;
  usedPercent: number;
}

/**
 * One `--user` systemd timer record, as emitted by
 * `systemctl --user list-timers --output=json` (issue #2287).
 *
 * `last`/`next` are epoch MICROSECONDS (systemd's native unit). A timer that has
 * never fired reports `last: 0` — the not-yet-fired sentinel the wiring-liveness
 * chore must distinguish from a stale timer.
 */
export interface TimerRecord {
  /** Timer unit name, e.g. `"hydra-betting-nba-injuries.timer"`. */
  unit: string;
  /** Last-fire time in epoch microseconds; `0` means never fired. */
  last: number;
  /** Next-fire time in epoch microseconds; `0` when none scheduled. */
  next: number;
}

const BYTES_PER_GIB = 1073741824;
const roundGb = (bytes: number) => Math.round((bytes / BYTES_PER_GIB) * 10) / 10;

/**
 * Pure parse of `df -B1 --output=avail,size,pcent /` stdout into a `DiskUsage`.
 * Returns null when stdout has no parseable data row. Exported for unit tests so
 * the columnar grammar is pinned without spawning `df`. Logic is byte-for-byte
 * the old `parseProbes` disk branch.
 */
export function parseDfOutput(stdout: string): DiskUsage | null {
  const dl = stdout.trim().split("\n").pop()?.trim();
  if (!dl) return null;
  const p = dl.split(/\s+/);
  return {
    availableGb: roundGb(parseInt(p[0] || "0")),
    totalGb: roundGb(parseInt(p[1] || "0")),
    usedPercent: parseInt((p[2] || "0").replace("%", "")) || 0,
  };
}

/**
 * Pure parse of `free -b` stdout into a `MemUsage`. Returns null when there is no
 * `Mem:` row. Exported for unit tests. Logic is byte-for-byte the old
 * `parseProbes` memory branch (column 1 = total, column 6 = available).
 */
export function parseFreeOutput(stdout: string): MemUsage | null {
  const ml = stdout.split("\n").find((l: string) => l.startsWith("Mem:"));
  if (!ml) return null;
  const p = ml.split(/\s+/);
  const t = parseInt(p[1]) || 0;
  const a = parseInt(p[6]) || 0;
  return {
    totalGb: roundGb(t),
    availableGb: roundGb(a),
    usedPercent: t > 0 ? Math.round((1 - a / t) * 100) : 0,
  };
}

/**
 * Probe available/total disk on `/` via `df`. On success the `data` is a parsed
 * `DiskUsage`; on a spawn/timeout/non-zero failure OR unparseable output the
 * failure arm carries a `host-probe-*` code. Never throws.
 */
export async function readDisk(opts: ProbeExecOptions = {}): Promise<ProbeResult<DiskUsage>> {
  const raw = await runProbe(dfBin(), ["-B1", "--output=avail,size,pcent", "/"], opts);
  if (raw.exitCode !== 0 || raw.timedOut || raw.spawnErrorCode) {
    const code = classifyProbeFailure(raw);
    logger.error({ code, stderr: raw.stderr.slice(0, 200) }, "[host-probe] df failed");
    return { ok: false, code };
  }
  const parsed = parseDfOutput(raw.stdout);
  if (!parsed) {
    logger.error("[host-probe] df produced no parseable data row");
    return { ok: false, code: "host-probe-empty" };
  }
  return { ok: true, data: parsed };
}

/**
 * Probe total/available memory via `free -b`. On success the `data` is a parsed
 * `MemUsage`; on failure or unparseable output the failure arm carries a
 * `host-probe-*` code. Never throws.
 */
export async function readMem(opts: ProbeExecOptions = {}): Promise<ProbeResult<MemUsage>> {
  const raw = await runProbe(freeBin(), ["-b"], opts);
  if (raw.exitCode !== 0 || raw.timedOut || raw.spawnErrorCode) {
    const code = classifyProbeFailure(raw);
    logger.error({ code, stderr: raw.stderr.slice(0, 200) }, "[host-probe] free failed");
    return { ok: false, code };
  }
  const parsed = parseFreeOutput(raw.stdout);
  if (!parsed) {
    logger.error("[host-probe] free produced no Mem: row");
    return { ok: false, code: "host-probe-empty" };
  }
  return { ok: true, data: parsed };
}

/**
 * Probe a `--user` systemd unit's active-state via `systemctl is-active <unit>`.
 * `systemctl is-active` exits NON-ZERO for any state other than "active"
 * (inactive/failed/unknown) but still prints the state word on stdout — so
 * unlike `df`/`free`, a non-zero exit with stdout is the EXPECTED path, not a
 * failure. We therefore return the trimmed stdout state whenever there is one,
 * and only fall to the failure arm when the binary is missing, timed out, or
 * produced nothing parseable.
 *
 * The accessor returns the raw state string (`"active"`, `"inactive"`,
 * `"failed"`, ...); callers map that to display, exactly as the old inline
 * `.then(r => r.stdout.trim())` did. The previous `.catch(() => "unknown")`
 * sentinel is replaced by the discriminated failure arm — `/api/health/deep`
 * coalesces it back to `"unknown"` at the call site.
 */
export async function readServiceStatus(
  unit: string,
  opts: ProbeExecOptions = {},
): Promise<ProbeResult<string>> {
  const raw = await runProbe(systemctlBin(), ["--user", "is-active", unit], opts);
  // Spawn/timeout failures have no usable stdout — surface a code.
  if (raw.spawnErrorCode || raw.timedOut) {
    const code = classifyProbeFailure(raw);
    logger.error({ unit, code }, "[host-probe] systemctl is-active failed");
    return { ok: false, code };
  }
  const state = raw.stdout.trim();
  if (state) {
    // exit code is non-zero for non-active units, but the state word is the
    // signal we want — this is the success arm for the probe's purpose.
    return { ok: true, data: state };
  }
  // No stdout AND non-zero with no spawn/timeout marker: genuinely empty.
  if (raw.exitCode !== 0) {
    logger.error(
      { unit, exitCode: raw.exitCode },
      "[host-probe] systemctl is-active exited non-zero with no state word",
    );
    return { ok: false, code: "host-probe-failed" };
  }
  return { ok: false, code: "host-probe-empty" };
}

/**
 * Pure parse of `systemctl --user list-timers --output=json` stdout into a
 * `TimerRecord[]`. The JSON is an array of `{unit,last,next,...}` objects where
 * `last`/`next` are epoch microseconds (`0` = never fired). Returns null when
 * stdout is not a JSON array of timer objects (issue #2287).
 *
 * Defensive: coerces `last`/`next` to finite numbers (defaulting to 0) and skips
 * entries with no usable `unit` string, so a future systemd JSON field addition
 * or a partial record can never make the parse throw.
 */
function parseListTimersOutput(stdout: string): TimerRecord[] | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const records: TimerRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const unit = (entry as any).unit;
    if (typeof unit !== "string" || unit === "") continue;
    const last = Number((entry as any).last);
    const next = Number((entry as any).next);
    records.push({
      unit,
      last: Number.isFinite(last) ? last : 0,
      next: Number.isFinite(next) ? next : 0,
    });
  }
  return records;
}

/**
 * Probe the `--user` systemd timer set via
 * `systemctl --user list-timers --all --output=json`. On success the `data` is a
 * parsed `TimerRecord[]`; on a spawn/timeout/non-zero failure OR unparseable
 * output the failure arm carries a `host-probe-*` code. `--all` is passed so a
 * declared-but-inactive timer still appears in the live set (otherwise it would
 * be indistinguishable from a missing timer). Never throws.
 *
 * The wiring-liveness chore (issue #2287) injects a fake reader of this shape in
 * tests, so no real `systemctl` is spawned under `npm test`.
 */
export async function readUserTimers(
  opts: ProbeExecOptions = {},
): Promise<ProbeResult<TimerRecord[]>> {
  const raw = await runProbe(
    systemctlBin(),
    ["--user", "list-timers", "--all", "--output=json"],
    opts,
  );
  if (raw.exitCode !== 0 || raw.timedOut || raw.spawnErrorCode) {
    const code = classifyProbeFailure(raw);
    logger.error(
      { code, stderr: raw.stderr.slice(0, 200) },
      "[host-probe] systemctl list-timers failed",
    );
    return { ok: false, code };
  }
  const parsed = parseListTimersOutput(raw.stdout);
  if (!parsed) {
    logger.error("[host-probe] systemctl list-timers produced no parseable JSON array");
    return { ok: false, code: "host-probe-empty" };
  }
  return { ok: true, data: parsed };
}

/** Parse `systemctl show -p ActiveEnterTimestampMonotonic --value` output (µs since boot). `null` for non-numeric. */
export function parseMonotonicUs(stdout: string): number | null {
  const t = stdout.trim();
  if (!/^[0-9]+$/.test(t)) return null;
  return Number(t);
}

/**
 * The unit's `ActiveEnterTimestampMonotonic` in µs since boot (issue #5096) —
 * the watchdog's fresh-start grace input.
 */
export async function readServiceActiveEnterMonotonicUs(
  unit: string,
  opts: ProbeExecOptions = {},
): Promise<ProbeResult<number>> {
  const raw = await runProbe(
    systemctlBin(),
    ["--user", "show", "-p", "ActiveEnterTimestampMonotonic", "--value", unit],
    opts,
  );
  if (raw.spawnErrorCode || raw.timedOut || raw.exitCode !== 0) {
    const code = classifyProbeFailure(raw);
    logger.error({ unit, code, exitCode: raw.exitCode }, "[host-probe] systemctl show ActiveEnterTimestampMonotonic failed");
    return { ok: false, code };
  }
  const us = parseMonotonicUs(raw.stdout);
  if (us === null) return { ok: false, code: "host-probe-empty" };
  return { ok: true, data: us };
}

/**
 * Is the flock at `path` currently HELD by someone else? Probes with
 * `flock -n <path> true`: the lock is released the instant the throwaway child
 * exits, so the caller never holds it (issue #5096). exit 0 -> `held:false`,
 * exit 1 -> `held:true`; spawn/timeout/other exits are failures.
 */
export async function probeFileLockFree(
  path: string,
  opts: ProbeExecOptions = {},
): Promise<ProbeResult<{ held: boolean }>> {
  const raw = await runProbe(flockBin(), ["-n", path, "true"], opts);
  if (raw.spawnErrorCode || raw.timedOut) {
    const code = classifyProbeFailure(raw);
    logger.error({ path, code }, "[host-probe] flock probe failed");
    return { ok: false, code };
  }
  if (raw.exitCode === 0) return { ok: true, data: { held: false } };
  if (raw.exitCode === 1) return { ok: true, data: { held: true } };
  logger.error({ path, exitCode: raw.exitCode }, "[host-probe] flock probe exited unexpectedly");
  return { ok: false, code: "host-probe-failed" };
}

/** One name-prefix group's inode count under a root (e.g. `/tmp/hydra-*`). */
export interface InodeConsumer {
  path: string;
  inodes: number;
}

/**
 * The grouping key for one top-level entry: everything from the first digit on
 * becomes `*`, so `hydra-pace-1730000000.json` and `hydra-pace-1730000120.json`
 * both count toward `hydra-pace-*`. A leak is thousands of sibling temp files
 * as often as one huge directory, and only the prefix names the leaker.
 */
export function inodePrefixKey(basename: string): string {
  return basename.replace(/[0-9].*$/, "*");
}

/**
 * Pure parse of `du --inodes -x -a -d1 <root>` stdout into the top `limit`
 * consumers by inode count, descending, grouped by {@link inodePrefixKey}. The
 * `<root>` total line itself is dropped; malformed lines are skipped (a
 * maxBuffer-truncated last line included). Exported for unit tests.
 */
export function parseDuInodesOutput(stdout: string, root: string, limit: number): InodeConsumer[] {
  const rootNorm = root.replace(/\/+$/, "") || "/";
  const groups = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const m = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const path = m[2].replace(/\/+$/, "") || "/";
    if (path === rootNorm) continue;
    const base = path.slice(path.lastIndexOf("/") + 1);
    const key = `${rootNorm === "/" ? "" : rootNorm}/${inodePrefixKey(base)}`;
    groups.set(key, (groups.get(key) ?? 0) + Number(m[1]));
  }
  return [...groups]
    .map(([path, inodes]) => ({ path, inodes }))
    .sort((a, b) => b.inodes - a.inodes)
    .slice(0, Math.max(0, limit));
}

/** Bound on the `du --inodes` walk: a 1M-inode tmpfs walks in a few seconds. */
export const DU_INODES_TIMEOUT_MS = 20_000;
/** One line per top-level entry; a 1M-inode flat /tmp is ~30MB of `du -a` output. */
export const DU_INODES_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Top inode consumers directly under `root`, grouped by name prefix (issue
 * #5327): `du --inodes -x -a -d1 <root>`, bounded by
 * {@link DU_INODES_TIMEOUT_MS}. du exits 1 when a subtree is
 * unreadable (another user's private dir) yet still prints every readable
 * entry, so exit 1 with parseable rows is a success; a spawn failure, a
 * timeout, or no parseable row is a failure. Never throws.
 */
export async function readTopInodeConsumers(
  root: string,
  limit: number,
  opts: ProbeExecOptions = {},
): Promise<ProbeResult<InodeConsumer[]>> {
  const raw = await runProbe(duBin(), ["--inodes", "-x", "-a", "-d1", root], {
    timeout: DU_INODES_TIMEOUT_MS,
    maxBuffer: DU_INODES_MAX_BUFFER,
    ...opts,
  });
  if (raw.spawnErrorCode || raw.timedOut || (raw.exitCode !== 0 && raw.exitCode !== 1)) {
    const code = classifyProbeFailure(raw);
    logger.error({ root, code, exitCode: raw.exitCode }, "[host-probe] du --inodes failed");
    return { ok: false, code };
  }
  const parsed = parseDuInodesOutput(raw.stdout, root, limit);
  if (parsed.length === 0 && raw.exitCode !== 0) {
    logger.error({ root, exitCode: raw.exitCode }, "[host-probe] du --inodes produced no parseable row");
    return { ok: false, code: "host-probe-empty" };
  }
  return { ok: true, data: parsed };
}

/** Restart timeout: `systemctl --user restart` blocks until the unit settles (the orchestrator runs tsc in ExecStartPre). */
export const RESTART_TIMEOUT_MS = 90_000;

/**
 * The seam's first WRITE accessor (issue #5096): `systemctl --user restart <unit>`.
 * The only restart primitive the watchdog CLI uses.
 */
export async function restartService(
  unit: string,
  opts: ProbeExecOptions = {},
): Promise<ProbeResult<true>> {
  const raw = await runProbe(systemctlBin(), ["--user", "restart", unit], {
    timeout: RESTART_TIMEOUT_MS,
    ...opts,
  });
  if (raw.spawnErrorCode || raw.timedOut || raw.exitCode !== 0) {
    const code = classifyProbeFailure(raw);
    logger.error({ unit, code, exitCode: raw.exitCode }, "[host-probe] systemctl restart failed");
    return { ok: false, code };
  }
  return { ok: true, data: true };
}

/**
 * `systemctl --user is-enabled <unit>` (issue #5098 — the redis-backup timer
 * visibility line). The state word (`enabled`, `disabled`, `not-found`, ...) is
 * the signal even on a non-zero exit, like {@link readServiceStatus}; only a
 * spawn failure, timeout or an empty reply is the failure arm.
 */
export async function readUnitEnabledState(
  unit: string,
  opts: ProbeExecOptions = {},
): Promise<ProbeResult<string>> {
  const raw = await runProbe(systemctlBin(), ["--user", "is-enabled", unit], opts);
  if (raw.spawnErrorCode || raw.timedOut) {
    const code = classifyProbeFailure(raw);
    logger.error({ unit, code }, "[host-probe] systemctl is-enabled failed");
    return { ok: false, code };
  }
  const state = raw.stdout.trim();
  if (state) return { ok: true, data: state };
  return { ok: false, code: raw.exitCode !== 0 ? "host-probe-failed" : "host-probe-empty" };
}

/** Outcome of a repo-script run: exit code plus the last stderr line for the WARN. */
export interface ScriptRun {
  exitCode: number;
  stderrTail: string;
}

/** Timeout for the deploy script the opt-in auto-deploy runs (the wrapper allows >= 1200s). */
export const DEPLOY_SCRIPT_TIMEOUT_MS = 1_100_000;
/** Timeout for one sync-skills.sh run (the wrapper allows >= 300s). */
export const SYNC_SKILLS_TIMEOUT_MS = 140_000;

async function runRepoScript(
  script: string,
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv | undefined,
  label: string,
): Promise<ProbeResult<ScriptRun>> {
  const raw = await runProbe(bashBin(), [script], { timeout, cwd, env, maxBuffer: 8 * 1024 * 1024 });
  if (raw.spawnErrorCode || raw.timedOut) {
    const code = classifyProbeFailure(raw);
    logger.error({ script: label, code }, "[host-probe] repo script did not run to completion");
    return { ok: false, code };
  }
  const tail = raw.stderr.trim().split("\n").filter(Boolean).pop() ?? "";
  return { ok: true, data: { exitCode: raw.exitCode, stderrTail: tail.slice(0, 300) } };
}

/** `bash <root>/scripts/deploy.sh` (the watchdog's opt-in auto-deploy). One typed method per effect. */
export function runDeployScript(root: string, opts: { timeout?: number } = {}): Promise<ProbeResult<ScriptRun>> {
  return runRepoScript(`${root}/scripts/deploy.sh`, root, opts.timeout ?? DEPLOY_SCRIPT_TIMEOUT_MS, undefined, "deploy.sh");
}

/**
 * `bash <root>/scripts/sync-skills.sh`, optionally regenerating into a scratch
 * `CLAUDE_SKILLS_DIR` (the skill-mirror detector) — without `skillsDir` it
 * targets the live default mirror (the one caller allowed to reconcile it).
 */
export function runSyncSkillsScript(
  root: string,
  opts: { skillsDir?: string; timeout?: number } = {},
): Promise<ProbeResult<ScriptRun>> {
  const env = opts.skillsDir ? { CLAUDE_SKILLS_DIR: opts.skillsDir } : undefined;
  return runRepoScript(`${root}/scripts/sync-skills.sh`, root, opts.timeout ?? SYNC_SKILLS_TIMEOUT_MS, env, "sync-skills.sh");
}

/** Outcome of `bash <script> --list`: exit code plus raw stdout (the installer's HOOKS listing). */
export interface ListRun {
  exitCode: number;
  stdout: string;
}

/** Timeout for the installer's `--list` (a pure echo of its array; the wrapper allows 60s). */
export const INSTALLER_LIST_TIMEOUT_MS = 20_000;

/** `bash <script> --list` — the watchdog's claude-hooks check reads the installer's own HOOKS array. */
export async function runInstallerList(script: string): Promise<ProbeResult<ListRun>> {
  const raw = await runProbe(bashBin(), [script, "--list"], { timeout: INSTALLER_LIST_TIMEOUT_MS });
  if (raw.spawnErrorCode || raw.timedOut) return { ok: false, code: classifyProbeFailure(raw) };
  return { ok: true, data: { exitCode: raw.exitCode, stdout: raw.stdout } };
}
