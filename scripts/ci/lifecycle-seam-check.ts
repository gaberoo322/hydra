#!/usr/bin/env -S npx tsx
/**
 * Lifecycle-Seam check — direct state-label write ratchet (ADR-0047 D3/D7,
 * issue #5311).
 *
 * Issue lifecycle state labels are written through ONE seam:
 * `scripts/lifecycle.ts` over `src/lifecycle/`. This is the blocking backstop
 * that freezes drift: it counts "write sites" — places in playbooks, `src/` and
 * `scripts/` that write a lifecycle state label (or an unresolvable label
 * operand) directly — per file, and a shrink-only baseline
 * (`test/fixtures/lifecycle-seam-baseline.json`) tolerates today's sites.
 *
 * It is blocking because `test/lifecycle-seam-check.test.mts` runs the live
 * scan inside `npm test` (the REQUIRED `test` job); `ci.yml` is untouched.
 *
 * State names are imported from `src/lifecycle/` (`OPEN_STATES`), never copied.
 *
 * CLI (the Ratchet module's `main`, convenience only):
 *   npx tsx scripts/ci/lifecycle-seam-check.ts                    # report
 *   npx tsx scripts/ci/lifecycle-seam-check.ts --write-baseline   # tighten only
 *
 * Fix a new site by routing the transition through
 * `npx tsx scripts/lifecycle.ts advance <issue> <to> ...`; growth needs
 * `--write-baseline --allow-grow` plus a reviewed `Baseline-raise:` PR line.
 *
 * The scanner is a best-effort heuristic behind a shrink-only ratchet, not a
 * sound analysis (#5359 round-4 ruling). Beyond plain flags and calls it counts:
 * create-context short `-l`; unresolvable flag operands (`{x}` placeholders,
 * `"--add-label " + x` concatenation, a trailing `=`); generic / optional calls
 * (`addIssueLabel<T>(`, `f?.(`); and one-hop aliases/wrappers of the seam
 * functions (`import { F as x }`, `const w = F ?? ...`, `const w = (..) => F(..)`).
 *
 * Not counted (documented evasions) — each is pinned by a synthetic test:
 *  - python `%`-formatting / `.format()` where the placeholder is not a brace
 *    at operand position (`"--add-label %s" % x`);
 *  - arity-changing wrappers (`const w = (l) => addIssueLabel(N, l); w("x")`):
 *    the wrapper definition line is counted, its calls are not;
 *  - two-hop aliases and `export { F as x }` re-exports from another module;
 *  - flags assembled from a separately-bound string (`const FLAG = "--add-label"`);
 *  - `.github/workflows/**` (ADR-0047 D1);
 *  - Target board writes are outside the seam (ADR-0047 scope): a label flag in a `gh issue <subcmd>`
 *    command whose own `--repo`/`-R` operand is one of a closed Target identifier list (`TARGET_REPO`,
 *    `$TARGET_GH_REPO`, `targetRepo`, ...) is not a site. Identifier-based, so `targetRepo = 'gaberoo322/hydra'`
 *    aliasing is a documented evasion; `gh api repos/$TARGET_REPO/issues/N/labels` writes are not covered;
 *  - PR labels are flags, not state (ADR-0047 D2, #5428): a label flag inside a
 *    `gh pr <subcmd>` command (shell or argv form) and a `gh api` write on an
 *    `issues/<PR identifier>/labels` path (one of 8 exact identifiers, e.g. `$PR`, `${PR_NUMBER}`, `{pr_id}`) are not sites. The latter is identifier-based, so the
 *    aliasing evasion `PR=$ISSUE; gh api -X DELETE repos/o/r/issues/$PR/labels/x` is not counted.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ORCH_BOARD_LABELS } from "../../src/board-labels.ts";
import { OPEN_STATES } from "../../src/lifecycle/index.ts";
import { defineRatchet, runIfCli } from "./ratchet.ts";
import { REPO_ROOT, stripComments } from "./seam-check-lib.ts";

export { REPO_ROOT };

/** The scanner's state vocabulary: exactly the 13 label states (`closed` is no label). */
export const LIFECYCLE_STATE_NAMES: readonly string[] = [...OPEN_STATES];
const STATE_SET: ReadonlySet<string> = new Set(LIFECYCLE_STATE_NAMES);

export const LIFECYCLE_SEAM_BASELINE_REL = "test/fixtures/lifecycle-seam-baseline.json";

