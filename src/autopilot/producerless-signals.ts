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
 */
export const PRODUCERLESS_SIGNALS = new Map<string, string>([
  [
    "skill_prune_board_saturated",
    "anti-flood cap emitted by no script — decide.py reads it as a defensive suppressor; absent-as-false fail-opens the class",
  ],
  [
    "target_research_due",
    "legacy Redis-substrate signal, unproduced since the ADR-0031 GitHub-board migration (target_board_research_due is the produced mirror)",
  ],
  [
    "target_idle",
    "discover_target's gate — the playbook itself flags its production as 'a separate Target-side question'",
  ],
]);

/**
 * The selector TRIGGER reads (transcribed from decide.py's
 * `_select_slot_*` / `_select_signal_*` bodies) for every class that
 * reads a producerless signal as a dispatch trigger. A class whose
 * listed triggers are ALL in PRODUCERLESS_SIGNALS can never fire — the
 * **dead** status. research_target stays alive because its second
 * trigger (target_board_research_due) is produced; discover_target is
 * the one dead class today.
 */
export const CLASS_TRIGGER_INPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  research_target: Object.freeze(["target_research_due", "target_board_research_due"]),
  discover_target: Object.freeze(["target_idle"]),
});

/**
 * Producerless signals decide.py reads as ANTI-FLOOD SUPPRESSORS (the
 * `return None` guard checked before the trigger), not triggers: read
 * absent-as-false, so the producerless-ness fail-OPENS the class. A
 * suppressor can never make a class dead — but it must be classified
 * here so the drift pin can tell trigger from suppressor.
 */
export const PRODUCERLESS_SUPPRESSORS: ReadonlySet<string> = new Set([
  "skill_prune_board_saturated",
]);

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
