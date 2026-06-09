/**
 * Log + journal helpers for the autopilot data plane.
 *
 * Extracted from src/api/autopilot.ts so the route layer can be a thin
 * adapter. The route handler now reduces to: validate inputs → call
 * `readLogTail()` / `readJournalSlice()` → write the HTTP response.
 *
 * Two surfaces:
 *
 *   1. `readLogTail({ runId, row, tail })` — returns the last N lines
 *      from either `/tmp/hydra-autopilot-nightly.log` (for the live
 *      run) or `.log.prev` (for the immediately prior run, if the
 *      rotated file's mtime is within tolerance of `row.started_epoch`).
 *      Older runs return `{ ok: false, code: "rotated" }`.
 *
 *   2. `readJournalSlice({ row })` — shells out to `journalctl --user
 *      -u <unit> --since <iso> --until <iso>` with output capped at
 *      JOURNAL_MAX_BYTES and execution timeout at JOURNAL_TIMEOUT_MS.
 *      All argv values come from the server-controlled run hash; the
 *      request body cannot influence them.
 *
 * Constants are env-overridable so tests can point at temp files /
 * mocked binaries without touching /tmp or requiring a real
 * journalctl on the CI host.
 */

import { spawn } from "node:child_process";
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

const JOURNAL_MAX_BYTES = 1024 * 1024; // 1 MB output cap (issue #499 AC)

/**
 * Env-driven knobs read on each call to `runJournalctl`. Test code in
 * `test/autopilot-logs.test.mts` mutates these envs and re-imports the
 * route module with a cache-buster to drive timeout and shim-binary
 * scenarios — reading at call time (rather than at module load) lets
 * that pattern work without dragging the whole module dependency tree
 * through the cache-bust. Production never sets these knobs.
 */
function journalTimeoutMs(): number {
  return Number(process.env.HYDRA_AUTOPILOT_JOURNAL_TIMEOUT_MS || "10000");
}
function journalUnit(): string {
  return process.env.HYDRA_AUTOPILOT_JOURNAL_UNIT || "hydra-autopilot.service";
}
function journalCmdOverride(): string | undefined {
  return process.env.HYDRA_AUTOPILOT_JOURNAL_CMD;
}

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
      return null;
    }
  }

  let prevStat;
  try {
    prevStat = await stat(AUTOPILOT_LOG_PREV_PATH);
  } catch {
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

// ---------------------------------------------------------------------------
// Journal slice
// ---------------------------------------------------------------------------

/**
 * Validate that a string looks like an ISO-8601 timestamp the kernel
 * journal will accept. Returns the original string when valid; null
 * otherwise. Intentionally strict — guards against a malformed Redis
 * row being passed straight into argv.
 */
export function sanitizeIso(s: string | undefined | null): string | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Compute the `--until` value for a journal query. For ended/killed
 * runs with a recorded `ended_epoch`, returns that as ISO. Otherwise
 * returns the current time (live run window).
 */
function computeUntilIso(row: Record<string, string>): string {
  const endedEpoch = Number(row.ended_epoch || "0");
  if (Number.isFinite(endedEpoch) && endedEpoch > 0) {
    return new Date(endedEpoch * 1000).toISOString();
  }
  return new Date().toISOString();
}

interface JournalSpawnResult {
  text: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Spawn `journalctl` for the given unit + time window. Output capped
 * at JOURNAL_MAX_BYTES; over-cap reads SIGTERM the child and append a
 * truncation marker. Timeouts SIGTERM after JOURNAL_TIMEOUT_MS.
 *
 * Internally consumed by `readJournalSlice` (below). Also exported so
 * `test/autopilot-logs.test.mts` can drive it with a mocked binary via
 * `HYDRA_AUTOPILOT_JOURNAL_CMD` — the `journalCmdOverride()` /
 * `journalTimeoutMs()` helpers read those env vars at call time. The test
 * imports it through a cache-busted dynamic `import()` knip cannot resolve
 * statically, so the export is tagged `@public` to keep it off the
 * unused-export report (the prior `src/api/autopilot.ts` re-export that knip
 * could see was removed in #1425).
 *
 * @public
 */
export function runJournalctl(
  unit: string,
  sinceIso: string,
  untilIso: string,
): Promise<JournalSpawnResult> {
  const override = journalCmdOverride();
  const timeoutMs = journalTimeoutMs();
  return new Promise<JournalSpawnResult>((resolve) => {
    const cmd = override || "journalctl";
    const args = override
      ? [unit, sinceIso, untilIso]
      : [
          "--user",
          "-u", unit,
          "--since", sinceIso,
          "--until", untilIso,
          "--no-pager",
          "--output=short-iso",
        ];

    let child;
    try {
      // shell:false is the default for spawn; we re-state it via the
      // absence of the `shell` option. Argv array, no interpolation.
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err: any) {
      resolve({
        text: `[autopilot] journalctl spawn failed: ${err?.message || err}\n`,
        truncated: false,
        timedOut: false,
      });
      return;
    }

    let buf = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = buf.toString("utf-8");
      if (extra) text += extra;
      resolve({ text, truncated, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* intentional: best-effort kill */ }
      finish(
        `\n[autopilot] --- journalctl timed out after ${timeoutMs}ms ---\n`,
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = JOURNAL_MAX_BYTES - buf.length;
      if (remaining <= 0) {
        truncated = true;
        try { child.kill("SIGTERM"); } catch { /* intentional: best-effort */ }
        finish(`\n[autopilot] --- output truncated at ${JOURNAL_MAX_BYTES} bytes ---\n`);
        return;
      }
      const take = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      buf = Buffer.concat([buf, take]);
      if (chunk.length > remaining) {
        truncated = true;
        try { child.kill("SIGTERM"); } catch { /* intentional: best-effort */ }
        finish(`\n[autopilot] --- output truncated at ${JOURNAL_MAX_BYTES} bytes ---\n`);
      }
    });

    child.stderr?.on("data", () => {
      /* intentional: discard stderr — journalctl prints "No entries"
         etc., which is information leakage we don't want in a UI panel.
         The exit code surfaces real failures. */
    });

    child.on("error", (err: any) => {
      finish(`\n[autopilot] journalctl error: ${err?.message || err}\n`);
    });

    child.on("close", () => {
      finish();
    });
  });
}

export type JournalSliceResult =
  | { ok: true; text: string; unit: string; truncated: boolean; timedOut: boolean }
  | { ok: false; code: "invalid-row" };

/**
 * Read the journal slice for the run window described by `row`.
 *
 * The route handler trusts this Module's argv hygiene (sanitizeIso +
 * server-controlled inputs). Bodies are never used for journal args.
 */
export async function readJournalSlice(args: {
  row: Record<string, string>;
}): Promise<JournalSliceResult> {
  const since = sanitizeIso(args.row.started);
  if (!since) return { ok: false, code: "invalid-row" };
  const untilIso = computeUntilIso(args.row);
  const unit = journalUnit();
  const result = await runJournalctl(unit, since, untilIso);
  return {
    ok: true,
    text: result.text,
    unit,
    truncated: result.truncated,
    timedOut: result.timedOut,
  };
}
