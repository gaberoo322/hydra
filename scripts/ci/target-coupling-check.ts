#!/usr/bin/env -S npx tsx
/**
 * Target-coupling check — ADR-0013 swap-seam guard.
 *
 * Hydra is a *swappable single-target builder* (ADR-0013): one orchestrator
 * process builds exactly one target (ADR-0002), and the operator swaps targets
 * by editing env vars — NOT by editing `src/`. Hardcoding a target's name, repo
 * slug, or domain vocabulary anywhere in `src/` silently breaks that swap model
 * and is therefore a **defect**, not a cosmetic nit.
 *
 * The swap seam is `src/target-config.ts` (`getTargetName()`,
 * `getTargetGithubRepo()`, `getTargetServiceName()`, …). Everything in `src/`
 * that needs a target identifier must route through it. This check defends the
 * seam so coupling cannot drift back in unnoticed.
 *
 * # What it flags
 *
 *   HARD (error in code, warn in comments): the literal target name / repo slug
 *     (`hydra-betting`, `gaberoo322/hydra-betting`) appearing anywhere in `src/`
 *     except `src/target-config.ts` (which legitimately owns the default). In
 *     CODE this fails the gate — it is the defect that breaks the swap at
 *     runtime. In a COMMENT it is a non-fatal warning: prose referencing the
 *     current target doesn't change behavior, so we surface it for cleanup
 *     without blocking the merge queue.
 *
 *   VOCAB (error in code, warn in comments): a configurable domain-vocab
 *     denylist (`kalshi`, `polymarket`, `bankroll`, …). These are betting-domain
 *     terms that should never be hardcoded into the target-agnostic orchestrator.
 *     A match inside a comment is reported at lower severity (does not fail the
 *     gate on its own) because comments don't change runtime behavior; a match
 *     in code fails the gate.
 *
 * # Baseline ratchet
 *
 * Like `redis-seam-check.ts` (ADR-0009), this implements a shrink-only baseline.
 * Pre-existing violations live in `scripts/ci/target-coupling-baseline.json` and
 * are tolerated; NEW violations fail the gate; a violation that gets cleaned up
 * must be removed from the baseline (the check fails loudly if the baseline is
 * stale). The intended end state for issue #731 is an EMPTY baseline.
 *
 * Usage:
 *   npx tsx scripts/ci/target-coupling-check.ts
 *   npm run coupling-check
 *
 * Update flow when intentionally introducing/removing a known violation:
 *   1. Make the change.
 *   2. Run with `--write-baseline` to regenerate the baseline file.
 *   3. Commit the new baseline alongside the change.
 *
 * Self-test:
 *   --self-test exercises the pure classifier against synthetic fixtures and
 *   exits non-zero if the classifier fails to catch a planted leak. This proves
 *   the gate would catch a newly-introduced hardcoded `hydra-betting` reference
 *   (acceptance criterion) without writing a throwaway file into `src/`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SRC_DIR = join(REPO_ROOT, "src");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ci/target-coupling-baseline.json");

/** The seam itself legitimately owns the default literals. */
const SEAM_FILE = "src/target-config.ts";

const WRITE_BASELINE = process.argv.includes("--write-baseline");
const SELF_TEST = process.argv.includes("--self-test");

/**
 * HARD literals — the concrete target identity. These must never be hardcoded
 * in `src/` (outside the seam). Case-insensitive whole-token matching.
 */
const HARD_LITERALS = [
  "gaberoo322/hydra-betting",
  "hydra-betting",
];

/**
 * Domain-vocab denylist — betting-domain terms that couple the orchestrator to
 * the current target's problem domain. Matched as whole words (case-insensitive)
 * so substrings of unrelated identifiers don't false-positive.
 */
const VOCAB_DENYLIST = [
  "kalshi",
  "polymarket",
  "bankroll",
];

