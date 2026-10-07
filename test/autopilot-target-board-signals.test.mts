/**
 * The `gh issue list` page-size ratchet over collect-state.sh (issue #3710).
 *
 * This file used to pin the Target board emission too (issues #3435, #3709,
 * #3710, #3973, #4130, #4528, #4823). ADR-0043 slice 4 (#4932) moved those
 * collectors — and their behavioural cases, 1:1 — to the typed Turn Snapshot
 * collectors and test/turn-snapshot-target-board.test.mts. What stays here is
 * the whole-file ratchet: every `gh issue list` the remaining bash collectors
 * issue must carry the shared `--limit "$GH_ISSUE_LIST_LIMIT"`.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "autopilot", "collect-state.sh");
const src = readFileSync(SCRIPT, "utf-8");

/**
 * Every `gh issue list` in collect-state.sh carries an explicit `--limit`
 * (issue #3710).
 *
 * `gh issue list` defaults to 30 with no error and no warning, and it sorts
 * newest-first — so an unlimited call silently drops the OLDEST issues, which
 * is precisely the cohort the age-sensitive consumers care about
 * (`wire_or_retire_target_available` gates on a 45-day ledger;
 * `target_backfill_idle` flips true on a board whose only remaining triage
 * items were truncated away). The Target board was already past 30 when #3710
 * was filed: five open issues were invisible to the collector every turn.
 *
 * WHY THIS TEST IS NOT A GREP. The issue originally proposed
 * `grep 'gh issue list' | grep -v -- '--limit'`. That is actively misleading
 * against this file, in BOTH directions:
 *
 *   - FALSE FAILURES: three of the twelve `gh issue list` occurrences are
 *     comment prose (the header docs, the ADR-0031 REST-only note, the
 *     wayfinder cost note), not invocations at all.
 *   - FALSE PASSES: three real invocations span line continuations, so a
 *     line-oriented grep stops reading before the flag. The Target healthy-path
 *     call deliberately carries its `--limit` on a continuation line, which a
 *     naive grep would report as unlimited.
 *
 * So the assertion runs over LOGICAL shell commands: comment lines are dropped
 * at command boundaries only (inside an open quote a leading `#` is data, not a
 * comment), and physical lines are joined across both continuation forms —
 * a trailing backslash AND an unterminated quote (the `--jq '` blocks).
 */

type QuoteState = null | "'" | '"';

/** Advance shell quote state across one physical line. */
function scanQuotes(text: string, state: QuoteState): QuoteState {
  let s = state;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (s === "'") {
      // Single quotes are literal in shell: nothing escapes, only `'` closes.
      if (c === "'") s = null;
      continue;
    }
    if (s === '"') {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') s = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') s = c;
  }
  return s;
}

type LogicalCommand = { line: number; text: string };

/** The word after `<<` / `<<-`: `DELIM`, `'DELIM'` or `"DELIM"`. */
const HEREDOC_WORD_RE = /^-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/**
 * The delimiters of every heredoc one physical line opens, in order.
 *
 * `<<` opens a heredoc only where the shell would read a redirection:
 *
 *   - not inside single quotes;
 *   - not inside double quotes — UNLESS a `$(` command substitution was
 *     opened after that quote on this same line, which is the
 *     `python3 -c "$(cat <<'PY'` shape collect-state.sh is built from;
 *   - not inside `$(( … ))` arithmetic, where `<<` is a shift;
 *   - not `<<<`, which is a here-string.
 *
 * Known limits, both of which FAIL LOUD (the caller throws on a heredoc that
 * never terminates) rather than hiding commands: quotes nested inside a
 * `"$( … )"` substitution are not tracked, and neither is a `$(` opened on an
 * earlier line of a multi-line double-quoted string.
 */
function heredocOpeners(text: string, state: QuoteState): string[] {
  const delims: string[] = [];
  let s = state;
  let substInDq = 0; // depth of `$(` opened inside the current double quote
  let arith = 0; // depth of `$((`
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (s === "'") {
      if (c === "'") s = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (text.startsWith("$((", i)) {
      arith++;
      i += 2;
      continue;
    }
    if (arith > 0) {
      if (text.startsWith("))", i)) {
        arith--;
        i++;
      }
      continue;
    }
    if (s === '"') {
      if (text.startsWith("$(", i)) {
        substInDq++;
        i++;
        continue;
      }
      if (substInDq === 0) {
        if (c === '"') s = null;
        continue;
      }
      if (c === ")") {
        substInDq--;
        continue;
      }
      // Inside `"$( …`: command context — fall through to the `<<` check.
    } else if (c === "'" || c === '"') {
      s = c;
      continue;
    }
    if (!text.startsWith("<<", i)) continue;
    if (text[i + 2] === "<") {
      i += 2;
      continue;
    }
    const word = HEREDOC_WORD_RE.exec(text.slice(i + 2));
    if (word) {
      delims.push(word[2]);
      i += 1 + word[0].length;
    } else {
      i++;
    }
  }
  return delims;
}

