/**
 * status-strip-state.ts — the two StatusStrip widget derivations (issue
 * #2411, now-status-5, parent #2408; extracted from console-state.ts by
 * #4382).
 *
 * Two small read-only status widgets for the top of /now: a next-dispatch
 * (pace-gate) countdown driven by GET /autopilot/idle-diagnostics, and an
 * in-flight dispatch-slot list driven by GET /autopilot/inflight-slots. Both
 * derivations live here (pure, `nowMs` injected) so the orchestrator suite
 * can pin them (`test/now-console-status-strip-state.test.mts`) — the
 * dashboard ships no JSX test runner (issue #3706). This leaf is the sole
 * now-console consumer of the canonical `formatRelativeTime` bucket from
 * lib/relative-time-format.ts (issue #4400).
 *
 * Consumers reach this through the `console-state.ts` barrel; import the leaf
 * directly when only the strip widgets are needed.
 */

import { formatRelativeTime } from "../../lib/relative-time-format.ts";

/**
 * The result of formatting `nextPaceGateCheck` into the countdown the widget
 * renders. `label` is always render-safe text; `state` distinguishes a real
 * countdown from the "unknown" (null/unparseable timestamp) and "due"
 * (timestamp already in the past) degradations.
 */
export interface NextDispatchCountdown {
  label: string;
  state: "counting" | "due" | "unknown";
}

/**
 * Format the ISO `nextPaceGateCheck` timestamp from /autopilot/idle-diagnostics
 * into a "next dispatch attempt in Xm Ys" countdown string. `nowMs` is injected
 * so tests stay deterministic.
 *
 * Degradations (acceptance criterion: handle a null value as "unknown"):
 *   - null / undefined / unparseable ISO   → { label: "unknown", state: "unknown" }
 *   - timestamp already in the past         → { label: "due now", state: "due" }
 *   - future timestamp                      → "next dispatch attempt in Xm Ys"
 *     (the "Xm Ys" omits the minutes segment under 60s, e.g. "in 42s").
 */
export function formatNextDispatchCountdown(
  nextPaceGateCheck: string | null | undefined,
  nowMs: number,
): NextDispatchCountdown {
  if (typeof nextPaceGateCheck !== "string" || nextPaceGateCheck.length === 0) {
    return { label: "unknown", state: "unknown" };
  }
  const targetMs = Date.parse(nextPaceGateCheck);
  if (!Number.isFinite(targetMs)) {
    return { label: "unknown", state: "unknown" };
  }
  const diffSec = Math.floor((targetMs - nowMs) / 1000);
  if (diffSec <= 0) {
    return { label: "due now", state: "due" };
  }
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  const rel = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  return { label: `next dispatch attempt in ${rel}`, state: "counting" };
}

/**
 * A single in-flight dispatch slot, normalised for the widget row. `key` is the
 * slot's record key (e.g. `worktree-agent-…`); `relativeStart` is a render-safe
 * "started Xm ago" string (empty when no usable start epoch is present).
 */
export interface InflightSlotRow {
  key: string;
  skill: string;
  taskId: string | null;
  relativeStart: string;
}

interface RawInflightSlot {
  skill?: unknown;
  task_id?: unknown;
  started?: unknown;
  started_epoch?: unknown;
}

/**
 * Derive the ordered in-flight slot rows from the
 * `/autopilot/inflight-slots` -> `slots` record (a
 * `Record<string,{skill,task_id,started,started_epoch}>`). Rows are sorted
 * oldest-first by `started_epoch` (a slot without a usable epoch sorts last),
 * so the longest-running dispatch leads. `nowMs` is injected for deterministic
 * relative-start formatting.
 *
 * An empty / missing / malformed `slots` value yields `[]` — the widget renders
 * its "no dispatches in flight" empty state from a zero-length list, never a
 * crash.
 */
export function deriveInflightSlots(
  slots: Record<string, RawInflightSlot | null | undefined> | null | undefined,
  nowMs: number,
): InflightSlotRow[] {
  if (!slots || typeof slots !== "object") return [];
  const nowSec = Math.floor(nowMs / 1000);
  const rows: Array<InflightSlotRow & { _epoch: number }> = [];
  for (const [key, slot] of Object.entries(slots)) {
    if (!slot || typeof slot !== "object") continue;
    const epochRaw = Number((slot as RawInflightSlot).started_epoch ?? NaN);
    const epoch = Number.isFinite(epochRaw) && epochRaw > 0 ? epochRaw : NaN;
    const skill =
      typeof slot.skill === "string" && slot.skill.length > 0 ? slot.skill : "unknown";
    const taskId = typeof slot.task_id === "string" && slot.task_id.length > 0 ? slot.task_id : null;
    rows.push({
      key,
      skill,
      taskId,
      relativeStart: formatRelativeStart(epoch, nowSec),
      _epoch: Number.isFinite(epoch) ? epoch : Number.POSITIVE_INFINITY,
    });
  }
  rows.sort((a, b) => a._epoch - b._epoch || a.key.localeCompare(b.key));
  return rows.map(({ _epoch, ...row }) => row);
}

/**
 * Format an epoch (seconds) as "started Xm ago" for a slot row: a "started "
 * prefix over the canonical formatRelativeTime buckets from
 * lib/relative-time-format.ts (issue #4400). Returns "" when no usable start
 * epoch is present, so the widget can omit the segment rather than render a
 * misleading "started 0s ago". `nowSec` injected for determinism.
 */
function formatRelativeStart(epochSec: number, nowSec: number): string {
  const rel = formatRelativeTime(epochSec, nowSec);
  return rel === "" ? "" : `started ${rel}`;
}
