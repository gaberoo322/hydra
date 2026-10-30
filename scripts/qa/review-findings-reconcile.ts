/**
 * scripts/qa/review-findings-reconcile.ts — weekly reconcile of the
 * review-findings seam from GitHub `QA-Verdict:` comments (issue #5270, R1;
 * ADR-0046 Decision 8). Zero tokens, idempotent: re-running over the same
 * comments writes nothing new. The weekly trigger is R2's (#5271); this CLI is
 * the unit of work.
 *
 *   npx tsx scripts/qa/review-findings-reconcile.ts [--since <iso>] [--repo o/r] [--dry-run]
 *
 * Default --since is 7 days ago. It reads issue comments (verdict comments are
 * issue comments) in one paginated GitHub CLI Adapter call, parses each with
 * `parseReviewFindingsComment`, merges against the stored rows, appends the
 * new ones (HSETNX, never overwriting a route row) and prunes rows older than
 * 90 days. Never changes a verdict.
 */

import { parseReviewFindingsComment, reconcileReviewFindings } from "../../src/qa/review-findings-extract.ts";
import type { StoredReviewFindingRow } from "../../src/redis/review-findings.ts";
import { withRetry } from "./cohort-baseline.ts";

interface RestComment {
  body: string | null;
  created_at: string;
}

export async function harvestReviewFindingRows(repo: string, since: string): Promise<StoredReviewFindingRow[]> {
  const { ghJson } = await import("../../src/github/gh.ts");
  const path = `repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`;
  const res = await withRetry(() =>
    ghJson<RestComment[][]>(["api", path, "--paginate", "--slurp"], {
      timeout: 300_000,
      maxBuffer: 256 * 1024 * 1024,
    }),
  );
  if (res.ok === false) {
    throw new Error(`gh api ${path} failed: ${res.code}`);
  }
  return res.data
    .flat()
    .filter((c) => typeof c.body === "string" && c.body.includes("QA-Verdict:"))
    .flatMap((c) => parseReviewFindingsComment(c.body, { at: c.created_at, source: "reconcile" }));
}

const isMain = (() => {
  try {
    return (
      Array.isArray(process.argv) &&
      process.argv[1] !== undefined &&
      import.meta.url === `file://${process.argv[1]}`
    );
  } catch {
    /* intentional: import.meta unavailable outside a module host — not the CLI */
    return false;
  }
})();

if (isMain) {
  const arg = (flag: string): string | null => {
    const i = process.argv.indexOf(flag);
    return i === -1 || i === process.argv.length - 1 ? null : (process.argv[i + 1] as string);
  };
  const repo = arg("--repo") ?? "gaberoo322/hydra";
  const since = arg("--since") ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dryRun = process.argv.includes("--dry-run");
  let code = 0;
  try {
    const seam = await import("../../src/redis/review-findings.ts");
    const harvested = await harvestReviewFindingRows(repo, since);
    const existing = await seam.readReviewFindingRows();
    const plan = reconcileReviewFindings(existing, harvested, { now: Date.now() });
    console.error(
      `[review-findings-reconcile] harvested=${harvested.length} upserts=${plan.upserts.length} unchanged=${plan.unchanged} pruned=${plan.pruned.length}${dryRun ? " (dry-run)" : ""}`,
    );
    if (!dryRun) {
      await seam.appendReviewFindingRows(plan.upserts);
      await seam.deleteReviewFindingRows(plan.pruned);
    }
  } catch (err) {
    console.error("[review-findings-reconcile] failed:", err);
    code = 1;
  }
  // The gh adapter and Redis side-channels keep the loop alive; exit explicitly.
  process.exit(code);
}
