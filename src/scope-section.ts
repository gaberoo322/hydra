/**
 * scope-section — the "Files in scope" markdown-section parser (issue #4010).
 *
 * This leaf is a VERBATIM RELOCATION of `extractScopeFromBody` /
 * `extractOutOfScopeFromBody` / `extractSection` / `looksLikePath` out of
 * `scripts/ci/scope-check.ts`, not a second implementation. The promote guard
 * on `POST /api/autopilot/board-state/promote` (issue #4010, ADR-0034 §7)
 * must refuse an issue whose body carries no `## Files in scope` section —
 * otherwise `issue-label-validation.yml` reverts the label a moment later —
 * and the approved design-concept artifact (issue-4010, INV-5) requires it to
 * reuse "the existing extractScopeFromBody, never a re-implemented regex".
 * Relocating was forced by the build: tsconfig `rootDir` is `./src`, so a
 * `src/` module CANNOT import a `scripts/` module (the reverse direction
 * works — `scripts/ci/scope-check.ts` imports this leaf and re-exports the
 * two public parsers, so its own API surface and `test/ci-scope-check.test.mts`
 * are unchanged).
 *
 * One parser, two consumers: the CI scope gate reads it from
 * `scripts/ci/scope-check.ts` (unchanged import surface), the runtime promote
 * guard reads it from here. The issue-label-validation.yml workflow's bash
 * regex remains the documented second, drifting copy — adding a THIRD TS copy
 * here is exactly what this relocation avoids.
 *
 * Pure leaf: string in, string[] out. No I/O, no imports.
 */

/**
 * Extract the `## Files in scope` section's path entries from an issue/PR body.
 * Returns [] when the body has no such section — the promote guard's refusal
 * signal.
 */
export function extractScopeFromBody(body: string): string[] {
  return extractSection(body, /Files in scope/i);
}

/**
 * Issue #396: explicit "Files out of scope" block. Any changed file matching
 * one of these entries triggers a hard fail (unless justified — see
 * extractScopeJustifications, still owned by the CI script).
 */
export function extractOutOfScopeFromBody(body: string): string[] {
  return extractSection(body, /Files out of scope/i);
}

function extractSection(body: string, headerRe: RegExp): string[] {
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

/**
 * Heuristic: contains a slash or a recognised extension, no spaces. Exported
 * because `scripts/ci/scope-check.ts`'s justification parser
 * (extractScopeJustifications) shares the same path-likeness predicate — one
 * spelling, two call sites in the same family.
 */
export function looksLikePath(s: string): boolean {
  // Heuristic: contains a slash or a recognised extension, no spaces.
  if (/\s/.test(s)) return false;
  if (s.includes("/")) return true;
  if (/\.(ts|tsx|js|mjs|cjs|mts|cts|md|yml|yaml|json|sh|toml)$/.test(s)) return true;
  return false;
}
