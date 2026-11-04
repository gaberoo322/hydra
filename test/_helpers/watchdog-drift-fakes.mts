/**
 * In-memory ports for the slice-4 watchdog checks (issue #5098): deploy drift,
 * skill mirror, redis backup, origin identity. The suites run the real
 * `run*` functions over these fakes — no bash, no PATH shims, no docker, no
 * Redis. Mirrors test/_helpers/launch-flow-fakes.mts.
 */

import type { DriftMarkerPort, SchedulerStopPort } from "../../src/watchdog/drift-gate.ts";
import type { DeployDriftDeps } from "../../src/watchdog/deploy-drift.ts";
import type { SkillMirrorDeps, SyncRun } from "../../src/watchdog/skill-mirror.ts";
import type { OriginIdentityDeps } from "../../src/watchdog/origin-identity.ts";
import type { RedisBackupDeps, NewestBackup } from "../../src/watchdog/redis-backup.ts";
import type { GitConfigRead, FetchOriginResult } from "../../src/github/git.ts";
import type { OperatorMessage } from "../../src/operator-channel/message.ts";
import { memoryEpisodeStore } from "./launch-flow-fakes.mts";

export const NOW_MS = 1_700_000_000_000;
export const NOW_S = NOW_MS / 1000;

export interface FakeMarker extends DriftMarkerPort {
  raw: string | null;
  writes: number[];
}

export function fakeMarker(initial: string | null = null): FakeMarker {
  const m: FakeMarker = {
    raw: initial,
    writes: [],
    read: () => m.raw,
    write(epochS) {
      m.writes.push(epochS);
      m.raw = `${epochS}\n`;
    },
    clear() {
      m.raw = null;
    },
  };
  return m;
}

export function fakeScheduler(stopReason: string | null): SchedulerStopPort & { calls: number } {
  const s = {
    calls: 0,
    async stopReason() {
      s.calls += 1;
      return stopReason;
    },
  };
  return s;
}

export interface DeployDriftHarness {
  deps: DeployDriftDeps;
  logs: string[];
  marker: FakeMarker;
  scheduler: ReturnType<typeof fakeScheduler>;
  deploys: string[];
  state: { hasGit: boolean; deployed: string | null; remote: string | null; deployRc: number | null };
}

export function makeDeployDriftHarness(opts: { marker?: string | null; stopReason?: string | null } = {}): DeployDriftHarness {
  const logs: string[] = [];
  const deploys: string[] = [];
  const marker = fakeMarker(opts.marker ?? null);
  const scheduler = fakeScheduler(opts.stopReason ?? null);
  const state: DeployDriftHarness["state"] = { hasGit: true, deployed: "a".repeat(40), remote: "a".repeat(40), deployRc: 0 };
  const deps: DeployDriftDeps = {
    repo: {
      hasGit: () => state.hasGit,
      deployedSha: async () => state.deployed,
      remoteSha: async () => state.remote,
    },
    marker,
    scheduler,
    host: {
      async deploy(root) {
        deploys.push(root);
        return state.deployRc;
      },
    },
    clock: { nowMs: () => NOW_MS },
    log: (line) => logs.push(line),
  };
  return { deps, logs, marker, scheduler, deploys, state };
}

export interface SkillMirrorHarness {
  deps: SkillMirrorDeps;
  logs: string[];
  marker: FakeMarker;
  scheduler: ReturnType<typeof fakeScheduler>;
  removed: string[];
  resyncs: string[];
  state: {
    scriptExists: boolean;
    scratchOk: boolean;
    regen: SyncRun;
    resync: SyncRun;
    /** Regenerated (scratch) SKILL.md contents by skill name. */
    fresh: Record<string, string>;
    /** Live mirror SKILL.md contents by skill name. */
    live: Record<string, string>;
  };
}

export function makeSkillMirrorHarness(opts: { marker?: string | null; stopReason?: string | null } = {}): SkillMirrorHarness {
  const logs: string[] = [];
  const removed: string[] = [];
  const resyncs: string[] = [];
  const marker = fakeMarker(opts.marker ?? null);
  const scheduler = fakeScheduler(opts.stopReason ?? null);
  const state: SkillMirrorHarness["state"] = {
    scriptExists: true,
    scratchOk: true,
    regen: { ran: true, exitCode: 0, stderrTail: "" },
    resync: { ran: true, exitCode: 0, stderrTail: "" },
    fresh: { demo: "v1" },
    live: { demo: "v1" },
  };
  const deps: SkillMirrorDeps = {
    files: {
      syncScriptExists: () => state.scriptExists,
      makeScratch: () => (state.scratchOk ? "/scratch/x" : null),
      removeScratch: (dir) => removed.push(dir),
      listSkills: (dir) => (dir === "/scratch/x/claude" ? Object.keys(state.fresh).sort() : []),
      readSkill: (dir, name) => (dir === "/scratch/x/claude" ? state.fresh[name] ?? null : state.live[name] ?? null),
    },
    host: {
      regenerate: async () => state.regen,
      async resync(root) {
        resyncs.push(root);
        return state.resync;
      },
    },
    marker,
    scheduler,
    clock: { nowMs: () => NOW_MS },
    log: (line) => logs.push(line),
  };
  return { deps, logs, marker, scheduler, removed, resyncs, state };
}

export interface RedisBackupHarness {
  deps: RedisBackupDeps;
  store: ReturnType<typeof memoryEpisodeStore>;
  logs: string[];
  pages: OperatorMessage[];
  resolves: Array<{ key: string; title?: string }>;
  published: Array<{ stream: string; event: { type: string; source: string; correlationId?: string | null; payload?: unknown } }>;
  state: { newest: NewestBackup | null; timer: string; failPublish: boolean };
}

