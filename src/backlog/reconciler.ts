/**
 * Merge→done reconciler (issue #1715).
 *
 * Closes the general "phantom work" hole that the reaper's merged-PR guard
 * (issue #1714) only covers for stale `inProgress` claims: when the build flow
 * misses its own done-stamp (agent crash after merge, reaper interference,
 * manual merges), the backlog item lingers in a non-done lane even though its
 * implementing PR verifiably merged. Confirmed instance: `item-490` sat in
 * `queued` for 9+ hours after hydra-betting PR #109 merged.
 *
 * The reconciler sweeps recently merged target PRs AND recent merge commits on
 * the target's default branch (cycle merges bypass PRs — e.g.
 * "merge: claude cycle — ... (item-485)"), extracts `item-NNN` references via
 * the same whole-word matcher the reaper uses (`itemMatchesOpenPr`), and moves
 * every referenced item found in a non-done lane to `done`, stamping
 * `meta.reconciledAt` / `meta.reconciledFrom` plus the same
 * `completedAt`/`outcome`/`checked` fields `moveToDone` writes so done-lane
 * retention prunes the item normally.
 *
 * Contract (mirrors `reapStaleClaims`):
 *   - Fail closed on ambiguity: a `gh` outage on a feed returns `null` →
 *     that feed contributes nothing; both feeds down → complete no-op. An
 *     unreadable board (Redis error) aborts the sweep with what was done so
 *     far. An item is NEVER moved without a concrete merged reference.
 *   - Idempotent: only non-done lanes are scanned, so re-running over the
 *     same window finds nothing to move.
 *   - Never throws — returns a result object; per-item failures are logged
 *     and skipped (CLAUDE.md: never throw from merge/verification paths).
 *   - Auditable: each closure emits a `merged-item-reconciled` alert and is
 *     listed in the returned `reconciled` array.
 *
 * Invoked hourly from the Housekeeping chore set
 * (`src/scheduler/housekeeping.ts`, `merged-item-reconciler`) — the same
 * cadence home as the work-queue hygiene reconciler (#1690). Tests inject the
 * feeds via `opts` (same seam style as `reaper.ts` `opts.fetchOpenPrBlobs`).
 */

import {
  addToBacklogLane, removeFromBacklogLane, getBacklogLaneIds,
} from "../redis/backlog.ts";
import { pushAlert } from "../redis/alerts.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import { ghJson } from "../github/gh.ts";
import { isGhFailure } from "../github/exec.ts";
import { applyLaneTransition, getItem, saveItem } from "./internal.ts";
import { itemMatchesOpenPr } from "./reaper.ts";

/**
 * One merged artifact the reconciler can attribute a closure to: `ref` is the
 * audit handle stamped into `meta.reconciledFrom` (`pr-109` /
 * `commit-f61e9ed`), `blob` is the text searched for item references.
 */
export interface MergedRef {
  ref: string;
  blob: string;
}

/** Lanes the reconciler sweeps — every lane except `done` that `moveToDone` also drains. */
const RECONCILE_LANES = ["inProgress", "blocked", "queued", "backlog"] as const;

const MERGED_PR_LIMIT = 50;
const MERGE_COMMIT_LIMIT = 50;

/**
 * Fetch recently MERGED PRs in the target repo as attributable refs.
 *
 * Returns `null` on any failure (gh missing, network down, malformed JSON) so
 * the caller treats it as "no information" — never "nothing merged". Routes
 * through the GitHub CLI Adapter seam (issue #899), which owns the JSON parse
 * and the error modes.
 */
async function fetchMergedTargetPrRefs(): Promise<MergedRef[] | null> {
  const repo = getTargetGithubRepo();
  const result = await ghJson<unknown>(
    [
      "pr", "list",
      "--repo", repo,
      "--state", "merged",
      "--limit", String(MERGED_PR_LIMIT),
      "--json", "title,body,number",
    ],
    { timeout: 10000 },
  );
  if (isGhFailure(result)) {
    console.error(
      `[Backlog] fetchMergedTargetPrRefs failed for ${repo} (${result.code}): ${result.stderr.slice(0, 200)}`,
    );
    return null;
  }
  const prs = result.data;
  if (!Array.isArray(prs)) return null;
  return prs
    .filter((pr: any) => pr && pr.number != null)
    .map((pr: any) => ({
      ref: `pr-${pr.number}`,
      blob: `${pr.title ?? ""}\n${pr.body ?? ""}`,
    }));
}

/**
 * Fetch recent commits on the target repo's default branch as attributable
 * refs — catches cycle merges that land without a PR (e.g. commit subject
 * "merge: claude cycle — ... (item-485)").
 *
 * Same fail-open contract as fetchMergedTargetPrRefs: `null` means "no
 * information", never "no commits".
 */
