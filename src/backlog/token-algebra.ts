// ---------------------------------------------------------------------------
// Merged-ref token algebra — the pure leaf of the MergedAnchorRefs Seam.
// ---------------------------------------------------------------------------
//
// Extracted from `src/backlog/merged-refs.ts` (issue #2677) so the pure
// token-normalization / overlap helpers no longer drag the gh-scan I/O
// machinery (`execFileViaSeam`, `getTargetGithubRepo()`) into scope at
// module-load time. A caller that imports only `titleSimilarity`
// (`src/backlog/items.ts`) or `subjectCoveredBy`
// (`src/backlog/stale-escalation.ts`) wants pure string algebra, not a
// subprocess seam — mirroring the `capacity-floor-classifier.ts` extraction
// (#2211) that separated pure arithmetic from the Redis-connected
// `capacity-floor.ts`.
//
// Everything in this module is PURE: it takes strings or plain objects and
// returns strings, numbers, or booleans. Zero I/O, zero clock, zero network,
// zero imports of side-effecting modules. The gh-scan I/O factory
// (`makeMergedAnchorRefsLoader`, `loadMergedAnchorRefsImpl`) lives in
// `src/backlog/merged-refs.ts` and imports the algebra it needs from here; that
// module also re-exports these symbols for back-compat so existing import sites
// (`./merged-refs.ts`) keep resolving unchanged.
//
// The two concerns have different growth axes: this token algebra evolves when
// the dedup/matching strategy changes; the gh-scan I/O evolves when the
// merge-lookback window or rate-limit handling changes. Separate Modules.

/**
 * Pure helper — exported for tests. Build the normalized identifier token-set
 * a merged PR contributes to the suppression set. A candidate is suppressed
 * when ANY of its identity tokens (see `candidateMergedTokens`) intersects this
 * set. We harvest:
 *   - every `#NNN` issue reference in the PR title + body (so a `Closes #882`
 *     marks issue 882's anchor merged),
 *   - every `item-NNN` reference (the target work-queue identity),
 *   - the normalized PR title itself (so a kanban anchor whose title equals the
 *     PR title is caught even without an explicit issue ref).
 */
