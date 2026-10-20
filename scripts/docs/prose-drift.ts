/**
 * Prose drift scanner (issue #4597 — docs-epic 11/13, per the #4543 resolution
 * and the #4544 decision-3 links check).
 *
 * The generated inventories (docs/generated/*.json) are drift-guarded by
 * test/generated-inventories-drift.test.mts; this module guards the PROSE
 * AROUND them. Four checks over the hand-written docs, one extraction truth:
 *
 *   1. identifier existence — every backticked repo path / API route / Redis
 *      key family / hydra-* skill / UPPER_SNAKE env var in a pinned doc must
 *      resolve against the tree (git ls-files) or the extracted inventory;
 *   2. retired-term denylist — test/fixtures/docs-retired-terms.json names
 *      subsystems that must not be presented as live outside history, with a
 *      paragraph-scoped admit rule (cite the retiring ADR/PR, or link
 *      docs/historical/);
 *   3. count claims — "N routers/routes/ADRs/…" prose must equal the
 *      docs/generated/counts.json row for that family;
 *   4. links — relative markdown links in living docs must resolve to a
 *      tracked file (or a directory prefix of one).
 *
 * Scope is READ from docs/generated/corpus.json: tier `living` gets all four
 * checks; tier `playbook` plus every tracked .md under
 * docs/operator-playbooks/_fragments/ gets existence + denylist only; tiers
 * `adr` and `historical` are exempt (they are the historical record the
 * denylist admits INTO). docs/operator-playbooks/_vendor/ is pinned
 * byte-for-byte to upstream by vendor-drift and never appears in the corpus,
 * so it is exempt by construction.
 *
 * The first baseline (test/fixtures/docs-drift-baseline.json) absorbs the
 * offenders already on master; the guard is two-directional — a NEW offender
 * fails, and a STALE baseline row (prose fixed, baseline not regenerated)
 * fails too, so the baseline can only shrink. Epic #4586's corpus-fix bullets
 * are what shrink it toward [].
 *
 * `npm run docs:drift` (this file's CLI) prints the same report the required
 * test asserts; `npm run docs:drift -- --update-baseline` rewrites the
 * fixture from a fresh scan.
 *
 * Stdlib-only (ADR-0005): fs + git ls-files. No Redis, no network, no
 * running service, no markdown parser — fenced code, YAML frontmatter and
 * HTML comments are BLANKED (non-newline chars → spaces, offsets and line
 * numbers preserved, the inventories/scan.ts blank() convention) and the
 * claim grammars are regexes over the blanked prose.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { byString, lineOf, resolveRelative, trackedFiles } from "./inventories/scan.ts";

/** One denylist row: the retired term and the ADR-NNNN / #NNNN that retired it. */
export interface RetiredTerm {
  term: string;
  retiredBy: string;
}

/** The eight offender kinds (five identifier kinds + the three prose checks). */
export type OffenderKind = "path" | "route" | "redis-key" | "skill" | "env-var" | "retired-term" | "count" | "link" | "unreadable-input";

/** One unresolved claim: where, what kind, the token, and the per-kind remedy. */
export interface Offender {
  /** Repo-relative doc path. */
  file: string;
  /** 1-based line of the (first) occurrence — reporting only, never a baseline key. */
  line: number;
  kind: OffenderKind;
  /** The claim text verbatim (for count: the matched phrase, e.g. "six chores"). */
  token: string;
  /** Concrete remedy rendered into the failure message. */
  fix: string;
}

/** A corpus row as this scanner reads it (docs/generated/corpus.json rows). */
export interface CorpusScopeRow {
  path: string;
  tier: string;
}

/** One counts.json row. */
export interface CountRow {
  family: string;
  metric: string;
  value: number;
}

/** Everything scanProseDrift can have injected, so rule tests run on throwaway data. */
export interface ProseScanOptions {
  corpusRows?: CorpusScopeRow[];
  fragmentFiles?: string[];
  tracked?: string[];
  routePaths?: string[];
  redisKeyPatterns?: string[];
  skillNames?: string[];
  envVarNames?: string[];
  counts?: CountRow[];
  retiredTerms?: RetiredTerm[];
  sourceBlob?: string;
}

