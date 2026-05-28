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
// Thinking-state derivation (issue #660 follow-up to /now-pixel slice 4/6).
//
// A pipeline slot is "thinking" when it has been occupied for ≥30s with
// **no token-delta on the run row** in that window. We do not have a
// "tokens went up at T" event from the autopilot — the signal lives in
// `slots_snapshot[cls].partial_tokens` from /api/autopilot/runs/current.
// The derivation diffs successive polls per slot and flips the slot into
// thinking once a configurable inactivity window has elapsed with no
// delta.
//
// Pure function — explicit `now` for test pinning. The caller threads
// the previous `tracker` value back in on each poll; the function
// returns the next tracker alongside the per-class thinking map.
// ---------------------------------------------------------------------------

/**
 * Per-slot bookkeeping for thinking-state derivation. The caller (the
 * `HabitatGrid` component) holds this in a `useRef` and threads it back
 * through `deriveThinking` on every /api/autopilot/runs/current poll.
 */
export interface ThinkingSlotState {
  /** Last seen partial_tokens value for this slot. Used to detect deltas. */
  lastTokens: number;
  /** Epoch (Unix seconds) at which `lastTokens` last changed. */
  lastChangeAt: number;
  /** Subagent task_id observed when `lastTokens` was last updated. */
  taskId: string | null;
}

export type ThinkingTracker = Partial<Record<PipelineClass, ThinkingSlotState>>;

/**
 * Inactivity window (seconds) before a still-occupied slot tips into
 * "thinking". The spec on issue #660 locks this at 30s — exposed as a
 * named export so tests don't hard-code the literal.
 */
export const THINKING_WINDOW_SEC = 30;

/**
 * Slim shape we accept off each `slots_snapshot[cls]` entry. The
 * autopilot writes the full slot row (skill, task_id, started_at, etc.);
 * we only need the bits that matter for thinking-state.
 */
interface ThinkingSlotInput {
  skill?: string;
  task_id?: string | null;
  partial_tokens?: number | null | undefined;
}

type SlotsSnapshotInput = Partial<Record<PipelineClass, ThinkingSlotInput | null>>;

export interface DeriveThinkingResult {
  /** Per-class thinking boolean. All seven pipeline classes are keyed. */
  thinking: Record<PipelineClass, boolean>;
  /**
   * Next tracker state — caller stores this and threads it back on the
   * next poll. Empty slots are pruned so the tracker never grows
   * unbounded as autopilot runs come and go.
   */
  nextTracker: ThinkingTracker;
}

/**
 * Derive per-slot thinking state from a slots-snapshot poll.
 *
 * Inputs:
 *   - `slotsSnapshot` — the freshest `slots_snapshot` from
 *     /api/autopilot/runs/current (typically the last turn).
 *   - `now` — Unix-seconds clock the caller is already ticking at 1Hz
 *     (HabitatGrid). Explicit so the unit test can pin time.
 *   - `prevTracker` — what the previous invocation returned in
 *     `nextTracker`. Pass `{}` on first call.
 *
 * Behaviour:
 *   - Empty slot (null/undefined) → not thinking. Tracker entry is
 *     dropped so a fresh occupancy starts the clock from scratch.
 *   - Slot re-occupied by a NEW task_id → not thinking (yet). Tracker
 *     restarts at `now`.
 *   - Same task_id with a token delta vs. `lastTokens` → not thinking.
 *     Tracker's `lastChangeAt` advances to `now`.
 *   - Same task_id with NO token delta and `now - lastChangeAt >=
 *     THINKING_WINDOW_SEC` → thinking. Tracker is preserved.
 *   - Same task_id, no token delta, but still inside the window → not
 *     thinking (yet). Tracker is preserved.
 *
 * Returns both the per-class thinking map AND the next tracker. Pure —
 * does not mutate `prevTracker`.
 */
export function deriveThinking(
  slotsSnapshot: SlotsSnapshotInput | null | undefined,
  now: number,
  prevTracker: ThinkingTracker = {},
): DeriveThinkingResult {
  const snapshot = slotsSnapshot ?? {};
  const thinking = {} as Record<PipelineClass, boolean>;
  const nextTracker: ThinkingTracker = {};

  for (const cls of PIPELINE_CLASSES) {
    const slot = snapshot[cls];
    if (slot == null) {
      // Empty slot — drop the tracker entry so the next occupancy
      // restarts the inactivity clock from zero.
      thinking[cls] = false;
      continue;
    }

    const tokensRaw = slot.partial_tokens;
    const tokens =
      typeof tokensRaw === "number" && Number.isFinite(tokensRaw) ? tokensRaw : 0;
    const taskId = slot.task_id ?? null;
    const prev = prevTracker[cls];

    if (!prev || prev.taskId !== taskId) {
      // New occupancy (or first poll). Seed the tracker at `now`; not
      // yet thinking.
      nextTracker[cls] = {
        lastTokens: tokens,
        lastChangeAt: now,
        taskId,
      };
      thinking[cls] = false;
      continue;
    }

    if (tokens !== prev.lastTokens) {
      // Token-delta observed → advance the change watermark.
      nextTracker[cls] = {
        lastTokens: tokens,
        lastChangeAt: now,
        taskId,
      };
      thinking[cls] = false;
      continue;
    }

    // Same task, no delta. Preserve the tracker; flip to thinking once
    // the inactivity window has elapsed.
    nextTracker[cls] = {
      lastTokens: tokens,
      lastChangeAt: prev.lastChangeAt,
      taskId,
    };
    thinking[cls] = now - prev.lastChangeAt >= THINKING_WINDOW_SEC;
  }

  return { thinking, nextTracker };
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
