/**
 * Class-state backend — the composition behind GET /api/autopilot/class-state
 * (issue #4635, ADR-0034 §9.2 / PR #4617).
 *
 * One row per Dispatch-Class Taxonomy class, plus a header of the global
 * gates, answering the operator's per-class panel question: *what is every
 * autopilot class doing right now, and why?*
 *
 *   - taxonomy (kind, scope, cooldown, skill) — `src/taxonomy/classes.ts`
 *     re-exporting classes.json (the single alphabet).
 *   - last-fired — max(the `hydra:autopilot:signal-last-fired` hash, the
 *     latest turn's signals_snapshot) per class. The hash is mirrored only
 *     at reap time (reap_state.py), so it lags a live dispatch; the
 *     snapshot carries the dispatch-time stamp. NEVER demoted by run state
 *     or verdict freshness (§9.2).
 *   - cooldown remaining — server-computed from last-fired + the class's
 *     cooldownSeconds.
 *   - verdict + freshness — the latest turn's persisted `decisions` map
 *     (heartbeat.py folds decide.py's dispatch_decision events onto the
 *     turn row, #4635 INV-1); fresh within a 15-minute budget, stale
 *     (verdict retained) beyond it, UNKNOWN with no active run, and
 *     not-evaluated for a class decide.py did not consider.
 *   - slot occupant — the latest turn's slots_snapshot for pipeline rows,
 *     sharing the verdict's freshness so it agrees with a "slot busy"
 *     verdict reason.
 *   - starved — outcome budget/stagger for >= PROMOTION_THRESHOLD
 *     consecutive turns; a turn where the global gate blocked every class
 *     never counts (transparent), nor does a stale-plan turn.
 *   - dead — static: every selector trigger of the class is a producerless
 *     signal (`./producerless-signals.ts`).
 *
 * NEVER THROWS (INV-13): `composeClassState` is pure; `readClassState`
 * takes injectable deps, degrades every failed source to null / 'unknown'
 * + a `header.degraded` entry, and the route always answers 200 with that
 * envelope — never a 0, [] or 'none' standing in for unknown (ADR-0034 §5
 * trust contract).
 */

import { DISPATCH_CLASSES } from "../taxonomy/classes.ts";
import type { DispatchClassRow } from "../taxonomy/classes.ts";
import { PROMOTION_THRESHOLD } from "../pattern-memory/constants.ts";
import { deadClassification } from "./producerless-signals.ts";
// Type-only edges (erased at runtime — no write-module coupling):
// `TurnDecision` is the sanitised per-class decision recordTurn persists
// (issue #4635 INV-2); `GetCurrentLifecycleResult` / `GetRunRowResult` are
// the reader result shapes the injectable deps default to.
import type { TurnDecision } from "./runs.ts";
import type { GetCurrentLifecycleResult, GetRunRowResult } from "./run-reads.ts";
import type { AutopilotLifecycle } from "./run-lifecycle-state.ts";
import { getCurrentLifecycle, getRunRow } from "./run-reads.ts";
import { listAutopilotRunTurnsDesc } from "../redis/autopilot-runs.ts";
import { getSignalLastFired } from "../redis/autopilot-signals.ts";
import type { GetSignalLastFiredResult } from "../redis/autopilot-signals.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Constants (§9.2)
// ---------------------------------------------------------------------------

/**
 * A verdict older than this is `stale` (retained, with `verdictAsOf`)
 * rather than `fresh`. 15 minutes covers the longest legitimate
 * decision-turn duration (a hydra-dev dispatch's slow path) — the same
 * budget the heartbeat wedge-detection threshold uses.
 */
export const VERDICT_FRESHNESS_BUDGET_SECONDS = 900;

/**
 * Bound on the newest-first turn walk that counts a starvation streak.
 * Generously beyond a 3-turn threshold's plausible backfill window;
 * bounded so a pathological run cannot make the read unbounded.
 */
export const STARVED_LOOKBACK_TURNS = 50;

// ---------------------------------------------------------------------------
// Types — the response envelope (INV-12)
// ---------------------------------------------------------------------------

