#!/usr/bin/env -S npx tsx
/**
 * scripts/ci/scope-check.ts — Scope enforcement CI gate (issue #382).
 *
 * Re-homes the in-cycle scope enforcement gate (was step 6.9 of the codex
 * control loop, in src/scope-enforcement.ts) so PRs from any source —
 * hydra-dev, hydra-target-build, manual operator branches — get the same
 * safety net once the codex CLI is removed (PR-3).
 *
 * Failure semantics: exit 2 when >80% of changed files are out-of-scope
 * AND more than 3 files are out-of-scope (matches the in-cycle gate
 * thresholds in src/scope-enforcement.ts). Exit 0 otherwise.
 *
 * Definition of in-scope (per issue #382 AC):
 *   - Files matched by the PR body's "Files in scope" / "## Files in scope"
 *     markdown section, OR
 *   - Files matched by the linked issue's "Files in scope" section.
 *   The matching is a substring/prefix match so directories ("src/foo/")
 *   match every file beneath them.
 *
 * Quick-fix bypass: if the PR body contains "[quick-fix]" the gate exits 0
 * with a "neutral" note in the step summary. This mirrors the in-cycle
 * exemption for quick-fix anchors.
 *
 * Inputs (env, with CI-friendly defaults):
 *   PR_BODY            — text of the PR body
 *   ISSUE_BODY         — text of the linked issue body (optional)
 *   CHANGED_FILES      — newline-separated list of changed files
 *   SCOPE_OUT_OF_SCOPE_THRESHOLD — float 0..1, default 0.8
 *   SCOPE_MIN_OUT_OF_SCOPE_COUNT — int, default 3
 *
 * Output: JSON report on stdout. Step-summary-friendly markdown on stderr.
 *
 * Exit codes:
 *   0 — pass (in scope, or quick-fix, or no diff)
 *   2 — scope gate failed (block merge)
 *   1 — usage / unexpected error
 */

const DEFAULT_RATIO = 0.8;
const DEFAULT_MIN_COUNT = 3;

export function extractScopeFromBody(body: string): string[] {
  if (!body) return [];
  // Match "Files in scope" header (markdown ## or bold) up to the next header.
  // Issue #382: also handle "Scope" as a fallback for short PR descriptions.
  const re = /(?:^|\n)\s*(?:##+\s*|\*\*)?Files in scope(?:\*\*)?\s*[\r\n]+([\s\S]*?)(?=\n\s*(?:##+\s|\*\*[A-Z])|\n\s*Files out of scope|\n\s*Risk\b|\n\s*Implementation\b|\n\s*$|$)/i;
  const m = body.match(re);
  if (!m) return [];
  const block = m[1];
  // Pull paths out of `code spans` first; if none, fall back to bullet text.
  const codeSpans = Array.from(block.matchAll(/`([^`]+)`/g)).map((x) => x[1].trim());
  if (codeSpans.length > 0) return codeSpans.filter(looksLikePath);
  // Fallback: bullet list lines, strip leading "- " or "* "
  return block
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter((l) => l && !l.startsWith("#"))
    .filter(looksLikePath);
}

function looksLikePath(s: string): boolean {
  // Heuristic: contains a slash or a recognised extension, no spaces.
  if (/\s/.test(s)) return false;
  if (s.includes("/")) return true;
  if (/\.(ts|tsx|js|mjs|cjs|mts|cts|md|yml|yaml|json|sh|toml)$/.test(s)) return true;
  return false;
}

export function classifyScope(
  changed: string[],
  inScope: string[],
  opts: { ratio?: number; minCount?: number } = {},
): {
  blocked: boolean;
  outOfScope: string[];
  ratio: number;
  threshold: number;
  minCount: number;
} {
  const ratio = opts.ratio ?? DEFAULT_RATIO;
  const minCount = opts.minCount ?? DEFAULT_MIN_COUNT;
  if (changed.length === 0) {
    return { blocked: false, outOfScope: [], ratio: 0, threshold: ratio, minCount };
  }
  const norm = (f: string) => f.replace(/^\.\//, "").replace(/^web\//, "");
  const scopeNormalised = inScope.map(norm).filter((s) => s.length > 0);
  const outOfScope = changed.filter((f) => {
    const n = norm(f);
    if (scopeNormalised.includes(n)) return false;
    return !scopeNormalised.some((s) => n.startsWith(s) || s.startsWith(n) || n.endsWith(s));
  });
  const observed = outOfScope.length / changed.length;
  const blocked = observed > ratio && outOfScope.length > minCount;
  return { blocked, outOfScope, ratio: observed, threshold: ratio, minCount };
}

function readChangedFiles(): string[] {
  const env = process.env.CHANGED_FILES ?? "";
  return env
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isQuickFix(body: string): boolean {
  return /\[quick-fix\]/i.test(body || "");
}

function main(): number {
  const prBody = process.env.PR_BODY ?? "";
  const issueBody = process.env.ISSUE_BODY ?? "";
  const changed = readChangedFiles();

  if (changed.length === 0) {
    process.stdout.write(JSON.stringify({ status: "pass", reason: "no changed files" }) + "\n");
    return 0;
  }

  if (isQuickFix(prBody)) {
    process.stdout.write(
      JSON.stringify({ status: "neutral", reason: "[quick-fix] PR — scope gate skipped", changed: changed.length }) + "\n",
    );
    process.stderr.write("Scope gate: [quick-fix] tag detected — gate skipped.\n");
    return 0;
  }

  const inScope = Array.from(new Set([
    ...extractScopeFromBody(prBody),
    ...extractScopeFromBody(issueBody),
  ]));

  const ratioEnv = process.env.SCOPE_OUT_OF_SCOPE_THRESHOLD;
  const minCountEnv = process.env.SCOPE_MIN_OUT_OF_SCOPE_COUNT;
  const ratio = ratioEnv ? parseFloat(ratioEnv) : DEFAULT_RATIO;
  const minCount = minCountEnv ? parseInt(minCountEnv, 10) : DEFAULT_MIN_COUNT;

  const result = classifyScope(changed, inScope, {
    ratio: Number.isFinite(ratio) ? ratio : DEFAULT_RATIO,
    minCount: Number.isFinite(minCount) ? minCount : DEFAULT_MIN_COUNT,
  });

  const report = {
    status: result.blocked ? "fail" : "pass",
    changedFiles: changed.length,
    inScopeFiles: inScope.length,
    outOfScopeFiles: result.outOfScope.length,
    outOfScopeRatio: result.ratio,
    threshold: result.threshold,
    minCount: result.minCount,
    outOfScope: result.outOfScope.slice(0, 20),
    inScope,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (result.blocked) {
    process.stderr.write(
      `SCOPE GATE FAILED: ${result.outOfScope.length}/${changed.length} files (${Math.round(result.ratio * 100)}%) outside declared scope.\n` +
      `Threshold: >${Math.round(result.threshold * 100)}% and >${result.minCount} files.\n` +
      `Out-of-scope sample: ${result.outOfScope.slice(0, 5).join(", ")}${result.outOfScope.length > 5 ? " ..." : ""}\n` +
      (inScope.length === 0
        ? `\nHINT: no "Files in scope" section was found in the PR body or linked issue.\n` +
          `Add a markdown section listing in-scope paths to override the gate, or tag the PR with [quick-fix].\n`
        : ""),
    );
    return 2;
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
