/**
 * Log-tail helper for the autopilot data plane.
 *
 * Extracted from src/api/autopilot.ts so the route layer can be a thin
 * adapter. The route handler now reduces to: validate inputs → call
 * `readLogTail()` → write the HTTP response.
 *
 *   `readLogTail({ runId, row, tail })` — returns the last N lines
 *   from either `/tmp/hydra-autopilot-nightly.log` (for the live
 *   run) or `.log.prev` (for the immediately prior run, if the
 *   rotated file's mtime is within tolerance of `row.started_epoch`).
 *   Older runs return `{ ok: false, code: "rotated" }`.
 *
 * The systemd-journal slice surface (`readJournalSlice`, the `journalctl`
 * spawn) moved to the **Journal Adapter** seam (`src/journal/*`, issue #1958)
 * — the fourth process boundary, now behind its own private spawn primitive
 * with injectable deps and a `journal-seam-check` ratchet, instead of the
 * inline spawn this module used to own (and that both `github-seam-check` and
 * `host-probe-seam-check` carved out as an acknowledged exception). The route
 * imports `readJournalSlice` from `src/journal/read.ts` directly.
 *
 * Constants are env-overridable so tests can point at temp files without
 * touching /tmp.
 */

import { readFile, stat } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTOPILOT_LOG_PATH =
  process.env.HYDRA_AUTOPILOT_LOG || "/tmp/hydra-autopilot-nightly.log";
const AUTOPILOT_LOG_PREV_PATH =
  process.env.HYDRA_AUTOPILOT_LOG_PREV || `${AUTOPILOT_LOG_PATH}.prev`;
const AUTOPILOT_STATE_PATH =
  process.env.HYDRA_AUTOPILOT_STATE || "/tmp/hydra-autopilot-state.json";

export const LOG_TAIL_DEFAULT = 50;
export const LOG_TAIL_MAX = 2000;

/**
 * Tolerance window for matching `.log.prev` to a previous run. bootstrap.sh
 * runs the rotation `mv` just before stamping STARTED_EPOCH, so the prev
 * file's mtime is ~= the new run's start time. 5 minutes is generous enough
 * for slow disks and clock skew without matching a much older rotated file.
 */
const LOG_PREV_MTIME_TOLERANCE_S = 300;

// ---------------------------------------------------------------------------
// Log tail
// ---------------------------------------------------------------------------

/**
 * Look up the current run_id from `state.json`. Returns null if the
 * file is missing or unparseable — both are normal pre-first-run states
 * and the caller treats them as "no live run".
 */
async function readCurrentRunIdFromState(): Promise<string | null> {
  try {
    const raw = await readFile(AUTOPILOT_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const rid = parsed && typeof parsed.run_id === "string" ? parsed.run_id.trim() : "";
    return rid || null;
  } catch {
    /* intentional: missing/unparseable state file is a normal pre-first-run state → "no live run" */
    return null;
  }
}

/**
 * Decide which log file (if any) serves the request for `runId`.
 *
 * Returns `{ path, source: "live" | "prev" }` or `null` if the log is
 * no longer available (rotated past the .prev window, or never existed
 * for this run).
 *
 * Rule (issue #499 body):
 *   - runId == state.json.run_id              → live log
 *   - else `.prev` exists AND its mtime is within
 *     `LOG_PREV_MTIME_TOLERANCE_S` of `row.started_epoch` → prev log
 *   - else null
 */
async function resolveLogFileForRun(
  runId: string,
  row: Record<string, string>,
): Promise<{ path: string; source: "live" | "prev" } | null> {
  const currentRunId = await readCurrentRunIdFromState();
  if (currentRunId && currentRunId === runId) {
    try {
      await stat(AUTOPILOT_LOG_PATH);
      return { path: AUTOPILOT_LOG_PATH, source: "live" };
    } catch {
      /* intentional: live log file missing → log not available for this run */
      return null;
    }
  }

  let prevStat;
  try {
    prevStat = await stat(AUTOPILOT_LOG_PREV_PATH);
  } catch {
    /* intentional: no .prev log → rotated past the window or never existed */
    return null;
  }
  const startedEpoch = Number(row.started_epoch || "0");
  if (!Number.isFinite(startedEpoch) || startedEpoch <= 0) return null;
  const mtimeEpoch = Math.floor(prevStat.mtimeMs / 1000);
  if (Math.abs(mtimeEpoch - startedEpoch) > LOG_PREV_MTIME_TOLERANCE_S) {
    return null;
  }
  return { path: AUTOPILOT_LOG_PREV_PATH, source: "prev" };
}

/**
 * Read up to the last `maxBytes` of a file as UTF-8. For log files
 * <16MB this comfortably fits in memory; for larger files we read only
 * the trailing window.
 *
 * Returns "" for empty files. Caller has already stat'd to confirm
 * existence.
 */
async function readLastBytes(path: string, maxBytes: number): Promise<string> {
  const st = await stat(path);
  if (st.size === 0) return "";
  if (st.size <= maxBytes) {
    return readFile(path, "utf-8");
  }
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    await fh.read(buf, 0, maxBytes, st.size - maxBytes);
    return buf.toString("utf-8");
  } finally {
    await fh.close();
  }
}

export type LogTailResult =
  | { ok: true; text: string; source: "live" | "prev" }
  | { ok: false; code: "rotated" };

/**
 * Read the last `tail` lines of the log file resolved for `runId`.
 *
 * `tail` MUST already be validated in the caller (1 ≤ tail ≤
 * LOG_TAIL_MAX). The caller is also responsible for confirming the run
 * exists in the Redis index — this function trusts `row` is the
 * corresponding hash.
 */
export async function readLogTail(args: {
  runId: string;
  row: Record<string, string>;
  tail: number;
}): Promise<LogTailResult> {
  const resolution = await resolveLogFileForRun(args.runId, args.row);
  if (!resolution) return { ok: false, code: "rotated" };

  // Defensively cap at 16MB so a pathological log size can't blow up RAM.
  const contents = await readLastBytes(resolution.path, 16 * 1024 * 1024);
  const lines = contents.split(/\r?\n/);
  // Drop trailing empty line from terminal newline; preserve real blank lines mid-file.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const tailed = lines.slice(-args.tail).join("\n");
  return { ok: true, text: tailed, source: resolution.source };
}
