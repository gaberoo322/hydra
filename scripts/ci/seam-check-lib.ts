/**
 * seam-check-lib.ts — the shared baseline-ratchet engine behind the four CI
 * Seam checks (redis / github / host-probe / schema).
 *
 * Every Seam check used to inline the same machinery four times: a `git
 * ls-files` scan, a `loadBaseline` / `writeBaselineFile` pair over the
 * `{callers, note}` JSON shape, the new-violations / stale-baseline diff, the
 * `--write-baseline` path, and the `import.meta.url === process.argv[1]` CLI
 * guard. The ONLY thing that genuinely varied per check was the policy: which
 * files to scan (the glob), what counts as a violation (the predicate), where
 * the baseline lives, and the human-facing wording. This module concentrates
 * the duplicated engine into one Interface and leaves each Seam a thin Adapter
 * that declares just its policy.
 *
 * Behavior is byte-identical to the four hand-written scripts: exit 0/1/2, the
 * new-violations message, the stale-baseline message, the `--write-baseline`
 * summary, and the OK summary line all reproduce per-arm wording verbatim. The
 * shrink-only ratchet semantics are preserved — a baseline may shrink (fixed
 * callers) but a grown baseline still fails, and a new violation outside the
 * baseline fails closed.
 *
 * The engine is intentionally ignorant of per-Seam exemptions: each Adapter's
 * `predicate(relPath, body)` is the SINGLE owner of all exemption logic
 * (directory carve-outs and sanctioned-owner Sets). The engine only calls the
 * predicate; a file that returns false is identical to one that would have been
 * skipped in the old per-check loop.
 *
 * Issue #4580 widened the module's remit from "the Seam checks' engine" to
 * "the baseline-ratchet family's shared primitives": the generic
 * `loadJsonBaseline` / `writeJsonBaseline` below are also imported by the
 * second consumer family — the size / coupling / typecheck / subject-map
 * ratchets — as I/O-ONLY consumers. They hand-rolled the same read/write
 * ritual with diverging fallback conventions; the primitives stay
 * payload-shape-agnostic (the same "engine knows nothing per-check"
 * discipline above), with each script's fallback mode and note wording
 * expressed at its own call site. The ONE shared policy is the growth gate
 * (#5551): `writeJsonBaseline` refuses to write a payload that grows the
 * existing baseline unless `--allow-grow` is on process.argv.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InvalidArgumentError } from "../../src/errors.ts";

const execFileAsync = promisify(execFile);

/** Repo root, resolved relative to this file (scripts/ci/seam-check-lib.ts → ../../). */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

/**
 * Characters after which a `/` starts a REGEX literal rather than a division.
 * Deliberately excludes `)` and `]`, after which a `/` is division
 * (`(a + b) / 2`, `xs[i] / 2`). Misjudging in the conservative direction is
 * safe here: an unrecognised regex literal is scanned as ordinary code, and a
 * `/` inside a regex body must be escaped (`\/`), so no unescaped `//` or `/*`
 * can arise to be mistaken for a comment.
 */
const REGEX_START_PREDECESSORS = "(,=:[!&|?{};+-*%<>~^";

