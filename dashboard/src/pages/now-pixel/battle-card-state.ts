/**
 * battle-card-state.ts — pure derivation for the BattleCardRow + Pokedex
 * modal that replaces ActiveDispatchesStrip (slice D of /now-observability,
 * epic #667, issue #672).
 *
 * "Pure" matters: every function here is referentially transparent so
 * test/now-pixel-battle-card.test.mts can pin behaviour at this seam
 * without a React tree. The components stay free of business logic;
 * they bind what these functions return.
 *
 * Wire-shape contract
 * -------------------
 * - `active-dispatches` API payload is the same one ActiveDispatchesStrip
 *   consumed (`/api/now/active-dispatches`).
 * - Tool-call events arrive over the WS `slot-event` stream with
 *   payload.event === "subagent_tool_call", carrying:
 *     slot, task_id, tool, category ∈ {milestone, io, background},
 *     target, duration_ms, success, ts_epoch
 *   (See scripts/autopilot/hooks/on-subagent-tool-call.sh from issue #671.)
 * - Permission-wait events arrive with payload.event ===
 *   "slot_waiting_permission" carrying { slot, task_id?, tool?, ts_epoch }.
 *   A permission-wait is "open" until a subsequent `subagent_tool_call`
 *   on the same task_id OR a `subagent_stop` on the same slot resolves it.
 * - PR-link events arrive either via slice G's `pr_lifecycle` WS frames
 *   (payload.event === "pr_opened") OR via the cycle-record `prRef` field
 *   on the dispatch row — whichever lands first wins.
 *
 * If slices A/C/G haven't landed yet, this code starts from zero counters
 * and shows no current-activity / no PR link. Nothing crashes; the strip's
 * graceful-degradation contract is preserved.
 */

import type { ActiveDispatch, ActiveDispatchesPayload } from "./derive-sprite-state.ts";
import { classSpriteFile, hasClassSprite, type ClassName } from "./sprite-map.ts";

// ---------------------------------------------------------------------------
// Live counter / wait / activity state — accumulated as WS events stream in.
// ---------------------------------------------------------------------------

export interface ToolCallCounters {
  writes: number;
  milestones: number;
  reads: number;
}

interface PermissionWait {
  /** epoch seconds when the wait was opened */
  openedAt: number;
  /** tool name (may be empty in older event versions) */
  tool: string;
}

/**
 * Per-task accumulator keyed by `task_id`. The strip uses task_id as the
 * identity throughout (dispatch row's `id` aligns with the autopilot slot's
 * task_id — see ActiveDispatchesStrip's slice-6 comment).
 */
export interface TaskRuntimeState {
  taskId: string;
  /** running counters since dispatch start */
  counters: ToolCallCounters;
  /** latest activity string, derived from the most recent tool-call event */
  currentActivity: string;
  /** open permission-wait, or null if none / already resolved */
  permissionWait: PermissionWait | null;
  /** PR URL or "owner/repo#N" — null until a pr_opened event or dispatch.prRef arrives */
  prRef: string | null;
  /** epoch seconds of the most recent event applied (debug / sort tie-break) */
  lastEventAt: number;
  /** chronological timeline of milestone-ish events for the Pokedex modal */
  milestoneLog: MilestoneLogEntry[];
}

interface MilestoneLogEntry {
  ts: number;
  /** discriminator: subagent_tool_call | slot_waiting_permission | pr_opened | subagent_stop */
  kind: string;
  category?: "milestone" | "io" | "background";
  tool?: string;
  target?: string;
  status?: string;
  message: string;
}

const EMPTY_COUNTERS: ToolCallCounters = Object.freeze({
  writes: 0,
  milestones: 0,
  reads: 0,
}) as ToolCallCounters;

const MAX_LOG_ENTRIES = 200;

export function makeInitialTaskState(taskId: string): TaskRuntimeState {
  return {
    taskId,
    counters: { writes: 0, milestones: 0, reads: 0 },
    currentActivity: "",
    permissionWait: null,
    prRef: null,
    lastEventAt: 0,
    milestoneLog: [],
  };
}

// ---------------------------------------------------------------------------
// Tool-call classification — maps the hook's `category` field to the three
// strip counters spec'd in the issue: writes / milestones / reads.
// ---------------------------------------------------------------------------

/**
 * Mapping from the on-emit `category` (milestone/io/background) to the
 * three counter buckets the strip surfaces:
 *
 *   - writes      → tool name signals an edit (Write/Edit/MultiEdit/NotebookEdit)
 *   - milestones  → category === "milestone" but tool isn't a write
 *                   (git commit, gh pr, npm test, npm run build, etc.)
 *   - reads       → category === "background" (Read/Grep/Glob)
 *
 * IO (Bash that isn't a milestone, WebFetch, WebSearch) is intentionally
 * NOT counted — the spec lists exactly three counters. We surface those
 * via the current-activity string instead so they're still legible.
 */
const WRITE_TOOL_NAMES = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

export function classifyToolCall(
  category: string | undefined,
  tool: string | undefined,
): keyof ToolCallCounters | null {
  if (tool && WRITE_TOOL_NAMES.has(tool)) return "writes";
  if (category === "milestone") return "milestones";
  if (category === "background") return "reads";
  return null; // "io" or unknown — not counted, but still timeline'd
}

