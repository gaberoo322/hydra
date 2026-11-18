/**
 * scripts/ci/baseline-raise-check.ts — advisory PR guard for silent baseline
 * raises (issue #5553, parent #5550; STD-BASELINE-EDIT-ROWS reviewer aid).
 *
 * Every committed shrink-only baseline JSON is compared against its base-ref
 * version. A growth (raised number, added key, added array element, shape
 * change) fails unless the PR body carries a line
 *   `Baseline-raise: <fixture> <row-key> - <reason>`
 * matching it; any row moved (including a shrink) for a subject file that is
 * NOT in the PR diff fails the same way. The growth definition is
 * `diffBaselineGrowth` from seam-check-lib (never re-implemented here).
 *
 * Split of duties: `evaluateBaselineRaise` is pure and never throws (unit
 * tested over synthetic base/head pairs); the CLI below is the only live
 * reader (git show + the PR body from env) and exits 0 on every path except
 * usage (2), unless `--strict` is passed (exit 1 on findings). Wired as an
 * advisory step in advisory-checks.yml — never ci.yml (Verifier Core).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffBaselineGrowth, type GrowthRow } from "./seam-check-lib.ts";

/** Snapshot/cohort fixtures that match the glob but are not shrink-only ceilings. */
export const NON_RATCHET_BASELINES: readonly string[] = [
  "test/fixtures/turn-snapshot/pr-gate-baseline.json",
  "test/fixtures/qa-cohort-baseline.json",
];

export type FindingKind = GrowthRow["kind"] | "lowered" | "removed-key" | "removed-element" | "unparseable";

export interface BaselineFinding {
  fixture: string;
  /** Slash-joined row key; "/" names the root. */
  key: string;
  kind: FindingKind;
  from: string;
  to: string;
  /** Subject file is derivable and not in the PR diff. */
  outOfDiff: boolean;
}

export interface BaselineRaiseLine {
  fixture: string;
  key: string;
  reason: string;
}

export interface FixturePair {
  path: string;
  /** Raw JSON text at base; null when absent at base. */
  base: string | null;
  /** Raw JSON text at head; null when absent at head. */
  head: string | null;
}

export interface BaselineRaiseResult {
  ok: boolean;
  findings: BaselineFinding[];
  cleared: BaselineFinding[];
  blanket: string[];
  malformedLines: string[];
}

interface Row {
  path: string;
  kind: FindingKind;
  from: string;
  to: string;
  /** Untruncated JSON of the element, for subject derivation (from/to are display-only). */
  raw?: string;
}

const LINE_RE = /^Baseline-raise:\s+(\S+)\s+(\S+)\s+[—–-]\s*(.+)$/;
const LOOSE_RE = /^Baseline-raise:/;

export function parseBaselineRaiseLines(body: string): {
  lines: BaselineRaiseLine[];
  malformed: string[];
} {
  const lines: BaselineRaiseLine[] = [];
  const malformed: string[] = [];
  for (const raw of (body ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!LOOSE_RE.test(line)) continue;
    const m = LINE_RE.exec(line);
    if (m && m[3].trim() !== "") lines.push({ fixture: m[1], key: m[2], reason: m[3].trim() });
    else malformed.push(line);
  }
  return { lines, malformed };
}

export function listBaselineFixtures(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, recurse: boolean): void => {
    const dir = join(root, rel);
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (recurse) walk(r, recurse);
      } else if (e.name.endsWith("-baseline.json")) out.push(r);
    }
  };
  walk("scripts/ci", false);
  walk("test/fixtures", true);
  return out.filter((p) => !NON_RATCHET_BASELINES.includes(p)).sort();
}

function jsonKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

const short = (c: string): string => (c.length > 120 ? `${c.slice(0, 117)}...` : c);

