/**
 * Target Outcomes loader (issue #241, ADR-0004 work-order step 1).
 *
 * Declares the structured contract between the target vision (prose) and
 * the orchestrator's behavior (code). Reads `config/direction/outcomes.yaml`,
 * validates schema, and exposes a typed value-fetch adapter for the `file`
 * source.
 *
 * Source seam (issue #933): `OutcomeSource` is `file` only — the one adapter
 * that is actually implemented. The earlier `prometheus | api | sql` arms were
 * stubs that logged and returned `null`; per LANGUAGE.md ("one adapter means a
 * hypothetical seam, two means a real one") a four-way union that only one arm
 * honours is a false promise to callers. They re-open as real arms the day a
 * SECOND source is implemented — see the FUTURE SOURCES note above
 * `getOutcomeValue`.
 *
 * Foundational dependency for #243/#244 (Tier-2 outcome holdback) and
 * the capacity-floor dispatcher (#245). (#242 stuckness detector retired
 * in ADR-0010.) Per CLAUDE.md conventions:
 *   - Never throws. All error paths return structured `{ ok: false, errors }`.
 *   - All errors logged with `[outcomes]` prefix.
 *   - Zero new dependencies — uses node:fs + a hand-rolled YAML subset parser
 *     (extracted to `src/outcomes-yaml.ts`, #933) covering only the schema this
 *     file documents (per CLAUDE.md operator-approved-deps rule).
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { parseOutcomesYaml, type YamlScalar } from "./outcomes-yaml.ts";

// Re-export the extracted YAML parser surface so existing importers of
// `parseOutcomesYaml` from this Module keep working (back-compat, #933).
export { parseOutcomesYaml, stripComment, parseScalar } from "./outcomes-yaml.ts";
export type { ParsedYaml, ParseResult, YamlScalar } from "./outcomes-yaml.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "", "hydra");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");
const DEFAULT_OUTCOMES_FILE = join(CONFIG_PATH, "direction", "outcomes.yaml");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutcomeKind = "leading" | "terminal";
export type OutcomeDirection = "up" | "down";
/**
 * Where an outcome's current value is read from. Today this is `file` only —
 * the single adapter that is actually implemented (#933). `prometheus | api |
 * sql` were live-looking stubs; they re-enter this union the day a real second
 * adapter lands (the "two adapters means a real seam" trigger, LANGUAGE.md).
 */
export type OutcomeSource = "file";

export interface Outcome {
  name: string;
  kind: OutcomeKind;
  direction: OutcomeDirection;
  source: OutcomeSource;
  query: string;
  baseline: number;
  target: number;
  noise_epsilon: number;
}

export interface OutcomeReading {
  value: number;
  ts: string;
}

export type LoadOutcomesResult =
  | { ok: true; outcomes: Outcome[] }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Schema validation
//
// The raw text → records parse lives in `src/outcomes-yaml.ts` (#933). This
// section owns the outcome-SPECIFIC rules (required fields, enums, ranges) and
// runs over the parser's `value.outcomes` records.
// ---------------------------------------------------------------------------

const VALID_KINDS: OutcomeKind[] = ["leading", "terminal"];
const VALID_DIRECTIONS: OutcomeDirection[] = ["up", "down"];
// Only `file` is a real source today (#933). A non-`file` `source:` is now a
// schema violation rather than a stub that silently reads as no-data.
const VALID_SOURCES: OutcomeSource[] = ["file"];

