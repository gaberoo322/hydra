import { useEffect, useRef, useState, useCallback } from "react";
import {
  DISPATCH_TWEEN_DURATION_MS,
  DISPATCH_TWEEN_DUST_DURATION_MS,
  tweenIdFor,
  tweenSpec,
} from "../pages/now-pixel/derive-dispatch-tween.ts";

/**
 * useSpriteAnimations — manage one-shot + steady-state sprite animations
 * for the /now-pixel habitat.
 *
 * Slice 4 of /now-pixel (epic #642, #646). The hook subscribes to the
 * `slot-event` WS frames the server-side slot-events bridge broadcasts
 * (see src/autopilot/slot-events-bridge.ts) and exposes a per-class
 * animation map.
 *
 * Slice E of autopilot observability (#667, #670) adds `fireTravel`
 * which spawns a transient dispatch tween: a portal-rendered sprite
 * that tweens from the Pavilion to a destination zone, ending with a
 * dust-puff keyframe. Tweens are keyed by a stable id (see
 * derive-dispatch-tween.ts → tweenIdFor) so duplicate WS deliveries
 * collapse into a single render entry instead of stacking.
 *
 * Animations:
 *   - excited: triggered when the consumer reports a new occupant for a
 *     slot via `fireExcited(cls)`. 1s one-shot, then auto-clears. Slot
 *     opens are derived from `/api/now/active-dispatches` deltas in the
 *     consumer (HabitatGrid), not from the WS stream — the autopilot
 *     hooks don't XADD a "slot opened" event today, so derivation is
 *     poll-based.
 *   - cheering: triggered on slot-event { event: subagent_stop, status:
 *     success }. 1s one-shot.
 *   - hurt: triggered on slot-event { event: subagent_stop, status:
 *     failure } OR by an explicit `fireHurt(cls)` call (e.g. burned-
 *     classes membership). Persists until `clearAnimation(cls)` is
 *     called or another success cheering supersedes it.
 *   - thinking: NOT implemented in slice 4. The full design (slot
 *     occupied + no token delta in 30s) needs per-slot partial_tokens
 *     diffing; slice 6 (#648) introduces subagent stats and will own
 *     the thinking-state derivation. The hook reserves the literal so
 *     future callers don't have to refactor.
 *
 * Graceful degradation: if the WebSocket disconnects, the hook stays
 * functional (it just stops receiving events). Excited triggered by
 * poll-deltas continues to fire because that derivation lives outside
 * the WS path. The Pavilion + zone grid keep updating from their 5-10s
 * polls regardless.
 */

const ONE_SHOT_DURATION_MS = 1000;

/**
 * Animation states (string literals; this is a .js file so no exported
 * union type, but consumers should treat these as the closed enum):
 *   "excited" | "cheering" | "hurt" | "thinking" | null
 */

/**
 * @param {{ subscribe: (type, cb) => () => void } | null | undefined} ws
 *        — the useWebSocket return; pass null when the consumer doesn't
 *        have one (tests).
 */
/**
 * Detect prefers-reduced-motion in an SSR-safe way. The dashboard is
 * client-rendered today but we guard window/matchMedia anyway so the
 * helper can be reused under node:test without polyfills.
 */
function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch (err) {
    /* intentional: matchMedia can throw in obscure browser test harnesses;
     * fall back to "no, animate" so the failure mode is more motion, not less.
     */
    console.error("[useSpriteAnimations] matchMedia failed:", err);
    return false;
  }
}

