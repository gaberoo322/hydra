/**
 * YAML-subset parser for the Target Outcomes config (extracted from
 * `src/outcomes.ts` by issue #933; the shared grammar was then lifted into
 * `src/config-yaml.ts` by issue #2314).
 *
 * This Module is now a thin typed **wrapper** over the domain-agnostic grammar in
 * `src/config-yaml.ts`. It owns ONE thing: turning the raw text of
 * `config/direction/outcomes.yaml` into parsed records under the outcomes-specific
 * `{ outcomes?: [...] }` shape. Its Interface is "raw text → `{ ok, value, errors }`"
 * — deliberately separate from the outcome-specific schema validation
 * (`validateOutcome` in `src/outcomes.ts`).
 *
 * The grammar primitives (`stripComment`, `parseScalar`) and the parse loop live
 * in `src/config-yaml.ts` and are exercised by `test/config-yaml.test.mts`. They
 * are re-exported here for back-compat (existing importers + `test/outcomes-yaml.test.mts`).
 *
 * Outcomes uses the FLAT grammar (`nestedMappings:false`): a `key:` line with no
 * value coerces to the empty string, the historic behavior. Never throws — all
 * malformed input surfaces as `errors`, matching the loader's never-throw contract.
 */

import {
  parseConfigYaml,
  stripComment,
  parseScalar,
  type YamlScalar,
} from "./config-yaml.ts";

// Re-export the moved primitives for back-compat (existing importers and the
// edge-case test `test/outcomes-yaml.test.mts` import them from here).
export { stripComment, parseScalar, type YamlScalar };

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
 * Parse the raw text of `outcomes.yaml` into `{ ok, value, errors }`.
 *
 * A thin wrapper over {@link parseConfigYaml} with the outcomes top-level key and
 * the flat grammar (`nestedMappings:false`), re-mapping the shared `entries` list
 * onto the outcomes-specific `outcomes` field so the result shape is unchanged.
 *
 * `ok` is `true` only when zero structural errors were found; the loader still
 * runs outcome-specific schema validation on `value.outcomes` afterwards. The
 * parser never throws — malformed lines accumulate in `errors` so the loader can
 * report every problem at once.
 */
export function parseOutcomesYaml(raw: string): ParseResult {
  const parsed = parseConfigYaml(raw, { topKey: "outcomes" });
  const value: ParsedYaml = {};
  if (parsed.value.entries !== undefined) {
    // Outcomes is the flat grammar, so every field is a scalar (no nested maps).
    value.outcomes = parsed.value.entries as Array<Record<string, YamlScalar>>;
  }
  return { ok: parsed.ok, value, errors: parsed.errors };
}
