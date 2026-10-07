/**
 * turn-snapshot/render-kv-remaining.ts — the `kv` renderer for the slice-5B
 * collectors (ADR-0043 Decision 4; #4933): redis queues, scout, arch/cleanup
 * boards, hitl-grill, retro, wayfinder frontier, tickets.
 *
 * The ONE place a degraded field turns back into today's fallback line; every
 * line is byte-identical to the collect-state.sh function it replaces (golden
 * files under test/fixtures/turn-snapshot/remaining/), including the retro
 * bundle-fetch-failure quirk (a second `true` line). A sibling of
 * render-kv.ts / render-kv-passthrough.ts so parallel slices never edit one file.
 */

import type { Classified } from "./collector.ts";
import type { ArchBoardsValue, BoardSignals, HitlGrillValue, RedisQueuesValue, ScoutValue } from "./board-saturation.ts";
import { BOARD_SIGNALS_SUPPRESSED } from "./board-saturation.ts";
import type { RetroValue, WayfinderValue } from "./afk-frontier.ts";

const bool = (b: boolean) => (b ? "true" : "false");
const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");
/** `echo -n "k="; redis-cli GET … | tr -d '"' || echo ""` — the raw value (quotes stripped) or empty. */
const redisString = (c: Classified<string | null>) => (c.ok ? (c.value ?? "").replaceAll('"', "") : "");

export function renderRedisQueuesKv(v: RedisQueuesValue): string {
  const n = (c: Classified<number>) => (c.ok ? String(c.value) : "0");
  return lines(
    "backlog_subsystem=retired-adr0031",
    `work_queue=${n(v["work-queue"])}`,
    `reframe_queue=${n(v["reframe-queue"])}`,
    `prior_failures=${n(v["prior-failures"])}`,
  );
}

export function renderScoutKv(v: ScoutValue): string {
  return lines(
    `scout_last_walk_iso=${redisString(v.lastWalkIso)}`,
    `scout_board_open_enhancements=${v.openEnhancements.ok ? v.openEnhancements.value : "0"}`,
    `scout_tokens_today=${v.tokensToday}`,
    `scout_spend_usd_today=${v.spendUsd}`,
  );
}

function boardLines(b: BoardSignals): string[] {
  return [
    `orch_backfill_idle=${bool(b.backfillIdle)}`,
    `arch_board_open_scan=${b.archOpenScan}`,
    `arch_board_open_enhancements=${b.archOpenEnhancements}`,
    `arch_board_saturated=${bool(b.archSaturated)}`,
    `cleanup_board_open_scan=${b.cleanupOpenScan}`,
    `cleanup_board_saturated=${bool(b.cleanupSaturated)}`,
    `skill_prune_board_open=${b.skillPruneOpen}`,
    `skill_prune_board_saturated=${bool(b.skillPruneSaturated)}`,
  ];
}

export function renderArchCleanupBoardsKv(v: ArchBoardsValue): string {
  return lines(
    `arch_last_run_iso=${redisString(v.lastRunIso)}`,
    ...boardLines(v.board.ok ? v.board.value : BOARD_SIGNALS_SUPPRESSED),
    `orch_board_signals_degraded=${bool(v.orchBoardDegraded === "1")}`,
  );
}

/** The globals collect-state.sh reads back after the arch collector (ARCH_WORK_QUEUE feeds the Target scan boards). */
export function renderArchExports(v: ArchBoardsValue): string {
  return lines(`ARCH_WORK_QUEUE=${v.workQueue}`, `ORCH_BOARD_DEGRADED=${v.orchBoardDegraded}`);
}

export function renderHitlGrillKv(v: Classified<HitlGrillValue>): string {
  const x = v.ok ? v.value : { open: 0, saturated: true };
  return lines(`hitl_grill_open=${x.open}`, `hitl_grill_saturated=${bool(x.saturated)}`);
}

export function renderRetroKv(v: RetroValue): string {
  const available = v.runs.ok && v.runs.value.available;
  const drillable = v.drillable === null ? "false" : bool(v.drillable);
  return lines(`retro_run_available=${bool(available)}`, `retro_run_drillable=${drillable}`, ...(v.bundleFetchFailed ? ["true"] : []));
}

export function renderWayfinderKv(v: WayfinderValue): string {
  return lines(
    `wayfinder_orch_frontier=${v.frontier === null ? "none" : `issue-${v.frontier}`}`,
    `wayfinder_orch_ticket_type=${v.ticketType}`,
    `wayfinder_orch_inflight_global=${v.inflightGlobal}`,
  );
}

export function renderTicketsKv(v: Classified<string | null>): string {
  const pick = v.ok ? v.value : null;
  return pick === null
    ? lines("tickets_available=false", "tickets_orch_pending_spec=none")
    : lines("tickets_available=true", `tickets_orch_pending_spec=issue-${pick}`);
}
