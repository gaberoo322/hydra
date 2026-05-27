/**
 * sprite-map.ts — class-to-Pokemon mapping for the /now-pixel habitat.
 *
 * Two distinct rules, decided in the slice-2 grilling session:
 *   1. **Pipeline classes** have a *fixed* sprite — operators learn
 *      "dev_orch is Mewtwo" once and never have to re-learn.
 *   2. **Signal classes** have a *pool* of habitat-matched candidates,
 *      and `pickSignalSprite()` selects one deterministically from the
 *      class's last-fired epoch (so the choice is stable per-fire — the
 *      user sees the same Pidgey for the same sweep, but a different
 *      one next sweep).
 *
 * The pools are stylistic — small, common encounter Pokemon for sweeps;
 * mysterious / detective-y Pokemon for discovers; the obvious healer
 * (Chansey) for health. Slice 3 of the epic (#642, #645).
 *
 * If/when the autopilot adds a new class, this file is the single point
 * of update — extending CLASS_TO_SPRITE / SIGNAL_POOLS is enough.
 */

// 7 pipeline class slots (matches `state.slots` in the autopilot
// state.json, schema_version=2).
export type PipelineClass =
  | "dev_orch"
  | "qa_orch"
  | "research_orch"
  | "design_concept_orch"
  | "dev_target"
  | "qa_target"
  | "research_target";

// 5 signal classes (matches `state.signal_last_fired` in the autopilot
// state.json). NB: `scout_orch` is calendar-driven and was deliberately
// not wired into the /now-pixel habitat in this slice — the operator's
// grilling session resolved it as out of scope.
export type SignalClass =
  | "health"
  | "sweep_orch"
  | "sweep_target"
  | "discover_orch"
  | "discover_target";

export type ClassName = PipelineClass | SignalClass;

/**
 * Pokemon ID → sprite filename. Pads to 3 digits and looks up the
 * vendored name from the slice-1 sprite set. Centralised so we never
 * spell "025-pikachu" wrong.
 */
const POKEDEX: Record<number, string> = {
  6: "006-charizard.png",
  10: "010-caterpie.png",
  13: "013-weedle.png",
  16: "016-pidgey.png",
  19: "019-rattata.png",
  21: "021-spearow.png",
  41: "041-zubat.png",
  54: "054-psyduck.png",
  65: "065-alakazam.png",
  79: "079-slowpoke.png",
  92: "092-gastly.png",
  95: "095-onix.png",
  96: "096-drowzee.png",
  104: "104-cubone.png",
  113: "113-chansey.png",
  122: "122-mr-mime.png",
  131: "131-lapras.png",
  133: "133-eevee.png",
  143: "143-snorlax.png",
  150: "150-mewtwo.png",
};

export function spriteFile(pokedexId: number): string {
  const f = POKEDEX[pokedexId];
  if (!f) throw new Error(`sprite-map: unknown Pokedex id ${pokedexId}`);
  return f;
}

/**
 * Pipeline class → fixed Pokemon ID. The mapping is intentional but
 * subjective; what matters is stability so operators build muscle
 * memory.
 */
export const CLASS_TO_SPRITE: Record<PipelineClass, number> = {
  // Orch side: psychic / engineer / designer / explorer tier
  dev_orch: 150, // Mewtwo — engineer-tier psychic
  qa_orch: 65, // Alakazam — careful psychic reviewer
  research_orch: 133, // Eevee — curious explorer
  design_concept_orch: 122, // Mr-mime — designer vibes
  // Target side: heavy hitters that ship product
  dev_target: 6, // Charizard — target's signature builder
  qa_target: 143, // Snorlax — heavyweight target reviewer
  research_target: 131, // Lapras — long-haul target explorer
};

/**
 * Signal class → pool of Pokemon IDs. `pickSignalSprite()` selects one
 * deterministically from the pool given a "seed" (typically the
 * last-fired epoch), so the same fire shows the same sprite across
 * polls but different fires show different sprites.
 */
export const SIGNAL_POOLS: Record<SignalClass, readonly number[]> = {
  health: [113], // Chansey — the obvious healer; singleton pool
  sweep_orch: [16, 19, 21], // Pidgey / Rattata / Spearow — common encounters
  sweep_target: [10, 13, 41], // Caterpie / Weedle / Zubat — different encounter set
  discover_orch: [54, 79, 96], // Psyduck / Slowpoke / Drowzee — psychic detectives
  discover_target: [92, 95, 104], // Gastly / Onix / Cubone — mysterious target finds
};

/**
 * Deterministic pool pick. `seed` is typically the signal's
 * `last_fired_epoch`; an epoch of 0 means "never fired" — we still
 * return a stable choice (index 0) so the sprite slot has something
 * to render when the operator first loads the page.
 */
export function pickSignalSprite(cls: SignalClass, seed: number): number {
  const pool = SIGNAL_POOLS[cls];
  if (!pool || pool.length === 0) {
    throw new Error(`sprite-map: empty signal pool for ${cls}`);
  }
  if (!Number.isFinite(seed) || seed <= 0) return pool[0];
  // Cheap deterministic hash — we only need uniform spread across a
  // tiny pool. Multiplicative-then-mod is plenty for that.
  const idx = Math.abs(Math.trunc(seed)) % pool.length;
  return pool[idx];
}

/**
 * Resolves the sprite filename a class should render with right now.
 * For pipeline classes this is the fixed Pokemon. For signals, it
 * picks from the pool keyed by `signalSeed` (the last-fired epoch).
 */
export function classSpriteFile(
  cls: ClassName,
  signalSeed: number | null | undefined,
): string {
  if (cls in CLASS_TO_SPRITE) {
    return spriteFile(CLASS_TO_SPRITE[cls as PipelineClass]);
  }
  const seed = typeof signalSeed === "number" ? signalSeed : 0;
  return spriteFile(pickSignalSprite(cls as SignalClass, seed));
}

export const PIPELINE_CLASSES: readonly PipelineClass[] = [
  "dev_orch",
  "qa_orch",
  "research_orch",
  "design_concept_orch",
  "dev_target",
  "qa_target",
  "research_target",
];

export const SIGNAL_CLASSES: readonly SignalClass[] = [
  "health",
  "sweep_orch",
  "sweep_target",
  "discover_orch",
  "discover_target",
];

/**
 * Side classification for the 2-column habitat layout. The Infirmary
 * (services strip) sits in the middle; `health` is scope-agnostic and
 * gets its own column.
 */
export type Side = "orch" | "target" | "center";

export const CLASS_SIDE: Record<ClassName, Side> = {
  // pipeline
  dev_orch: "orch",
  qa_orch: "orch",
  research_orch: "orch",
  design_concept_orch: "orch",
  dev_target: "target",
  qa_target: "target",
  research_target: "target",
  // signal
  sweep_orch: "orch",
  discover_orch: "orch",
  sweep_target: "target",
  discover_target: "target",
  health: "center",
};