export const BASELINE_FILE = "test/fixtures/docs-drift-baseline.json";
export const RETIRED_TERMS_FILE = "test/fixtures/docs-retired-terms.json";
export const FIX_COMMAND = "Fix: npm run docs:drift -- --update-baseline";

// ---------------------------------------------------------------------------
// Prose blanking + paragraph segmentation
// ---------------------------------------------------------------------------

/** Replace every non-newline character of `text` with a space (the scan.ts blank() convention). */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Blank YAML frontmatter, fenced code blocks (``` or ~~~) and HTML comments
 * of a markdown source. Newlines and therefore every offset and line number
 * are preserved, so a claim found in the blanked text reports the line it
 * sits on in the ORIGINAL. Fences blank to whitespace-only lines, so a code
 * block also acts as a paragraph separator for the admit rule.
 */
export function blankProse(src: string): string {
  const lines = src.split("\n");
  let start = 0;
  // YAML frontmatter: only when the very first line is a bare `---`.
  if (lines[0] === "---") {
    let close = 1;
    while (close < lines.length && lines[close] !== "---") close += 1;
    if (close < lines.length) {
      for (let i = 0; i <= close; i += 1) lines[i] = blank(lines[i]);
      start = close + 1;
    }
  }
  // Fenced code: toggle on an opening fence line, blank everything until the
  // matching closer (same marker character, at least three).
  // CommonMark closer rule: same marker character, run length >= the opener's,
  // and nothing but whitespace after it (no info string).
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (let i = start; i < lines.length; i += 1) {
    const fence = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fenceChar === null) {
      if (fence) {
        fenceChar = fence[1][0];
        fenceLen = fence[1].length;
        lines[i] = blank(lines[i]);
      }
    } else {
      lines[i] = blank(lines[i]);
      if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen && fence[2].trim() === "") {
        fenceChar = null;
      }
    }
  }
  if (fenceChar !== null) {
    console.error("[prose-drift] unclosed code fence at end of file — the rest of the file was treated as code");
  }
  let out = lines.join("\n");
  // HTML comments last: fences are already blanked, so a comment marker inside
  // a fence can no longer pair with prose.
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => blank(m));
  return out;
}

/** One paragraph: its char span and start line in the blanked text. */
export interface ParagraphSpan {
  start: number;
  startLine: number;
  text: string;
}

const TABLE_ROW_RE = /^\s*\|/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)(?:\s|$)/;

/**
 * Segment blanked prose into paragraphs for the admit rule: a paragraph is a
 * maximal run of consecutive non-blank lines, EXCEPT that a table row or a
 * list item is its own paragraph (its continuation lines attach to it — an
 * indented follow-up line under a bullet belongs to that bullet's claim).
 */
export function paragraphSpans(blanked: string): ParagraphSpan[] {
  const lines = blanked.split("\n");
  const spans: ParagraphSpan[] = [];
  let cur: string[] | null = null;
  let curStart = 0;
  let curStartLine = 0;
  let off = 0;
  const flush = (): void => {
    if (cur !== null) {
      spans.push({ start: curStart, startLine: curStartLine, text: cur.join("\n") });
      cur = null;
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      flush();
    } else if (TABLE_ROW_RE.test(line)) {
      flush();
      spans.push({ start: off, startLine: i + 1, text: line });
    } else if (LIST_ITEM_RE.test(line)) {
      flush();
      cur = [line];
      curStart = off;
      curStartLine = i + 1;
    } else if (cur === null) {
      cur = [line];
      curStart = off;
      curStartLine = i + 1;
    } else {
      cur.push(line);
    }
    off += line.length + 1;
  }
  flush();
  return spans;
}

/** The paragraph containing char `index`, or null when it falls between spans. */
export function paragraphAt(spans: ParagraphSpan[], index: number): ParagraphSpan | null {
  for (const p of spans) {
    if (index >= p.start && index <= p.start + p.text.length) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Identifier claims — grammar + resolvers (INV-4)
// ---------------------------------------------------------------------------

const PATH_CLAIM_RE = /^(?:src|scripts|\.github|config|docs|dashboard|test|bin)\/.+/;
const ROUTE_CLAIM_RE = /^(?:[A-Z]+ )?\/api\/.+/;
const REDIS_CLAIM_RE = /^hydra:.+/;
const SKILL_CLAIM_RE = /^\/?hydra-[a-z]+(?:-[a-z]+)*$/;
const ENV_CLAIM_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/** The identifier-claim kinds, in dispatch order. */
export type IdentifierKind = "path" | "route" | "redis-key" | "skill" | "env-var";

/**
 * Classify a backtick token into an identifier-claim kind, or null when it is
 * not a claim at all. One deterministic resolver per kind, no guessing of
 * kind by context: the token's SHAPE is the kind.
 */
export function classifyToken(token: string): IdentifierKind | null {
  if (PATH_CLAIM_RE.test(token)) return "path";
  if (ROUTE_CLAIM_RE.test(token)) return "route";
  if (REDIS_CLAIM_RE.test(token)) return "redis-key";
  if (SKILL_CLAIM_RE.test(token)) return "skill";
  if (ENV_CLAIM_RE.test(token) && token.includes("_")) return "env-var";
  return null;
}

/** Placeholder markers that make a token a shape, not a concrete claim. */
const PLACEHOLDER_RE = /[<>{}*…]|NNNN/;

/**
 * Normalise a Redis key claim OR inventory pattern: `{x}` / `<x>` param
 * holders become `*`, and a TRAILING `:*` family wildcard is stripped. Claim
 * and inventory are normalised the same way, so a doc writing
 * `hydra:design-concept:{anchorRef}` matches the inventory's
 * `hydra:design-concept:{anchor}`.
 */
export function normaliseRedisKey(key: string): string {
  let k = key.replace(/\{[^{}]*\}/g, "*").replace(/<[^<>]*>/g, "*");
  if (k.endsWith(":*")) k = k.slice(0, -2);
  return k;
}

/**
 * INV-4's placeholder skip: tokens containing `<`, `>`, `{`, `}`, `*`, `…` or
 * `NNNN` are skipped by every kind — the redis-key kind applies the skip
 * AFTER its own normalisation, because typed-param holders are exactly what
 * that normalisation resolves (a claim still carrying `…` / `NNNN` after
 * normalisation is a shapeless placeholder and stays skipped).
 */
export function placeholderSkipped(kind: IdentifierKind, token: string): boolean {
  if (kind === "redis-key") {
    return /…|NNNN/.test(normaliseRedisKey(token));
  }
  return PLACEHOLDER_RE.test(token);
}

/**
 * A path claim resolves iff it is a git-tracked file or a directory prefix of
 * one — TRACKED, not on-disk, so gitignored build output (dashboard/dist)
 * fails identically on CI and on the host. A trailing `:N` / `:N-M` line
 * suffix and a trailing `/` are stripped first.
 */
export function pathClaimResolves(token: string, tracked: Set<string>): boolean {
  let p = token.replace(/:\d+(?:-\d+)?$/, "");
  while (p.endsWith("/")) p = p.slice(0, -1);
  if (p === "") return true;
  if (tracked.has(p)) return true;
  const dirPrefix = `${p}/`;
  for (const t of tracked) {
    if (t.startsWith(dirPrefix)) return true;
  }
  return false;
}

/**
 * A route claim resolves iff some routes.json row has the same segment count
 * and every segment equal or a `:param`. The optional `METHOD ` prefix and a
 * query string are stripped; the method is not part of the comparison.
 */
export function routeClaimResolves(claim: string, routePaths: string[]): boolean {
  const path = claim.replace(/^[A-Z]+\s+/, "").split("?")[0];
  const segs = path.split("/").filter((s) => s !== "");
  return routePaths.some((row) => {
    const rowSegs = row.split("/").filter((s) => s !== "");
    return rowSegs.length === segs.length && rowSegs.every((rs, i) => rs === segs[i] || rs.startsWith(":"));
  });
}

/**
 * A Redis-key claim resolves iff it equals a normalised redis-keys.json
 * pattern or streams.json key, or is a `:`-boundary prefix of one.
 */
export function redisKeyClaimResolves(claim: string, patterns: string[]): boolean {
  const c = normaliseRedisKey(claim);
  return patterns.some((p) => {
    const n = normaliseRedisKey(p);
    return n === c || n.startsWith(`${c}:`);
  });
}

/** A skill claim resolves iff the name (leading `/` stripped) is a skills.json row. */
export function skillClaimResolves(claim: string, skills: Set<string>): boolean {
  return skills.has(claim.replace(/^\//, ""));
}

/**
 * An env-var claim resolves iff the name is an env-vars.json row OR appears
 * as a whole word in tracked source under the scanned dirs — a TS constant
 * like `VERIFIER_CORE_PATHS` exists, an invented name does not. `$NAME` /
 * `${NAME}` shell variables are not claims at all (they fail the UPPER_SNAKE
 * grammar before this resolver runs).
 */
export function envVarClaimResolves(name: string, known: Set<string>, sourceBlob: string): boolean {
  if (known.has(name)) return true;
  return new RegExp(`\\b${name}\\b`).test(sourceBlob);
}

/** Dirs whose tracked source backs an env-var / constant claim. */
const SOURCE_BLOB_DIRS = ["src", "scripts", "bin", ".github", "config", "dashboard/src", "dashboard/vite-plugins", "test"];
/** Extensions read into the source blob. */
const SOURCE_BLOB_EXTS = new Set([".ts", ".mts", ".mjs", ".js", ".jsx", ".py", ".sh", ".json", ".yml"]);

/**
 * Files that must never back an env-var claim: the guard's own script, test and
 * fixtures quote every baselined token, so once tracked they would make each
 * baseline row resolve against itself (the 32 STALE env-var rows seen in CI).
 */
const SOURCE_BLOB_EXCLUDED = new Set([
  "scripts/docs/prose-drift.ts",
  "test/docs-prose-drift.test.mts",
  "test/fixtures/docs-drift-baseline.json",
  "test/fixtures/docs-retired-terms.json",
]);

/**
 * Concatenate the tracked source files (newline-joined) that back env-var
 * claims. Read failures are skipped loudly — a tracked file the scanner
 * cannot read is host damage, not a doc lie, and must not fail the drift arm.
 */
export function buildSourceBlob(repoRoot: string, tracked: Iterable<string>): string {
  const parts: string[] = [];
  for (const p of tracked) {
    const inBlobDir = SOURCE_BLOB_DIRS.some((d) => p === d || p.startsWith(`${d}/`));
    if (!inBlobDir || !SOURCE_BLOB_EXTS.has(extname(p)) || SOURCE_BLOB_EXCLUDED.has(p)) continue;
    try {
      parts.push(readFileSync(join(repoRoot, p), "utf8"));
    } catch (err) {
      console.error(`[prose-drift] could not read tracked file ${p} for the env-var blob — ${err}`);
    }
  }
  return parts.join("\n");
}

/**
 * All git-tracked paths INCLUDING dot-directories. inventories/scan.ts's
 * trackedFiles() drops dot-segments by design (an inventory-walk rule), but
 * path claims legitimately target `.github/**` (INV-4's own grammar lists it),
 * so the prose scanner needs the unfiltered listing. Same child-process
 * shape, same existsSync guard, one git ls-files per scan.
 */
export function lsTrackedAll(repoRoot: string): string[] {
  let raw: string;
  try {
    raw = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new ProseDriftInputError(`[prose-drift] git ls-files failed: ${(err as Error).message}`);
  }
  return raw
    .split("\0")
    .filter((p) => p !== "");
}

// ---------------------------------------------------------------------------
// Retired-term denylist + admit rule (INV-5 / INV-6)
// ---------------------------------------------------------------------------

/** Whole-word, case-insensitive matcher for a denylist term on blanked prose. */
export function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A term ending in `/` or `.` is directory/prefix-shaped: it must also match
  // inside `src/anchor-selection/foo.ts`, so it takes no trailing lookahead.
  const tail = /[/.]$/.test(term) ? "" : "(?![A-Za-z0-9_])";
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}${tail}`, "gi");
}

/**
 * A denylisted term is admitted iff the same paragraph contains its
 * `retiredBy` token (ADR-NNNN or #NNNN) or the string `docs/historical/`.
 * No HTML markers, no per-file allowlists, no inline pragmas.
 */
export function retiredTermAdmitted(paragraph: string, retiredBy: string): boolean {
  const escaped = retiredBy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Digit boundary: `#710` must not be admitted by `#7100`.
  return new RegExp(`${escaped}(?!\\d)`).test(paragraph) || paragraph.includes("docs/historical/");
}

