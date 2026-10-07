/**
 * Shared inter-issue blocker seam (issue #3059).
 *
 * Two responsibilities, extracted so BOTH the `/hydra-review` stale-blocked
 * aggregator (`src/review-pickup.ts`) and the autopilot board-state dispatch
 * filter (`src/api/autopilot-board.ts`) read from ONE place:
 *
 *   1. {@link extractStrictBlockerRefs} — a STRICT body parser that pulls the
 *      `#N` numbers an issue declares it is *blocked by* / *depends on*. Unlike
 *      the loose `extractIssueRefs` (which returns every `#N` mention), this
 *      only matches anchored `blocked by #N` / `blocks #N` / `depends on #N`
 *      conventions. A false positive here silently STARVES real work
 *      (a bare `#N` "see also" reference would wrongly gate dispatch), so the
 *      dispatch filter must use the strict form. Code-span-safe: `#N` inside a
 *      backtick span is ignored (same guard as `extractIssueRefs`).
 *
 *   2. {@link fetchOpenBlockerNumbers} — a single batched `gh issue list`
 *      open/closed resolver over the union of referenced numbers (one extra
 *      round-trip, not one per issue), hoisted verbatim from
 *      `review-pickup.ts`. Its FAIL-SAFE default is load-bearing and shared: on
 *      a lookup FAILURE it returns the full requested set (treat every
 *      referenced blocker as still-OPEN). For review-pickup that yields FEWER
 *      stale-blocked notifications; for the dispatch filter that WAITS a tick
 *      rather than dispatching onto an unmerged blocker. One resolver, one
 *      conservative behavior in both consumers.
 *
 * Pure/leaf: the only external touchpoint is the injected reader in
 * {@link OpenBlockerLookupDeps}; the parsing and set math are pure and
 * golden-fixture testable without a live `gh`.
 */

import {
  listIssuesBySearch,
  isIssueReadFailure,
  type IssueRow,
} from "./issues.ts";

// ---------------------------------------------------------------------------
// Strict blocker-ref parser
// ---------------------------------------------------------------------------

/**
 * The strict blocker conventions. Two anchored patterns only:
 *
 *   - `blocked by #N` / `blocked-by #N` / `blocks #N` / `blocked #N`
 *     (epic-close's `blockedBy` regex, reused verbatim — see
 *     `scripts/ci/epic-close.ts`).
 *   - `depends on #N` / `depends-on #N` / `depend on #N` / `dependent on #N`.
 *
 * A bare `#N` (a "see also", a "part of", an incidental mention) deliberately
 * does NOT match — it must not gate dispatch.
 */
/**
 * The strict-blocker regex pattern SOURCES — the **single source of truth** for
 * "what counts as a strict blocker ref". Reused verbatim from
 * `scripts/ci/epic-close.ts` (`parseEpicReferences`).
 *
 * Exported (issue #3965) because the autopilot's anchor-SELECTION path
 * (`scripts/autopilot/collect-state.sh`) must apply the SAME predicate the
 * anchor-COUNT path (`src/autopilot/board-state.ts::hasOpenStrictBlocker`)
 * uses — "do not write a second parser". collect-state.sh has no TypeScript
 * bridge, so its candidate exclusion mirrors these patterns in python; the
 * export gives `test/board-state.test.mts` a stable, named anchor to pin the
 * python port against (a byte-identical drift guard + a behavioural-parity
 * check on a golden fixture). One predicate, two call sites, machine-checked
 * for drift.
 *
 * Each entry is a plain regex SOURCE string (no flags); the {@link gi} flags
 * are applied once, below, when the compiled {@link STRICT_BLOCKER_PATTERNS} is
 * derived. Do not inline a second copy elsewhere — extend this array.
 */
export const STRICT_BLOCKER_PATTERN_SOURCES: readonly string[] = [
  "\\bblock(?:ed|s)?(?:[\\s-]+by)?\\s*:?\\s*#(\\d+)",
  "\\bdepend(?:s|ent)?(?:[\\s-]+on)?\\s*:?\\s*#(\\d+)",
];

