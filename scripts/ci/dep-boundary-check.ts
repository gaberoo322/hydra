#!/usr/bin/env -S npx tsx
/**
 * dep-boundary-check — import-graph boundary scanner (issue #2205,
 * tool-scout: dependency-hygiene).
 *
 * Thin Adapter over `dependency-cruiser` (sverweij/dependency-cruiser): it shells
 * out to `npx dependency-cruiser`, runs the rule set in `.dependency-cruiser.cjs`
 * over the `src/` import graph, parses the JSON `summary.violations`, and renders a
 * human + GitHub-step-summary report. Unlike the text-regex `scripts/ci/*-seam-check.ts`
 * ratchets (one seam each, via `seam-check-lib.ts`), this reads the ACTUAL import
 * graph, so a boundary name appearing only in a comment / docstring never
 * false-matches, and one config generalises ALL the module-boundary seams at once.
 *
 * No-runtime-dependency lane (ADR-0005): dependency-cruiser is invoked through a
 * PINNED `npx -p dependency-cruiser@<ver>` — it is NOT a package.json devDependency.
 * dependency-cruiser ships a `prepare: husky` install script, so adding it as a dep
 * would trip the `@lavamoat/allow-scripts` gate (current allowScripts is deny-all);
 * the npx path runs the binary without ever running that script gate. This is the
 * same lane ast-grep / comby / probe / promptfoo already use (CLAUDE.md "Structural
 * code search"). DEPCRUISE_SPEC below is the single pinned source of truth — keep it
 * in lockstep with the `dep-boundary-check` npm script and the dep-boundary-check.yml
 * workflow.
 *
 * ADVISORY by design (issue #2205 risk note: "start in advisory mode, not err
 * blocking mode"): every rule in `.dependency-cruiser.cjs` ships at
 * `severity: "warn"`, and this wrapper exits 0 regardless of findings UNLESS run
 * with `--error`. It surfaces import-boundary drift to reviewers WITHOUT blocking
 * merge, mirroring the ast-grep-lint / comby-check advisory contract. The
 * authoritative HARD gate for the Redis seam stays the text-regex
 * `scripts/ci/redis-seam-check.ts` inside Verifier-Core `ci.yml`; this complements
 * it. To promote a rule to a hard gate later: flip its `severity` to "error" in the
 * config AND run this wrapper with `--error` in the workflow (a conscious,
 * reviewable change).
 *
 * Usage:
 *   npx tsx scripts/ci/dep-boundary-check.ts          # advisory: report, always exit 0
 *   npx tsx scripts/ci/dep-boundary-check.ts --error  # exit 1 if any error-severity violation
 *   npm run dep-boundary-check
 *
 * Exit codes:
 *   0 — advisory mode (default), OR --error mode with zero error-severity violations
 *   1 — --error mode AND at least one error-severity violation
 *   2 — could not run dependency-cruiser / parse its output (fail loud)
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/**
 * Pinned dependency-cruiser version. MUST stay in lockstep with the
 * `dep-boundary-check` npm script and `.github/workflows/dep-boundary-check.yml`.
 */
const DEPCRUISE_SPEC = "dependency-cruiser@17.4.3";

/** The cruise entry: the whole src/ tree as a glob (a bare `src` dir cruises 0 .ts modules). */
const CRUISE_TARGET = "src/**/*.ts";
const CONFIG_FILE = ".dependency-cruiser.cjs";

interface DepcruiseViolation {
  type: string;
  from: string;
  to: string;
  rule: { name: string; severity: string };
}

interface DepcruiseResult {
  summary: {
    violations: DepcruiseViolation[];
    error: number;
    warn: number;
    info: number;
    totalCruised: number;
  };
}

/** The decision a run resolves to, derived purely from the parsed summary + mode. */
export interface DepBoundaryDecision {
  /** Process exit code: 0 advisory/clean, 1 blocking error in --error mode, 2 tool/config failure. */
  exitCode: 0 | 1 | 2;
  /** Violations grouped by rule name, for rendering. */
  byRule: Map<string, DepcruiseViolation[]>;
  /** Human-readable one-line outcome. */
  headline: string;
}

/**
 * Pure decision function — maps a parsed dependency-cruiser summary to the exit code
 * and grouping, with NO process / spawn / fs side effects. Exported so the regression
 * test can pin the advisory-vs-blocking contract and the 0-modules-is-a-tool-error
 * rule WITHOUT shelling out to npx (mirrors the seam-check `fileViolates…` exported
 * predicate pattern).
 *
 * Contract:
 *  - totalCruised === 0           → exit 2 (resolver saw nothing — config/glob regression)
 *  - failOnError && error > 0     → exit 1 (a real error-severity violation under --error)
 *  - otherwise                    → exit 0 (advisory: surfaced, not blocking)
 */
