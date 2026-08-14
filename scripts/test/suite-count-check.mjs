#!/usr/bin/env node
/**
 * scripts/test/suite-count-check.mjs — per-file top-level suite/test count
 * detector for the `--test-force-exit` silent-drop race (issue #4020).
 *
 * # The bug this detects
 *
 * `package.json`'s `test` script passes `--test-force-exit` (necessary: without
 * it the suite hangs forever on a long-lived ioredis handle — see
 * `project_autopilot_never_reaped_root_cause`). Node's own `test.js` (root
 * test's `run()` completion path, confirmed against the pinned v22.23.1 source)
 * calls `process.exit()` once "all KNOWN tests have finished executing" — but a
 * subtest whose promise hasn't settled yet at that instant is torn down
 * silently: never counted as pass, fail, OR skip. `# fail 0`, exit 0, and the
 * suite just... didn't fully run. Confirmed by direct measurement (issue body +
 * research comments): 4 back-to-back runs of one unchanged commit swung
 * 1325-1337 reported suites, concentrated in a small set of large and/or
 * subprocess-heavy files. This is an unfiled upstream Node limitation, not a
 * defect in project code — see the issue for the full bisection and the
 * `nodejs/node` source citation.
 *
 * The fix scoped here is DETECTION, not elimination: removing
 * `--test-force-exit` outright reopens the hang, and closing the race properly
 * means auditing 87 files / 116 raw `new Redis(...)` call sites for open
 * handles — disproportionate scope for this ticket (see the issue's research
 * comments). Detecting the drop turns a SILENT pass into a LOUD failure, which
 * is the load-bearing property CLAUDE.md's opening line assumes already holds:
 * "Hard verification (`npm test`, `tsc`, build) is deterministic — never an
 * agent claim."
 *
 * # Design — three modes in one dual-purpose module
 *
 * 1. **Reporter mode** (loaded via `--test-reporter=<this file>
 *    --test-reporter-destination=<path>`): the default export is a node:test
 *    custom-reporter async generator. It streams one NDJSON line PER TOP-LEVEL
 *    (`nesting === 0`) `test:pass` / `test:fail` event, AS IT ARRIVES — never
 *    buffered until the run completes. This is the crux of why the detector
 *    itself survives the very race it detects: a dropped subtest simply never
 *    fires an event, so it is silently absent from the capture, which is
 *    exactly the ground truth we want (empirically verified: repeated runs of
 *    a 70-synchronous-test repro file produced a capture file whose line count
 *    always matched the TAP footer's `# tests N` exactly, valid NDJSON every
 *    line, no truncation-corruption from the forced exit — see PR discussion).
 *    Plain TAP text was considered and rejected: Node's TAP reporter does NOT
 *    include a `file` field anywhere in its output (verified directly — grepped
 *    a full TAP capture for source paths, found none), so per-file attribution
 *    is impossible from TAP alone. The reporter-event API used here exposes
 *    `evt.data.file` directly.
 *
 * 2. **Comparator** (`compareCapture()`, called in-process by
 *    scripts/test/redis-db-launch.mjs AFTER the test child has fully exited —
 *    never from inside the process under measurement, which would be exposed
 *    to the identical forceExit race): reads the NDJSON capture plus the
 *    checked-in baseline manifest and reports every file whose observed
 *    top-level count fell under its expected count.
 *
 * 3. **Baseline generator** (`node scripts/test/suite-count-check.mjs
 *    --update-baseline`): a STATIC source scan of `test/*.test.mts`, counting
 *    top-level `describe(...)` / `test(...)` calls per file — i.e. calls whose
 *    node:test NESTING is 0. This is deliberately NOT derived from an empirical
 *    run: an empirical baseline risks baking in an unlucky drop from the very
 *    run used to generate it, silently lowering the floor for exactly the
 *    fragile files that matter most. Source structure is immune to the runtime
 *    race entirely. "Top-level" here means "not nested inside a describe/test
 *    callback" in the node:test sense, NOT "column 0" — a file may register
 *    describe() calls from inside a bare top-level `for` loop (one real
 *    instance in this repo: test/hydra-dev-reflection-deposit.test.mts, which
 *    generates one describe() per playbook) and those still count as top-level.
 *    The scanner tracks a describe/test-callback-nesting depth (via `=> {` /
 *    `function (...) {` immediately following a `describe(`/`test(` token,
 *    NOT raw brace depth) so a bare `for`/`if`/`.forEach(` block at depth 0
 *    does not itself introduce nesting. Deliberately raising the baseline in
 *    the same PR as a real change to a file's test count is the intended escape
 *    hatch — same convention as test/fixtures/adr-area-baseline.json.
 *
 * # Why a heuristic scanner, not a full parser
 *
 * This is a detector, not a source of truth with formal guarantees — ADR-0014
 * simplicity. The scanner strips string/template-literal contents and comments
 * before brace-tracking (so a stray `{` inside a test name never miscounts),
 * and distinguishes a callback-opening brace from an options-object brace (the
 * `test(name, { skip: ... }, () => { ... })` 3-arg form, used by
 * test/build-spritesheet.test.mts) by requiring the brace be immediately
 * preceded by `=>` or a `function (...)` header — an options object's `{` is
 * preceded by neither. A file whose structure defeats this heuristic
 * undercounts rather than overcounts (baseline too low, not too high), so the
 * failure mode is "misses a real drop for that one file" rather than "false
 * alarm on an unrelated change" — bump the baseline by hand if that ever bites.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_DIR = resolve(REPO_ROOT, "test");
const BASELINE_PATH = resolve(REPO_ROOT, "test/fixtures/suite-count-baseline.json");

// ---------------------------------------------------------------------------
// Mode 1 — node:test custom reporter (used only when this module is loaded via
// --test-reporter=; the default export is the transform node:test expects).
// ---------------------------------------------------------------------------

export default async function* reporter(source) {
  for await (const evt of source) {
    if (
      (evt.type === "test:pass" || evt.type === "test:fail") &&
      evt.data?.nesting === 0
    ) {
      const file = evt.data.file
        ? relative(REPO_ROOT, evt.data.file).split("\\").join("/")
        : null;
      yield (
        JSON.stringify({
          file,
          name: evt.data.name,
          ok: evt.type === "test:pass",
        }) + "\n"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Mode 2 — comparator: capture (observed) vs. baseline (expected).
// ---------------------------------------------------------------------------

/**
 * Parse the NDJSON capture a reporter-mode run produced. Tolerant of a
 * truncated/corrupt final line (the one place a hard kill COULD still land
 * mid-write) — skips it rather than throwing, since a partial line carries no
 * usable data and the goal is never to let a formatting hiccup mask real
 * results.
 */