export type Severity =
  | "name" // hardcoded target identity in CODE — fatal
  | "name-comment" // hardcoded target identity in a COMMENT — advisory
  | "vocab-code" // domain vocab in CODE — fatal
  | "vocab-comment"; // domain vocab in a COMMENT — advisory

/** Severities that fail the gate when newly introduced. */
const FATAL: ReadonlySet<Severity> = new Set<Severity>(["name", "vocab-code"]);

export interface Violation {
  /** `src/...` path, POSIX-style. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The denylisted token that matched. */
  token: string;
  severity: Severity;
  /** The trimmed source line (truncated) — for human-readable output. */
  excerpt: string;
}

interface BaselineFile {
  /** Sorted list of `file::token::severity` violation keys that are tolerated. */
  violations: string[];
  note: string;
}

/**
 * Stable key for baseline membership. We key on file+token+severity, NOT line,
 * because line numbers churn on unrelated edits while the *fact* of a leak in a
 * file is what we want to ratchet on.
 */
export function violationKey(v: Violation): string {
  return `${v.file}::${v.token}::${v.severity}`;
}

// ---------------------------------------------------------------------------
// Pure classifier — exported for tests / self-test.
// ---------------------------------------------------------------------------

/**
 * Decide whether a given line sits inside a comment. This is a deliberately
 * simple line-oriented heuristic (not a full TS parser): a line is treated as a
 * comment if, after trimming, it starts with `//`, `*`, or `/*`. That covers
 * JSDoc blocks and line comments — the only places we downgrade vocab matches.
 * A vocab term in a string literal or identifier is treated as code (the
 * stricter classification), which is the safe default.
 */
export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function wholeWordRegex(token: string): RegExp {
  // Escape regex metachars in the token (the slug contains `/` and `-`).
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `hydra-betting` / `gaberoo322/hydra-betting` contain `-` and `/`, which are
  // not \w, so a plain \b won't anchor cleanly. Use lookarounds on the
  // identifier-character class so we don't match a longer alphanumeric run.
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i");
}

const HARD_REGEXES = HARD_LITERALS.map(t => ({ token: t, re: wholeWordRegex(t) }));
const VOCAB_REGEXES = VOCAB_DENYLIST.map(t => ({ token: t, re: wholeWordRegex(t) }));

/**
 * Classify a single file's body into violations. Pure — no I/O. Exported so the
 * self-test and unit tests can plant fixtures without touching the filesystem.
 *
 * HARD literals are checked longest-first so that `gaberoo322/hydra-betting` is
 * reported as the repo slug rather than double-counting the embedded
 * `hydra-betting` on the same line.
 */
