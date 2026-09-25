/**
 * Producerless-signal classification — the dead-class selector input
 * (issue #4635, ADR-0034 §9.2 / PR #4617).
 *
 * `PRODUCERLESS_SIGNALS` is the name→rationale exemption list born in
 * `scripts/ci/signal-parity-check.ts` (issue #4519, continuing #4342's
 * list). The class-state backend (issue #4635) needs that same list at
 * runtime to derive the **dead** panel status — "a class whose every
 * selector trigger is a signal no producer emits" — but tsconfig.json
 * pins rootDir ./src and includes only src/**, so an src→scripts import
 * fails `npm run typecheck`. The established import direction is the
 * reverse (scripts/ci → ../../src, e.g. hydra-retro-emit.ts,
 * mutation-check.ts), so the Map moved HERE: a zero-I/O leaf with no
 * Redis, no filesystem, and no imports from the rest of src/. The CI
 * script re-exports it under the same name, so
 * test/decide-signal-classes.test.mts keeps compiling unchanged — one
 * home, no duplicate list.
 *
 * The two companion tables below classify HOW decide.py reads each
 * producerless signal, which is what decides deadness:
 *
 *   - a **trigger** (CLASS_TRIGGER_INPUTS) makes the class dispatch when
 *     present — every trigger producerless means the class can NEVER
 *     fire → dead;
 *   - a **suppressor** (PRODUCERLESS_SUPPRESSORS) is read absent-as-false
 *     → fail-OPENS the class, so a producerless suppressor keeps the
 *     class alive (flagging it dead would be a false alarm).
 *
 * Drift is honesty-tested in test/class-state.test.mts (INV-10 of the
 * issue-4635 design concept): every PRODUCERLESS_SIGNALS key must appear
 * in one of the two tables, every CLASS_TRIGGER_INPUTS literal must occur
 * in decide.py as a `_signal_present(state, events, "<sig>")` read, and
 * every CLASS_TRIGGER_INPUTS key must be a DISPATCH_CLASSES name — so a
 * newly-exempted signal fails the suite until it is classified.
 */

/**
 * Signals decide.py reads that have NO collect-state.sh producer, and so
 * can never have a Signal-wiring row (a row would claim a promotion hop
 * that does not exist). Each reads absent-as-false forever — the safe
 * direction for a suppressor or a mothballed lane's trigger. An entry
 * that GAINS a real producer must be removed at the same time its table
 * row is added. (Verbatim continuation of the #4342/#4519 list.)
 *
 * Issue #4607 EMPTIED this list (its three entries —
 * `skill_prune_board_saturated`, `target_research_due`, `target_idle` —
 * each gained a producer or lost its reader) and left this size-0
 * ratchet in its place: the map must stay empty, pinned by
 * test/decide-signal-classes.test.mts's "PRODUCERLESS_SIGNALS is EMPTY"
 * test. A new exemption is a deliberate, visible act — add the entry AND
 * update that pin (with the issue reference) in the same PR. The map
 * survives (rather than being deleted) because signal-parity-check L1,
 * the class-state dead derivation, and the honesty tests all consume it.
 */
export const PRODUCERLESS_SIGNALS = new Map<string, string>([]);

/**
 * The selector TRIGGER reads (transcribed from decide.py's
 * `_select_slot_*` / `_select_signal_*` bodies) for every class whose
 * dispatch triggers include a signal that is (or could become)
 * producerless. A class whose listed triggers are ALL in
 * PRODUCERLESS_SIGNALS can never fire — the **dead** status. Post-#4607
 * both rows list only PRODUCED signals, so no class is dead today — the
 * rows stay because they are how a future producerless trigger would be
 * classified (keep the drift pins honest, not vacuous).
 */
export const CLASS_TRIGGER_INPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  research_target: Object.freeze(["target_board_research_due"]),
  discover_target: Object.freeze(["target_backfill_idle"]),
});

/**
 * Producerless signals decide.py reads as ANTI-FLOOD SUPPRESSORS (the
 * `return None` guard checked before the trigger), not triggers: read
 * absent-as-false, so the producerless-ness fail-OPENS the class. A
 * suppressor can never make a class dead — but it must be classified
 * here so the drift pin can tell trigger from suppressor. Emptied by
 * #4607 (`skill_prune_board_saturated` gained a producer); stays empty
 * under the same size-0 ratchet as PRODUCERLESS_SIGNALS.
 */
export const PRODUCERLESS_SUPPRESSORS: ReadonlySet<string> = new Set([]);

/**
 * Derive the static **dead** classification for one dispatch class
 * (ADR-0034 §9.2, issue #4635 INV-9): true when the class has a
 * CLASS_TRIGGER_INPUTS entry AND every listed trigger is producerless.
 * Returns the deadReason naming the producerless trigger(s) + their
 * rationales, or null when the class is alive. Static — independent of
 * run state, verdict freshness, or cooldowns.
 */
export function deadClassification(
  className: string,
): { dead: true; deadReason: string } | { dead: false; deadReason: null } {
  const triggers = CLASS_TRIGGER_INPUTS[className];
  if (!triggers || triggers.length === 0) return { dead: false, deadReason: null };
  const producerless = triggers.filter((t) => PRODUCERLESS_SIGNALS.has(t));
  if (producerless.length !== triggers.length) {
    // At least one trigger has a real producer — the class can fire.
    return { dead: false, deadReason: null };
  }
  const parts = producerless.map((t) => `${t} (${PRODUCERLESS_SIGNALS.get(t)})`);
  return {
    dead: true,
    deadReason: `every selector trigger is producerless: ${parts.join("; ")}`,
  };
}