/** The path-only additional admit: the paragraph says the thing is gone. */
const PATH_ADMIT_RE = /\b(?:retired|removed|deleted|gitignored)\b/i;

// ---------------------------------------------------------------------------
// Count claims (INV-7) and links (INV-8)
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** Multi-word nouns first — regex alternation is first-match. */
const COUNT_CLAIM_RE =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[ \t]+(dispatch classes|redis keys|ci jobs|routers|routes|ADRs|pages|classes|skills|playbooks|streams|chores)\b/gi;

/** Fixed noun → counts.json row map (lowercased noun → family/metric). */
const COUNT_NOUN_ROWS: Record<string, { family: string; metric: string }> = {
  routers: { family: "routes", metric: "routers" },
  routes: { family: "routes", metric: "routes" },
  adrs: { family: "adrs", metric: "rows" },
  pages: { family: "pages", metric: "rows" },
  "dispatch classes": { family: "classes", metric: "rows" },
  classes: { family: "classes", metric: "rows" },
  skills: { family: "skills", metric: "rows" },
  playbooks: { family: "corpus", metric: "playbook" },
  "redis keys": { family: "redis-keys", metric: "rows" },
  streams: { family: "streams", metric: "rows" },
  chores: { family: "chores", metric: "rows" },
  "ci jobs": { family: "ci-gates", metric: "rows" },
};