function parseCapture(capturePath) {
  if (!existsSync(capturePath)) {
    return { entries: [], readError: `capture file not found: ${capturePath}` };
  }
  const raw = readFileSync(capturePath, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* intentional: a truncated final NDJSON line carries no usable data —
         skip it rather than fail the whole comparator over a formatting
         artifact of the same forced exit this tool exists to survive. */
    }
  }
  return { entries, readError: null };
}

export function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return {};
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/**
 * Compare an NDJSON capture against the checked-in baseline for the set of
 * files that were actually part of THIS run (`testFiles`, repo-relative
 * paths). A file is only checked when both (a) it has a baseline entry and
 * (b) it was named in this run's file list — restricting to (b) is what makes
 * this safe to call from `npm run test:file -- test/one-file.test.mts` without
 * every OTHER baselined file reporting a false 100% drop.
 *
 * A file present in `testFiles` with ZERO capture lines is the worst case (every
 * top-level entry dropped) and must still be caught — that's why membership is
 * driven by `testFiles`, not by "files that appear in the capture": a fully
 * dropped file produces no capture lines at all and would otherwise vanish.
 */
export function compareCapture({ capturePath, baseline, testFiles, repoRoot = REPO_ROOT }) {
  const { entries, readError } = parseCapture(capturePath);
  const observedByFile = new Map();
  for (const entry of entries) {
    if (!entry.file) continue;
    observedByFile.set(entry.file, (observedByFile.get(entry.file) ?? 0) + 1);
  }

  const relevantFiles = testFiles
    .map((f) => relative(repoRoot, resolve(repoRoot, f)).split("\\").join("/"))
    .filter((f) => Object.prototype.hasOwnProperty.call(baseline, f));

  const shortfalls = [];
  for (const file of relevantFiles) {
    const expected = baseline[file];
    const observed = observedByFile.get(file) ?? 0;
    if (observed < expected) {
      shortfalls.push({ file, expected, observed });
    }
  }

  return {
    ok: shortfalls.length === 0,
    shortfalls,
    readError,
    checkedFileCount: relevantFiles.length,
  };
}

/** Extract `test/*.test.mts`-style args from an argv-like array. */
export function testFilesFromArgs(args) {
  return args.filter((a) => /\.test\.mts$/.test(a));
}

