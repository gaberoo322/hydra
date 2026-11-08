/**
 * scripts/lifecycle-legacy-backfill.ts — one-time cutover helper
 * (ADR-0047 Decision 7, issue #5315).
 *
 *   npx tsx scripts/lifecycle-legacy-backfill.ts [--apply]
 *
 * For every open orchestrator-repo `in-progress` issue with no held dispatch
 * claim, opens a placeholder claim (`class: legacy-backfill`) so the claim
 * gate covers work that was dispatched before the seam existed. Dry-run by
 * default; writes only with `--apply`. Idempotent: a second run finds every
 * claim held and writes nothing. Never writes a label. A placeholder older
 * than STALE_CLAIM_AGE_MS is closed by the reconcile stale arm, and the first
 * real dispatch on the issue takes it over (see `openClaim`).
 *
 * Prints one `{scanned, claimed, held, failed}` JSON line. Exit 0 on a clean
 * pass, 1 when any claim write or the board read failed.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defaultSeamDeps, openClaim, type SeamDeps } from "../src/lifecycle/index.ts";
import { LEGACY_BACKFILL_CLASS } from "../src/lifecycle/seam.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";
import { listOpenIssues, type IssueReadResult, type IssueRow } from "../src/github/issues.ts";

export interface BackfillDeps {
  seam: SeamDeps;
  listOpenIssues: () => Promise<IssueReadResult<IssueRow>>;
}

export interface BackfillSummary {
  scanned: number;
  claimed: number;
  held: number;
  failed: number;
}

/** UTC calendar day, `YYYY-MM-DD`. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Never throws: a board-read failure is `ok: false`; a per-issue failure is counted. */
export async function runBackfill(
  deps: BackfillDeps,
  opts: { apply?: boolean } = {},
): Promise<{ ok: boolean; summary: BackfillSummary }> {
  const summary: BackfillSummary = { scanned: 0, claimed: 0, held: 0, failed: 0 };
  const open = await deps.listOpenIssues();
  if (open.ok === false) return { ok: false, summary };
  const run = `legacy-backfill-${isoDay(deps.seam.now())}`;
  for (const row of open.rows) {
    if (!row.labels.includes("in-progress") || row.labels.includes("target-backlog")) continue;
    summary.scanned++;
    try {
      const held = await deps.seam.journal.readClaim(deps.seam.repo, row.number);
      if (held.ok === false) {
        summary.failed++;
        continue;
      }
      if (held.claim !== null) {
        summary.held++;
        continue;
      }
      if (opts.apply !== true) {
        summary.claimed++; // dry-run: would claim
        continue;
      }
      const res = await openClaim(
        { issue: row.number, dispatchId: `legacy-backfill-${row.number}`, class: LEGACY_BACKFILL_CLASS, run, actor: "legacy-backfill" },
        deps.seam,
      );
      if (res.ok === true) summary.claimed++;
      else if (res.code === "claim-held") summary.held++;
      else summary.failed++;
    } catch (err) {
      console.error(`[lifecycle-legacy-backfill] #${row.number} failed:`, err);
      summary.failed++;
    }
  }
  return { ok: summary.failed === 0, summary };
}

export async function main(argv: readonly string[]): Promise<number> {
  const apply = argv.includes("--apply");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const seam = defaultSeamDeps(repoRoot);
  const res = await runBackfill(
    { seam, listOpenIssues: () => listOpenIssues({ repo: seam.repo, limit: 500, timeout: 60_000 }) },
    { apply },
  );
  console.log(JSON.stringify(res.summary));
  return res.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      closeRedisConnections();
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("[lifecycle-legacy-backfill] fatal:", err);
      closeRedisConnections();
      process.exitCode = 1;
    });
}
