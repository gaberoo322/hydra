/**
 * watchdog/ports.ts — the typed ports of the watchdog CLI checks and their
 * production adapters (issue #5095; ADR-0043 D1: one typed method per read or
 * effect, never a generic exec port). Tests use an in-memory fake that
 * implements the same interfaces — no PATH-shimmed binaries.
 *
 * No `node:child_process` here: systemctl goes through the Host-Probe Adapter,
 * signals through src/process-probe.ts (a syscall, not a binary).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isProbeFailure,
  probeFileLockFree,
  readServiceActiveEnterMonotonicUs,
  readServiceStatus,
  readTopInodeConsumers,
  readUnitEnabledState,
  restartService,
  runDeployScript,
  runSyncSkillsScript,
} from "../host-probe/probe.ts";
import { OperatorChannel, operatorChannel } from "../operator-channel/channel.ts";
import { EventBus } from "../event-bus.ts";
import { getGlmDrainerLiveness, readGlmDrainerLastPick } from "../redis/autopilot.ts";
import { getPaceGateLastTick } from "../redis/launch-flow.ts";
import { readRecentSlotEvents } from "../redis/slot-events.ts";
import {
  anchorEpisodeSince,
  clearEpisodeKeys,
  episodeFiredExists,
  markEpisodeFired,
  readEpisodeSince,
} from "../redis/watchdog-episodes.ts";
import { ghBin, runExec } from "../github/exec.ts";
import { resolveOrchestratorRepo } from "../github/repo.ts";
import { isGlmProvenance } from "../autopilot/turn-snapshot/pr-gate.ts";
import { fetchOrigin, hasGitConfigKey, readGitConfig, refResolves, setGitConfig } from "../github/git.ts";
import { getDeployedSha, getRemoteMasterSha } from "../health/deployed-sha.ts";
import type { LaunchFlowDeps } from "./launch-flow.ts";
import type { DriftMarkerPort, SchedulerStopPort } from "./drift-gate.ts";
import type { DeployDriftDeps } from "./deploy-drift.ts";
import type { SkillMirrorDeps, SyncRun } from "./skill-mirror.ts";
import type { NewestBackup, RedisBackupDeps } from "./redis-backup.ts";
import { ORIGIN_FETCH_REFSPEC, type OriginIdentityDeps } from "./origin-identity.ts";
import type { EpisodeStore } from "./episode.ts";
import type { DiskDeps, StatfsReading } from "./disk.ts";
import { isLivePid, signalPid } from "../process-probe.ts";
import { countOpenBoard } from "../autopilot/turn-snapshot/board-saturation.ts";
import { createTurnSnapshotGithub, type TurnSnapshotGithub } from "../autopilot/turn-snapshot/github-port.ts";
import { pingRedis } from "../redis/utility.ts";
import { closeTurnSnapshotRedis, getAnchorQueueLength, quietTurnSnapshotRedisErrors } from "../redis/turn-snapshot.ts";
import { parseDeliberateStopMarker, readDeliberateStop } from "../scheduler/stop-marker.ts";
import type { DeliberateStopRead, HealthRead, PendingWorkRead, SchedulerRead } from "./liveness.ts";

/** Parsed autopilot state.json: absent, present-without-pid, or the live-candidate pid + run id. */
export type WedgeState = "missing" | "no-pid" | { pid: number; runId: string };

export interface WedgeHost {
  /** `true`/`false` for the unit's active state; `null` when the probe itself failed. */
  serviceActive(unit: string): Promise<boolean | null>;
  pidAlive(pid: number): boolean;
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): boolean;
  sleep(ms: number): Promise<void>;
}

export interface WedgeFiles {
  readStatePid(path: string): WedgeState;
  /** OS-heartbeat epoch seconds (file mtime, as the bash block read it), or `null` when missing/unreadable. */
  heartbeatEpochS(path: string): number | null;
  /** Occupied slots (non-null, bare-hex task_id) of state.json; `[]` when missing/unparseable. */
  readSlotRefs(path: string): WedgeSlotRef[];
}

/** One occupied autopilot slot: the dispatch class and its bare-hex harness task id. */
export interface WedgeSlotRef {
  class: string;
  taskId: string;
}

/** One raw slot-events stream entry (stream id + decoded field map). */
export interface SlotEventRaw {
  id: string;
  fields: Record<string, string>;
}