// ---------------------------------------------------------------------------
// Event application — folds one WS frame into the per-task accumulator map.
// ---------------------------------------------------------------------------

/**
 * Fold a single WS `slot-event` frame into the per-task state map.
 *
 * Returns a NEW map (immutable update) so React's setState picks up the
 * change. Tasks unseen by `activeDispatches` are still tracked — the
 * BattleCardRow filters them out at render-time so dead tasks fade out
 * with the rest of the strip when the dispatch row disappears.
 */
export function applySlotEvent(
  state: Readonly<Record<string, TaskRuntimeState>>,
  frame: unknown,
): Record<string, TaskRuntimeState> {
  const payload = readPayload(frame);
  if (!payload) return state as Record<string, TaskRuntimeState>;

  const event = String(payload.event ?? "");
  if (!event) return state as Record<string, TaskRuntimeState>;

  const taskId = pickTaskId(payload);
  if (!taskId) return state as Record<string, TaskRuntimeState>;

  const ts = readEpochSec(payload);
  const prev = state[taskId] ?? makeInitialTaskState(taskId);
  const next: TaskRuntimeState = {
    ...prev,
    counters: { ...prev.counters },
    milestoneLog: prev.milestoneLog,
    lastEventAt: Math.max(prev.lastEventAt, ts),
  };

  if (event === "subagent_tool_call") {
    const category = normaliseCategory(payload.category);
    const tool = String(payload.tool ?? "");
    const target = String(payload.target ?? "");
    const bucket = classifyToolCall(category, tool);
    if (bucket) {
      next.counters[bucket] = (next.counters[bucket] ?? 0) + 1;
    }
    // Any tool call clears an outstanding permission-wait (the operator
    // approved, or the subagent moved on after a denial).
    if (next.permissionWait) next.permissionWait = null;
    next.currentActivity = formatActivity(tool, target, category);
    next.milestoneLog = appendMilestone(next.milestoneLog, {
      ts,
      kind: "subagent_tool_call",
      category,
      tool,
      target,
      message: next.currentActivity,
    });
  } else if (event === "slot_waiting_permission") {
    next.permissionWait = {
      openedAt: ts || Math.floor(Date.now() / 1000),
      tool: String(payload.tool ?? ""),
    };
    next.milestoneLog = appendMilestone(next.milestoneLog, {
      ts,
      kind: "slot_waiting_permission",
      tool: String(payload.tool ?? ""),
      message: `waiting on permission${payload.tool ? ` (${payload.tool})` : ""}`,
    });
  } else if (event === "subagent_stop") {
    // A stop resolves any open permission-wait and freezes activity.
    if (next.permissionWait) next.permissionWait = null;
    const status = String(payload.status ?? "");
    next.currentActivity = status ? `stopped · ${status}` : "stopped";
    next.milestoneLog = appendMilestone(next.milestoneLog, {
      ts,
      kind: "subagent_stop",
      status,
      message: next.currentActivity,
    });
  } else if (event === "pr_opened") {
    const ref = String(payload.pr_ref ?? payload.url ?? "");
    if (ref) next.prRef = ref;
    next.milestoneLog = appendMilestone(next.milestoneLog, {
      ts,
      kind: "pr_opened",
      target: ref,
      message: ref ? `PR opened — ${ref}` : "PR opened",
    });
  } else {
    // Unknown event kind — still timeline it so debugging is possible.
    next.milestoneLog = appendMilestone(next.milestoneLog, {
      ts,
      kind: event,
      message: event,
    });
  }

  return { ...state, [taskId]: next };
}

function appendMilestone(
  log: MilestoneLogEntry[],
  entry: MilestoneLogEntry,
): MilestoneLogEntry[] {
  const next = log.length >= MAX_LOG_ENTRIES ? log.slice(-MAX_LOG_ENTRIES + 1) : [...log];
  next.push(entry);
  return next;
}

function readPayload(frame: unknown): Record<string, unknown> | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.type !== "slot-event") return null;
  const p = f.payload;
  if (!p || typeof p !== "object") return null;
  return p as Record<string, unknown>;
}

function pickTaskId(p: Record<string, unknown>): string {
  const tid = p.task_id;
  if (typeof tid === "string" && tid.length > 0) return tid;
  if (typeof tid === "number") return String(tid);
  // Some early events omit task_id and only carry slot. The strip needs
  // task identity for the per-card row; without it we cannot attribute.
  return "";
}

