/**
 * Stale-claim reaper (issue #374).
 *
 * Distinct from `requeueStaleInProgressItems` in ./wip.ts — that function uses
 * `meta.startedAt` (date precision) and reclaims items the system has been
 * chewing on for >7 days. This file uses `claimedAt` (ISO timestamp, stamped
 * on every move-into-inProgress) and reclaims items whose claimant died — the
 * "Phase-A codex-removal orphaned 3 in-progress items" failure mode. Default
 * threshold 2h; tunable via HYDRA_CLAIM_MAX_AGE_MS.
 */

import {
  addToBacklogLane, removeFromBacklogLane, getBacklogLaneIds,
  incrClaimsReapedLifetime,
  incrClaimsReapedDay,
  setClaimsReapedLast,
} from "../redis/backlog.ts";
import { pushAlert } from "../redis/alerts.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import { ghJson } from "../github/gh.ts";
import { isGhFailure } from "../github/exec.ts";
import {
  applyLaneTransition, getItem, saveItem, getLaneItems,
} from "./internal.ts";

const CLAIM_MAX_AGE_MS_DEFAULT = 2 * 60 * 60 * 1000;
const CLAIM_REAP_ESCALATE_AFTER = parseInt(process.env.HYDRA_CLAIM_REAP_ESCALATE_AFTER) || 3;
const CLAIMS_REAPED_DAY_TTL_S = 7 * 24 * 60 * 60;

export interface StaleClaim {
  id: string;
  title: string;
  claimedBy: string | null;
  claimedAt: string | null;
  claimedAgeMs: number;
  reapCount: number;
}

/**
 * Return inProgress items annotated with their current claim age. Does not
 * mutate any state. Used by `/api/backlog/stale-claims` so the operator and
 * dashboard can preview what the reaper would touch.
 */
export async function getStaleClaims(opts: { maxAgeMs?: number } = {}): Promise<{
  all: StaleClaim[];
  stale: StaleClaim[];
  maxAgeMs: number;
}> {
  const maxAgeMs = opts.maxAgeMs ?? CLAIM_MAX_AGE_MS_DEFAULT;
  const now = Date.now();
  const items = await getLaneItems("inProgress");
  const all: StaleClaim[] = items.map((item: any) => {
    const claimedAtIso = item.claimedAt ?? null;
    const claimedAtMs = claimedAtIso ? new Date(claimedAtIso).getTime() : NaN;
    const ageMs = Number.isFinite(claimedAtMs) ? now - claimedAtMs : 0;
    return {
      id: item.id,
      title: item.title,
      claimedBy: item.claimedBy ?? null,
      claimedAt: claimedAtIso,
      claimedAgeMs: ageMs,
      reapCount: typeof item.meta?.reapCount === "number" ? item.meta.reapCount : 0,
    };
  });
  const stale = all.filter(c => c.claimedAgeMs > maxAgeMs);
  return { all, stale, maxAgeMs };
}

/**
 * Fetch the set of open PRs in the target repo and return their title+body
 * blobs. Used by reapStaleClaims to skip reaping items whose implementing PR
 * is already open (issue #490).
 *
 * Returns `null` on any failure (gh missing, network down, JSON malformed) so
 * the caller treats it as "no information" rather than "no open PRs". The
 * reaper falls back to time-only behaviour in that case — better to over-reap
 * once than wedge a WIP slot because gh is unavailable.
 */
async function fetchOpenTargetPrBlobs(): Promise<string[] | null> {
  const repo = getTargetGithubRepo();
  // Routes through the GitHub CLI Adapter seam (issue #899). The seam never
  // throws and owns the JSON parse + the four error modes; any failure arm
  // (gh missing, network down, malformed/empty JSON) returns null so the caller
  // treats it as "no information" and falls back to time-only reaping —
  // preserving the pre-seam contract.
  const result = await ghJson<unknown>(
    [
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--limit", "100",
      "--json", "title,body,number",
    ],
    { timeout: 10000 },
  );
  if (isGhFailure(result)) {
    console.error(
      `[Backlog] fetchOpenTargetPrBlobs failed for ${repo} (${result.code}): ${result.stderr.slice(0, 200)}`,
    );
    return null;
  }
  const prs = result.data;
  if (!Array.isArray(prs)) return null;
  return prs.map((pr: any) => `${pr.title ?? ""}\n${pr.body ?? ""}`);
}

/**
 * Decide whether an in-progress backlog item is already covered by an OPEN PR
 * in the target repo. Match is on the item ID as a whole word — this is the
 * convention autopilot subagents use when opening PRs (e.g. PR title
 * "feat(scanner): item-302 add run history page" or body line "closes
 * item-302"). Falls back to substring title match for the rare case where the
 * subagent embedded the item title verbatim.
 *
 * Exported so tests can exercise the matcher without invoking `gh` — the
 * open-PR-guard regression suite imports it directly (statically) rather than
 * reaching it through the dynamic-import `admin` namespace, so the export stays
 * statically traceable.
 */
