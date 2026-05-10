/**
 * Target Outcomes loader (issue #241, ADR-0004 work-order step 1).
 *
 * Declares the structured contract between the target vision (prose) and
 * the orchestrator's behavior (code). Reads `config/direction/outcomes.yaml`,
 * validates schema, and exposes a typed value-fetch dispatcher per source
 * adapter (`prometheus`, `api`, `sql`, `file`).
 *
 * Foundational dependency for #242 (stuckness detector), #243/#244 (Tier-2
 * outcome holdback), and #245 (capacity floor classifier). Per CLAUDE.md
 * conventions:
 *   - Never throws. All error paths return structured `{ ok: false, errors }`.
 *   - All errors logged with `[outcomes]` prefix.
 *   - Zero new dependencies — uses node:fs + a hand-rolled YAML subset parser
 *     covering only the schema this file documents (per CLAUDE.md "Four
 *     dependencies" rule).
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "", "hydra");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");
const DEFAULT_OUTCOMES_FILE = join(CONFIG_PATH, "direction", "outcomes.yaml");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutcomeKind = "leading" | "terminal";
export type OutcomeDirection = "up" | "down";
export type OutcomeSource = "prometheus" | "api" | "sql" | "file";

export interface Outcome {
  name: string;
  kind: OutcomeKind;
  direction: OutcomeDirection;
  source: OutcomeSource;
  query: string;
  baseline: number;
  target: number;
  stuckness_threshold_cycles: number;
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
// YAML subset parser
//
// Intentionally small. Supports only what `outcomes.yaml` documents:
//   - `#` comments (full-line and trailing)
//   - blank lines
//   - top-level `key:` introducing a list
//   - `- key: value` list-item-as-mapping
//   - subsequent `  key: value` lines belonging to the most recent list item
//   - scalar values: number, boolean, quoted string, bare string
//
// Returns `{ ok, value }` so the loader can attribute errors to file paths.
// Anything more elaborate is operator-edited and out of scope for this issue.
// ---------------------------------------------------------------------------

function stripComment(line: string): string {
  // Strip trailing `# ...` but only when not inside quotes. Schema doesn't
  // currently use `#` inside values, but be safe with a small state machine.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  // numeric (int or decimal, optional sign)
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

interface ParsedYaml {
  outcomes?: Array<Record<string, string | number | boolean>>;
}

interface ParseResult {
  ok: boolean;
  value: ParsedYaml;
  errors: string[];
}

export function parseOutcomesYaml(raw: string): ParseResult {
  const errors: string[] = [];
  const result: ParsedYaml = {};
  const lines = raw.split("\n");

  let currentTopKey: string | null = null;
  let currentList: Array<Record<string, string | number | boolean>> | null = null;
  let currentItem: Record<string, string | number | boolean> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const stripped = stripComment(rawLine);
    if (stripped.trim() === "") continue;

    // Count leading spaces to determine indentation level.
    const indent = stripped.length - stripped.replace(/^ */, "").length;
    const content = stripped.slice(indent);

    if (indent === 0) {
      // Top-level key: `outcomes:` (introduces list)
      const m = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!m) {
        errors.push(`line ${i + 1}: unrecognized top-level syntax: "${rawLine}"`);
        continue;
      }
      const key = m[1];
      const inline = m[2];
      currentTopKey = key;
      if (key === "outcomes") {
        currentList = [];
        result.outcomes = currentList;
        currentItem = null;
      } else {
        // Unknown top-level key — schema violation surfaces later when
        // required fields aren't found, but record a hint here too.
        errors.push(`line ${i + 1}: unknown top-level key '${key}' (expected 'outcomes')`);
      }
      if (inline.trim() !== "") {
        errors.push(`line ${i + 1}: inline value not supported for top-level key '${key}'`);
      }
    } else {
      // Indented line — must belong to a list item under `outcomes:`.
      if (currentTopKey !== "outcomes" || !currentList) {
        errors.push(`line ${i + 1}: indented content without enclosing 'outcomes:' list`);
        continue;
      }

      const itemMatch = content.match(/^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (itemMatch) {
        // New list item starting with `- key: value`
        currentItem = {};
        currentList.push(currentItem);
        const key = itemMatch[1];
        const value = itemMatch[2];
        currentItem[key] = parseScalar(value);
        continue;
      }

      const fieldMatch = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (fieldMatch) {
        if (!currentItem) {
          errors.push(`line ${i + 1}: field '${fieldMatch[1]}' has no enclosing list item`);
          continue;
        }
        const key = fieldMatch[1];
        const value = fieldMatch[2];
        currentItem[key] = parseScalar(value);
        continue;
      }

      errors.push(`line ${i + 1}: unrecognized indented syntax: "${rawLine}"`);
    }
  }

  return { ok: errors.length === 0, value: result, errors };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const VALID_KINDS: OutcomeKind[] = ["leading", "terminal"];
const VALID_DIRECTIONS: OutcomeDirection[] = ["up", "down"];
const VALID_SOURCES: OutcomeSource[] = ["prometheus", "api", "sql", "file"];

function validateOutcome(
  raw: Record<string, string | number | boolean>,
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
  const stuckness = requireNumber("stuckness_threshold_cycles");

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
    target === null ||
    stuckness === null
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
      stuckness_threshold_cycles: stuckness,
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
      ts = new Date().toISOString();
    }
    return { value, ts };
  } catch (err: any) {
    console.error(`[outcomes] file adapter: failed to read ${path}: ${err?.message || String(err)}`);
    return null;
  }
}

async function apiAdapter(query: string): Promise<OutcomeReading | null> {
  // Stub: real wiring is operator-defined. We log + return null so callers
  // (#242 stuckness detector) treat unreachable as no-data, never crash.
  console.error(`[outcomes] api adapter: not yet implemented (query='${query}'); returning null`);
  return null;
}

async function prometheusAdapter(query: string): Promise<OutcomeReading | null> {
  console.error(`[outcomes] prometheus adapter: not yet implemented (query='${query}'); returning null`);
  return null;
}

async function sqlAdapter(query: string): Promise<OutcomeReading | null> {
  console.error(`[outcomes] sql adapter: not yet implemented (query='${query}'); returning null`);
  return null;
}

/**
 * Read the current value of an outcome from its declared source.
 *
 * Returns `null` when the source is unreachable / not yet adapted — never
 * throws. The downstream stuckness detector (#242) treats null as no-data
 * (does NOT count as a regression) per acceptance criteria of that issue.
 */
export async function getOutcomeValue(outcome: Outcome): Promise<OutcomeReading | null> {
  try {
    switch (outcome.source) {
      case "file":
        return await readFileAdapter(outcome.query);
      case "api":
        return await apiAdapter(outcome.query);
      case "prometheus":
        return await prometheusAdapter(outcome.query);
      case "sql":
        return await sqlAdapter(outcome.query);
      default:
        // Should be unreachable thanks to schema validation.
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