export interface WedgeSlotEvents {
  /**
   * Newest slot-events entries, or `null` when the read failed / timed out /
   * Redis is down (unknown activity never shields, issue #5349).
   */
  readRecent(): Promise<SlotEventRaw[] | null>;
}

export interface WedgeClock {
  nowEpochS(): number;
}

export interface WedgeDeps {
  host: WedgeHost;
  files: WedgeFiles;
  slotEvents: WedgeSlotEvents;
  clock: WedgeClock;
  log: (line: string) => void;
}

/** Bound on the slot-events read: the wedge tick must never hang on Redis. */
export const SLOT_EVENTS_READ_TIMEOUT_MS = 5000;

/**
 * Occupied slots from state.json text. Pure. Only non-null slot objects whose
 * `task_id` is a bare lowercase-hex harness agent id count (an unstamped slot
 * cannot be joined to the event stream, so it can never shield).
 */
export function parseStateSlots(raw: string): WedgeSlotRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* intentional: unparseable state.json == no occupied slots == nothing can shield */
    return [];
  }
  const slots = (parsed as { slots?: unknown } | null)?.slots;
  if (slots === null || typeof slots !== "object" || Array.isArray(slots)) return [];
  const out: WedgeSlotRef[] = [];
  for (const [cls, slot] of Object.entries(slots as Record<string, unknown>)) {
    if (slot === null || typeof slot !== "object") continue;
    const taskId = (slot as { task_id?: unknown }).task_id;
    if (typeof taskId === "string" && /^[0-9a-f]+$/.test(taskId)) out.push({ class: cls, taskId });
  }
  return out;
}

/** Parse state.json text into a {@link WedgeState}. Pure; unparseable JSON or a non-positive pid is `no-pid`. */
export function parseStatePid(raw: string): WedgeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* intentional: unparseable state.json == no usable pid (bash: jq failure -> "0") */
    return "no-pid";
  }
  const obj = (parsed ?? {}) as { pid?: unknown; run_id?: unknown };
  const pid = Number(obj.pid);
  if (!Number.isInteger(pid) || pid <= 0) return "no-pid";
  const runId = typeof obj.run_id === "string" && obj.run_id ? obj.run_id : "unknown";
  return { pid, runId };
}

/**
 * Heartbeat epoch (seconds) from the file's mtime ONLY — the faithful port of
 * the bash block's `stat -c %Y`. Deliberately NOT readOsHeartbeatEpoch (which
 * prefers an in-file epoch token): this value gates the irreversible SIGKILL,
 * so the age source stays exactly what the bash watchdog used. `null` when the
 * file is missing/unreadable.
 */
export function readHeartbeatMtimeEpoch(path: string): number | null {
  try {
    const mtimeS = Math.floor(statSync(path).mtimeMs / 1000);
    return Number.isFinite(mtimeS) && mtimeS > 0 ? mtimeS : null;
  } catch {
    /* intentional: missing heartbeat file -> age unknown -> decideWedge logs WARN, never kills */
    return null;
  }
}

/**
 * Bounded slot-events read (INV-4): resolves null (shield off) on timeout or
 * reader failure, logging a WARN either way so a Redis hang is distinguishable
 * from an empty stream. Reader and timeout are injectable for tests.
 */
