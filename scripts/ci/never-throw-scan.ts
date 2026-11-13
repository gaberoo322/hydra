#!/usr/bin/env -S npx tsx
/**
 * STD-VERIFY-NEVER-THROW scanner — issue #5490 (hydra-retro --review check rung).
 *
 * A function whose OWN attached comment claims the never-throw contract (the
 * claim regex below) must not let an `await`, a `throw`, or a known-thrower call
 * escape outside a `try` that has a `catch`. Reviewers flagged that shape on 14
 * PRs in 30 days; this scanner makes the checkable half deterministic. The
 * reviewer still owns which modules SHOULD make the claim.
 *
 * Advisory only: one `if: always()` step in .github/workflows/advisory-checks.yml,
 * a shrink-only baseline (scripts/ci/never-throw-baseline.json). There is no
 * annotation escape: a function may not both claim never-throw and throw — guard
 * the call, return a result object, or drop the claim.
 *
 * CLI:  npx tsx scripts/ci/never-throw-scan.ts [--init | --write-baseline]
 *   exit 0 clean, 1 new findings, 2 infrastructure failure.
 *
 * Syntactic only (TypeScript compiler API, no type-checker). Scan set is
 * git-tracked src/ and scripts/ .ts/.mts; test/, dashboard/ and Python excluded.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import {
  REPO_ROOT,
  isCliEntrypoint,
  listTrackedFiles,
  loadJsonBaseline,
  writeJsonBaseline,
} from "./seam-check-lib.ts";

const NAME = "never-throw-scan";
const BASELINE_PATH = resolve(REPO_ROOT, "scripts/ci/never-throw-baseline.json");
const GLOBS = ["src/*.ts", "src/*.mts", "scripts/*.ts", "scripts/*.mts"];

const CLAIM_RE =
  /never[- ]throws?|never raises|returns? (a )?result object|STD-VERIFY-NEVER-THROW/i;
const RISKY_CALLS = new Set([
  "JSON.parse",
  "readFileSync",
  "readdirSync",
  "statSync",
  "execSync",
  "execFileSync",
]);

export type FindingKind = "unguarded-await" | "unguarded-throw" | "unguarded-call";

export interface Finding {
  kind: FindingKind;
  fnName: string;
  text: string;
}

export interface BaselineShape {
  keys: string[];
  note: string;
}

type ScanSourceResult =
  | { ok: true; findings: Finding[] }
  | { ok: false; error: string };

export type ScanTrackedResult =
  | { ok: true; keys: string[] }
  | { ok: false; error: string };

function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isFnLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n)
  );
}

/** The raw text of comments attached to `node` (leading; plus trailing for class members). */
function ownComment(sf: ts.SourceFile, node: ts.Node, isMember: boolean): string {
  const text = sf.getFullText();
  const start = node.getFullStart();
  const ranges = [
    ...(ts.getLeadingCommentRanges(text, start) ?? []),
    ...(isMember ? (ts.getTrailingCommentRanges(text, start) ?? []) : []),
  ];
  return ranges.map((r) => text.slice(r.pos, r.end)).join("\n");
}

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const obj = ts.isIdentifier(e.expression) ? e.expression.text : "";
    return obj === "JSON" ? `JSON.${e.name.text}` : e.name.text;
  }
  return "";
}

function isCatchAwait(a: ts.AwaitExpression): boolean {
  const op = a.expression;
  return (
    ts.isCallExpression(op) &&
    ts.isPropertyAccessExpression(op.expression) &&
    op.expression.name.text === "catch"
  );
}

function walkBody(fn: ts.Node, body: ts.Node, fnName: string, out: Finding[]): void {
  const visit = (n: ts.Node, guarded: boolean): void => {
    if (n !== fn && isFnLike(n)) return; // nested function boundary
    if (ts.isTryStatement(n)) {
      visit(n.tryBlock, guarded || n.catchClause !== undefined);
      if (n.catchClause) visit(n.catchClause, guarded);
      if (n.finallyBlock) visit(n.finallyBlock, guarded);
      return;
    }
    if (!guarded) {
      if (ts.isAwaitExpression(n) && !isCatchAwait(n)) {
        out.push({ kind: "unguarded-await", fnName, text: norm(n.getText()) });
      } else if (ts.isThrowStatement(n)) {
        out.push({ kind: "unguarded-throw", fnName, text: norm(n.getText()) });
      } else if (ts.isCallExpression(n) && RISKY_CALLS.has(calleeName(n))) {
        out.push({ kind: "unguarded-call", fnName, text: norm(n.getText()) });
      }
    }
    ts.forEachChild(n, (c) => visit(c, guarded));
  };
  visit(body, false);
}

