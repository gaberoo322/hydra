/**
 * Convention lint: no unannotated silent catches in src/ (issue #234).
 *
 * Bug context: silent catches caused every major incident in the 2026-04-07/08
 * debug session. CLAUDE.md requires every `catch` block to either log
 * `console.error` with structured context, OR carry an `/* intentional: <reason> *\/`
 * marker so reviewers can confirm the swallow is deliberate.
 *
 * Issues #120/#126/#127/#128/#234 swept the existing silent catches. This test
 * is the regression guard that prevents new ones from landing.
 *
 * Lint scope:
 *   - Scans src/*.ts and src/**\/*.ts (recursive).
 *   - Flags catch blocks with a truly empty body, i.e. matches
 *       `} catch { }`  or  `} catch (err) { }`
 *     where the body contains no statements and no `intentional:` comment.
 *   - A catch is considered annotated if the body or the trailing comment on
 *     the same line contains the literal substring `intentional:`.
 *
 * Out of scope:
 *   - Catches with a non-empty body (even `return null;`) — these are not
 *     "truly empty" per CLAUDE.md and the test description in #234. Author
 *     judgement applies; reviewers can request annotation in PR review.
 *   - Test files (test/**) and generated files (dashboard/dist, node_modules).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SRC_ROOT = new URL("../src/", import.meta.url).pathname;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      // Skip node_modules / dist if they ever appear under src/
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      out.push(...(await walk(full)));
    } else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Return the list of violations: `{ file, line, snippet }` for each truly-empty
 * unannotated catch in `content`. Exported as a pure function so it can be
 * unit-tested below.
 */
export function findUnannotatedEmptyCatches(content: string, file = "<inline>"): Array<{ file: string; line: number; snippet: string }> {
  const violations: Array<{ file: string; line: number; snippet: string }> = [];
  const lines = content.split("\n");

  // Pattern: `} catch` followed by optional `(ident)` followed by `{` and a body.
  // We match the catch keyword and then scan forward to the matching `}` to
  // extract the body. A simple regex on the whole content can't handle
  // multi-line bodies reliably, so we use a line-based scan keyed off the
  // `} catch ... {` opener.
  const opener = /(^|\s)} catch(?:\s*\([^)]*\))?\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(opener);
    if (!m) continue;

    // Find the position of the opening `{` of the catch body on this line.
    const braceIdx = line.indexOf("{", line.indexOf("catch", m.index ?? 0));
    if (braceIdx === -1) continue;

    // Collect body text until the matching `}` (brace-balanced, naive — this
    // is a lint regex, not a parser; nested braces inside the catch body are
    // simply treated as non-empty content which is the correct verdict).
    let depth = 1;
    let body = "";
    let endLine = i;
    let endCol = -1;
    let firstScan = true;
    for (let j = i; j < lines.length && depth > 0; j++) {
      const text = firstScan ? lines[j].slice(braceIdx + 1) : lines[j];
      firstScan = false;
      for (let k = 0; k < text.length; k++) {
        const ch = text[k];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            endLine = j;
            endCol = k;
            break;
          }
        }
        body += ch;
      }
      if (depth === 0) break;
      body += "\n";
    }

    if (endCol === -1) continue; // unbalanced — skip rather than false-positive

    // The body is "truly empty" if, after stripping comments and whitespace,
    // there are no statements left. We keep comments separately so we can
    // detect the `intentional:` marker even when it's the sole content.
    const hasIntentional = /intentional\s*:/.test(body);
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
      .replace(/\/\/[^\n]*/g, "")        // line comments
      .replace(/\s+/g, "");              // whitespace

    if (stripped.length === 0 && !hasIntentional) {
      violations.push({
        file,
        line: i + 1,
        snippet: lines[i].trim(),
      });
    }
  }

  return violations;
}

test("src/ has no unannotated silent catches (issue #234)", async () => {
  const files = await walk(SRC_ROOT);
  const allViolations: Array<{ file: string; line: number; snippet: string }> = [];

  for (const file of files) {
    const content = await readFile(file, "utf-8");
    const violations = findUnannotatedEmptyCatches(content, file);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    const lines = allViolations
      .map((v) => `  - ${v.file}:${v.line}  ${v.snippet}`)
      .join("\n");
    assert.fail(
      `Found ${allViolations.length} unannotated silent catch block(s) in src/. ` +
        `Per CLAUDE.md every catch must either log console.error with context, ` +
        `or carry an /* intentional: <reason> */ marker. Offenders:\n${lines}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Unit tests for the pure detector — these run regardless of src/ contents
// and lock in the lint semantics so future changes to the regex can't
// silently disable the rule.
// ---------------------------------------------------------------------------

test("detector flags truly empty catch with no marker", () => {
  const src = `function f() { try { x(); } catch { } }`;
  const v = findUnannotatedEmptyCatches(src);
  assert.equal(v.length, 1);
});

test("detector flags empty catch with named error and no marker", () => {
  const src = `function f() { try { x(); } catch (err) { } }`;
  const v = findUnannotatedEmptyCatches(src);
  assert.equal(v.length, 1);
});

test("detector accepts catch annotated with /* intentional: ... */", () => {
  const src = `function f() { try { x(); } catch { /* intentional: ignore */ } }`;
  const v = findUnannotatedEmptyCatches(src);
  assert.equal(v.length, 0);
});

test("detector accepts catch with a logging body", () => {
  const src = [
    `function f() {`,
    `  try { x(); } catch (err) {`,
    `    console.error("boom", err);`,
    `  }`,
    `}`,
  ].join("\n");
  const v = findUnannotatedEmptyCatches(src);
  assert.equal(v.length, 0);
});

test("detector accepts catch with a non-empty return body", () => {
  const src = `function f() { try { return JSON.parse(x); } catch { return null; } }`;
  // Body is not truly empty (has `return null;`), so this is not a violation
  // per the issue #234 lint scope. Authors are encouraged to annotate these
  // too, but the regex test is intentionally narrower than full convention.
  const v = findUnannotatedEmptyCatches(src);
  assert.equal(v.length, 0);
});

test("detector accepts catch whose only body content is the intentional marker line-comment", () => {
  const src = `function f() { try { x(); } catch { // intentional: skip
  } }`;
  const v = findUnannotatedEmptyCatches(src);
  assert.equal(v.length, 0);
});

test("detector flags catch whose body comment is NOT the intentional marker", () => {
  const src = `function f() { try { x(); } catch { /* whatever */ } }`;
  const v = findUnannotatedEmptyCatches(src);
  assert.equal(v.length, 1);
});