/** One matched count claim: the phrase, its parsed number, and the counts row it names. */
export interface CountClaimMatch {
  phrase: string;
  index: number;
  value: number;
  row: { family: string; metric: string };
}

/** Every count claim in blanked prose (unresolved-ness is the caller's compare). */
export function countClaimsIn(blanked: string): CountClaimMatch[] {
  const out: CountClaimMatch[] = [];
  for (const m of blanked.matchAll(COUNT_CLAIM_RE)) {
    const num = m[1];
    const value = /^\d+$/.test(num) ? Number(num) : NUMBER_WORDS[num.toLowerCase()];
    const row = COUNT_NOUN_ROWS[m[2].toLowerCase()];
    out.push({ phrase: m[0], index: m.index ?? 0, value, row });
  }
  return out;
}

const LINK_TARGET_RE = /\]\(([^)\n]+)\)/g;

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/**
 * The one exception class the scan treats as "an input could not be read"
 * (a missing/unparseable inventory or baseline, or a failed git listing).
 * scanProseDrift converts ONLY this into the unreadable-input sentinel row;
 * any other throw (a TypeError from a malformed inventory row, a scanner bug)
 * is a programming error and propagates. Messages carry repo-relative paths
 * only, so the sentinel token is host-independent.
 */
export class ProseDriftInputError extends Error {
  readonly code = "prose-drift-unreadable-input";
  constructor(message: string) {
    super(message);
    this.name = "ProseDriftInputError";
  }
}