async function fetchTargetMergeCommitRefs(): Promise<MergedRef[] | null> {
  const repo = getTargetGithubRepo();
  const result = await ghJson<unknown>(
    ["api", `repos/${repo}/commits?per_page=${MERGE_COMMIT_LIMIT}`],
    { timeout: 10000 },
  );
  if (isGhFailure(result)) {
    console.error(
      `[Backlog] fetchTargetMergeCommitRefs failed for ${repo} (${result.code}): ${result.stderr.slice(0, 200)}`,
    );
    return null;
  }
  const commits = result.data;
  if (!Array.isArray(commits)) return null;
  return commits
    .filter((c: any) => c && typeof c.sha === "string" && c.sha.length > 0)
    .map((c: any) => ({
      ref: `commit-${c.sha.slice(0, 7)}`,
      blob: String(c.commit?.message ?? ""),
    }));
}

/**
 * Sweep non-done lanes for items referenced by a recently merged target PR or
 * merge commit, and move each match to `done` with audit stamps.
 *
 * Options (test seam, mirrors `reapStaleClaims`):
 *   - `fetchMergedPrRefs`  — injectable merged-PR feed; default shells `gh`.
 *   - `fetchMergeCommitRefs` — injectable commit feed; default shells `gh`.
 *
 * Returns:
 *   - `reconciled` — items moved to done, with the matched `ref` and the lane
 *     they were lifted from.
 *   - `scanned`    — how many non-done items were inspected.
 *   - `feedsAvailable` — false when BOTH feeds returned `null` (gh outage);
 *     the sweep was a guaranteed no-op in that case.
 */
export async function reconcileMergedItems(opts: {
  fetchMergedPrRefs?: () => Promise<MergedRef[] | null>;
  fetchMergeCommitRefs?: () => Promise<MergedRef[] | null>;
} = {}): Promise<{
  reconciled: Array<{ id: string; title: string; fromLane: string; ref: string }>;
  scanned: number;
  feedsAvailable: boolean;
}> {
  const reconciled: Array<{ id: string; title: string; fromLane: string; ref: string }> = [];
  let scanned = 0;

  const prFetcher = opts.fetchMergedPrRefs ?? fetchMergedTargetPrRefs;
  const commitFetcher = opts.fetchMergeCommitRefs ?? fetchTargetMergeCommitRefs;
  const prRefs = await prFetcher();
  const commitRefs = await commitFetcher();
  const feedsAvailable = prRefs !== null || commitRefs !== null;

  // Fail closed: no feed information → never move anything.
  const refs: MergedRef[] = [...(prRefs ?? []), ...(commitRefs ?? [])];
  if (refs.length === 0) {
    return { reconciled, scanned, feedsAvailable };
  }

  for (const lane of RECONCILE_LANES) {
    let ids: string[];
    try {
      ids = await getBacklogLaneIds(lane);
    } catch (err: any) {
      // Unreadable board → stop sweeping; report what was done so far rather
      // than guessing at lane membership.
      console.error(`[Backlog] reconcileMergedItems could not read lane ${lane}: ${err.message}`);
      return { reconciled, scanned, feedsAvailable };
    }

    for (const id of ids) {
      try {
        const item = await getItem(id);
        if (!item) continue;
        scanned++;

        // Per-ref matching (rather than one big blob array) so the closure is
        // attributable: the FIRST matching ref is stamped as reconciledFrom.
        const match = refs.find((r) => itemMatchesOpenPr(item, [r.blob]));
        if (!match) continue;

        await removeFromBacklogLane(lane, id);
        item.checked = true;
        item.meta = {
          ...item.meta,
          reconciledAt: new Date().toISOString(),
          reconciledFrom: match.ref,
          completedAt: new Date().toISOString().split("T")[0],
          outcome: "merged",
        };
        applyLaneTransition(item, "done");
        await saveItem(item);
        await addToBacklogLane("done", -Date.now(), id);

        console.warn(
          `[Backlog] Reconciled ${id} ("${(item.title || "").slice(0, 60)}") ${lane} → done — merged ${match.ref} references this item`,
        );

        try {
          await pushAlert(
            JSON.stringify({
              type: "merged-item-reconciled",
              ts: new Date().toISOString(),
              payload: {
                itemId: id,
                title: item.title,
                fromLane: lane,
                reconciledFrom: match.ref,
              },
            }),
            100,
          );
        } catch (err: any) {
          console.error(`[Backlog] reconcileMergedItems alert publish failed for ${id}: ${err.message}`);
        }

        reconciled.push({ id, title: item.title, fromLane: lane, ref: match.ref });
      } catch (err: any) {
        console.error(`[Backlog] reconcileMergedItems failed on item ${id}: ${err.message}`);
      }
    }
  }

  return { reconciled, scanned, feedsAvailable };
}