const STRICT_BLOCKER_PATTERNS: RegExp[] = STRICT_BLOCKER_PATTERN_SOURCES.map(
  (src) => new RegExp(src, "gi"),
);

/**
 * The declared-Epic marker pattern SOURCES (issue #4823) — the **single source
 * of truth** for "which `#N` does this body declare as its own Epic (parent)".
 * Exactly three anchored, case-insensitive forms (nothing else — `part of #N`,
 * `see #N`, `follow-up of #N` — counts):
 *
 *   (a) a markdown heading line `## Parent` / `## Parent epic` (any heading
 *       level) followed — after optional blank lines and an optional `-` / `*`
 *       bullet — by `#N` (the hydra-prd `renderChildBody` shape);
 *   (b) inline `Parent: #N` / `Parent epic: #N`;
 *   (c) `Child of #N` (the Target child-issue shape, e.g. claw-street-bets
 *       #200-#205 `Child of #194`).
 *
 * An Epic stays open until its children close, so an Epic ref can never be a
 * satisfiable dispatch blocker: gating a child on it is a logical cycle that
 * starves the lane permanently (membership is not ordering).
 *
 * Exported for the same reason as {@link STRICT_BLOCKER_PATTERN_SOURCES}: the
 * anchor-SELECTION mirror in `scripts/autopilot/collect-state.sh` spells these
 * in python (`PARENT_PATTERNS`) and `test/board-state.test.mts` pins the port
 * byte-identically. Plain regex SOURCE strings (no flags; `gi` is applied
 * below) — line anchoring is spelled `(?:^|\n)` so no multiline flag is needed
 * and the python port needs only IGNORECASE.
 */
export const PARENT_REF_PATTERN_SOURCES: readonly string[] = [
  "(?:^|\\n)[ \\t]*#{1,6}[ \\t]+parent(?:[ \\t]+epic)?[ \\t]*\\r?\\n(?:[ \\t]*\\r?\\n)*[ \\t]*(?:[-*][ \\t]+)?#(\\d+)",
  "(?:^|\\n)[ \\t]*(?:[-*][ \\t]+)?parent(?:[ \\t]+epic)?[ \\t]*:[ \\t]*#(\\d+)",
  // Form (c) is SENTENCE-anchored (issue #4880): line start, or after sentence
  // punctuation (+ optional closing ** / __). Rejects negations such as
  // "Not a child of #194; blocked by #194." while keeping the mid-line
  // producer shape "**Follow-up of #202 (...).** Child of #194 (M5)."
  "(?:^|\\n|[.!?](?:\\*\\*|__)?[ \\t]+)[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*|__)?child[ \\t]+of[ \\t]+#(\\d+)",
];

const PARENT_REF_PATTERNS: RegExp[] = PARENT_REF_PATTERN_SOURCES.map(
  (src) => new RegExp(src, "gi"),
);

/**
 * Pull the `#N` refs a body DECLARES as its Epic ({@link
 * PARENT_REF_PATTERN_SOURCES}), deduped, code-span-safe. `[]` for an
 * empty/absent body. Pure.
 */
function extractDeclaredEpicRefs(
  body: string | null | undefined,
): number[] {
  return scanRefs(body, PARENT_REF_PATTERNS);
}

/**
 * Pull the STRICT blocker `#N` refs from a markdown body — the numbers this
 * issue declares it is blocked by / depends on, deduped, in order of first
 * appearance, MINUS every ref the SAME body declares as its Epic (issue #4823,
 * {@link extractDeclaredEpicRefs}). A non-Epic strict ref in the same body
 * still gates. The subtraction lives HERE (not in a second helper) so every
 * consumer — the board count path, the /work projection, the promote gate, the
 * blocker resolver — agrees by construction. Code-span-safe (`#N` inside a
 * backtick span is ignored); `[]` for an empty/absent body. Pure — a
 * golden-fixture unit under `test/`.
 */
export function extractStrictBlockerRefs(
  body: string | null | undefined,
): number[] {
  const epics = new Set(extractDeclaredEpicRefs(body));
  return scanRefs(body, STRICT_BLOCKER_PATTERNS).filter((n) => !epics.has(n));
}

