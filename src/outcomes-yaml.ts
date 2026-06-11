/**
 * YAML-subset parser for the Target Outcomes config (extracted from
 * `src/outcomes.ts` by issue #933).
 *
 * This Module owns ONE thing: turning the raw text of
 * `config/direction/outcomes.yaml` into parsed records. Its Interface is
 * "raw text → `{ ok, value, errors }`" — deliberately separate from the
 * outcome-specific schema validation (`validateOutcome` in `src/outcomes.ts`),
 * so the parse edge cases (`#` inside quotes, scalar coercion, malformed
 * indentation) have their own test surface (`test/outcomes-yaml.test.mts`)
 * instead of only being exercised indirectly through the full `loadOutcomes`
 * path.
 *
 * Intentionally small. Supports only what `outcomes.yaml` documents:
 *   - `#` comments (full-line and trailing)
 *   - blank lines
 *   - top-level `key:` introducing a list
 *   - `- key: value` list-item-as-mapping
 *   - subsequent `  key: value` lines belonging to the most recent list item
 *   - scalar values: number, boolean, quoted string, bare string
 *
 * Returns `{ ok, value, errors }` so the loader can attribute errors to file
 * paths. Anything more elaborate is operator-edited and out of scope. Never
 * throws — all malformed input surfaces as `errors`, matching the loader's
 * never-throw contract.
 */

/** A single scalar a YAML field can hold in this subset. */
export type YamlScalar = string | number | boolean;

/** The parsed document shape: an optional `outcomes:` list of record maps. */
interface ParsedYaml {
  outcomes?: Array<Record<string, YamlScalar>>;
}

export interface ParseResult {
  ok: boolean;
  value: ParsedYaml;
  errors: string[];
}

/**
 * Strip a trailing `# ...` comment, but only when the `#` is not inside a
 * quoted scalar. A small state machine tracks single/double quotes so a `#`
 * inside `"/api/foo#frag"` survives.
 */
export function stripComment(line: string): string {
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

/**
 * Coerce a raw scalar token into its typed value.
 *
 *   - `""` → empty string
 *   - `true` / `false` → boolean
 *   - quoted (single or double) → the unquoted contents verbatim
 *   - integer or decimal (optional leading sign) → number
 *   - anything else → the bare string, trimmed
 */
export function parseScalar(raw: string): YamlScalar {
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

/**
 * Parse the raw text of `outcomes.yaml` into `{ ok, value, errors }`.
 *
 * `ok` is `true` only when zero structural errors were found; the loader still
 * runs outcome-specific schema validation on `value.outcomes` afterwards. The
 * parser never throws — malformed lines accumulate in `errors` so the loader
 * can report every problem at once.
 */
export function parseOutcomesYaml(raw: string): ParseResult {
  const errors: string[] = [];
  const result: ParsedYaml = {};
  const lines = raw.split("\n");

  let currentTopKey: string | null = null;
  let currentList: Array<Record<string, YamlScalar>> | null = null;
  let currentItem: Record<string, YamlScalar> | null = null;

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