// ---------------------------------------------------------------------------
// Mode 3 — static baseline generator.
// ---------------------------------------------------------------------------

/**
 * Strip line comments, block comments, and string/template literal CONTENTS
 * (replacing non-newline characters with a space so offsets/line numbers are
 * preserved) so brace-counting below never trips on a stray `{`/`}` inside a
 * test name or a comment. Template-literal `${...}` interpolation is treated
 * as ordinary literal content (a known, accepted simplification — no test name
 * in this repo interpolates braces).
 */
/**
 * Characters after which a `/` is (almost) certainly DIVISION, not a regex
 * literal's opening slash — the standard disambiguation every JS-ish lexer
 * needs (Acorn calls this `exprAllowed`). Getting this wrong in the OTHER
 * direction (treating a regex as division) is the dangerous case: the
 * regex's raw content — which routinely contains `"`/`'` characters when a
 * test matches shell/JSON source text, e.g. `/"\$FOO"/ ` — then gets scanned
 * as ordinary code, and an embedded quote char is misread as a real string
 * delimiter, corrupting brace-depth tracking for everything downstream
 * (issue #4020 PR discussion — measured directly: this exact bug inflated
 * the baseline for test/branch-prune-script.test.mts from a true 1 to a
 * miscounted 3). Known accepted gap: a `/` immediately after a keyword like
 * `return`/`typeof`/`case` still misclassifies as division, since this is a
 * lightweight heuristic, not a full tokenizer — no top-level describe/test
 * scan target in this repo currently hits that pattern.
 */
const DIVISION_CANNOT_FOLLOW_WORDCHAR = /[A-Za-z0-9_$]/;
const REGEX_CANNOT_FOLLOW = new Set([")", "]", "}"]);

function stripLiteralsAndComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // Last non-whitespace character already scanned, used ONLY to disambiguate
  // a `/` as a regex-literal start vs. a division operator.
  let lastSignificant = "";
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += " ";
      i++;
      lastSignificant = quote;
      continue;
    }
    if (
      c === "/" &&
      !DIVISION_CANNOT_FOLLOW_WORDCHAR.test(lastSignificant) &&
      !REGEX_CANNOT_FOLLOW.has(lastSignificant)
    ) {
      // Regex literal: scan to the closing unescaped `/`, treating a
      // character class (`[...]`) as opaque (a `/` inside `[...]` does not
      // close the regex), then consume trailing flag letters.
      out += " ";
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (src[i] === "[") {
          inClass = true;
          out += " ";
          i++;
          continue;
        }
        if (src[i] === "]") {
          inClass = false;
          out += " ";
          i++;
          continue;
        }
        if (src[i] === "/" && !inClass) {
          out += " ";
          i++;
          break;
        }
        if (src[i] === "\n") {
          // Unterminated regex on this line — bail without consuming the
          // newline, matching the string-literal handler's leniency.
          break;
        }
        out += " ";
        i++;
      }
      while (i < n && /[a-zA-Z]/.test(src[i])) {
        out += " ";
        i++;
      }
      lastSignificant = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return out;
}

/**
 * Count TOP-LEVEL describe()/test() calls in one file's source — "top-level"
 * meaning zero describe/test-callback nesting, not zero brace depth (see
 * module header). Returns the count.
 */
