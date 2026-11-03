/**
 * In-memory ports for the launch-flow check (issue #5097): an EpisodeStore, a
 * recording Operator Channel, a recording EventBus and a scripted
 * WatchdogGithub, assembled into a LaunchFlowDeps. No Redis, no bash, no
 * spawn — the suites that import this run the real `runLaunchFlow` /
 * `runEpisode` over these fakes.
 */

import type { GlmDrainerLastPick, GlmDrainerLiveness } from "../../src/redis/autopilot.ts";
import { GLM_DRAINER_HEARTBEAT_STALE_MS } from "../../src/redis/autopilot.ts";
import { launchFlowFiredKey, launchFlowSinceKey, type LaunchFlowEpisodeSignal, type PaceGateLastTick } from "../../src/redis/launch-flow.ts";
import type { EpisodeKeyPair, EpisodeStore } from "../../src/watchdog/episode.ts";
import type { LaunchFlowDeps } from "../../src/watchdog/launch-flow.ts";
import type { OperatorMessage } from "../../src/operator-channel/message.ts";

/** Fixed deterministic clock for threshold maths (epoch-ms). */
export const T0 = 1_700_000_000_000;

export interface MemoryStore extends EpisodeStore {
  kv: Map<string, string>;
  /** When true every read throws (an unreachable Redis). */
  failReads: boolean;
  /** Ordered log of mutations, e.g. `anchor:<key>`, `fired:<key>`, `clear:<key>`. */
  writes: string[];
}

export function memoryEpisodeStore(): MemoryStore {
  const kv = new Map<string, string>();
  const store: MemoryStore = {
    kv,
    failReads: false,
    writes: [],
    async anchor(keys: EpisodeKeyPair, nowMs: number) {
      store.writes.push(`anchor:${keys.since}`);
      if (!kv.has(keys.since)) kv.set(keys.since, String(nowMs));
    },
    async readSince(keys: EpisodeKeyPair) {
      if (store.failReads) throw new Error("redis unreachable");
      const raw = kv.get(keys.since);
      return raw === undefined ? null : Number(raw);
    },
    async firedExists(keys: EpisodeKeyPair) {
      if (store.failReads) throw new Error("redis unreachable");
      return kv.has(keys.fired);
    },
    async markFired(keys: EpisodeKeyPair) {
      store.writes.push(`fired:${keys.fired}`);
      kv.set(keys.fired, "1");
    },
    async clear(keys: EpisodeKeyPair) {
      store.writes.push(`clear:${keys.since}`);
      kv.delete(keys.since);
      kv.delete(keys.fired);
    },
  };
  return store;
}

export const sinceOf = (store: MemoryStore, sig: LaunchFlowEpisodeSignal): number | null => {
  const raw = store.kv.get(launchFlowSinceKey(sig));
  return raw === undefined ? null : Number(raw);
};
export const firedOf = (store: MemoryStore, sig: LaunchFlowEpisodeSignal): boolean => store.kv.has(launchFlowFiredKey(sig));
export const seedSince = (store: MemoryStore, sig: LaunchFlowEpisodeSignal, ms: number): void => {
  store.kv.set(launchFlowSinceKey(sig), String(ms));
};
export const seedFired = (store: MemoryStore, sig: LaunchFlowEpisodeSignal): void => {
  store.kv.set(launchFlowFiredKey(sig), "1");
};

export interface Harness {
  deps: LaunchFlowDeps;
  store: MemoryStore;
  logs: string[];
  pages: OperatorMessage[];
  resolves: Array<{ key: string; title?: string }>;
  published: Array<{ stream: string; event: { type: string; source: string; correlationId?: string | null; payload?: unknown } }>;
  ghCalls: number[];
  /** Mutable scenario state. */
  state: {
    tick: PaceGateLastTick | null | "throw";
    heartbeatMs: number | null | "unreadable";
    pick: GlmDrainerLastPick | null;
    drainerPrs: number | null | "throw";
    failPage: boolean;
    failPublish: boolean;
  };
}

export function makeHarness(): Harness {
  const store = memoryEpisodeStore();
  const logs: string[] = [];
  const pages: OperatorMessage[] = [];
  const resolves: Harness["resolves"] = [];
  const published: Harness["published"] = [];
  const ghCalls: number[] = [];
  const state: Harness["state"] = {
    tick: null,
    heartbeatMs: null,
    pick: null,
    drainerPrs: 0,
    failPage: false,
    failPublish: false,
  };
  const deps: LaunchFlowDeps = {
    async lastTick() {
      if (state.tick === "throw") throw new Error("redis unreachable");
      return state.tick;
    },
    store,
    glm: {
      async liveness(nowMs: number): Promise<GlmDrainerLiveness> {
        if (state.heartbeatMs === "unreadable") return { live: false, heartbeatMs: null, reason: "unreadable" };
        if (state.heartbeatMs === null) return { live: false, heartbeatMs: null, reason: "absent" };
        const age = nowMs - state.heartbeatMs;
        return age > GLM_DRAINER_HEARTBEAT_STALE_MS
          ? { live: false, heartbeatMs: state.heartbeatMs, reason: "stale" }
          : { live: true, heartbeatMs: state.heartbeatMs, reason: "fresh" };
      },
      async lastPick() {
        return state.pick;
      },
    },
    github: {
      async countDrainerPrsCreatedSince(windowStartMs: number) {
        ghCalls.push(windowStartMs);
        if (state.drainerPrs === "throw") throw new Error("gh exploded");
        return state.drainerPrs;
      },
    },
    channel: {
      async page(m: OperatorMessage) {
        if (state.failPage) throw new Error("channel down");
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
        published.push({ stream, event: event as Harness["published"][number]["event"] });
        return "1-0";
      },
    },
    clock: { nowMs: () => T0 },
    log: (line) => logs.push(line),
  };
  return { deps, store, logs, pages, resolves, published, ghCalls, state };
}