export function createSlotEventsReader<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  log: (line: string) => void,
): () => Promise<T | null> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, timeoutMs);
      });
      const r = await Promise.race([read(), timeout]);
      if (timedOut) log(`hydra-autopilot-watchdog: WARN slot-events read timed out after ${timeoutMs}ms; activity unknown, shield off`);
      return r;
    } catch (err) {
      log(`hydra-autopilot-watchdog: WARN slot-events read failed (${err instanceof Error ? err.message : String(err)}); activity unknown, shield off`);
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

export function createProductionWedgeDeps(log: (line: string) => void): WedgeDeps {
  return {
    host: {
      async serviceActive(unit) {
        const r = await readServiceStatus(unit);
        return r.ok ? r.data === "active" : null;
      },
      pidAlive: (pid) => isLivePid(pid),
      signal: (pid, sig) => signalPid(pid, sig),
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
    files: {
      readStatePid(path) {
        let raw: string;
        try {
          raw = readFileSync(path, "utf8");
        } catch {
          /* intentional: no state file is the expected fresh-boot case */
          return "missing";
        }
        return parseStatePid(raw);
      },
      heartbeatEpochS: (path) => readHeartbeatMtimeEpoch(path),
      readSlotRefs(path) {
        try {
          return parseStateSlots(readFileSync(path, "utf8"));
        } catch {
          /* intentional: unreadable state.json == no occupied slots == nothing can shield */
          return [];
        }
      },
    },
    slotEvents: { readRecent: createSlotEventsReader(readRecentSlotEvents, SLOT_EVENTS_READ_TIMEOUT_MS, log) },
    clock: { nowEpochS: () => Math.floor(Date.now() / 1000) },
    log,
  };
}

// ---------------------------------------------------------------------------
// SERVICE LIVENESS ports (issue #5096)
// ---------------------------------------------------------------------------

export interface LivenessHost {
  /** `true`/`false` for the unit's active state; `null` when the probe itself failed. */
  serviceActive(unit: string): Promise<boolean | null>;
  /** Seconds since the unit's current activation; `null` when either clock read failed. */
  activationAgeS(unit: string): Promise<number | null>;
  /** `true` when another process holds the lock; `null` when the probe failed (fail-open: not held). */
  deployLockHeld(path: string): Promise<boolean | null>;
  restartService(unit: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export interface LivenessHttp {
  health(): Promise<HealthRead>;
  schedulerStatus(): Promise<SchedulerRead>;
  /** POST /api/scheduler/start (NOT a service restart). */
  startScheduler(): Promise<boolean>;
  tunnelReachable(url: string): Promise<boolean>;
}

export interface LivenessRedis {
  ping(): Promise<boolean>;
  deliberateStop(): Promise<DeliberateStopRead>;
  close(): void;
}

export interface LivenessWork {
  pendingWork(): Promise<PendingWorkRead>;
}

export interface LivenessClock {
  nowMs(): number;
}

export interface LivenessDeps {
  host: LivenessHost;
  http: LivenessHttp;
  redis: LivenessRedis;
  work: LivenessWork;
  clock: LivenessClock;
  log: (line: string) => void;
}

const HTTP_TIMEOUT_MS = 5_000;
const REDIS_TIMEOUT_MS = 3_000;

/** Race `p` against a timeout; rejects with `label timed out` so callers fail closed. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** JSON body of a 2xx fetch, or `null` on a transport failure, non-2xx, or unparseable body. */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    return JSON.parse(await res.text());
  } catch {
    /* intentional: a transport/parse failure IS the failed arm of the read; the verdict log names it */
    return null;
  }
}

/** Seconds since boot from /proc/uptime, or `null` when unreadable. */
function readProcUptimeUs(): number | null {
  try {
    const first = readFileSync("/proc/uptime", "utf8").split(/\s+/)[0];
    const s = Number(first);
    return Number.isFinite(s) ? Math.floor(s * 1_000_000) : null;
  } catch {
    /* intentional: unreadable uptime -> activation age unknown -> the grace guard fails open */
    return null;
  }
}

/**
 * Tunnel reachability: ANY completed HTTP response (2xx, 3xx Access redirect,
 * 4xx, 5xx) counts as reachable — the replaced bash `curl -sS` (no `-f`) did
 * the same; only a transport error/timeout (fetch rejects) is unreachable.
 */
export async function probeTunnel(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  await fetchImpl(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "manual" });
  return true;
}

/** `gh issue list --limit` for each per-label pending-work read (the bash limit). */
export const PENDING_WORK_LIST_LIMIT = 100;

export interface PendingWorkDeps {
  github: Pick<TurnSnapshotGithub, "openIssueLabelsWithLabel">;
  readQueue: () => Promise<number>;
  log: (line: string) => void;
}

/**
 * Pending-work signal: ready-for-agent / needs-research / needs-triage are each
 * read with their OWN label-filtered listing (limit 100 each, as the bash did),
 * so a board with >100 unrelated open issues cannot hide actionable ones. A
 * failed read is `ok:false` — "could not read" is never "no work" (#3794).
 */
export async function readPendingWork(deps: PendingWorkDeps): Promise<PendingWorkRead> {
  try {
    const [rfa, research, triage, queue] = await Promise.all([
      deps.github.openIssueLabelsWithLabel("ready-for-agent", PENDING_WORK_LIST_LIMIT),
      deps.github.openIssueLabelsWithLabel("needs-research", PENDING_WORK_LIST_LIMIT),
      deps.github.openIssueLabelsWithLabel("needs-triage", PENDING_WORK_LIST_LIMIT),
      deps.readQueue(),
    ]);
    const a = countOpenBoard(rfa);
    const b = countOpenBoard(research);
    const c = countOpenBoard(triage);
    for (const counts of [a, b, c]) {
      if ("reason" in counts) {
        deps.log(`WARN board read FAILED (${counts.reason}) — cannot prove no work pending`);
        return { ok: false };
      }
    }
    if ("reason" in a || "reason" in b || "reason" in c) return { ok: false };
    return { ok: true, total: a.value.readyForAgent + b.value.needsResearch + c.value.needsTriage + queue };
  } catch (err) {
    deps.log(`WARN work-signal read FAILED: ${err instanceof Error ? err.message : String(err)} — cannot prove no work pending`);
    return { ok: false };
  }
}

export interface LivenessAdapterConfig {
  baseUrl: string;
}

export function createProductionLivenessDeps(
  log: (line: string) => void,
  config: LivenessAdapterConfig,
): LivenessDeps {
  const prefix = "hydra-orchestrator-watchdog:";
  quietTurnSnapshotRedisErrors(() => {
    /* intentional: Redis errors surface as the ping/marker/queue read failing, never as stderr noise */
  });
  const github = createTurnSnapshotGithub();
  return {
    host: {
      async serviceActive(unit) {
        const r = await readServiceStatus(unit);
        if (isProbeFailure(r)) {
          log(`${prefix} WARN systemctl is-active ${unit} failed (${r.code})`);
          return null;
        }
        return r.data === "active";
      },
      async activationAgeS(unit) {
        const r = await readServiceActiveEnterMonotonicUs(unit);
        const nowUs = readProcUptimeUs();
        if (!r.ok || nowUs === null) return null;
        return Math.max(0, Math.floor((nowUs - r.data) / 1_000_000));
      },
      async deployLockHeld(path) {
        const r = await probeFileLockFree(path);
        return r.ok ? r.data.held : null;
      },
      async restartService(unit) {
        return (await restartService(unit)).ok;
      },
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
    http: {
      async health() {
        const body = (await fetchJson(`${config.baseUrl}/api/health`)) as Record<string, unknown> | null;
        if (body === null || typeof body !== "object") return { ok: false };
        return {
          ok: true,
          status: typeof body.status === "string" ? body.status : "",
          redis: body.redis === true,
          uptimeS: Math.floor(Number(body.uptime) || 0),
          cycleRunning: body.cycle === "running",
        };
      },
      async schedulerStatus() {
        const body = (await fetchJson(`${config.baseUrl}/api/scheduler/status`)) as Record<string, unknown> | null;
        if (body === null || typeof body !== "object") return { ok: false };
        const tick = body.lastTickAt;
        return { ok: true, running: body.running === true, lastTickAt: typeof tick === "string" && tick ? tick : null };
      },
      async startScheduler() {
        return (
          (await fetchJson(`${config.baseUrl}/api/scheduler/start`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })) !== null
        );
      },
      async tunnelReachable(url) {
        try {
          return await probeTunnel(url);
        } catch {
          /* intentional: an unreachable tunnel is the verdict input, not an error */
          return false;
        }
      },
    },
    redis: {
      ping: () => withTimeout(pingRedis(), REDIS_TIMEOUT_MS, "redis ping").catch(() => false),
      async deliberateStop() {
        try {
          const raw = await withTimeout(readDeliberateStop(), REDIS_TIMEOUT_MS, "deliberate-stop read");
          return parseDeliberateStopMarker(raw) !== null ? "present" : "absent";
        } catch (err) {
          log(`${prefix} WARN deliberate-stop marker read failed: ${err instanceof Error ? err.message : String(err)}`);
          return "unreadable";
        }
      },
      close: closeTurnSnapshotRedis,
    },
    work: {
      pendingWork: () =>
        readPendingWork({
          github,
          readQueue: () => withTimeout(getAnchorQueueLength("work-queue"), REDIS_TIMEOUT_MS, "work-queue read"),
          log: (line) => log(`${prefix} ${line}`),
        }),
    },
    clock: { nowMs: () => Date.now() },
    log,
  };
}

// ---------------------------------------------------------------------------
// TMPFS EXHAUSTION ports (issue #5327)
// ---------------------------------------------------------------------------

/** `statfs(path)` via the stdlib syscall (no spawn), or `null` when unreadable. */
export function readStatfs(path: string): StatfsReading | null {
  try {
    const s = statfsSync(path);
    return { blocks: s.blocks, bfree: s.bfree, bavail: s.bavail, bsize: s.bsize, files: s.files, ffree: s.ffree };
  } catch {
    /* intentional: an unreadable mount is the verdict input — decideDisk logs WARN and holds the episode */
    return null;
  }
}

export function createProductionDiskDeps(log: (line: string) => void): DiskDeps {
  const channel = new OperatorChannel();
  return {
    statfs: readStatfs,
    async topInodeConsumers(path, limit) {
      const r = await readTopInodeConsumers(path, limit);
      return r.ok ? r.data.map((c) => `${c.path} ${c.inodes}`) : null;
    },
    page: (msg) => channel.page(msg),
    briefOnce: (msg) => channel.briefOnce(msg),
    reminderDue: (key) => channel.reminderDue(key),
    resolve: (key, title) => channel.resolve(key, title),
    isOpen: (key) => channel.isOpen(key),
    clear: (key) => channel.clear(key),
    log,
  };
}

// ---------------------------------------------------------------------------
// LAUNCH FLOW ports (issue #5097)
// ---------------------------------------------------------------------------

/**
 * The watchdog's one typed GitHub read (ADR-0043 D1: one method per read,
 * never a generic gh(args) port).
 */
export interface WatchdogGithub {
  /**
   * Number of drainer (GLM) PRs created at or after `windowStartMs`, or `null`
   * when the query failed or was unparseable (a failed query is not zero).
   */
  countDrainerPrsCreatedSince(windowStartMs: number): Promise<number | null>;
}

/**
 * Pure: count drainer PRs among raw REST `pulls` rows created in the window.
 * The "is this drainer output" predicate is the shared `isGlmProvenance`
 * (issue #4048) — never re-typed. Rows without a parseable `created_at` are
 * not counted. A non-array payload is `null` (a failed measurement).
 */
export function countDrainerPrsInRows(rows: unknown, windowStartMs: number): number | null {
  if (!Array.isArray(rows)) return null;
  let n = 0;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const r = row as { labels?: unknown; head?: { ref?: unknown }; created_at?: unknown };
    const names = new Set<unknown>(
      Array.isArray(r.labels) ? r.labels.map((l) => (l && typeof l === "object" ? (l as { name?: unknown }).name : undefined)) : [],
    );
    if (!isGlmProvenance(names, r.head?.ref ?? "")) continue;
    const created = typeof r.created_at === "string" && r.created_at ? Date.parse(r.created_at) : NaN;
    if (Number.isFinite(created) && created >= windowStartMs) n += 1;
  }
  return n;
}