export function mergedTokensFromPr(title: string, body: string): string[] {
  const tokens = new Set<string>();
  const haystack = `${title || ""}\n${body || ""}`;
  for (const m of haystack.matchAll(/#(\d+)\b/g)) tokens.add(m[1]);
  for (const m of haystack.matchAll(/\bitem-(\d+)\b/gi)) tokens.add(`item-${m[1]}`);
  const normTitle = normalizeIdentity(title);
  if (normTitle) tokens.add(normTitle);
  return [...tokens];
}

/**
 * Pure helper — exported for tests. Normalize a free-text identity for
 * comparison: lowercase, collapse whitespace, trim. Mirrors
 * `normalizeForDedup` in the work-queue adapter so the two dedup surfaces stay
 * consistent.
 */
export function normalizeIdentity(s: string): string {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Pure helper — exported for tests. Derive the identity tokens a candidate
 * matches against the merged-set. A candidate is "merged work" when any of
 * these is present in the merged-token set:
 *   - its `issue` field as a bare string (orchestrator issue number),
 *   - any `item-NNN` reference found in its issue/title/anchorRef,
 *   - its normalized title / anchorRef.
 */
export function candidateMergedTokens(c: {
  issue: string | number;
  title: string;
  anchorRef: string;
}): string[] {
  const tokens = new Set<string>();
  const issueStr = String(c.issue ?? "").trim();
  // A bare numeric issue id (kanban anchor) matches a `#NNN` merge ref.
  if (/^\d+$/.test(issueStr)) tokens.add(issueStr);
  const fields = [issueStr, c.title || "", c.anchorRef || ""];
  for (const f of fields) {
    for (const m of f.matchAll(/\bitem-(\d+)\b/gi)) tokens.add(`item-${m[1]}`);
    const norm = normalizeIdentity(f);
    if (norm) tokens.add(norm);
  }
  return [...tokens];
}

/**
 * Pure helper — exported for tests. True when the candidate's identity tokens
 * intersect the merged-work token set. Empty merged-set → never suppresses.
 */
export function isMergedWork(
  c: { issue: string | number; title: string; anchorRef: string },
  mergedRefs: ReadonlySet<string>,
): boolean {
  if (mergedRefs.size === 0) return false;
  for (const tok of candidateMergedTokens(c)) {
    if (mergedRefs.has(tok)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Subject fuzzy-match (issue #2110) — asymmetric containment.
// ---------------------------------------------------------------------------
//
// The stale-escalation pass in `src/backlog/reconciler.ts` (#2031) escalates a
// stale item to `blocked` ("unconfirmable-shipped") whenever NO merged
// `item-NNN`/`#NNN` token references it. But Hydra dev cycles routinely ship an
// item's work under a DIFFERENT title or sibling item id (squash "claude cycle"
// merges, item-412 shipping under item-455), carrying no matching token — so a
// 2026-06-18 operator triage found 24/26 escalations were actually-shipped
// (92% false-positive). This helper adds a subject fuzzy-match fallback so a
// stale item whose TITLE is covered by a recently-merged PR/commit subject is
// recognised as shipped and reconciled to `done` instead of escalated.
//
// Why a NEW helper and not the existing symmetric `titleSimilarity`
// (`src/backlog/items.ts`, `overlap / max(sizeA, sizeB)`): the `MergedRef.blob`
// is the PR title+body (or full commit message), which carries far MORE
// significant words than the bare item title, so the `max()` denominator
// inflates and genuine renamed shipments score 0.46–0.63 < 0.70 — the symmetric
// helper would MISS the very false-positives it targets (prototype-disproven,
// design-concept invariant). The fix is ASYMMETRIC containment: divide the
// overlap by the ITEM's word count only ("how much of the item title is covered
// by the blob"), so a blob that contains all of the item's significant words
// scores 1.00 regardless of how much extra body text surrounds them. Prototype:
// 3 real renamed shipments scored 1.00, 2 unrelated pairs scored 0.00 — clean
// separation at 0.70.

/**
 * SYMMETRIC word-overlap similarity (`overlap / max(sizeA, sizeB)`), extracted
 * from `src/backlog/items.ts` (issue #2110) so its symmetric form lives next to
 * the asymmetric `subjectCoveredBy` below and the contrast is visible in one
 * place. This is the helper backlog-CREATION dedup uses (two bare titles of
 * comparable length); it is deliberately NOT used for the merged-subject gate —
 * see the block comment below for why the `max()` denominator fails there. The
 * 4-significant-word guard mirrors `subjectCoverageScore`.
 */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  // Need at least 4 significant words in each title for fuzzy matching to be reliable.
  if (wordsA.size < 4 || wordsB.size < 4) return 0;
  const overlap = [...wordsA].filter((w) => wordsB.has(w)).length;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/**
 * Subject-match threshold — fraction of the item's significant words that must
 * appear in the merged-ref blob for the item to count as "shipped under a
 * renamed title". Mirrors the 0.70 `FUZZY_DEDUP_THRESHOLD` used for
 * backlog-creation dedup (`src/backlog/items.ts`); kept as a distinct constant
 * because this is a different consumer (escalation gating, not dedup) and the
 * two thresholds should be tunable independently.
 */
export const SUBJECT_MATCH_THRESHOLD = 0.7;

/**
 * Minimum number of significant words (length > 3) an item title must have for
 * a subject fuzzy-match to be considered (design-concept invariant). Short or
 * generic titles ("fix tests", "update docs") could spuriously hit an unrelated
 * blob and silently reconcile real open work, so they never subject-match.
 */
export const SUBJECT_MATCH_MIN_WORDS = 4;

/**
 * Pure helper — exported for tests. ASYMMETRIC containment score of an item
 * title against a merged-ref blob: the fraction of the item's significant
 * words (length > 3) that also appear in the blob.
 *
 *   score = |itemWords ∩ blobWords| / |itemWords|
 *
 * Returns 0 (never matches) when the item has fewer than
 * `SUBJECT_MATCH_MIN_WORDS` significant words — the short/generic-title guard.
 * Asymmetry is deliberate (see the block comment above): dividing by the item
 * word count, NOT `max(item, blob)`, keeps a renamed shipment at 1.00 even
 * though the blob (PR title+body / full commit message) dwarfs the item title.
 */
export function subjectCoverageScore(itemTitle: string, blob: string): number {
  if (typeof itemTitle !== "string" || typeof blob !== "string") return 0;
  const itemWords = new Set(
    itemTitle.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
  );
  if (itemWords.size < SUBJECT_MATCH_MIN_WORDS) return 0;
  const blobWords = new Set(
    blob.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3),
  );
  const overlap = [...itemWords].filter((w) => blobWords.has(w)).length;
  return overlap / itemWords.size;
}

/**
 * Pure helper — exported for tests. True when the item title is covered by the
 * merged-ref blob at or above `SUBJECT_MATCH_THRESHOLD`. This is the boolean
 * gate the reconciler's escalation pass consults: a true result means the item
 * demonstrably shipped under a renamed/sibling title, so it reconciles to
 * `done` rather than escalating to `blocked`.
 */
export function subjectCoveredBy(itemTitle: string, blob: string): boolean {
  return subjectCoverageScore(itemTitle, blob) >= SUBJECT_MATCH_THRESHOLD;
}

/**
 * Pure helper — exported for tests. Parse a `gh pr list --json title,body`
 * payload into the union of merged-identity tokens. Returns [] on any
 * structural problem (never throws).
 */
export function mergedTokensFromGhJson(jsonStdout: string): string[] {
  if (!jsonStdout || !jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    /* intentional: malformed gh JSON → [] per the documented never-throws contract */
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = new Set<string>();
  for (const pr of parsed) {
    if (!pr || typeof pr !== "object") continue;
    const title = typeof (pr as any).title === "string" ? (pr as any).title : "";
    const body = typeof (pr as any).body === "string" ? (pr as any).body : "";
    for (const tok of mergedTokensFromPr(title, body)) out.add(tok);
  }
  return [...out];
}
