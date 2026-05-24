/**
 * Anchor-reference normalization.
 *
 * Turns the free-form `reference` string carried by every anchor (kanban
 * titles, codebase-health diagnostic strings, user-request prose) into a
 * stable token form that small wording differences collide into.
 *
 * Two consumers today:
 *   - `src/plan-cache.ts` — used inside `cacheKey()` so "Fix the cache" and
 *     "Fix the cache please!" hit the same cached plan.
 *   - `src/anchor-actionability.ts` — used for similarity tokenization
 *     against priorities-doc lines and recent merged tasks.
 *
 * The shape is owned here, not at either call site — that's the locality
 * fix from the 2026-05 architecture review (candidate #6). Anchor-ref
 * vocabulary lives next to the rest of the anchor-selection Module family.
 */

// Common English stopwords + Hydra anchor noise words that don't affect intent.
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "for", "with", "from", "to", "of",
  "in", "on", "at", "by", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "this", "that", "these", "those",
  "it", "its", "as", "if", "then", "than", "so", "into", "via", "using", "use",
]);

function tokenize(text: string): string[] {
  // Lowercase, strip parenthetical/bracket clauses, drop punctuation while
  // keeping path-like chars (so src/foo.ts and quick-fix survive intact).
  const cleaned = text
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")           // strip "(...)" clauses
    .replace(/\[[^\]]*\]/g, " ")          // strip "[...]" clauses
    .replace(/[^a-z0-9_./\- ]+/g, " ");   // keep word/path chars
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Normalize codebase-health references that follow the deterministic
 * "codebase-health: <category> in <file>" pattern emitted by
 * src/anchor-selection/codebase-health-tier.ts. Returns null if the
 * reference doesn't match the expected shape — caller falls back to
 * generic normalization.
 */
function normalizeHealthReference(reference: string): string | null {
  const match = reference.match(
    /^codebase-health:\s*(\S+)\s+in\s+(\S+?)\s*(?:\([^)]*\))?\s*$/i,
  );
  if (!match) return null;
  const [, category, file] = match;
  return `health|${category.toLowerCase()}|${file.toLowerCase()}`;
}

/**
 * Normalize an anchor reference into a stable string. Used as the plan-cache
 * key input AND as the actionability-similarity tokenization input.
 *
 * The codebase-health branch is structure-preserving (parses the deterministic
 * "codebase-health: <category> in <file>" shape into a `health|cat|file` key)
 * so plan-cache collides exact matches without the generic tokenizer dropping
 * the leading "codebase-health" prefix on the floor.
 */
export function normalizeReference(type: string, reference: string): string {
  if (type === "codebase-health") {
    const health = normalizeHealthReference(reference);
    if (health) return health;
  }
  // Generic: tokenize + sort so small wording differences collide.
  const tokens = tokenize(reference);
  tokens.sort();
  return tokens.join(" ");
}
