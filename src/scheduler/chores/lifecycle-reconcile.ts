/**
 * Lifecycle reconcile chore (ADR-0047 D1/D2/D4/D5, issue #5316).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`): an hourly,
 * intrinsically idempotent tick that journals out-of-seam label changes as
 * `external`, fires record-checked `qa-passed` exits and the zero-state
 * backstop through the seam, and persists the enforce-readiness report the
 * attention feed and `scripts/lifecycle.ts reconcile --report` read. The pass
 * itself lives in `src/lifecycle/reconcile.ts`; this module only wires the
 * production deps. NEVER THROWS: any fault folds to a logged `null`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../../logger.ts";
import { listIssuesBySearch, listOpenIssues, resolveGithubRepo } from "../../github/issues.ts";
import { listOpenPrs } from "../../github/prs.ts";
import { defaultSeamDeps } from "../../lifecycle/seam.ts";
import {
  RECENTLY_CLOSED_LIMIT,
  runReconcile,
  type ReconcileDeps,
  type ReconcileOptions,
  type ReconcileReport,
} from "../../lifecycle/reconcile.ts";
import { persistJournal, writeReconcileReport } from "../../redis/lifecycle-journal.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Production deps: real gh, real Redis, mode from the git-tracked rollout config. */
export function defaultReconcileDeps(repoRoot: string = REPO_ROOT): ReconcileDeps {
  const seam = defaultSeamDeps(repoRoot);
  return {
    seam,
    listOpenIssues: () => listOpenIssues({ repo: seam.repo, limit: 500, timeout: 60_000 }),
    listOpenPrs: async () => {
      const res = await listOpenPrs({ repo: seam.repo, limit: 200, fields: "number,body", timeout: 60_000 });
      if (res.ok === false) return { ok: false };
      return { ok: true, value: res.rows.map((p) => ({ number: p.number, body: p.body ?? "" })) };
    },
    listRecentlyClosed: (sinceIso) =>
      listIssuesBySearch(`closed:>=${sinceIso}`, { repo: seam.repo, state: "closed", limit: RECENTLY_CLOSED_LIMIT }),
    persistJournal,
    writeReport: (report, ts) => writeReconcileReport(resolveGithubRepo(seam.repo), report, ts),
  };
}

/** Run the pass with production deps. Never throws; null on a crash. */
export async function runLifecycleReconcile(
  opts: ReconcileOptions = {},
  deps?: ReconcileDeps,
): Promise<ReconcileReport | null> {
  try {
    const report = await runReconcile(deps ?? defaultReconcileDeps(), opts);
    logger.info(
      {
        open: report.scanned.open,
        invalid: report.invalid.length,
        zeroStateRelabeled: report.zeroStateRelabeled.length,
        externalEntries: report.externalEntries,
        capResetsPosted: report.capResetsPosted,
        errors: report.errors,
      },
      "[lifecycle-reconcile] pass complete",
    );
    return report;
  } catch (err) {
    logger.error({ err }, "[lifecycle-reconcile] chore failed");
    return null;
  }
}
