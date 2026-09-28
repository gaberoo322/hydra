#!/usr/bin/env -S npx tsx
/**
 * ast-search — agent-callable structural code search over the Hydra source tree.
 *
 * Where `grep`/`ripgrep` match TEXT, ast-grep matches SYNTAX: you give it a code
 * snippet with metavariables ($EXPR matches one node, $$$ARGS matches a list) and
 * it returns every AST node with that structure — zero false positives from
 * comments or string literals. This is a thin Adapter over the upstream ast-grep
 * CLI (tool-scout finding #1797): it shells `ast-grep run --json=compact`,
 * normalises the output into a stable, minimal JSON shape, and prints it so a
 * dev_orch / hydra-dev agent can answer call-site questions
 * ("find all callers of moveItemToLane") without parsing CLI stdout by hand.
 *
 * Provenance / design choice (issue #1797):
 *   ast-grep is invoked via `npx -p @ast-grep/cli@<pinned>` rather than added to
 *   package.json dependencies. This keeps it OFF the runtime-dep allowlist
 *   (ADR-0005: only express/ioredis/ws/@sentry/node/zod are runtime deps) AND
 *   off the lavamoat allow-scripts gate (the CLI carries a native-binary
 *   postinstall). npx resolves it into the shared npm cache on first use; no
 *   project node_modules / package-lock mutation, no new lifecycle script to
 *   allowlist. The version is pinned in AST_GREP_SPEC below so the binary is
 *   reproducible across runs.
 *
 * Usage:
 *   npx tsx scripts/ast-search.ts --pattern 'moveItemToLane($$$)' [--lang ts] [--path src/] [--text]
 *   npm run ast-search -- --pattern 'new Redis($$$)' --path src/
 *   npx tsx scripts/ast-search.ts --rule fail-loud-catch --path src/a.ts --path src/b.ts
 *
 * Flags:
 *   --pattern <p>  ast-grep pattern, e.g. '$_.then($$$)'. Required unless --rule.
 *   --rule <id>    rule mode (issue #4732): run ONE project rule from
 *                  src/ast-grep-rules/ (by its `id`, via `ast-grep scan
 *                  --filter`) over the --path list instead of an ad-hoc
 *                  pattern. This is how hydra-dev lints a PR's changed files
 *                  pre-PR (e.g. `--rule fail-loud-catch`). Mutually exclusive
 *                  with --pattern; --lang is ignored (the rule declares it).
 *   --lang <l>     language grammar (default: ts). One of ast-grep's lang ids.
 *   --path <p>     directory or file to scan (default: src/). Repeatable.
 *   --text         print the matched source text only, one per line (human mode)
 *                  instead of the JSON match array (agent mode, the default).
 *
 * Output (default / agent mode): a JSON array of
 *   { file, line, column, endLine, endColumn, text }
 * sorted by (file, line). Exit 0 even when there are zero matches — "no matches"
 * is a valid answer, not an error (a non-zero exit is reserved for an actual
 * tool/invocation failure so callers can distinguish the two).
 */

import { spawnSync } from "node:child_process";
import { parseCliArgs } from "../src/cli-args.ts";

/** Pinned ast-grep CLI version — keep in lockstep with the CI workflow. */
const AST_GREP_SPEC = "@ast-grep/cli@0.43.0";

interface RawMatch {
  text?: string;
  file?: string;
  range?: {
    start?: { line?: number; column?: number };
    end?: { line?: number; column?: number };
  };
}

interface NormalisedMatch {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  text: string;
}

interface Args {
  /** Ad-hoc pattern (pattern mode). Empty string in rule mode. */
  pattern: string;
  /** Project rule id (rule mode, issue #4732). Null in pattern mode. */
  rule: string | null;
  lang: string;
  paths: string[];
  textOnly: boolean;
}

/**
 * Parse argv into a typed Args. Pure (takes argv, returns Args | error) so the
 * regression test can pin flag handling without spawning a process.
 */