function validateOutcome(
  raw: Record<string, YamlScalar>,
  index: number,
): { ok: true; outcome: Outcome } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const ctx = `outcome[${index}]${raw.name ? ` (${raw.name})` : ""}`;

  function requireString(field: string): string | null {
    const v = raw[field];
    if (typeof v !== "string" || v === "") {
      errors.push(`${ctx}: field '${field}' is required and must be a non-empty string`);
      return null;
    }
    return v;
  }

  function requireEnum<T extends string>(field: string, allowed: readonly T[]): T | null {
    const v = raw[field];
    if (typeof v !== "string" || !allowed.includes(v as T)) {
      errors.push(`${ctx}: field '${field}' must be one of [${allowed.join(", ")}], got '${v}'`);
      return null;
    }
    return v as T;
  }

  function requireNumber(field: string): number | null {
    const v = raw[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${ctx}: field '${field}' is required and must be a finite number`);
      return null;
    }
    return v;
  }

  const name = requireString("name");
  const kind = requireEnum("kind", VALID_KINDS);
  const direction = requireEnum("direction", VALID_DIRECTIONS);
  const source = requireEnum("source", VALID_SOURCES);
  const query = requireString("query");
  const baseline = requireNumber("baseline");
  const target = requireNumber("target");

  // noise_epsilon defaults to 0 if omitted.
  let noiseEpsilon = 0;
  if (raw.noise_epsilon !== undefined) {
    if (typeof raw.noise_epsilon !== "number" || !Number.isFinite(raw.noise_epsilon)) {
      errors.push(`${ctx}: field 'noise_epsilon' must be a finite number when provided`);
    } else {
      noiseEpsilon = raw.noise_epsilon;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (
    name === null ||
    kind === null ||
    direction === null ||
    source === null ||
    query === null ||
    baseline === null ||
    target === null
  ) {
    // Defensive — should be unreachable because errors would be non-empty.
    return { ok: false, errors: [`${ctx}: schema violation (unknown reason)`] };
  }

  return {
    ok: true,
    outcome: {
      name,
      kind,
      direction,
      source,
      query,
      baseline,
      target,
      noise_epsilon: noiseEpsilon,
    },
  };
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Load and validate `config/direction/outcomes.yaml`.
 *
 * Never throws. Returns:
 *   - `{ ok: true, outcomes }` on success
 *   - `{ ok: false, errors }` on parse or schema violations
 *
 * Missing file is treated as `{ ok: true, outcomes: [] }` per the
 * acceptance criterion ("missing file returns empty array, not crash").
 */
export async function loadOutcomes(filePath: string = DEFAULT_OUTCOMES_FILE): Promise<LoadOutcomesResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { ok: true, outcomes: [] };
    }
    const msg = `[outcomes] failed to read ${filePath}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, errors: [msg] };
  }

  const parsed = parseOutcomesYaml(raw);
  const errors: string[] = [...parsed.errors];

  const items = parsed.value.outcomes || [];
  const outcomes: Outcome[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const v = validateOutcome(items[i], i);
    if (v.ok === false) {
      errors.push(...(v as { ok: false; errors: string[] }).errors);
      continue;
    }
    const outcome = (v as { ok: true; outcome: Outcome }).outcome;
    if (seenNames.has(outcome.name)) {
      errors.push(`outcome[${i}] (${outcome.name}): duplicate 'name' — outcomes must be unique`);
      continue;
    }
    seenNames.add(outcome.name);
    outcomes.push(outcome);
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`[outcomes] ${e}`);
    return { ok: false, errors };
  }

  return { ok: true, outcomes };
}

// ---------------------------------------------------------------------------
// Source adapters
//
// FUTURE SOURCES (#933): only `file` is implemented. `prometheus`, `api`, and
// `sql` were live-looking stubs that logged + returned null; they were removed
// because a single real adapter is a HYPOTHETICAL seam, not a real one
// (LANGUAGE.md). When a SECOND source genuinely lands:
//   1. widen `OutcomeSource` to the new union member,
//   2. add its `case` arm + a real adapter below,
//   3. add it back to `VALID_SOURCES`,
//   4. update the `source` field doc in `config/direction/outcomes.yaml`.
// That second adapter is the "two adapters means a real seam" trigger that
// re-opens the dispatch switch for a genuine reason.
// ---------------------------------------------------------------------------

/**
 * Resolve an outcome's `query` for the `file` source.
 * Relative paths are resolved against HYDRA_ROOT to keep the schema portable.
 */
function resolveFilePath(query: string): string {
  return isAbsolute(query) ? query : resolve(HYDRA_ROOT, query);
}

async function readFileAdapter(query: string): Promise<OutcomeReading | null> {
  const path = resolveFilePath(query);
  try {
    const raw = await readFile(path, "utf-8");
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) {
      console.error(`[outcomes] file adapter: ${path} did not parse as a finite number (got "${raw.trim().slice(0, 60)}")`);
      return null;
    }
    let ts: string;
    try {
      const s = await stat(path);
      ts = s.mtime.toISOString();
    } catch {
      /* intentional: mtime stat failed but readFile succeeded — fall back
         to wall clock; the value itself is the load-bearing field, ts is
         informational. */
      ts = new Date().toISOString();
    }
    return { value, ts };
  } catch (err: any) {
    console.error(`[outcomes] file adapter: failed to read ${path}: ${err?.message || String(err)}`);
    return null;
  }
}

/**
 * Read the current value of an outcome from its declared source.
 *
 * Returns `null` when the source is unreachable / not yet adapted — never
 * throws. Downstream consumers treat null as no-data (does NOT count as a
 * regression).
 */
export async function getOutcomeValue(outcome: Outcome): Promise<OutcomeReading | null> {
  try {
    switch (outcome.source) {
      case "file":
        return await readFileAdapter(outcome.query);
      default:
        // Unreachable: schema validation rejects any non-`file` source today
        // (#933). Kept as a fail-loud guard for the day a second source lands.
        console.error(`[outcomes] unknown source '${(outcome as Outcome).source}' for outcome '${outcome.name}'`);
        return null;
    }
  } catch (err: any) {
    /* intentional: adapters already log; this is the safety net so a buggy
       adapter can never crash the cycle. */
    console.error(`[outcomes] adapter for '${outcome.name}' threw: ${err?.message || String(err)}`);
    return null;
  }
}

