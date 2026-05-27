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
  // Pre-evolutions used by EVOLUTION_CHAINS below — needed for slice 6's
  // subagent-sprite rendering.
  4: "004-charmander.png",
  5: "005-charmeleon.png",
  6: "006-charizard.png",
  10: "010-caterpie.png",
  13: "013-weedle.png",
  16: "016-pidgey.png",
  19: "019-rattata.png",
  21: "021-spearow.png",
  41: "041-zubat.png",
  54: "054-psyduck.png",
  63: "063-abra.png",
  64: "064-kadabra.png",
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
 * Per-signal-class cooldown in seconds. Mirrors `decide.py:SIGNAL_COOLDOWNS`
 * (scripts/autopilot/decide.py). Slice 6 of /now-pixel uses this to drive
 * the ⏳ overlay on signal sprites: time-until-next-eligible-fire =
 * (last_fired_epoch + cooldown) - now.
 *
 * scout_orch is intentionally omitted — it's not surfaced on the habitat
 * grid.
 */
export const SIGNAL_COOLDOWNS: Record<SignalClass, number> = {
  health: 0, // always allowed; rate-limited by the signal itself
  sweep_orch: 900, // 15 min
  sweep_target: 900,
  discover_orch: 1800, // 30 min
  discover_target: 1800,
};

/**
 * Pokemon evolution chain — pre-evolution lookup.
 *
 * Slice 6 (#648) uses this to render subagent sprites as one stage
 * below their slot's parent. e.g. dev_target's parent is Charizard (6),
 * so subagents in that slot render as Charmeleon (5). qa_orch's parent
 * is Alakazam (65), so subagents render as Kadabra (64).
 *
 * Where a class's parent has no Gen-1 pre-evolution (Mewtwo, Eevee,
 * Snorlax, Lapras, Mr-mime), the consumer falls back to rendering the
 * parent at 75% scale + desaturated.
 */
export const EVOLUTION_CHAINS: Record<number, number> = {
  // Charmander → Charmeleon → Charizard
  6: 5,
  5: 4,
  // Abra → Kadabra → Alakazam
  65: 64,
  64: 63,
};

/**
 * Resolve the sprite filename for a subagent occupying a pipeline class
 * slot. Returns the pre-evolution if one exists; otherwise the parent.
 * Callers should set `desaturate: true` when no pre-evo was used.
 */
export function subagentSpriteFile(parentClass: PipelineClass): {
  spriteFile: string;
  desaturate: boolean;
} {
  const parentId = CLASS_TO_SPRITE[parentClass];
  const preEvoId = EVOLUTION_CHAINS[parentId];
  if (preEvoId != null) {
    return { spriteFile: spriteFile(preEvoId), desaturate: false };
  }
  return { spriteFile: spriteFile(parentId), desaturate: true };
}

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

/**
 * Class → speech-bubble color for the Oak town crier (slice 5 of #642).
 * Picked so orch-side and target-side classes have visually distinct
 * families: orch = forge/blue family, target = green/amber family,
 * health = healer pink. Values are CSS color strings.
 */
export const CLASS_BUBBLE_COLOR: Record<ClassName, string> = {
  // Orch side — blue / orange "Forge" family
  dev_orch: "#fb923c", // orange-400 (the "Forge" mentioned in the spec)
  qa_orch: "#60a5fa", // blue-400
  research_orch: "#a78bfa", // violet-400
  design_concept_orch: "#f472b6", // pink-400
  sweep_orch: "#7dd3fc", // sky-300
  discover_orch: "#c084fc", // purple-400
  // Target side — green / amber family
  dev_target: "#4ade80", // green-400
  qa_target: "#facc15", // yellow-400
  research_target: "#34d399", // emerald-400
  sweep_target: "#86efac", // green-300
  discover_target: "#fbbf24", // amber-400
  // Healer pink for the central health signal.
  health: "#f9a8d4", // pink-300
};

/**
 * Map any source identifier (`subagent_type`, slot name, free-form
 * "source") to a known class for color lookup. Falls back to a neutral
 * grey when nothing matches so the bubble still renders.
 */
export function resolveBubbleColor(source: string | null | undefined): string {
  if (!source) return "#9ca3af"; // zinc-400 fallback
  const key = source as ClassName;
  if (key in CLASS_BUBBLE_COLOR) return CLASS_BUBBLE_COLOR[key];
  // Some events come in with the skill name (hydra-dev, hydra-target-build,
  // etc.) instead of the class. Best-effort map them too.
  const fromSkill: Record<string, ClassName> = {
    "hydra-dev": "dev_orch",
    "hydra-qa": "qa_orch",
    "hydra-research": "research_orch",
    "hydra-target-build": "dev_target",
    "hydra-target-research": "research_target",
    "hydra-doctor": "health",
    "hydra-sweep": "sweep_orch",
    "hydra-target-sweep": "sweep_target",
    "hydra-discover": "discover_orch",
    "hydra-target-discover": "discover_target",
  };
  const resolved = fromSkill[source];
  return resolved ? CLASS_BUBBLE_COLOR[resolved] : "#9ca3af";
}