function readJson(repoRoot: string, rel: string): unknown {
  try {
    return JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
  } catch (err) {
    throw new ProseDriftInputError(`[prose-drift] could not read ${rel}: ${(err as Error).message}`);
  }
}

const FIXES: Record<OffenderKind, string> = {
  path: "path not tracked; fix the path or say retired/removed/deleted in the same paragraph",
  route: "not in docs/generated/routes.json",
  "redis-key": "not in docs/generated/redis-keys.json or streams.json",
  skill: "not in docs/generated/skills.json",
  "env-var": "not in docs/generated/env-vars.json nor a whole word in tracked source",
  "retired-term": "cite the retiring ADR/PR in the same paragraph or drop the term",
  count: "counts.json disagrees",
  link: "relative link target not tracked",
  "unreadable-input": "a generated inventory, baseline, or git listing could not be read; regenerate (npm run docs:inventories) or fix the file",
};

/**
 * Scan the scoped docs and return every offender (occurrences; dedupe to
 * baseline rows happens in offenderRows). Everything load-bearing is
 * injectable so the rule tests pin facts about the functions, not about
 * today's corpus.
 */
export function scanProseDrift(repoRoot: string, opts: ProseScanOptions = {}): Offender[] {
  // Verification never throws on an unreadable INPUT: that becomes a
  // structured offender row so callers report it instead of crashing. Only
  // the typed read error is caught — a programming error (e.g. a TypeError
  // from a malformed inventory row) surfaces instead of masquerading as
  // "could not be read".
  try {
    return scanProseDriftUnguarded(repoRoot, opts);
  } catch (err) {
    if (!(err instanceof ProseDriftInputError)) throw err;
    // Strip the absolute repo root (an fs/git error message can embed it) so
    // the sentinel token never carries a host-specific path.
    const message = err.message.split(repoRoot).join("<repo>");
    console.error(`[prose-drift] scan aborted: ${message}`);
    return [{ file: "(inputs)", line: 1, kind: "unreadable-input", token: message, fix: FIXES["unreadable-input"] }];
  }
}

