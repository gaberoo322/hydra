#!/usr/bin/env -S npx tsx
/**
 * probe-search — agent-callable semantic/structural code search over the Hydra
 * source tree (tool-scout finding #1799).
 *
 * Where `grep`/`ripgrep` match a TEXT pattern and `ast-search` (scripts/ast-search.ts,
 * #1797) matches an EXACT AST shape, probe answers the fuzzier agent question
 * "where in this codebase does X happen?" — it combines ripgrep speed with
 * tree-sitter AST parsing and BM25 keyword ranking, returning whole code BLOCKS
 * (functions/classes containing the match) ranked by relevance, with zero
 * indexing step. That makes it the right tool when you don't know the exact
 * identifier or AST shape yet ("find the auth handling", "where is retry logic")
 * and want ranked, context-bearing results rather than raw match lines.
 *
 * Lane boundary (keep these distinct so agents reach for the right one):
 *   - ast-search  — EXACT structural/AST queries on TS ("every `new Redis($$$)`",
 *                   "every caller of moveItemToLane($$$)"). Zero false positives,
 *                   results sorted positionally.
 *   - probe-search — FUZZY relevance-ranked block search across any language in
 *                   the tree ("where is the embedding backend configured?").
 *                   Results sorted by BM25 score, most-relevant first.
 *   - OpenViking  — SEMANTIC similarity over accumulated knowledge ("what concept
 *                   relates to X?"); requires an embedding index + Ollama backend.
 *
 * Provenance / design choice (issue #1799): probe is invoked via
 * `npx -p @probelabs/probe@<pinned>` rather than added to package.json
 * dependencies — identical rationale to ast-search (#1797), comby (#1798), and
 * promptfoo (#1806): it keeps probe OFF the ADR-0005 runtime-dep allowlist (only
 * express/ioredis/ws/@sentry/node/zod are runtime deps) AND off the lavamoat
 * allow-scripts gate (no new lifecycle script to allowlist). npx resolves it into
 * the shared npm cache on first use; no project node_modules / package-lock
 * mutation. The version is pinned in PROBE_SPEC below so the binary is
 * reproducible across runs.
 *
 * The issue's higher-leverage MCP-server path (`@probelabs/probe mcp` registered
 * in .claude/settings.json) is deliberately OUT of scope here — that mutates an
 * operator-controlled hooks file and was filed as an operator decision "after
 * smoke-test". This CLI wrapper is the issue's own documented "CLI fallback …
 * always available" and respects the no-dependency lane.
 *
 * Usage:
 *   npx tsx scripts/probe-search.ts --query 'embedding backend config' [--path src/] [--max 5] [--text]
 *   npm run probe-search -- --query 'retry logic' --path src/ --max 10
 *
 * Flags:
 *   --query <q>   (required) the search query. Supports probe's AND/OR boolean
 *                 operators, e.g. 'login OR auth'.
 *   --path <p>    directory or file to search (default: src/). Repeatable.
 *   --max <n>     max results to return (default: 10). Maps to probe --max-results.
 *   --text        print a compact human view (file:lines + first code line) instead
 *                 of the JSON match array (agent mode, the default).
 *
 * Output (default / agent mode): a JSON array of
 *   { file, startLine, endLine, language, score, code }
 * sorted by score DESC (most relevant first). `file` is made repo-relative.
 * Exit 0 even when there are zero matches — "no matches" is a valid answer, not
 * an error (a non-zero exit is reserved for an actual tool/invocation failure so
 * callers can distinguish the two).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

/** Pinned probe CLI version — keep in lockstep with the package.json script. */
const PROBE_SPEC = "@probelabs/probe@0.6.0-rc325";

/** A single result block as emitted by `probe search --format json`. */
interface RawResult {
  file?: string;
  /** [startLine, endLine] (1-based, inclusive). */
  lines?: [number, number] | number[];
  code?: string;
  language?: string;
  bm25_score?: number;
}

interface RawPayload {
  results?: RawResult[];
}

interface NormalisedResult {
  file: string;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  code: string;
}

interface Args {
  query: string;
  paths: string[];
  max: number;
  textOnly: boolean;
}