function readEpochSec(p: Record<string, unknown>): number {
  const v = p.ts_epoch;
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normaliseCategory(
  v: unknown,
): "milestone" | "io" | "background" | undefined {
  if (v === "milestone" || v === "io" || v === "background") return v;
  return undefined;
}

function formatActivity(
  tool: string,
  target: string,
  category: string | undefined,
): string {
  const parts: string[] = [];
  if (tool) parts.push(tool);
  if (target) parts.push(target);
  const base = parts.join(" · ");
  if (!base) return category ?? "";
  return base;
}

// ---------------------------------------------------------------------------
// Battle card row derivation — combines active-dispatches + runtime map into
// the shape BattleCardRow.jsx renders.
// ---------------------------------------------------------------------------

interface BattleCardRow {
  id: string;
  classLabel: string;
  /** sprite path under /sprites/pokemon/ — falls back to the placeholder when class has no mapping */
  spriteFile: string;
  source: "autopilot" | "operator";
  counters: ToolCallCounters;
  currentActivity: string;
  permissionWaitOpen: boolean;
  prRef: string | null;
  tooltip: string;
}

export interface BattleCardRowState {
  rows: BattleCardRow[];
  empty: boolean;
}

const PLACEHOLDER_SPRITE_FILE = "025-pikachu.png";

export function deriveBattleCardRows(
  payload: ActiveDispatchesPayload | null | undefined,
  taskState: Readonly<Record<string, TaskRuntimeState>>,
): BattleCardRowState {
  const items: ActiveDispatch[] = payload?.items ?? [];
  const rows: BattleCardRow[] = items.map((item) => {
    const runtime = taskState[item.id];
    const counters = runtime?.counters ?? EMPTY_COUNTERS;
    // PR ref from runtime events wins; otherwise the dispatch row's own prRef.
    const prRef = runtime?.prRef ?? item.prRef ?? null;
    return {
      id: item.id,
      classLabel: item.classLabel,
      spriteFile: resolveSpriteFile(item.classLabel),
      source: item.source,
      counters,
      currentActivity:
        runtime?.currentActivity ||
        (item.currentStep ? item.currentStep : ""),
      permissionWaitOpen: runtime?.permissionWait != null,
      prRef,
      tooltip: buildTooltip(item, runtime),
    };
  });
  return { rows, empty: rows.length === 0 };
}

function resolveSpriteFile(classLabel: string): string {
  // classLabel may already be a class name (dev_orch, qa_target, …) or it
  // may be a skill alias / unknown string. `classSpriteFile` no longer throws
  // for an unmapped class — it degrades to its own habitat fallback sprite —
  // so we gate on `hasClassSprite` and keep the strip's OWN placeholder
  // (Pikachu) for anything outside the pipeline+signal closed set, preserving
  // the legacy strip convention. We don't import the skill-alias table here
  // because the /now-pixel sprite-map keeps it private — the active-dispatches
  // payload normalises to the class string at the API boundary today.
  if (!hasClassSprite(classLabel)) return PLACEHOLDER_SPRITE_FILE;
  try {
    const file = classSpriteFile(classLabel as ClassName, 0);
    return file || PLACEHOLDER_SPRITE_FILE;
  } catch {
    /* intentional: unexpected sprite-lookup failure falls back to the placeholder */
    return PLACEHOLDER_SPRITE_FILE;
  }
}

function buildTooltip(
  item: ActiveDispatch,
  runtime: TaskRuntimeState | undefined,
): string {
  const activity = runtime?.currentActivity || item.currentStep;
  const issue = item.issueRef ? ` · ${item.issueRef}` : "";
  return activity ? `${item.classLabel} · ${activity}${issue}` : `${item.classLabel}${issue}`;
}

// ---------------------------------------------------------------------------
// Pokedex modal — chronological milestone list for one task.
// ---------------------------------------------------------------------------

export interface PokedexEntry {
  ts: number;
  kind: string;
  message: string;
  /** for styling: "milestone" / "io" / "background" / "stop" / "wait" / "pr" */
  category: string;
}

export function derivePokedexEntries(
  state: Readonly<Record<string, TaskRuntimeState>>,
  taskId: string,
): PokedexEntry[] {
  const log = state[taskId]?.milestoneLog ?? [];
  return log.map((m) => ({
    ts: m.ts,
    kind: m.kind,
    message: m.message,
    category: m.category ?? deriveEntryCategory(m.kind),
  }));
}

function deriveEntryCategory(kind: string): string {
  if (kind === "subagent_stop") return "stop";
  if (kind === "slot_waiting_permission") return "wait";
  if (kind === "pr_opened") return "pr";
  return "io";
}

// ---------------------------------------------------------------------------
// Permission-wait reaper — drops entries older than `MAX_WAIT_AGE_SEC`. A
// safety net in case a slice-C event sequence is dropped (Redis MAXLEN'd,
// XACK ahead of us, etc.) and a stale yellow dot would otherwise stick.
// ---------------------------------------------------------------------------

export const MAX_WAIT_AGE_SEC = 30 * 60; // 30 minutes

export function reapStalePermissionWaits(
  state: Readonly<Record<string, TaskRuntimeState>>,
  nowEpoch: number,
): Record<string, TaskRuntimeState> {
  let changed = false;
  const next: Record<string, TaskRuntimeState> = {};
  for (const [id, t] of Object.entries(state)) {
    if (t.permissionWait && nowEpoch - t.permissionWait.openedAt > MAX_WAIT_AGE_SEC) {
      next[id] = { ...t, permissionWait: null };
      changed = true;
    } else {
      next[id] = t;
    }
  }
  return changed ? next : (state as Record<string, TaskRuntimeState>);
}
