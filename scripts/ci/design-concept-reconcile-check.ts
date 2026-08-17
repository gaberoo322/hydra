/**
 * scripts/ci/design-concept-reconcile-check.ts — pure decision core for the
 * design-concept reconciliation gate (issue #2528).
 *
 * # The gap this closes
 *
 * `hydra-grill` produces a **design concept** whose `invariants[]` are the
 * binding contract for the implementation. The dev child flow has instructed
 * agents to reconcile their diff against every invariant before opening a PR
 * since #2537 — but that gate was *prose*, so an agent could simply skip it.
 * The `acceptance-criterion-unmet` cue climbed 83 → 150 hits with genuine
 * MUST-NOT violations reaching PR (e.g. #3606 shipped a call the artifact
 * explicitly said the route MUST NOT gain). QA caught them by hand, after the
 * PR was already open. This module makes the gate mechanical.
 *
 * # Why this is a test module, not a workflow
 *
 * Live `required_status_checks` on master is exactly
 * [test, dashboard-build, tier-gate, mutation-test, scope-check, secret-scan,
 * deep-qa-gate]. A NEW `.github/workflows/*.yml` sibling is *advisory* — it can
 * go red while auto-merge proceeds (empirically: PR #3033 auto-merged with
 * `protected-paths` RED, see `test/protected-paths-guard.test.mts`). Shipping
 * this as an advisory workflow would reproduce #2537's exact defect one layer
 * down: unenforceable enforcement. The consumer is therefore
 * `test/design-concept-reconcile-check.test.mts`, which `npm test` runs inside
 * the REQUIRED `test` job — reaching a blocking check with **zero** `ci.yml`
 * edits (`feedback_drift_guard_as_test_not_workflow`).
 *
 * # Purity contract
 *
 * This file has **no imports**. No `node:fs`, no `fetch`, no `process.env`, no
 * module-scope side effects. Every decision is a pure function over injected
 * inputs: the PR body string, the artifact's `invariants` + `artifactHash`, and
 * an injected {@link FileReader}. All environment sourcing (GITHUB_EVENT_PATH,
 * the artifact HTTP fetch, filesystem reads) lives in the thin test-file
 * adapter. This mirrors the `scope-check.ts` / `mechanical-check.ts` /
 * `qa-verdict.ts` pure-helper family and is what makes the grammar and the
 * verdict reducer unit-testable without a live PR.
 *
 * # The PR-body contract
 *
 * A PR whose linked issue has a design-concept artifact MUST carry a top-level
 * section (documented in `docs/operator-playbooks/_fragments/hydra-dev-child-flow.md`):
 *
 * ```markdown
 * ## Design-concept reconciliation
 *
 * Artifact: `8c0dfe60287a`
 *
 * - INV-1: "<verbatim prefix of invariants[0]>" — verified by: `file-contains: src/x.ts :: doThing(`
 * - INV-2: "<verbatim prefix of invariants[1]>" — verified by: `file-lacks: src/api.ts :: pruneIndex(`
 * ```
 *
 * It MUST be its own `##` heading and MUST NOT be nested inside
 * `## Files in scope` — `scope-check.ts` extracts that section up to the next
 * markdown heading and would otherwise absorb these backticked paths as scope
 * entries (`feedback_scope_check_codespan_trap`).
 *
 * # Assertion grammar (Node-stdlib-only, evaluated at HEAD)
 *
 * Assertions are tree-state predicates over the checked-out worktree. They
 * deliberately do NOT use `git diff` / `git merge-base`: the required `test`
 * job checks out at the default `fetch-depth: 1`, so no merge-base exists, and
 * tree-state answers the question that actually matters ("does the forbidden
 * call exist in the shipped tree?") rather than a rebase-fragile delta.
 *
 * - `file-exists: <path>`
 * - `file-absent: <path>`
 * - `file-contains: <path> :: <literal>`
 * - `file-lacks: <path> :: <literal>`        (a MISSING file FAILS — see note)
 * - `file-matches: <path> :: /<regex>/<flags>`
 * - `file-not-matches: <path> :: /<regex>/<flags>`
 * - `occurrences: <path> :: <literal> == <n>`   (also `<=`, `>=`)
 * - `manual: <prose>`                        (REJECTED on MUST-NOT invariants)
 *
 * `file-lacks` / `file-not-matches` fail when the file is unreadable rather
 * than passing vacuously: "src/api.ts does not contain pruneX()" is not
 * satisfied by pointing at a path that does not exist.
 *
 * # What this gate deliberately does NOT judge
 *
 * It never adjudicates *which* of several issue-offered options the dev chose
 * (`feedback_qa_false_fail_spec_offered_option`). It fires only on section
 * shape (missing/misquoted/miscounted entries, stale artifact hash) and on
 * declared assertions that evaluate FALSE. Design preference is out of reach.
 */

