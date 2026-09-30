/**
 * src/glm/gate.ts — the GLM drainer's GATE phase (ADR-0040 Decisions 1–3;
 * epic #4681, issue #4682 — the tracer bullet).
 *
 * Replaces the bash pre-authoring sequence in `scripts/glm/drainer-loop.sh`'s
 * `main()`: operator pause → daily PR cap → z.ai quota block → heartbeat.
 * First match wins, in that order, exactly as bash exited:
 *
 *   - `paused`        — the operator pause flag (Redis, `getAutopilotPaused()`).
 *                       The kill-switch honours ONLY the operator pause, never
 *                       Anthropic usage reasons (ADR-0032 Decision 6).
 *   - `cap-exhausted` — today's (UTC) PR count has reached the daily cap.
 *   - `quota-blocked` — a z.ai quota block instant is still in the future.
 *
 * On `able` the gate writes the drainer heartbeat itself (ADR-0040 Decision
 * 2: the three exclusions are its own verdict). A skip writes NO heartbeat, so
 * the heartbeat lapses honestly and the 45-min staleness fallback fires. The
 * lock-held heartbeat stays in bash with flock (kernel auto-release, ADR-0032
 * invariant 5).
 *
 * Fail directions (unchanged from bash):
 *   - a rejected pause read, or one that does not settle within 10 s (curl
 *     `--max-time 10` parity) → paused (fail closed);
 *   - a corrupt pause blob → not paused (`getAutopilotPaused` already returns
 *     `{paused:false}` for it); only `paused === true` pauses;
 *   - a missing / non-numeric cap file → count 0;
 *   - a missing / non-numeric / past quota-block file → no block; a file that
 *     exists but is not an active block is deleted (`rm -f` semantics); an
 *     active block file is never touched.
 *
 * File-backed state keeps today's `$CAP_DIR` paths and formats (ADR-0040
 * Decision 3) so a live quota block survives the cut-over tick.
 *
 * The gate emits NO human log lines: it returns a {@link GateLine} whose
 * `reason` / `heartbeat` / `detail` bash turns into the unchanged
 * `hydra-glm-drainer:` journal prose, so bash stays the single human-log
 * writer until the tick slice (#4688). Only faults go to `logger` (stderr).
 *
 * `runGate` never throws. Dry-run (`HYDRA_GLM_DRAINER_DRY_RUN=1`) still
 * performs the reads — as bash did — but writes no heartbeat and reports
 * `heartbeat: "would-write"`.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { logger } from "../logger.ts";
import { setGlmDrainerHeartbeat } from "../redis/autopilot.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import { loadDrainerConfig, type DrainerConfig } from "./drainer-config.ts";

/** A pause read that has not settled by then is treated as paused (curl `--max-time 10`). */
export const PAUSE_READ_TIMEOUT_MS = 10_000;

export type GateReason = "paused" | "cap-exhausted" | "quota-blocked";

export type GateVerdict = { able: true } | { able: false; reason: GateReason };

export interface GateInput {
  paused: boolean;
  capCount: number;
  dailyCap: number;
  /** Epoch seconds, or `null` when there is no active block. */
  quotaBlockedUntil: number | null;
  /** Epoch seconds. */
  now: number;
}

/**
 * The `gate` driver mode's stdout line. `detail` is a preformatted string bash
 * logs verbatim: `N/M` for the cap, an ISO-8601 UTC instant for a quota block,
 * the failure message for a failed heartbeat write or a failed pause read.
 */
export type GateLine =
  | { able: true; heartbeat: "written" | "would-write" | "write-failed"; detail?: string }
  | { able: false; reason: GateReason; detail?: string };

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** The gate verdict. Pure. First match wins: paused → cap → quota block. */
export function decideGate(input: GateInput): GateVerdict {
  if (input.paused) return { able: false, reason: "paused" };
  if (input.capCount >= input.dailyCap) return { able: false, reason: "cap-exhausted" };
  if (input.quotaBlockedUntil !== null && input.quotaBlockedUntil > input.now) {
    return { able: false, reason: "quota-blocked" };
  }
  return { able: true };
}

/** `<capDir>/hydra-glm-drainer-daily-cap-YYYY-MM-DD` for the UTC day of `nowMs`. */
export function capFilePath(capDir: string, nowMs: number): string {
  return join(capDir, `hydra-glm-drainer-daily-cap-${new Date(nowMs).toISOString().slice(0, 10)}`);
}

/** `<capDir>/hydra-glm-drainer-quota-blocked-until`. */
export function quotaBlockFilePath(capDir: string): string {
  return join(capDir, "hydra-glm-drainer-quota-blocked-until");
}

/** Cap-file content → count. Missing or non-numeric reads as 0 (bash `^[0-9]+$`). */
export function parseCapCount(raw: string | null): number {
  if (raw === null) return 0;
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number(t) : 0;
}

/**
 * Quota-block-file content → the active block instant, or `null`. `stale` is
 * true when the file exists but is not an active block (non-numeric, or not
 * strictly in the future — bash's `-le`) — the caller deletes it.
 */
export function parseQuotaBlock(
  raw: string | null,
  nowSec: number,
): { until: number | null; stale: boolean } {
  if (raw === null) return { until: null, stale: false };
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) <= nowSec) return { until: null, stale: true };
  return { until: Number(t), stale: false };
}

