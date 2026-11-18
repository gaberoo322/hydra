/**
 * Rank 0 `machine-stopped` lines: ONE aggregate row over the active lines
 * `paused`, `session-blocked`, `scheduler-deliberate`, `sha-drift`. Extracted
 * from src/attention.ts (issue #5615). Reads pause / session-block through the
 * Redis adapters directly, NOT through usage-eligibility (which pulls cost/ in
 * and fails SAFE to "not paused").
 */

import { getAutopilotPaused, type AutopilotPauseState } from "../redis/autopilot-pause.ts";
import { getSessionBlockedUntil } from "../redis/session-block.ts";
import { getStatus as getSchedulerStatus } from "../scheduler/heartbeat.ts";
import { deliberateStopFreshness } from "../scheduler/stop-marker.ts";
import {
  DEPLOY_DRIFT_GRACE_SECONDS,
  readDeployDrift,
  type DeployDriftReading,
} from "../health/deployed-sha.ts";
import { BUCKET_LINES } from "../schemas/operator-actions.ts";
import { logger } from "../logger.ts";
import { settle, type BucketRead, type Draft } from "./draft.ts";

/** Rank-0 injection slice (see AttentionFeedDeps). */
export interface MachineStoppedDeps {
  /** Rank-0 `paused` line read. Default: src/redis/autopilot-pause.ts. */
  readPaused?: () => Promise<AutopilotPauseState>;
  /** Rank-0 `session-blocked` line read (epoch ms, null = none). Default: src/redis/session-block.ts. */
  readSessionBlockedUntil?: () => Promise<number | null>;
  /**
   * Rank-0 `scheduler-deliberate` line read: ONE snapshot of `stopReason` +
   * `deliberateStoppedAt` (never two reads — a torn pair could mix a new
   * reason with a stale stamp). Default: scheduler heartbeat getStatus().
   */
  readSchedulerStop?: () => Promise<SchedulerStopRead>;
  /** Rank-0 `sha-drift` line read. Default: src/health/deployed-sha.ts readDeployDrift(). */
  readShaDrift?: () => Promise<DeployDriftReading>;
}

/** One scheduler-stop snapshot (see {@link MachineStoppedDeps.readSchedulerStop}). */
export interface SchedulerStopRead {
  stopReason: string | null;
  deliberateStoppedAt: string | null;
}

/**
 * Read the four rank-0 lines, each independently settled. A rejected (or
 * UNKNOWN) read names itself in `sourceErrors` — it never reads as "not
 * stopped" (ADR-0034 §5.1/§5.2).
 */
export async function readMachineStopped(
  deps: MachineStoppedDeps,
  nowDate: Date,
): Promise<BucketRead> {
  const readPaused = deps.readPaused ?? getAutopilotPaused;
  const readBlock = deps.readSessionBlockedUntil ?? (() => getSessionBlockedUntil(nowDate.getTime()));
  const readStop =
    deps.readSchedulerStop ??
    (async (): Promise<SchedulerStopRead> => {
      const status = await getSchedulerStatus();
      return {
        stopReason: status.stopReason ?? null,
        deliberateStoppedAt: status.deliberateStoppedAt ?? null,
      };
    });
  const readDrift = deps.readShaDrift ?? (() => readDeployDrift());

  const [pausedR, blockR, stopR, driftR] = await Promise.all([
    settle(readPaused),
    settle(readBlock),
    settle(readStop),
    settle(readDrift),
  ]);

  const sourceErrors: string[] = [];
  let scanned = 0;
  const active = new Map<string, { detail: string; sinceMs: number | null }>();

  if (pausedR.status === "fulfilled") {
    scanned++;
    if (pausedR.value.paused) {
      const since = pausedR.value.since ?? null;
      active.set("paused", {
        detail: since !== null ? `autopilot paused since ${isoOrRaw(since)}` : "autopilot paused",
        sinceMs: since,
      });
    }
  } else {
    logRank0Failure("paused", pausedR.reason);
    sourceErrors.push("paused");
  }

  if (blockR.status === "fulfilled") {
    scanned++;
    if (blockR.value !== null) {
      active.set("session-blocked", {
        detail: `session blocked until ${isoOrRaw(blockR.value)}`,
        sinceMs: null,
      });
    }
  } else {
    logRank0Failure("session-block", blockR.reason);
    sourceErrors.push("session-block");
  }

  if (stopR.status === "fulfilled") {
    scanned++;
    if (stopR.value.stopReason === "deliberate") {
      // A missing or unparseable stamp (fresh === null) is treated as FRESH:
      // the row stays loud while /health yields no verdict and keeps Start
      // disabled (fail closed; issue #5164, ADR-0034 §8.1).
      const { fresh, stoppedAtMs } = deliberateStopFreshness(
        stopR.value.deliberateStoppedAt,
        nowDate.getTime(),
      );
      if (fresh !== false) {
        active.set("scheduler-deliberate", {
          detail: "scheduler stopped deliberately (stopReason=deliberate)",
          sinceMs: stoppedAtMs,
        });
      }
    }
  } else {
    logRank0Failure("scheduler", stopR.reason);
    sourceErrors.push("scheduler");
  }

  if (driftR.status === "fulfilled") {
    const d = driftR.value;
    if (d.deployedSha === null) sourceErrors.push("deployed-sha");
    if (d.originMasterSha === null) sourceErrors.push("origin-master-sha");
    if (d.deployedSha !== null && d.originMasterSha !== null) {
      scanned++;
      if (d.active) {
        active.set("sha-drift", {
          detail:
            `deployed ${d.deployedSha.slice(0, 8)} ≠ origin/master ${d.originMasterSha.slice(0, 8)} ` +
            `for ${d.driftSeconds ?? 0}s (≥ ${DEPLOY_DRIFT_GRACE_SECONDS}s)`,
          sinceMs: d.firstSeenMs,
        });
      }
    }
  } else {
    logRank0Failure("sha-drift", driftR.reason);
    sourceErrors.push("sha-drift");
  }

  // Active lines in BUCKET_LINES['machine-stopped'] order (most upstream first).
  const lines = BUCKET_LINES["machine-stopped"].filter((line) => active.has(line));
  if (lines.length === 0) return { drafts: [], scanned, sourceErrors };

  const subLines = lines.map((line) => ({
    key: `machine-stopped:${line}`,
    line,
    detail: active.get(line)!.detail,
  }));
  const sinceCandidates = lines
    .map((line) => active.get(line)!.sinceMs)
    .filter((ms): ms is number => ms !== null && Number.isFinite(ms));
  const crossedAt =
    sinceCandidates.length > 0
      ? new Date(Math.min(...sinceCandidates)).toISOString()
      : nowDate.toISOString();

  const row: Draft = {
    key: subLines[0].key,
    context: {},
    subLines,
    base: {
      // The §8.4 episode subject: the sorted set of active lines.
      id: `machine-stopped:${[...lines].sort().join(",")}`,
      signal: "blocked-on-human",
      title: `Machine stopped: ${lines.join(", ")}`,
      url: "/health",
      observedValue: lines.length,
      threshold: 1,
      thresholdLabel: `stopped: ${lines.join(", ")}`,
      crossedAt,
      dismissed: false,
    },
  };
  return { drafts: [row], scanned, sourceErrors };
}

function logRank0Failure(source: string, reason: unknown): void {
  logger.error(
    { err: reason, source },
    "[attention] machine-stopped source read failed — rank 0 renders UNKNOWN",
  );
}

function isoOrRaw(ms: number): string {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(ms);
}