export function useSpriteAnimations(ws) {
  const [animations, setAnimations] = useState({});
  const timersRef = useRef({});
  // tweens: id → { spec, cls, turnN, tsEpoch, startedAt }
  // The DispatchTween component subscribes to this map and renders one
  // portal-positioned sprite per entry. Auto-unmount is timer-driven so
  // a closed WS / failed render doesn't leak entries.
  const [tweens, setTweens] = useState({});
  const tweenTimersRef = useRef({});

  const clearAnimation = useCallback((cls) => {
    setAnimations((prev) => {
      if (prev[cls] == null) return prev;
      const next = { ...prev };
      delete next[cls];
      return next;
    });
  }, []);

  const setOneShot = useCallback((cls, anim) => {
    setAnimations((prev) => ({ ...prev, [cls]: anim }));
    if (timersRef.current[cls]) clearTimeout(timersRef.current[cls]);
    timersRef.current[cls] = setTimeout(() => {
      timersRef.current[cls] = null;
      clearAnimation(cls);
    }, ONE_SHOT_DURATION_MS);
  }, [clearAnimation]);

  const fireExcited = useCallback((cls) => setOneShot(cls, "excited"), [setOneShot]);
  const fireCheering = useCallback((cls) => setOneShot(cls, "cheering"), [setOneShot]);

  /**
   * fireTravel(cls, fromRect, toRect, opts?) — spawn a one-shot tween
   * from `fromRect` (Pavilion screen rect) to `toRect` (destination zone
   * screen rect). Returns the tween-id consumed by the portal-rendered
   * DispatchTween component, or null if the inputs are unusable (the
   * caller doesn't usually have to handle null — it just means no
   * tween was queued).
   *
   * Identity: same (turn_n, cls, ts_epoch) triple → same id, so the
   * Strict-Mode double-invoke + the autopilot's at-least-once event
   * delivery don't double-stack a tween. `opts.turnN` / `opts.tsEpoch`
   * default to (0, Date.now()) for callers that don't have the WS
   * envelope handy (e.g. tests).
   *
   * Lifecycle: the entry is removed `durationMs + dustDurationMs` after
   * it lands so the dust-puff keyframe gets to finish before unmount.
   * If the component unmounts mid-tween the cleanup effect clears every
   * timer (no orphan unmount calls).
   */
  const fireTravel = useCallback((cls, fromRect, toRect, opts = {}) => {
    if (typeof cls !== "string" || cls.length === 0) return null;
    const turnN = typeof opts.turnN === "number" ? opts.turnN : 0;
    const tsEpoch = typeof opts.tsEpoch === "number" ? opts.tsEpoch : Date.now();
    const durationMs = typeof opts.durationMs === "number"
      ? opts.durationMs
      : DISPATCH_TWEEN_DURATION_MS;
    const dustDurationMs = typeof opts.dustDurationMs === "number"
      ? opts.dustDurationMs
      : DISPATCH_TWEEN_DUST_DURATION_MS;

    const reducedMotion = opts.reducedMotion ?? prefersReducedMotion();
    const spec = tweenSpec({
      fromRect,
      toRect,
      reducedMotion,
      durationMs,
      dustDurationMs,
    });
    const id = tweenIdFor(turnN, cls, tsEpoch);

    setTweens((prev) => {
      if (prev[id]) return prev; // dedupe identical envelopes
      return {
        ...prev,
        [id]: { id, cls, turnN, tsEpoch, spec, startedAt: Date.now() },
      };
    });

    if (tweenTimersRef.current[id]) {
      clearTimeout(tweenTimersRef.current[id]);
    }
    // Total lifetime = travel time + dust-puff tail. instant short-
    // circuit still gets a short visible window so the operator sees
    // the sprite land instead of it flashing for one frame.
    const lifetimeMs =
      spec.kind === "instant" ? dustDurationMs : durationMs + dustDurationMs;
    tweenTimersRef.current[id] = setTimeout(() => {
      tweenTimersRef.current[id] = null;
      setTweens((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, lifetimeMs);

    return id;
  }, []);
  const fireHurt = useCallback((cls) => {
    if (timersRef.current[cls]) {
      clearTimeout(timersRef.current[cls]);
      timersRef.current[cls] = null;
    }
    setAnimations((prev) => ({ ...prev, [cls]: "hurt" }));
  }, []);

  // WS subscription — slot-event frames carry the slot name + status.
  useEffect(() => {
    if (!ws || typeof ws.subscribe !== "function") return undefined;
    const off = ws.subscribe("slot-event", (frame) => {
      const slot = frame?.payload?.slot;
      const eventKind = frame?.payload?.event;
      const status = frame?.payload?.status;
      if (!slot) return;
      if (eventKind === "subagent_stop") {
        if (status === "success") fireCheering(slot);
        else if (status === "failure") fireHurt(slot);
        // Other statuses (no_op, budget_exceeded, unknown) are
        // intentionally silent — they don't map to a celebration or
        // crash animation.
      }
      // slot_waiting_permission could optionally drive a "thinking-
      // bubble" preview animation; deferred along with thinking.
    });
    return () => {
      off?.();
    };
  }, [ws, fireCheering, fireHurt]);

  // Cleanup all timers on unmount.
  useEffect(() => () => {
    for (const t of Object.values(timersRef.current)) {
      if (t) clearTimeout(t);
    }
    timersRef.current = {};
    for (const t of Object.values(tweenTimersRef.current)) {
      if (t) clearTimeout(t);
    }
    tweenTimersRef.current = {};
  }, []);

  return {
    animations,
    fireExcited,
    fireCheering,
    fireHurt,
    clearAnimation,
    tweens,
    fireTravel,
  };
}
