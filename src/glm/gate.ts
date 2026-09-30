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
 *   - a rejected Redis pause read → paused (fail closed);
 *   - a corrupt pause blob → not paused (`getAutopilotPaused` already decides
 *     this, matching what the HTTP endpoint returned);
 *   - a missing / non-numeric cap file → count 0;
 *   - a missing / non-numeric / past quota-block file → no block, and a file
 *     that exists but is not an active block is deleted on read.
 *
 * File-backed state keeps today's `$CAP_DIR` paths and formats (ADR-0040
 * Decision 3) so a live quota block survives the cut-over tick.
 *
 * `runGate` never throws. Dry-run (`HYDRA_GLM_DRAINER_DRY_RUN=1`) still
 * performs the reads — as bash did — but logs `would-heartbeat` instead of
 * writing the heartbeat.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { logger } from "../logger.ts";
import { setGlmDrainerHeartbeat } from "../redis/autopilot.ts";
import { getAutopilotPaused } from "../redis/autopilot-pause.ts";
import { readDrainerConfig, type DrainerConfig } from "./drainer-config.ts";

export type GateReason = "paused" | "cap-exhausted" | "quota-blocked";

export type GateVerdict = { able: true } | { able: false; reason: GateReason };

export interface GateInput {
  paused: boolean;
  capCount: number;
  dailyCap: number;
  /** Epoch seconds, or `null` when no block file is present / parseable. */
  quotaBlockedUntil: number | null;
  /** Epoch seconds. */
  now: number;
}

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

/** Cap-file content → count. Missing or non-numeric reads as 0. */
export function parseCapCount(raw: string | null): number {
  if (raw === null) return 0;
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number(t) : 0;
}

/**
 * Quota-block-file content → the active block instant, or `null`. `stale` is
 * true when the file exists but is not an active block (non-numeric or not in
 * the future) — the caller deletes it.
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

/** Epoch seconds → `YYYY-MM-DDTHH:MM:SSZ` (log formatting only). */
export function epochToIso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// runGate
// ---------------------------------------------------------------------------

export interface GateDeps {
  config: DrainerConfig;
  /** Epoch milliseconds. */
  now: () => number;
  /** Journal line sink (stderr in production). */
  log: (msg: string) => void;
  readPaused: () => Promise<{ paused: boolean }>;
  /** File content, or `null` when the file is absent/unreadable. */
  readFile: (path: string) => string | null;
  removeFile: (path: string) => void;
  writeHeartbeat: () => Promise<{ ok: boolean }>;
}

/**
 * Run one gate tick: read the three inputs, decide, and on `able` write the
 * heartbeat (or log `would-heartbeat` under dry-run). Never throws — an
 * unexpected fault resolves to `paused`, the fail-closed verdict.
 */
export async function runGate(deps: GateDeps): Promise<GateVerdict> {
  try {
    return await gateInner(deps);
  } catch (err) {
    logger.error({ err }, "[glm-gate] gate phase threw — failing closed (treating as paused)");
    return { able: false, reason: "paused" };
  }
}

async function gateInner(deps: GateDeps): Promise<GateVerdict> {
  const { config } = deps;
  const nowMs = deps.now();
  const nowSec = Math.floor(nowMs / 1000);

  let paused: boolean;
  try {
    paused = (await deps.readPaused()).paused === true;
  } catch (err) {
    logger.error({ err }, "[glm-gate] pause read rejected — failing safe (treating as paused)");
    deps.log("WARN pause read failed — failing safe (treating as paused)");
    paused = true;
  }

  const capCount = parseCapCount(deps.readFile(capFilePath(config.capDir, nowMs)));

  const quotaPath = quotaBlockFilePath(config.capDir);
  const quota = parseQuotaBlock(deps.readFile(quotaPath), nowSec);
  if (quota.stale) deps.removeFile(quotaPath);

  const verdict = decideGate({
    paused,
    capCount,
    dailyCap: config.dailyCap,
    quotaBlockedUntil: quota.until,
    now: nowSec,
  });

  if (isSkip(verdict)) {
    if (verdict.reason === "paused") {
      deps.log(
        "operator paused — skip (no heartbeat; kill-switch honors ONLY operator paused, ignoring Anthropic reasons per ADR-0032 Decision 6)",
      );
    } else if (verdict.reason === "cap-exhausted") {
      deps.log(`daily PR cap reached (${capCount}/${config.dailyCap}) — skip (no heartbeat)`);
    } else {
      deps.log(`quota block active until ${epochToIso(quota.until as number)} — skip (no heartbeat)`);
    }
    return verdict;
  }

  // Committed to running this tick: neither paused, cap-exhausted, nor
  // quota-blocked, so the drainer IS "able to author" — heartbeat now.
  if (config.dryRun) {
    deps.log("would-heartbeat (reason=able, DRY_RUN=1)");
    return verdict;
  }
  try {
    const hb = await deps.writeHeartbeat();
    deps.log(hb.ok ? "heartbeat written (reason=able)" : `WARN heartbeat write failed (reason=able): ${JSON.stringify(hb)}`);
  } catch (err) {
    // A heartbeat failure never blocks authoring (bash: `return 0`).
    logger.error({ err }, "[glm-gate] heartbeat write threw (non-fatal)");
    deps.log("WARN heartbeat write failed (reason=able)");
  }
  return verdict;
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

/** Build the production deps from an env (names match what bash read). */
export function buildDefaultGateDeps(env: NodeJS.ProcessEnv = process.env): GateDeps {
  return {
    config: readDrainerConfig(env),
    now: () => Date.now(),
    log: (msg) => {
      process.stderr.write(`hydra-glm-drainer: ${msg}\n`);
    },
    readPaused: () => getAutopilotPaused(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        if ((err as { code?: unknown })?.code !== "ENOENT") {
          logger.error({ err, path }, "[glm-gate] state file unreadable — treating as absent");
        }
        return null;
      }
    },
    removeFile: (path) => {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        logger.error({ err, path }, "[glm-gate] stale quota-block file removal failed (non-fatal)");
      }
    },
    writeHeartbeat: () => setGlmDrainerHeartbeat(),
  };
}