export function classifyFile(file: string, body: string): Violation[] {
  const out: Violation[] = [];
  const lines = body.split("\n");

  const hardOrdered = [...HARD_REGEXES].sort((a, b) => b.token.length - a.token.length);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const comment = isCommentLine(line);

    // Track characters already consumed by a longer HARD match so the shorter
    // `hydra-betting` regex doesn't re-flag the same span.
    let consumed = line;

    for (const { token, re } of hardOrdered) {
      if (re.test(consumed)) {
        out.push({
          file,
          line: lineNo,
          token,
          severity: comment ? "name-comment" : "name",
          excerpt: line.trim().slice(0, 120),
        });
        // Blank out the matched token so a shorter overlapping literal on the
        // same line isn't double-counted.
        consumed = consumed.replace(new RegExp(re.source, "gi"), " ".repeat(token.length));
      }
    }

    for (const { token, re } of VOCAB_REGEXES) {
      if (re.test(line)) {
        out.push({
          file,
          line: lineNo,
          token,
          severity: comment ? "vocab-comment" : "vocab-code",
          excerpt: line.trim().slice(0, 120),
        });
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Distinctive-dependency filter — swap-seam vocabulary (ADR-0013).
//
// Relocated here from the (now-deleted) src/codebase-analyzer.ts in issue #785:
// it is the only export that survived, it was consumed solely by this guard's
// test, and the filter IS swap-seam logic — it decides which of a target's
// package.json dependencies *distinguish* that target from a generic web app.
// Co-locating it with the coupling check keeps that vocabulary inside the
// swap-seam guard and CI-exercisable, instead of stranding a production src/
// module alive only because a test borrowed one function.
// ---------------------------------------------------------------------------

/**
 * Common web-framework dependency prefixes that every target sharing this
 * Next/React/Drizzle stack carries — these say nothing distinctive about what a
 * target *is*, so they're filtered out of the "key dependencies" signal. This
 * is an EXCLUSION list of generic infrastructure, deliberately containing no
 * target-domain vocabulary (ADR-0013): a new target's domain packages surface
 * automatically because they aren't on this list.
 */
export const GENERIC_DEP_PREFIXES = [
  "next", "react", "react-dom", "tailwind", "drizzle", "postgres", "pg",
  "zod", "typescript", "eslint", "prettier", "vitest", "@types/",
  "@radix-ui/", "clsx", "tailwind-merge", "lucide-react", "ws", "dotenv",
];

/**
 * Pick the dependencies that distinguish this target from a generic web app —
 * i.e. everything that isn't part of the common framework stack. Target-agnostic
 * by construction: no venue/domain names are hardcoded.
 */
export function pickDistinctiveDependencies(deps: string[]): string[] {
  return deps.filter(
    d => !GENERIC_DEP_PREFIXES.some(p => d === p || d.startsWith(p)),
  );
}

// ---------------------------------------------------------------------------
// File discovery + I/O
// ---------------------------------------------------------------------------

async function listTrackedSrcFiles(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "src/*.ts", "src/**/*.ts"],
    { cwd: REPO_ROOT },
  );
  return stdout
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(p => p !== SEAM_FILE);
}

async function findViolations(): Promise<Violation[]> {
  const tracked = await listTrackedSrcFiles();
  const all: Violation[] = [];
  for (const relPath of tracked) {
    const abs = join(REPO_ROOT, relPath);
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    all.push(...classifyFile(relPath, body));
  }
  return all.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
}

async function loadBaseline(): Promise<BaselineFile> {
  try {
    const raw = await readFile(BASELINE_PATH, "utf8");
    return JSON.parse(raw) as BaselineFile;
  } catch {
    return { violations: [], note: "baseline not yet seeded" };
  }
}

async function writeBaselineFile(keys: string[]): Promise<void> {
  const payload: BaselineFile = {
    violations: [...new Set(keys)].sort(),
    note: `Auto-generated by scripts/ci/target-coupling-check.ts --write-baseline on ${new Date().toISOString()}. ADR-0013 swap-seam ratchet: shrink only. Target state: empty.`,
  };
  await writeFile(BASELINE_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Self-test — proves the classifier catches a planted leak.
// ---------------------------------------------------------------------------

function runSelfTest(): number {
  const failures: string[] = [];

  // 1. A newly-introduced hardcoded repo slug must be caught as a `name` leak.
  const planted = classifyFile(
    "src/fake.ts",
    'const repo = "gaberoo322/hydra-betting";\n',
  );
  if (!planted.some(v => v.severity === "name" && v.token === "gaberoo322/hydra-betting")) {
    failures.push("classifier failed to catch hardcoded repo slug");
  }
  // The embedded `hydra-betting` must NOT be double-reported on that line.
  if (planted.filter(v => v.severity === "name").length !== 1) {
    failures.push(`expected exactly 1 name violation for the repo slug, got ${planted.filter(v => v.severity === "name").length}`);
  }

  // 2. A bare target name in code is caught.
  const bareName = classifyFile("src/fake.ts", 'const t = "hydra-betting";\n');
  if (!bareName.some(v => v.severity === "name" && v.token === "hydra-betting")) {
    failures.push("classifier failed to catch bare target name");
  }

  // 3. Domain vocab in code is an error; in a comment it is downgraded.
  const vocabCode = classifyFile("src/fake.ts", 'if (d.includes("kalshi")) {}\n');
  if (!vocabCode.some(v => v.severity === "vocab-code" && v.token === "kalshi")) {
    failures.push("classifier failed to flag vocab in code as vocab-code");
  }
  const vocabComment = classifyFile("src/fake.ts", "// supports kalshi and polymarket\n");
  if (vocabComment.length === 0 || !vocabComment.every(v => v.severity === "vocab-comment")) {
    failures.push("classifier failed to downgrade vocab in a comment");
  }

  // 4. A target-agnostic line must NOT trip the gate.
  const clean = classifyFile(
    "src/fake.ts",
    "const repo = getTargetGithubRepo();\nconst name = getTargetName();\n",
  );
  if (clean.length !== 0) {
    failures.push(`clean target-agnostic code produced ${clean.length} false positives`);
  }

  // 5. A substring of an unrelated identifier must not false-positive.
  const substring = classifyFile("src/fake.ts", "const x = bankrolling;\n");
  // `bankroll` is a whole-word denylist entry; `bankrolling` should NOT match.
  if (substring.some(v => v.token === "bankroll")) {
    failures.push("whole-word matching failed: matched a substring of an unrelated identifier");
  }

  if (failures.length > 0) {
    console.error("[target-coupling-check --self-test] FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("[target-coupling-check --self-test] OK — classifier catches planted leaks and ignores clean code.");
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  if (SELF_TEST) return runSelfTest();

  const violations = await findViolations();
  const keys = violations.map(violationKey);

  if (WRITE_BASELINE) {
    await writeBaselineFile(keys);
    console.log(
      `[target-coupling-check] Wrote baseline with ${new Set(keys).size} entries to ${relative(REPO_ROOT, BASELINE_PATH)}`,
    );
    return 0;
  }

  const baseline = await loadBaseline();
  const baselineSet = new Set(baseline.violations);
  const currentSet = new Set(keys);

  // Comment-context matches never fail the gate on their own — they're advisory.
  // Only code-context matches (severity in FATAL) block a merge.
  const newViolations = violations.filter(v => !baselineSet.has(violationKey(v)));
  const newFatal = newViolations.filter(v => FATAL.has(v.severity));
  const newAdvisory = newViolations.filter(v => !FATAL.has(v.severity));

  const fixed = [...baselineSet].filter(k => !currentSet.has(k));

  let failed = false;

  if (newFatal.length > 0) {
    console.error("[target-coupling-check] NEW target-coupling leaks (ADR-0013):");
    for (const v of newFatal) {
      const label = v.severity === "name" ? "TARGET-IDENTITY" : "DOMAIN-VOCAB";
      console.error(`  - ${v.file}:${v.line} [${label}] "${v.token}"  ${v.excerpt}`);
    }
    console.error("");
    console.error("Route target identifiers through src/target-config.ts (getTargetName / getTargetGithubRepo / getTargetServiceName).");
    console.error("Replace betting-domain literals with target-agnostic heuristics or config-declared signals (ADR-0013, ADR-0002).");
    failed = true;
  }

  if (newAdvisory.length > 0) {
    console.warn("[target-coupling-check] WARNING — new target-coupling in comments (advisory, not fatal):");
    for (const v of newAdvisory) {
      console.warn(`  - ${v.file}:${v.line} "${v.token}"  ${v.excerpt}`);
    }
  }

  if (fixed.length > 0) {
    console.error("[target-coupling-check] Baseline is stale — these leaks are resolved:");
    for (const k of fixed) console.error(`  - ${k}`);
    console.error("");
    console.error("Re-run with --write-baseline and commit the shrunk baseline.");
    failed = true;
  }

  if (failed) return 1;

  console.log(
    `[target-coupling-check] OK — ${violations.length} known matches (${baseline.violations.length} baselined), no new leaks.`,
  );
  return 0;
}

main().then(
  code => process.exit(code),
  err => {
    console.error("[target-coupling-check] crash:", err);
    process.exit(2);
  },
);
