#!/usr/bin/env -S npx tsx
/**
 * biome-check — advisory lint diagnostics over the orchestrator src/ tree
 * (issue #2204, tool-scout: lsp-language-tooling).
 *
 * Thin Adapter over `@biomejs/biome` (biomejs/biome): it shells out to
 * `npx @biomejs/biome lint --reporter=json src/`, parses the JSON
 * `diagnostics[]` + `summary`, and renders a human + GitHub-step-summary report
 * with one `::warning` annotation per finding. The repo had ZERO linter on the
 * `src/` tree before this — only `tsc --noEmit`. biome gives agents a fast
 * (<400ms cold) in-loop "is this even valid lint-wise?" signal whose findings
 * carry a stable `category` / `location` schema an agent can pattern-match
 * WITHOUT an LLM parse.
 *
 * DIAGNOSTICS ONLY — does NOT format. The rule set in `biome.jsonc` ships with
 * `formatter.enabled:false` and `assist.enabled:false`, so biome can never
 * rewrite a byte of source. This repo has no formatter (no prettier, no
 * .editorconfig); biome is added strictly as a non-conflicting advisory linter,
 * NOT as a formatter that would fight an existing one. `tsc --noEmit` stays the
 * type-checker (biome does no type analysis). The dashboard/ tree keeps its own
 * eslint — this wrapper only ever passes `src/`, never dashboard/.
 *
 * No-runtime-dependency lane (ADR-0005): biome is invoked through a PINNED
 * `npx -p @biomejs/biome@<ver>` — it is NOT a package.json devDependency.
 * @biomejs/biome has NO install/postinstall/prepare scripts (verified via
 * `npm view @biomejs/biome@2.5.0 scripts` → empty), so even adding it as a dep
 * would not trip the `@lavamoat/allow-scripts` gate — but the npx path keeps it
 * off the runtime-dep allowlist entirely, the same lane ast-grep / comby / probe
 * / promptfoo / dependency-cruiser already use (CLAUDE.md "Structural code
 * search"). BIOME_SPEC below is the single pinned source of truth — keep it in
 * lockstep with the `biome-check` npm script and the biome-check.yml workflow.
 *
 * ADVISORY by design (issue #2204 risk note: "advisory only on first merge;
 * operator upgrades later"): every rule in `biome.jsonc` ships at `warn`, and
 * this wrapper exits 0 regardless of findings UNLESS run with `--error`. It
 * surfaces lint drift to reviewers WITHOUT blocking merge, mirroring the
 * ast-grep-lint / comby-check / dep-boundary-check advisory contract. To promote
 * a rule to a hard gate later: bump its severity to `error` in biome.jsonc AND
 * run this wrapper with `--error` in the workflow (a conscious, reviewable
 * change) — NEVER by editing the Verifier-Core ci.yml.
 *
 * Usage:
 *   npx tsx scripts/ci/biome-check.ts          # advisory: report, always exit 0
 *   npx tsx scripts/ci/biome-check.ts --error  # exit 1 if any error-severity diagnostic
 *   npm run biome-check
 *
 * Exit codes:
 *   0 — advisory mode (default), OR --error mode with zero error-severity diagnostics
 *   1 — --error mode AND at least one error-severity diagnostic
 *   2 — could not run biome / parse its output (fail loud)
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Pinned biome version. MUST stay in lockstep with the `biome-check` npm script
 * and `.github/workflows/biome-check.yml`.
 */
const BIOME_SPEC = "@biomejs/biome@2.5.0";

/** The lint target: the orchestrator src/ tree only (dashboard/ keeps its own eslint). */
const LINT_TARGET = "src/";

/** A single biome JSON diagnostic (the fields this wrapper renders). */
interface BiomeDiagnostic {
  severity: "error" | "warning" | "information" | string;
  message: string;
  category: string;
  location?: { path?: string; start?: { line?: number; column?: number } };
}

/** biome's `--reporter=json` top-level shape (the fields this wrapper reads). */
interface BiomeResult {
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    /** Number of files biome actually scanned (changed + unchanged). 0 ⇒ tool/glob regression. */
    changed: number;
    unchanged: number;
  };
  diagnostics: BiomeDiagnostic[];
}

/** The decision a run resolves to, derived purely from the parsed result + mode. */
export interface BiomeCheckDecision {
  /** Process exit code: 0 advisory/clean, 1 blocking error in --error mode, 2 tool/config failure. */
  exitCode: 0 | 1 | 2;
  /** Diagnostics grouped by `category` (the biome rule id), for rendering. */
  byCategory: Map<string, BiomeDiagnostic[]>;
  /** Human-readable one-line outcome. */
  headline: string;
}

/**
 * Pure decision function — maps a parsed biome result to the exit code and
 * grouping, with NO process / spawn / fs side effects. Exported so the
 * regression test can pin the advisory-vs-blocking contract and the
 * 0-files-scanned-is-a-tool-error rule WITHOUT shelling out to npx (mirrors the
 * dep-boundary-check `decideDepBoundary` and the seam-check `fileViolates…`
 * exported-predicate pattern).
 *
 * Contract:
 *  - filesScanned === 0           → exit 2 (biome saw no source — config/glob regression)
 *  - failOnError && errors > 0    → exit 1 (a real error-severity diagnostic under --error)
 *  - otherwise                    → exit 0 (advisory: surfaced, not blocking)
 */
