/**
 * oak-crier-state.ts — the pure folds behind the OakTownCrier live feed.
 *
 * Issue #3706. `OakTownCrier.jsx` used to carry three total functions inline:
 * the 34-line `eventSummary` WS-frame classifier, the `oak_resting` envelope
 * fold, and the MAX_BUBBLES ring-buffer reducer that runs inside a setState
 * updater. All three are functions of their inputs only, so they live here and
 * are pinned by `test/now-pixel-oak-crier-state.test.mts` in the REQUIRED
 * `test` job — the same seam `oak-tab-state.ts` and `derive-sprite-state.ts`
 * already use.
 *
 * What deliberately did NOT move: the `ws.subscribe("*", …)` / `off?.()`
 * lifecycle, the hover-pause `scrollTop = scrollHeight` auto-scroll, and the
 * collapse toggle. A test over those asserts that React and the DOM work, not
 * that Hydra works.
 *
 * `dashboard/` is a separately deployed Vite build with its own tsconfig and
 * package-lock, so the WS frame shape is re-declared here rather than imported
 * from `src/`. Plain functions, interfaces and const objects only — the root
 * `npm test` runs `node --experimental-strip-types`, which erases types but
 * cannot emit fields, so parameter properties and enums are unavailable.
 */

/**
 * A frame off the dashboard WS wildcard subscription. Only the fields the
 * crier folds over are typed; the server payload carries more.
 */
export interface CrierFrame {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown> | null;
}

export type BubbleKind = "stop" | "wait" | "slot" | "generic";

export interface EventSummary {
  /** Class/slot the event came from; drives the bubble colour. */
  source: string | undefined;
  text: string;
  kind: BubbleKind;
}

export interface Bubble {
  id: number;
  ts: string;
  color: string;
  source: string;
  text: string;
  kind: BubbleKind;
}

export interface RestingNote {
  spend: number;
  cap: number;
  ts: string;
}

/** Ring-buffer ceiling for the live feed. The wildcard subscription is an
 *  unbounded feed, so this is a real memory invariant, not a display choice. */
export const MAX_BUBBLES = 50;

/** Longest rendered bubble text; longer generic messages are truncated. */
export const MAX_BUBBLE_TEXT = 120;

/** Bubble source shown when the frame identifies no class or skill. */
export const FALLBACK_BUBBLE_SOURCE = "system";

/**
 * First non-empty string among the candidates, mirroring the `a || b || c`
 * fallback chain this replaced. Non-string values are skipped rather than
 * returned: the original chain would hand an object straight to `.slice()`
 * and throw, which was never intended behaviour.
 */
function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** `value ?? fallback` stringified — nullish falls back, empty string does not. */
function orDefault(value: unknown, fallback: string): string {
  return value === null || value === undefined ? fallback : String(value);
}

/**
 * Classify one WS frame into a renderable bubble summary, or `null` when the
 * frame should be suppressed.
 *
 * Four shapes, in precedence order:
 *   1. `slot-event` + `payload.event === "subagent_stop"` → kind `"stop"`
 *   2. `slot-event` + `payload.event === "slot_waiting_permission"` → `"wait"`
 *   3. any other `slot-event` → `"slot"`
 *   4. anything else → `"generic"`, message truncated to MAX_BUBBLE_TEXT
 *
 * The `connected` heartbeat hello returns `null` so it never fills the feed.
 * Note the ordering: the `slot-event` branches are checked first, so a
 * `slot-event` frame is never suppressed by the heartbeat rule.
 */
export function eventSummary(
  frame: CrierFrame | null | undefined,
): EventSummary | null {
  if (frame?.type === "slot-event") {
    const p = frame.payload || {};
    const source = firstString(p.slot, p.subagent_type);
    if (p.event === "subagent_stop") {
      return {
        source,
        text: `${orDefault(p.slot, "slot")} ${orDefault(p.status, "stopped")}${
          p.summary ? ` · ${String(p.summary)}` : ""
        }`,
        kind: "stop",
      };
    }
    if (p.event === "slot_waiting_permission") {
      return {
        source,
        text: `${orDefault(p.slot, "slot")} waiting on permission${
          p.tool ? ` (${String(p.tool)})` : ""
        }`,
        kind: "wait",
      };
    }
    return {
      source,
      text: firstString(p.event) ?? "slot event",
      kind: "slot",
    };
  }
  // Suppress the heartbeat hello — it carries no operator signal.
  if (frame?.type === "connected") return null;

  const p = frame?.payload || {};
  const msg = firstString(p.message, p.text, p.summary, frame?.type) ?? "event";
  return {
    source: firstString(p.source, p.subagent_type, frame?.type),
    text: msg.slice(0, MAX_BUBBLE_TEXT),
    kind: "generic",
  };
}

/**
 * Build the rendered bubble from a classified summary. `nowIso` is injected so
 * the timestamp fallback is deterministic under test; `color` is resolved by
 * the caller via `sprite-map.ts` so this module stays free of the palette.
 */
export function bubbleFrom(
  frame: CrierFrame | null | undefined,
  summary: EventSummary,
  id: number,
  color: string,
  nowIso: string,
): Bubble {
  return {
    id,
    ts: firstString(frame?.timestamp) ?? nowIso,
    color,
    source: summary.source ?? FALLBACK_BUBBLE_SOURCE,
    text: summary.text,
    kind: summary.kind,
  };
}

/**
 * Append one bubble and trim the oldest entries back to `max`. Returns a new
 * array — the caller passes this straight into a setState updater, so it must
 * never mutate `prev`.
 */
export function appendBubble<T>(
  prev: readonly T[] | null | undefined,
  bubble: T,
  max: number = MAX_BUBBLES,
): T[] {
  const next = Array.isArray(prev) ? [...prev, bubble] : [bubble];
  if (next.length > max) next.splice(0, next.length - max);
  return next;
}

/**
 * Fold the `oak_resting` envelope the recommendation engine broadcasts when
 * the daily cap is spent. Returns `null` for every other frame type, so the
 * caller can use it as the branch test as well as the parser.
 */
export function restingNoteFrom(
  frame: CrierFrame | null | undefined,
  nowIso: string,
): RestingNote | null {
  if (frame?.type !== "oak_resting") return null;
  const p = frame.payload || {};
  return {
    spend: Number(p.daily_spend_usd ?? 0),
    cap: Number(p.daily_cap_usd ?? 0),
    ts: firstString(frame.timestamp) ?? nowIso,
  };
}