/** One parsed, already-sanitised turn member (shape recordTurn persists). */
export interface ClassStateTurn {
  turn_n: number;
  epoch: number;
  /** Folded {class: {outcome, reason}} from plan.events; absent = no information. */
  decisions?: Record<string, TurnDecision>;
  burned_classes?: string[];
  usage_shed?: string[];
  usage_allow?: boolean;
  slots_snapshot?: Record<string, unknown>;
  signals_snapshot?: Record<string, unknown>;
}

/** Per-row verdict freshness. `unknown` = no active run / no decisions on the latest turn. */
export type RowFreshness = "fresh" | "stale" | "unknown" | "not-evaluated";

export interface ClassStateVerdict {
  outcome: string;
  reason: string;
  turnN: number;
}

export interface ClassStateRow {
  name: string;
  kind: DispatchClassRow["kind"];
  scope: DispatchClassRow["scope"];
  /** classes.json's value as-is (#4636 owns making it authoritative). */
  skill: string;
  cooldownSeconds: number | null;
  lastFiredEpoch: number | null;
  cooldownRemainingSeconds: number | null;
  verdict: ClassStateVerdict | null;
  verdictFreshness: RowFreshness;
  /** Pipeline rows only; omitted entirely when freshness is 'unknown'. */
  slotOccupant?: unknown;
  /** null whenever verdictFreshness is 'unknown' (no active run / no decisions). */
  starved: boolean | null;
  dead: boolean;
  deadReason?: string;
}

export interface ClassStateHeader {
  run: {
    runId: string;
    lifecycle: AutopilotLifecycle["state"];
    latestTurnN: number | null;
    latestTurnEpoch: number | null;
  } | null;
  scope: string | null;
  usage: { allow: boolean; shed: string[] } | null;
  burnedClasses: string[] | null;
  quotaDeltaCap: { fiveHourMaxPts: number; weekMaxPts: number } | null;
  verdictFreshness: "fresh" | "stale" | "unknown";
  verdictAsOf: string | null;
  degraded: string[];
}

export interface ClassStateResponse {
  header: ClassStateHeader;
  classes: ClassStateRow[];
  /** == classes.length (the #4630 {…, scanned, generatedAt} list convention). */
  scanned: number;
  generatedAt: string;
}

/** composeClassState inputs — every source pre-read; null = failed/absent. */
export interface ClassStateInputs {
  taxonomy: readonly DispatchClassRow[];
  /** Parsed last-fired hash; null = the Redis read failed. */
  lastFired: Record<string, number> | null;
  /** Lifecycle of the most-recent run; null = the read failed. */
  lifecycle: AutopilotLifecycle | null;
  /** Raw run hash of that run (limits JSON lives here); null = unreadable. */
  runRow: Record<string, string> | null;
  /** Parsed turn members, NEWEST-FIRST; null = the read failed. */
  turns: readonly ClassStateTurn[] | null;
}

// ---------------------------------------------------------------------------
// Pure composition (INV-13) — no I/O, `now` injected
// ---------------------------------------------------------------------------

/**
 * Read a positive-integer epoch off a signals_snapshot field, or null.
 * Snapshot values are state.json's signal_last_fired epochs (numbers);
 * anything else is "no value" (never a fabricated 0).
 */