/**
 * Strip JavaScript/TypeScript comments from `source`, PRESERVING string and
 * template literals (issue #3703).
 *
 * Token-keyed Seam checks (journal's `journalctl`, and the same shape in the
 * anthropic / telegram ratchets) ask "does this file name binary X
 * AND hold a spawn capability?". Matching the token against RAW source conflates
 * two very different facts: *spawning* `journalctl` and merely *writing the word*
 * in a doc comment. The journal ratchet's own docstring already drew that line —
 * "Naming `journalctl` in prose/comments alone ... is not a violation" — but the
 * regex never stripped comments, so the stated contract and the implementation
 * disagreed.
 *
 * That gap is a trap for exactly the files most likely to name a sibling seam:
 * a new process Adapter whose header documents the other Adapters. It fired on
 * `src/claude-cli/exec.ts`, and the historical fix was worse than the bug — the
 * `src/github/` and `src/host-probe/` families carry directory carve-outs in
 * `journal-seam-check.ts` PURELY so their doc-prose would stop tripping the
 * gate. Stripping comments removes the need to keep minting such carve-outs.
 *
 * String literals are deliberately KEPT: a spawned binary name lives in one
 * (`spawn("journalctl", …)`), so stripping them would make the gate permissive.
 * The scanner tracks quote state precisely (including backslash escapes) so a
 * `//` inside a URL string never truncates the line — the classic naive-stripper
 * bug, which would silently hide a real violation.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  /** Last non-whitespace character emitted — decides regex-vs-division. */
  let prev = "";

  while (i < n) {
    const c = source[i]!;
    const next = i + 1 < n ? source[i + 1] : "";

    // Line comment — drop through end of line, keep the newline.
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }

    // Block comment — drop, leaving a space so neighbouring tokens don't glue.
    if (c === "/" && next === "*") {
      i += 2;
      let nl = "";
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") nl += "\n"; // keep line numbers stable for site reports
        i++;
      }
      i += 2;
      out += nl || " ";
      continue;
    }

    // String or template literal — copy verbatim, honouring escapes.
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "\\") {
          out += ch + (i + 1 < n ? source[i + 1] : "");
          i += 2;
          continue;
        }
        out += ch;
        i++;
        if (ch === c) break;
      }
      prev = c;
      continue;
    }

    // Regex literal — copy verbatim so an escaped slash never reads as a comment.
    if (c === "/" && (prev === "" || REGEX_START_PREDECESSORS.includes(prev))) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const ch = source[i]!;
        if (ch === "\\") {
          out += ch + (i + 1 < n ? source[i + 1] : "");
          i += 2;
          continue;
        }
        if (ch === "\n") break;
        out += ch;
        i++;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
      }
      prev = "/";
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out;
}

/**
 * The on-disk baseline shape, shared by all four Seam checks: a sorted list of
 * tolerated `src/...` caller paths plus a free-form regeneration note.
 */
export interface BaselineFile {
  /** Sorted list of `src/...` paths whose violation is tolerated. */
  callers: string[];
  /** Free-form note explaining when this baseline was last regenerated. */
  note: string;
}

/**
 * The per-Seam policy an Adapter supplies. Everything an Adapter needs to vary
 * lives here; the engine owns the rest.
 */
export interface SeamCheckConfig {
  /**
   * The check's log prefix and identity, e.g. `"redis-seam-check"`. Used
   * verbatim in every `[<name>] ...` log line and the `--write-baseline` note.
   */
  name: string;
  /**
   * The `git ls-files` glob arguments. Three checks scan `["src/*.ts",
   * "src/**\/*.ts"]`; schema scans `["src/api/*.ts"]` only. The engine does not
   * hard-code a glob.
   */
  globs: string[];
  /**
   * Pure violation predicate. The SINGLE owner of all per-Seam exemption — the
   * Adapter folds its directory carve-outs and sanctioned-owner Sets in here.
   * `relPath` is a repo-relative `src/...` path; `body` is the file contents.
   */
  predicate: (relPath: string, body: string) => boolean;
  /** Absolute path to this check's `scripts/ci/<name>-seam-baseline.json`. */
  baselinePath: string;
  /**
   * The note clause appended after the auto-generated timestamp in a written
   * baseline, e.g. `"ADR-0009 closure ratchet: shrink only."`.
   */
  noteSuffix: string;
  /**
   * The multi-line how-to-fix help printed under the NEW-violations list. One
   * string per output line (the engine adds the newline); reproduces the
   * per-check wording verbatim.
   */
  newViolationsHelp: string[];
  /**
   * The one-line headline printed before the NEW-violations list, e.g.
   * `"NEW Redis-seam violations (ADR-0009):"` (the engine prepends `[<name>] `).
   */
  newViolationsHeadline: string;
}

/**
 * Run `git ls-files` for the given globs and return the tracked repo-relative
 * paths. Faster than a manual walk and respects `.gitignore`.
 */