export function decideBiomeCheck(
  result: BiomeResult,
  failOnError: boolean,
): BiomeCheckDecision {
  const { errors, warnings, infos, changed, unchanged } = result.summary;
  const filesScanned = changed + unchanged;

  const byCategory = new Map<string, BiomeDiagnostic[]>();
  for (const d of result.diagnostics) {
    const list = byCategory.get(d.category) ?? [];
    list.push(d);
    byCategory.set(d.category, list);
  }

  if (filesScanned === 0) {
    return {
      exitCode: 2,
      byCategory,
      headline:
        "biome scanned 0 files — saw no source (config/glob regression).",
    };
  }

  if (failOnError && errors > 0) {
    return {
      exitCode: 1,
      byCategory,
      headline: `${errors} error-severity diagnostic(s) — failing (--error mode).`,
    };
  }

  const total = result.diagnostics.length;
  return {
    exitCode: 0,
    byCategory,
    headline:
      total === 0
        ? `scanned ${filesScanned} files — no lint diagnostics (clean).`
        : `scanned ${filesScanned} files — ${total} diagnostic(s) surfaced, ` +
          `advisory (not blocking). ${errors} error / ${warnings} warn / ${infos} info.`,
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
    console.error(`[biome-check] WARN: could not write GITHUB_STEP_SUMMARY: ${String(err)}`);
  }
}

function main(): void {
  const failOnError = process.argv.includes("--error");

  // npx --yes resolves+runs the pinned binary without touching package.json or
  // the allow-scripts gate. `--max-diagnostics=none` makes biome emit EVERY
  // diagnostic (default caps at 20) so the count is faithful; biome exits 1 when
  // it finds error-severity diagnostics, which is an expected, parseable outcome
  // — NOT a tool failure (handled below by the parse, not by run.status).
  const run = spawnSync(
    "npx",
    [
      "--yes",
      "-p",
      BIOME_SPEC,
      "biome",
      "lint",
      "--reporter=json",
      "--max-diagnostics=none",
      LINT_TARGET,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  if (run.error) {
    console.error(`[biome-check] FAILED to spawn biome: ${String(run.error)}`);
    process.exit(2);
  }

  let parsed: BiomeResult;
  try {
    parsed = JSON.parse(run.stdout) as BiomeResult;
  } catch (err) {
    console.error(
      `[biome-check] FAILED to parse biome JSON (exit=${run.status}). ` +
        `This is a tool/config error, not a lint diagnostic.\n` +
        `stderr:\n${run.stderr}\n` +
        `parse error: ${String(err)}`,
    );
    process.exit(2);
  }

  const { errors, warnings, infos, changed, unchanged } = parsed.summary;
  const filesScanned = changed + unchanged;
  const decision = decideBiomeCheck(parsed, failOnError);

  if (decision.exitCode === 2) {
    // 0 files scanned — almost always a config/glob regression, never a genuinely
    // empty src/. Fail loud (repo convention).
    console.error(`[biome-check] FAILED: ${decision.headline} stderr:\n${run.stderr}`);
    process.exit(2);
  }

  console.log(
    `[biome-check] scanned ${filesScanned} files — ` +
      `${errors} error / ${warnings} warn / ${infos} info diagnostics`,
  );
  stepSummary(`### biome-check (advisory, issue #2204)\n`);
  stepSummary(
    `Scanned **${filesScanned}** files — **${errors}** error · **${warnings}** warn · **${infos}** info.\n`,
  );

  if (decision.byCategory.size === 0) {
    console.log("[biome-check] no lint diagnostics — clean.");
    stepSummary("No lint diagnostics — clean.\n");
    process.exit(0);
  }

  stepSummary("| Rule (category) | Count |");
  stepSummary("| --- | --- |");
  for (const [category, ds] of decision.byCategory) {
    console.log(`\n  ${category} — ${ds.length} diagnostic(s)`);
    for (const d of ds) {
      const path = d.location?.path ?? "?";
      const line = d.location?.start?.line ?? 0;
      const col = d.location?.start?.column ?? 0;
      console.log(`    ${path}:${line}:${col}  ${d.message}`);
      // GitHub Actions advisory annotation (file/line anchored).
      console.log(
        `::warning title=biome-check,file=${path},line=${line},col=${col}::${category}: ${d.message}`,
      );
    }
    stepSummary(`| ${category} | ${ds.length} |`);
  }

  if (decision.exitCode === 1) {
    console.error(`\n[biome-check] ${decision.headline}`);
    process.exit(1);
  }

  console.log(`\n[biome-check] ${decision.headline} exit 0.`);
  process.exit(0);
}

/**
 * True when this module is the process entrypoint (run as a CLI), false when it
 * is merely imported (e.g. by the regression test). Mirrors dep-boundary-check /
 * seam-check-lib so importing the module never triggers the npx spawn /
 * process.exit.
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
