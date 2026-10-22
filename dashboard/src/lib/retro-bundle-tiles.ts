/**
 * retro-bundle-tiles.ts — pure trust derivation for the /runs/:runId
 * RunRetroBundle panel (issue #4634 review follow-up; ADR-0034 §5.1/§5.2).
 *
 * The retro-bundle assembler (src/autopilot/retro-bundle.ts) is never-throw:
 * a failed sub-source falls back to an EMPTY value (`[]`) and records
 * `{ source, detail }` in `errors[]`. Rendering that fallback as "0" would be
 * a confident zero for a value nobody measured. This module maps each failed
 * source to the count field(s) its fallback emptied, so the panel renders
 * those tiles (and the friction list) as UNKNOWN instead.
 *
 * Source names are the assembler's `safeSource` labels. A source this table
 * does not recognise is treated as possibly affecting EVERY count — the
 * fail-safe direction (UNKNOWN over a guessed zero).
 *
 * React-free so the orchestrator node:test suite can drive it directly
 * (test/runs-page.test.mts), the same lane as lib/delayed-commit.ts.
 */

export type RetroCountField =
  | "dispatches"
  | "dispatchOutcomes"
  | "reflections"
  | "stuckSignals"
  | "frictionPatterns";

/** The five count tiles, in render order. */
export const RETRO_COUNT_FIELDS: ReadonlyArray<{ field: RetroCountField; label: string }> = [
  { field: "dispatches", label: "dispatches" },
  { field: "dispatchOutcomes", label: "dispatch outcomes" },
  { field: "reflections", label: "reflections" },
  { field: "stuckSignals", label: "stuck signals" },
  { field: "frictionPatterns", label: "friction patterns" },
];

const ALL_FIELDS: RetroCountField[] = RETRO_COUNT_FIELDS.map((t) => t.field);

/**
 * Failed source → the count fields its empty fallback would falsely zero.
 * `[]` marks a source that feeds no count tile (it enriches rows or feeds a
 * field this panel does not render), so its failure shows only in the
 * partial-bundle line.
 */
export const RETRO_SOURCE_FIELDS: Readonly<Record<string, RetroCountField[]>> = {
  // The run record gates every per-run join (turns → dispatches → outcomes →
  // reflections); the ambient stuck-signal / friction reads do not depend on it.
  "run-record": ["dispatches", "dispatchOutcomes", "reflections"],
  "dispatch-outcomes": ["dispatchOutcomes"],
  reflections: ["reflections"],
  "stuck-signals": ["stuckSignals"],
  friction: ["frictionPatterns"],
  // Enrichment of already-projected dispatch rows — the count is unaffected.
  "cycle-metrics": [],
  "cycle-record": [],
  // Fields the panel does not render.
  recommendations: [],
  "cross-run-trend": [],
};

export interface RetroSourceError {
  source?: unknown;
  detail?: unknown;
}

/** The set of count fields a bundle's `errors[]` leaves unverified. */
export function unverifiedRetroFields(errors: unknown): Set<RetroCountField> {
  const out = new Set<RetroCountField>();
  if (!Array.isArray(errors)) return out;
  for (const e of errors as RetroSourceError[]) {
    const source = typeof e?.source === "string" ? e.source : "";
    const mapped = Object.prototype.hasOwnProperty.call(RETRO_SOURCE_FIELDS, source)
      ? RETRO_SOURCE_FIELDS[source]
      : ALL_FIELDS; // unrecognised source → fail safe
    for (const f of mapped) out.add(f);
  }
  return out;
}

export interface RetroCountTile {
  field: RetroCountField;
  label: string;
  /** The observed count, or null when its source failed (render UNKNOWN). */
  count: number | null;
}

/** The five tiles: an observed length, or null where the source failed. */
export function retroCountTiles(bundle: Record<string, unknown> | null | undefined): RetroCountTile[] {
  const unverified = unverifiedRetroFields(bundle?.errors);
  return RETRO_COUNT_FIELDS.map(({ field, label }) => {
    const value = bundle?.[field];
    return {
      field,
      label,
      count: unverified.has(field) ? null : Array.isArray(value) ? value.length : 0,
    };
  });
}

export interface TopFriction {
  /** True when the friction source failed — the list is UNKNOWN, not empty. */
  unknown: boolean;
  patterns: Array<Record<string, unknown>>;
}

/** The top `n` friction patterns by hitCount, or unknown when the source failed. */
export function topFrictionPatterns(
  bundle: Record<string, unknown> | null | undefined,
  n = 3,
): TopFriction {
  if (unverifiedRetroFields(bundle?.errors).has("frictionPatterns")) {
    return { unknown: true, patterns: [] };
  }
  const raw = Array.isArray(bundle?.frictionPatterns) ? (bundle!.frictionPatterns as Array<Record<string, unknown>>) : [];
  const patterns = raw
    .slice()
    .sort((a, b) => (Number(b?.hitCount) || 0) - (Number(a?.hitCount) || 0))
    .slice(0, n);
  return { unknown: false, patterns };
}

/**
 * The persistent amber "partial bundle" line, or null on a fully-clean
 * assembly. A non-empty `errors[]` ALWAYS yields a line — the assembler
 * answers 200 with a partial bundle, so the page must never render one as
 * complete.
 */
export function retroPartialLine(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const parts = (errors as RetroSourceError[]).map(
    (e) => `${typeof e?.source === "string" ? e.source : "unknown-source"}: ${String(e?.detail ?? "")}`,
  );
  return `partial bundle — ${errors.length} source(s) failed: ${parts.join(" · ")}`;
}
