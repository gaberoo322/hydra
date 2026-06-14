// ---------------------------------------------------------------------------
// MergedAnchorRefs — the shared merged-by-cycle suppression Seam (issue #882).
// ---------------------------------------------------------------------------
//
// Extracted from `src/anchor-candidates.ts` (issue #1880). This module is pure
// infrastructure shared across two consumers that are NOT each other's owner:
//
//   1. The Candidate Feed (`src/anchor-candidates.ts`) — its eligibility filter
//      suppresses any candidate whose work already MERGED.
//   2. The WorkQueueHygiene reconciler (`reconcileWorkQueue`, currently still in
//      `anchor-candidates.ts`; slated for `src/backlog/work-queue-hygiene.ts`
//      per #1844) — it REMOVES merged-work entries from the work queue.
//
// Because the MergedRefs concern is owned by neither consumer exclusively, its
// neutral home is here, a sibling to `src/backlog/reconciler.ts`. Both consumers
// import the loader type (`MergedAnchorRefsLoader`) and the production loader
// (`loadMergedAnchorRefsImpl`) from this one location; neither needs to know the
// other shares the scan.
//
// The Seam owns: the `gh pr list --state merged` scan on both repos, the TTL
// cache, and the normalized identity-token algebra (`mergedTokensFromPr`,
// `candidateMergedTokens`, `isMergedWork`). Every public helper is pure (or a
// never-throws degrade-to-empty loader) so the suppression logic is unit-
// testable in isolation (`test/backlog-merged-refs.test.mts`).

import { getTargetGithubRepo } from "../target-config.ts";
import { execFileViaSeam } from "../github/exec-file-compat.ts";

// Merged-by-cycle suppression (issue #882). The in-flight window in the
// Candidate Feed hides anchors with a *fresh, still-open* PR claim, but a claude
// dev-cycle that merges its work leaves NO lingering open PR — the
// `claimedBy = "pr-<n>"` marker is on a closed/merged PR, or the work merged via
// a target-tree commit with no kanban claim at all. Those shipped items kept
// resurfacing at the top of the feed (score 0.85), starving dev_target and
// tricking research into re-promoting completed work. We suppress any candidate
// whose identity matches a recently-MERGED PR (orchestrator OR target repo). The
// lookback window is wide enough to cover the period a stale work-queue / kanban
// entry can linger after its work shipped, but bounded so the merged-PR scan
// stays cheap.
const MERGED_LOOKBACK_DAYS = 30;
// How many recent merged PRs to scan per repo. The maker-stack staleness in
// #882 surfaced from items merged within the last few dozen PRs; 100 gives a
// comfortable margin without an unbounded `gh` page walk.
const MERGED_PR_SCAN_LIMIT = 100;
// TTL-bounded cache for the merged-PR scan (issue #882, QA remediation). The
// route `/api/anchor/candidates` is on the decide.py hot path; without a cache
// every request shelled out to `gh pr list` twice (once per repo, 15s timeout
// each) synchronously. A 60s in-memory TTL collapses the burst of polls a
// single decide.py tick fires into one scan while still picking up freshly
// merged PRs within a minute. Mirrors the `CACHE_TTL_MS` idiom in
// `src/cost/usage-tracker.ts`. The merged set is small (token strings) and the
// staleness window is bounded, so an in-memory cache is safe across requests.
const MERGED_SCAN_CACHE_TTL_MS = 60_000;

// The production default routes the merged-PR scan through the GitHub CLI
// Adapter seam (issue #899). The `exec` parameter on makeMergedAnchorRefsLoader
// remains the injectable test seam — this only changes the default.
const execFile = execFileViaSeam;

// The orchestrator's own repo. A literal is fine here — Hydra IS this repo, so
// it is not a swappable target (mirrors `ORCHESTRATOR_REPO` in
// `src/autopilot/pr-lifecycle-bridge.ts`). The TARGET repo, by contrast, MUST
// resolve through the swap seam (`getTargetGithubRepo()`) per ADR-0013.
const ORCHESTRATOR_REPO = "gaberoo322/hydra";

