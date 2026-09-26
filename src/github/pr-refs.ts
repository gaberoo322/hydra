/**
 * src/github/pr-refs.ts — the PR-ref detection predicate, ported from
 * `scripts/autopilot/pr-refs.py` (ADR-0040 Decision 4 row 6, Decision 5;
 * wayfinder #4517, issue #4683).
 *
 * `pr-refs.py` is the ONE reference-detection predicate the bash autopilot
 * lane (`collect-state.sh`, `recover-stale.sh`) and `reap.py` share — see its
 * own docstring for the full history. This module ports the same three
 * regexes and three matcher semantics into TypeScript for the two
 * `scripts/ci/*.ts` consumers (`epic-close.ts`, `design-concept-reconcile-check.ts`)
 * that previously hand-rolled their own copy of the closing-verb alternation.
 * `pr-refs.py` itself is NOT edited or replaced — it stays the bash-facing
 * predicate until #4686/#4688 give the bash lane a TS-backed path. This
 * module and the Python script are two independent implementations kept in
 * sync by a source-string parity test (`test/github-pr-refs.test.mts`, the
 * #3965 convention already used for `STRICT_BLOCKER_PATTERN_SOURCES` vs the
 * `collect-state.sh` jq literal): a change to either side alone fails the
 * test.
 *
 * # Family membership (CONTEXT.md: GitHub CLI Adapter)
 *
 * This module joins the `src/github/*` family as a PURE predicate sibling of
 * `src/github/blockers.ts` — no `gh`/`git` spawn, no import of
 * `src/github/exec.ts`. It is a leaf: stdin-shaped rows in, `ReadonlySet<number>`
 * out, nothing else.
 *
 * # Purity contract
 *
 * No `node:fs` / `node:child_process` / `fetch` / `process.env`, no
 * module-scope side effects beyond regex construction, no classes. Every
 * export is a pure function or a constant. No function throws on a row with
 * null/undefined/missing `headRefName`, `body`, or `title` — such a row
 * simply contributes nothing to the result.
 */

/**
 * The GitHub closing-verb alternation — close/fix/resolve, any tense — as a
 * bare regex-alternation fragment (no `\b`, no anchors, no flags). This is
 * the SINGLE TypeScript home for the verb list: `BODY_RE` and `CLOSE_RE`
 * below compose it, and the two `scripts/ci/*.ts` consumers import this
 * constant and compose their OWN existing tail (differing at the edges —
 * `\b` placement, `\s*` vs `\s+`) so each file's resulting `.source` stays
 * byte-identical to the inline literal it replaces.
 */
export const CLOSING_VERB_ALTERNATION = "close[sd]?|fix(?:e[sd])?|resolve[sd]?";

/**
 * `issue-<N>` head-branch prefix (hydra-dev's branch-naming convention; the
 * `-<slug>` tail is optional). `\b` after the digits stops `issue-385`
 * matching branch `issue-3852-foo`. No flags — mirrors `pr-refs.py`'s
 * `_BRANCH_RE`, which anchors via `re.match` (start-of-string) rather than a
 * `^` in the pattern source; {@link branchRef} reproduces that anchoring by
 * requiring `match.index === 0`.
 */
export const BRANCH_RE = /issue-(\d+)\b/;

/**
 * PR-body keyword refs: a GitHub closing verb OR the non-closing `Ref(s) #N`
 * form. Case-insensitive, global (consumed only via `matchAll`, never an
 * `.exec` loop, so the constant's `lastIndex` never advances). Mirrors
 * `pr-refs.py`'s `_BODY_RE`.
 */
export const BODY_RE = new RegExp(
  String.raw`\b(?:${CLOSING_VERB_ALTERNATION}|refs?)\s*:?\s+#(\d+)\b`,
  "gi",
);

/**
 * Closing-verb-only subset of {@link BODY_RE} — deliberately excludes the
 * non-closing `Ref(s) #N` form and never matches on branch name alone.
 * Mirrors `pr-refs.py`'s `_CLOSE_RE`.
 */
export const CLOSE_RE = new RegExp(
  String.raw`\b(?:${CLOSING_VERB_ALTERNATION})\s*:?\s+#(\d+)\b`,
  "gi",
);

/**
 * A `(#N)` anchor in a PR title — the `(#4236)`/`(#4130)` shape the GLM
 * drainer's `issue_has_merged_pr` jq rule also recognises. Global (consumed
 * only via `matchAll`).
 */
export const TITLE_ANCHOR_RE = /\(#(\d+)\)/g;

/**
 * The structural subset of a PR row this module needs. `PrRow` from
 * `src/github/prs.ts` satisfies this unchanged (its `body` field, when
 * absent, is simply not present — every field here is optional). No new
 * adapter type, no JSON parsing: parsing stays at the seam (`parsePrRows`).
 */
export interface PrRefRow {
  headRefName?: string | null;
  body?: string | null;
  title?: string | null;
}

/** The issue number one row references via its head-branch name, or `null`. */
function branchRef(row: PrRefRow): number | null {
  const headRefName = row.headRefName ?? "";
  const m = BRANCH_RE.exec(headRefName);
  if (!m || m.index !== 0) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Every positive-integer capture group 1 match of a global `re` over `text`. */
function matchAllNumbers(re: RegExp, text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

/**
 * The union of both evidence channels: the `issue-<N>` head-branch
 * convention OR a body keyword ref (closing verb or `Refs #N`). Mirrors
 * `pr-refs.py`'s `referenced_issues()`.
 */
export function referencedIssues(prs: readonly PrRefRow[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const pr of prs) {
    const b = branchRef(pr);
    if (b !== null) out.add(b);
    for (const n of matchAllNumbers(BODY_RE, pr.body ?? "")) out.add(n);
  }
  return out;
}

/**
 * Issue numbers an open PR ACTUALLY CLOSES — `CLOSE_RE` over the body ONLY
 * (never the branch name, never `Refs #N`). Mirrors `pr-refs.py`'s
 * `closing_issues()`.
 */
export function closedIssues(prs: readonly PrRefRow[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const pr of prs) {
    for (const n of matchAllNumbers(CLOSE_RE, pr.body ?? "")) out.add(n);
  }
  return out;
}

/**
 * Issue numbers a (typically MERGED) PR references via a closing verb over
 * `title + body`, UNION a `(#N)` title anchor. This is the drainer's
 * `issue_has_merged_pr` rule (ADR-0040 Decision 4 row 7), consumed later by
 * #4686/#4687/#4690.
 */
export function mergedPrReferences(prs: readonly PrRefRow[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const pr of prs) {
    const combined = `${pr.title ?? ""}\n${pr.body ?? ""}`;
    for (const n of matchAllNumbers(CLOSE_RE, combined)) out.add(n);
    for (const n of matchAllNumbers(TITLE_ANCHOR_RE, pr.title ?? "")) out.add(n);
  }
  return out;
}
