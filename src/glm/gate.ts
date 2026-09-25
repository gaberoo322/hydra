/**
 * The GLM dev-drainer's **gate phase** (ADR-0040 Decision 1–3, issue #4682 —
 * the tracer bullet for "TypeScript owns the whole tick").
 *
 * The gate is the tick's admission decision, previously four separate bash
 * steps in `scripts/glm/drainer-loop.sh`'s `main()` (operator pause, daily
 * cap, quota block, heartbeat write). Those three exclusions plus the
 * heartbeat-on-able are ONE verdict, so they moved here together — splitting
 * them across layers is exactly the parity drift ADR-0040 closes.
 *
 * Shape (ADR-0040 Decision 2): a pure `decideGate` core — typed inputs, typed
 * verdict, zero I/O — plus a `runGate` orchestration whose dependencies are
 * injected, so every arm is unit-testable with no live Redis or filesystem.
 *
 * Semantics preserved from the bash it replaces:
 *
 *   - Pause is the operator's durable flag ONLY (ADR-0032 Decision 6): read
 *     through the `getAutopilotPaused()` Redis seam. A REJECTED read is
 *     treated as paused (fail-closed — today's direction, kept); a corrupt
 *     blob reads as not-paused (the seam's own fail-safe, what the HTTP
 *     endpoint returned for that case). Anthropic emergency-stop state is
 *     deliberately ignored.
 *   - The daily cap is exhausted at exactly `capCount >= dailyCap`
 *     (`is_cap_exhausted`'s `-ge`); a missing or non-numeric counter file
 *     reads as 0.
 *   - A quota block is a future-instant epoch file; missing, non-numeric or
 *     past-instant all read as "no block", and a stale file is DELETED on
 *     read — including under dry-run (`quota_blocked_until_epoch`'s
 *     read-side rule, issue #4273: a bad write can never wedge the drainer).
 *   - The heartbeat is written ONLY on able ("able to author", never "the
 *     process ran", ADR-0032 AMENDMENTS #2) and the gate writes it ITSELF:
 *     the verdict and its liveness side-effect belong to one layer.
 */

import { rmSync } from "node:fs";

import { logger } from "../logger.ts";
import { getAutopilotPaused, type AutopilotPauseState } from "../redis/autopilot-pause.ts";
import {
  setGlmDrainerHeartbeat,
  type SetGlmDrainerHeartbeatResult,
} from "../redis/autopilot.ts";
import {
  defaultDrainerConfig,
  dailyCapFilePath,
  epochToIsoUtc,
  quotaBlockFilePath,
  readStateFile,
  todayUtc,
  type DrainerConfig,
} from "./drainer-config.ts";

/** Why a tick was not admitted. */
export type GateReason = "paused" | "cap-exhausted" | "quota-blocked";

/** The pure verdict — no I/O, no clock, fully deterministic. */
export type GateDecision =
  | { able: true }
  | { able: false; reason: GateReason };

/**
 * The gate's decision core. Check order is load-bearing and mirrors the bash
 * `main()` sequence it replaces (paused → cap → quota): when several
 * exclusions hold at once, the operator-visible reason is the FIRST one,
 * exactly as the sequential bash checks reported it.
 */
export function decideGate(input: {
  /** Operator pause flag (already fail-closed/resolved by the caller). */
  paused: boolean;
  /** Today's PR count (missing/unparseable counter file reads as 0). */
  capCount: number;
  /** The configured daily cap. */
  dailyCap: number;
  /** Active quota-block instant in epoch SECONDS, or null when no block. */
  quotaBlockedUntil: number | null;
  /** Now, epoch seconds (injected; never `Date.now()` inside). */
  now: number;
}): GateDecision {
  if (input.paused) {
    return { able: false, reason: "paused" };
  }
  if (input.capCount >= input.dailyCap) {
    return { able: false, reason: "cap-exhausted" };
  }
  if (input.quotaBlockedUntil !== null && input.quotaBlockedUntil > input.now) {
    return { able: false, reason: "quota-blocked" };
  }
  return { able: true };
}

/**
 * The driver-facing result: the verdict plus the detail fields bash needs to
 * compose its (unchanged) skip log lines — `capCount`/`dailyCap` for
 * "daily PR cap reached (N/M)" and a preformatted ISO instant for "quota
 * block active until …" (the bash `epoch_to_iso` helper this slice deletes).
 * Detail fields are present only on their own reason's arm.
 */
export type GateOutcome =
  | { able: true }
  | {
      able: false;
      reason: GateReason;
      /** Present iff `reason === "cap-exhausted"`. */
      capCount?: number;
      /** Present iff `reason === "cap-exhausted"`. */
      dailyCap?: number;
      /** Epoch seconds; present iff `reason === "quota-blocked"`. */
      quotaBlockedUntil?: number;
      /** `YYYY-MM-DDTHH:MM:SSZ`; present iff `reason === "quota-blocked"`. */
      quotaBlockedUntilIso?: string;
    };