export function itemMatchesOpenPr(item: { id: string; title?: string }, prBlobs: string[]): boolean {
  if (!Array.isArray(prBlobs) || prBlobs.length === 0) return false;
  const id = String(item.id || "");
  if (!id) return false;
  // Whole-word match for the item ID. `item-302` should not match `item-3020`.
  const idPattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?:[^A-Za-z0-9_-]|$)`);
  const title = (item.title || "").trim();
  for (const blob of prBlobs) {
    if (idPattern.test(blob)) return true;
    if (title.length >= 12 && blob.includes(title)) return true;
  }
  return false;
}

/**
 * Reap stale claims: move inProgress items whose `claimedAt` is older than
 * `maxAgeMs` back to `queued` (or to `blocked` if they've been reaped
 * `CLAIM_REAP_ESCALATE_AFTER` times — likely a crash-loop, operator needs to
 * see it). Stamps `meta.reapedAt`, `meta.reapReason`, `meta.previousClaimedBy`
 * and increments `meta.reapCount`. Emits a `stale-claim-reaped` alert per item
 * and increments the lifetime + per-day `claims-reaped` counters.
 *
 * **Open-PR guard (issue #490).** Before reaping any item, the reaper fetches
 * the list of OPEN PRs in the target repo and skips any item whose ID (or
 * exact title) appears in a PR title/body. This prevents the "reaper
 * re-queues an item that already has an open implementing PR" failure mode,
 * which cost 76k tokens in a duplicate dev_target dispatch on 2026-05-17. The
 * check is best-effort: a `gh` outage falls back to time-only reaping
 * (over-reap once rather than wedge a slot). Tests inject the PR feed via
 * `opts.fetchOpenPrBlobs` so they don't shell out.
 *
 * Returns `{ reaped, skippedOpenPr }`. `skippedOpenPr` lists items the
 * open-PR guard preserved so operators and tests can audit the decision.
 *
 * Never throws — Redis errors during metric/alert publication are logged and
 * swallowed so a metrics outage can't leave a wedged WIP slot.
 */
export async function reapStaleClaims(opts: {
  maxAgeMs?: number;
  fetchOpenPrBlobs?: () => Promise<string[] | null>;
} = {}): Promise<{
  reaped: Array<{ id: string; title: string; ageMs: number; escalated: boolean }>;
  skippedOpenPr: Array<{ id: string; title: string; ageMs: number }>;
  maxAgeMs: number;
}> {
  const maxAgeMs = opts.maxAgeMs ?? CLAIM_MAX_AGE_MS_DEFAULT;
  const now = Date.now();
  const ids = await getBacklogLaneIds("inProgress");
  const reaped: Array<{ id: string; title: string; ageMs: number; escalated: boolean }> = [];
  const skippedOpenPr: Array<{ id: string; title: string; ageMs: number }> = [];

  const prFetcher = opts.fetchOpenPrBlobs ?? fetchOpenTargetPrBlobs;
  const prBlobs = await prFetcher();

  for (const id of ids) {
    const item = await getItem(id);
    if (!item) continue;

    const claimedAtIso = item.claimedAt;
    if (!claimedAtIso) continue;
    const claimedAtMs = new Date(claimedAtIso).getTime();
    if (!Number.isFinite(claimedAtMs)) continue;
    const ageMs = now - claimedAtMs;
    if (ageMs <= maxAgeMs) continue;

    if (prBlobs && itemMatchesOpenPr(item, prBlobs)) {
      console.warn(
        `[Backlog] Skipping reap of ${id} ("${(item.title || "").slice(0, 60)}") — open PR in target repo references this item. claimedBy=${item.claimedBy ?? "?"} ageMs=${ageMs}`,
      );
      skippedOpenPr.push({ id, title: item.title, ageMs });
      continue;
    }

    const previousClaimedBy = item.claimedBy ?? null;
    const reapCount = (typeof item.meta?.reapCount === "number" ? item.meta.reapCount : 0) + 1;
    const escalate = reapCount >= CLAIM_REAP_ESCALATE_AFTER;
    const targetLane = escalate ? "blocked" : "queued";
    const reapReason = "stale-claim";

    await removeFromBacklogLane("inProgress", id);
    item.meta = {
      ...item.meta,
      reapedAt: new Date().toISOString(),
      reapReason,
      previousClaimedBy,
      reapCount,
      ...(escalate
        ? {
            blockedAt: new Date().toISOString().split("T")[0],
            blockedReason: `repeatedly-reaped (${reapCount}x): claim by ${previousClaimedBy ?? "unknown"} aged ${Math.round(ageMs / 1000)}s past ${Math.round(maxAgeMs / 1000)}s threshold`,
          }
        : {}),
    };
    applyLaneTransition(item, targetLane);
    await saveItem(item);
    await addToBacklogLane(targetLane, Date.now(), id);

    console.warn(
      `[Backlog] Reaped stale claim ${id} ("${(item.title || "").slice(0, 60)}") — claimedBy=${previousClaimedBy ?? "?"} ageMs=${ageMs} threshold=${maxAgeMs} reapCount=${reapCount} → ${targetLane}`,
    );

    try {
      await incrClaimsReapedLifetime();
      const isoDate = new Date().toISOString().split("T")[0];
      await incrClaimsReapedDay(isoDate, CLAIMS_REAPED_DAY_TTL_S);
      await setClaimsReapedLast(new Date().toISOString());
    } catch (err: any) {
      console.error(`[Backlog] reapStaleClaims metrics failed for ${id}: ${err.message}`);
    }

    try {
      await pushAlert(
        JSON.stringify({
          type: "stale-claim-reaped",
          ts: new Date().toISOString(),
          payload: {
            itemId: id,
            title: item.title,
            previousClaimedBy,
            claimedAt: claimedAtIso,
            ageMs,
            maxAgeMs,
            reapCount,
            targetLane,
            escalated: escalate,
          },
        }),
        100,
      );
    } catch (err: any) {
      console.error(`[Backlog] reapStaleClaims alert publish failed for ${id}: ${err.message}`);
    }

    reaped.push({ id, title: item.title, ageMs, escalated: escalate });
  }

  return { reaped, skippedOpenPr, maxAgeMs };
}
