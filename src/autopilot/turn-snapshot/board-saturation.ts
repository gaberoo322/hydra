/**
 * turn-snapshot/board-saturation.ts — the Redis-queue, scout, arch/cleanup/
 * skill-prune board and hitl-grill inbox Turn Snapshot collectors (ADR-0043
 * slice 5B, #4933). They were collect_redis_queues, collect_scout,
 * collect_arch_cleanup_boards and collect_hitl_grill in collect-state.sh.
 *
 * Reads go through the typed `TurnSnapshotRedis` and `TurnSnapshotGithub`
 * ports; the bash's `--jq` programs and python heredocs are the pure folds
 * below. Semantics carried over verbatim (golden files under
 * test/fixtures/turn-snapshot/remaining/ pin the bytes):
 *
 *   - redis queues (#3478): `backlog_subsystem=retired-adr0031` (the ADR-0031
 *     retired-backlog marker), then `work_queue` / `reframe_queue` /
 *     `prior_failures` — the LLEN of each anchor queue, `0` when unreadable.
 *   - scout (#485, #532): `scout_last_walk_iso` (the calendar-walk stamp, `"`
 *     stripped, empty when unset/unreadable); `scout_board_open_enhancements`
 *     (open `enhancement` issues, `0` on a failed read); today's (UTC)
 *     `hydra-tool-scout` tokens from the by-skill daily hash (a bare
 *     non-negative integer, else `0`), MIRRORED into
 *     `hydra:scout:spend:<DATE>` with a 7d TTL (best effort); and
 *     `scout_spend_usd_today` = tokens/1e6 × HYDRA_TOKEN_USD_RATE as gawk
 *     printed it (`0.00` when either is <= 0; INERT here, #4161).
 *   - arch/cleanup/skill-prune boards (#789, #959, #960, #4130, #4607, #4657):
 *     one open-board read counts ready-for-agent (minus target-backlog),
 *     needs-research, needs-triage, architecture-scan, cleanup-scan,
 *     skill-prune and enhancement issues. `orch_backfill_idle` = the first
 *     three and the work queue all zero; `arch_board_saturated` =
 *     architecture-scan > 6 OR enhancement > 20; cleanup > 10; skill-prune > 3.
 *     A FAILED board read never computes idle from fake zeros: it emits the
 *     suppressing defaults and flips the lane's degraded flag (#4130).
 *     `orch_board_signals_degraded` = that failure OR an earlier orch-board read
 *     failure (collect-state.sh passes its ORCH_BOARD_DEGRADED in).
 *   - hitl-grill (#4391): `hitl_grill_open` + `hitl_grill_saturated` (open >=
 *     10, INCLUSIVE); a failed read saturates (fail closed) with open=0.
 */

import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { GhJsonRead, TurnSnapshotGithub } from "./github-port.ts";
import { JqError, jqEquals, jqField, jqIter, jqLength, jqText } from "./jq-compat.ts";
import { pyFormatFixed } from "./py-format.ts";
import type { AnchorQueueName, TurnSnapshotRedis } from "./redis-port.ts";

export interface BoardSaturationDeps {
  readonly github: TurnSnapshotGithub;
  readonly redis: TurnSnapshotRedis;
  readonly now: () => number;
  readonly ghListLimit: number;
  /** collect-state.sh's ORCH_BOARD_DEGRADED as it stood before this collector (`1` = degraded). */
  readonly orchBoardDegraded: string;
  readonly env: { readonly HYDRA_TOKEN_USD_RATE?: string };
}

export const ARCH_SCAN_LABEL = "architecture-scan";
export const ARCH_BOARD_SATURATION_CAP = 6;
export const ARCH_BOARD_ENHANCEMENT_CAP = 20;
export const CLEANUP_SCAN_LABEL = "cleanup-scan";
export const CLEANUP_BOARD_SATURATION_CAP = 10;
export const SKILL_PRUNE_LABEL = "skill-prune";
export const SKILL_PRUNE_BOARD_SATURATION_CAP = 3;
export const HITL_GRILL_LABEL = "hitl-grill";
export const HITL_GRILL_INBOX_CAP = 10;
export const SCOUT_ENHANCEMENT_LABEL = "enhancement";
/** The scout spend mirror's TTL: 7 days (issue #532). */
export const SCOUT_SPEND_TTL_SECONDS = 604_800;

