/**
 * Shared YAML-subset parser for Hydra's operator-edited config files (extracted
 * by issue #2314 from the two byte-identical copies that lived in
 * `src/outcomes-yaml.ts` and `src/scheduler/chores/wiring-liveness.ts`).
 *
 * This Module owns ONE thing: the *grammar* of Hydra's tiny config-YAML subset —
 * the quote-aware comment-stripping state machine (`stripComment`), the scalar
 * coercion rule (`parseScalar`), and the single parameterized parse loop
 * (`parseConfigYaml`). It is deliberately **domain-agnostic**: it knows nothing
 * about `outcomes` or `entries`; the top-level key name and whether one-level
 * nested mappings are supported are passed in by the caller. Each config-specific
 * loader (`parseOutcomesYaml`, `parseLivenessYaml`) is a thin typed wrapper that
 * supplies its own key name and returns its own result shape — the domain schemas
 * and their zod validators stay separate (ADR-0016 deepening: concentrate the
 * grammar, not the schemas).
 *
 * Intentionally small. Supports only what the two config files document:
 *   - `#` comments (full-line and trailing)
 *   - blank lines
 *   - a single top-level `key:` introducing a list (the `topKey`)
 *   - `- key: value` list-item-as-mapping
 *   - subsequent `  key: value` lines belonging to the most recent list item
 *   - (when `nestedMappings` is true) a `key:` line with no value opens a
 *     ONE-LEVEL nested mapping on the item (e.g. liveness `minOverRuns:` →
 *     indented `value:` / `runs:` children)
 *   - scalar values: number, boolean, quoted string, bare string
 *
 * NEVER THROWS — all malformed input surfaces as `errors[]`, matching the loader
 * never-throw contract (CLAUDE.md fail-loud). No new runtime dependency: this is a
 * zero-dependency Node-stdlib tokenizer (ADR-0005).
 *
 * `nestedMappings` defaults to `false`. Outcomes MUST keep it false: with the flag
 * off, a `key:` line with an empty value coerces to the empty string (the historic
 * outcomes behavior), whereas with the flag on it opens a nested mapping. The two
 * behaviors are mutually exclusive on the empty-value branch, which is why the flag
 * is opt-in per caller rather than always-on.
 */

/** A single scalar a config field can hold in this subset. */
export type YamlScalar = string | number | boolean;

/**
 * A field value: a scalar, or (when `nestedMappings` is enabled) a one-level
 * nested mapping of scalars. The flat callers (outcomes) only ever see scalars.
 */
export type YamlValue = YamlScalar | Record<string, YamlScalar>;

/** The shared parse result. `entries` is the list parsed under the caller's `topKey`. */
export interface ConfigParseResult {
  ok: boolean;
  /** The parsed document shape: an optional list (under `topKey`) of record maps. */
  value: { entries?: Array<Record<string, YamlValue>> };
  errors: string[];
}

/** Options that parameterize the shared parse loop for a specific config file. */
export interface ParseConfigYamlOptions {
  /** The single top-level key that introduces the list (e.g. `"outcomes"`, `"entries"`). */
  topKey: string;
  /**
   * When true, a `key:` line with no value opens a ONE-LEVEL nested mapping on the
   * current list item (liveness `minOverRuns:`). When false (the default), such a
   * line is treated as a field whose value coerces to the empty string — the
   * historic outcomes behavior. MUST stay false for outcomes: enabling it changes
   * empty-value coercion.
   */
  nestedMappings?: boolean;
}

/**
 * Strip a trailing `# ...` comment, but only when the `#` is not inside a quoted
 * scalar. A small state machine tracks single/double quotes so a `#` inside
 * `"/api/foo#frag"` (or a quoted description) survives.
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
 * Parse the raw text of a config-YAML file into `{ ok, value, errors }`.
 *
 * `ok` is `true` only when zero structural errors were found; the caller still
 * runs its own schema validation on `value.entries` afterwards. The parser never
 * throws — malformed lines accumulate in `errors` so the caller can report every
 * problem at once.
 *
 * The loop is identical to the historic flat (outcomes) walk except for the three
 * branches gated by `nestedMappings`: tracking the item's own field indent,
 * opening a nested mapping on an empty-value key, and routing deeper lines into
 * that open mapping. With `nestedMappings:false` those branches are bypassed and
 * the loop reduces exactly to the original outcomes parse loop (empty-value keys
 * coerce to the empty string).
 */