/** Production adapter: `gh api repos/<repo>/pulls?...` over the exec seam (REST, never GraphQL). */
/** Timeout for the one gh API call a launch-flow tick makes. */
export const GH_EXEC_TIMEOUT_MS = 30_000;

export function createProductionWatchdogGithub(): WatchdogGithub {
  return {
    async countDrainerPrsCreatedSince(windowStartMs) {
      const raw = await runExec(
        ghBin(),
        ["api", `repos/${resolveOrchestratorRepo()}/pulls?state=all&sort=created&direction=desc&per_page=100`],
        { timeout: GH_EXEC_TIMEOUT_MS },
      );
      if (raw.exitCode !== 0 || raw.timedOut || raw.spawnErrorCode) return null;
      try {
        return countDrainerPrsInRows(JSON.parse(raw.stdout), windowStartMs);
      } catch {
        /* intentional: unparseable output is a failed measurement (null); the caller logs the WARN */
        return null;
      }
    },
  };
}

/** Production wiring of the launch-flow ports. The EventBus is constructed on the first fire only. */
export function createProductionLaunchFlowDeps(log: (line: string) => void): LaunchFlowDeps {
  let bus: EventBus | null = null;
  return {
    lastTick: getPaceGateLastTick,
    store: {
      anchor: anchorEpisodeSince,
      readSince: readEpisodeSince,
      firedExists: episodeFiredExists,
      markFired: markEpisodeFired,
      clear: clearEpisodeKeys,
    },
    glm: { liveness: (nowMs) => getGlmDrainerLiveness(nowMs), lastPick: async () => {
        const r = await readGlmDrainerLastPick();
        return r.kind === "ok" ? r.pick : r.kind === "absent" ? null : "unreadable";
      },
    },
    github: createProductionWatchdogGithub(),
    channel: operatorChannel,
    bus: {
      publish: (stream, event) => {
        bus ??= new EventBus();
        return bus.publish(stream, event);
      },
    },
    clock: { nowMs: () => Date.now() },
    log,
  };
}