/** Injected seam so every arm is unit-testable with no live Redis/fs/clock. */
export interface GateDeps {
  getAutopilotPaused: () => Promise<AutopilotPauseState>;
  setGlmDrainerHeartbeat: (
    nowMs?: number,
  ) => Promise<SetGlmDrainerHeartbeatResult>;
  /** Reads a state file's trimmed contents; "" when missing (ENOENT-shaped). */
  readFile: (path: string) => string;
  /** Deletes a state file; must not throw for a missing file. */
  removeFile: (path: string) => void;
  /** Now in epoch SECONDS. */
  now: () => number;
  config: DrainerConfig;
  /** Operator-facing log line (stderr-shaped; the default is the pino seam). */
  log: (message: string) => void;
}

/** Real dependencies, resolved per call so env overrides are read fresh. */
export function defaultGateDeps(): GateDeps {
  return {
    getAutopilotPaused,
    setGlmDrainerHeartbeat,
    readFile: readStateFile,
    removeFile: (path: string) => {
      rmSync(path, { force: true });
    },
    now: () => Math.floor(Date.now() / 1000),
    config: defaultDrainerConfig(),
    log: (message: string) =>
      logger.info({ component: "glm-drainer/gate" }, message),
  };
}

function isMissingFileError(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === "ENOENT";
}

/**
 * Type guards for the two boolean-discriminated unions below — the
 * orchestrator's tsconfig runs `strict: false`, so a plain `if (!x.ok)` does
 * NOT narrow (mirrors the `isEnvFailure`/`isDriverFailure` pattern documented
 * in `src/glm/drainer-driver.ts` and `src/github/exec.ts`).
 */
function isGateSkip(d: GateDecision): d is Extract<GateDecision, { able: false }> {
  return d.able === false;
}
function isHeartbeatFailure(
  r: SetGlmDrainerHeartbeatResult,
): r is Extract<SetGlmDrainerHeartbeatResult, { ok: false }> {
  return r.ok === false;
}

/**
 * Run the gate: resolve the three inputs (pause flag, cap count, quota
 * block), decide, and — on able — write the heartbeat. Never throws: a
 * rejecting pause read fails closed to paused; a unreadable state file fails
 * open to its "no signal" value (0 / no block), matching the bash read-side
 * rules. The heartbeat write's own failure is logged and does NOT un-able
 * the tick (the bash `write_heartbeat` likewise logged and continued).
 */
export async function runGate(
  overrides: Partial<GateDeps> = {},
): Promise<GateOutcome> {
  const deps = { ...defaultGateDeps(), ...overrides };
  const cfg = deps.config;

  let paused: boolean;
  try {
    paused = (await deps.getAutopilotPaused()).paused;
  } catch (err) {
    // Fail-closed: an unreadable pause flag is treated as paused (the
    // direction the curl-based check had for an unreachable endpoint).
    deps.log(
      `WARN pause read threw — failing safe (treating as paused): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    paused = true;
  }

  const now = deps.now();

  let capCount = 0;
  const capPath = dailyCapFilePath(cfg.capDir, todayUtc(now * 1000));
  try {
    const raw = deps.readFile(capPath);
    if (/^[0-9]+$/.test(raw)) capCount = Number(raw);
  } catch (err) {
    if (!isMissingFileError(err)) {
      deps.log(
        `WARN daily-cap counter unreadable (${capPath}) — reading as 0: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let quotaBlockedUntil: number | null = null;
  const quotaPath = quotaBlockFilePath(cfg.capDir);
  let quotaRaw: string | null = null;
  try {
    quotaRaw = deps.readFile(quotaPath);
  } catch (err) {
    if (!isMissingFileError(err)) {
      deps.log(
        `WARN quota-block file unreadable (${quotaPath}) — reading as no block: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (quotaRaw !== null) {
    const val = Number(quotaRaw);
    if (/^[0-9]+$/.test(quotaRaw) && val > now) {
      quotaBlockedUntil = val;
    } else {
      // Missing-or-stale-or-garbage: no block, and the file is deleted so a
      // bad write can never wedge the drainer (issue #4273 read-side rule).
      // This runs under dry-run too — it is read-side cleanup, not a mutating
      // tick action (the bash it replaces had no DRY_RUN guard here either).
      deps.removeFile(quotaPath);
    }
  }

  const decision = decideGate({
    paused,
    capCount,
    dailyCap: cfg.dailyCap,
    quotaBlockedUntil,
    now,
  });

  if (!isGateSkip(decision)) {
    if (cfg.dryRun) {
      deps.log("would-heartbeat (reason=able, DRY_RUN=1)");
    } else {
      const hb = await deps.setGlmDrainerHeartbeat();
      if (isHeartbeatFailure(hb)) {
        // A failed heartbeat write does not abort the tick — the bash
        // write_heartbeat logged WARN and returned 0; keep that.
        deps.log(`WARN heartbeat write failed (reason=able): ${hb.message}`);
      } else {
        deps.log("heartbeat written (reason=able)");
      }
    }
    return { able: true };
  }

  if (decision.reason === "cap-exhausted") {
    return {
      able: false,
      reason: "cap-exhausted",
      capCount,
      dailyCap: cfg.dailyCap,
    };
  }
  if (decision.reason === "quota-blocked" && quotaBlockedUntil !== null) {
    return {
      able: false,
      reason: "quota-blocked",
      quotaBlockedUntil,
      quotaBlockedUntilIso: epochToIsoUtc(quotaBlockedUntil),
    };
  }
  return { able: false, reason: decision.reason };
}
