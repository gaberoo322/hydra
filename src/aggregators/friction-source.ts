/**
 * Friction-Pattern Read seam (issue #820).
 *
 * The `hydra:friction:{skill}:patterns` SCAN-and-parse loop was byte-identical
 * in three aggregators — `lessons-trend.ts`, `lessons-overnight.ts`, and
 * `friction-patterns.ts`. Each hand-rolled the same SCAN cursor walk, the same
 * `hydra:friction:` key-to-skill strip, and the same per-key JSON parse with
 * error isolation. Adding a new friction-key shape or fixing the parse meant
 * three identical edits.
 *
 * This module owns that read ONLY: SCAN + parse + per-key error isolation. It
 * deliberately does NOT own pattern validation, windowing, or promotion logic —
 * those stay in each consumer (their `liftFrictionPatterns` / `collectPromoted`
 * / `filterNearPromotion` steps narrow the permissive raw shape into their own
 * typed pattern). The `hydra:friction:*` store is owned by **Pattern Memory**
 * (`src/pattern-memory/`); this reader lives in the aggregator layer (sibling of
 * `types.ts`) so a friction reader does not mis-attribute ownership to
 * `src/metrics/`.
 *
 * Deletion test: remove this file and the identical SCAN-and-parse loop
 * re-concentrates in three aggregators — so the seam earns its place.
 *
 * **Redis seam.** The connection is pulled through `redis/connection.ts` only,
 * so `scripts/ci/redis-seam-check.ts` stays green (no `new Redis()`, no import
 * of `redis/keys` | `redis/kv`).
 */

/**
 * One `{skill, patterns}` tuple as read off Redis. `patterns` is whatever the
 * stored JSON array contained — the reader does not narrow it. Each consumer
 * supplies its own element type `P` and runs its existing lift/validate step.
 */
export interface FrictionGroup<P> {
  skill: string;
  patterns: P[];
}

/**
 * Scan every `hydra:friction:{skill}:patterns` key, parse each value as a JSON
 * array, and return one `{skill, patterns}` tuple per key. A value that is
 * missing, malformed, or not an array is skipped (logged via `console.error`
 * with `label`), never thrown — preserving each aggregator's "never throws"
 * parse-isolation contract.
 *
 * The element type `P` is the caller's responsibility: the reader casts the
 * parsed array to `P[]` without validating its members, so the caller's
 * lift/validate step remains the single place that narrows the shape.
 *
 * @param label log prefix identifying the calling aggregator (e.g.
 *   `"lessons-trend"`), so a parse failure is attributable in the logs.
 */
export async function readFrictionPatterns<P>(
  label: string,
): Promise<Array<FrictionGroup<P>>> {
  const { getRedisConnection } = await import("../redis/connection.ts");
  const r = getRedisConnection();
  const matches: string[] = [];
  let cursor = "0";
  do {
    const [next, page] = await r.scan(
      cursor,
      "MATCH",
      "hydra:friction:*:patterns",
      "COUNT",
      "200",
    );
    cursor = next;
    matches.push(...page);
  } while (cursor !== "0");

  const out: Array<FrictionGroup<P>> = [];
  for (const key of matches) {
    const skill = key.replace(/^hydra:friction:/, "").replace(/:patterns$/, "");
    const raw = await r.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push({ skill, patterns: parsed as P[] });
    } catch (err: any) {
      console.error(`[${label}] failed to parse ${key}: ${err?.message || err}`);
    }
  }
  return out;
}
