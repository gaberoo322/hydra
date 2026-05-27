/**
 * derive-sprite-state.ts — pure derivation functions from the /api/now/*
 * payloads to the shape the /now-pixel React components want to render.
 *
 * "Pure" is load-bearing: every function here MUST be referentially
 * transparent (same input → same output, no I/O, no Date.now), because
 * test/now-pixel-derive-sprite-state.test.mts asserts behaviour at this
 * boundary. The components stay free of business logic; they just bind
 * what the derive functions returned.
 *
 * Slice 2 of the /now-pixel epic (#642, #644). Slices 3-6 add zone/class
 * mapping, animation states, infirmary tiles, and subagent stats — each
 * gets a new derive function here.
 */

// ---------------------------------------------------------------------------
// API payload shapes (mirrored from src/api/now-page.ts; we deliberately
// duplicate the types so the dashboard does not import from src/.)
// ---------------------------------------------------------------------------

export interface AutopilotTickRun {
  id: string;
  startedAt: string;
  trigger: string;
  turns: number;
  dispatches: number;
  elapsedSeconds: number;
  ageSeconds: number;
}

export interface AutopilotTickPayload {
  running: boolean;
  lastTickAt: string | null;
  currentRun: AutopilotTickRun | null;
  generatedAt: string;
}

export interface ActiveDispatch {
  id: string;
  classLabel: string;
  source: "autopilot" | "operator";
  startedAt: string;
  currentStep?: string;
  issueRef?: string;
  prRef?: string;
}