/**
 * Parse argv into a typed Args. Pure (takes argv, returns Args | error) so the
 * regression test can pin flag handling without spawning a process.
 */
export function parseArgs(argv: string[]): { ok: true; args: Args } | { ok: false; error: string } {
  let query: string | undefined;
  const paths: string[] = [];
  let max = 10;
  let textOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--query":
        query = argv[++i];
        break;
      case "--path":
        if (argv[i + 1] !== undefined) paths.push(argv[++i]);
        break;
      case "--max": {
        const raw = argv[++i];
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          return { ok: false, error: `--max must be a positive integer, got: ${raw}` };
        }
        max = n;
        break;
      }
      case "--text":
        textOnly = true;
        break;
      default:
        return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  if (!query) {
    return { ok: false, error: "Missing required --query <search query>" };
  }
  return { ok: true, args: { query, paths: paths.length ? paths : ["src/"], max, textOnly } };
}

/**
 * Normalise probe's `--format json` payload into the stable minimal shape, with
 * `file` made repo-relative and results sorted by BM25 score DESC (most relevant
 * first — that ranking is the whole point of probe over grep). Pure (takes
 * parsed JSON + a repo root, returns rows) so the test can pin the mapping
 * against a recorded probe payload without invoking the CLI.
 */
export function normaliseResults(payload: RawPayload, repoRoot: string): NormalisedResult[] {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const rows: NormalisedResult[] = results.map((r) => {
    const file = r.file ?? "";
    // probe emits absolute paths; make them repo-relative for stable, portable
    // output. path.relative on an already-relative or empty path is harmless.
    const rel = file && path.isAbsolute(file) ? path.relative(repoRoot, file) : file;
    const lines = Array.isArray(r.lines) ? r.lines : [];
    return {
      file: rel,
      startLine: typeof lines[0] === "number" ? lines[0] : 0,
      endLine: typeof lines[1] === "number" ? lines[1] : 0,
      language: r.language ?? "",
      score: typeof r.bm25_score === "number" ? r.bm25_score : 0,
      code: r.code ?? "",
    };
  });
  // Sort by score DESC; tie-break on (file, startLine) for determinism.
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.startLine - b.startLine;
  });
  return rows;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.ok === false) {
    console.error(parsed.error);
    console.error(
      "Usage: npx tsx scripts/probe-search.ts --query '<search query>' [--path src/] [--max 10] [--text]",
    );
    process.exit(2);
    return;
  }
  const { query, paths, max, textOnly } = parsed.args;

  // npx -p @probelabs/probe@<pinned> probe search <query> <paths...> --format json --max-results <n>
  const cliArgs = [
    "--yes",
    "-p",
    PROBE_SPEC,
    "probe",
    "search",
    query,
    ...paths,
    "--format",
    "json",
    "--max-results",
    String(max),
  ];
  const result = spawnSync("npx", cliArgs, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

  if (result.error) {
    console.error(`probe-search: failed to invoke probe via npx: ${result.error.message}`);
    process.exit(1);
  }
  // probe exits 0 with an empty results array when there are no matches; a
  // non-zero exit here is a real failure (bad query, download failure) — surface it.
  if (result.status !== 0) {
    console.error(`probe-search: probe exited ${result.status}`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }

  // probe prints npm/ranking notices to stderr and the JSON document to stdout.
  // Slice from the first '{' so any stray stdout preamble can't break the parse.
  const stdout = result.stdout || "";
  const jsonStart = stdout.indexOf("{");
  let payload: RawPayload;
  try {
    payload = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : "{}") as RawPayload;
  } catch (err) {
    console.error(`probe-search: could not parse probe JSON output: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const rows = normaliseResults(payload, process.cwd());
  if (textOnly) {
    for (const r of rows) {
      const firstLine = r.code.split("\n")[0] ?? "";
      console.log(`${r.file}:${r.startLine}-${r.endLine} (${r.score.toFixed(2)}): ${firstLine}`);
    }
  } else {
    console.log(JSON.stringify(rows, null, 2));
  }
}

// Only run as a CLI — importing the module (e.g. from the regression test) must
// not spawn probe or call process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
