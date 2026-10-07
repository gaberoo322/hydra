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
} from "./board-saturation.ts";
import { collectRetro, collectTickets, collectWayfinderFrontier, type AfkFrontierDeps } from "./afk-frontier.ts";
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

interface RemainingEntry {
  collect(deps: RemainingDeps): Promise<{ text: string; exports: string | null; degraded: readonly DegradedMarker[] }>;
  /** The lines (and exports) the collector produces when every read failed — also the crash fallback. */
  readonly fallback: { text: string; exports: string | null };
}

function entry<T>(
  collect: (d: RemainingDeps) => Promise<CollectorOutcome<T>>,
  render: (v: T) => string,
  fallback: T,
  exportsOf?: (v: T) => string,
): RemainingEntry {
  return {
    async collect(deps) {
      const o = await collect(deps);
      return { text: render(o.value), exports: exportsOf ? exportsOf(o.value) : null, degraded: o.degraded };
    },
    fallback: { text: render(fallback), exports: exportsOf ? exportsOf(fallback) : null },
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
export const REMAINING_COLLECTORS: Readonly<Record<string, RemainingEntry>> = {
  "redis-queues": entry(collectRedisQueues, renderRedisQueuesKv, { "work-queue": FAILED, "reframe-queue": FAILED, "prior-failures": FAILED }),
  scout: entry(collectScout, renderScoutKv, {
    lastWalkIso: FAILED,
    openEnhancements: FAILED,
    tokensToday: "0",
    spendUsd: "0.00",
    mirrored: FAILED,
  }),
  "arch-cleanup-boards": entry(collectArchCleanupBoards, renderArchCleanupBoardsKv, ARCH_FALLBACK, renderArchExports),
  "hitl-grill": entry(collectHitlGrill, renderHitlGrillKv, FAILED),
  retro: entry(collectRetro, renderRetroKv, { runs: FAILED, drillable: null, bundleFetchFailed: false }),
  "wayfinder-frontier": entry(collectWayfinderFrontier, renderWayfinderKv, { frontier: null, ticketType: "", inflightGlobal: 0 }),
  tickets: entry(collectTickets, renderTicketsKv, FAILED),
};

export function isRemainingCollector(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REMAINING_COLLECTORS, name);
}

export interface RemainingRun {
  readonly stdout: string;
  readonly notes: string[];
  readonly degraded: DegradedMarker[];
  /** The exported shell globals (`KEY=value` lines), or null when no exporting collector ran. */
  readonly exports: string | null;
}

export async function runRemainingCollectors(names: readonly string[], deps: RemainingDeps): Promise<RemainingRun> {
  try {
    const results = await Promise.all(
      names.map(async (name) => {
        const e = REMAINING_COLLECTORS[name] as RemainingEntry;
        try {
          return { ...(await e.collect(deps)), note: null as string | null };
        } catch (err) {
          /* intentional: fail-open — the crash becomes a stderr note plus the collector's fallback lines */
          const msg = err instanceof Error ? err.message : String(err);
          return {
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
    };
  } finally {
    deps.redis.close();
  }
}