export async function listTrackedFiles(globs: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", ...globs], {
    cwd: REPO_ROOT,
  });
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read and JSON.parse the baseline file at `path`, applying the caller's
 * fallback policy (issue #4580). The generic primitive shared by the whole
 * baseline-ratchet family — the Seam checks' own `{callers, note}` baseline
 * AND the sibling ratchets that used to hand-roll this ritual
 * (skill-size-ratchet, target-coupling-check, test-typecheck-check,
 * test-subject-map).
 *
 * Two modes, one per convention the family actually uses:
 *
 *   - DEFAULT (no `opts` / `strict` falsy): ANY readFile/JSON.parse error
 *     returns `fallback` — the catch-all "missing/unparseable baseline is
 *     'not yet seeded'" convention the Seam, target-coupling and
 *     test-typecheck loaders use.
 *   - STRICT (`{ strict: true }`): ENOENT returns `fallback` (an unseeded
 *     baseline is a soft state even for a check that reports it as a
 *     violation); every OTHER error — a non-ENOENT fs error or a JSON.parse
 *     SyntaxError — is rethrown UNWRAPPED, so the caller can distinguish
 *     corruption from unseeded and wrap it in its own wording
 *     (skill-size-ratchet does).
 *
 * The primitive is payload-shape-agnostic: no validation, no sorting, no
 * note stamping — per-check policy stays at each call site.
 */
export async function loadJsonBaseline<T>(
  path: string,
  fallback: T,
  opts?: { strict?: boolean },
): Promise<T> {
  if (!opts?.strict) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      /* intentional: missing/unparseable baseline is 'not yet seeded' */
      return fallback;
    }
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
  return JSON.parse(raw) as T;
}

/** One way a candidate baseline payload exceeds the on-disk baseline. */
export interface GrowthRow {
  /** Slash-joined JSON path ("" is the root). */
  path: string;
  kind: "raised" | "added-key" | "added-element" | "shape-changed";
  from: string;
  to: string;
}

function jsonKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Pure growth comparison of `next` against `prev` (no I/O). Reports every
 * raised number, added object key, added array element (compared as a multiset
 * of canonical-JSON strings, so a duplicate counts) and JSON-type change. Shrinks, unchanged values and
 * string/boolean/null differences (e.g. a timestamped note) are not growth.
 * Exported so a PR-diff guard can run the same comparison against a committed
 * fixture.
 */
export function diffBaselineGrowth(prev: unknown, next: unknown): GrowthRow[] {
  const rows: GrowthRow[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    const ka = jsonKind(a);
    const kb = jsonKind(b);
    if (ka !== kb) {
      rows.push({ path, kind: "shape-changed", from: ka, to: kb });
      return;
    }
    if (kb === "number") {
      if ((b as number) > (a as number)) {
        rows.push({ path, kind: "raised", from: String(a), to: String(b) });
      }
    } else if (kb === "array") {
      // Multiset: baselines such as fail-loud hits count duplicates (diffKeys).
      const left = new Map<string, number>();
      for (const e of a as unknown[]) {
        const c = JSON.stringify(e);
        left.set(c, (left.get(c) ?? 0) + 1);
      }
      for (const e of b as unknown[]) {
        const c = JSON.stringify(e);
        const n = left.get(c) ?? 0;
        if (n > 0) {
          left.set(c, n - 1);
          continue;
        }
        rows.push({ path, kind: "added-element", from: "(absent)", to: c.length > 120 ? `${c.slice(0, 117)}...` : c });
      }
    } else if (kb === "object") {
      const oa = a as Record<string, unknown>;
      const ob = b as Record<string, unknown>;
      for (const k of Object.keys(ob)) {
        const sub = path ? `${path}/${k}` : k;
        if (!Object.hasOwn(oa, k)) rows.push({ path: sub, kind: "added-key", from: "(absent)", to: "(present)" });
        else walk(oa[k], ob[k], sub);
      }
    }
  };
  walk(prev, next, "");
  return rows;
}