/**
 * Repos whose merged PRs can ship a candidate's work. The orchestrator board
 * (`dev_orch`) and the target board (`dev_target`) both feed the candidate
 * feed, so both repos are scanned (issue #882: "applies to both orch and
 * target candidate surfaces"). Resolved at CALL TIME — the target repo flows
 * through the `target-config.ts` swap seam (ADR-0013/ADR-0002) rather than a
 * hardcoded literal, so the merged-scan follows a target swap. Mirrors
 * `defaultRepos()` in `src/autopilot/pr-lifecycle-bridge.ts`.
 */
function mergedScanRepos(): readonly string[] {
  return [ORCHESTRATOR_REPO, getTargetGithubRepo()];
}

/**
 * Pure helper — exported for tests. Build the normalized identifier token-set
 * a merged PR contributes to the suppression set. A candidate is suppressed
 * when ANY of its identity tokens (see `candidateMergedTokens`) intersects this
 * set. We harvest:
 *   - every `#NNN` issue reference in the PR title + body (so a `Closes #882`
 *     marks issue 882's anchor merged),
 *   - every `item-NNN` reference (the target work-queue identity),
 *   - the normalized PR title itself (so a kanban anchor whose title equals the
 *     PR title is caught even without an explicit issue ref).
 */
export function mergedTokensFromPr(title: string, body: string): string[] {
  const tokens = new Set<string>();
  const haystack = `${title || ""}\n${body || ""}`;
  for (const m of haystack.matchAll(/#(\d+)\b/g)) tokens.add(m[1]);
  for (const m of haystack.matchAll(/\bitem-(\d+)\b/gi)) tokens.add(`item-${m[1]}`);
  const normTitle = normalizeIdentity(title);
  if (normTitle) tokens.add(normTitle);
  return [...tokens];
}

/**
 * Pure helper — exported for tests. Normalize a free-text identity for
 * comparison: lowercase, collapse whitespace, trim. Mirrors
 * `normalizeForDedup` in the work-queue adapter so the two dedup surfaces stay
 * consistent.
 */
export function normalizeIdentity(s: string): string {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Pure helper — exported for tests. Derive the identity tokens a candidate
 * matches against the merged-set. A candidate is "merged work" when any of
 * these is present in the merged-token set:
 *   - its `issue` field as a bare string (orchestrator issue number),
 *   - any `item-NNN` reference found in its issue/title/anchorRef,
 *   - its normalized title / anchorRef.
 */
export function candidateMergedTokens(c: {
  issue: string | number;
  title: string;
  anchorRef: string;
}): string[] {
  const tokens = new Set<string>();
  const issueStr = String(c.issue ?? "").trim();
  // A bare numeric issue id (kanban anchor) matches a `#NNN` merge ref.
  if (/^\d+$/.test(issueStr)) tokens.add(issueStr);
  const fields = [issueStr, c.title || "", c.anchorRef || ""];
  for (const f of fields) {
    for (const m of f.matchAll(/\bitem-(\d+)\b/gi)) tokens.add(`item-${m[1]}`);
    const norm = normalizeIdentity(f);
    if (norm) tokens.add(norm);
  }
  return [...tokens];
}

/**
 * Pure helper — exported for tests. True when the candidate's identity tokens
 * intersect the merged-work token set. Empty merged-set → never suppresses.
 */
export function isMergedWork(
  c: { issue: string | number; title: string; anchorRef: string },
  mergedRefs: ReadonlySet<string>,
): boolean {
  if (mergedRefs.size === 0) return false;
  for (const tok of candidateMergedTokens(c)) {
    if (mergedRefs.has(tok)) return true;
  }
  return false;
}

/**
 * TTL-bounded cache entry for the merged-PR scan (issue #882 QA remediation).
 * `null` until the first successful-or-empty scan. We cache the resolved token
 * set plus the wall-clock time it was stored so a burst of decide.py polls
 * within `MERGED_SCAN_CACHE_TTL_MS` reuses one `gh` round-trip.
 */
interface MergedScanCacheEntry {
  refs: Set<string>;
  storedAt: number;
}

/**
 * A merged-refs loader: scans recent merged PRs and returns the suppression
 * token set, TTL-caching the result. `nowMs` defaults to `Date.now()`; pass an
 * explicit clock for deterministic tests.
 */
export type MergedAnchorRefsLoader = (nowMs?: number) => Promise<Set<string>>;

/**
 * Factory for the production merged-refs reader (issue #882 / #1834
 * state-locality refactor). Builds a loader that scans recent merged PRs on
 * both the orchestrator and target repos via `gh pr list --state merged`,
 * harvesting the normalized identity tokens each PR ships
 * (`mergedTokensFromPr`). Never throws — a `gh` failure on one repo logs and
 * contributes nothing; total failure yields an empty set (suppress nothing),
 * exactly degrading to the pre-#882 behaviour on a miss.
 *
 * The TTL cache lives in THIS closure, not in module scope (#1834). A fresh
 * cache entry (younger than `MERGED_SCAN_CACHE_TTL_MS`) short-circuits the `gh`
 * shell-out so the hot `/api/anchor/candidates` path doesn't fork `gh` on every
 * request. Production wires one long-lived instance (`loadMergedAnchorRefsImpl`)
 * as the default `loadMergedAnchorRefs` dep; each call to this factory yields a
 * loader with its OWN cold cache, so tests get isolation by constructing a
 * fresh loader instead of resetting shared module state.
 *
 * The `exec` parameter is the injectable seam so the TTL-cache behaviour is
 * unit-testable without forking a real `gh`.
 */
export function makeMergedAnchorRefsLoader(
  exec: typeof execFile = execFile,
): MergedAnchorRefsLoader {
  // Cache is closure-local: a burst of polls within the TTL reuses one scan,
  // but no module-level state leaks across unrelated tests.
  let cache: MergedScanCacheEntry | null = null;

  return async function loadMergedAnchorRefs(
    nowMs: number = Date.now(),
  ): Promise<Set<string>> {
    if (cache && nowMs - cache.storedAt < MERGED_SCAN_CACHE_TTL_MS) {
      return cache.refs;
    }

    const merged = new Set<string>();
    // gh's --search uses GitHub's `merged:>=YYYY-MM-DD` qualifier.
    const since = new Date(nowMs - MERGED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (const repo of mergedScanRepos()) {
      try {
        const { stdout } = await exec(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "merged",
            "--search",
            `merged:>=${since}`,
            "--limit",
            String(MERGED_PR_SCAN_LIMIT),
            "--json",
            "title,body",
          ],
          { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
        );
        for (const tok of mergedTokensFromGhJson(stdout)) merged.add(tok);
      } catch (err: any) {
        console.error(
          `[CandidateFeed] merged-PR scan failed for ${repo}: ${err?.message || err}`,
        );
      }
    }
    // Cache even an empty/degraded result: a `gh` outage should not be retried
    // on every hot-path request within the TTL window. The set self-heals on
    // the next scan after the TTL expires.
    cache = { refs: merged, storedAt: nowMs };
    return merged;
  };
}

/**
 * Production merged-refs reader — the single long-lived default loader wired
 * into `CandidateFeedDeps.loadMergedAnchorRefs` and `reconcileWorkQueue`. Its
 * TTL cache is the module's only merged-scan cache, contained inside the
 * factory closure above (no module-level mutable state, no test-reset hook).
 */
export const loadMergedAnchorRefsImpl: MergedAnchorRefsLoader =
  makeMergedAnchorRefsLoader();

/**
 * Pure helper — exported for tests. Parse a `gh pr list --json title,body`
 * payload into the union of merged-identity tokens. Returns [] on any
 * structural problem (never throws).
 */
export function mergedTokensFromGhJson(jsonStdout: string): string[] {
  if (!jsonStdout || !jsonStdout.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStdout);
  } catch {
    /* intentional: malformed gh JSON → [] per the documented never-throws contract */
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = new Set<string>();
  for (const pr of parsed) {
    if (!pr || typeof pr !== "object") continue;
    const title = typeof (pr as any).title === "string" ? (pr as any).title : "";
    const body = typeof (pr as any).body === "string" ? (pr as any).body : "";
    for (const tok of mergedTokensFromPr(title, body)) out.add(tok);
  }
  return [...out];
}