export function parseConfigYaml(
  raw: string,
  options: ParseConfigYamlOptions,
): ConfigParseResult {
  const { topKey, nestedMappings = false } = options;
  const errors: string[] = [];
  const result: ConfigParseResult["value"] = {};
  const lines = raw.split("\n");

  let currentTopKey: string | null = null;
  let currentList: Array<Record<string, YamlValue>> | null = null;
  let currentItem: Record<string, YamlValue> | null = null;
  // Nested-mapping state (only used when `nestedMappings` is true): the open
  // one-level nested mapping (e.g. `minOverRuns:`), and the indent of the item's
  // own fields (a nested child must sit deeper than that).
  let currentNested: Record<string, YamlScalar> | null = null;
  let fieldIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const stripped = stripComment(rawLine);
    if (stripped.trim() === "") continue;

    // Count leading spaces to determine indentation level.
    const indent = stripped.length - stripped.replace(/^ */, "").length;
    const content = stripped.slice(indent);

    if (indent === 0) {
      currentNested = null;
      fieldIndent = -1;
      // Top-level key: `<topKey>:` (introduces list)
      const m = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!m) {
        errors.push(`line ${i + 1}: unrecognized top-level syntax: "${rawLine}"`);
        continue;
      }
      const key = m[1];
      const inline = m[2];
      currentTopKey = key;
      if (key === topKey) {
        currentList = [];
        result.entries = currentList;
        currentItem = null;
      } else {
        // Unknown top-level key — schema violation surfaces later when required
        // fields aren't found, but record a hint here too.
        errors.push(`line ${i + 1}: unknown top-level key '${key}' (expected '${topKey}')`);
      }
      if (inline.trim() !== "") {
        errors.push(`line ${i + 1}: inline value not supported for top-level key '${key}'`);
      }
    } else {
      // Indented line — must belong to a list item under `<topKey>:`.
      if (currentTopKey !== topKey || !currentList) {
        errors.push(`line ${i + 1}: indented content without enclosing '${topKey}:' list`);
        continue;
      }

      const itemMatch = content.match(/^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (itemMatch) {
        // New list item starting with `- key: value`
        currentItem = {};
        currentList.push(currentItem);
        currentNested = null;
        // The item's own fields sit at the indent of the chars after `- `.
        fieldIndent = indent + content.indexOf(itemMatch[1]);
        currentItem[itemMatch[1]] = parseScalar(itemMatch[2]);
        continue;
      }

      const fieldMatch = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (fieldMatch) {
        if (!currentItem) {
          errors.push(`line ${i + 1}: field '${fieldMatch[1]}' has no enclosing list item`);
          continue;
        }
        const fieldKey = fieldMatch[1];
        const fieldVal = fieldMatch[2];

        if (nestedMappings) {
          // A line deeper than the item's own fields belongs to the open nested map.
          if (currentNested && indent > fieldIndent) {
            currentNested[fieldKey] = parseScalar(fieldVal);
            continue;
          }

          // Back at the item-field indent: this is an item field.
          if (fieldVal.trim() === "") {
            // `key:` with no value opens a one-level nested mapping.
            const nested: Record<string, YamlScalar> = {};
            currentItem[fieldKey] = nested;
            currentNested = nested;
            continue;
          }
          currentNested = null;
        }

        currentItem[fieldKey] = parseScalar(fieldVal);
        continue;
      }

      errors.push(`line ${i + 1}: unrecognized indented syntax: "${rawLine}"`);
    }
  }

  return { ok: errors.length === 0, value: result, errors };
}