/**
 * Growth-path advice shared by every ratchet (STD-BASELINE-EDIT-ROWS). Pure
 * string builder: fix the code first; reviewed growth ONLY sets exactly that
 * row to the printed value, and the PR body carries a `Baseline-raise:` line.
 */
export function formatGrowthAdvice(opts: {
  cmd: string;
  baselineRel: string;
  rowKey: string;
  fixVerb: string;
  current: number | string;
}): string {
  return (
    `Fix the code first: ${opts.fixVerb}. For reviewed growth ONLY, set exactly the ` +
    `\`${opts.rowKey}\` row in ${opts.baselineRel} to ${opts.current} (hand-edit, or ` +
    `\`${opts.cmd} --allow-grow\` when it moves no other row) AND add a PR-body line ` +
    `\`Baseline-raise: ${opts.baselineRel} ${opts.rowKey} — <reason>\` ` +
    `(STD-BASELINE-EDIT-ROWS in CODING_STANDARDS.md).`
  );
}

/**
 * Stale-path advice shared by every ratchet: hand-edit only the listed rows,
 * never regenerate the baseline. Names no writer command.
 */
export function formatStaleAdvice(opts: {
  baselineRel: string;
  rowAction: string;
}): string {
  return (
    `In ${opts.baselineRel}, ${opts.rowAction} by hand — only the listed rows. ` +
    `Do not regenerate the whole baseline file (STD-BASELINE-EDIT-ROWS in CODING_STANDARDS.md).`
  );
}

/** Thrown by writeJsonBaseline when the payload would grow the on-disk baseline. */
export class BaselineGrowthRefusedError extends Error {
  readonly code = "baseline-growth-refused" as const;
  readonly rows: GrowthRow[];
  constructor(path: string, rows: GrowthRow[]) {
    super(
      `refusing to grow baseline ${path}:\n` +
        rows.map((r) => `  ${r.path || "/"}: ${r.kind} ${r.from} -> ${r.to}`).join("\n") +
        "\nre-run with --allow-grow (deliberate, reviewed growth only)",
    );
    this.name = "BaselineGrowthRefusedError";
    this.rows = rows;
  }
}

/**
 * Shared CLI wrapper: write the baseline, turning a growth refusal into exit
 * code 1 (after `onRefusal`, if given) and rethrowing anything else.
 */
