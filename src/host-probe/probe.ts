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
  freeBin,
  systemctlBin,
  runProbe,
  classifyProbeFailure,
  isProbeFailure,
  type ProbeResult,
  type ProbeExecOptions,
} from "./exec.ts";

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
    console.error(`[host-probe] df failed (${code}): ${raw.stderr.slice(0, 200)}`);
    return { ok: false, code };
  }
  const parsed = parseDfOutput(raw.stdout);
  if (!parsed) {
    console.error("[host-probe] df produced no parseable data row");
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
    console.error(`[host-probe] free failed (${code}): ${raw.stderr.slice(0, 200)}`);
    return { ok: false, code };
  }
  const parsed = parseFreeOutput(raw.stdout);
  if (!parsed) {
    console.error("[host-probe] free produced no Mem: row");
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
    console.error(`[host-probe] systemctl is-active ${unit} failed (${code})`);
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
    console.error(
      `[host-probe] systemctl is-active ${unit} exited ${raw.exitCode} with no state word`,
    );
    return { ok: false, code: "host-probe-failed" };
  }
  return { ok: false, code: "host-probe-empty" };
}