export function countTopLevelEntries(source) {
  const sanitized = stripLiteralsAndComments(source);

  // Negative lookbehind `(?<!\.)` excludes a PRECEDING dot — without it,
  // `someRegex.test(str)` (JS's built-in RegExp.prototype.test, used
  // throughout this suite to assert against captured shell/log text) matches
  // as a false "top-level test() call" (issue #4020 PR discussion — measured
  // directly: this inflated test/autopilot-hooks.test.mts's count from a
  // true 6 to a miscounted 9, three `someVar.test(...)` call sites). The
  // TRAILING `.skip`/`.only`/`.todo` group is unaffected — that's a suffix on
  // "describe"/"test" itself, not a preceding property-access dot.
  const callRe = /(?<!\.)\b(?:describe|test)(?:\s*\.\s*(?:skip|only|todo))?\s*\(/g;
  const callStarts = [];
  let m;
  while ((m = callRe.exec(sanitized)) !== null) {
    callStarts.push(m.index);
  }

  // For each call, locate its callback-opening brace: the first `{` that is
  // immediately preceded (ignoring whitespace) by `=>` or by a `function`
  // header's closing `)`. This skips over any options-object argument (the
  // `test(name, { skip: ... }, fn)` 3-arg form) whose `{` is preceded by
  // neither.
  const calloutOpenBraceRe = /(=>\s*\{|function\s*\*?\s*\([^()]*\)\s*\{)/g;
  const describeOpenBraceIndices = new Set();
  for (const start of callStarts) {
    calloutOpenBraceRe.lastIndex = start;
    const found = calloutOpenBraceRe.exec(sanitized);
    if (found) {
      const braceIdx = found.index + found[0].length - 1; // position of the '{'
      describeOpenBraceIndices.add(braceIdx);
    }
  }

  // Merge call-start events and brace events into one left-to-right pass.
  const events = [];
  for (const start of callStarts) events.push({ pos: start, kind: "call" });
  for (let i = 0; i < sanitized.length; i++) {
    if (sanitized[i] === "{") events.push({ pos: i, kind: "open", idx: i });
    else if (sanitized[i] === "}") events.push({ pos: i, kind: "close" });
  }
  events.sort((a, b) => a.pos - b.pos || (a.kind === "call" ? -1 : 1));

  let rawDepth = 0;
  const describeStack = [];
  let topLevelCount = 0;
  for (const evt of events) {
    if (evt.kind === "call") {
      if (describeStack.length === 0) topLevelCount++;
    } else if (evt.kind === "open") {
      rawDepth++;
      if (describeOpenBraceIndices.has(evt.idx)) {
        describeStack.push(rawDepth);
      }
    } else {
      if (describeStack.length > 0 && describeStack[describeStack.length - 1] === rawDepth) {
        describeStack.pop();
      }
      rawDepth--;
    }
  }
  return topLevelCount;
}

/**
 * Hand-verified corrections for files whose true top-level entry count is
 * DATA-dependent, not syntactic — a static text scan counts `describe(`/
 * `test(` CALL SITES, but a call site inside a runtime loop can fire more than
 * once. `countTopLevelEntries` therefore undercounts these (safe direction:
 * under, never over — a low baseline only weakens detection for that one file,
 * it never spuriously fails an unrelated PR). Verified once against the live
 * node:test reporter event stream (ground truth, immune to interpretation):
 *
 *   - test/hydra-dev-reflection-deposit.test.mts: one `describe(...)` call
 *     site sits inside `for (const [name] of Object.entries(playbooks))`
 *     (2 playbooks at time of writing → fires twice), plus 2 other static
 *     top-level entries elsewhere in the file = 4 true, vs. 3 counted from the
 *     3 distinct call sites in source text.
 *
 * Update this table (not the baseline JSON directly) if the file changes so
 * `--update-baseline` regenerations don't silently regress the correction.
 */
const STATIC_COUNT_OVERRIDES = {
  "test/hydra-dev-reflection-deposit.test.mts": 4,
};

function generateBaseline() {
  const files = readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.mts"))
    .sort();
  const baseline = {};
  for (const f of files) {
    const rel = `test/${f}`;
    const source = readFileSync(join(TEST_DIR, f), "utf8");
    baseline[rel] = STATIC_COUNT_OVERRIDES[rel] ?? countTopLevelEntries(source);
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// CLI entrypoint — guarded so the exports above stay importable without
// running the CLI (same pattern as scripts/test/redis-db-launch.mjs).
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === "--update-baseline") {
    const baseline = generateBaseline();
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.error(
      `[suite-count-check] wrote ${Object.keys(baseline).length} file entries to ${relative(REPO_ROOT, BASELINE_PATH)}`,
    );
    process.exit(0);
  }

  // Standalone comparator invocation: node suite-count-check.mjs <capture> <file...>
  const [capturePath, ...testFiles] = args;
  if (!capturePath) {
    console.error(
      "[suite-count-check] usage: node scripts/test/suite-count-check.mjs --update-baseline\n" +
        "                     | node scripts/test/suite-count-check.mjs <capture.ndjson> <test-file...>",
    );
    process.exit(1);
  }
  const baseline = loadBaseline();
  const result = compareCapture({ capturePath, baseline, testFiles });
  if (result.readError) {
    console.error(`[suite-count-check] WARN: ${result.readError}`);
  }
  if (!result.ok) {
    console.error(
      `[suite-count-check] FAIL — ${result.shortfalls.length} file(s) under their expected top-level suite/test count:`,
    );
    for (const s of result.shortfalls) {
      console.error(`  ${s.file}: expected ${s.expected}, observed ${s.observed}`);
    }
    process.exit(1);
  }
  console.error(
    `[suite-count-check] OK — ${result.checkedFileCount} file(s) at or above their expected top-level count`,
  );
  process.exit(0);
}
