import { useEffect, useRef, useState, useCallback } from "react";

/**
 * useSpriteAnimations — manage one-shot + steady-state sprite animations
 * for the /now-pixel habitat.
 *
 * Slice 4 of /now-pixel (epic #642, #646). The hook subscribes to the
 * `slot-event` WS frames the server-side slot-events bridge broadcasts
 * (see src/autopilot/slot-events-bridge.ts) and exposes a per-class
 * animation map.
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
 *   - thinking: persistent (NOT one-shot). Fired by the consumer
 *     (HabitatGrid) via `fireThinking(cls)` whenever its per-slot
 *     `deriveThinking` derivation flips that class into the inactivity
 *     window (slot occupied ≥30s, no token-delta). Cleared explicitly
 *     by the consumer via `clearAnimation(cls)` once tokens move again
 *     or the slot empties. Priority rules (issue #660 follow-up):
 *       - `hurt` MUST win — a failing subagent stays red even if it
 *         also went quiet. `fireThinking` is a no-op when the current
 *         animation is `hurt`.
 *       - one-shot success animations (`excited`, `cheering`) override
 *         `thinking` for their 1s lifetime; the consumer re-fires
 *         `thinking` on the next poll if the slot is still quiet.
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
export function useSpriteAnimations(ws) {
  const [animations, setAnimations] = useState({});
  const timersRef = useRef({});

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
  const fireHurt = useCallback((cls) => {
    if (timersRef.current[cls]) {
      clearTimeout(timersRef.current[cls]);
      timersRef.current[cls] = null;
    }
    setAnimations((prev) => ({ ...prev, [cls]: "hurt" }));
  }, []);

  /**
   * Persistent (not one-shot) animation — set the class into "thinking"
   * until the caller explicitly clears it. Hurt wins: if the current
   * animation is `hurt`, this is a no-op so a failing subagent stays
   * red. Idempotent — re-firing while already thinking does not nudge
   * the state object (preserves referential equality so consumers don't
   * re-render needlessly).
   */
  const fireThinking = useCallback((cls) => {
    setAnimations((prev) => {
      if (prev[cls] === "hurt") return prev;
      if (prev[cls] === "thinking") return prev;
      return { ...prev, [cls]: "thinking" };
    });
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
  }, []);

  return {
    animations,
    fireExcited,
    fireCheering,
    fireHurt,
    fireThinking,
    clearAnimation,
  };
}