export { DEFAULT_OUTCOMES_FILE };

// ---------------------------------------------------------------------------
// Outcome Holdback helpers (issue #786, ADR-0004 step 4)
//
// Additive read-only helpers consumed by the Post-merge Regression Check (the
// Outcome Holdback producer). They live here, next to the loader + adapters,
// so the producer reads leading outcomes through the same seam every other
// consumer uses — never re-parsing outcomes.yaml itself.
//
// Invariant: only `kind: leading` outcomes ever drive a holdback decision.
// Terminal outcomes are too slow for any watch window (outcomes.yaml schema
// comment + CONTEXT.md) and are filtered out here so a caller cannot
// accidentally watch one.
// ---------------------------------------------------------------------------

/** One leading-outcome sample: the outcome's contract fields + current value. */
export interface LeadingOutcomeSample {
  name: string;
  direction: OutcomeDirection;
  /** Absolute change below this is treated as no-move. */
  noiseEpsilon: number;
  /** Current value, or null if the adapter returned no data (no-data, not 0). */
  value: number | null;
}

/**
 * Snapshot the current value of every `kind: leading` outcome.
 *
 * Returns one sample per leading outcome (terminal outcomes are excluded).
 * Adapter outages surface as `value: null` — never as a synthetic 0 — so the
 * regression detector can treat them as no-data rather than a false regression.
 * Never throws: a failed load yields an empty array (logged by `loadOutcomes`).
 */
export async function snapshotLeadingOutcomes(
  filePath: string = DEFAULT_OUTCOMES_FILE,
): Promise<LeadingOutcomeSample[]> {
  const result = await loadOutcomes(filePath);
  if (result.ok === false) return [];
  const leading = result.outcomes.filter((o) => o.kind === "leading");
  return Promise.all(
    leading.map(async (o) => {
      const reading = await getOutcomeValue(o);
      return {
        name: o.name,
        direction: o.direction,
        noiseEpsilon: o.noise_epsilon,
        value: reading?.value ?? null,
      };
    }),
  );
}

/**
 * Decide whether a single leading outcome has regressed vs its baseline.
 *
 * A regression is a move in the UNFAVORABLE direction (opposite `direction`)
 * whose magnitude EXCEEDS `noiseEpsilon`. A favorable move, a no-move (delta
 * ≤ epsilon), or missing data on either side is NOT a regression.
 *
 *   direction: "up"   → regressed when current < baseline by more than epsilon
 *   direction: "down" → regressed when current > baseline by more than epsilon
 *
 * Returns `false` (no regression) when either value is null — adapter outages
 * are no-data, never a synthetic regression (matches the historical watcher's
 * "no false revert" posture, docs/reference.md).
 */
export function isOutcomeRegressed(
  baselineValue: number | null,
  currentValue: number | null,
  direction: OutcomeDirection,
  noiseEpsilon: number,
): boolean {
  if (baselineValue == null || currentValue == null) return false;
  if (!Number.isFinite(baselineValue) || !Number.isFinite(currentValue)) return false;
  const eps = Number.isFinite(noiseEpsilon) ? Math.abs(noiseEpsilon) : 0;
  // Favorable delta is positive when moving the favorable way.
  const favorableDelta = direction === "up"
    ? currentValue - baselineValue
    : baselineValue - currentValue;
  // Regressed = moved unfavorably by MORE than epsilon.
  return favorableDelta < -eps;
}

/** A leading outcome that regressed past its noise epsilon vs baseline. */
export interface OutcomeRegression {
  name: string;
  baseline: number;
  current: number;
  direction: OutcomeDirection;
  noiseEpsilon: number;
}

/**
 * Compare a baseline snapshot against a current snapshot and return the leading
 * outcomes that regressed past their noise epsilon. The two arrays are matched
 * by outcome `name`; an outcome present in one but not the other, or with null
 * data on either side, is skipped (no-data, not a regression).
 *
 * Pure function — no I/O — so the producer (and its tests) can reason about the
 * revert decision deterministically.
 */
export function detectRegressions(
  baseline: Array<{ name: string; direction: OutcomeDirection; noiseEpsilon: number; value: number | null }>,
  current: Array<{ name: string; value: number | null }>,
): OutcomeRegression[] {
  const currentByName = new Map(current.map((c) => [c.name, c.value]));
  const regressions: OutcomeRegression[] = [];
  for (const b of baseline) {
    const cur = currentByName.has(b.name) ? currentByName.get(b.name)! : null;
    if (isOutcomeRegressed(b.value, cur, b.direction, b.noiseEpsilon)) {
      regressions.push({
        name: b.name,
        baseline: b.value as number,
        current: cur as number,
        direction: b.direction,
        noiseEpsilon: b.noiseEpsilon,
      });
    }
  }
  return regressions;
}
