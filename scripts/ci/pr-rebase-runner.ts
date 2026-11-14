/**
 * scripts/ci/pr-rebase-runner.ts — thin runner for the hydra-pr-rebase skill.
 *
 * Reads the JSON array printed by
 *   gh pr list --repo gaberoo322/hydra --state open --limit 100 \
 *     --json number,mergeStateStatus,headRefName,labels,headRefOid
 * on stdin, classifies every row through `classifyBatch` (pr-rebase.ts) and
 * prints `{ report, plan }` as JSON on stdout. The apply step stays plain `gh`
 * calls driven from `plan` (same shape as branch-prune-runner.ts).
 *
 * Bad stdin exits 2 with a message; individual malformed rows are dropped and
 * counted in `plan.malformed`.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  classifyBatch,
  renderReport,
  type MergeStateStatus,
  type PullRequestRow,
} from "./pr-rebase.ts";

export interface RebaseStep {
  number: number;
  headRefName: string;
  /** Head SHA observed at list time — pass as `expected_head_sha` to update-branch. */
  expectedHeadSha: string | null;
}

export interface RunnerPlan {
  rebase: RebaseStep[];
  surface: Array<{ number: number; headRefName: string }>;
  skipped: number;
  /** Rows dropped because they lacked a numeric `number` or a string `mergeStateStatus`. */
  malformed: number;
}

export interface RunnerOutput {
  report: string;
  plan: RunnerPlan;
}

function toRow(raw: unknown): PullRequestRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.number !== "number" || typeof r.mergeStateStatus !== "string") return null;
  const labels = Array.isArray(r.labels)
    ? r.labels.filter(
        (l): l is { name: string } =>
          typeof l === "object" && l !== null && typeof (l as { name?: unknown }).name === "string",
      )
    : [];
  return {
    number: r.number,
    mergeStateStatus: r.mergeStateStatus as MergeStateStatus,
    headRefName: typeof r.headRefName === "string" ? r.headRefName : "",
    labels,
    headRefOid: typeof r.headRefOid === "string" ? r.headRefOid : undefined,
  };
}

/** Pure: raw `gh pr list --json` rows + a date label → action plan + report. */
export function buildRunnerOutput(rawRows: unknown[], when: string): RunnerOutput {
  const rows: PullRequestRow[] = [];
  let malformed = 0;
  for (const raw of rawRows) {
    const row = toRow(raw);
    if (row) rows.push(row);
    else malformed++;
  }
  const buckets = classifyBatch(rows);
  return {
    report: renderReport(buckets, when),
    plan: {
      rebase: buckets.rebase.map((r) => ({
        number: r.number,
        headRefName: r.headRefName,
        expectedHeadSha: r.headRefOid ?? null,
      })),
      surface: buckets.surface.map((r) => ({ number: r.number, headRefName: r.headRefName })),
      skipped: buckets.skip.length,
      malformed,
    },
  };
}

function main(): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(0, "utf-8"));
  } catch (err) {
    console.error("pr-rebase-runner: stdin is not valid JSON:", err);
    process.exit(2);
  }
  if (!Array.isArray(parsed)) {
    console.error("pr-rebase-runner: stdin must be the JSON array from `gh pr list --json ...`");
    process.exit(2);
  }
  const when = new Date().toISOString().slice(0, 10);
  process.stdout.write(JSON.stringify(buildRunnerOutput(parsed, when)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