/** Mirror of the growth walk: lowered numbers, removed keys, removed elements. */
function diffBaselineShrink(prev: unknown, next: unknown): Row[] {
  const rows: Row[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    const ka = jsonKind(a);
    if (ka !== jsonKind(b)) return; // shape change is a growth row already
    if (ka === "number") {
      if ((b as number) < (a as number)) rows.push({ path, kind: "lowered", from: String(a), to: String(b) });
    } else if (ka === "array") {
      const right = new Map<string, number>();
      for (const e of b as unknown[]) {
        const c = JSON.stringify(e);
        right.set(c, (right.get(c) ?? 0) + 1);
      }
      for (const e of a as unknown[]) {
        const c = JSON.stringify(e);
        const n = right.get(c) ?? 0;
        if (n > 0) right.set(c, n - 1);
        else rows.push({ path, kind: "removed-element", from: short(c), to: "(absent)", raw: c });
      }
    } else if (ka === "object") {
      const oa = a as Record<string, unknown>;
      const ob = b as Record<string, unknown>;
      for (const k of Object.keys(oa)) {
        const sub = path ? `${path}/${k}` : k;
        if (!Object.hasOwn(ob, k)) rows.push({ path: sub, kind: "removed-key", from: "(present)", to: "(absent)" });
        else walk(oa[k], ob[k], sub);
      }
    }
  };
  walk(prev, next, "");
  return rows;
}

const looksLikePath = (s: string): boolean => /^[\w.@-]+(\/[\w.@-]+)+$/.test(s) && /\.[A-Za-z0-9]+$/.test(s);

/** Deterministic subject-file candidates for a row, or null when none is derivable. */
function subjectCandidates(row: Row): string[] | null {
  if (row.kind === "added-element" || row.kind === "removed-element") {
    const text = row.raw ?? (row.kind === "removed-element" ? row.from : row.to);
    let el: unknown = text;
    try {
      el = JSON.parse(text);
    } catch {
      /* intentional: truncated display text (growth rows) is not JSON; recover the string prefix */
      if (text.startsWith('"')) el = text.replace(/^"/, "").replace(/\.\.\.$/, "").replace(/\\t/g, "\t");
    }
    if (typeof el !== "string") return null;
    const fields = el.split("\t");
    if (fields.length > 1) return fields[1] && looksLikePath(fields[1]) ? [fields[1]] : null;
    return looksLikePath(el) ? [el] : null;
  }
  const allSegs = row.path.split("/").filter(Boolean);
  // Nested count rows (files/<path>.md/<counter>) end in a counter name, not the
  // file: trim trailing segments to the last one carrying a file extension.
  let last = allSegs.length - 1;
  while (last >= 0 && !/\.[A-Za-z0-9]+$/.test(allSegs[last])) last--;
  const segs = last >= 0 ? allSegs.slice(0, last + 1) : allSegs;
  const cands: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const c = segs.slice(i).join("/");
    if (c.includes("/") && looksLikePath(c)) cands.push(c);
  }
  return cands.length ? cands : null;
}

function isOutOfDiff(row: Row, changed: ReadonlySet<string>): boolean {
  const cands = subjectCandidates(row);
  if (!cands) return false;
  return !cands.some((c) => changed.has(c));
}