export function decideDepBoundary(
  summary: DepcruiseResult["summary"],
  failOnError: boolean,
): DepBoundaryDecision {
  const { violations, error, warn, info, totalCruised } = summary;

  const byRule = new Map<string, DepcruiseViolation[]>();
  for (const v of violations) {
    const list = byRule.get(v.rule.name) ?? [];
    list.push(v);
    byRule.set(v.rule.name, list);
  }

  if (totalCruised === 0) {
    return {
      exitCode: 2,
      byRule,
      headline:
        "dependency-cruiser cruised 0 modules — resolver saw no source (config/glob regression).",
    };
  }

  if (failOnError && error > 0) {
    return {
      exitCode: 1,
      byRule,
      headline: `${error} error-severity violation(s) — failing (--error mode).`,
    };
  }

  return {
    exitCode: 0,
    byRule,
    headline:
      violations.length === 0
        ? `cruised ${totalCruised} modules — no import-boundary violations (clean).`
        : `cruised ${totalCruised} modules — ${violations.length} finding(s) surfaced, ` +
          `advisory (not blocking). ${error} error / ${warn} warn / ${info} info.`,
  };
}

/** Append a line to the GitHub step summary, if running in CI. Best-effort. */
function stepSummary(line: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, line + "\n");
  } catch (err) {
    // Fail loud (repo convention) but never block the check on a summary write.
    console.error(`[dep-boundary-check] WARN: could not write GITHUB_STEP_SUMMARY: ${String(err)}`);
  }
}

function main(): void {
  const failOnError = process.argv.includes("--error");

  // npx --yes resolves+runs the pinned binary without touching package.json or the
  // allow-scripts gate (dependency-cruiser's `prepare: husky` only runs on `npm install`).
  const run = spawnSync(
    "npx",
    [
      "--yes",
      "-p",
      DEPCRUISE_SPEC,
      "depcruise",
      "--config",
      CONFIG_FILE,
      "--output-type",
      "json",
      CRUISE_TARGET,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  // depcruise exits non-zero when it FINDS error-severity violations — that is an
  // expected, parseable outcome, not a tool failure. A genuine tool failure (binary
  // missing, bad config) prints to stderr and yields no parseable JSON on stdout.
  if (run.error) {
    console.error(`[dep-boundary-check] FAILED to spawn dependency-cruiser: ${String(run.error)}`);
    process.exit(2);
  }

  let parsed: DepcruiseResult;
  try {
    parsed = JSON.parse(run.stdout) as DepcruiseResult;
  } catch (err) {
    console.error(
      `[dep-boundary-check] FAILED to parse dependency-cruiser JSON (exit=${run.status}). ` +
        `This is a tool/config error, not a boundary violation.\n` +
        `stderr:\n${run.stderr}\n` +
        `parse error: ${String(err)}`,
    );
    process.exit(2);
  }

  const { error, warn, info, totalCruised } = parsed.summary;
  const decision = decideDepBoundary(parsed.summary, failOnError);

  if (decision.exitCode === 2) {
    // 0 modules cruised — almost always a config/glob regression, never a genuinely
    // empty src/. Fail loud (repo convention).
    console.error(`[dep-boundary-check] FAILED: ${decision.headline} stderr:\n${run.stderr}`);
    process.exit(2);
  }

  console.log(
    `[dep-boundary-check] cruised ${totalCruised} modules — ` +
      `${error} error / ${warn} warn / ${info} info violations`,
  );
  stepSummary(`### dep-boundary-check (advisory, issue #2205)\n`);
  stepSummary(
    `Cruised **${totalCruised}** modules — **${error}** error · **${warn}** warn · **${info}** info.\n`,
  );

  if (decision.byRule.size === 0) {
    console.log("[dep-boundary-check] no import-boundary violations — clean.");
    stepSummary("No import-boundary violations — clean.\n");
    process.exit(0);
  }

  stepSummary("| Rule | Severity | From | To |");
  stepSummary("| --- | --- | --- | --- |");
  for (const [ruleName, vs] of decision.byRule) {
    console.log(`\n  rule: ${ruleName} (${vs[0]!.rule.severity}) — ${vs.length} finding(s)`);
    for (const v of vs) {
      console.log(`    ${v.from} -> ${v.to}`);
      // GitHub Actions advisory annotation.
      console.log(`::warning title=dep-boundary-check::${ruleName}: ${v.from} -> ${v.to}`);
      stepSummary(`| ${ruleName} | ${v.rule.severity} | ${v.from} | ${v.to} |`);
    }
  }

  if (decision.exitCode === 1) {
    console.error(`\n[dep-boundary-check] ${decision.headline}`);
    process.exit(1);
  }

  console.log(`\n[dep-boundary-check] ${decision.headline} exit 0.`);
  process.exit(0);
}

/**
 * True when this module is the process entrypoint (run as a CLI), false when it is
 * merely imported (e.g. by the regression test). Mirrors seam-check-lib's
 * isCliEntrypoint so importing the module never triggers the npx spawn / process.exit.
 */
function isCliEntrypoint(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    /* intentional: best-effort CLI-entrypoint probe — if realpath/URL resolution fails, the module is being imported rather than run as the entrypoint, so degrading to false is the correct answer and must not throw into module-load. */
    return false;
  }
}

if (isCliEntrypoint(import.meta.url)) {
  main();
}
