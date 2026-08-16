/**
 * scope-sections — the markdown scope-section parser family, as a pure
 * src-side leaf (issue #4010).
 *
 * These functions were extracted VERBATIM from `scripts/ci/scope-check.ts`
 * (issues #382/#396/#836) so runtime code under `src/` can reuse the ONE
 * existing "does this body declare a Files in scope section?" parser
 * instead of growing a third drifting copy of the rule (the
 * issue-label-validation.yml workflow's bash regex is already the second).
 * The /work promote guard (issue #4010, ADR-0034 §7) refuses to promote an
 * issue whose body declares no scope section — via
 * {@link extractScopeFromBody}, never a re-implemented regex.
 *
 * Why a relocation, not an import of the script: `tsconfig.json` pins
 * `rootDir: "./src"`, so a `src/` module importing `../../scripts/…` fails
 * the `tsc` build (TS6059). The parser therefore moved DOWN into src/ and
 * `scripts/ci/scope-check.ts` now imports + re-exports it from here — one
 * parser, one home, both consumers (the CI gate and the API route) on it.
 *
 * The CI gate keeps owning everything downstream of parsing (ratio
 * classification, env inputs, exit codes); this leaf owns only the
 * markdown-body → scope-entries projection. It is a PURE data leaf — no I/O,
 * no Express, no decisions — mirroring `src/board-labels.ts`.
 */

/**
 * Extract the `## Files in scope` entries from a PR/issue body. Each backticked
 * code-span and each plain bullet line inside the section contributes a path
 * (issue #836); the section runs until the next markdown heading or a sibling
 * section marker. Returns `[]` when the body declares no such section — the
 * exact signal the /work promote guard keys on.
 */
export function extractScopeFromBody(body: string): string[] {
  return extractSection(body, /Files in scope/i);
}

/**
 * Issue #396: explicit "Files out of scope" block. Any changed file matching
 * one of these entries triggers a hard fail (unless justified — see
 * extractScopeJustifications).
 */
export function extractOutOfScopeFromBody(body: string): string[] {
  return extractSection(body, /Files out of scope/i);
}

/**
 * Issue #396: parse `scope-justification:` blocks from the PR body. Each
 * block whitelists one or more out-of-scope files that the subagent
 * deliberately touched. Recognised forms (case-insensitive):
 *
 *   scope-justification: `src/foo.ts` — needed to update the test fixture
 *   scope-justification:
 *     - `src/foo.ts`
 *     - `src/bar.ts`
 *       reason: shared regression suite
 *
 * The parser is intentionally permissive: any backticked path appearing
 * within ~6 lines after a `scope-justification:` line is treated as
 * justified. Returns the set of justified file paths.
 */
export function extractScopeJustifications(body: string): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const justified: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*scope-justification\s*:/i.test(lines[i])) continue;
    // Grab paths from the marker line itself.
    const inline = Array.from(lines[i].matchAll(/`([^`]+)`/g)).map((m) => m[1].trim());
    inline.filter(looksLikePath).forEach((p) => justified.push(p));
    // Plus up to 6 trailing lines until we hit a blank/heading/new marker.
    for (let j = 1; j <= 6 && i + j < lines.length; j++) {
      const ln = lines[i + j];
      if (/^\s*$/.test(ln)) break;
      if (/^\s*#{1,6}\s/.test(ln)) break;
      if (/^\s*scope-justification\s*:/i.test(ln)) break;
      const paths = Array.from(ln.matchAll(/`([^`]+)`/g)).map((m) => m[1].trim());
      paths.filter(looksLikePath).forEach((p) => justified.push(p));
    }
  }
  return Array.from(new Set(justified));
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
 * Issue #2175: a path that belongs to the **Target** repo (`hydra-betting`),
 * not this orchestrator repo. A scope section that lists Target-repo siblings
 * (the cross-repo seam case) must NOT contribute them to the in-scope /
 * out-of-scope sets — the CHANGED_FILES of an orchestrator PR can never match a
 * `hydra-betting/…` path, so unioning it as in-scope is harmless noise, but
 * unioning it as out-of-scope would hard-fail nothing yet still pollute the
 * report. Filtering them out at extraction keeps the gate honest for legacy
 * issues whose bodies still leak Target paths (the render-side fix in
 * scripts/ci/hydra-prd-render.ts prevents NEW leakage).
 *
 * Boundary-anchored on the `hydra-betting` path segment (mirrors
 * `isTargetRepoPath` in scripts/ci/hydra-prd-render.ts) so an orchestrator file
 * like `src/hydra-betting-adapter.ts` is not mis-classified.
 */
export function isTargetRepoPath(path: string): boolean {
  const p = (path || "").trim();
  if (!p) return false;
  return /(^|\/)(gaberoo322\/)?hydra-betting(\/|$)/.test(p);
}

export function looksLikePath(s: string): boolean {
  // Heuristic: contains a slash or a recognised extension, no spaces.
  if (/\s/.test(s)) return false;
  if (s.includes("/")) return true;
  if (/\.(ts|tsx|js|mjs|cjs|mts|cts|md|yml|yaml|json|sh|toml)$/.test(s)) return true;
  return false;
}