export function evaluateBaselineRaise(input: {
  fixtures: readonly FixturePair[];
  changedFiles: readonly string[];
  prBody: string;
}): BaselineRaiseResult {
  const findings: BaselineFinding[] = [];
  const cleared: BaselineFinding[] = [];
  const blanket: string[] = [];
  const { lines, malformed } = parseBaselineRaiseLines(input.prBody ?? "");
  const known = new Set(input.fixtures.map((f) => f.path));
  const malformedLines = [...malformed];
  const valid: BaselineRaiseLine[] = [];
  for (const l of lines) {
    if (known.has(l.fixture)) valid.push(l);
    else malformedLines.push(`Baseline-raise: ${l.fixture} ${l.key} - ${l.reason}`);
  }
  const changed = new Set(input.changedFiles);
  const blanketUsed = new Set<string>();

  for (const f of input.fixtures) {
    if (f.base === null || f.head === null) continue; // seeded or retired: no findings
    let base: unknown;
    let head: unknown;
    try {
      base = JSON.parse(f.base);
      head = JSON.parse(f.head);
    } catch {
      /* intentional: an unparseable fixture is reported as a finding, never thrown */
      findings.push({ fixture: f.path, key: "/", kind: "unparseable", from: "", to: "", outOfDiff: false });
      continue;
    }
    const rows: Array<{ row: Row; growth: boolean }> = [
      ...diffBaselineGrowth(base, head).map((row) => ({ row: row as Row, growth: true })),
      ...diffBaselineShrink(base, head).map((row) => ({ row, growth: false })),
    ];
    for (const { row, growth } of rows) {
      const outOfDiff = isOutOfDiff(row, changed);
      if (!growth && !outOfDiff) continue; // in-diff shrink passes silently
      const finding: BaselineFinding = {
        fixture: f.path,
        key: row.path === "" ? "/" : row.path,
        kind: row.kind,
        from: row.from,
        to: row.to,
        outOfDiff,
      };
      const clearedBy = valid.find((l) => l.fixture === f.path && (l.key === finding.key || l.key === "*"));
      if (clearedBy) {
        cleared.push(finding);
        if (clearedBy.key === "*" && !blanketUsed.has(f.path)) {
          blanketUsed.add(f.path);
          blanket.push(f.path);
        }
      } else findings.push(finding);
    }
  }
  return { ok: findings.length === 0, findings, cleared, blanket, malformedLines };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function gitShow(root: string, sha: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${sha}:${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    /* intentional: path absent at base (new ratchet) is a seed, not an error */
    return null;
  }
}

/** Both sides commit-pinned: head is read from the head commit, never the working tree (a pull_request checkout is the refs/pull/N/merge commit). */
export function buildFixturePairs(
  paths: readonly string[],
  mergeBase: string,
  head: string,
  show: (sha: string, path: string) => string | null,
): FixturePair[] {
  return paths.map((path) => ({ path, base: show(mergeBase, path), head: show(head, path) }));
}

export function formatSummary(r: BaselineRaiseResult): string {
  const out = ["### Baseline-raise check (advisory)", ""];
  if (r.findings.length === 0) out.push("No unaccompanied baseline raises.");
  else {
    out.push("| fixture | row | kind | change | out-of-diff |", "|---|---|---|---|---|");
    for (const f of r.findings) {
      out.push(`| ${f.fixture} | ${f.key} | ${f.kind} | ${f.from} -> ${f.to} | ${f.outOfDiff ? "yes" : "no"} |`);
    }
  }
  if (r.blanket.length) out.push("", `Blanket clearances (\`*\`): ${r.blanket.join(", ")}`);
  if (r.malformedLines.length) {
    out.push("", "Malformed Baseline-raise lines (cleared nothing):", ...r.malformedLines.map((l) => `- ${l}`));
  }
  return out.join("\n") + "\n";
}

export function main(argv: string[], env: NodeJS.ProcessEnv): number {
  const take = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = take("--base");
  const head = take("--head");
  const strict = argv.includes("--strict");
  if (!base || !head) {
    console.error("usage: baseline-raise-check.ts --base <sha> --head <sha> [--strict]  (env PR_BODY)");
    return 2;
  }
  const root = resolve(take("--root") ?? ".");
  try {
    // Compare against the merge-base so a master that advanced after the PR
    // branched never shows up as a spurious raise (matches the `...` diff).
    let mergeBase = base;
    try {
      mergeBase = execFileSync("git", ["merge-base", base, head], { cwd: root, encoding: "utf8" }).trim() || base;
    } catch {
      /* intentional: no merge-base (shallow clone) — fall back to the base ref as given */
    }
    const changedFiles = execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const fixtures = buildFixturePairs(listBaselineFixtures(root), mergeBase, head, (sha, path) =>
      gitShow(root, sha, path),
    );
    const result = evaluateBaselineRaise({ fixtures, changedFiles, prBody: env.PR_BODY ?? "" });
    for (const f of result.findings) {
      console.log(`::warning title=baseline-raise::${f.fixture} ${f.key} ${f.kind} ${f.from}->${f.to}`);
    }
    for (const l of result.malformedLines) console.log(`::warning title=baseline-raise::malformed line: ${l}`);
    for (const b of result.blanket) console.log(`::warning title=baseline-raise::blanket clearance for ${b}`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, formatSummary(result));
    console.log(JSON.stringify(result));
    return strict && !result.ok ? 1 : 0;
  } catch (err) {
    /* intentional: advisory contract (INV-7) — surface a ::warning:: and exit 0, never fail the PR */
    console.log(`::warning title=baseline-raise::check could not run: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2), process.env));
}
