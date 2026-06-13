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
 *
 * Flags:
 *   --pattern <p>  (required) ast-grep pattern, e.g. '$_.then($$$)'
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
  pattern: string;
  lang: string;
  paths: string[];
  textOnly: boolean;
}

/**
 * Parse argv into a typed Args. Pure (takes argv, returns Args | error) so the
 * regression test can pin flag handling without spawning a process.
 */
export function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  let pattern: string | undefined;
  let lang = "ts";
  const paths: string[] = [];
  let textOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--pattern":
        pattern = argv[++i];
        break;
      case "--lang":
        lang = argv[++i] ?? lang;
        break;
      case "--path":
        if (argv[i + 1] !== undefined) paths.push(argv[++i]);
        break;
      case "--text":
        textOnly = true;
        break;
      default:
        return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  if (!pattern) {
    return { ok: false, error: "Missing required --pattern <ast-grep pattern>" };
  }
  return { ok: true, args: { pattern, lang, paths: paths.length ? paths : ["src/"], textOnly } };
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
      "Usage: npx tsx scripts/ast-search.ts --pattern '<ast-grep pattern>' [--lang ts] [--path src/] [--text]",
    );
    process.exit(2);
    return;
  }
  const { pattern, lang, paths, textOnly } = parsed.args;

  // npx -p @ast-grep/cli@<pinned> ast-grep run --pattern <p> --lang <l> --json=compact <paths...>
  const cliArgs = [
    "--yes",
    "-p",
    AST_GREP_SPEC,
    "ast-grep",
    "run",
    "--pattern",
    pattern,
    "--lang",
    lang,
    "--json=compact",
    ...paths,
  ];
  const result = spawnSync("npx", cliArgs, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    console.error(`ast-search: failed to invoke ast-grep via npx: ${result.error.message}`);
    process.exit(1);
  }
  // ast-grep exits 0 with `[]` when there are no matches; a non-zero exit here is
  // a real failure (bad pattern, unknown lang, download failure) — surface it.
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
