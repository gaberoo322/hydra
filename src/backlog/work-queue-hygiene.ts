// ---------------------------------------------------------------------------
// Work-Queue Hygiene — reconcile entries against resolved state (issue #1690).
// ---------------------------------------------------------------------------
//
// Extracted from `src/anchor-candidates.ts` (issue #1844). The Candidate Feed
// and Work-Queue Hygiene were two orthogonal concerns living in one module with
// different call-site profiles: the Feed serves `GET /api/anchor/candidates`,
// while Hygiene drives the hourly `work-queue-hygiene` housekeeping chore and
// the operator-facing `POST /api/queue/reconcile` hook. They shared the #882
// merged-suppression primitives, but those moved to the shared
// `src/backlog/merged-refs.ts` Seam (issue #1880) — so this module imports them
// directly from there and has NO dependency on `anchor-candidates.ts`.
//
// `hydra:anchors:work-queue` retains entries whose anchor was resolved
// OUT-OF-BAND (issue closed manually, work shipped by a different cycle, an
// external fix). The merged-suppression in the Candidate Feed hides entries
// whose identity matches a recently-merged PR token, but an out-of-band
// resolution often has NO matching merged-PR token — the entry kept resurfacing
// at work-queue tier (0.70) and dev_target burned a full dispatch on no-op
// verify+LREM (highest-recurrence unfixed retro cue, recurrence 14).
// `reconcileWorkQueue` is the shared engine: it REMOVES entries that are
// (a) merged work per the #882 token scan, (b) reference orchestrator issues
// that are ALL closed, or (c) terminal-state markers (COMPLETED:/CLOSED:
// completion notes that are never actionable as work, issue #1853). It is
// fail-open — any uncertainty (no issue refs, an open issue, an unreachable
// `gh`) keeps the entry.
//
// The terminal-marker reap (cause "terminal-marker") MOVED here from the
// Candidate Feed (issue #2187): the Feed still SUPPRESSES terminal markers on
// every poll (skipping them as candidates), but the Redis GC of the stale entry
// is owned by this hourly reconciler so the Feed stays a pure read-and-score
// path with zero writes. `isTerminalMarker` lives in the `redis/work-queue.ts`
// module this file already imports — no new import edge.

import { execFileViaSeam } from "../github/exec-file-compat.ts";
import {
  getWorkQueueItems,
  removeWorkQueueItem,
  isTerminalMarker,
} from "../redis/work-queue.ts";
import { isMergedWork, loadMergedAnchorRefsImpl } from "./merged-refs.ts";

// ---------------------------------------------------------------------------
// GitHub CLI adapter + the orchestrator repo literal (issue #899 / #882).
// ---------------------------------------------------------------------------

// The production default routes `gh` shell-outs through the GitHub CLI Adapter
// seam (issue #899). The `exec` parameter on `getIssueStateImpl` remains the
// injectable test seam — this only changes the default.
const execFile = execFileViaSeam;

// The orchestrator's own repo. A literal is fine here — Hydra IS this repo, so
// it is not a swappable target (mirrors `ORCHESTRATOR_REPO` in
// `src/autopilot/pr-lifecycle-bridge.ts`). Used by the issue-state reader below.
const ORCHESTRATOR_REPO = "gaberoo322/hydra";

/** Max `gh` issue-state lookups per reconcile run — bounds chore cost. */
const ISSUE_STATE_CHECK_CAP = 30;

/**
 * Pure helper — exported for tests. Harvest orchestrator issue numbers from a
 * work-queue entry: `#NNN` and `issue-NNN` tokens in the `reference` and
 * `reason` fields. The free-text `context` field is deliberately EXCLUDED — it
 * often quotes related PRs / foreign-repo numbers (e.g. a betting PR "#113"),
 * and a foreign number colliding with an old closed orch issue would be a
 * false-positive removal. `item-NNN` target refs are also excluded (they are
 * Redis backlog items, not GitHub issues; the merged-token path covers them).
 */