function scanNode(sf: ts.SourceFile, node: ts.Node, out: Finding[]): void {
  let fn: ts.Node | undefined;
  let carrier: ts.Node = node;
  let name = "<anonymous>";
  let isMember = false;
  if (ts.isFunctionDeclaration(node)) {
    fn = node;
    name = node.name?.text ?? "default";
  } else if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    fn = node;
    name = node.name.getText(sf);
    isMember = true;
  } else if (ts.isVariableStatement(node)) {
    for (const d of node.declarationList.declarations) {
      const init = d.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        fn = init;
        carrier = node;
        name = d.name.getText(sf);
      }
    }
  }
  if (fn && CLAIM_RE.test(ownComment(sf, carrier, isMember))) {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body) walkBody(fn, body, name, out);
  }
}

/** Scan one source text. Returns a result object; a parse crash is `ok:false`, never a throw. */
export function scanSource(file: string, source: string): ScanSourceResult {
  try {
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    const findings: Finding[] = [];
    const visit = (n: ts.Node): void => {
      scanNode(sf, n, findings);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return { ok: true, findings };
  } catch (err) {
    return { ok: false, error: `scan of ${file} crashed: ${String(err)}` };
  }
}

/** Baseline key: kind, file, fnName, normalised text — never a line number. */
export function findingKey(file: string, f: Finding): string {
  return [f.kind, file, f.fnName, f.text].join("\t");
}

/** Scan every tracked file. Returns a result object; an unreadable file is `ok:false`, never a skip. */
export async function scanTrackedFiles(): Promise<ScanTrackedResult> {
  try {
    const files = await listTrackedFiles(GLOBS);
    const keys = new Set<string>();
    for (const rel of files) {
      const source = await readFile(resolve(REPO_ROOT, rel), "utf8");
      const r = scanSource(rel, source);
      if (!r.ok) return r;
      for (const f of r.findings) keys.add(findingKey(rel, f));
    }
    return { ok: true, keys: [...keys].sort() };
  } catch (err) {
    return { ok: false, error: `tracked-file scan failed: ${String(err)}` };
  }
}

export function diffKeys(
  current: string[],
  baseline: string[],
): { added: string[]; removed: string[] } {
  const base = new Set(baseline);
  const cur = new Set(current);
  return {
    added: current.filter((k) => !base.has(k)),
    removed: baseline.filter((k) => !cur.has(k)),
  };
}

export function formatFailure(added: string[]): string {
  const lines = [`[${NAME}] NEW STD-VERIFY-NEVER-THROW findings (${added.length}):`];
  for (const k of added) {
    const [kind, file, fnName, text] = k.split("\t");
    lines.push(`  ${file} ${fnName}(): ${kind}: ${text}`);
  }
  lines.push(
    "Fix: guard the call in a try/catch and return a result object, or drop the",
    "never-throw claim from the function's doc. There is no annotation escape.",
  );
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const init = argv.includes("--init");
  const write = argv.includes("--write-baseline");
  const scan = await scanTrackedFiles();
  if (!scan.ok) {
    console.error(`[${NAME}] ${scan.error}`);
    return 2;
  }
  const baseline = await loadJsonBaseline<BaselineShape>(
    BASELINE_PATH,
    { keys: [], note: "" },
  );
  const { added, removed } = diffKeys(scan.keys, baseline.keys);
  if (init || write) {
    if (write && !init && added.length > 0) {
      console.error(`[${NAME}] --write-baseline is shrink-only; refusing to add:`);
      console.error(formatFailure(added));
      return 1;
    }
    await writeJsonBaseline(BASELINE_PATH, {
      keys: scan.keys,
      note: `Auto-generated by ${NAME} on ${new Date().toISOString()}. STD-VERIFY-NEVER-THROW shrink-only ratchet (#5490).`,
    });
    console.log(`[${NAME}] baseline written: ${scan.keys.length} keys`);
    return 0;
  }
  if (added.length > 0) {
    console.error(formatFailure(added));
    return 1;
  }
  console.log(
    `[${NAME}] OK — ${scan.keys.length} tolerated finding(s)` +
      (removed.length > 0
        ? `; ${removed.length} fixed — run --write-baseline to tighten`
        : ""),
  );
  return 0;
}

if (isCliEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[${NAME}] crash:`, err);
      process.exit(2);
    },
  );
}