/** Canonical PR-body heading the gate looks for. */
export const RECONCILIATION_HEADING = "## Design-concept reconciliation";

/**
 * Minimum verbatim characters an entry must quote from its invariant. Long
 * enough that `"T"` cannot satisfy the prefix rule, short enough that a genuine
 * one-clause quote of a short invariant still passes.
 */
export const MIN_QUOTE_CHARS = 16;

/** Minimum length of a cited artifact-hash prefix. */
export const MIN_HASH_PREFIX = 8;

/** Hard cap on a user-supplied regex source, as cheap ReDoS insurance. */
export const MAX_REGEX_SOURCE = 200;

/** Reads a repo-relative path, returning `null` when it is not a readable file. */
export type FileReader = (repoRelativePath: string) => string | null;

/** One parsed `- INV-<n>: "<quote>" — verified by: <assertion>` bullet. */
export type ReconcileEntry = {
  /** The 1-based index from the `INV-<n>` label. */
  index: number;
  /** Text the entry quotes from the invariant (empty when no quote was found). */
  quoted: string;
  /** Raw assertion text following `verified by:` (empty when absent). */
  assertion: string;
  /** The entry's full (continuation-joined) source text, for diagnostics. */
  raw: string;
};

/** Result of parsing the reconciliation section out of a PR body. */
export type ParsedSection = {
  present: boolean;
  /** Cited artifact hash (lower-cased, backticks stripped), or `null`. */
  artifactHash: string | null;
  entries: ReconcileEntry[];
};

/** A machine-checkable (or explicitly manual) assertion. */
export type Assertion =
  | { kind: "file-exists"; path: string }
  | { kind: "file-absent"; path: string }
  | { kind: "file-contains"; path: string; needle: string }
  | { kind: "file-lacks"; path: string; needle: string }
  | { kind: "file-matches"; path: string; source: string; flags: string }
  | { kind: "file-not-matches"; path: string; source: string; flags: string }
  | { kind: "occurrences"; path: string; needle: string; op: "==" | "<=" | ">="; count: number }
  | { kind: "manual"; note: string }
  | { kind: "unparseable"; raw: string; reason: string };

/** Outcome of evaluating one assertion against the worktree. */
export type AssertionResult = { ok: boolean; expected: string; observed: string };

/** Machine-readable violation codes, so callers/tests discriminate on `code`. */
export type ViolationCode =
  | "missing-section"
  | "missing-artifact-hash"
  | "artifact-hash-mismatch"
  | "entry-count-mismatch"
  | "duplicate-entry"
  | "unknown-entry"
  | "missing-entry"
  | "quote-mismatch"
  | "must-not-needs-machine-assertion"
  | "unparseable-assertion"
  | "assertion-failed";

/** One blocking finding. `invariant` is quoted VERBATIM per acceptance criterion 2. */
export type Violation = {
  code: ViolationCode;
  /** 1-based invariant index, or `null` for section-level findings. */
  invariantIndex: number | null;
  /** The offending invariant, verbatim. `null` for section-level findings. */
  invariant: string | null;
  message: string;
};

/** Everything {@link checkReconciliation} needs. All injected — nothing ambient. */
export type ReconcileInput = {
  prBody: string;
  invariants: string[];
  artifactHash: string;
  readFile: FileReader;
};

// ---------------------------------------------------------------------------
// PR-body / anchor parsing
// ---------------------------------------------------------------------------

/**
 * Extract the first `Closes|Fixes|Resolves #N` issue number from a PR body.
 * Mirrors the parser `design-concept-comment.yml` and `scope-check`'s ci.yml
 * wiring already use, so all three resolve the same anchor.
 */