/** Epoch seconds → `YYYY-MM-DDTHH:MM:SSZ` (the bash `date -u +%Y-%m-%dT%H:%M:%SZ` shape). */
export function epochToIso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// runGate
// ---------------------------------------------------------------------------

export interface GateDeps {
  getAutopilotPaused: () => Promise<{ paused: boolean }>;
  setGlmDrainerHeartbeat: () => Promise<{ ok: boolean; message?: string }>;
  /** File content, or `null` when the file does not exist. */
  readFileIfExists: (path: string) => string | null;
  /** `rm -f`: a missing file is not an error. */
  unlink: (path: string) => void;
  /** Epoch milliseconds. */
  now: () => number;
  config: DrainerConfig;
}

type PauseRead = { paused: boolean; failure?: string };

/** Pause read raced against {@link PAUSE_READ_TIMEOUT_MS}; any failure is paused. */
async function readPause(deps: GateDeps): Promise<PauseRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PauseRead>((res) => {
    timer = setTimeout(
      () => res({ paused: true, failure: `pause read timed out after ${PAUSE_READ_TIMEOUT_MS}ms` }),
      PAUSE_READ_TIMEOUT_MS,
    );
  });
  const read = deps.getAutopilotPaused().then(
    (r): PauseRead => ({ paused: r?.paused === true }),
    (err): PauseRead => {
      logger.warn({ err }, "[glm-gate] pause read rejected — failing safe (treating as paused)");
      return { paused: true, failure: `pause read failed: ${err instanceof Error ? err.message : String(err)}` };
    },
  );
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one gate tick: read the three inputs, decide, and on `able` write the
 * heartbeat (or report `would-write` under dry-run). Never throws — an
 * unexpected fault resolves to `paused`, the fail-closed verdict.
 */
export async function runGate(deps: GateDeps): Promise<GateLine> {
  try {
    return await gateInner(deps);
  } catch (err) {
    logger.error({ err }, "[glm-gate] gate phase threw — failing closed (treating as paused)");
    return {
      able: false,
      reason: "paused",
      detail: `gate fault: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function gateInner(deps: GateDeps): Promise<GateLine> {
  const { config } = deps;
  const nowMs = deps.now();
  const nowSec = Math.floor(nowMs / 1000);

  const pause = await readPause(deps);
  const capCount = parseCapCount(deps.readFileIfExists(capFilePath(config.capDir, nowMs)));
  const quotaPath = quotaBlockFilePath(config.capDir);
  const quota = parseQuotaBlock(deps.readFileIfExists(quotaPath), nowSec);
  if (quota.stale) deps.unlink(quotaPath);

  const verdict = decideGate({
    paused: pause.paused,
    capCount,
    dailyCap: config.dailyCap,
    quotaBlockedUntil: quota.until,
    now: nowSec,
  });

  if (isSkip(verdict)) {
    if (verdict.reason === "paused") {
      return pause.failure
        ? { able: false, reason: "paused", detail: pause.failure }
        : { able: false, reason: "paused" };
    }
    if (verdict.reason === "cap-exhausted") {
      return { able: false, reason: "cap-exhausted", detail: `${capCount}/${config.dailyCap}` };
    }
    return { able: false, reason: "quota-blocked", detail: epochToIso(quota.until as number) };
  }

  // Committed to running this tick: neither paused, cap-exhausted, nor
  // quota-blocked, so the drainer IS "able to author" — heartbeat now.
  if (config.dryRun) return { able: true, heartbeat: "would-write" };
  try {
    const hb = await deps.setGlmDrainerHeartbeat();
    if (hb?.ok === true) return { able: true, heartbeat: "written" };
    const message = hb?.message ?? JSON.stringify(hb);
    logger.warn({ result: hb }, "[glm-gate] heartbeat write failed (tick proceeds)");
    return { able: true, heartbeat: "write-failed", detail: message };
  } catch (err) {
    // A heartbeat failure never blocks authoring (bash write_heartbeat: `return 0`).
    logger.warn({ err }, "[glm-gate] heartbeat write threw (tick proceeds)");
    return {
      able: true,
      heartbeat: "write-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Narrow a verdict to its skip arm — `tsconfig.json` runs `strict: false`, so
 * a plain `if (!verdict.able)` does not narrow a boolean discriminant (same
 * reason as `isDriverFailure` in drainer-driver.ts).
 */
function isSkip(v: GateVerdict): v is Extract<GateVerdict, { able: false }> {
  return v.able === false;
}

// ---------------------------------------------------------------------------
// Default (real) dependencies
// ---------------------------------------------------------------------------

/**
 * The production deps for `env`. A function rather than a module constant so
 * the config is read from the env the driver was handed, never `process.env`
 * at import time (INV-12's `loadDrainerConfig` purity).
 */
export function defaultGateDeps(env: NodeJS.ProcessEnv = process.env): GateDeps {
  return {
    getAutopilotPaused: () => getAutopilotPaused(),
    setGlmDrainerHeartbeat: () => setGlmDrainerHeartbeat(),
    readFileIfExists: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        if ((err as { code?: unknown })?.code !== "ENOENT") {
          logger.error({ err, path }, "[glm-gate] state file unreadable — treating as absent");
        }
        return null;
      }
    },
    unlink: (path) => {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        logger.error({ err, path }, "[glm-gate] stale quota-block file removal failed (non-fatal)");
      }
    },
    now: () => Date.now(),
    config: loadDrainerConfig(env),
  };
}
