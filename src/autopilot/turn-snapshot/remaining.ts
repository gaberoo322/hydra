/**
 * turn-snapshot/remaining.ts — registry + runner for the slice-5B Turn
 * Snapshot collectors (ADR-0043, #4933): `redis-queues`, `scout`,
 * `arch-cleanup-boards`, `hitl-grill` (board-saturation.ts) and `retro`,
 * `wayfinder-frontier`, `tickets` (afk-frontier.ts).
 *
 * The CLI runs a list of these concurrently. A collector that throws is
 * reported as a stderr note and returns its full all-reads-failed fallback
 * value — the run never throws — and the Redis connection is always released
 * afterwards so the one-shot CLI can exit.
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
  collect(deps: RemainingDeps): Promise<CollectorOutcome<RemainingValueMap[K]>>;
  /** The typed value when every read failed — also the crash fallback. */
  readonly fallback: RemainingValueMap[K];
}

function entry<K extends RemainingName>(
  collect: (d: RemainingDeps) => Promise<CollectorOutcome<RemainingValueMap[K]>>,
  fallback: RemainingValueMap[K],
): RemainingEntry<K> {
  return { collect, fallback };
}

const FAILED: Classified<never> = { ok: false, reason: "all-reads-failed" };
/**
 * A crashed arch collector returns the #4130 suppressing defaults and flags the
 * lane degraded; its work-queue depth fails CLOSED at 1 so the
 * downstream target_backfill_idle cannot fire on a read that never happened.
 */
const ARCH_FALLBACK: ArchBoardsValue = { lastRunIso: FAILED, workQueue: 1, board: FAILED, orchBoardDegraded: "1" };

/** Collector name → collect + fallback value. */
export const REMAINING_COLLECTORS: { readonly [K in RemainingName]: RemainingEntry<K> } = {
  "redis-queues": entry<"redis-queues">(collectRedisQueues, { "work-queue": FAILED, "reframe-queue": FAILED, "prior-failures": FAILED }),
  scout: entry<"scout">(collectScout, {
    lastWalkIso: FAILED,
    openEnhancements: FAILED,
    tokensToday: "0",
    spendUsd: "0.00",
    mirrored: FAILED,
  }),
  "arch-cleanup-boards": entry<"arch-cleanup-boards">(collectArchCleanupBoards, ARCH_FALLBACK),
  "hitl-grill": entry<"hitl-grill">(collectHitlGrill, FAILED),
  retro: entry<"retro">(collectRetro, { runs: FAILED, drillable: null }),
  "wayfinder-frontier": entry<"wayfinder-frontier">(collectWayfinderFrontier, { frontier: null, ticketType: "", inflightGlobal: 0 }),
  tickets: entry<"tickets">(collectTickets, FAILED),
};

export function isRemainingCollector(name: string): name is RemainingName {
  return Object.prototype.hasOwnProperty.call(REMAINING_COLLECTORS, name);
}

export interface RemainingRun {
  readonly notes: string[];
  readonly degraded: (DegradedMarker & { collector: string })[];
  /** Each collector's typed value (its fallback value when it crashed). */
  readonly values: Partial<RemainingValueMap>;
}

export async function runRemainingCollectors(names: readonly string[], deps: RemainingDeps): Promise<RemainingRun> {
  try {
    const results = await Promise.all(
      names.map(async (name) => {
        const e = REMAINING_COLLECTORS[name as RemainingName] as RemainingEntry;
        try {
          const o = await e.collect(deps);
          return { name, value: o.value, degraded: o.degraded, note: null as string | null };
        } catch (err) {
          /* intentional: fail-open — the crash becomes a stderr note plus the collector's fallback value */
          const msg = err instanceof Error ? err.message : String(err);
          return {
            name,
            value: e.fallback,
            degraded: [{ field: name, reason: "collector-crashed" }],
            note: `orch turn-snapshot ${name} collector crashed (${msg}) — emitting its fail-open fallback (issue #4933)`,
          };
        }
      }),
    );
    return {
      notes: results.flatMap((r) => (r.note === null ? [] : [r.note])),
      degraded: results.flatMap((r) => r.degraded.map((d) => ({ collector: r.name, ...d }))),
      values: Object.fromEntries(results.map((r) => [r.name, r.value])) as Partial<RemainingValueMap>,
    };
  } finally {
    deps.redis.close();
  }
}