export function extractAnchorRefFromPrBody(body: string): number | null {
  const m = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(body ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** True iff `line` opens a markdown ATX heading (`#` … `######`). */
function isHeadingLine(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/.test(line);
}

/**
 * Slice the reconciliation section out of a PR body: the lines after a
 * `## Design-concept reconciliation` heading, up to the next heading or EOF.
 * Accepts `##`/`###`, an optional trailing colon, and either spelling of
 * "design concept" / "design-concept". Returns `null` when absent.
 */
export function extractReconciliationSection(body: string): string | null {
  const lines = (body ?? "").split(/\r?\n/);
  const headingRe = /^\s{0,3}#{2,4}\s*design[-\s]?concept\s+reconciliation\b.*$/i;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (isHeadingLine(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** Strip any number of wrapping backticks and surrounding whitespace. */
function stripBackticks(s: string): string {
  return (s ?? "").trim().replace(/^`+/, "").replace(/`+$/, "").trim();
}

/**
 * `(\*\*|__|\*|_)?` (group 1) optionally consumes a Markdown emphasis opener —
 * `**`/`__`/`*`/`_` — directly before the `INV-<n>` label, and the later `\1`
 * consumes the SAME marker as a mandatory closer directly after the digits
 * (e.g. `**INV-1**`, `*INV-2*`, `__INV-3__`). Per ECMA-262, a backreference to
 * a group that did not participate matches the empty string, so the unbolded
 * form (`- INV-1: …`) is untouched: group 1 stays unset and `\1` contributes
 * nothing — but when group 1 DID participate, `\1` (no longer optional via a
 * trailing `?`) requires the literal closer to be present, so an asymmetric
 * `**INV-1_` (opened with `**`, "closed" with `_`) correctly fails to match
 * rather than silently accepting the mismatched marker as unrelated trailing
 * text (issue #4037 follow-up).
 *
 * The digit run is closed with `(?![0-9A-Za-z])` rather than `\b` or the
 * narrower `(?!\d)`: `\b` would refuse to fire between the digits and an
 * underscore-emphasis closer (`INV-3__`), silently dropping the `__…__` form,
 * while `(?!\d)` only blocks a following digit and lets a following LETTER
 * through — so `INV-10x` and `INV-1abc` wrongly matched as `INV-10`/`INV-1`
 * with the letters absorbed into the trailing text. `(?![0-9A-Za-z])` blocks
 * any following alphanumeric while still allowing `_`/`*` through as the
 * (backreference-enforced) emphasis closer.
 *
 * The bullet-marker anchor (`^\s*(?:[-*+]|\d+[.)])…`) still requires INV
 * (optionally emphasised) to follow immediately, so a mid-sentence mention of
 * "INV-1" elsewhere in a bullet's prose still does not match (issue #4037).
 */
const ENTRY_RE =
  /^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?(\*\*|__|\*|_)?INV[\s-]?(\d+)(?![0-9A-Za-z])\1\s*[:.–—-]?\s*(.*)$/;

/**
 * Labelled same-line hash finder — `Artifact: `8c0dfe60…``, `artifact hash =
 * 8c0dfe60…` (case-insensitive, backticks optional). This is the ORIGINAL
 * (#3740) matching strategy and stays PRIMARY; the label-adjacent fallback in
 * {@link parseReconciliationSection} only runs when it finds nothing.
 */
const LABELLED_HASH_RE = /artifact(?:\s*hash)?\s*[:=]\s*`?([0-9a-fA-F]{8,64})`?/i;

/**
 * A line that OPENS a hash citation (`Artifact:` / `artifact hash =`) whether
 * or not a hash follows on that same line.
 */
const HASH_LABEL_RE = /artifact(?:\s*hash)?\s*[:=]/i;

/** A hash token on its own line — backticks optional (issue #4101 wrap form). */
const BARE_HASH_RE = /`?([0-9a-fA-F]{8,64})`?/i;

/**
 * Parse the reconciliation section into a cited artifact hash plus one entry
 * per `- INV-<n>` bullet. A bullet may wrap: any following indented, non-empty,
 * non-heading, non-bullet line is joined onto it with a single space.
 */
export function parseReconciliationSection(body: string): ParsedSection {
  const section = extractReconciliationSection(body);
  if (section === null) return { present: false, artifactHash: null, entries: [] };

  const lines = section.split(/\r?\n/);
  let artifactHash: string | null = null;
  const entries: ReconcileEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (artifactHash === null) {
      const h = LABELLED_HASH_RE.exec(line);
      if (h) artifactHash = h[1].toLowerCase();
    }

    const m = ENTRY_RE.exec(line);
    if (!m) continue;

    // m[1] is the optional emphasis marker (unused past the match itself);
    // m[2] is the INV-<n> digit capture; m[3] is the trailing bullet text.
    let text = m[3];
    // Absorb wrapped continuation lines.
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === "") break;
      if (isHeadingLine(next)) break;
      if (ENTRY_RE.test(next)) break;
      if (!/^\s{2,}/.test(next)) break;
      text += " " + next.trim();
      i = j;
    }

    entries.push({
      index: parseInt(m[2], 10),
      quoted: extractQuotedText(text),
      assertion: extractAssertionText(text),
      raw: text.trim(),
    });
  }

  // Label-adjacent next-line fallback (issue #4101): a fully-compliant section
  // can wrap — the `Artifact:` / `artifact hash:` label ends its line and the
  // hash lands on the NEXT line (PR #4100 reddened the required `test` job on
  // exactly this shape, quoting the very hash the body already contained).
  // Reaching here means the same-line finder located no hash ANYWHERE, so every
  // label line by construction carries none on its own line. Resolution is
  // deliberately BOUNDED to the line IMMEDIATELY following a label line — no
  // unbounded full-section hex scan (#4101 design-concept INV-2) — and
  // hashesMatch still validates whatever is found, so widening the finder
  // never weakens the check.
  if (artifactHash === null) {
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!HASH_LABEL_RE.test(lines[i])) continue;
      const h = BARE_HASH_RE.exec(lines[i + 1]);
      if (h) {
        artifactHash = h[1].toLowerCase();
        break;
      }
    }
  }

  return { present: true, artifactHash, entries };
}