export function makeRedisBackupHarness(): RedisBackupHarness {
  const store = memoryEpisodeStore();
  const logs: string[] = [];
  const pages: OperatorMessage[] = [];
  const resolves: RedisBackupHarness["resolves"] = [];
  const published: RedisBackupHarness["published"] = [];
  const state: RedisBackupHarness["state"] = { newest: null, timer: "enabled", failPublish: false };
  const deps: RedisBackupDeps = {
    files: { newestBackup: () => state.newest },
    host: { timerState: async () => state.timer },
    store,
    channel: {
      async page(m: OperatorMessage) {
        pages.push(m);
        return { sent: true as const, kind: "page" as const };
      },
      async resolve(key: string, title?: string) {
        resolves.push({ key, title });
        return { sent: true as const, kind: "recovered" as const };
      },
    },
    bus: {
      async publish(stream, event) {
        if (state.failPublish) throw new Error("bus down");
        published.push({ stream, event: event as RedisBackupHarness["published"][number]["event"] });
        return "1-0";
      },
    },
    clock: { nowMs: () => NOW_MS },
    log: (line) => logs.push(line),
  };
  return { deps, store, logs, pages, resolves, published, state };
}

export interface OriginHarness {
  deps: OriginIdentityDeps;
  logs: string[];
  pages: OperatorMessage[];
  resolves: Array<{ key: string; title?: string }>;
  published: Array<{ stream: string; event: { type: string; source: string; correlationId?: string | null; payload: Record<string, unknown> } }>;
  /** Ordered record of every git mutation/fetch the check asked for. */
  gitCalls: string[];
  files: { since: string | null; mtimeMarker: string | null; written: string[] };
  state: {
    stateDirOk: boolean;
    hasGitDir: boolean;
    configMtimeS: number | null;
    /** The origin URL as git reports it: a string, "absent" (exit 1) or an error exit code. */
    url: string | "absent" | { error: number };
    masterPresent: boolean;
    /** What git reports AFTER `setOriginUrl` succeeds (null = it stores exactly what was set). */
    urlAfterSet: string | null;
    setUrlOk: boolean;
    hasRefspec: boolean;
    setRefspecOk: boolean;
    fetch: FetchOriginResult;
    /** Whether a successful fetch makes origin/master resolve. */
    fetchFixesMaster: boolean;
    /** `null` = publish returns a stream id; "empty" = returns null; "throw" = rejects. */
    publish: null | "empty" | "throw";
  };
}

export function makeOriginHarness(): OriginHarness {
  const logs: string[] = [];
  const pages: OperatorMessage[] = [];
  const resolves: OriginHarness["resolves"] = [];
  const published: OriginHarness["published"] = [];
  const gitCalls: string[] = [];
  const files: OriginHarness["files"] = { since: null, mtimeMarker: null, written: [] };
  const state: OriginHarness["state"] = {
    stateDirOk: true,
    hasGitDir: true,
    configMtimeS: null,
    url: "https://github.com/gaberoo322/hydra.git",
    masterPresent: true,
    urlAfterSet: null,
    setUrlOk: true,
    hasRefspec: true,
    setRefspecOk: true,
    fetch: { ok: true, exitCode: 0, timedOut: false, stderr: "" },
    fetchFixesMaster: true,
    publish: null,
  };
  const read = (): GitConfigRead => {
    if (state.url === "absent") return { kind: "absent" };
    if (typeof state.url === "object") return { kind: "error", exitCode: state.url.error, stderr: "boom" };
    return { kind: "value", value: state.url };
  };
  const deps: OriginIdentityDeps = {
    files: {
      ensureStateDir: () => state.stateDirOk,
      configMtimeS: () => state.configMtimeS,
      readMtimeMarker: () => files.mtimeMarker,
      writeMtimeMarker(s) {
        files.mtimeMarker = String(s);
      },
      readSince: () => files.since,
      writeSince(line) {
        files.written.push(line);
        files.since = `${line}\n`;
      },
      clearSince() {
        files.since = null;
      },
      hasGitDir: () => state.hasGitDir,
    },
    git: {
      async readOriginUrl() {
        return read();
      },
      async masterResolves() {
        return state.masterPresent;
      },
      async setOriginUrl(_root, url) {
        gitCalls.push(`set-url ${url}`);
        if (!state.setUrlOk) return false;
        state.url = state.urlAfterSet ?? url;
        return true;
      },
      async hasFetchRefspec() {
        return state.hasRefspec;
      },
      async setFetchRefspec() {
        gitCalls.push("set-refspec");
        if (!state.setRefspecOk) return false;
        state.hasRefspec = true;
        return true;
      },
      async fetchOrigin(_root, timeoutMs) {
        gitCalls.push(`fetch ${timeoutMs}`);
        if (state.fetch.ok && state.fetchFixesMaster) state.masterPresent = true;
        return state.fetch;
      },
    },
    bus: {
      async publish(stream, event) {
        if (state.publish === "throw") throw new Error("bus down");
        published.push({ stream, event: event as OriginHarness["published"][number]["event"] });
        return state.publish === "empty" ? null : "1-0";
      },
    },
    channel: {
      async page(m: OperatorMessage) {
        pages.push(m);
        return { sent: true as const, kind: "page" as const };
      },
      async resolve(key: string, title?: string) {
        resolves.push({ key, title });
        return { sent: true as const, kind: "recovered" as const };
      },
    },
    clock: { nowMs: () => NOW_MS },
    log: (line) => logs.push(line),
  };
  return { deps, logs, pages, resolves, published, gitCalls, files, state };
}
