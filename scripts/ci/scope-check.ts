#!/usr/bin/env -S npx tsx
/**
 * scripts/ci/scope-check.ts — Scope enforcement CI gate (issues #382, #396).
 *
 * Re-homes the in-cycle scope enforcement gate (was step 6.9 of the codex
 * control loop, in src/scope-enforcement.ts) so PRs from any source —
 * hydra-dev, hydra-target-build, manual operator branches — get the same
 * safety net once the codex CLI is removed (PR-3).
 *
 * Issue #396 extends this with subagent-side parity for the deleted
 * reconcilePlanVsActual step: the gate now also recognises an explicit
 * "Files out of scope" block (hard-block any matching file) and a
 * `scope-justification:` escape hatch in the PR body that whitelists
 * specific out-of-scope files when the subagent had a good reason.
 *
 * Failure semantics:
 *   - Hard fail (exit 2) if ANY changed file matches the declared
 *     "Files out of scope" list (unless it appears in a
 *     `scope-justification:` block in the PR body).
 *   - Soft fail (exit 2) when >80% of changed files are out-of-scope AND
 *     more than 3 files are out-of-scope (matches the legacy in-cycle
 *     thresholds in src/scope-enforcement.ts). Files appearing in a
 *     `scope-justification:` block are excluded from the out-of-scope
 *     count.
 *   - Pass (exit 0) otherwise.
 *
 * Definition of in-scope (per issues #382 + #396 AC):
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
 *     reason: shared regression suite
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
  opts: {
    ratio?: number;
    minCount?: number;
    /** Explicit "Files out of scope" entries (issue #396). */
    outOfScopeDeclared?: string[];
    /** Out-of-scope files justified by `scope-justification:` PR-body blocks. */
    justified?: string[];
  } = {},
): {
  blocked: boolean;
  outOfScope: string[];
  /** Subset of outOfScope that matched the declared "out of scope" block. */
  hardOutOfScope: string[];
  /** Files excused from the count by `scope-justification:`. */
  justifiedTouched: string[];
  ratio: number;
  threshold: number;
  minCount: number;
  reason: "pass" | "hard-out-of-scope" | "ratio-exceeded";
} {
  const ratio = opts.ratio ?? DEFAULT_RATIO;
  const minCount = opts.minCount ?? DEFAULT_MIN_COUNT;
  const outOfScopeDeclared = opts.outOfScopeDeclared ?? [];
  const justified = (opts.justified ?? []).map((p) => normalisePath(p));

  if (changed.length === 0) {
    return {
      blocked: false,
      outOfScope: [],
      hardOutOfScope: [],
      justifiedTouched: [],
      ratio: 0,
      threshold: ratio,
      minCount,
      reason: "pass",
    };
  }

  const scopeNormalised = inScope.map(normalisePath).filter((s) => s.length > 0);
  const outDeclaredNormalised = outOfScopeDeclared.map(normalisePath).filter((s) => s.length > 0);

  const matches = (target: string, list: string[]): boolean => {
    if (list.length === 0) return false;
    if (list.includes(target)) return true;
    return list.some((s) => target.startsWith(s) || s.startsWith(target) || target.endsWith(s));
  };

  // In-scope wins (issue #1872): drop from the declared out-of-scope set any
  // entry that also matches the in-scope set under the same matcher. A file the
  // author explicitly lists in "Files in scope" is in scope regardless of an
  // incidental out-of-scope code-span (the arch-scan seam-target trap that bit
  // PRs #1515/#1870/#1871). Genuine out-of-scope-only entries have no in-scope
  // twin, so they survive and still hard-fail. This reconciliation lives in
  // exactly one place — both the hardOutOfScope filter and any future consumer
  // of outNormalised see the reconciled view.
  //
  // The overlap test is symmetric: the #1870/#1871 shape is an in-scope full
  // path (`src/foo.ts`) versus a bare-basename out-of-scope code-span
  // (`foo.ts`), so we check whether the out-of-scope entry matches an in-scope
  // entry OR vice-versa under the same matcher (matches() only walks one
  // direction's startsWith/endsWith, so a single call misses the suffix case).
  const overlapsInScope = (o: string): boolean =>
    matches(o, scopeNormalised) || scopeNormalised.some((s) => matches(s, [o]));
  const outNormalised = outDeclaredNormalised.filter((o) => !overlapsInScope(o));

  const justifiedTouched = changed.filter((f) => matches(normalisePath(f), justified));

  // Hard fail: any changed file matches the declared "out of scope" list and
  // is NOT justified. This is the per-file gate (#396) — it ignores the
  // ratio threshold entirely.
  const hardOutOfScope = changed.filter((f) => {
    const n = normalisePath(f);
    if (matches(n, justified)) return false;
    return matches(n, outNormalised);
  });

  // Soft (ratio-based) classification. Justified files don't count.
  const outOfScope = changed.filter((f) => {
    const n = normalisePath(f);
    if (matches(n, justified)) return false;
    if (matches(n, scopeNormalised)) return false;
    return true;
  });

  const observed = outOfScope.length / changed.length;
  let blocked = false;
  let reason: "pass" | "hard-out-of-scope" | "ratio-exceeded" = "pass";
  if (hardOutOfScope.length > 0) {
    blocked = true;
    reason = "hard-out-of-scope";
  } else if (observed > ratio && outOfScope.length > minCount) {
    blocked = true;
    reason = "ratio-exceeded";
  }

  return {
    blocked,
    outOfScope,
    hardOutOfScope,
    justifiedTouched,
    ratio: observed,
    threshold: ratio,
    minCount,
    reason,
  };
}