/** Index of the `verified by:` marker in an entry, or -1. */
function verifiedByIndex(text: string): number {
  const m = /verified\s+by\s*:/i.exec(text);
  return m ? m.index : -1;
}

/**
 * Outermost straight-quoted span, or first smart-quoted span, in the text
 * before `verified by:`.
 *
 * The contract format is `- INV-<n>: "<quote>" — verified by: <assertion>`, so
 * the straight quote is always the OUTERMOST `"…"` span in `head` (the text
 * before `verified by:`). A greedy first-`"`-to-last-`"` capture grabs it whole
 * — the ONLY way to encode an invariant whose verbatim prefix itself contains
 * an embedded `"` (e.g. `mergeable == "UNKNOWN" …`) or one that STARTS with a
 * `"`. The previous `[^"]+` stopped at the first embedded quote, truncating
 * those invariants below the {@link MIN_QUOTE_CHARS} verbatim-prefix floor with
 * an unavoidable `quote-mismatch` (issue #3975, blocking #3963). For the
 * no-embedded-quote majority a single `"foo"` still yields `foo`: greedy
 * first-to-last reduces to first-and-only when there is one pair.
 *
 * The smart-quote (curly `“…”`) fallback is deliberately LEFT on its original
 * first-span matcher: its open/close characters differ, so an embedded STRAIGHT
 * `"` never truncates it, and the approved design-concept for #3975 (INV-5)
 * requires that path untouched by this fix.
 */
export function extractQuotedText(entryText: string): string {
  const vb = verifiedByIndex(entryText);
  const head = vb === -1 ? entryText : entryText.slice(0, vb);
  const straight = /"(.*)"/.exec(head);
  if (straight) return straight[1];
  const smart = /“([^”]+)”/.exec(head);
  if (smart) return smart[1];
  return "";
}

/** Everything after `verified by:`, backticks stripped. Empty when absent. */
export function extractAssertionText(entryText: string): string {
  const m = /verified\s+by\s*:\s*/i.exec(entryText);
  if (!m) return "";
  return stripBackticks(entryText.slice(m.index + m[0].length));
}

// ---------------------------------------------------------------------------
// Invariant text comparison
// ---------------------------------------------------------------------------

/**
 * Canonicalise invariant text for the verbatim-prefix comparison: drop a
 * leading `INV-<n>` label (artifacts write invariants both with and without
 * it) and collapse whitespace runs, so a markdown-wrapped quote still matches.
 * Case and punctuation are preserved — the quote must be verbatim.
 */
