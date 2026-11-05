/**
 * scripts/lifecycle-legacy-backfill.ts — one-time claim pass (ADR-0047 D4, #5315).
 *
 *   npx tsx scripts/lifecycle-legacy-backfill.ts [--apply]
 *
 * Every open `in-progress` issue on the orch repo that has NO held dispatch claim
 * gets a `legacy-backfill` placeholder claim journalled with `state=in-progress`,
 * so the first real dispatch (or reap release) takes it over through the seam
 * (`openClaim`'s legacy-backfill exception). Dry-run by default; writes only with
 * `--apply`. Idempotent: a second run sees `claim-held` for every row and writes
 * nothing. Writes no label. Prints one JSON summary line `{scanned, claimed, held, failed}`.
 *
 * Run ONCE by the operator after merge.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { LEGACY_BACKFILL_CLASS, defaultSeamDeps, openClaim, type ClaimResult } from "../src/lifecycle/index.ts";
import { isIssueReadFailure, listIssuesByLabel, resolveGithubRepo } from "../src/github/issues.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";
import { readDispatchClaim, type ReadClaimResult } from "../src/redis/lifecycle-journal.ts";

export interface BackfillSummary {
  scanned: number;
  claimed: number;
  held: number;
  failed: number;
}

export interface BackfillDeps {
  repo: string;
  /** Issue numbers currently labelled `in-progress` and open; `null` when the list read failed. */
  listInProgress: () => Promise<number[] | null>;
  readClaim: (repo: string, issue: number) => Promise<ReadClaimResult>;
  open: (issue: number, dispatchId: string, run: string) => Promise<ClaimResult>;
  today: () => string;
}

/** Pure of I/O beyond its injected deps. Never throws. */
export async function runBackfill(apply: boolean, deps: BackfillDeps): Promise<BackfillSummary> {
  const summary: BackfillSummary = { scanned: 0, claimed: 0, held: 0, failed: 0 };
  const issues = await deps.listInProgress();
  if (issues === null) {
    summary.failed += 1;
    return summary;
  }
  const run = `legacy-backfill-${deps.today()}`;
  for (const issue of issues) {
    summary.scanned += 1;
    const held = await deps.readClaim(deps.repo, issue);
    if (held.ok === false) {
      summary.failed += 1;
      continue;
    }
    if (held.claim) {
      summary.held += 1;
      continue;
    }
    if (!apply) continue;
    const res = await deps.open(issue, `legacy-backfill-${issue}`, run);
    if (res.ok) summary.claimed += 1;
    else if (res.code === "claim-held") summary.held += 1;
    else summary.failed += 1;
  }
  return summary;
}

export async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes("--apply");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const seam = defaultSeamDeps(repoRoot);
  const summary = await runBackfill(apply, {
    repo: seam.repo || resolveGithubRepo(),
    listInProgress: async () => {
      const res = await listIssuesByLabel("in-progress", { repo: seam.repo });
      if (isIssueReadFailure(res)) {
        console.error(`[lifecycle-backfill] gh issue list --label in-progress failed (${res.code})`);
        return null;
      }
      return res.rows.map((r) => r.number);
    },
    readClaim: readDispatchClaim,
    open: (issue, dispatchId, run) =>
      openClaim({ issue, dispatchId, class: LEGACY_BACKFILL_CLASS, run, actor: "legacy-backfill" }, seam),
    today: () => new Date().toISOString().slice(0, 10),
  });
  console.log(JSON.stringify({ apply, ...summary }));
  return summary.failed === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      closeRedisConnections();
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("[lifecycle-backfill] fatal:", err);
      closeRedisConnections();
      process.exitCode = 1;
    });
}
