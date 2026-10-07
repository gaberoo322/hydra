/**
 * turn-snapshot/remaining.ts — registry + runner for the slice-5B Turn
 * Snapshot collectors (ADR-0043, #4933): `redis-queues`, `scout`,
 * `arch-cleanup-boards`, `hitl-grill` (board-saturation.ts) and `retro`,
 * `wayfinder-frontier`, `tickets` (afk-frontier.ts).
 *
 * The CLI runs a `--collectors` list of these concurrently and concatenates
 * their `kv` text in the given order. A collector that throws is reported as a
 * stderr note and rendered as its full all-reads-failed fallback — the run
 * never throws — and the Redis connection is always released afterwards so
 * the one-shot CLI can exit.
 */

import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import type { TurnSnapshotRedis } from "./redis-port.ts";
import {
  collectArchCleanupBoards,
  collectHitlGrill,
  collectRedisQueues,
  collectScout,
  type ArchBoardsValue,
  type BoardSaturationDeps,
  type HitlGrillValue,
  type RedisQueuesValue,
  type ScoutValue,
} from "./board-saturation.ts";
import {
  collectRetro,
  collectTickets,
  collectWayfinderFrontier,
  type AfkFrontierDeps,
  type RetroValue,
  type WayfinderValue,
} from "./afk-frontier.ts";
import {
  renderArchCleanupBoardsKv,
  renderArchExports,
  renderHitlGrillKv,
  renderRedisQueuesKv,
  renderRetroKv,
  renderScoutKv,
  renderTicketsKv,
  renderWayfinderKv,
} from "./render-kv-remaining.ts";

export interface RemainingDeps extends BoardSaturationDeps, AfkFrontierDeps {
  readonly github: TurnSnapshotGithub;
  /** Only the generic read (the retro runs index + bundle). */
  readonly hydra: Pick<TurnSnapshotHydra, "get">;
  readonly redis: TurnSnapshotRedis;
}

/** Each slice-5B collector's typed value (the JSON Turn Snapshot is built from these, ADR-0043 slice 6). */
export interface RemainingValueMap {
  "redis-queues": RedisQueuesValue;
  scout: ScoutValue;
  "arch-cleanup-boards": ArchBoardsValue;
  "hitl-grill": Classified<HitlGrillValue>;
  retro: RetroValue;
  "wayfinder-frontier": WayfinderValue;
  tickets: Classified<string | null>;
}

export type RemainingName = keyof RemainingValueMap;

interface RemainingEntry<K extends RemainingName = RemainingName> {
  collect(deps: RemainingDeps): Promise<{ text: string; exports: string | null; degraded: readonly DegradedMarker[]; value: RemainingValueMap[K] }>;
  /** The lines (and exports) the collector produces when every read failed — also the crash fallback. */
  readonly fallback: { text: string; exports: string | null; value: RemainingValueMap[K] };
}

function entry<K extends RemainingName>(
  collect: (d: RemainingDeps) => Promise<CollectorOutcome<RemainingValueMap[K]>>,
  render: (v: RemainingValueMap[K]) => string,
  fallback: RemainingValueMap[K],
  exportsOf?: (v: RemainingValueMap[K]) => string,
): RemainingEntry<K> {
  return {
    async collect(deps) {
      const o = await collect(deps);
      return { text: render(o.value), exports: exportsOf ? exportsOf(o.value) : null, degraded: o.degraded, value: o.value };
    },
    fallback: { text: render(fallback), exports: exportsOf ? exportsOf(fallback) : null, value: fallback },
  };
}

const FAILED: Classified<never> = { ok: false, reason: "all-reads-failed" };
/**
 * A crashed arch collector renders the #4130 suppressing defaults and flags the
 * lane degraded; its exported work-queue depth fails CLOSED at 1 so the
 * downstream target_backfill_idle cannot fire on a read that never happened.
 */
const ARCH_FALLBACK: ArchBoardsValue = { lastRunIso: FAILED, workQueue: 1, board: FAILED, orchBoardDegraded: "1" };

/** Collector name → collect + render (the caller's `--collectors` order is the emit order). */
export const REMAINING_COLLECTORS: { readonly [K in RemainingName]: RemainingEntry<K> } = {
  "redis-queues": entry<"redis-queues">(collectRedisQueues, renderRedisQueuesKv, { "work-queue": FAILED, "reframe-queue": FAILED, "prior-failures": FAILED }),
  scout: entry<"scout">(collectScout, renderScoutKv, {
    lastWalkIso: FAILED,
    openEnhancements: FAILED,
    tokensToday: "0",
    spendUsd: "0.00",
    mirrored: FAILED,
  }),
  "arch-cleanup-boards": entry<"arch-cleanup-boards">(collectArchCleanupBoards, renderArchCleanupBoardsKv, ARCH_FALLBACK, renderArchExports),
  "hitl-grill": entry<"hitl-grill">(collectHitlGrill, renderHitlGrillKv, FAILED),
  retro: entry<"retro">(collectRetro, renderRetroKv, { runs: FAILED, drillable: null, bundleFetchFailed: false }),
  "wayfinder-frontier": entry<"wayfinder-frontier">(collectWayfinderFrontier, renderWayfinderKv, { frontier: null, ticketType: "", inflightGlobal: 0 }),
  tickets: entry<"tickets">(collectTickets, renderTicketsKv, FAILED),
};

export function isRemainingCollector(name: string): name is RemainingName {
  return Object.prototype.hasOwnProperty.call(REMAINING_COLLECTORS, name);
}

export interface RemainingRun {
  readonly stdout: string;
  readonly notes: string[];
  readonly degraded: DegradedMarker[];
  /** The exported shell globals (`KEY=value` lines), or null when no exporting collector ran. */
  readonly exports: string | null;
  /** Each collector's typed value (its fallback value when it crashed). */
  readonly values: Partial<RemainingValueMap>;
}

export async function runRemainingCollectors(names: readonly string[], deps: RemainingDeps): Promise<RemainingRun> {
  try {
    const results = await Promise.all(
      names.map(async (name) => {
        const e = REMAINING_COLLECTORS[name as RemainingName] as RemainingEntry;
        try {
          return { name, ...(await e.collect(deps)), note: null as string | null };
        } catch (err) {
          /* intentional: fail-open — the crash becomes a stderr note plus the collector's fallback lines */
          const msg = err instanceof Error ? err.message : String(err);
          return {
            name,
            ...e.fallback,
            degraded: [{ field: name, reason: "collector-crashed" }],
            note: `orch turn-snapshot ${name} collector crashed (${msg}) — emitting its fail-open fallback (issue #4933)`,
          };
        }
      }),
    );
    const exports = results.flatMap((r) => (r.exports === null ? [] : [r.exports]));
    return {
      stdout: results.map((r) => r.text).join(""),
      notes: results.flatMap((r) => (r.note === null ? [] : [r.note])),
      degraded: results.flatMap((r) => [...r.degraded]),
      exports: exports.length === 0 ? null : exports.join(""),
      values: Object.fromEntries(results.map((r) => [r.name, r.value])) as Partial<RemainingValueMap>,
    };
  } finally {
    deps.redis.close();
  }
}