export async function writeBaselineOrRefuse(
  path: string,
  payload: unknown,
  opts?: { allowGrow?: boolean; onRefusal?: () => void },
): Promise<0 | 1> {
  try {
    await writeJsonBaseline(path, payload, { allowGrow: opts?.allowGrow });
  } catch (err) {
    if (err instanceof BaselineGrowthRefusedError) {
      opts?.onRefusal?.();
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  return 0;
}

/**
 * Write `payload` as the baseline JSON at `path`: pretty-printed two-space
 * JSON with a trailing newline — the byte-for-byte on-disk form every
 * baseline writer in the family already used (issue #4580). It does NOT
 * sort, dedupe, or stamp notes; payload construction (sorting keys,
 * Set-dedupe, the per-check `Auto-generated by ... on <ISO>. <suffix>`
 * note) stays in each caller.
 */
export async function writeJsonBaseline(
  path: string,
  payload: unknown,
  opts?: { allowGrow?: boolean },
): Promise<void> {
  const allowGrow = opts?.allowGrow ?? process.argv.includes("--allow-grow");
  if (!allowGrow) {
    // Only a missing file (ENOENT) is a seed: there is no prior to grow from.
    // An unparseable prior throws rather than bypassing the growth gate.
    const prior = await loadJsonBaseline<unknown>(path, undefined, { strict: true });
    if (prior !== undefined) {
      const rows = diffBaselineGrowth(prior, JSON.parse(JSON.stringify(payload)));
      if (rows.length > 0) throw new BaselineGrowthRefusedError(path, rows);
    }
  }
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

/**
 * Read the Seam-check baseline JSON at `path`, falling back to an empty
 * unseeded baseline if the file does not exist or is unreadable.
 */
export async function loadBaseline(path: string): Promise<BaselineFile> {
  return loadJsonBaseline(path, {
    callers: [],
    note: "baseline not yet seeded",
  });
}

/**
 * Write the baseline JSON at `path` with the sorted `callers` and an
 * auto-generated note (`<name> --write-baseline on <ISO>. <noteSuffix>`).
 */
export async function writeBaselineFile(
  path: string,
  callers: string[],
  name: string,
  noteSuffix: string,
): Promise<void> {
  const payload: BaselineFile = {
    callers,
    note: `Auto-generated by scripts/ci/${name}.ts --write-baseline on ${new Date().toISOString()}. ${noteSuffix}`,
  };
  await writeJsonBaseline(path, payload);
}

/** The shrink-only diff between current violations and the recorded baseline. */
export interface BaselineDiff {
  /** Current violations absent from the baseline — fail closed. */
  newViolations: string[];
  /** Baseline entries that no longer violate — baseline is stale, must shrink. */
  fixedCallers: string[];
}

/**
 * Compute the shrink-only diff: which current violations are new (not in the
 * baseline) and which baseline entries have been fixed (no longer violate).
 */
export function diffBaseline(
  violations: string[],
  baseline: BaselineFile,
): BaselineDiff {
  const baselineSet = new Set(baseline.callers);
  const violationSet = new Set(violations);
  return {
    newViolations: violations.filter((v) => !baselineSet.has(v)),
    fixedCallers: baseline.callers.filter((c) => !violationSet.has(c)),
  };
}

/**
 * Scan the configured globs, apply the Adapter's predicate, and return the
 * sorted list of violating repo-relative paths. Unreadable files are skipped.
 */
async function findViolations(config: SeamCheckConfig): Promise<string[]> {
  const tracked = await listTrackedFiles(config.globs);
  const violations: string[] = [];
  for (const relPath of tracked) {
    const abs = join(REPO_ROOT, relPath);
    let body: string;
    try {
      body = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (config.predicate(relPath, body)) {
      violations.push(relPath);
    }
  }
  return violations.sort();
}

/**
 * The engine entrypoint each Adapter calls. Returns the numeric exit code:
 *   0 — OK (or `--write-baseline` succeeded)
 *   1 — new violations, or a stale (un-shrunk) baseline
 *
 * Honors `--write-baseline` (regenerate then exit 0), the shrink-only ratchet,
 * and reproduces each arm's wording verbatim. Reads `--write-baseline` from
 * `process.argv` so an Adapter does not have to thread it through.
 */
export async function runSeamCheck(config: SeamCheckConfig): Promise<number> {
  const writeBaseline = process.argv.includes("--write-baseline");
  const violations = await findViolations(config);

  if (writeBaseline) {
    await writeBaselineFile(
      config.baselinePath,
      violations,
      config.name,
      config.noteSuffix,
    );
    console.log(
      `[${config.name}] Wrote baseline with ${violations.length} entries to ${relative(REPO_ROOT, config.baselinePath)}`,
    );
    return 0;
  }

  const baseline = await loadBaseline(config.baselinePath);
  const { newViolations, fixedCallers } = diffBaseline(violations, baseline);

  if (newViolations.length > 0) {
    console.error(`[${config.name}] ${config.newViolationsHeadline}`);
    for (const v of newViolations) console.error(`  - ${v}`);
    console.error("");
    for (const line of config.newViolationsHelp) console.error(line);
    return 1;
  }

  if (fixedCallers.length > 0) {
    console.error(`[${config.name}] Baseline is stale — these files no longer violate:`);
    for (const c of fixedCallers) console.error(`  - ${c}`);
    console.error("");
    console.error(
      formatStaleAdvice({
        baselineRel: relative(REPO_ROOT, config.baselinePath),
        rowAction: "delete the listed rows (the files no longer violate)",
      }),
    );
    return 1;
  }

  console.log(`[${config.name}] OK — ${violations.length} known violations, no new ones.`);
  return 0;
}

/**
 * Whether `import.meta.url` of an Adapter module is the script Node was invoked
 * with — i.e. the Adapter is running as a CLI, not being imported by a test.
 * Each Adapter gates its `runSeamCheck(...).then(exit)` on this so importing it
 * never triggers a git scan or `process.exit`.
 */
export function isCliEntrypoint(moduleUrl: string): boolean {
  return Boolean(
    process.argv[1] && fileURLToPath(moduleUrl) === resolve(process.argv[1]),
  );
}

/**
 * Run an Adapter's `runSeamCheck` as a CLI: exit with the returned code, or
 * exit 2 on an unexpected crash (preserving the per-check crash wording).
 */
export function runAsCli(config: SeamCheckConfig): void {
  runSeamCheck(config).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[${config.name}] crash:`, err);
      process.exit(2);
    },
  );
}

// ---------------------------------------------------------------------------
// Shrink-only row-ratchet engine (issue #5617)
//
// The playbook ratchets (duplicate / vocabulary / reference-check) share one
// shape: a `{note, files: Record<file, Row>}` baseline, a shrink-only compare,
// a sorted-row build, a row-scoped re-seed and a check-or-write CLI flow. The
// engine below owns that structure; each ratchet supplies its scanner, its row
// payload and its report wording (`formatReport` stays per-ratchet).
// ---------------------------------------------------------------------------

/** Escape a string for literal use inside a RegExp source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The shared baseline envelope: a free-form note plus one row per file. */
export interface RowBaseline<Row> {
  note: string;
  files: Record<string, Row>;
}

/** Build a baseline: file keys sorted, rows that `isEmpty` dropped. */
export function buildRowBaseline<Row>(
  rows: Record<string, Row>,
  note: string,
  isEmpty: (row: Row) => boolean,
): RowBaseline<Row> {
  const files: Record<string, Row> = {};
  for (const file of Object.keys(rows).sort()) {
    if (!isEmpty(rows[file]!)) files[file] = rows[file]!;
  }
  return { note, files };
}

/**
 * Row-scoped re-seed (STD-BASELINE-EDIT-ROWS): only the named files' rows are
 * replaced by `rows`; every other row and the note carry over verbatim.
 */
export function mergeRowsForFiles<Row>(
  existing: RowBaseline<Row>,
  rows: Record<string, Row>,
  files: readonly string[],
  isEmpty: (row: Row) => boolean,
  emptyRow: Row,
): RowBaseline<Row> {
  const out: Record<string, Row> = {};
  const names = new Set([...Object.keys(existing.files), ...files]);
  for (const file of [...names].sort()) {
    const row = files.includes(file) ? (rows[file] ?? emptyRow) : existing.files[file]!;
    if (!isEmpty(row)) out[file] = row;
  }
  return { note: existing.note, files: out };
}

/** One cell whose count differs from its baseline. */
export interface CountDelta<K extends string> {
  file: string;
  key: K;
  count: number;
  baseline: number;
}

/**
 * The single exceeded-vs-stale decider for every count-row ratchet. An absent
 * file or key is capped at 0. Files sorted, keys in `keys` order.
 */
export function compareCountRows<K extends string>(
  found: Record<string, Partial<Record<K, number>>>,
  baseline: Record<string, Partial<Record<K, number>>>,
  keys: readonly K[],
): { exceeded: CountDelta<K>[]; stale: CountDelta<K>[] } {
  const exceeded: CountDelta<K>[] = [];
  const stale: CountDelta<K>[] = [];
  const files = new Set([...Object.keys(found), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    for (const key of keys) {
      const count = found[file]?.[key] ?? 0;
      const allowed = baseline[file]?.[key] ?? 0;
      if (count === allowed) continue;
      (count > allowed ? exceeded : stale).push({ file, key, count, baseline: allowed });
    }
  }
  return { exceeded, stale };
}

/**
 * Cell-scoped re-seed of count rows. `scope.files` limits which files and
 * `scope.keys` which cells take the fresh `counts`; every other cell keeps its
 * existing value. Zero cells and empty rows are dropped; keys stay in declared order.
 */
export function mergeCountRows<K extends string>(
  existing: Record<string, Partial<Record<K, number>>>,
  counts: Record<string, Partial<Record<K, number>>>,
  keys: readonly K[],
  scope: { files?: readonly string[]; keys?: readonly K[] } = {},
): Record<string, Partial<Record<K, number>>> {
  const out: Record<string, Partial<Record<K, number>>> = {};
  const names = new Set([...Object.keys(existing), ...Object.keys(counts), ...(scope.files ?? [])]);
  for (const file of [...names].sort()) {
    const fileInScope = scope.files === undefined || scope.files.includes(file);
    const row: Partial<Record<K, number>> = {};
    for (const key of keys) {
      const fresh = fileInScope && (scope.keys === undefined || scope.keys.includes(key));
      const v = fresh ? counts[file]?.[key] : existing[file]?.[key];
      if (v) row[key] = v;
    }
    if (Object.keys(row).length > 0) out[file] = row;
  }
  return out;
}

/**
 * Resolve a writer's comma-separated `--<flag> a,b` filter from argv:
 * `undefined` when the flag is absent. A flag given without `--write-baseline`,
 * or with no value, throws (`missing` is the wording for the no-value case).
 * Returns the trimmed non-empty names, which may be empty.
 */
export function resolveListFlag(argv: readonly string[], flag: string, missing: string): string[] | undefined {
  const at = argv.indexOf(flag);
  if (at === -1) return undefined;
  if (!argv.includes("--write-baseline")) throw new InvalidArgumentError(`${flag} only applies together with --write-baseline`);
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new InvalidArgumentError(missing);
  return value.split(",").map((n) => n.trim()).filter(Boolean);
}

/** Per-ratchet policy for `runBaselineRatchet`. */
export interface BaselineRatchetConfig<Found, Base extends RowBaseline<unknown>, Cmp, Filter> {
  /** Log prefix, e.g. `"playbook-duplicate-ratchet"`. */
  name: string;
  /** Repo-relative baseline path. */
  baselineRel: string;
  scan: () => Found;
  load: () => Promise<Base>;
  build: (found: Found) => Base;
  /** Scoped re-seed, used only when `filter` resolves to a value. */
  merge?: (existing: Base, found: Found, filter: Filter) => Base;
  /** Resolve the scoped-write filter from argv (`undefined` = rewrite everything). */
  filter?: (argv: readonly string[]) => Filter | undefined;
  compare: (found: Found, baseline: Base) => Cmp;
  /** Empty string when clean. */
  report: (cmp: Cmp) => string;
  /** Prefix for the failure report on stderr (default: none). */
  failHeadline?: string;
  /** Suffix appended to the `wrote <baselineRel>` line. */
  writeSuffix?: (next: Base) => string;
}

/**
 * The shared check-or-write CLI flow. Returns the exit code: 0 on a clean
 * check or a successful write, 1 on a report or a refused (growing) write.
 */
export async function runBaselineRatchet<Found, Base extends RowBaseline<unknown>, Cmp, Filter>(
  config: BaselineRatchetConfig<Found, Base, Cmp, Filter>,
  argv: readonly string[] = process.argv,
): Promise<number> {
  const filter = config.filter?.(argv);
  const found = config.scan();
  if (argv.includes("--write-baseline")) {
    const next =
      filter === undefined || !config.merge ? config.build(found) : config.merge(await config.load(), found, filter);
    const code = await writeBaselineOrRefuse(join(REPO_ROOT, config.baselineRel), next);
    if (code !== 0) return code;
    console.log(`[${config.name}] wrote ${config.baselineRel}${config.writeSuffix?.(next) ?? ""}`);
    return 0;
  }
  const report = config.report(config.compare(found, await config.load()));
  if (report) {
    console.error(config.failHeadline ? `${config.failHeadline}\n${report}` : report);
    return 1;
  }
  console.log(`[${config.name}] OK`);
  return 0;
}