export function harvestOrchIssueRefs(item: {
  reference?: unknown;
  reason?: unknown;
}): string[] {
  const out = new Set<string>();
  for (const f of [item?.reference, item?.reason]) {
    if (typeof f !== "string") continue;
    for (const m of f.matchAll(/#(\d+)\b/g)) out.add(m[1]);
    for (const m of f.matchAll(/\bissue-(\d+)\b/gi)) out.add(m[1]);
  }
  return [...out];
}

/**
 * Production issue-state reader. Returns "open" | "closed" for an orchestrator
 * issue, or null when the state cannot be determined (unreachable `gh`,
 * unexpected payload). Never throws — null means "keep the entry" (fail open).
 * REST (`gh api`) rather than GraphQL: the running autopilot exhausts the
 * GraphQL pool; REST has its own.
 */
async function getIssueStateImpl(
  issueNumber: string,
  exec: typeof execFile = execFile,
): Promise<"open" | "closed" | null> {
  try {
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${ORCHESTRATOR_REPO}/issues/${issueNumber}`, "--jq", ".state"],
      { timeout: 10_000 },
    );
    const st = stdout.trim().toLowerCase();
    return st === "open" || st === "closed" ? st : null;
  } catch (err: any) {
    console.error(
      `[WorkQueueHygiene] issue-state check failed for #${issueNumber}: ${err?.message || err}`,
    );
    return null;
  }
}

/** Injectable dependencies for `reconcileWorkQueue` — the test surface. */
export interface WorkQueueReconcileDeps {
  getWorkQueueItems: () => Promise<string[]>;
  removeWorkQueueItem: (raw: string) => Promise<number>;
  loadMergedAnchorRefs: () => Promise<Set<string>>;
  getIssueState: (issueNumber: string) => Promise<"open" | "closed" | null>;
}

export interface WorkQueueReconcileResult {
  /** Entries inspected this run. */
  scanned: number;
  /** Queue entries removed (LREM count — duplicates of one raw all count). */
  removed: number;
  /** One row per distinct removed raw, with the cause. */
  details: Array<{
    reference: string;
    cause: "merged-work" | "closed-issue" | "terminal-marker";
  }>;
}

/**
 * Reconcile the work queue against resolved state. Removes entries that are
 * (a) merged work (the #882 token set), (b) reference orch issues that are
 * ALL closed (at least one ref required), or (c) terminal-state markers
 * (COMPLETED:/CLOSED: completion notes, issue #1853 — reap moved here from the
 * Candidate Feed in #2187). Fail-open on every uncertainty; never throws — a
 * failing read degrades to a no-op result.
 */
export async function reconcileWorkQueue(
  deps: Partial<WorkQueueReconcileDeps> = {},
): Promise<WorkQueueReconcileResult> {
  const d: WorkQueueReconcileDeps = {
    getWorkQueueItems: deps.getWorkQueueItems ?? getWorkQueueItems,
    removeWorkQueueItem: deps.removeWorkQueueItem ?? removeWorkQueueItem,
    loadMergedAnchorRefs: deps.loadMergedAnchorRefs ?? (() => loadMergedAnchorRefsImpl()),
    getIssueState: deps.getIssueState ?? getIssueStateImpl,
    // NOTE: `() => loadMergedAnchorRefsImpl()` calls the shared production
    // loader with no clock arg so the closure-local TTL cache uses Date.now().
  };
  const result: WorkQueueReconcileResult = { scanned: 0, removed: 0, details: [] };

  let raws: string[] = [];
  try {
    raws = await d.getWorkQueueItems();
  } catch (err: any) {
    console.error(`[WorkQueueHygiene] queue read failed: ${err.message}`);
    return result;
  }
  if (raws.length === 0) return result;
  result.scanned = raws.length;

  let mergedRefs: Set<string> = new Set();
  try {
    mergedRefs = await d.loadMergedAnchorRefs();
  } catch (err: any) {
    console.error(`[WorkQueueHygiene] merged-refs load failed: ${err.message}`);
  }

  // Per-run issue-state cache — entries referencing the same issue share one
  // lookup, and the cap bounds total `gh` cost per invocation.
  const stateCache = new Map<string, "open" | "closed" | null>();
  let checksUsed = 0;
  let capLogged = false;

  for (const raw of raws) {
    let item: any;
    try {
      item = JSON.parse(raw);
    } catch {
      /* intentional: corrupt entries are cleanWorkQueue's concern — keep going */
      continue;
    }
    const ref: string = item.reference || item.description || "";
    if (!ref) continue;

    let cause: "merged-work" | "closed-issue" | "terminal-marker" | null = null;
    // Terminal-state markers (COMPLETED:/CLOSED:) are completion notes, never
    // actionable as work (issue #1853). Independent of merged/closed-issue —
    // checked first and cheaply (no `gh` lookup). The Candidate Feed suppresses
    // them on every poll; this reconciler GCs the stale Redis entry (#2187).
    if (isTerminalMarker(ref)) {
      cause = "terminal-marker";
    } else if (isMergedWork({ issue: ref, title: ref, anchorRef: ref }, mergedRefs)) {
      cause = "merged-work";
    } else {
      const issueRefs = harvestOrchIssueRefs(item);
      if (issueRefs.length > 0) {
        let allClosed = true;
        for (const num of issueRefs) {
          let st = stateCache.get(num);
          if (st === undefined) {
            if (checksUsed >= ISSUE_STATE_CHECK_CAP) {
              if (!capLogged) {
                console.error(
                  `[WorkQueueHygiene] issue-state check cap (${ISSUE_STATE_CHECK_CAP}) reached — remaining entries kept this run`,
                );
                capLogged = true;
              }
              allClosed = false;
              break;
            }
            checksUsed++;
            st = await d.getIssueState(num);
            stateCache.set(num, st);
          }
          // Open OR undeterminable → keep the entry (fail open).
          if (st !== "closed") {
            allClosed = false;
            break;
          }
        }
        if (allClosed) cause = "closed-issue";
      }
    }
    if (!cause) continue;

    try {
      const n = await d.removeWorkQueueItem(raw);
      // A duplicate raw already reaped earlier in this loop LREMs 0 — don't
      // double-report it.
      if (n > 0) {
        result.removed += n;
        result.details.push({ reference: String(ref).slice(0, 120), cause });
        console.log(
          `[WorkQueueHygiene] Removed resolved entry (${cause}): "${String(ref).slice(0, 80)}"`,
        );
      }
    } catch (err: any) {
      console.error(
        `[WorkQueueHygiene] remove failed for "${String(ref).slice(0, 60)}": ${err.message}`,
      );
    }
  }
  return result;
}