// ---------------------------------------------------------------------------
// Slice 4 ports (issue #5098): deploy drift, skill mirror, redis backup,
// origin identity. No `node:child_process`: git rides src/github/git.ts, the
// host effects ride src/host-probe/probe.ts.
// ---------------------------------------------------------------------------

/** The production Redis-backed {@link EpisodeStore} (used by redis-backup). */
export function createProductionEpisodeStore(): EpisodeStore {
  return {
    anchor: anchorEpisodeSince,
    readSince: readEpisodeSince,
    firedExists: episodeFiredExists,
    markFired: markEpisodeFired,
    clear: clearEpisodeKeys,
  };
}

function lazyBus(): Pick<EventBus, "publish"> {
  let bus: EventBus | null = null;
  return {
    publish: (stream, event) => {
      bus ??= new EventBus();
      return bus.publish(stream, event);
    },
  };
}

/** An epoch-seconds FILE marker at `path` (same path and format as the bash blocks, INV-6). */
export function createFileDriftMarker(path: string, log: (line: string) => void): DriftMarkerPort {
  return {
    read() {
      try {
        return readFileSync(path, "utf8");
      } catch {
        /* intentional: no marker file == no drift episode in flight */
        return null;
      }
    },
    write(epochS) {
      try {
        writeFileSync(path, `${epochS}\n`);
      } catch (err) {
        log(`WARN could not write drift marker ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    clear() {
      try {
        unlinkSync(path);
      } catch {
        /* intentional: rm -f semantics — an absent marker is already cleared */
      }
    },
  };
}

/** GET /api/scheduler/status (5s bound) -> `stopReason`; `null` when the API is unreachable (does not block). */
export function createSchedulerStopPort(baseUrl: string): SchedulerStopPort {
  return {
    async stopReason() {
      const body = (await fetchJson(`${baseUrl}/api/scheduler/status`)) as Record<string, unknown> | null;
      if (body === null || typeof body !== "object") return null;
      return typeof body.stopReason === "string" && body.stopReason ? body.stopReason : null;
    },
  };
}

export function createProductionDeployDriftDeps(
  log: (line: string) => void,
  config: { markerPath: string; baseUrl: string },
): DeployDriftDeps {
  return {
    repo: {
      hasGit: (root) => existsSync(join(root, ".git")),
      deployedSha: () => getDeployedSha(),
      remoteSha: () => getRemoteMasterSha(),
    },
    marker: createFileDriftMarker(config.markerPath, log),
    scheduler: createSchedulerStopPort(config.baseUrl),
    host: {
      async deploy(root) {
        const r = await runDeployScript(root);
        return r.ok ? r.data.exitCode : null;
      },
    },
    clock: { nowMs: () => Date.now() },
    log,
  };
}

function toSyncRun(r: Awaited<ReturnType<typeof runSyncSkillsScript>>): SyncRun {
  return r.ok ? { ran: true, exitCode: r.data.exitCode, stderrTail: r.data.stderrTail } : { ran: false };
}

export function createProductionSkillMirrorDeps(
  log: (line: string) => void,
  config: { markerPath: string; baseUrl: string },
): SkillMirrorDeps {
  return {
    files: {
      syncScriptExists: (root) => existsSync(join(root, "scripts", "sync-skills.sh")),
      makeScratch() {
        try {
          return mkdtempSync(join(process.env.TMPDIR || tmpdir(), "hydra-skill-mirror-drift."));
        } catch {
          /* intentional: the run logs the WARN for a null scratch dir */
          return null;
        }
      },
      removeScratch(dir) {
        rmSync(dir, { recursive: true, force: true });
      },
      listSkills(dir) {
        try {
          return readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
        } catch {
          /* intentional: a regenerated dir that does not exist has no skills to compare */
          return [];
        }
      },
      readSkill(dir, name) {
        try {
          return readFileSync(join(dir, name, "SKILL.md"), "latin1");
        } catch {
          /* intentional: an absent SKILL.md is the (missing-live) / skip arm */
          return null;
        }
      },
    },
    host: {
      regenerate: async (root, skillsDir) => toSyncRun(await runSyncSkillsScript(root, { skillsDir })),
      resync: async (root) => toSyncRun(await runSyncSkillsScript(root)),
    },
    marker: createFileDriftMarker(config.markerPath, log),
    scheduler: createSchedulerStopPort(config.baseUrl),
    clock: { nowMs: () => Date.now() },
    log,
  };
}

export function createProductionRedisBackupDeps(log: (line: string) => void): RedisBackupDeps {
  return {
    files: {
      newestBackup(dir): NewestBackup | null {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          /* intentional: a missing/unreadable backup dir IS the 'missing' verdict input */
          return null;
        }
        let best: NewestBackup | null = null;
        for (const name of names) {
          if (!/^hydra-redis-.*\.rdb\.gz$/.test(name)) continue;
          try {
            const mtimeS = Math.floor(statSync(join(dir, name)).mtimeMs / 1000);
            if (best === null || mtimeS > best.mtimeS) best = { name, mtimeS };
          } catch {
            /* intentional: a file that vanished between readdir and stat is simply not a candidate */
          }
        }
        return best;
      },
    },
    host: {
      async timerState(unit) {
        const r = await readUnitEnabledState(unit);
        return r.ok ? r.data : "unknown";
      },
    },
    store: createProductionEpisodeStore(),
    channel: operatorChannel,
    bus: lazyBus(),
    clock: { nowMs: () => Date.now() },
    log,
  };
}

export function createProductionOriginIdentityDeps(
  log: (line: string) => void,
  config: { stateDir: string },
): OriginIdentityDeps {
  const sincePath = join(config.stateDir, "hydra-origin-identity.since");
  const mtimePath = join(config.stateDir, "hydra-origin-identity.config-mtime");
  return {
    files: {
      ensureStateDir() {
        try {
          mkdirSync(config.stateDir, { recursive: true });
          return true;
        } catch {
          /* intentional: the run logs the WARN for an unusable state dir */
          return false;
        }
      },
      configMtimeS(root) {
        try {
          const st = statSync(join(root, ".git", "config"));
          return st.isFile() ? Math.floor(st.mtimeMs / 1000) : null;
        } catch {
          /* intentional: no .git/config (worktree gitfile, bare) == no breadcrumb */
          return null;
        }
      },
      readMtimeMarker() {
        try {
          return readFileSync(mtimePath, "utf8");
        } catch {
          /* intentional: first run has no breadcrumb marker */
          return null;
        }
      },
      writeMtimeMarker(mtimeS) {
        try {
          writeFileSync(mtimePath, String(mtimeS));
        } catch (err) {
          log(`WARN could not write ${mtimePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      readSince() {
        try {
          return readFileSync(sincePath, "utf8");
        } catch {
          /* intentional: no since-marker == no alarm episode in flight */
          return null;
        }
      },
      writeSince(line) {
        try {
          writeFileSync(sincePath, `${line}\n`);
        } catch (err) {
          log(`WARN could not write ${sincePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      clearSince() {
        try {
          unlinkSync(sincePath);
        } catch {
          /* intentional: rm -f semantics */
        }
      },
      hasGitDir: (root) => existsSync(join(root, ".git")),
    },
    git: {
      readOriginUrl: (root) => readGitConfig(root, "remote.origin.url"),
      masterResolves: (root) => refResolves(root, "refs/remotes/origin/master"),
      async setOriginUrl(root, url) {
        const r = await setGitConfig(root, "remote.origin.url", url);
        return r.ok;
      },
      hasFetchRefspec: (root) => hasGitConfigKey(root, "remote.origin.fetch"),
      async setFetchRefspec(root) {
        const r = await setGitConfig(root, "remote.origin.fetch", ORIGIN_FETCH_REFSPEC);
        return r.ok;
      },
      fetchOrigin: (root, timeoutMs) => fetchOrigin(root, timeoutMs),
    },
    bus: lazyBus(),
    channel: operatorChannel,
    clock: { nowMs: () => Date.now() },
    log,
  };
}
