/**
 * pr-lifecycle-snapshot.ts — the **pure** snapshot/differ grammar behind the
 * PR-lifecycle bridge (issue #673, extracted #2239).
 *
 * # Why this module exists
 *
 * Split out of `src/autopilot/pr-lifecycle-bridge.ts` so the bridge's three
 * concerns live at separated seams:
 *
 *   1. **Snapshot diffing + projection** (this module) — pure: given two
 *      plain-object snapshot maps it returns the transition events that fired,
 *      and given a read-seam {@link PrRow} it projects the bridge's snapshot
 *      view. No `gh`, no EventBus, no timer, no Redis.
 *   2. **`gh` CLI read** — `defaultGhFetcher` in the bridge (I/O-bound).
 *   3. **Timer lifecycle + stream emission** — `startPrLifecycleBridge` /
 *      `emitPrLifecycleEvent` in the bridge.
 *
 * The extraction mirrors the `run-projections.ts` / `runs.ts` write-vs-read
 * split (#1183) the codebase already uses to tame the `autopilot/runs.ts`
 * lifecycle/projection mix: the pure derivation surface gets its own named
 * home so tests can pin it with plain inputs — no subprocess stub, no EventBus
 * stub.
 *
 * This module is the canonical home for every pure snapshot/differ symbol.
 * Callers (the bridge, tests) import from here directly — there is no
 * back-compat re-export relay through the bridge (the precedent's relay was
 * retired in #2125; do not reintroduce one here).
 */

import type { PrRow } from "../github/issues.ts";

export interface PullRequestSnapshot {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  title: string;
  url: string;
  headRefName: string;
  /** ISO timestamp — used as a tie-breaker for "just opened" detection. */
  createdAt: string;
}

/**
 * Narrow a raw {@link PrRow} `state` (a plain `string` from the read seam) to
 * the bridge's three-state union. Anything unrecognized (or empty) falls back
 * to `OPEN`, preserving the pre-migration inline parser's behaviour.
 */
function normalizePrState(raw: string): "OPEN" | "MERGED" | "CLOSED" {
  const s = (raw || "").toUpperCase();
  if (s === "OPEN" || s === "MERGED" || s === "CLOSED") return s;
  return "OPEN";
}

/**
 * Project a read-seam {@link PrRow} onto the bridge's {@link PullRequestSnapshot}
 * view. The seam already did the defensive field-by-field parse; this only
 * narrows `state` to the bridge's union. Exported for the test surface so the
 * mapping is pinned independently of the live `gh` round-trip.
 */
export function prRowToSnapshot(row: PrRow): PullRequestSnapshot {
  return {
    number: row.number,
    state: normalizePrState(row.state),
    title: row.title,
    url: row.url,
    headRefName: row.headRefName,
    createdAt: row.createdAt,
  };
}

type PrTransition = "opened" | "merged" | "closed";

export interface PrLifecycleEvent {
  repo: string;
  pr_number: number;
  transition: PrTransition;
  title: string;
  url: string;
  task_id: string;
  head_branch: string;
}

/**
 * Extract a subagent task_id hint from a head-branch name. Matches the
 * conventions in use today:
 *   - hydra-dev:          `issue-<N>-dev` / `issue-<N>`
 *   - hydra-target-build: `issue-<N>` (target-side)
 *   - autopilot Agent():  `agent-<hex>` (worktree-isolated sessions)
 *
 * Returns the first match in priority order (`agent-` outranks `issue-`
 * because the Agent-tool task_id is the more specific identifier — issue
 * branches can be hand-created by an operator with no autopilot binding).
 * Empty string if no recognisable token is found.
 */
export function extractTaskId(headBranch: string | undefined | null): string {
  if (!headBranch || typeof headBranch !== "string") return "";
  const agentMatch = headBranch.match(/agent-[0-9a-f]{8,}/i);
  if (agentMatch) return agentMatch[0];
  const issueMatch = headBranch.match(/issue-\d+/);
  if (issueMatch) return issueMatch[0];
  return "";
}

/**
 * Diff the current poll against the last snapshot and yield the transitions
 * that produced new lifecycle events.
 *
 * Pure — `prev` and `curr` are plain JSON-shaped Maps keyed by PR number.
 *
 * Semantics:
 *   - PR in `curr` but not in `prev`, state=OPEN     → "opened"
 *   - PR in both, prev=OPEN and curr=MERGED          → "merged"
 *   - PR in both, prev=OPEN and curr=CLOSED          → "closed"
 *   - PR drops out of `curr`                         → no event (gh's
 *     OPEN list dropped it because it merged/closed; that transition
 *     is captured the LAST time it was in `curr` AFTER we add MERGED+
 *     CLOSED states to the query, so we always include `--state all`
 *     limited to recent PRs in the actual fetch).
 *
 * Cold-start (empty prev): emits "opened" for every currently-open PR.
 * That's a one-time burst on service startup which is the right behaviour
 * because the dashboard's first connection should know which PRs are
 * currently in flight — but it's also why service restarts inside a busy
 * day don't double-fire (the SETNX-style idempotency for budget thresholds
 * isn't needed here because the snapshot diff itself is the dedup mechanism
 * for ongoing operation; the cold-start burst is a one-time signal).
 */
export function diffPrSnapshots(
  prev: Map<number, PullRequestSnapshot>,
  curr: Map<number, PullRequestSnapshot>,
  repo: string,
): PrLifecycleEvent[] {
  const events: PrLifecycleEvent[] = [];

  for (const [num, snap] of curr.entries()) {
    const before = prev.get(num);
    if (!before) {
      // New PR observed this poll.
      if (snap.state === "OPEN") {
        events.push(buildLifecycleEvent(repo, snap, "opened"));
      } else if (snap.state === "MERGED") {
        events.push(buildLifecycleEvent(repo, snap, "merged"));
      } else if (snap.state === "CLOSED") {
        events.push(buildLifecycleEvent(repo, snap, "closed"));
      }
      continue;
    }
    if (before.state === snap.state) continue;
    if (before.state === "OPEN" && snap.state === "MERGED") {
      events.push(buildLifecycleEvent(repo, snap, "merged"));
    } else if (before.state === "OPEN" && snap.state === "CLOSED") {
      events.push(buildLifecycleEvent(repo, snap, "closed"));
    }
    // Other transitions (CLOSED → OPEN reopen, MERGED → anything) are
    // not in the #673 spec — quietly ignored.
  }

  return events;
}

function buildLifecycleEvent(
  repo: string,
  snap: PullRequestSnapshot,
  transition: PrTransition,
): PrLifecycleEvent {
  return {
    repo,
    pr_number: snap.number,
    transition,
    title: snap.title,
    url: snap.url,
    task_id: extractTaskId(snap.headRefName),
    head_branch: snap.headRefName,
  };
}

/** Truncate to 200 chars + strip CR/LF/tab to match the stream-field convention. */
export function sanitizeField(raw: string): string {
  let s = raw || "";
  s = s.replace(/[\n\r\t]/g, " ");
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}