/**
 * Split shell source into logical commands, skipping whole-line comments.
 *
 * Heredoc bodies stay in the command text but are NOT quote-scanned (issue
 * #4821): the embedded python is full of quotes and apostrophes that are not
 * shell quoting, so scanning it left a stray open quote after the closing
 * `)"`. The parse then only recovered by accident — on whichever later
 * comment line happened to carry an odd number of quote characters — and
 * editing that comment joined three `gh issue list` commands into one.
 *
 * A line may open several heredocs (`cat <<A <<B`); their bodies are consumed
 * in order. When the last one terminates, the command ends there if no quote
 * is open; otherwise (the `"$(cat <<'PY' … PY` shape, whose quote closes on
 * the following `)"` line) it stays buffered until the quote closes, exactly
 * like any other multi-line quoted command.
 */
function logicalCommands(source: string): LogicalCommand[] {
  const lines = source.split("\n");
  const out: LogicalCommand[] = [];
  let buf = "";
  let startLine = 0;
  let quote: QuoteState = null;
  let heredocs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (heredocs.length > 0) {
      buf += "\n" + raw;
      if (raw.trim() === heredocs[0]) {
        heredocs.shift();
        // A bare heredoc (no enclosing open quote) ends its command here.
        if (heredocs.length === 0 && quote === null) {
          out.push({ line: startLine, text: buf });
          buf = "";
        }
      }
      continue;
    }
    if (buf === "") {
      // A leading `#` is a comment ONLY at a command boundary. Mid-command it
      // is data (a jq comment, prose inside a quoted body) and dropping it
      // would corrupt the join — and comment prose is full of apostrophes
      // ("decide.py's"), which would wreck the quote scanner if fed to it.
      if (raw.trim() === "" || /^\s*#/.test(raw)) continue;
      startLine = i + 1;
      buf = raw;
    } else {
      buf += "\n" + raw;
    }
    heredocs = heredocOpeners(raw, quote);
    quote = scanQuotes(raw, quote);
    if (heredocs.length > 0) continue;
    // Continue on an unterminated quote (multi-line `--jq '...'`) or on an
    // explicit backslash line continuation.
    if (quote !== null || /\\$/.test(raw)) continue;
    out.push({ line: startLine, text: buf });
    buf = "";
  }
  if (heredocs.length > 0) {
    throw new Error(`unterminated heredoc <<${heredocs[0]} — parser would hide later commands`);
  }
  if (buf !== "") out.push({ line: startLine, text: buf });
  return out;
}

const ghIssueListCommands = () =>
  logicalCommands(src).filter((c) => c.text.includes("gh issue list"));

