/**
 * Autopilot recommendation-engine MATERIALITY-GATE leaf (issue #3099).
 *
 * The pure, deterministic decision logic that gates whether the recs engine
 * fires a (daily-capped) LLM call this turn. This is the deepest concern: a
 * false negative here ("nothing changed") silently skips a call that should
 * have fired, and the daily-spend cap it short-circuits on is the sole
 * sanctioned real-USD surface (CONTEXT.md L203 / ADR-0005).
 *
 * ## Why this is a standalone leaf
 *
 * This section (SECTION 2 of `recommendation-engine.ts`) is purely computation:
 * no I/O, no state mutation, no import-time side effects. Identical input yields
 * byte-identical output, independent of slot key order. It was re-extracted from
 * the engine coordinator by #3099 — mirroring exactly what #2867 did for the
 * prompt-grammar concern — so a test of this gate can import it WITHOUT pulling
 * in the Anthropic Request Adapter, the Redis seam, or the prompt builder at
 * module-load time. The gate is the highest-consequence concern in the engine;
 * a pure leaf gives its policy an independent, narrow test surface.
 *
 * The engine coordinator (`recommendation-engine.ts`) imports from here and
 * re-exports the symbols it needs, so the `EngineDeps` / `LlmResult` surface
 * `recommendation-consumer.ts` consumes stays unchanged and the existing
 * `test/recommendation-engine.test.mts` import paths stay zero-diff.
 *
 * The gate has two halves:
 *   1. A material-change *signature* — `computeMaterialChangeSignature` +
 *      `summariseSlotStatus` — a stable string over the state that changes
 *      between material-change triggers (new dispatch, new permission-wait,
 *      new outcome, autopilot status flip).
 *   2. The *fire decision* — `shouldFire` — which orders cap > interval >
 *      no-change > proceed so the cap always short-circuits first.
 *
 * The leaf imports ONLY the `PermissionWaitEvent` and `SlotSnapshot` types from
 * `recommendation-prompt.ts` (itself a zero-IO leaf, #2867) — no runtime code.
 */

import type { PermissionWaitEvent, SlotSnapshot } from "./recommendation-prompt.ts";

/** Minimum seconds between LLM calls for a given run. */
export const MIN_CALL_INTERVAL_SECONDS = 30;

/**
 * Derive a deterministic material-change signature from the engine inputs.
 * The signature MUST be a function only of state that changes between
 * material-change triggers (new dispatch, new permission-wait, new outcome,
 * autopilot status flip). When the signature matches the last-call
 * signature, the engine skips this turn even if the 30s window has passed.
 *
 * Format: a short delimited string. We avoid JSON.stringify to keep the
 * comparison cheap and stable under key-order drift.
 */
export function computeMaterialChangeSignature(input: {
  dispatches: number;
  permission_waits: PermissionWaitEvent[];
  slot_status_summary: string;
  autopilot_running: boolean;
}): string {
  const permParts = input.permission_waits
    .slice(0, 5)
    .map((e) => `${e.slot}@${e.ts_epoch}`)
    .join(",");
  return [
    `d=${input.dispatches}`,
    `r=${input.autopilot_running ? "1" : "0"}`,
    `s=${input.slot_status_summary}`,
    `p=${permParts}`,
  ].join("|");
}

/**
 * Reduce a slot snapshot to a compact stable string for the signature
 * computation. Slots are sorted by name so the output is deterministic
 * regardless of iteration order.
 */
export function summariseSlotStatus(snapshot: SlotSnapshot): string {
  const entries = Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([slot, info]) => `${slot}:${info?.status ?? "?"}`).join(",");
}

/**
 * Decision: should the engine fire this turn? Pure function — exported for
 * tests. Returns one of:
 *
 *   { proceed: true }                                                — fire
 *   { proceed: false, skip_reason: "cap" }                          — daily cap reached
 *   { proceed: false, skip_reason: "interval" }                     — too soon
 *   { proceed: false, skip_reason: "no-change" }                    — no material change
 *
 * The order matters: "cap" beats "interval" beats "no-change" so the
 * caller can surface the most specific reason. The cap MUST short-circuit
 * first so a capped day never fires an LLM call.
 */
export type ShouldFireDecision =
  | { proceed: true }
  | { proceed: false; skip_reason: "cap" | "interval" | "no-change" };

export function shouldFire(input: {
  now_epoch: number;
  last_call_epoch: number | null;
  current_signature: string;
  last_signature: string | null;
  daily_spend_usd: number;
  daily_cap_usd: number;
}): ShouldFireDecision {
  if (input.daily_spend_usd >= input.daily_cap_usd) {
    return { proceed: false, skip_reason: "cap" };
  }
  if (input.last_call_epoch !== null) {
    const since = input.now_epoch - input.last_call_epoch;
    if (since < MIN_CALL_INTERVAL_SECONDS) {
      return { proceed: false, skip_reason: "interval" };
    }
  }
  if (input.last_signature !== null && input.last_signature === input.current_signature) {
    return { proceed: false, skip_reason: "no-change" };
  }
  return { proceed: true };
}
