/**
 * scope-section — the "## Files in scope" markdown-section parser, as ONE pure
 * leaf shared by the CI scope gate and the runtime promote gate (issue #4010).
 *
 * `extractScopeFromBody` (+ its private `extractSection` / `looksLikePath`
 * helpers) previously lived only in `scripts/ci/scope-check.ts`. Issue #4010's
 * /work page adds a SECOND runtime consumer — the promote-to-ready-for-agent
 * refusal that mirrors the `issue-label-validation` workflow's precondition
 * ("the issue body MUST contain a `## Files in scope` section", issue #396) —
 * and `src/` cannot import a `scripts/` module (tsconfig `rootDir` is `./src`,
 * so a src→scripts edge fails typecheck with TS6059; see `src/worktree-orphan.ts`
 * for the same constraint recorded when that module was placed). The
 * issue-label-validation workflow's bash regex is ALREADY a second, drifting
 * copy of this rule; leaving the parser CI-only would have forced a THIRD copy
 * into `src/`. Relocating the one implementation here keeps the count at one.
 *
 * `scripts/ci/scope-check.ts` imports these verbatim (scripts→src imports are
 * the established direction — `mutation-check.ts`, `target-risk-core-check.ts`,
 * `branch-prune-runner.ts` already do it) and re-exports `extractScopeFromBody`
 * so its existing consumers (`test/ci-scope-check.test.mts`, the CI workflow)
 * keep their import paths unchanged. The code below is byte-for-byte the
 * pre-relocation implementation — behaviour is identical, home is not.
 *
 * Pure: no I/O, no deps. The section regex, the code-span/bullet union, and
 * the path heuristic stay in exactly one place.
 */

// ---------------------------------------------------------------------------
// extractSection + helpers — verbatim from scripts/ci/scope-check.ts
// ---------------------------------------------------------------------------

/** Path heuristic — exported for `scripts/ci/scope-check.ts`'s sibling extractors. */
export function looksLikePath(s: string): boolean {
  // Heuristic: contains a slash or a recognised extension, no spaces.
  if (/\s/.test(s)) return false;
  if (s.includes("/")) return true;
  if (/\.(ts|tsx|js|mjs|cjs|mts|cts|md|yml|yaml|json|sh|toml)$/.test(s)) return true;
  return false;
}

/**
 * The generic markdown-section extractor the scope/out-of-scope readers share.
 * Exported for `scripts/ci/scope-check.ts`'s sibling extractor
 * (`extractOutOfScopeFromBody`), which stayed CI-side — only the runtime-needed
 * half moved.
 */
export function extractSection(body: string, headerRe: RegExp): string[] {
  if (!body) return [];
  // Build a markdown-section regex anchored on the header keyword. The
  // section runs until the next markdown heading, a sibling section
  // (Risk / Implementation / Files in/out of scope / Acceptance), or EOF.
  const headerSource = headerRe.source.replace(/\\b/g, "");
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:##+\\s*|\\*\\*)?${headerSource}(?:\\*\\*)?\\s*[\\r\\n]+([\\s\\S]*?)(?=\\n\\s*(?:##+\\s|\\*\\*[A-Z])|\\n\\s*Files (?:in|out of) scope|\\n\\s*Risk\\b|\\n\\s*Implementation\\b|\\n\\s*Acceptance\\b|\\n\\s*scope-justification|\\n\\s*$|$)`,
    "i",
  );
  const m = body.match(re);
  if (!m) return [];
  const block = m[1];
  // Collect paths from BOTH code spans AND bullet/line entries (issue #836).
  // A single backticked path inside the section (e.g. from a scope-justification
  // line that the boundary lookahead failed to strip) must never suppress the
  // plain bullet-list entries — that early-return was the #836 regression.
  const codeSpans = Array.from(block.matchAll(/`([^`]+)`/g))
    .map((x) => x[1].trim())
    .filter(looksLikePath);
  const bulletPaths = block
    .split("\n")
    // Strip the bullet marker, THEN strip backticks so a backticked bullet
    // contributes the same clean path as the code-span branch (no corrupted
    // literal-backtick duplicate), then trim.
    .map((l) => l.replace(/^\s*[-*]\s+/, "").replace(/`/g, "").trim())
    .filter((l) => l && !l.startsWith("#"))
    .filter(looksLikePath);
  // Union, deduped — backticked-bullet and plain-bullet sections both stay
  // byte-identical to the pre-#836 behaviour; mixed sections now keep all paths.
  return Array.from(new Set([...codeSpans, ...bulletPaths]));
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function extractScopeFromBody(body: string): string[] {
  return extractSection(body, /Files in scope/i);
}

/**
 * True when an issue body carries a parseable `## Files in scope` section —
 * the `ready-for-agent` precondition (issue #396) the promote gate refuses on
 * and the `issue-label-validation` workflow enforces post-hoc. A section that
 * exists but extracts zero path-like entries does NOT count: the workflow
 * reverts the label on a missing SECTION, and a heading over no paths is the
 * same unscoped shape.
 */
export function hasScopeSection(body: string): boolean {
  return extractScopeFromBody(body).length > 0;
}