describe("collect-state.sh — gh issue list page-size ratchet (issue #3710)", () => {
  test("the parser skips comment prose and joins BOTH continuation forms", () => {
    // A miniature of the exact shapes in collect-state.sh. If this fixture
    // parses correctly, the assertion below is trustworthy; if the parser ever
    // regresses to line-oriented matching, this fails first and explains why.
    const fixture = [
      "#!/usr/bin/env bash",
      "# Prose: one `gh issue list` fetch, per decide.py's cost note.",
      "#   - Another `gh issue list` mention, with an apostrophe's worth of risk.",
      "LIMITED=$(gh issue list --repo o/r --state open \\",
      '  --limit "$L" \\',
      "  --json number --jq 'length')",
      "gh issue list --repo o/r --state open --json number --jq '",
      "  [ .[] | .number ]",
      "  | length'",
      "echo done",
    ].join("\n");

    const cmds = logicalCommands(fixture).filter((c) => c.text.includes("gh issue list"));

    assert.equal(
      cmds.length,
      2,
      "three of the five `gh issue list` occurrences are prose — a grep would see five",
    );
    assert.ok(
      cmds[0].text.includes('--limit "$L"'),
      "the backslash-continued invocation must be joined so its continuation-line --limit is visible",
    );
    assert.ok(
      cmds[1].text.includes("| length'"),
      "the unterminated-quote invocation must be joined through its closing quote",
    );
    assert.deepEqual(
      cmds.filter((c) => !c.text.includes("--limit")).map((c) => c.line),
      [7],
      "exactly the one genuinely unlimited invocation is flagged, by its real line number",
    );
  });

  test("a heredoc body never leaks quote state into the commands after it (issue #4821)", () => {
    // The collect-state.sh shape that broke: `"$(cat <<'PY' … PY\n)"` around
    // python whose own quotes do not balance as shell, followed by comment
    // prose and two real invocations. Scanning the body leaves a quote open,
    // which swallows the comment and joins A and B into the first command.
    const fixture = [
      "PICK=$(printf '%s' \"$JSON\" | python3 -c \"$(cat <<'PY'",
      "s = \"it's\"",
      "PY",
      ')")',
      "",
      "# Prose mentioning `gh issue list` with no quote characters at all.",
      'A=$(gh issue list --repo o/r --limit "$L" --json number)',
      'B=$(gh issue list --repo o/r --limit "$L" --json title)',
    ].join("\n");

    const cmds = logicalCommands(fixture).filter((c) => c.text.includes("gh issue list"));

    assert.deepEqual(
      cmds.map((c) => c.line),
      [7, 8],
      "each invocation after the heredoc must parse as its own command",
    );
  });

  test("here-strings, <<-, bare and unterminated heredocs are handled (issue #4821 QA)", () => {
    const lines = (src: string[]) =>
      logicalCommands(src.join("\n"))
        .filter((c) => c.text.includes("gh issue list"))
        .map((c) => c.line);
    // A <<< here-string must not open heredoc mode.
    assert.deepEqual(lines(["cat <<<word", "gh issue list --limit 1", "gh issue list --json a"]), [2, 3]);
    // << inside single quotes is data.
    assert.deepEqual(lines(["echo 'a <<EOF b'", "gh issue list --limit 1"]), [2]);
    // <<- and bare heredocs terminate and resume parsing.
    assert.deepEqual(lines(["cat <<-EOF", "x '", "EOF", "gh issue list --limit 1"]), [4]);
    assert.deepEqual(lines(["cat <<EOF", "x", "EOF", "gh issue list --limit 1"]), [4]);
    // Unterminated heredoc fails loud.
    assert.throws(
      () => logicalCommands("cat <<EOF\ngh issue list --limit 1"),
      /unterminated heredoc/,
    );
  });

  test("only a real redirection opens heredoc mode (issue #4821 QA round 2)", () => {
    const lines = (src: string[]) =>
      logicalCommands(src.join("\n"))
        .filter((c) => c.text.includes("gh issue list"))
        .map((c) => c.line);
    // `<<WORD` in double-quoted prose is data, on one line or across two.
    assert.deepEqual(
      lines(['echo "see <<EOF in prose"', "gh issue list --limit 1", "gh issue list --json a"]),
      [2, 3],
    );
    assert.deepEqual(lines(['MSG="first', 'uses <<EOF here"', "gh issue list --limit 1"]), [3]);
    // `<<` inside $(( … )) is a shift, quoted or not.
    assert.deepEqual(lines(["X=$((1<<LIMIT))", "gh issue list --limit 1"]), [2]);
    assert.deepEqual(lines(['echo "$((1<<LIMIT))"', "gh issue list --limit 1"]), [2]);
    // Two openers on one line: BOTH bodies are skipped, so the apostrophe in
    // the second body cannot join the commands that follow.
    assert.deepEqual(
      lines(["cat <<A <<B", "a", "A", "it's", "B", "gh issue list --limit 1", "gh issue list --json a"]),
      [6, 7],
    );
    // A `$(` opened inside a double quote on the same line is command context.
    assert.deepEqual(lines(['X="$(cat <<EOF', "it's", "EOF", ')"', "gh issue list --limit 1"]), [5]);
  });

  test("the real collect-state.sh yields a plausible count of gh issue list commands", () => {
    assert.ok(ghIssueListCommands().length >= 3, "parser must still see collect-state.sh's invocations");
  });

  test("every gh issue list invocation carries an explicit --limit", () => {
    const cmds = ghIssueListCommands();
    const unlimited = cmds.filter((c) => !c.text.includes("--limit"));
    assert.deepEqual(
      unlimited.map((c) => `line ${c.line}`),
      [],
      "gh defaults to 30 and truncates newest-first — an unlimited list silently drops the oldest issues",
    );
  });

  test("every invocation sources its limit from the one shared constant", () => {
    for (const c of ghIssueListCommands()) {
      assert.ok(
        c.text.includes('--limit "$GH_ISSUE_LIST_LIMIT"'),
        `line ${c.line}: limit must come from GH_ISSUE_LIST_LIMIT, not a private literal that can drift`,
      );
    }
  });

  test("the parser resolves the file's real invocations without over-joining", () => {
    const cmds = ghIssueListCommands();
    assert.ok(
      cmds.length >= 9,
      `expected at least the 9 known call sites, parsed ${cmds.length} — the parser lost invocations`,
    );
    for (const c of cmds) {
      const occurrences = c.text.split("gh issue list").length - 1;
      assert.equal(
        occurrences,
        1,
        `line ${c.line}: two commands were joined into one, so a missing --limit could hide behind a sibling's`,
      );
    }
  });

  test("the shared constant defaults to 100 — the GitHub API's max single page", () => {
    assert.match(
      src,
      /^GH_ISSUE_LIST_LIMIT="\$\{HYDRA_GH_ISSUE_LIST_LIMIT:-100\}"$/m,
      "100 is one API page (zero extra round trips on a per-turn hot path) and matches DEFAULT_LIMIT in src/github/issues.ts",
    );
  });

  test("never --paginate: unbounded paging is not the fix for a truncated hot-path read", () => {
    // Again scoped to commands — the constant's own docstring names
    // `--paginate` to explain why it was rejected.
    for (const c of ghIssueListCommands()) {
      assert.doesNotMatch(
        c.text,
        /--paginate/,
        `line ${c.line}: paging trades a silent truncation for unbounded per-turn latency and rate-limit cost`,
      );
    }
  });
});