function snapshotEpoch(turn: ClassStateTurn | null, className: string): number | null {
  if (!turn?.signals_snapshot) return null;
  const raw = turn.signals_snapshot[className];
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Count the consecutive budget/stagger outcomes for `className`, walking
 * newest-first (INV-8). A turn is TRANSPARENT — skipped, neither counting
 * nor breaking — when it lacks decisions, its decisions map is empty (a
 * stale-plan turn), or usage_allow === false (the global gate blocked
 * every class; §9.2 "never counts"). Any other outcome, or the class
 * being absent from that turn's decisions, ends the walk.
 */
function starvationStreak(turns: readonly ClassStateTurn[], className: string): number {
  let streak = 0;
  const bounded = turns.slice(0, STARVED_LOOKBACK_TURNS);
  for (const turn of bounded) {
    const decisions = turn.decisions;
    if (
      decisions === undefined ||
      Object.keys(decisions).length === 0 ||
      turn.usage_allow === false
    ) {
      continue; // transparent
    }
    const verdict = decisions[className];
    if (verdict === undefined) break;
    if (verdict.outcome === "budget" || verdict.outcome === "stagger") {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Compose the full class-state envelope. Pure: every source arrives
 * pre-read (null = failed), `nowMs` is injected, nothing throws. See the
 * module header for the per-field semantics (ADR-0034 §9.2 / #4635).
 */
export function composeClassState(
  inputs: ClassStateInputs,
  nowMs: number,
): ClassStateResponse {
  const nowEpoch = Math.floor(nowMs / 1000);
  const degraded: string[] = [];
  if (inputs.lastFired === null) degraded.push("last-fired");
  if (inputs.lifecycle === null) degraded.push("lifecycle");

  const runId = inputs.lifecycle?.run_id ?? null;
  const turns = inputs.turns ?? [];
  const latest = turns.length > 0 ? (turns[0] as ClassStateTurn) : null;
  // A run we know exists whose run hash could not be read is a source
  // failure (scope/quota fields degrade); with no run at all there is
  // simply nothing to read.
  if (runId !== null && inputs.runRow === null) degraded.push("run-row");
  if (runId !== null && inputs.turns === null) degraded.push("turns");

  const active = inputs.lifecycle?.state === "running";

  // header.run — the most-recent run's identity + its latest turn marker.
  const headerRun =
    runId !== null && inputs.lifecycle !== null
      ? {
          runId,
          lifecycle: inputs.lifecycle.state,
          latestTurnN: latest !== null ? latest.turn_n : null,
          latestTurnEpoch: latest !== null ? latest.epoch : null,
        }
      : null;

  // scope + quotaDeltaCap from the run hash's limits JSON (bootstrap.sh's
  // run-start POST; no new write — the design concept's glossary note).
  let scope: string | null = null;
  let quotaDeltaCap: { fiveHourMaxPts: number; weekMaxPts: number } | null = null;
  if (inputs.runRow !== null) {
    const rawLimits = inputs.runRow.limits;
    if (typeof rawLimits === "string" && rawLimits.length > 0) {
      try {
        const limits = JSON.parse(rawLimits) as Record<string, unknown>;
        if (limits && typeof limits === "object" && typeof limits.scope === "string") {
          scope = limits.scope;
        }
        const q5 = (limits as Record<string, unknown>).quota_5h_max_pts;
        const qw = (limits as Record<string, unknown>).quota_week_max_pts;
        if (typeof q5 === "number" && typeof qw === "number") {
          quotaDeltaCap = { fiveHourMaxPts: q5, weekMaxPts: qw };
        }
      } catch (err: any) {
        // Present but unparseable — a run-row source failure. Named loud via
        // both channels: `degraded` in the response envelope for the
        // operator-facing surface, and logger.error here so a corrupted
        // `limits` field also lands in journalctl/stderr (CLAUDE.md fail-loud
        // rule — every catch logs or is annotated intentional).
        logger.error(
          { err, runId },
          "[autopilot/class-state] composeClassState: run-row limits JSON.parse failed",
        );
        degraded.push("run-row");
      }
    }
  }

  // usage + burnedClasses from the latest turn — null when absent or no
  // active run (INV-12). usage_allow is only ever false on a blocked turn;
  // an absent field fail-OPENS (decide.py treats missing usage payloads as
  // "no signal"), matching the reader-side convention.
  const usage =
    active && latest !== null
      ? { allow: latest.usage_allow !== false, shed: latest.usage_shed ?? [] }
      : null;
  const burnedClasses = active && latest !== null ? (latest.burned_classes ?? null) : null;

  // Header-level freshness: the latest turn's decisions age when there is
  // an active run carrying them; anything else is unknown.
  let verdictFreshness: ClassStateHeader["verdictFreshness"] = "unknown";
  let verdictAsOf: string | null = null;
  if (active && latest !== null && latest.decisions !== undefined) {
    verdictFreshness =
      nowEpoch - latest.epoch <= VERDICT_FRESHNESS_BUDGET_SECONDS ? "fresh" : "stale";
    verdictAsOf = new Date(latest.epoch * 1000).toISOString();
  }

  const classes: ClassStateRow[] = inputs.taxonomy.map((row) => {
    // last-fired: max(hash, latest snapshot) over readable sources — the
    // hash is reboot-survivable but lags a live dispatch; the snapshot is
    // the loop's own dispatch-time view. Never demoted by run state.
    const hashEpoch = inputs.lastFired?.[row.name] ?? null;
    const snapEpoch = snapshotEpoch(latest, row.name);
    const candidates = [hashEpoch, snapEpoch].filter((e): e is number => e !== null);
    const lastFiredEpoch = candidates.length > 0 ? Math.max(...candidates) : null;

    // Cooldown remaining (INV-6): pipeline classes (null cooldown) report
    // null; a never-fired signal class reads 0 (fully cooled).
    const cooldownRemainingSeconds =
      row.cooldownSeconds === null
        ? null
        : lastFiredEpoch === null
          ? 0
          : Math.max(0, lastFiredEpoch + row.cooldownSeconds - nowEpoch);

    // Verdict + freshness (INV-7).
    let verdict: ClassStateVerdict | null = null;
    let rowFreshness: RowFreshness = "unknown";
    if (active && latest !== null && latest.decisions !== undefined) {
      const d = latest.decisions[row.name];
      if (d === undefined) {
        rowFreshness = "not-evaluated";
      } else {
        verdict = { outcome: d.outcome, reason: d.reason, turnN: latest.turn_n };
        rowFreshness =
          nowEpoch - latest.epoch <= VERDICT_FRESHNESS_BUDGET_SECONDS ? "fresh" : "stale";
      }
    }

    // Starved (INV-8): null whenever freshness is unknown.
    const starved =
      rowFreshness === "unknown"
        ? null
        : starvationStreak(turns, row.name) >= PROMOTION_THRESHOLD;

    // Dead (INV-9): static, independent of run state.
    const deadResult = deadClassification(row.name);

    const out: ClassStateRow = {
      name: row.name,
      kind: row.kind,
      scope: row.scope,
      skill: row.skill,
      cooldownSeconds: row.cooldownSeconds,
      lastFiredEpoch,
      cooldownRemainingSeconds,
      verdict,
      verdictFreshness: rowFreshness,
      ...(row.kind === "pipeline" && rowFreshness !== "unknown"
        ? {
            // INV-11: latest turn's slots_snapshot verbatim (null = free),
            // under the verdict's freshness — omitted when unknown, and
            // signal rows never carry it.
            slotOccupant: latest?.slots_snapshot?.[row.name] ?? null,
          }
        : {}),
      starved,
      dead: deadResult.dead,
      ...(deadResult.deadReason !== null ? { deadReason: deadResult.deadReason } : {}),
    };
    return out;
  });

  return {
    header: {
      run: headerRun,
      scope,
      usage,
      burnedClasses,
      quotaDeltaCap,
      verdictFreshness,
      verdictAsOf,
      degraded,
    },
    classes,
    scanned: classes.length,
    generatedAt: new Date(nowMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reader — injectable deps over the real accessors (INV-13)
// ---------------------------------------------------------------------------

/** Injectable deps for {@link readClassState} (tests stub each source). */
export interface ClassStateReaderDeps {
  getSignalLastFired: () => Promise<GetSignalLastFiredResult>;
  getCurrentLifecycle: () => Promise<GetCurrentLifecycleResult>;
  getRunRow: (runId: string) => Promise<GetRunRowResult>;
  listTurnsDesc: (runId: string, limit: number) => Promise<string[]>;
  now: () => number;
}

const defaultClassStateReaderDeps: ClassStateReaderDeps = {
  getSignalLastFired,
  getCurrentLifecycle,
  getRunRow,
  listTurnsDesc: listAutopilotRunTurnsDesc,
  now: Date.now,
};

/**
 * Parse one persisted turn member into the composition's turn shape.
 * Pure; null for an unparseable/wrong-shaped member (the caller logs +
 * skips — the #3744 reader-guard pattern). Fields already sanitised by
 * recordTurn are re-guarded here so a direct Redis writer cannot smuggle
 * a malformed verdict into the composition.
 */
function parseTurnMember(member: string): ClassStateTurn | null {
  let raw: unknown;
  try {
    raw = JSON.parse(member);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.turn_n !== "number" || typeof t.epoch !== "number") return null;

  const turn: ClassStateTurn = { turn_n: t.turn_n, epoch: t.epoch };
  if (t.decisions && typeof t.decisions === "object" && !Array.isArray(t.decisions)) {
    const kept: Record<string, TurnDecision> = {};
    for (const [cls, val] of Object.entries(t.decisions as Record<string, unknown>)) {
      if (
        val &&
        typeof val === "object" &&
        typeof (val as Record<string, unknown>).outcome === "string" &&
        typeof (val as Record<string, unknown>).reason === "string"
      ) {
        kept[cls] = {
          outcome: (val as { outcome: string }).outcome,
          reason: (val as { reason: string }).reason,
        };
      }
    }
    turn.decisions = kept;
  }
  if (Array.isArray(t.burned_classes)) {
    turn.burned_classes = t.burned_classes.filter((s): s is string => typeof s === "string");
  }
  if (Array.isArray(t.usage_shed)) {
    turn.usage_shed = t.usage_shed.filter((s): s is string => typeof s === "string");
  }
  if (typeof t.usage_allow === "boolean") turn.usage_allow = t.usage_allow;
  if (t.slots_snapshot && typeof t.slots_snapshot === "object" && !Array.isArray(t.slots_snapshot)) {
    turn.slots_snapshot = t.slots_snapshot as Record<string, unknown>;
  }
  if (
    t.signals_snapshot &&
    typeof t.signals_snapshot === "object" &&
    !Array.isArray(t.signals_snapshot)
  ) {
    turn.signals_snapshot = t.signals_snapshot as Record<string, unknown>;
  }
  return turn;
}

/**
 * Read every source and compose the class-state envelope. NEVER THROWS:
 * each failed source degrades to null/'unknown' and is named in
 * `header.degraded`; an unexpected failure of the whole orchestration is
 * caught and answered with a fully-degraded envelope (all sources named)
 * so the route can always answer 200.
 */
export async function readClassState(
  deps: ClassStateReaderDeps = defaultClassStateReaderDeps,
): Promise<ClassStateResponse> {
  let lastFired: Record<string, number> | null = null;
  let lifecycle: AutopilotLifecycle | null = null;
  let runRow: Record<string, string> | null = null;
  let turns: ClassStateTurn[] | null = null;

  try {
    const lf = await deps.getSignalLastFired();
    if (lf.ok) lastFired = lf.lastFired;
  } catch (err: any) {
    logger.error({ err }, "[autopilot/class-state] getSignalLastFired threw");
  }

  try {
    const lc = await deps.getCurrentLifecycle();
    if (lc.ok) lifecycle = lc.lifecycle;
  } catch (err: any) {
    logger.error({ err }, "[autopilot/class-state] getCurrentLifecycle threw");
  }

  const runId = lifecycle?.run_id ?? null;
  if (runId !== null) {
    try {
      const rowRes = await deps.getRunRow(runId);
      if (rowRes.ok) runRow = rowRes.row;
    } catch (err: any) {
      logger.error({ err }, "[autopilot/class-state] getRunRow threw");
    }
    try {
      const members = await deps.listTurnsDesc(runId, STARVED_LOOKBACK_TURNS);
      const parsed: ClassStateTurn[] = [];
      let unparseable = 0;
      for (const member of members) {
        const turn = parseTurnMember(member);
        if (turn === null) {
          unparseable += 1;
          continue;
        }
        parsed.push(turn);
      }
      if (unparseable > 0) {
        logger.warn(
          { runId, unparseable },
          "[autopilot/class-state] skipped unparseable turn members",
        );
      }
      turns = parsed;
    } catch (err: any) {
      logger.error({ err }, "[autopilot/class-state] listTurnsDesc threw");
    }
  }

  try {
    return composeClassState(
      { taxonomy: DISPATCH_CLASSES, lastFired, lifecycle, runRow, turns },
      deps.now(),
    );
  } catch (err: any) {
    // Belt-and-braces (INV-13): the pure composer cannot throw by design;
    // if it ever does, answer the trust-contract envelope, never a 500.
    logger.error({ err }, "[autopilot/class-state] composeClassState threw (degraded envelope)");
    return composeClassState(
      { taxonomy: DISPATCH_CLASSES, lastFired: null, lifecycle: null, runRow: null, turns: null },
      deps.now(),
    );
  }
}