function normalisePath(f: string): string {
  return f.replace(/^\.\//, "").replace(/^web\//, "");
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

/**
 * Best-effort: tell the orchestrator a scope violation happened so the
 * Builder-Health Scorecard's scope-violation-rate metric (issue #732) gets a
 * durable, day-bucketed count. Fire-and-forget over HTTP — the CI gate stays
 * dependency-free of ioredis, and a Redis/HTTP outage must NEVER change the
 * gate's exit code. Skipped when `HYDRA_API_BASE` is unset (the typical CI
 * runner has no orchestrator reachable), so this is a no-op outside the
 * self-hosted-runner deploy box unless explicitly wired.
 */
export async function reportScopeViolation(
  base: string | undefined = process.env.HYDRA_API_BASE,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!base) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetchImpl(`${base.replace(/\/$/, "")}/api/builder-health/scope-violation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    // Observability is best-effort; never fail the gate on a reporting error.
    process.stderr.write(
      `Scope gate: scope-violation report failed (non-fatal): ${err?.message || err}\n`,
    );
  }
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
  const outOfScopeDeclared = Array.from(new Set([
    ...extractOutOfScopeFromBody(prBody),
    ...extractOutOfScopeFromBody(issueBody),
  ]));
  // Justifications only count if they're in the PR body — issues don't get
  // to pre-authorise scope violations.
  const justified = extractScopeJustifications(prBody);

  const ratioEnv = process.env.SCOPE_OUT_OF_SCOPE_THRESHOLD;
  const minCountEnv = process.env.SCOPE_MIN_OUT_OF_SCOPE_COUNT;
  const ratio = ratioEnv ? parseFloat(ratioEnv) : DEFAULT_RATIO;
  const minCount = minCountEnv ? parseInt(minCountEnv, 10) : DEFAULT_MIN_COUNT;

  const result = classifyScope(changed, inScope, {
    ratio: Number.isFinite(ratio) ? ratio : DEFAULT_RATIO,
    minCount: Number.isFinite(minCount) ? minCount : DEFAULT_MIN_COUNT,
    outOfScopeDeclared,
    justified,
  });

  const report = {
    status: result.blocked ? "fail" : "pass",
    reason: result.reason,
    changedFiles: changed.length,
    inScopeFiles: inScope.length,
    outOfScopeDeclaredFiles: outOfScopeDeclared.length,
    outOfScopeFiles: result.outOfScope.length,
    hardOutOfScope: result.hardOutOfScope,
    justified: result.justifiedTouched,
    outOfScopeRatio: result.ratio,
    threshold: result.threshold,
    minCount: result.minCount,
    outOfScope: result.outOfScope.slice(0, 20),
    inScope,
    outOfScopeDeclared,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  if (result.blocked) {
    if (result.reason === "hard-out-of-scope") {
      process.stderr.write(
        `SCOPE GATE FAILED (hard): ${result.hardOutOfScope.length} changed file(s) match the declared "Files out of scope" list:\n` +
        `  ${result.hardOutOfScope.slice(0, 5).join(", ")}${result.hardOutOfScope.length > 5 ? " ..." : ""}\n` +
        `\nEscape hatches:\n` +
        `  1. Remove the file from the PR diff.\n` +
        `  2. Add a "scope-justification:" block to the PR body listing the specific file(s) with a rationale, e.g.\n\n` +
        `       scope-justification: \`src/foo.ts\` — required to update the test fixture\n`,
      );
    } else {
      process.stderr.write(
        `SCOPE GATE FAILED: ${result.outOfScope.length}/${changed.length} files (${Math.round(result.ratio * 100)}%) outside declared scope.\n` +
        `Threshold: >${Math.round(result.threshold * 100)}% and >${result.minCount} files.\n` +
        `Out-of-scope sample: ${result.outOfScope.slice(0, 5).join(", ")}${result.outOfScope.length > 5 ? " ..." : ""}\n` +
        (inScope.length === 0
          ? `\nHINT: no "Files in scope" section was found in the PR body or linked issue.\n` +
            `Add a markdown section listing in-scope paths to override the gate, or tag the PR with [quick-fix].\n`
          : ""),
      );
    }
    return 2;
  }

  if (result.justifiedTouched.length > 0) {
    process.stderr.write(
      `Scope gate: ${result.justifiedTouched.length} out-of-scope file(s) accepted via scope-justification:\n` +
      `  ${result.justifiedTouched.slice(0, 5).join(", ")}${result.justifiedTouched.length > 5 ? " ..." : ""}\n`,
    );
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = main();
  // On a scope-gate block, record the violation (best-effort, awaited so the
  // fire-and-forget POST isn't killed by process.exit) before exiting. The
  // exit code is decided entirely by main(); the report can never change it.
  if (code === 2) {
    reportScopeViolation().finally(() => process.exit(code));
  } else {
    process.exit(code);
  }
}