function scanRefs(
  body: string | null | undefined,
  patterns: readonly RegExp[],
): number[] {
  if (!body) return [];
  // Strip backtick code spans first — `#1234` inside `code` is not a ref.
  const stripped = body.replace(/`[^`]*`/g, "");

  const seen = new Set<number>();
  const out: number[] = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const n = Number.parseInt(m[1], 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batched open/closed resolver (hoisted from review-pickup.ts)
// ---------------------------------------------------------------------------

export interface OpenBlockerLookupDeps {
  /** GitHub repo handle (`owner/name`) override. Defaults to the seam default. */
  githubRepo?: string;
  /**
   * The open/closed lookup uses the *discriminated* (failure-aware) reader, not
   * an *OrEmpty variant: on a lookup FAILURE we must conservatively treat every
   * referenced blocker as still-open. Tests inject this to avoid spawning `gh`.
   */
  listIssuesBySearch?: typeof listIssuesBySearch;
}

/**
 * Resolve which of the given issue numbers are currently OPEN. Batches into a
 * single `--state open --search "<n1> <n2> ..."` query through the seam's
 * *discriminated* reader.
 *
 * FAIL-SAFE default (shared by both consumers): on a lookup FAILURE this
 * returns the full requested set (treat every referenced blocker as still-OPEN)
 * so a transient `gh` outage never flips the conservative direction — fewer
 * stale-blocked notifications for review-pickup, a waited tick for the dispatch
 * filter.
 */
export async function fetchOpenBlockerNumbers(
  numbers: number[],
  deps: OpenBlockerLookupDeps = {},
): Promise<Set<number>> {
  if (numbers.length === 0) return new Set();
  const search = numbers.map((n) => `${n}`).join(" ");
  const read = deps.listIssuesBySearch ?? listIssuesBySearch;
  const res = await read(search, { state: "open", repo: deps.githubRepo });
  if (isIssueReadFailure(res)) {
    console.error(`[blockers] open-blocker lookup failed (${res.code})`);
    // Conservative: treat all referenced blockers as open.
    return new Set(numbers);
  }
  return openNumbersFromRows(res.rows, numbers);
}

/**
 * Pure helper — from the seam's {@link IssueRow} rows of an open-state number
 * search, return the subset of `requested` numbers reported open. Intersecting
 * with `requested` guards against the search matching unrelated issues that
 * merely mention the number.
 */
export function openNumbersFromRows(
  rows: readonly IssueRow[],
  requested: number[],
): Set<number> {
  const requestedSet = new Set(requested);
  const open = new Set<number>();
  for (const row of rows) {
    if (requestedSet.has(row.number)) open.add(row.number);
  }
  return open;
}

// ---------------------------------------------------------------------------
// Blocker CLEARANCE verdict (issue #4806)
// ---------------------------------------------------------------------------
//
// The one predicate behind autopilot Phase 1.5's "may this stale `blocked`
// issue be promoted?" question (`scripts/autopilot/blockers-cleared.ts`). It
// reuses the strict parser above — no second regex — and is conservative in
// every direction: an unresolvable ref, a failed read, or an issue with no
// strict blocker ref at all holds the issue.

/**
 * Blocker refs for the clearance verdict: the strict-parser refs PLUS every
 * `#N` on any body line that itself carries a strict blocker match (so
 * `Blocked by #100 and #101` yields both). A `#N` on any other line (the
 * `## Parent` epic, see-also mentions, ADR PR mentions) is NOT a blocker.
 * `self` is excluded. Code spans are ignored. Deduped, first-appearance order.
 */
