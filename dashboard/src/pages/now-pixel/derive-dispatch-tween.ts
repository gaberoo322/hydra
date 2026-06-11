/**
 * derive-dispatch-tween.ts — pure logic for the Pavilion → HabitatZone
 * dispatch tween.
 *
 * Slice E of the autopilot observability epic (#667, #670). The render-
 * side hook + component (`useSpriteAnimations.fireTravel`, DispatchTween)
 * is a thin shell around these pure functions so the lifecycle is
 * exercisable from node:test without a DOM.
 *
 * The contract:
 *   1. `shouldTweenFrame(frame)` — predicate gating on the slot-event
 *      envelope. Returns the destination class on a match, null otherwise.
 *      Only `dispatch_decision` events with outcome === "dispatched" and
 *      a non-empty string class qualify. Other discriminators
 *      (turn_start, turn_end, subagent_*) fall through.
 *   2. `tweenIdFor(turnN, cls, tsEpoch)` — deterministic id used to key
 *      the React render layer + cancellation timers. Same (turn_n,
 *      class, ts_epoch) triple always produces the same id so duplicate
 *      WS deliveries collapse into a single tween instead of stacking.
 *   3. `tweenSpec({fromRect, toRect, reducedMotion, durationMs})` —
 *      decides between an `instant` short-circuit (reducedMotion / null
 *      rects) and a `tween` payload with start/end coords + the
 *      dustStartAt timestamp the keyframe layer hands to the dust-puff
 *      child.
 *
 * The split keeps the load-bearing parts pure: the React layer is
 * essentially "subscribe to WS, call these functions, render the
 * returned spec".
 */

export const DISPATCH_TWEEN_DURATION_MS = 800;
export const DISPATCH_TWEEN_DUST_DURATION_MS = 200;

/**
 * Loose shape — `slot-event` envelopes are forwarded verbatim from the
 * autopilot side, so we keep the payload typing permissive and validate
 * the parts we care about at runtime.
 */
export interface SlotEventFrame {
  type?: string;
  payload?: {
    event?: string;
    class?: string;
    outcome?: string;
    turn_n?: number;
    ts_epoch?: number;
    [key: string]: unknown;
  };
}

export interface DispatchTweenHit {
  cls: string;
  turnN: number;
  tsEpoch: number;
}

/**
 * Pure predicate. Returns the canonical dispatch info if `frame` is a
 * dispatch_decision with outcome=dispatched and a non-empty class.
 * Otherwise null.
 *
 * Tolerates missing turn_n / ts_epoch defensively — older bridges
 * occasionally omit fields. The render side falls back to Date.now()
 * for ts_epoch and 0 for turn_n if needed.
 */
export function shouldTweenFrame(frame: SlotEventFrame | null | undefined): DispatchTweenHit | null {
  if (!frame || typeof frame !== "object") return null;
  const payload = frame.payload;
  if (!payload || typeof payload !== "object") return null;
  if (payload.event !== "dispatch_decision") return null;
  if (payload.outcome !== "dispatched") return null;
  const cls = payload.class;
  if (typeof cls !== "string" || cls.length === 0) return null;
  const turnN = typeof payload.turn_n === "number" ? payload.turn_n : 0;
  const tsEpoch = typeof payload.ts_epoch === "number" ? payload.ts_epoch : 0;
  return { cls, turnN, tsEpoch };
}

/**
 * Stable id for a single dispatch tween. Same triple → same id, so
 * duplicate WS deliveries collapse into one tween. The cls is sanitised
 * so a future autopilot class with dashes/underscores stays safe as a
 * DOM attribute value.
 */
export function tweenIdFor(turnN: number, cls: string, tsEpoch: number): string {
  const safeCls = cls.replace(/[^a-zA-Z0-9_-]/g, "");
  return `dispatch-tween-${turnN}-${safeCls}-${tsEpoch}`;
}

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TweenSpec {
  kind: "tween" | "instant";
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs: number;
  dustStartAtMs: number;
}

/**
 * Compute the render-side spec from the two rects.
 *
 * - When either rect is missing OR reducedMotion is true, returns an
 *   `instant` spec — the consumer should pop the sprite in place at
 *   `endX/endY` and unmount it after one frame.
 * - Otherwise an `tween` spec with the centre-of-rect coordinates.
 * - The dust-puff fires at `durationMs - dustStartAtMs` from the start,
 *   so by the time the sprite "lands" the puff has just started its
 *   200ms keyframe. Returning the offset (instead of an absolute time)
 *   keeps the function pure.
 */
export function tweenSpec(opts: {
  fromRect: RectLike | null | undefined;
  toRect: RectLike | null | undefined;
  reducedMotion?: boolean;
  durationMs?: number;
  dustDurationMs?: number;
}): TweenSpec {
  const durationMs = opts.durationMs ?? DISPATCH_TWEEN_DURATION_MS;
  const dustDurationMs = opts.dustDurationMs ?? DISPATCH_TWEEN_DUST_DURATION_MS;
  const reducedMotion = opts.reducedMotion === true;

  const toCenter = centerOf(opts.toRect);
  const fromCenter = centerOf(opts.fromRect);

  if (!toCenter) {
    // Nowhere to land — emit a stationary instant at origin so the
    // caller can unmount immediately. The render layer treats kind
    // === "instant" with no rect as a no-op (see DispatchTween.jsx).
    return {
      kind: "instant",
      startX: 0,
      startY: 0,
      endX: 0,
      endY: 0,
      durationMs,
      dustStartAtMs: durationMs - dustDurationMs,
    };
  }

  if (reducedMotion || !fromCenter) {
    return {
      kind: "instant",
      startX: toCenter.x,
      startY: toCenter.y,
      endX: toCenter.x,
      endY: toCenter.y,
      durationMs,
      dustStartAtMs: durationMs - dustDurationMs,
    };
  }

  return {
    kind: "tween",
    startX: fromCenter.x,
    startY: fromCenter.y,
    endX: toCenter.x,
    endY: toCenter.y,
    durationMs,
    dustStartAtMs: durationMs - dustDurationMs,
  };
}

function centerOf(rect: RectLike | null | undefined): { x: number; y: number } | null {
  if (!rect) return null;
  if (
    typeof rect.left !== "number" ||
    typeof rect.top !== "number" ||
    typeof rect.width !== "number" ||
    typeof rect.height !== "number"
  ) {
    return null;
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
