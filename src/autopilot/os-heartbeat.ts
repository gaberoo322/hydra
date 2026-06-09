/**
 * OS-heartbeat reader (issue #1091).
 *
 * Background
 * ----------
 * The autopilot has TWO liveness signals, and conflating them caused a
 * structural wedge false-positive:
 *
 *   1. The **per-turn heartbeat** — `last_heartbeat_epoch` on the run hash,
 *      written ONLY inside `recordTurn()` (once per *completed* decision
 *      turn). While the loop is mid-turn waiting on slow background
 *      subagents (a hydra-target-build + several `npm test` runs easily
 *      exceed 10 min), this value is frozen at the previous turn boundary.
 *      `wedge_likely` / `stalled-dispatch` derived from it alone therefore
 *      flag a perfectly healthy, actively-reaping run as wedged.
 *
 *   2. The **OS heartbeat** — `/tmp/hydra-autopilot-heartbeat.txt`, written
 *      continuously by `scripts/autopilot/heartbeat.py` (#435) every turn
 *      AND refreshed out-of-band by the collect-state cadence. Its first
 *      whitespace-token is the current unix epoch (which also drives the
 *      file mtime operators grep on). This is the signal that actually
 *      tracks intra-turn liveness.
 *
 * The fix (#1091, option 1): cross-check the OS heartbeat. A run is only
 * wedged / stalled when BOTH heartbeats are stale. If the OS heartbeat is
 * fresh, the control loop is alive even though the per-turn heartbeat lags.
 *
 * This module is the single read seam for that OS-heartbeat epoch, kept
 * pure + injectable so both consumers (`runs.ts` wedge derivation and the
 * `autopilot-health` stalled-dispatch heuristic) share one tested boundary
 * without each re-implementing the file parse.
 *
 * Contract:
 *   - Never throws. A missing / unreadable / unparseable heartbeat returns
 *     `null` (age unknown), and callers MUST fail open — i.e. treat an
 *     unknown OS-heartbeat age as "stale" so a genuinely hung run whose
 *     heartbeat file vanished is still flagged. Only a *fresh* OS heartbeat
 *     suppresses the wedge signal.
 *   - Read-only. No writes, ever (mirrors `grounding.ts` discipline).
 */

import { readFileSync, statSync } from "node:fs";

/** Default OS-heartbeat path; overridable via env for tests / non-default deploys. */
const OS_HEARTBEAT_PATH =
  process.env.HYDRA_AUTOPILOT_HEARTBEAT || "/tmp/hydra-autopilot-heartbeat.txt";

/**
 * Parse the heartbeat epoch (seconds) out of one heartbeat-file line.
 *
 * The line format (heartbeat.py #435) is:
 *   `<epoch> <pid> <run_id> turn=<N> dispatches=<M> ...`
 * so the epoch is the first whitespace-delimited token. Returns `null`
 * when the first token isn't a positive finite integer-ish epoch.
 *
 * Pure + exported for tests.
 */
export function parseHeartbeatEpoch(line: string): number | null {
  if (typeof line !== "string") return null;
  const first = line.trim().split(/\s+/, 1)[0];
  if (!first) return null;
  const epoch = Number(first);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return Math.floor(epoch);
}

/**
 * Reader for the raw OS-heartbeat epoch (seconds), or `null` when it can't
 * be determined. Prefers the epoch token written into the file (the value
 * heartbeat.py stamps); falls back to the file's mtime so a truncated /
 * partially-written line still yields a usable liveness timestamp. Returns
 * `null` only when the file is absent or wholly unreadable.
 *
 * Never throws — every failure path returns `null`.
 */
export function readOsHeartbeatEpoch(path: string = OS_HEARTBEAT_PATH): number | null {
  // 1. Preferred: the epoch token inside the file.
  try {
    const raw = readFileSync(path, "utf8");
    const firstLine = raw.split("\n", 1)[0] ?? "";
    const epoch = parseHeartbeatEpoch(firstLine);
    if (epoch !== null) return epoch;
  } catch {
    /* intentional: fall through to mtime, then null — missing/unreadable file is expected. */
  }
  // 2. Fallback: file mtime (the value operators grep on via `find -mmin`).
  try {
    const st = statSync(path);
    const mtimeS = Math.floor(st.mtimeMs / 1000);
    if (Number.isFinite(mtimeS) && mtimeS > 0) return mtimeS;
  } catch {
    /* intentional: no file → age unknown → null (caller fails open to "stale"). */
  }
  return null;
}

/**
 * Age (seconds) of the OS heartbeat relative to `nowS`, or `null` when the
 * heartbeat can't be read. A clamp at 0 guards against clock skew where the
 * stamped epoch is slightly ahead of `nowS`.
 *
 * Pure given `readEpoch` — defaults to the real file reader, overridable in
 * tests so neither consumer needs a fixture file on disk.
 */
export function osHeartbeatAgeS(
  nowS: number,
  readEpoch: () => number | null = () => readOsHeartbeatEpoch(),
): number | null {
  const epoch = readEpoch();
  if (epoch === null) return null;
  return Math.max(0, nowS - epoch);
}

/**
 * Decision helper: is the OS heartbeat STALE relative to `thresholdS`?
 *
 * Fails open: a `null` age (heartbeat unreadable / absent) counts as STALE
 * so the wedge signal is NOT silently suppressed for a run whose heartbeat
 * file disappeared. Only a fresh, readable heartbeat (`age <= threshold`)
 * returns `false`.
 *
 * Pure + exported for tests.
 */
export function isOsHeartbeatStale(ageS: number | null, thresholdS: number): boolean {
  if (ageS === null) return true; // fail open — unknown liveness is treated as stale
  return ageS > thresholdS;
}
