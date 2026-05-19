/**
 * Tool-scout slug canonicalization (issue #484).
 *
 * The scout discovers candidates from npm, GitHub topics, awesome-lists, and
 * web searches. The same tool surfaces with different identifiers across
 * those sources — `@tanstack/query` from npm, `tanstack-query` from a topic
 * tag, `react-query` from the legacy name. We need ONE canonical slug per
 * tool so the seen-list (see `seen-list.ts`) doesn't accumulate duplicate
 * entries for the same project.
 *
 * `canonicalizeSlug` is the single chokepoint — every call into the scout
 * filter pipeline routes through it before touching Redis.
 *
 * The alias map is deliberately small in Phase A. We expect the smoke test
 * (see playbook §5) to surface real-world collisions which then get pinned
 * here.
 */

// ---------------------------------------------------------------------------
// Curated alias map
// ---------------------------------------------------------------------------
//
// Keys are raw inputs the scout might encounter; values are the canonical
// slug. Keep entries sorted alphabetically by key.
//
// Phase A seeds this with one well-known multi-name project so the test
// suite has something to verify against. Operator/dev_orch adds more as
// they surface during real walks.
const KNOWN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "@tanstack/query": "tanstack-query",
  "@tanstack/react-query": "tanstack-query",
  "react-query": "tanstack-query",
  "tanstack/query": "tanstack-query",
  "tanstack-query": "tanstack-query",
});

/**
 * Lower-case + collapse separators to single hyphens. Pure string normalize;
 * does NOT consult the alias map. Exported for tests.
 */
export function normalizeSlug(raw: string): string {
  if (typeof raw !== "string") {
    throw new TypeError(`normalizeSlug: expected string, got ${typeof raw}`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new RangeError("normalizeSlug: empty input");
  }
  return (
    trimmed
      .toLowerCase()
      // Replace @scope/name with scope-name (npm scoped packages)
      .replace(/^@/, "")
      .replace(/\//g, "-")
      // Collapse whitespace / underscores / repeated punctuation to a hyphen
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      // Strip any character that isn't a-z0-9-
      .replace(/[^a-z0-9-]/g, "")
      // Trim leading/trailing hyphens
      .replace(/^-+|-+$/g, "")
  );
}

/**
 * Map an arbitrary tool identifier (npm name, repo slug, awesome-list bullet
 * text) to the canonical seen-list slug.
 *
 * Steps:
 * 1. Normalize (lower-case, kebab-case, strip junk).
 * 2. Look up the normalized form in `KNOWN_ALIASES`.
 * 3. If hit, return the alias target. Otherwise, return the normalized form.
 *
 * Idempotent: `canonicalizeSlug(canonicalizeSlug(x)) === canonicalizeSlug(x)`.
 */
export function canonicalizeSlug(raw: string): string {
  // We deliberately look up both the raw (lower-cased only) and normalized
  // forms so we catch `@tanstack/query` as-is BEFORE the `@` and `/` get
  // rewritten by `normalizeSlug`.
  const rawLower = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (rawLower.length > 0 && KNOWN_ALIASES[rawLower]) {
    return KNOWN_ALIASES[rawLower];
  }
  const normalized = normalizeSlug(raw);
  return KNOWN_ALIASES[normalized] ?? normalized;
}

/**
 * Expose the alias map for diagnostics / debugging. Returns a shallow copy so
 * callers can't mutate the source-of-truth.
 */
export function listKnownAliases(): Record<string, string> {
  return { ...KNOWN_ALIASES };
}