/** Exemptions: the ONLY carve-outs, one reason each. */
export const LIFECYCLE_EXEMPTIONS: ReadonlyArray<{
  matches: (relPath: string) => boolean;
  reason: string;
}> = [
  { matches: (p) => p.startsWith("src/lifecycle/"), reason: "the seam itself" },
  { matches: (p) => p === "src/github/issues.ts", reason: "label-write transport definition" },
  { matches: (p) => p === "src/github/issue-actions.ts", reason: "label-write transport definition" },
  { matches: (p) => p === "src/github/prs.ts", reason: "label-write transport definition" },
  { matches: (p) => p === "scripts/lifecycle.ts", reason: "the CLI adapter over the seam" },
  { matches: (p) => p === "scripts/ci/lifecycle-seam-check.ts", reason: "this checker" },
  {
    matches: (p) =>
      /^docs\/operator-playbooks\/(?:_fragments\/)?hydra-target-[^/]*\.md$/.test(p) ||
      p === "docs/operator-playbooks/hydra-wire-or-retire.md" ||
      p === "docs/operator-playbooks/hydra-design-qa.md",
    reason: "Target-scope playbooks: ADR-0047 scopes the seam to the Orchestrator board",
  },
  {
    matches: (p) => p === "scripts/target/target-reframe.ts",
    reason: "Target board reframe write: ADR-0047 scopes the seam to the Orchestrator board",
  },
];

export function isExemptPath(relPath: string): boolean {
  return LIFECYCLE_EXEMPTIONS.some((e) => e.matches(relPath));
}

// ---------------------------------------------------------------------------
// Detection — pure functions
// ---------------------------------------------------------------------------