export function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  const parsed = parseCliArgs(argv, {
    pattern: { type: "string" },
    rule: { type: "string" },
    lang: { type: "string", default: "ts" },
    path: { type: "string", multiple: true },
    text: { type: "boolean", default: false },
  });
  if (parsed.ok === false) return parsed;
  const { pattern, rule, lang, path, text } = parsed.values;

  if (pattern && rule) {
    return { ok: false, error: "--pattern and --rule are mutually exclusive" };
  }
  if (!pattern && !rule) {
    return { ok: false, error: "Missing required --pattern <ast-grep pattern> (or --rule <rule-id>)" };
  }
  return {
    ok: true,
    args: {
      pattern: pattern ?? "",
      rule: rule ?? null,
      lang: lang ?? "ts",
      paths: path && path.length ? path : ["src/"],
      textOnly: text === true,
    },
  };
}

/**
 * Build the argv passed to `npx` for the parsed Args. Pure so the regression
 * test can pin both modes without spawning ast-grep:
 *   pattern mode → `ast-grep run --pattern <p> --lang <l> --json=compact <paths>`
 *   rule mode    → `ast-grep scan --filter ^<id>$ --json=compact <paths>`
 *                  (sgconfig.yml's ruleDirs supplies the rule; the anchored
 *                  regex keeps `--filter` from matching a longer sibling id).
 */
export function buildCliArgs(args: Args): string[] {
  const head = ["--yes", "-p", AST_GREP_SPEC, "ast-grep"];
  if (args.rule !== null) {
    return [...head, "scan", "--filter", `^${escapeRegex(args.rule)}$`, "--json=compact", ...args.paths];
  }
  return [...head, "run", "--pattern", args.pattern, "--lang", args.lang, "--json=compact", ...args.paths];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalise the upstream `--json=compact` array into the stable minimal shape.
 * Pure (takes parsed JSON, returns rows) so the test can pin the mapping
 * against a recorded ast-grep payload without invoking the CLI.
 */
export function normaliseMatches(raw: RawMatch[]): NormalisedMatch[] {
  const rows: NormalisedMatch[] = raw.map((m) => ({
    file: m.file ?? "",
    line: m.range?.start?.line ?? 0,
    column: m.range?.start?.column ?? 0,
    endLine: m.range?.end?.line ?? 0,
    endColumn: m.range?.end?.column ?? 0,
    text: m.text ?? "",
  }));
  rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return rows;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.ok === false) {
    console.error(parsed.error);
    console.error(
      "Usage: npx tsx scripts/ast-search.ts (--pattern '<ast-grep pattern>' | --rule <rule-id>) [--lang ts] [--path src/] [--text]",
    );
    process.exit(2);
    return;
  }
  const { textOnly } = parsed.args;
  const cliArgs = buildCliArgs(parsed.args);
  const result = spawnSync("npx", cliArgs, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    console.error(`ast-search: failed to invoke ast-grep via npx: ${result.error.message}`);
    process.exit(1);
  }
  // ast-grep exits 0 with `[]` when there are no matches (and, in rule mode, when
  // a `severity: warning` rule has hits); a non-zero exit here is a real failure
  // (bad pattern, unknown lang/rule, download failure) — surface it.
  if (result.status !== 0) {
    console.error(`ast-search: ast-grep exited ${result.status}`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }

  let raw: RawMatch[];
  try {
    raw = JSON.parse(result.stdout || "[]") as RawMatch[];
  } catch (err) {
    console.error(`ast-search: could not parse ast-grep JSON output: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const rows = normaliseMatches(raw);
  if (textOnly) {
    for (const r of rows) console.log(`${r.file}:${r.line}:${r.column}: ${r.text}`);
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }
}

// Only run as a CLI — importing the module (e.g. from the regression test) must
// not spawn ast-grep or call process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