export function extractClearanceBlockerRefs(
  body: string | null | undefined,
  self?: number,
): number[] {
  if (!body) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (n: number) => {
    if (!Number.isFinite(n) || n <= 0 || n === self || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  for (const n of extractStrictBlockerRefs(body)) add(n);
  const stripped = body.replace(/`[^`]*`/g, "");
  for (const line of stripped.split("\n")) {
    const hit = STRICT_BLOCKER_PATTERN_SOURCES.some((src) =>
      new RegExp(src, "i").test(line),
    );
    if (!hit) continue;
    for (const m of line.matchAll(/#(\d+)/g)) add(Number.parseInt(m[1], 10));
  }
  return out;
}

/** How a single referenced number resolved. Only `closed` / `merged` clear. */
export type BlockerRefState = "closed" | "merged" | "open" | "unknown";

export interface BlockedIssueVerdict {
  issue: number;
  /** Blocker numbers confirmed closed-issue / merged-PR (non-empty when promotable). */
  cleared: number[];
}

export interface ClearanceDeps {
  /** Read an issue body; `null` = unreadable (holds the issue). */
  readBody: (issue: number) => Promise<string | null>;
  /** Batched open-issue lookup; defaults to {@link fetchOpenBlockerNumbers}. */
  fetchOpen?: (numbers: number[]) => Promise<Set<number>>;
  /** Per-ref confirmation read (issue OR PR). */
  resolveRef: (n: number) => Promise<BlockerRefState>;
  /** Files-in-scope precondition (src/scope-section.ts `hasScopeSection`). */
  hasScope: (body: string) => boolean;
}

/**
 * From a list of `blocked` issue numbers, return those whose blockers are ALL
 * confirmed cleared (closed issue or merged PR), that have at least one
 * blocker ref, and whose body carries a parseable `## Files in scope`.
 *
 * Fail-safe: a failed body read, a failed batched open-issue search (the
 * resolver reports every ref open), an unresolvable ref, or a cross-repo
 * `owner/repo#N` blocker ref (resolved against the wrong repo otherwise) holds
 * the issue — it never promotes on uncertainty, and a throwing dependency is
 * caught, logged, and treated as "promote nothing".
 */
export async function findClearedBlockedIssues(
  issues: number[],
  deps: ClearanceDeps,
): Promise<BlockedIssueVerdict[]> {
  try {
    return await findClearedBlockedIssuesUnguarded(issues, deps);
  } catch (err) {
    console.error("[blockers] clearance verdict failed — promoting nothing:", err);
    return [];
  }
}

/** True when a blocker-bearing body line carries a cross-repo `owner/repo#N` ref. */
export function hasCrossRepoBlockerRef(body: string): boolean {
  const stripped = body.replace(/`[^`]*`/g, "");
  return stripped.split("\n").some(
    (line) =>
      /[\w.-]+\/[\w.-]+#\d+/.test(line) &&
      STRICT_BLOCKER_PATTERN_SOURCES.some((src) => new RegExp(src, "i").test(line)),
  );
}

async function findClearedBlockedIssuesUnguarded(
  issues: number[],
  deps: ClearanceDeps,
): Promise<BlockedIssueVerdict[]> {
  const bodies = new Map<number, string>();
  const refsByIssue = new Map<number, number[]>();
  for (const issue of issues) {
    const body = await deps.readBody(issue);
    if (body === null) {
      console.error(`[blockers] issue #${issue}: body unreadable — holding`);
      continue;
    }
    if (hasCrossRepoBlockerRef(body)) {
      console.error(`[blockers] issue #${issue}: cross-repo blocker ref — holding`);
      continue;
    }
    const refs = extractClearanceBlockerRefs(body, issue);
    if (refs.length === 0) continue; // epic parent: parked on purpose
    bodies.set(issue, body);
    refsByIssue.set(issue, refs);
  }
  const union = [...new Set([...refsByIssue.values()].flat())];
  if (union.length === 0) return [];

  const fetchOpen = deps.fetchOpen ?? ((ns: number[]) => fetchOpenBlockerNumbers(ns));
  const open = await fetchOpen(union);

  const resolved = new Map<number, BlockerRefState>();
  for (const n of union) {
    if (open.has(n)) {
      resolved.set(n, "open");
      continue;
    }
    resolved.set(n, await deps.resolveRef(n));
  }

  const out: BlockedIssueVerdict[] = [];
  for (const [issue, refs] of refsByIssue) {
    const states = refs.map((n) => resolved.get(n) ?? "unknown");
    if (!states.every((s) => s === "closed" || s === "merged")) continue;
    if (!deps.hasScope(bodies.get(issue) ?? "")) continue;
    out.push({ issue, cleared: refs });
  }
  return out;
}