const STATE_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${LIFECYCLE_STATE_NAMES.map((s) => s.replace(/[-]/g, "\\-")).join("|")})(?![A-Za-z0-9_-])`,
);

function operandIsSite(operand: string, identifierIsVariable: boolean): boolean {
  if (operand.includes("$") || operand.includes("{")) return true;
  if (identifierIsVariable && /^[A-Za-z_][\w.]*$/.test(operand)) return true;
  return STATE_TOKEN_RE.test(operand);
}

/** `gh api` as a shell command or an argv list (`"gh", ["api", ...]`). */
const GH_API_RE = /\bgh\b["'\s,[]*\bapi\b|["']api["']\s*,/;
/** Label flags: `--add-label` / `--remove-label` / `--label`, and short `-l` (own token only). */
const FLAG_NAME_SRC = String.raw`--(?:add-|remove-)?label|(?<![^\s"',])-l(?=[\s="',]|$)`;
const FLAG_RE = new RegExp(
  String.raw`(?:${FLAG_NAME_SRC})(?:(["']?\s*,\s*)|[ =]+)(?:"([^"]*)"|'([^']*)'|([^\s"')\]]+))`,
  "g",
);
/** `"--add-label " + x` / `"--add-label=" + x`: the operand lives outside the literal. */
const CONCAT_RE = new RegExp(String.raw`(?:${FLAG_NAME_SRC})[ =]*["']\s*\+`, "g");
/** `"--add-label="` (flag literal closes right after `=`) or a flag `=` ending the logical line. */
const TRAILING_EQ_RE = new RegExp(
  String.raw`(["'])(?:${FLAG_NAME_SRC})=\1|(?:${FLAG_NAME_SRC})=\s*$`,
  "g",
);
/** Bare `--label` / `-l` write only on create commands (elsewhere they are list filters). */
function isCreateOnlyFlag(matched: string): boolean {
  return /^["']?(?:--label|-l)(?![\w-])/.test(matched);
}
/** Bare `--label` only writes state on create commands (elsewhere it is a list filter). */
const CREATE_CMD_RE = /\bcreate\b/;
/**
 * A `;` / `&&` / `||` / `|` outside quotes in `tail` (which starts at `issue|pr`). `before` is the
 * char ahead of it: a quote there means `tail` opens inside that literal (argv form).
 */
function hasUnquotedBoundary(tail: string, before: string, startDepth = 0): boolean {
  let quote = before === '"' || before === "'" ? before : "";
  let depth = startDepth;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth--;
    else if (ch === "\n" && depth <= 0) return true; // unquoted newline outside any bracket ends the command
    else if (ch === ";" || ch === "|" || (ch === "&" && tail[i + 1] === "&")) return true;
  }
  return false;
}

/** Net open-bracket count of `s`. */
function bracketDepth(s: string): number {
  let depth = 0;
  for (const ch of s) {
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth--;
  }
  return depth;
}

/** Index of the first unquoted `<<` heredoc marker (not `<<<`, not an arithmetic shift) in `tail`, or -1. */
function findHeredocMarker(tail: string, before: string): number {
  let quote = before === '"' || before === "'" ? before : "";
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "<" && tail[i + 1] === "<") {
      if (tail[i + 2] === "<") {
        i += 2; // `<<<` here-string, not a heredoc
        continue;
      }
      if (/^-?\s*(["']?)[A-Za-z_]\w*\1/.test(tail.slice(i + 2))) return i;
      i++; // `1<<2` arithmetic shift
    }
  }
  return -1;
}

/**
 * A heredoc (`<<WORD`) keeps the command open only when its marker sits before the first unquoted
 * command boundary. With `endsAtTerminator` (the PR exemption, which must fail closed) it also
 * requires that nothing after the terminator line can start another command: the rest of the marker
 * line has no boundary, and a flag reached after the terminator belongs to a new command. A flag
 * still inside the heredoc body (terminator not yet seen) is body text of this command.
 */
function heredocReaches(tail: string, before: string, depth: number, endsAtTerminator = false): boolean {
  const at = findHeredocMarker(tail, before);
  if (at < 0 || hasUnquotedBoundary(tail.slice(0, at), before, depth)) return false;
  const m = /^<<-?\s*(["']?)([A-Za-z_]\w*)\1/.exec(tail.slice(at));
  if (!m) return false;
  if (!endsAtTerminator) return true;
  const afterMarker = tail.slice(at + m[0].length);
  const eol = afterMarker.indexOf("\n");
  const markerRest = eol < 0 ? afterMarker : afterMarker.slice(0, eol);
  if (hasUnquotedBoundary(markerRest, "", depth)) return false;
  if (eol < 0) return true;
  const body = afterMarker.slice(eol + 1);
  const term = new RegExp(`(?:^|\\n)[ \\t]*${m[2]}[ \\t]*(?:\\n|$)`).exec(body);
  return !term || depth > 0; // terminator seen: whatever follows is a new command (unless inside brackets)
}

/** A bare `--label` is a create-time write when `create` appears within 300 chars before it (same or earlier line). */
function inCreateContext(text: string, idx: number, matched = ""): boolean {
  const win = text.slice(Math.max(0, idx - 300), idx);
  // Short `-l` is also `ls -l` / `wc -l` / `grep -l`: demand `issue|pr create` (shell or argv), not a bare `create`.
  if (/^["']?-l(?![\w-])/.test(matched)) {
    // Same command only, bounded by command boundaries rather than newlines: the last
    // `issue|pr create` must reach the flag with no unquoted `;` / `&&` / `||` / `|` between. A newline
    // ends the command only when no bracket is open (multi-line argv list), no `\` continues it
    // and no heredoc (`<<`) is in play. Gives `-l` the same reach as `--label` (INV-2).
    let create = -1;
    for (const m of win.matchAll(/\b(?:issue|pr)["',\s[]+create\b/g)) create = m.index ?? -1;
    if (create < 0) return false;
    const tail = win.slice(create).replace(/\\\r?\n/g, " ").replace(/\r/g, "");
    // Brackets opened just before `issue` (`run("gh", [` then newline-separated items) still count.
    const depth = bracketDepth(win.slice(Math.max(0, create - 80), create));
    return heredocReaches(tail, win[create - 1] ?? "", depth) || !hasUnquotedBoundary(tail, win[create - 1] ?? "", depth);
  }
  return CREATE_CMD_RE.test(win);
}

/**
 * Start offsets of the nearest `gh pr` / `gh issue` command before the end of `win` (shell or argv
 * form), or -1. Shared by the PR-context and Target-repo carve-outs so the command-start rule has
 * one definition.
 */
function lastGhCommandStarts(win: string): { pr: number; issue: number } {
  let pr = -1;
  let issue = -1;
  for (const m of win.matchAll(/\bgh["',\s[]+(?:(?:-R|--repo)["',\s=]+[\w./-]+["',\s[]+)*(pr|issue)\b/g)) {
    const at = (m.index ?? 0) + m[0].length - m[1]!.length;
    if (m[1] === "pr") pr = at;
    else issue = at;
  }
  for (const m of win.matchAll(/(["'])(pr|issue)\1\s*,\s*["']\w+["']/g)) {
    const at = (m.index ?? 0) + 1;
    if (m[2] === "pr") pr = Math.max(pr, at);
    else issue = Math.max(issue, at);
  }
  return { pr, issue };
}

/** `issues/$PR/labels`, `issues/${PR_NUMBER}/labels`, `issues/{pr_number}/labels`: PR-identifier label path (#5428). */
const PR_LABEL_PATH_RE = /issues\/(?:\$\{?|\{)(?:PR|PR_NUMBER|PR_NUM|PR_ID|pr|pr_number|pr_num|pr_id)\}?\/labels/;

/**
 * Is the flag at `idx` inside a `gh pr <subcmd>` command (shell or argv form)? PR labels are flags
 * (ADR-0047 D2). Same command bound as `-l`: the nearest `gh pr|issue` start before the flag must be
 * `pr`, with no unquoted `;` / `&&` / `||` / `|` / unbracketed newline between (#5428).
 */
function inPrContext(text: string, idx: number): boolean {
  // Unbounded walk-back (operator ruling, PR #5431 rounds 2-3): no fixed lookback constant to outgrow.
  const win = text.slice(0, idx);
  const { pr, issue } = lastGhCommandStarts(win);
  if (pr < 0 || issue > pr) return false;
  // `gh issue edit $(gh pr view ...) --add-label x`: the `gh pr` is nested in the issue command's args (INV-3).
  if (issue >= 0 && !hasUnquotedBoundary(win.slice(issue, pr), win[issue - 1] ?? "")) return false;
  const tail = win.slice(pr).replace(/\\\r?\n/g, " ").replace(/\r/g, "");
  const depth = bracketDepth(win.slice(Math.max(0, pr - 80), pr));
  const lead = win[pr - 1] ?? "";
  return heredocReaches(tail, lead, depth, true) || (findHeredocMarker(tail, lead) < 0 && !hasUnquotedBoundary(tail, lead, depth));
}

/** Exact `--repo` / `-R` operands that name the Target board (ADR-0047 scopes the seam to the Orchestrator board). */
const TARGET_REPO_OPERANDS: ReadonlySet<string> = new Set([
  "TARGET_REPO", "$TARGET_REPO", "${TARGET_REPO}",
  "TARGET_GH_REPO", "$TARGET_GH_REPO", "${TARGET_GH_REPO}",
  "targetRepo", "{target_repo}",
]);
const REPO_FLAG_RE = /(?<![\w-])(?:--repo|-R)(?:["']?\s*,\s*|[ \t=]+)(?:"([^"]*)"|'([^']*)'|([^\s"',)\]]+))/g;

/**
 * Is the flag at `idx` inside a `gh issue <subcmd>` command (shell or argv form) whose own `--repo` /
 * `-R` operand (same command, bracket depth 0) is a closed Target identifier? Target board writes are
 * outside the seam's scope. Identifier-based, so `targetRepo = 'gaberoo322/hydra'` aliasing is a
 * documented evasion, not a soundness claim.
 */
function inTargetRepoContext(text: string, idx: number): boolean {
  const win = text.slice(0, idx);
  const { pr, issue } = lastGhCommandStarts(win);
  if (issue < 0 || pr > issue) return false;
  const lead = text[issue - 1] ?? "";
  // Is the command inside an open bracket (a call or argv list)? Walk back to the nearest unmatched opener.
  let base = 0;
  for (let i = issue - 1, open = 0; i >= Math.max(0, issue - 400); i--) {
    const ch = win[i]!;
    if (ch === ")" || ch === "]" || ch === "}") open++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (open === 0) {
        base = 1;
        break;
      }
      open--;
    }
  }
  const before = win.slice(issue).replace(/\\\r?\n/g, " ").replace(/\r/g, "");
  if (hasUnquotedBoundary(before, lead, base)) return false;
  // Walk forward to the end of this command: unquoted boundary, unbracketed newline, or its closing bracket.
  const fwd = text.slice(issue).replace(/\\\r?\n/g, " ").replace(/\r/g, "");
  let quote = lead === '"' || lead === "'" ? lead : "";
  let depth = base;
  let end = fwd.length;
  const depthAt: number[] = new Array(fwd.length + 1);
  for (let i = 0; i < fwd.length; i++) {
    depthAt[i] = depth;
    const ch = fwd[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") {
      depth--;
      if (depth < base) {
        end = i;
        break;
      }
    } else if (ch === ";" || ch === "|" || (ch === "&" && fwd[i + 1] === "&") || (ch === "\n" && depth <= 0)) {
      end = i;
      break;
    }
  }
  if (before.length > end) return false; // the flag sits past the end of this command
  const cmd = fwd.slice(0, end);
  for (const m of cmd.matchAll(REPO_FLAG_RE)) {
    if (depthAt[m.index ?? 0] !== base) continue;
    const operand = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (TARGET_REPO_OPERANDS.has(operand)) return true;
  }
  return false;
}

/** A bare list-form identifier operand that a module-scope const resolves to a NON-state literal (INV-3). */
function resolvedNonState(operand: string, consts?: Map<string, string>): boolean {
  const id = operand.replace(/,$/, "");
  return !!consts && /^[A-Za-z_$][\w$]*$/.test(id) && consts.has(id) && !STATE_SET.has(consts.get(id)!);
}

/** Join backslash-continued physical lines; each logical line keeps its first physical line number. */
function logicalLines(text: string): Array<{ line: number; text: string; offset: number }> {
  const phys = text.split(/\r?\n/);
  const out: Array<{ line: number; text: string; offset: number }> = [];
  let acc = 0;
  const physOffsets = phys.map((p) => {
    const o = acc;
    acc += p.length + 1;
    return o;
  });
  for (let i = 0; i < phys.length; i++) {
    const start = i;
    let cur = phys[i]!;
    while (/\\\s*$/.test(cur) && i + 1 < phys.length) {
      cur = cur.replace(/\\\s*$/, " ") + phys[++i]!.trimStart();
    }
    out.push({ line: start + 1, text: cur, offset: physOffsets[start]! });
  }
  return out;
}

/** Line grammar for markdown / shell / python / mjs. Returns 1-based site line numbers. */
export function scanTextSites(text: string, consts?: Map<string, string>): number[] {
  const sites: number[] = [];
  for (const { line: lineNo, text: line, offset } of logicalLines(text)) {
    let hit = false;
    for (const m of line.matchAll(FLAG_RE)) {
      if (inPrContext(text, offset + (m.index ?? 0))) continue;
      if (isCreateOnlyFlag(m[0]) && !inCreateContext(text, offset + (m.index ?? 0), m[0])) continue;
      if (inTargetRepoContext(text, offset + (m.index ?? 0))) continue;
      const argList = m[1] !== undefined; // `"--add-label", x` list form
      const quoted = m[2] ?? m[3];
      const operand = quoted ?? m[4] ?? "";
      const bareIdentifier = quoted === undefined && argList;
      if (bareIdentifier && operand) {
        if (resolvedNonState(operand, consts)) continue;
        hit = true; // list form, non-literal operand (`labelFor(x)`, `labels[i]`): fail closed
        continue;
      }
      for (const part of operand.split(",")) {
        if (part && operandIsSite(part, bareIdentifier)) hit = true;
      }
    }
    for (const re of [CONCAT_RE, TRAILING_EQ_RE]) {
      for (const m of line.matchAll(re)) {
        if (inPrContext(text, offset + (m.index ?? 0))) continue;
        if (isCreateOnlyFlag(m[0]) && !inCreateContext(text, offset + (m.index ?? 0), m[0])) continue;
        hit = true; // operand not inside the literal: unresolvable, fail closed
      }
    }
    // Per `gh api` invocation: a PR-path write must not hide a chained issue-path write on the same line.
    for (const chunk of line.split(/(?=\bgh["'\s,[]*\bapi\b)/)) {
      if (hit) break;
      if (!(GH_API_RE.test(chunk) && !PR_LABEL_PATH_RE.test(chunk) && (/\/labels\b/.test(chunk) || /labels\[\]=/.test(chunk)))) continue;
      const isWrite =
        /(?:-X|--method)["',= ]+(?:POST|PUT|PATCH|DELETE)\b/i.test(chunk) ||
        /(?:-[fF]|--field|--raw-field)["',= ]*["']?labels\[\]=/.test(chunk) ||
        /--input\b/.test(chunk);
      if (isWrite) {
        const operands: string[] = [];
        const tail = /\/labels\/?([^\s"',]*)/.exec(chunk);
        if (tail && tail[1]) operands.push(tail[1]);
        for (const f of chunk.matchAll(/labels\[\]=([^\s"',]+)/g)) operands.push(f[1]!);
        if (/--input\b/.test(chunk) || operands.some((o) => operandIsSite(o, false))) hit = true;
      }
    }
    if (hit) sites.push(lineNo);
  }
  // Argv list form with the flag and its operand on separate physical lines (prettier-formatted).
  const seen = new Set(sites);
  for (const m of text.matchAll(FLAG_RE)) {
    if (m[1] === undefined || !m[0].includes("\n")) continue; // single-line matches handled above
    if (inPrContext(text, m.index!)) continue;
    if (isCreateOnlyFlag(m[0]) && !inCreateContext(text, m.index!, m[0])) continue;
    if (inTargetRepoContext(text, m.index!)) continue;
    const quoted = m[2] ?? m[3];
    const operand = quoted ?? m[4] ?? "";
    const isSite =
      quoted === undefined ? operand !== "" && !resolvedNonState(operand, consts) : operand.split(",").some((p) => p && operandIsSite(p, false));
    const line = text.slice(0, m.index!).split("\n").length;
    if (isSite && !seen.has(line)) {
      seen.add(line);
      sites.push(line);
    }
  }
  return sites.sort((a, b) => a - b);
}

/** Split `text` on top-level commas, honouring nesting and string literals. */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") cur += text[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
    } else if ("([{".includes(c)) {
      depth++;
      cur += c;
    } else if (")]}".includes(c)) {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Does this one-hop-resolved label expression make a site? (fail closed) */
function tsOperandIsSite(expr: string, consts: Map<string, string>): boolean {
  const e = expr.trim();
  const lit = /^["'`]([^"'`$]*)["'`]$/.exec(e);
  if (lit) return STATE_SET.has(lit[1]!);
  const board = /^ORCH_BOARD_LABELS\.(\w+)$/.exec(e);
  if (board) {
    const v = (ORCH_BOARD_LABELS as Record<string, string>)[board[1]!];
    return v === undefined ? true : STATE_SET.has(v);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(e) && consts.has(e)) return STATE_SET.has(consts.get(e)!);
  return true;
}

/** Is `name` also bound as a function parameter or destructured binding anywhere in the file? */
function isShadowedBinding(src: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  const destructure = new RegExp(`\\b(?:const|let|var)\\s*[{\\[][^=;]*(?<![\\w$])${n}(?![\\w$])[^=;]*[}\\]]\\s*=`);
  if (destructure.test(src)) return true;
  if (new RegExp(`(?<![\\w$.])${n}\\s*=>`).test(src)) return true; // bare single-parameter arrow
  const params = new RegExp(`\\(((?:[^()]|\\([^()]*\\))*(?<![\\w$.])${n}(?![\\w$])(?:[^()]|\\([^()]*\\))*)\\)\\s*(?::[^{=;]+)?(?:=>|\\{)`, "g");
  for (const m of src.matchAll(params)) {
    const before = src.slice(Math.max(0, m.index! - 8), m.index!);
    if (/\b(?:if|while|for|switch|catch|with)\s*$/.test(before)) continue; // control flow, not params
    return true;
  }
  return false;
}

/** Module-scope consts only (column 0); a name declared more than once anywhere is unresolvable. */
function collectConsts(src: string): Map<string, string> {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=]+)?\s*=\s*([^;\n]+)/gm)) {
    const name = m[1]!;
    const decls = src.match(new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\b`, "g"));
    if (decls && decls.length > 1) continue;
    if (isShadowedBinding(src, name)) continue;
    const rhs = m[2]!.trim();
    const lit = /^["'`]([^"'`$]*)["'`]$/.exec(rhs);
    if (lit) {
      consts.set(m[1]!, lit[1]!);
      continue;
    }
    const board = /^ORCH_BOARD_LABELS\.(\w+)$/.exec(rhs);
    if (board) {
      const v = (ORCH_BOARD_LABELS as Record<string, string>)[board[1]!];
      if (v !== undefined) consts.set(m[1]!, v);
    }
  }
  return consts;
}

const SEAM_FNS = ["addIssueLabel", "removeIssueLabel", "editIssueLabels"] as const;
const IDENT = "[A-Za-z_$][\\w$]*";
const escId = (n: string) => n.replace(/\$/g, "\\$");

/** End index of a `const x = <init>` initializer: `;` at depth 0, or a newline that does not continue the expression. */
function initializerEnd(src: string, start: number): number {
  let depth = 0;
  let quote = "";
  const limit = Math.min(src.length, start + 1500);
  for (let i = start; i < limit; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (--depth < 0) return i;
    } else if (c === ";" && depth === 0) return i;
    else if (c === "\n" && depth === 0) {
      const prev = src.slice(start, i).trimEnd();
      const next = src.slice(i).trimStart();
      if (!/(?:[?|&,:+(]|=>)$/.test(prev) && !/^[?|&.:]/.test(next)) return i;
    }
  }
  return limit;
}

/**
 * One-hop wrappers of the seam functions, file-wide: `import { F as x }`, or
 * `const|let|var x [: T] = <init>` whose initializer mentions F as a bare
 * reference or inside an arrow body (`=>` before `F(`). A direct call result
 * (`const r = await F(..)`) is not a wrapper. Returns wrapper name -> seam fn.
 */
function collectWrappers(src: string): Map<string, string> {
  const wrappers = new Map<string, string>();
  const reserved = new Set<string>(SEAM_FNS);
  for (const f of SEAM_FNS) {
    const imp = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*?(?<![\\w$])${f}\\s+as\\s+(${IDENT})`, "g");
    for (const m of src.matchAll(imp)) if (!reserved.has(m[1]!)) wrappers.set(m[1]!, f);
  }
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::(?:=>|[^=;])+?)?=(?![=>])`, "g");
  for (const m of src.matchAll(declRe)) {
    const name = m[1]!;
    if (reserved.has(name)) continue;
    const start = m.index! + m[0].length + (/^\s*/.exec(src.slice(m.index! + m[0].length))?.[0].length ?? 0);
    const init = src.slice(start, initializerEnd(src, start));
    const arrowAt = init.indexOf("=>");
    for (const f of SEAM_FNS) {
      // Bare alias: the whole initializer is `F`, `X ?? F`, `X || F` (optionally `as T`); object
      // shorthand / call-result bindings (`{ F }`, `xs.map(..F..)`) are not wrappers (#5367 QA).
      const bare = new RegExp(`^(?:\\(*[\\w$.]+\\)*\\s*(?:\\?\\?|\\|\\|)\\s*)*\\(*${f}\\)*(?:\\s+as\\s+[^;]+)?$`);
      const call = new RegExp(`(?<![\\w$])${f}\\s*(?:<[^()]*>)?\\s*(?:\\?\\.)?\\s*\\(`);
      const callAt = init.search(call);
      // Arrow wrapper: the initializer itself IS the arrow (params then `=>`), body calls F.
      // Strip `X ??` / `X ||` prefixes and wrapping parens: `deps.f ?? ((n, l) => F(n, l))` is a wrapper.
      let arrowInit = init.trim();
      for (;;) {
        const next = arrowInit.replace(/^[\w$.]+\s*(?:\?\?|\|\|)\s*/, "").replace(/^\((?=\s*(?:async\s*)?(?:\(|[\w$]+\s*(?::[^=]+?)?=>))/, "");
        if (next === arrowInit) break;
        arrowInit = next;
      }
      const isArrow = /^(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+?)?=>/.test(arrowInit);
      if (bare.test(init.trim()) || (isArrow && arrowAt !== -1 && callAt !== -1 && arrowAt < callAt)) {
        wrappers.set(name, f);
        break;
      }
    }
  }
  return wrappers;
}

/** Call grammar for `src/` and `scripts/*.ts`. Returns 1-based site line numbers (one per site). */
export function scanTsSites(source: string): number[] {
  const src = stripComments(source);
  const consts = collectConsts(src);
  const wrappers = collectWrappers(src);
  const sites: number[] = [];
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  // Seam fns match as member calls too (`gh.addIssueLabel(..)`); wrapper aliases are local
  // bindings, so `proc.run(a, b)` must NOT match a wrapper named `run` (#5367 QA).
  const seamNames = SEAM_FNS.map(escId).join("|");
  const wrapNames = [...wrappers.keys()].map(escId).join("|");
  const names = wrapNames ? `(?<![\\w$])(?:${seamNames})|(?<![\\w$.])(?:${wrapNames})` : `(?<![\\w$])(?:${seamNames})`;
  const callRe = new RegExp(`(${names})\\s*(?:<[^()]*>)?\\s*(?:\\?\\.)?\\s*\\(`, "g");
  for (const m of src.matchAll(callRe)) {
    if (/\bfunction\s+$/.test(src.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchParen(src, open);
    const args = splitTop(src.slice(open + 1, close === -1 ? undefined : close));
    const line = lineOf(m.index!);
    const second = (args[1] ?? "").trim();
    const wrapped = wrappers.get(m[1]!);
    if (wrapped !== undefined && args.length < 2) continue; // arity-changing wrapper: documented non-count
    const fn = wrapped ?? m[1]!;
    if (fn !== "editIssueLabels") {
      if (tsOperandIsSite(second, consts)) sites.push(line);
      continue;
    }
    if (!second.startsWith("{")) {
      sites.push(line); // pass-through object: unresolvable
      continue;
    }
    for (const prop of splitTop(second.replace(/^\{/, "").replace(/\}\s*$/, ""))) {
      const kv = /^\s*(add|remove)\s*:\s*([\s\S]*)$/.exec(prop);
      if (!kv) {
        // shorthand, spread, computed key or any other shape: unresolvable, fail closed
        if (prop.trim()) sites.push(line);
        continue;
      }
      const val = kv[2]!.trim();
      if (val.startsWith("[")) {
        for (const el of splitTop(val.replace(/^\[/, "").replace(/\]\s*$/, ""))) {
          if (tsOperandIsSite(el, consts)) sites.push(line);
        }
      } else sites.push(line);
    }
  }
  return sites;
}

/** Sites in one file (exempt paths and non-surfaces yield none). */
export function scanFileSites(relPath: string, text: string): number[] {
  if (isExemptPath(relPath)) return [];
  if (TS_LIKE_RE.test(relPath)) {
    // Call grammar plus the text grammar over comment-stripped source (argv-style `gh` shell-outs).
    // The call grammar counts per site; text-grammar lines it already covers are not double-counted.
    const calls = scanTsSites(text);
    const seen = new Set(calls);
    const stripped = stripComments(text);
    const extra = scanTextSites(stripped, collectConsts(stripped)).filter((l) => !seen.has(l));
    return [...calls, ...extra].sort((a, b) => a - b);
  }
  return scanTextSites(text);
}

// ---------------------------------------------------------------------------
// Tree walk + baseline ratchet
// ---------------------------------------------------------------------------

export interface FileSites {
  count: number;
  lines: number[];
}
export type Observed = Record<string, FileSites>;

const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", "dist"]);

const TS_LIKE_RE = /\.(?:ts|mts|cts|tsx|js|cjs|mjs)$/;

export function isSurface(rel: string): boolean {
  if (rel.startsWith("docs/operator-playbooks/") || rel.startsWith("docs/agents/")) {
    return rel.endsWith(".md");
  }
  if (rel.startsWith("src/")) return TS_LIKE_RE.test(rel);
  if (rel.startsWith("scripts/")) return TS_LIKE_RE.test(rel) || /\.(?:sh|py)$/.test(rel);
  return false;
}

async function walk(root: string, dir: string, out: string[], isScanRoot = false): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch (err) {
    // A missing scan root has no sites; any other failure must not fail open.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && isScanRoot) return;
    throw new Error(`[lifecycle-seam-check] cannot read dir ${dir}: ${String(err)}`, { cause: err });
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, rel, out);
    else if (e.isFile() && isSurface(rel)) out.push(rel);
  }
}

/** Walk the scan surfaces under `root` (fs walk, no git) and count sites per file. */
export async function scanLifecycleSeam(root: string = REPO_ROOT): Promise<Observed> {
  const files: string[] = [];
  for (const top of ["docs/operator-playbooks", "docs/agents", "src", "scripts"]) {
    await walk(root, top, files, true);
  }
  const observed: Observed = {};
  for (const rel of files.sort()) {
    if (isExemptPath(rel)) continue;
    let text: string;
    try {
      text = await readFile(join(root, rel), "utf8");
    } catch (err) {
      throw new Error(`[lifecycle-seam-check] cannot read ${rel}: ${String(err)}`, { cause: err });
    }
    const lines = scanFileSites(rel, text);
    if (lines.length > 0) observed[rel] = { count: lines.length, lines };
  }
  return observed;
}

/**
 * The lifecycle-seam ratchet on the Ratchet module: per-file count of direct
 * state-label write sites. Fix a failure by routing the transition through
 * `npx tsx scripts/lifecycle.ts advance <issue> <to> [--evidence k=v]
 * [--reason R --rationale T]`, never by raising a row.
 */
export const lifecycleSeamRatchet = defineRatchet({
  id: "lifecycle-seam-check",
  baseline: LIFECYCLE_SEAM_BASELINE_REL,
  shape: "counted",
  polarity: "ceiling",
  stale: "fail",
  enforcement: "required",
  async measure(root) {
    const rows: Record<string, number> = {};
    for (const [file, { count }] of Object.entries(await scanLifecycleSeam(root))) rows[file] = count;
    return rows;
  },
});

runIfCli(import.meta.url, lifecycleSeamRatchet);