function scanProseDriftUnguarded(repoRoot: string, opts: ProseScanOptions): Offender[] {
  const tracked = new Set(opts.tracked ?? lsTrackedAll(repoRoot));
  const corpusRows =
    opts.corpusRows ??
    ((readJson(repoRoot, "docs/generated/corpus.json") as { rows: CorpusScopeRow[] }).rows);
  const retiredTerms = opts.retiredTerms ?? (readJson(repoRoot, RETIRED_TERMS_FILE) as RetiredTerm[]);
  const routePaths =
    opts.routePaths ?? (readJson(repoRoot, "docs/generated/routes.json") as { rows: { path: string }[] }).rows.map((r) => r.path);
  const redisKeyPatterns =
    opts.redisKeyPatterns ??
    [
      ...(readJson(repoRoot, "docs/generated/redis-keys.json") as { rows: { pattern: string }[] }).rows.map((r) => r.pattern),
      ...(readJson(repoRoot, "docs/generated/streams.json") as { rows: { key: string }[] }).rows.map((r) => r.key),
    ];
  const skillNames =
    opts.skillNames ?? (readJson(repoRoot, "docs/generated/skills.json") as { rows: { name: string }[] }).rows.map((r) => r.name);
  const envVarNames =
    opts.envVarNames ?? (readJson(repoRoot, "docs/generated/env-vars.json") as { rows: { name: string }[] }).rows.map((r) => r.name);
  const counts = opts.counts ?? (readJson(repoRoot, "docs/generated/counts.json") as { rows: CountRow[] }).rows;
  const sourceBlob = opts.sourceBlob ?? buildSourceBlob(repoRoot, tracked);

  const livingPaths = corpusRows.filter((r) => r.tier === "living").map((r) => r.path);
  const playbookPaths = corpusRows.filter((r) => r.tier === "playbook").map((r) => r.path);
  const fragmentFiles =
    opts.fragmentFiles ?? trackedFiles(repoRoot, "docs/operator-playbooks/_fragments", (n) => n.endsWith(".md"));
  const limitedPaths = [...new Set([...playbookPaths, ...fragmentFiles])];

  const skills = new Set(skillNames);
  const envKnown = new Set(envVarNames);
  const countValue = new Map(counts.map((r) => [`${r.family}/${r.metric}`, r.value]));

  const offenders: Offender[] = [];

  const scanDoc = (file: string, full: boolean): void => {
    let raw: string;
    try {
      raw = readFileSync(join(repoRoot, file), "utf8");
    } catch (err) {
      console.error(`[prose-drift] could not read scoped doc ${file}: ${(err as Error).message}`);
      offenders.push({ file, line: 1, kind: "link", token: "(unreadable scoped doc)", fix: "scoped doc missing — regenerate docs/generated/corpus.json" });
      return;
    }
    const blanked = blankProse(raw);
    const spans = paragraphSpans(blanked);

    // 1. Identifier existence — inline backtick spans only.
    for (const m of blanked.matchAll(/`([^`\n]+)`/g)) {
      const token = m[1];
      const kind = classifyToken(token);
      if (kind === null) continue;
      if (placeholderSkipped(kind, token)) continue;
      let resolves: boolean;
      switch (kind) {
        case "path":
          resolves = pathClaimResolves(token, tracked);
          break;
        case "route":
          resolves = routeClaimResolves(token, routePaths);
          break;
        case "redis-key":
          resolves = redisKeyClaimResolves(token, redisKeyPatterns);
          break;
        case "skill":
          resolves = skillClaimResolves(token, skills);
          break;
        case "env-var":
          resolves = envVarClaimResolves(token, envKnown, sourceBlob);
          break;
      }
      if (resolves) continue;
      if (kind === "path") {
        // A missing path — and only a path — is additionally admitted when the
        // same paragraph says the thing is gone.
        const para = paragraphAt(spans, m.index ?? 0);
        // Blank backtick spans first so a claim token whose own name contains
        // "retired"/"removed" (docs/retired-foo.md) cannot self-admit.
        if (para && PATH_ADMIT_RE.test(para.text.replace(/`[^`\n]*`/g, (b) => " ".repeat(b.length)))) continue;
      }
      offenders.push({ file, line: lineOf(blanked, m.index ?? 0), kind, token, fix: FIXES[kind] });
    }

    // 2. Retired-term denylist — whole-word on blanked prose, paragraph admit.
    for (const para of spans) {
      for (const term of retiredTerms) {
        for (const mm of para.text.matchAll(termRegex(term.term))) {
          if (retiredTermAdmitted(para.text, term.retiredBy)) continue;
          const line = para.startLine + (para.text.slice(0, mm.index ?? 0).match(/\n/g)?.length ?? 0);
          offenders.push({
            file,
            line,
            kind: "retired-term",
            token: term.term,
            fix: `cite ${term.retiredBy} in the same paragraph or drop the term`,
          });
        }
      }
    }

    if (!full) return;

    // 3. Count claims (living tier only).
    for (const c of countClaimsIn(blanked)) {
      const actual = countValue.get(`${c.row.family}/${c.row.metric}`);
      if (actual === undefined) {
        // Return, never throw: one missing counts row must not hide every
        // other offender in the scan.
        offenders.push({
          file,
          line: lineOf(blanked, c.index),
          kind: "count",
          token: `${c.phrase} (counts.json lacks ${c.row.family}/${c.row.metric})`,
          fix: "regenerate docs/generated/counts.json (npm run docs:inventories)",
        });
        continue;
      }
      if (actual === c.value) continue;
      offenders.push({
        file,
        line: lineOf(blanked, c.index),
        kind: "count",
        token: c.phrase,
        fix: `counts.json says ${actual}`,
      });
    }

    // 4. Links (living tier only) — relative targets must be tracked.
    for (const m of blanked.matchAll(LINK_TARGET_RE)) {
      let target = m[1].trim();
      if (/^(https?:|mailto:|#)/i.test(target)) continue;
      target = target.split("#")[0];
      if (target === "") continue;
      const resolved = resolveRelative(file, target);
      if (tracked.has(resolved)) continue;
      let underTrackedDir = false;
      for (const t of tracked) {
        if (t.startsWith(`${resolved}/`)) {
          underTrackedDir = true;
          break;
        }
      }
      if (underTrackedDir) continue;
      offenders.push({
        file,
        line: lineOf(blanked, m.index ?? 0),
        kind: "link",
        token: target,
        fix: FIXES.link,
      });
    }
  };

  for (const file of livingPaths) scanDoc(file, true);
  const living = new Set(livingPaths);
  for (const file of limitedPaths) {
    if (!living.has(file)) scanDoc(file, false);
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Baseline compare + report rendering (INV-9 / INV-10)
// ---------------------------------------------------------------------------

/** Baseline key of an offender — file:kind:token. Lines are reporting-only. */
export function offenderRow(o: Offender): string {
  return `${o.file}:${o.kind}:${o.token}`;
}

/**
 * The sorted, deduped baseline rows for a scan — one row per distinct
 * file:kind:token, carrying the FIRST occurrence's line for the report.
 */
export function offenderRowsAndIndex(offenders: Offender[]): { rows: string[]; byRow: Map<string, Offender> } {
  const byRow = new Map<string, Offender>();
  for (const o of offenders) {
    const row = offenderRow(o);
    const prev = byRow.get(row);
    if (prev === undefined || o.line < prev.line) byRow.set(row, o);
  }
  return { rows: [...byRow.keys()].sort(byString), byRow };
}

/** Two-direction compare: current − baseline are NEW offenders, baseline − current are STALE rows. */
export function compareBaseline(currentRows: string[], baselineRows: string[]): { added: string[]; removed: string[] } {
  const current = new Set(currentRows);
  const baseline = new Set(baselineRows);
  const added = currentRows.filter((r) => !baseline.has(r));
  const removed = baselineRows.filter((r) => !current.has(r));
  return {
    added: [...new Set(added)].sort(byString),
    removed: [...new Set(removed)].sort(byString),
  };
}

/**
 * The aggregate-offender report one arm asserts (and the CLI prints): every
 * row as `file:line — kind — token — fix` (stale rows have no live offender,
 * so the row itself is the line), ending with the regeneration command.
 */
export function renderReport(arm: "new" | "stale", rows: string[], byRow: Map<string, Offender>): string {
  const header =
    arm === "new"
      ? "docs prose drift: NEW offender(s) since the baseline — prose in a pinned doc makes a claim the tree does not back."
      : "docs prose drift: STALE baseline row(s) — the offender was fixed or moved but test/fixtures/docs-drift-baseline.json was not regenerated.";
  const lines = [header];
  for (const row of rows) {
    if (arm === "new") {
      const o = byRow.get(row);
      lines.push(
        o
          ? `${o.file}:${o.line} — ${o.kind} — ${o.token} — ${o.fix}`
          : `${row} — ${FIXES.count}`,
      );
    } else {
      lines.push(`${row} — stale baseline row — regenerate`);
    }
  }
  lines.push(FIX_COMMAND);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI — npm run docs:drift [-- --update-baseline]
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Read the committed baseline. Returns null (logged) when it is unreadable,
 * unparseable, or valid JSON that is not an array of strings — so a malformed
 * baseline fails the arm loudly instead of throwing inside compareBaseline.
 */
export function readBaseline(repoRoot: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = readJson(repoRoot, BASELINE_FILE);
  } catch (err) {
    console.error(`[prose-drift] ${(err as Error).message}`);
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((r) => typeof r === "string")) {
    console.error(`[prose-drift] ${BASELINE_FILE} is not a JSON array of strings — ${FIX_COMMAND}`);
    return null;
  }
  return parsed;
}

/**
 * The CLI body, parameterised on repo root + argv so tests can drive it.
 * Returns the exit code: 0 clean / baseline written, 1 drift or unreadable input.
 */
export function runProseDriftCli(repoRoot: string, argv: string[]): number {
  const update = argv.includes("--update-baseline");
  const offenders = scanProseDrift(repoRoot);
  // An aborted scan yields only the unreadable-input sentinel. It must never
  // reach the update branch (--allow-grow would overwrite the real baseline
  // with the sentinel row) nor be reported as ordinary drift: fail loud here.
  const unreadable = offenders.filter((o) => o.kind === "unreadable-input");
  if (unreadable.length > 0) {
    for (const o of unreadable) console.error(`[prose-drift] scan aborted, baseline untouched — ${o.token} — ${o.fix}`);
    return 1;
  }
  const { rows, byRow } = offenderRowsAndIndex(offenders);
  if (update) {
    // The baseline can only shrink unless the operator says otherwise: refuse
    // to absorb a NEW offender silently.
    if (!argv.includes("--allow-grow")) {
      const existing = readBaseline(repoRoot);
      if (existing === null) return 1;
      const { added: grown } = compareBaseline(rows, existing);
      if (grown.length > 0) {
        console.error(renderReport("new", grown, byRow));
        console.error("[prose-drift] refusing --update-baseline: it would ADD the row(s) above. Fix the prose, or pass --allow-grow deliberately.");
        return 1;
      }
    }
    writeFileSync(join(repoRoot, BASELINE_FILE), `${JSON.stringify(rows, null, 2)}\n`);
    console.log(`[prose-drift] baseline written: ${BASELINE_FILE} (${rows.length} rows)`);
    return 0;
  }
  const baseline = readBaseline(repoRoot);
  if (baseline === null) return 1;
  const { added, removed } = compareBaseline(rows, baseline);
  if (added.length > 0) {
    console.error(renderReport("new", added, byRow));
  }
  if (removed.length > 0) {
    console.error(renderReport("stale", removed, byRow));
  }
  if (added.length === 0 && removed.length === 0) {
    console.log(`[prose-drift] OK — ${rows.length} baseline rows all backed by live offenders, no new drift`);
    return 0;
  }
  return 1;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  process.exitCode = runProseDriftCli(REPO_ROOT, process.argv.slice(2));
}
