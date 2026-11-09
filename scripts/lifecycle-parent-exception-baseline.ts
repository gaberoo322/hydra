/**
 * scripts/lifecycle-parent-exception-baseline.ts — idempotent replay of the
 * parentExceptionRate baseline (ADR-0047 Decision 9, issue #5324).
 *
 *   npx tsx scripts/lifecycle-parent-exception-baseline.ts [--ledger <state.json>] [--dry-run]
 *
 * Replays every Autopilot Run it can see (runs:index + turn rows in Redis, the
 * 7d TTL window) plus, with `--ledger`, the live Run Ledger, into per-run rows
 * keyed by run_id in config/orchestrator/builder-health-baselines.json. Rows
 * already in the file are kept and a re-seen run keeps whichever of its rows has more turns, so the
 * script is re-runnable: after ~5 weekly runs the file holds a true 30d
 * baseline. `summary` is recomputed over rows within 30d of the newest row and
 * records the real covered span (a baseline that covers 3 days says 3 days).
 * Prints one JSON line. Exit 0 ok, 1 failure, 2 usage.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILDER_HEALTH_BASELINES_PATH,
  baselineRowFor,
  ledgerToRunTurns,
  mergeBaselineRow,
  summarizeBaselineRows,
  type BaselineRunRow,
  filterMirrorRuns,
  type RunTurns,
} from "../src/aggregators/lifecycle-health.ts";
import { listAutopilotRunTurnsDesc, listAutopilotRunsSince } from "../src/redis/autopilot-runs.ts";
import { closeRedisConnections } from "../src/redis/connection.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WINDOW_DAYS = 30;

async function main(argv: string[]): Promise<number> {
  let ledgerPath: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--ledger" && argv[i + 1] !== undefined) ledgerPath = argv[++i];
    else {
      console.error("usage: lifecycle-parent-exception-baseline.ts [--ledger <state.json>] [--dry-run]");
      return 2;
    }
  }

  const file = resolve(REPO_ROOT, BUILDER_HEALTH_BASELINES_PATH);
  const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  const section = (doc.parentExceptionRate ??= {});
  const rows: Record<string, BaselineRunRow> = (section.rows ??= {});

  const runs: RunTurns[] = [];
  const sinceEpoch = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
  for (const run of await listAutopilotRunsSince(sinceEpoch)) {
    runs.push({
      runId: run.runId,
      startedEpoch: run.startedEpoch,
      members: await listAutopilotRunTurnsDesc(run.runId, 5000),
    });
  }
  // Redis runs that predate the per-turn mirror carry no data; drop them.
  runs.splice(0, runs.length, ...filterMirrorRuns(runs));
  if (ledgerPath !== null) {
    const live = ledgerToRunTurns(JSON.parse(await readFile(ledgerPath, "utf8")));
    if (live === null) {
      console.error(`[baseline] ${ledgerPath} is not a Run Ledger document (run_id/started_epoch/turn)`);
      return 1;
    }
    // Redis may already hold this run; the ledger is the fuller record while live.
    const at = runs.findIndex((r) => r.runId === live.runId);
    if (at >= 0) runs[at] = live;
    else runs.push(live);
  }

  // A run near the 7d TTL has lost early turn rows; never shrink a stored row.
  for (const run of runs) rows[run.runId] = mergeBaselineRow(rows[run.runId], baselineRowFor(run));
  section.baseline = summarizeBaselineRows(rows, new Date().toISOString());

  if (!dryRun) await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, dryRun, replayed: runs.length, rows: Object.keys(rows).length, baseline: section.baseline }));
  return 0;
}

main(process.argv.slice(2))
  .then(async (code) => {
    await closeRedisConnections();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[baseline] failed:", err);
    await closeRedisConnections();
    process.exit(1);
  });
