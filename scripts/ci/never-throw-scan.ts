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
 * CLI:  npx tsx scripts/ci/never-throw-scan.ts [--write-baseline [--allow-grow]]
 *   exit 0 clean, 1 new findings, 2 infrastructure failure. The baseline is a
 *   sorted {key: count} object (scripts/ci/ratchet.ts, shape `counted`).
 *
 * Syntactic only (TypeScript compiler API, no type-checker). Scan set is
 * git-tracked src/ and scripts/ .ts/.mts; test/, dashboard/ and Python excluded.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { GateInvariantError } from "../../src/errors.ts";
import { defineRatchet, runIfCli } from "./ratchet.ts";
import { REPO_ROOT, listTrackedFiles } from "./seam-check-lib.ts";

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
  } catch (err) { /* intentional: surfaced as an ok:false result, printed by the CLI */
    return { ok: false, error: `scan of ${file} crashed: ${String(err)}` };
  }
}

/** Baseline key: kind, file, fnName, normalised text — never a line number. */
export function findingKey(file: string, f: Finding): string {
  return [f.kind, file, f.fnName, f.text].join("\t");
}

/** Scan every tracked file. Returns a result object; an unreadable file is `ok:false`, never a skip. */
export async function scanTrackedFiles(root: string = REPO_ROOT): Promise<ScanTrackedResult> {
  try {
    const files = await listTrackedFiles(GLOBS);
    const keys: string[] = [];
    for (const rel of files) {
      const source = await readFile(resolve(root, rel), "utf8");
      const r = scanSource(rel, source);
      if ("error" in r) return { ok: false, error: r.error };
      for (const f of r.findings) keys.push(findingKey(rel, f));
    }
    return { ok: true, keys: keys.sort() };
  } catch (err) { /* intentional: surfaced as an ok:false result, printed by the CLI */
    return { ok: false, error: `tracked-file scan failed: ${String(err)}` };
  }
}

/** Every finding key in the tree; a repeated identical finding appears once per occurrence. */
async function measure(root: string): Promise<string[]> {
  const scan = await scanTrackedFiles(root);
  if (scan.ok === false) throw new GateInvariantError(scan.error);
  return scan.keys;
}

export const neverThrowRatchet = defineRatchet({
  id: "never-throw-scan",
  baseline: "scripts/ci/never-throw-baseline.json",
  shape: "counted",
  polarity: "ceiling",
  stale: "hint",
  enforcement: "advisory",
  measure,
});

runIfCli(import.meta.url, neverThrowRatchet);
