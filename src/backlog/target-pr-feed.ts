/**
 * TargetPrFeed — the shared target-repo PR/commit I/O Seam for the backlog
 * maintenance path (issue #2084).
 *
 * Extracted from `src/backlog/reaper.ts` and `src/backlog/reconciler.ts`, which
 * each independently shelled out to `gh pr list --repo <target>` and returned
 * incompatible shapes for the same underlying data — `reaper.ts` returned flat
 * `string[]` blobs, `reconciler.ts` returned a structured `MergedRef[]`. Tests
 * had to stub two different injection contracts for the same `gh` call, and a
 * third consumer (the blocked-item re-escalation chore named in `reconciler.ts`)
 * would have required a third clone of the fetching logic.
 *
 * This Module owns all target-repo PR/commit I/O for the backlog maintenance
 * path and returns the `MergedRef` shape for EVERY feed type — open PRs, merged
 * PRs, and merge commits. Both `reaper.ts` and `reconciler.ts` import their
 * default fetchers from here and expose a single injection type in their test
 * seam. The neutral home mirrors `src/backlog/merged-refs.ts` (#882/#1880),
 * which already owns a shared `gh pr list --state merged` scan for two consumers
 * that are not each other's owner.
 *
 * The Seam sits ABOVE the GitHub CLI Adapter (issue #899): it CONSUMES `ghJson`,
 * it never imports `node:child_process` directly, so the github-seam-check
 * ratchet stays green. Every fetcher is a never-throws degrade-to-`null` loader
 * (the fail-open contract: `null` means "no information", never "no PRs").
 *
 * The `itemMatchesOpenPr` matcher also lives here so neither caller is the
 * indirect owner of the other's vocabulary. It stays a STATICALLY traceable
 * named export so knip/dead-code sees it through a static import (the reaper
 * open-PR-guard regression suite imports it directly from this path).
 */

import { getTargetGithubRepo } from "../target-config.ts";
import { ghJson } from "../github/gh.ts";
import { isGhFailure } from "../github/exec.ts";

/**
 * One attributable target-repo artifact the backlog maintenance path can match
 * an item against: `ref` is the audit handle (`pr-109` / `commit-f61e9ed`) that
 * gets stamped into `meta.reconciledFrom`, `blob` is the title+body (or commit
 * message) text the matcher searches for item references.
 *
 * The open-PR and merged-PR feeds set `ref` to `pr-<number>` purely as an audit
 * handle; the reaper does not stamp it (it only reads `.blob` through the
 * matcher), but unifying on `MergedRef` collapses the two historical feed
 * contracts (`string[]` vs `MergedRef[]`) into one. `MergedRef` is a strict
 * superset of the old `string[]` feed because the matcher only reads `.blob`.
 */
export interface MergedRef {
  ref: string;
  blob: string;
}

const OPEN_PR_LIMIT = 100;
const MERGED_PR_LIMIT = 50;
const MERGE_COMMIT_LIMIT = 50;

/**
 * Fetch the set of OPEN PRs in the target repo as attributable refs. Used by
 * `reapStaleClaims` to skip reaping items whose implementing PR is already open
 * (issue #490).
 *
 * Returns `null` on any failure (gh missing, network down, JSON malformed) so
 * the caller treats it as "no information" rather than "no open PRs". The reaper
 * falls back to time-only behaviour in that case — better to over-reap once than
 * wedge a WIP slot because gh is unavailable. Routes through the GitHub CLI
 * Adapter seam (issue #899), which owns the JSON parse + the error modes.
 */
export async function fetchOpenTargetPrRefs(): Promise<MergedRef[] | null> {
  const repo = getTargetGithubRepo();
  const result = await ghJson<unknown>(
    [
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--limit", String(OPEN_PR_LIMIT),
      "--json", "title,body,number",
    ],
    { timeout: 10000 },
  );
  if (isGhFailure(result)) {
    console.error(
      `[Backlog] fetchOpenTargetPrRefs failed for ${repo} (${result.code}): ${result.stderr.slice(0, 200)}`,
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
 * Fetch the set of recently MERGED PRs in the target repo as attributable refs.
 * Used by the reaper's merged-PR guard (issue #1714) and by the reconciler's
 * merge→done sweep (issue #1715).
 *
 * Same fail-open contract as fetchOpenTargetPrRefs: returns `null` on any
 * failure so the caller treats it as "no information" — never "nothing merged".
 */
export async function fetchMergedTargetPrRefs(): Promise<MergedRef[] | null> {
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
export async function fetchTargetMergeCommitRefs(): Promise<MergedRef[] | null> {
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
 * Decide whether a backlog item is already covered by a PR/commit in the target
 * repo. The same matcher serves the reaper's open-PR guard (#490), the reaper's
 * merged-PR guard (#1714), and the reconciler's merge→done sweep (#1715) — only
 * the feed differs. Match is on the item ID as a whole word — the convention
 * autopilot subagents use when opening PRs (e.g. PR title "feat(scanner):
 * item-302 add run history page" or body line "closes item-302"). Falls back to
 * substring title match for the rare case where the subagent embedded the item
 * title verbatim.
 *
 * The `prBlobs` parameter is the title+body text of each candidate PR/commit —
 * i.e. the `.blob` field of the `MergedRef`s the feeds above return. Callers pass
 * `refs.map(r => r.blob)` (or a single `[ref.blob]` for per-ref attribution).
 *
 * Exported as a STATICALLY traceable named export so tests can exercise the
 * matcher without invoking `gh`, and so knip/dead-code sees it through a static
 * import rather than the dynamic-import `admin` namespace.
 */
export function itemMatchesOpenPr(item: { id: string | number; title?: string }, prBlobs: string[]): boolean {
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