export interface ActiveDispatchesPayload {
  items: ActiveDispatch[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// PavilionState — derived from autopilot-tick. Drives AutopilotPavilion.jsx.
// ---------------------------------------------------------------------------

export type PavilionMode = "no-run" | "running" | "stopped";

export interface PavilionState {
  mode: PavilionMode;
  runId: string | null;
  trigger: string | null;
  turns: number;
  dispatches: number;
  elapsedLabel: string;
  heartbeatAgeLabel: string;
  /**
   * `lastTickAt` echoed through so callers can pulse the trainer sprite
   * via React's useEffect dependency-array trick. Components compare the
   * previous value to the new one and trigger a one-shot animation when
   * it changes. Null when the scheduler isn't running.
   */
  lastTickAt: string | null;
  /** Tooltip the page uses on the empty-state message. */
  emptyMessage: string;
}

export function derivePavilionState(payload: AutopilotTickPayload | null | undefined): PavilionState {
  if (!payload) {
    return {
      mode: "no-run",
      runId: null,
      trigger: null,
      turns: 0,
      dispatches: 0,
      elapsedLabel: "—",
      heartbeatAgeLabel: "—",
      lastTickAt: null,
      emptyMessage: "Autopilot status not yet loaded.",
    };
  }
  const run = payload.currentRun;
  if (!payload.running || !run) {
    return {
      mode: payload.running ? "no-run" : "stopped",
      runId: null,
      trigger: null,
      turns: 0,
      dispatches: 0,
      elapsedLabel: "—",
      heartbeatAgeLabel: "—",
      lastTickAt: payload.lastTickAt ?? null,
      emptyMessage: payload.running
        ? "Scheduler running, no active autopilot run."
        : "Scheduler stopped.",
    };
  }
  return {
    mode: "running",
    runId: run.id,
    trigger: run.trigger,
    turns: run.turns,
    dispatches: run.dispatches,
    elapsedLabel: formatDuration(run.elapsedSeconds),
    heartbeatAgeLabel: formatDuration(run.ageSeconds),
    lastTickAt: payload.lastTickAt ?? null,
    emptyMessage: "",
  };
}

// ---------------------------------------------------------------------------
// DispatchesStripState — derived from active-dispatches. Drives
// ActiveDispatchesStrip.jsx.
// ---------------------------------------------------------------------------

export interface DispatchSpriteRow {
  id: string;
  classLabel: string;
  source: "autopilot" | "operator";
  /**
   * Slice 2 ships a placeholder mapping — every dispatch renders as
   * 025-pikachu.png. Slice 3 swaps this for a real class-to-sprite map.
   * We expose the placeholder here so components don't hardcode it.
   */
  spriteFile: string;
  /** Hover tooltip text. */
  tooltip: string;
}

export interface DispatchesStripState {
  rows: DispatchSpriteRow[];
  empty: boolean;
}

const PLACEHOLDER_SPRITE = "025-pikachu.png";

export function deriveDispatchesStripState(
  payload: ActiveDispatchesPayload | null | undefined,
): DispatchesStripState {
  const items = payload?.items ?? [];
  const rows = items.map((item) => ({
    id: item.id,
    classLabel: item.classLabel,
    source: item.source,
    spriteFile: PLACEHOLDER_SPRITE,
    tooltip: item.currentStep
      ? `${item.classLabel} · ${item.currentStep}`
      : item.classLabel,
  }));
  return { rows, empty: rows.length === 0 };
}

// ---------------------------------------------------------------------------
// ZoneState — derived from /api/autopilot/runs/current's last turn snapshot.
// Drives HabitatGrid.jsx (slice 3 of #642, #645).
// ---------------------------------------------------------------------------

import {
  PIPELINE_CLASSES,
  SIGNAL_CLASSES,
  type PipelineClass,
  type SignalClass,
  type ClassName,
} from "./sprite-map.ts";

export type ZoneStatus = "sleeping" | "active";

export interface ZoneState {
  /** Map of class → "active" / "sleeping". Covers all 12 classes. */
  zones: Record<ClassName, ZoneStatus>;
  /**
   * Last-fired epoch (Unix seconds) for each signal class — propagated
   * through so the sprite picker can seed pool selection on the same
   * epoch the cooldown logic ran on.
   */
  signalSeeds: Record<SignalClass, number>;
  scope: "all" | "orch-only" | "target-only";
  /**
   * `null` when /api/autopilot/runs/current returns no run (autopilot
   * idle). Caller renders everything as sleeping.
   */
  runStatus: string | null;
}

/**
 * Subset of /api/autopilot/runs/current we actually depend on. Keeping
 * the shape narrow here means a server-side payload change only has to
 * preserve THIS subset to stay compatible.
 */
export interface AutopilotRunPayload {
  status?: string;
  limits?: { scope?: "all" | "orch-only" | "target-only" };
  turns?: Array<{
    slots_snapshot?: Partial<Record<PipelineClass, unknown>>;
    signals_snapshot?: Partial<Record<SignalClass, number>>;
  }>;
}

/**
 * Window (seconds) within which a signal class is "active" after its
 * last fire. Operator's grilling session locked this at 60s.
 */
export const SIGNAL_ACTIVE_WINDOW_SEC = 60;

/**
 * Derive per-class zone status from the autopilot run snapshot.
 *
 * - Pipeline class is "active" iff `slots_snapshot[cls]` is a non-null
 *   object (the autopilot writes `null` for empty slots).
 * - Signal class is "active" iff `signals_snapshot[cls]` was within the
 *   last `SIGNAL_ACTIVE_WINDOW_SEC` seconds relative to `nowEpoch`.
 *
 * Pure function — `nowEpoch` is an explicit input so tests can pin time.
 */
export function deriveZoneState(
  payload: AutopilotRunPayload | null | undefined,
  nowEpoch: number,
): ZoneState {
  const lastTurn = payload?.turns?.[payload.turns.length - 1];
  const slots = lastTurn?.slots_snapshot ?? {};
  const signals = lastTurn?.signals_snapshot ?? {};
  const scope = payload?.limits?.scope ?? "all";
  const runStatus = payload?.status ?? null;
  // When the run isn't currently running, fall back to all-sleeping —
  // a stale snapshot from a long-dead run would otherwise paint the
  // habitat as eternally-busy.
  const stale = !runStatus || runStatus !== "running";

  const zones = {} as Record<ClassName, ZoneStatus>;
  for (const cls of PIPELINE_CLASSES) {
    zones[cls] = !stale && slots[cls] != null ? "active" : "sleeping";
  }
  const signalSeeds = {} as Record<SignalClass, number>;
  for (const cls of SIGNAL_CLASSES) {
    const fired = Number(signals[cls] ?? 0);
    signalSeeds[cls] = Number.isFinite(fired) ? fired : 0;
    const within =
      !stale &&
      Number.isFinite(fired) &&
      fired > 0 &&
      nowEpoch - fired < SIGNAL_ACTIVE_WINDOW_SEC;
    zones[cls] = within ? "active" : "sleeping";
  }
  return { zones, signalSeeds, scope, runStatus };
}

// ---------------------------------------------------------------------------
// HP / EXP / Cooldown derivations (slice 6 of #642, #648).
// ---------------------------------------------------------------------------

import { SIGNAL_COOLDOWNS } from "./sprite-map.ts";

export interface HpState {
  percent: number; // 0..100
  color: "green" | "yellow" | "red" | "grey";
  flashing: boolean;
}

/**
 * Derive a subagent's HP bar from its token usage. The autopilot's
 * `state.limits.subagent_hard_max_tokens` is the ceiling at which
 * reap.py force-stops the subagent; we map remaining headroom to HP %.
 *
 * Grading:
 *   - >= 50%       → green
 *   - >= 20%       → yellow
 *   - >= 10%       → red, no flash
 *   - <  10%       → red, flashing (spec requirement)
 *   - hardMax <= 0 → grey (unknown ceiling)
 */
export function deriveHp(tokensUsed: number, hardMax: number): HpState {
  if (!Number.isFinite(hardMax) || hardMax <= 0) {
    return { percent: 100, color: "grey", flashing: false };
  }
  const used = Number.isFinite(tokensUsed) ? Math.max(0, tokensUsed) : 0;
  const remaining = Math.max(0, hardMax - used);
  const pct = Math.min(100, (remaining / hardMax) * 100);
  if (pct < 10) return { percent: pct, color: "red", flashing: true };
  if (pct < 20) return { percent: pct, color: "red", flashing: false };
  if (pct < 50) return { percent: pct, color: "yellow", flashing: false };
  return { percent: pct, color: "green", flashing: false };
}

export interface ExpState {
  level: number; // 1..50
  expPercent: number; // 0..100 — progress to next level
  cumulativeTokens: number;
  tokenBudget: number;
}

/**
 * Trainer LV/EXP derivation. Acceptance criterion:
 *   LV = floor((cumulative_tokens / token_budget) * 50)
 * EXP bar = position within the current half-percent band.
 *
 * Clamped to LV 1..50 so the bar never empties or overshoots the cap;
 * once the run hits 100% budget LV is 50 and the bar is full.
 */
export function deriveExp(cumulativeTokens: number, tokenBudget: number): ExpState {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return {
      level: 1,
      expPercent: 0,
      cumulativeTokens: cumulativeTokens || 0,
      tokenBudget: 0,
    };
  }
  const ratio = Math.min(
    1,
    Math.max(0, (cumulativeTokens || 0) / tokenBudget),
  );
  const rawLevel = ratio * 50;
  const level = Math.min(50, Math.max(1, Math.floor(rawLevel) || 1));
  // Position within the current LV band. Each level spans 1/50 of the
  // budget; if we're past level 1, the band starts at (level/50) and
  // ends at ((level+1)/50). We render the percent-within-band.
  const bandStart = level / 50;
  const bandEnd = (level + 1) / 50;
  const bandWidth = bandEnd - bandStart;
  const within = bandWidth > 0 ? (ratio - bandStart) / bandWidth : 0;
  const expPercent = Math.min(100, Math.max(0, within * 100));
  return {
    level,
    expPercent,
    cumulativeTokens: cumulativeTokens || 0,
    tokenBudget,
  };
}

export interface CooldownState {
  /** Seconds remaining until the next fire is eligible. <= 0 means ready. */
  secondsRemaining: number;
  ready: boolean;
  /** Cooldown total (seconds) for the source class. 0 → no cooldown. */
  totalSeconds: number;
}

/**
 * Cooldown derivation for signal classes. `lastFiredEpoch` is Unix
 * seconds; `nowEpoch` lets tests pin the clock.
 *
 * health has cooldown 0 — `ready: true` and `secondsRemaining: 0` always.
 */
export function deriveCooldown(
  cls: SignalClass,
  lastFiredEpoch: number,
  nowEpoch: number,
): CooldownState {
  const totalSeconds = SIGNAL_COOLDOWNS[cls] ?? 0;
  if (totalSeconds <= 0) {
    return { secondsRemaining: 0, ready: true, totalSeconds: 0 };
  }
  const fired = Number.isFinite(lastFiredEpoch) ? lastFiredEpoch : 0;
  if (fired <= 0) {
    // Never fired → cooldown not "in progress"; class is ready to fire.
    return { secondsRemaining: 0, ready: true, totalSeconds };
  }
  const remaining = Math.max(0, fired + totalSeconds - nowEpoch);
  return {
    secondsRemaining: remaining,
    ready: remaining <= 0,
    totalSeconds,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function formatDuration(seconds: number | null | undefined): string {
  if (!Number.isFinite(seconds) || (seconds as number) < 0) return "—";
  const s = seconds as number;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
