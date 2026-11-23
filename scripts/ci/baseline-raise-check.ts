/**
 * scripts/ci/baseline-raise-check.ts — advisory PR guard for silent baseline
 * raises (issue #5553, parent #5550; STD-BASELINE-EDIT-ROWS reviewer aid).
 *
 * Every committed baseline JSON the registry (`ratchets.ts`) gives a polarity
 * is compared against its base-ref version with the Ratchet module's one
 * two-direction diff (`diffBaselineJson`). The LOOSENING side fails unless the
 * PR body carries a line
 *   `Baseline-raise: <fixture> <row-key> - <reason>`
 * matching it: a ceiling loosens by growing (raised number, added key, added
 * array element), a floor by shrinking (lowered number, removed key or
 * element); a shape change loosens under either. The TIGHTENING side passes
 * silently unless its subject file is NOT in the PR diff. A baseline with no
 * polarity (a fixture, or an external without one) is skipped.
 *
 * Split of duties: `evaluateBaselineRaise` is pure and never throws (unit
 * tested over synthetic base/head pairs); the CLI below is the only live
 * reader (git show + the PR body from env) and exits 0 on every path except
 * usage (2), unless `--strict` is passed (exit 1 on findings). Wired as an
 * advisory step in advisory-checks.yml — never ci.yml (Verifier Core).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffBaselineJson, loosening, type BaselineJsonRow, type RatchetPolarity } from "./ratchet.ts";
import { listBaselineFixtures, registryRowFor, rowPolarity } from "./ratchets.ts";

export type FindingKind = BaselineJsonRow["kind"] | "unparseable";

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
  /** Which direction is bad (from the registry); absent means no polarity and the pair is skipped. */
  polarity?: RatchetPolarity;
}

export interface BaselineRaiseResult {
  ok: boolean;
  findings: BaselineFinding[];
  cleared: BaselineFinding[];
  blanket: string[];
  malformedLines: string[];
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

const looksLikePath = (s: string): boolean => /^[\w.@-]+(\/[\w.@-]+)+$/.test(s) && /\.[A-Za-z0-9]+$/.test(s);

/** Deterministic subject-file candidates for a row, or null when none is derivable. */
function subjectCandidates(row: BaselineJsonRow): string[] | null {
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
  // A counted key may be `<path>\t<ident>` (zizmor): the subject file is the path half.
  const tabAt = row.path.indexOf("\t");
  if (tabAt >= 0) {
    const file = row.path.slice(0, tabAt);
    return looksLikePath(file) ? [file] : null;
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

/** The tab-free spelling of a `<path>\t<ident>` key (`<path>:<ident>`), since a Baseline-raise key is one \S+ token. */
function tabFreeKey(key: string): string {
  return key.replace("\t", ":");
}

function isOutOfDiff(row: BaselineJsonRow, changed: ReadonlySet<string>): boolean {
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
    if (f.polarity === undefined) continue; // no direction (fixture / external without one): nothing to guard
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
    const { grown, shrunk } = diffBaselineJson(base, head);
    const { loosened, tightened } = loosening({ grown, shrunk }, f.polarity);
    const rows = [
      ...loosened.map((row) => ({ row, loosens: true })),
      ...tightened.map((row) => ({ row, loosens: false })),
    ];
    for (const { row, loosens } of rows) {
      const outOfDiff = isOutOfDiff(row, changed);
      if (!loosens && !outOfDiff) continue; // in-diff tightening passes silently
      const finding: BaselineFinding = {
        fixture: f.path,
        key: row.path === "" ? "/" : row.path,
        kind: row.kind,
        from: row.from,
        to: row.to,
        outOfDiff,
      };
      const clearedBy = valid.find((l) => l.fixture === f.path && (l.key === finding.key || l.key === "*" || l.key === tabFreeKey(finding.key)));
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
    ).map((pair) => {
      const row = registryRowFor(pair.path);
      const polarity = row ? rowPolarity(row) : undefined;
      return polarity === undefined ? pair : { ...pair, polarity };
    });
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