export function normaliseInvariantText(s: string): string {
  return (s ?? "")
    .replace(/^\s*INV[\s-]?\d+\s*[:.–—-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True iff `quoted` is a long-enough verbatim prefix of `invariant`. */
export function quoteMatchesInvariant(quoted: string, invariant: string): boolean {
  const q = normaliseInvariantText(quoted);
  const inv = normaliseInvariantText(invariant);
  if (q.length === 0) return false;
  const min = Math.min(MIN_QUOTE_CHARS, inv.length);
  if (q.length < min) return false;
  return inv.startsWith(q);
}

/** True iff the invariant states a prohibition (MUST NOT / MUST NEVER). */
export function isMustNotInvariant(text: string): boolean {
  return /\bmust[\s-]?not\b/i.test(text ?? "") || /\bmust\s+never\b/i.test(text ?? "");
}

/** True iff a cited hash prefix identifies the live artifact hash. */
export function hashesMatch(cited: string, actual: string): boolean {
  const c = stripBackticks(cited).toLowerCase();
  const a = stripBackticks(actual).toLowerCase();
  if (c.length < MIN_HASH_PREFIX) return false;
  return a.startsWith(c);
}

/**
 * Message-time companion diagnostic (issue #4101, item 3): when the finder
 * could not read a hash, does the section nonetheless contain a hex run the
 * LIVE artifact hash starts with? Message-only — the return never feeds
 * {@link ParsedSection.artifactHash}, so it cannot widen hash *resolution*
 * (which the #4101 design concept bounds to label lines and their immediate
 * successor); it only stops the gate from telling an author "you cited no
 * hash" about a body that visibly contains the correct one.
 */
export function findCorrectHashMention(section: string, liveHash: string): string | null {
  const live = (liveHash ?? "").toLowerCase();
  if (live.length === 0) return null;
  for (const m of (section ?? "").matchAll(/[0-9a-fA-F]{8,64}/g)) {
    if (live.startsWith(m[0].toLowerCase())) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assertion parsing + evaluation
// ---------------------------------------------------------------------------

/**
 * Repo-relative path guard. The gate reads paths straight out of a PR body
 * inside CI, so absolute paths, `..` traversal, `~`, backslashes and anything
 * outside a conservative charset are rejected outright.
 */
export function isSafeRepoRelativePath(p: string): boolean {
  const s = (p ?? "").trim();
  if (s.length === 0 || s.length > 300) return false;
  if (s.startsWith("/") || s.startsWith("~")) return false;
  if (s.includes("\\") || s.includes("\0")) return false;
  if (s.split("/").some((seg) => seg === "..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(s);
}

function splitOnDoubleColon(rest: string): [string, string] | null {
  const idx = rest.indexOf("::");
  if (idx === -1) return null;
  return [rest.slice(0, idx).trim(), rest.slice(idx + 2).trim()];
}

function bad(raw: string, reason: string): Assertion {
  return { kind: "unparseable", raw, reason };
}

/** Parse one `verified by:` payload into a typed {@link Assertion}. */
export function parseAssertion(raw: string): Assertion {
  const s = stripBackticks(raw);
  if (s.length === 0) return bad(raw, "no `verified by:` assertion found");

  const m = /^([A-Za-z][A-Za-z-]*)\s*:\s*([\s\S]*)$/.exec(s);
  if (!m) return bad(s, "assertion must start with a kind, e.g. `file-contains: <path> :: <literal>`");

  const kind = m[1].toLowerCase();
  const rest = m[2].trim();

  if (kind === "manual") {
    if (rest.length === 0) return bad(s, "`manual:` needs a justification");
    return { kind: "manual", note: rest };
  }

  if (kind === "file-exists" || kind === "file-absent") {
    const path = stripBackticks(rest);
    if (!isSafeRepoRelativePath(path)) return bad(s, `unsafe or malformed path: ${path || "(empty)"}`);
    return kind === "file-exists" ? { kind: "file-exists", path } : { kind: "file-absent", path };
  }

  if (kind === "file-contains" || kind === "file-lacks") {
    const parts = splitOnDoubleColon(rest);
    if (!parts) return bad(s, `${kind} needs \`<path> :: <literal>\``);
    const path = stripBackticks(parts[0]);
    const needle = stripBackticks(parts[1]);
    if (!isSafeRepoRelativePath(path)) return bad(s, `unsafe or malformed path: ${path || "(empty)"}`);
    if (needle.length === 0) return bad(s, `${kind} needs a non-empty literal after \`::\``);
    return kind === "file-contains"
      ? { kind: "file-contains", path, needle }
      : { kind: "file-lacks", path, needle };
  }

  if (kind === "file-matches" || kind === "file-not-matches") {
    const parts = splitOnDoubleColon(rest);
    if (!parts) return bad(s, `${kind} needs \`<path> :: /<regex>/<flags>\``);
    const path = stripBackticks(parts[0]);
    if (!isSafeRepoRelativePath(path)) return bad(s, `unsafe or malformed path: ${path || "(empty)"}`);
    const re = /^\/([\s\S]*)\/([gimsuy]*)$/.exec(stripBackticks(parts[1]));
    if (!re) return bad(s, `${kind} needs a /slash-delimited/ regex`);
    if (re[1].length === 0) return bad(s, `${kind} regex is empty`);
    if (re[1].length > MAX_REGEX_SOURCE) return bad(s, `regex source exceeds ${MAX_REGEX_SOURCE} chars`);
    return kind === "file-matches"
      ? { kind: "file-matches", path, source: re[1], flags: re[2] }
      : { kind: "file-not-matches", path, source: re[1], flags: re[2] };
  }

  if (kind === "occurrences") {
    const parts = splitOnDoubleColon(rest);
    if (!parts) return bad(s, "occurrences needs `<path> :: <literal> == <n>`");
    const path = stripBackticks(parts[0]);
    if (!isSafeRepoRelativePath(path)) return bad(s, `unsafe or malformed path: ${path || "(empty)"}`);
    const cmp = /^([\s\S]*?)\s*(==|<=|>=)\s*(\d+)$/.exec(parts[1]);
    if (!cmp) return bad(s, "occurrences needs a trailing `== <n>` (or `<=` / `>=`)");
    const needle = stripBackticks(cmp[1]);
    if (needle.length === 0) return bad(s, "occurrences needs a non-empty literal");
    return { kind: "occurrences", path, needle, op: cmp[2] as "==" | "<=" | ">=", count: parseInt(cmp[3], 10) };
  }

  return bad(s, `unknown assertion kind \`${kind}\``);
}

/** True iff the assertion is re-executable by the gate (i.e. not prose). */
export function isMachineCheckable(a: Assertion): boolean {
  return a.kind !== "manual" && a.kind !== "unparseable";
}

/** Non-overlapping occurrence count of a literal. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return n;
    n++;
    from = i + needle.length;
  }
}

function missing(path: string): AssertionResult {
  return { ok: false, expected: `readable file ${path}`, observed: "file not found or unreadable" };
}

/**
 * Re-execute an assertion against the worktree via the injected reader.
 * Never throws: an invalid regex or unreadable path resolves to `ok: false`
 * with a diagnostic, so a malformed declaration fails CLOSED.
 */
export function evaluateAssertion(a: Assertion, readFile: FileReader): AssertionResult {
  switch (a.kind) {
    case "manual":
      return { ok: true, expected: "manual justification", observed: a.note };
    case "unparseable":
      return { ok: false, expected: "a parseable assertion", observed: a.reason };
    case "file-exists": {
      const c = readFile(a.path);
      return { ok: c !== null, expected: `${a.path} exists`, observed: c === null ? "absent" : "present" };
    }
    case "file-absent": {
      const c = readFile(a.path);
      return { ok: c === null, expected: `${a.path} absent`, observed: c === null ? "absent" : "present" };
    }
    case "file-contains": {
      const c = readFile(a.path);
      if (c === null) return missing(a.path);
      const n = countOccurrences(c, a.needle);
      return { ok: n > 0, expected: `${a.path} contains "${a.needle}"`, observed: `${n} occurrence(s)` };
    }
    case "file-lacks": {
      // A missing file does NOT vacuously satisfy "does not contain X".
      const c = readFile(a.path);
      if (c === null) return missing(a.path);
      const n = countOccurrences(c, a.needle);
      return { ok: n === 0, expected: `${a.path} does not contain "${a.needle}"`, observed: `${n} occurrence(s)` };
    }
    case "file-matches":
    case "file-not-matches": {
      const c = readFile(a.path);
      if (c === null) return missing(a.path);
      let re: RegExp;
      try {
        re = new RegExp(a.source, a.flags.replace(/g/g, ""));
      } catch (err: any) {
        return { ok: false, expected: `valid regex /${a.source}/`, observed: `invalid regex: ${err?.message ?? err}` };
      }
      const hit = re.test(c);
      const want = a.kind === "file-matches";
      return {
        ok: hit === want,
        expected: `${a.path} ${want ? "matches" : "does not match"} /${a.source}/`,
        observed: hit ? "matched" : "no match",
      };
    }
    case "occurrences": {
      const c = readFile(a.path);
      if (c === null) return missing(a.path);
      const n = countOccurrences(c, a.needle);
      const ok = a.op === "==" ? n === a.count : a.op === "<=" ? n <= a.count : n >= a.count;
      return {
        ok,
        expected: `occurrences of "${a.needle}" in ${a.path} ${a.op} ${a.count}`,
        observed: `${n}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The verdict reducer
// ---------------------------------------------------------------------------

/**
 * Reduce a PR body + artifact into the list of blocking violations. An empty
 * array means the reconciliation section is well-formed AND every declared
 * assertion re-executed true.
 *
 * Callers are responsible for the fail-OPEN cases (no artifact, no anchor, no
 * event payload, orchestrator unreachable, `invariants` empty) — by the time
 * this runs, the artifact resolved and the gate is fail-CLOSED.
 */
export function checkReconciliation(input: ReconcileInput): Violation[] {
  const { prBody, invariants, artifactHash, readFile } = input;
  const violations: Violation[] = [];
  const parsed = parseReconciliationSection(prBody);

  if (!parsed.present) {
    violations.push({
      code: "missing-section",
      invariantIndex: null,
      invariant: null,
      message:
        `The linked issue has an approved design-concept artifact with ${invariants.length} invariant(s), ` +
        `but the PR body has no "${RECONCILIATION_HEADING}" section. ` +
        `Add it as a TOP-LEVEL "##" heading (never nested inside "## Files in scope"), ` +
        `citing the artifact hash and one "- INV-<n>: \"<verbatim quote>\" — verified by: <assertion>" bullet per invariant.`,
    });
    return violations;
  }

  if (parsed.artifactHash === null) {
    // Companion diagnostic (issue #4101, item 3): when the correct hash IS in
    // the section but not in a position the finder reads, say that — "cites no
    // artifact hash" is misleading about a body that visibly contains it.
    const correctMention = findCorrectHashMention(extractReconciliationSection(prBody) ?? "", artifactHash);
    violations.push({
      code: "missing-artifact-hash",
      invariantIndex: null,
      invariant: null,
      message: correctMention
        ? `The reconciliation section cites no artifact hash the gate can read — the correct hash ` +
          `("${correctMention.toLowerCase().slice(0, 12)}…") appears in the section, but not on an ` +
          `"Artifact:" line and not on the line immediately following one. Cite it on the label line, ` +
          `e.g. "Artifact: \`${artifactHash.slice(0, 12)}\`", so the gate can prove the reconciliation ` +
          `was written against the CURRENT artifact.`
        : `The reconciliation section cites no artifact hash. Add a line ` +
          `"Artifact: \`${artifactHash.slice(0, 12)}\`" so the gate can prove the reconciliation was ` +
          `written against the CURRENT artifact.`,
    });
  } else if (!hashesMatch(parsed.artifactHash, artifactHash)) {
    violations.push({
      code: "artifact-hash-mismatch",
      invariantIndex: null,
      invariant: null,
      message:
        `Reconciliation cites artifact hash "${parsed.artifactHash}" but the live artifact hash is ` +
        `"${artifactHash}". The design concept changed after the reconciliation was written — ` +
        `re-read the artifact and redo the reconciliation.`,
    });
  }

  if (parsed.entries.length !== invariants.length) {
    violations.push({
      code: "entry-count-mismatch",
      invariantIndex: null,
      invariant: null,
      message:
        `Reconciliation has ${parsed.entries.length} INV entr(ies) but the artifact declares ` +
        `${invariants.length} invariant(s). Every invariant needs exactly one "- INV-<n>: …" bullet.`,
    });
  }

  const seen = new Map<number, ReconcileEntry>();
  for (const e of parsed.entries) {
    if (seen.has(e.index)) {
      violations.push({
        code: "duplicate-entry",
        invariantIndex: e.index,
        invariant: invariants[e.index - 1] ?? null,
        message: `Duplicate reconciliation entry for INV-${e.index}. Each invariant gets exactly one bullet.`,
      });
      continue;
    }
    if (e.index < 1 || e.index > invariants.length) {
      violations.push({
        code: "unknown-entry",
        invariantIndex: e.index,
        invariant: null,
        message:
          `Reconciliation entry INV-${e.index} has no matching artifact invariant ` +
          `(the artifact declares INV-1 … INV-${invariants.length}).`,
      });
      continue;
    }
    seen.set(e.index, e);
  }

  for (let i = 0; i < invariants.length; i++) {
    const n = i + 1;
    const invariant = invariants[i];
    const entry = seen.get(n);

    if (!entry) {
      violations.push({
        code: "missing-entry",
        invariantIndex: n,
        invariant,
        message:
          `No reconciliation entry for INV-${n}. Unreconciled invariant, verbatim:\n    ${invariant}`,
      });
      continue;
    }

    if (!quoteMatchesInvariant(entry.quoted, invariant)) {
      violations.push({
        code: "quote-mismatch",
        invariantIndex: n,
        invariant,
        message:
          `INV-${n} entry does not quote the invariant verbatim (need a >=${MIN_QUOTE_CHARS}-char prefix, ` +
          `whitespace-normalised).\n    quoted:    ${JSON.stringify(entry.quoted)}\n` +
          `    invariant: ${invariant}`,
      });
      continue;
    }

    const assertion = parseAssertion(entry.assertion);

    if (assertion.kind === "unparseable") {
      violations.push({
        code: "unparseable-assertion",
        invariantIndex: n,
        invariant,
        message:
          `INV-${n} declares an assertion the gate cannot parse: ${assertion.reason}.\n` +
          `    invariant: ${invariant}\n    declared:  ${JSON.stringify(entry.assertion)}`,
      });
      continue;
    }

    if (assertion.kind === "manual" && isMustNotInvariant(invariant)) {
      violations.push({
        code: "must-not-needs-machine-assertion",
        invariantIndex: n,
        invariant,
        message:
          `INV-${n} is a MUST-NOT invariant, so prose ("manual:") is not accepted — it needs a ` +
          `machine-checkable assertion (file-absent / file-lacks / file-not-matches / occurrences).\n` +
          `    invariant: ${invariant}\n    declared:  ${JSON.stringify(entry.assertion)}`,
      });
      continue;
    }

    const result = evaluateAssertion(assertion, readFile);
    if (!result.ok) {
      violations.push({
        code: "assertion-failed",
        invariantIndex: n,
        invariant,
        message:
          `INV-${n} assertion evaluated FALSE.\n    invariant: ${invariant}\n` +
          `    declared:  ${entry.assertion}\n    expected:  ${result.expected}\n    observed:  ${result.observed}`,
      });
    }
  }

  return violations;
}

/** Render violations as the assertion message the required `test` job prints. */
export function formatViolations(violations: Violation[], anchorRef?: number): string {
  const head =
    `Design-concept reconciliation gate FAILED` +
    (anchorRef ? ` for issue #${anchorRef}` : "") +
    ` — ${violations.length} violation(s).`;
  const body = violations.map((v, i) => `\n  ${i + 1}. [${v.code}] ${v.message}`).join("");
  const tail =
    `\n\nFix the PR body, then PUSH A COMMIT: this gate reads the PR body from the triggering ` +
    `webhook payload (GITHUB_EVENT_PATH), so a re-run replays the ORIGINAL body and an edit alone ` +
    `will not clear it.\nContract: docs/operator-playbooks/_fragments/hydra-dev-child-flow.md ` +
    `("Design-concept reconciliation gate").`;
  return head + body + tail;
}

/**
 * Verdict from the live adapter's fail-OPEN skip ladder for a RESOLVED artifact
 * (HTTP 200, body parsed). `enforce: false` + a bare `reason` for every skip;
 * only a structurally-complete, APPROVED artifact returns `enforce: true` (with
 * an empty `reason`), at which point the adapter fails CLOSED via
 * {@link checkReconciliation}.
 *
 * Extracted from the adapter's inline ladder so the skip rungs are unit-testable
 * without GITHUB_EVENT_PATH or a live orchestrator (issue #3849). The live
 * adapter composes this bare `reason` into its `issue #N`-prefixed skip line, so
 * the structural-skip messages are byte-identical to the pre-extraction form.
 */
export type ArtifactEnforceDecision = { enforce: boolean; reason: string };
export function resolveEnforceDecision(artifact: any): ArtifactEnforceDecision {
  const invariants: string[] = Array.isArray(artifact?.invariants) ? artifact.invariants : [];
  if (invariants.length === 0) return { enforce: false, reason: "declares no invariants" };
  const artifactHash: string = typeof artifact?.artifactHash === "string" ? artifact.artifactHash : "";
  if (artifactHash.length === 0) return { enforce: false, reason: "has no artifactHash" };
  // Approval guard (issue #3849): only an APPROVED artifact may bind a PR. A
  // draft or stale artifact skips green, exactly like a missing one — without
  // this rung, a stale/abandoned DRAFT carrying real invariants + a hash became
  // a binding reconciliation requirement on any later PR closing the same issue,
  // on a REQUIRED merge-gate job (the npm-audit ambient-poison-pill class, where
  // a check reddens the merge queue from state outside the PR's own diff). A
  // missing or unrecognised status is treated as not-approved (fail OPEN — never
  // bind on a shape we cannot confirm is approved). This is an ADDITIONAL rung:
  // the four pre-existing skip conditions above are unchanged.
  const status = typeof artifact?.status === "string" ? artifact.status : "";
  if (status !== "approved") {
    return {
      enforce: false,
      reason: `is not approved (status: ${status ? `'${status}'` : "unknown"}) — only an approved artifact binds a PR`,
    };
  }
  return { enforce: true, reason: "" };
}