const fail = <T>(reason: string): Classified<T> => ({ ok: false, reason });
const okv = <T>(value: T): Classified<T> => ({ ok: true, value });
const marker = (field: string, c: Classified<unknown>): DegradedMarker[] => ("reason" in c ? [{ field, reason: c.reason }] : []);
const outcome = <T>(collector: string, value: T, degraded: DegradedMarker[]): CollectorOutcome<T> => ({ collector, value, degraded, notes: [] });

/** A gh read the bash's `--jq` would have run over: data, or why the read failed. */
function ghData(read: GhJsonRead): Classified<unknown> {
  if (read.kind === "ok") return okv(read.data);
  return fail(read.kind === "empty" ? "gh-read-failed" : "unparseable");
}

/** Run a jq-shaped fold; a jq runtime error is the bash's failed (empty) read. */
function jqFold<T>(c: Classified<unknown>, fold: (data: unknown) => T): Classified<T> {
  if ("reason" in c) return fail(c.reason);
  try {
    return okv(fold(c.value));
  } catch (err) {
    if (err instanceof JqError) return fail(`jq: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Redis queues
// ---------------------------------------------------------------------------

export const ANCHOR_QUEUES = ["work-queue", "reframe-queue", "prior-failures"] as const satisfies readonly AnchorQueueName[];

export type RedisQueuesValue = Readonly<Record<AnchorQueueName, Classified<number>>>;

export async function collectRedisQueues(deps: BoardSaturationDeps): Promise<CollectorOutcome<RedisQueuesValue>> {
  const [wq, rq, pf] = await Promise.all(ANCHOR_QUEUES.map((q) => deps.redis.anchorQueueLength(q)));
  const value = { "work-queue": wq, "reframe-queue": rq, "prior-failures": pf } as RedisQueuesValue;
  return outcome("redis-queues", value, ANCHOR_QUEUES.flatMap((q) => marker(q, value[q])));
}

// ---------------------------------------------------------------------------
// Scout
// ---------------------------------------------------------------------------

/**
 * gawk's string→number coercion (`r+0`): the longest leading decimal-float
 * prefix after blanks, else 0; gawk also honours exactly `±inf` / `±nan`.
 */
export function awkNumber(raw: string): number {
  const s = raw.replace(/^[ \t\n\r\f\v]+/, "");
  const special = /^([+-])(inf|nan)$/i.exec(s);
  if (special) {
    if (special[2]?.toLowerCase() === "nan") return special[1] === "-" ? -NaN : NaN;
    return special[1] === "-" ? -Infinity : Infinity;
  }
  const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s);
  return m ? Number(m[0]) : 0;
}

/**
 * `scout_spend_usd_today`: gawk's
 * `if (r+0 <= 0 || t+0 <= 0) "0.00" else printf "%.6f", t/1e6*r`.
 * glibc prints non-finite values as `+inf` / `+nan` / `-nan` under gawk.
 */
export function scoutSpendUsd(tokens: string, rate: string): string {
  const t = awkNumber(tokens);
  const r = awkNumber(rate);
  if (r <= 0 || t <= 0) return "0.00";
  const usd = (t / 1_000_000) * r;
  if (Number.isNaN(usd)) return /^\s*-/.test(rate) ? "-nan" : "+nan";
  if (!Number.isFinite(usd)) return "+inf";
  return pyFormatFixed(usd, 6);
}

/** `redis-cli GET … | tr -d '"'`: the value with every `"` removed (`""` when unset). */
const stripQuotes = (v: string | null): string => (v ?? "").replaceAll('"', "");

/** The scout token count: `$(… | tr -d '"')` then `^[0-9]+$`, else `0`. */
export function scoutTokensValue(read: Classified<string | null>): string {
  const v = read.ok ? stripQuotes(read.value).replace(/\n+$/, "") : "";
  return /^[0-9]+$/.test(v) ? v : "0";
}

export interface ScoutValue {
  readonly lastWalkIso: Classified<string | null>;
  /** The `length` gh printed, or the failed-read `0`. */
  readonly openEnhancements: Classified<string>;
  readonly tokensToday: string;
  readonly spendUsd: string;
  readonly mirrored: Classified<true>;
}

/** `gh … --jq length`, as text, or failed. */
export function foldLength(read: GhJsonRead): Classified<string> {
  return jqFold(ghData(read), (d) => jqText(jqLength(d)));
}

/** UTC `date -u +%Y-%m-%d`. */
export const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function collectScout(deps: BoardSaturationDeps): Promise<CollectorOutcome<ScoutValue>> {
  const date = utcDate(deps.now());
  const [lastWalkIso, enh, tokensRead] = await Promise.all([
    deps.redis.scoutLastCalendarWalk(),
    deps.github.openIssuesWithLabel(SCOUT_ENHANCEMENT_LABEL, deps.ghListLimit),
    deps.redis.scoutTokens(date),
  ]);
  const tokensToday = scoutTokensValue(tokensRead);
  const mirrored = await deps.redis.mirrorScoutSpend(date, tokensToday, SCOUT_SPEND_TTL_SECONDS);
  const openEnhancements = foldLength(enh);
  const value: ScoutValue = {
    lastWalkIso,
    openEnhancements,
    tokensToday,
    spendUsd: scoutSpendUsd(tokensToday, deps.env.HYDRA_TOKEN_USD_RATE || "0"),
    mirrored,
  };
  return outcome("scout", value, [
    ...marker("scoutLastWalkIso", lastWalkIso),
    ...marker("scoutBoardOpenEnhancements", openEnhancements),
    ...marker("scoutTokensToday", tokensRead),
    ...marker("scoutSpendMirror", mirrored),
  ]);
}

// ---------------------------------------------------------------------------
// Arch / cleanup / skill-prune boards
// ---------------------------------------------------------------------------

export interface BoardCounts {
  readonly readyForAgent: number;
  readonly needsResearch: number;
  readonly needsTriage: number;
  readonly archSourced: number;
  readonly cleanupSourced: number;
  readonly skillPruneSourced: number;
  readonly enhancementSourced: number;
}

/** `.labels | map(.name)` of one issue. */
export function labelNames(issue: unknown): unknown[] {
  return jqIter(jqField(issue, "labels")).map((l) => jqField(l, "name"));
}

const has = (names: readonly unknown[], label: string) => names.some((n) => jqEquals(n, label));

/** The bash's single board `--jq` object, over the raw `number,labels` payload. */
export function countOpenBoard(read: GhJsonRead): Classified<BoardCounts> {
  return jqFold(ghData(read), (data) => {
    const boards = jqIter(data).map(labelNames);
    const count = (pred: (n: unknown[]) => boolean) => boards.filter(pred).length;
    return {
      readyForAgent: count((n) => has(n, "ready-for-agent") && !has(n, "target-backlog")),
      needsResearch: count((n) => has(n, "needs-research")),
      needsTriage: count((n) => has(n, "needs-triage")),
      archSourced: count((n) => has(n, ARCH_SCAN_LABEL)),
      cleanupSourced: count((n) => has(n, CLEANUP_SCAN_LABEL)),
      skillPruneSourced: count((n) => has(n, SKILL_PRUNE_LABEL)),
      enhancementSourced: count((n) => has(n, "enhancement")),
    };
  });
}

export interface BoardSignals {
  readonly backfillIdle: boolean;
  readonly archOpenScan: number;
  readonly archOpenEnhancements: number;
  readonly archSaturated: boolean;
  readonly cleanupOpenScan: number;
  readonly cleanupSaturated: boolean;
  readonly skillPruneOpen: number;
  readonly skillPruneSaturated: boolean;
}

/** The python emitter: idle / saturation verdicts from the counts and the work queue. */
export function foldBoardSignals(c: BoardCounts, workQueue: number): BoardSignals {
  return {
    backfillIdle: c.readyForAgent === 0 && c.needsResearch === 0 && c.needsTriage === 0 && workQueue === 0,
    archOpenScan: c.archSourced,
    archOpenEnhancements: c.enhancementSourced,
    archSaturated: c.archSourced > ARCH_BOARD_SATURATION_CAP || c.enhancementSourced > ARCH_BOARD_ENHANCEMENT_CAP,
    cleanupOpenScan: c.cleanupSourced,
    cleanupSaturated: c.cleanupSourced > CLEANUP_BOARD_SATURATION_CAP,
    skillPruneOpen: c.skillPruneSourced,
    skillPruneSaturated: c.skillPruneSourced > SKILL_PRUNE_BOARD_SATURATION_CAP,
  };
}

/** The suppressing defaults a failed board read emits (#4130): never idle, never saturated. */
export const BOARD_SIGNALS_SUPPRESSED: BoardSignals = {
  backfillIdle: false,
  archOpenScan: 0,
  archOpenEnhancements: 0,
  archSaturated: false,
  cleanupOpenScan: 0,
  cleanupSaturated: false,
  skillPruneOpen: 0,
  skillPruneSaturated: false,
};

export interface ArchBoardsValue {
  readonly lastRunIso: Classified<string | null>;
  /** The work-queue depth the idle verdict used (0 when unreadable) — exported as ARCH_WORK_QUEUE. */
  readonly workQueue: number;
  readonly board: Classified<BoardSignals>;
  /** ORCH_BOARD_DEGRADED after this collector: `1` when the board read failed, else the value passed in. */
  readonly orchBoardDegraded: string;
}

export async function collectArchCleanupBoards(deps: BoardSaturationDeps): Promise<CollectorOutcome<ArchBoardsValue>> {
  const [boardRead, wq, lastRunIso] = await Promise.all([
    deps.github.openIssueLabels(deps.ghListLimit),
    deps.redis.anchorQueueLength("work-queue"),
    deps.redis.architectureLastRun(),
  ]);
  const workQueue = wq.ok ? wq.value : 0;
  const counts = countOpenBoard(boardRead);
  const board: Classified<BoardSignals> = "reason" in counts ? fail(counts.reason) : okv(foldBoardSignals(counts.value, workQueue));
  const value: ArchBoardsValue = { lastRunIso, workQueue, board, orchBoardDegraded: board.ok ? deps.orchBoardDegraded : "1" };
  return outcome("arch-cleanup-boards", value, [...marker("orchBoard", board), ...marker("workQueue", wq), ...marker("archLastRunIso", lastRunIso)]);
}

// ---------------------------------------------------------------------------
// hitl-grill inbox
// ---------------------------------------------------------------------------

export interface HitlGrillValue {
  readonly open: number;
  readonly saturated: boolean;
}

/** Python `int(raw)` over the printed length: a failed or non-integer read saturates with open=0. */
export function foldHitlGrill(read: GhJsonRead): Classified<HitlGrillValue> {
  const len = foldLength(read);
  if ("reason" in len) return fail(len.reason);
  if (!/^[0-9]+$/.test(len.value)) return fail("non-integer-count");
  const open = Number(len.value);
  return okv({ open, saturated: open >= HITL_GRILL_INBOX_CAP });
}

export async function collectHitlGrill(deps: BoardSaturationDeps): Promise<CollectorOutcome<Classified<HitlGrillValue>>> {
  const inbox = foldHitlGrill(await deps.github.openIssuesWithLabel(HITL_GRILL_LABEL, deps.ghListLimit));
  return outcome("hitl-grill", inbox, marker("hitlGrill", inbox));
}
