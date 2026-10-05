/**
 * src/glm/pick.ts — the GLM drainer's PICK phase (ADR-0040 Decision 1-2, third
 * phase; epic #4681, issue #4686).
 *
 * `runPick(deps)` replaces seven bash functions in `scripts/glm/drainer-loop.sh`
 * (`pick_eligible_issue`, `is_grill_clear`, `has_approved_design_concept`,
 * `issue_has_open_pr`, `issue_has_merged_pr`, `recover_stale_glm_claims`,
 * `find_resumable_branch`). Since zeta (#4687, ADR-0040 Decision 6) it rules
 * on every candidate through the ONE predicate, `glmPickVerdict` from
 * `./eligibility.ts`, and carries no eligibility rule of its own. What stays
 * here is not a rule: the candidate denominator, `updatedAt` ordering, I/O
 * staging (one batched blocker lookup, a lazy per-candidate artifact fetch),
 * stale-claim recovery, resume-branch detection and last-pick publication.
 *
 * Never throws: every dependency rejection resolves to a result (idle).
 * Dry-run (`HYDRA_GLM_DRAINER_DRY_RUN=1`) is hermetic — no gh, git,
 * subprocess, HTTP, or Redis.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ORCH_BOARD_LABELS } from "../board-labels.ts";
import { logger } from "../logger.ts";
import { extractStrictBlockerRefs, fetchOpenBlockerNumbers } from "../github/blockers.ts";
import {
  glmPickVerdict,
  type GlmPickArtifact,
  type GlmPickableReason,
  type GlmUnpickableReason,
} from "./eligibility.ts";
import {
  listIssuesByLabel,
  isIssueReadFailure,
  type IssueReadResult,
  type IssueRow,
} from "../github/issues.ts";
import { listOpenPrs, type PrRow } from "../github/prs.ts";
import { gitExec, lsRemoteHeads } from "../github/git.ts";
import { setGlmDrainerLastPick } from "../redis/autopilot.ts";

/** In-progress issues idle longer than this are re-queued (matches bash, 90 min). */
export const STALE_IN_PROGRESS_SECONDS = 5400;

/** Candidate fetch window — ADR-0040 row 12 (bash used 30). */
export const PICK_FETCH_LIMIT = 100;

const CANDIDATE_FIELDS = "number,updatedAt,labels,body,title";
const RECOVERY_FIELDS = "number,updatedAt,labels";

/** A pushed drainer branch as the resume rule sees it. */
export interface ResumeRow {
  branch: string;
  /** Commits ahead of `origin/master`. */
  aheadCount: number;
  /** Epoch suffix of `worktree-agent-glm-<issue>-<ts>`. */
  ts: number;
}

export type PickResult =
  | {
      issue: number;
      reason: GlmPickableReason;
      resumeBranch: string | null;
      resumeCommits: number | null;
    }
  | { idle: true; skipped: Record<string, number>; dryRun?: true };

/** The design-concept artifact facts, or `null` for 404 / unreachable / unparseable. */
export type ArtifactStatus = GlmPickArtifact | null;

export interface PickDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  /** Journal line sink (stderr in production). */
  log: (msg: string) => void;
  /** `glm-eligible` open issues; `fields` requested by the caller. */
  listGlmEligible: (fields: string, limit: number) => Promise<IssueReadResult<IssueRow>>;
  listOpenPrs: () => Promise<IssueReadResult<PrRow>>;
  listMergedPrs: () => Promise<IssueReadResult<PrRow>>;
  fetchArtifact: (issue: number) => Promise<ArtifactStatus>;
  /** Which of the given issue numbers are currently OPEN (fail-safe: full set on failure). */
  fetchOpenBlockers: (numbers: number[]) => Promise<ReadonlySet<number>>;
  /** Runs `recover-stale.sh stale_in_progress <n...> stale_blocked`; resolves its exit code. */
  runRecoverStale: (issues: number[]) => Promise<number>;
  listResumeRows: (issue: number) => Promise<ResumeRow[]>;
  publishLastPick: (verdict: {
    picked: number | null;
    reason: string;
    candidates: number;
    skipped: Record<string, number>;
  }) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/**
 * Newest ahead-of-master pushed branch: keep `aheadCount >= 1`, sort by `ts`
 * descending, return the first, or `null`. A head at 0 commits ahead (an
 * empty / rewound attempt) is skipped, never returned.
 */
export function pickResumeBranch(rows: readonly ResumeRow[]): ResumeRow | null {
  const ahead = rows.filter((r) => Number.isFinite(r.aheadCount) && r.aheadCount >= 1);
  if (ahead.length === 0) return null;
  return [...ahead].sort((a, b) => b.ts - a.ts)[0];
}

/** Epoch suffix of `worktree-agent-glm-<issue>-<ts>`, or `null` when not numeric. */
export function resumeBranchTs(branch: string): number | null {
  const m = /-(\d+)$/.exec(branch);
  return m ? Number(m[1]) : null;
}

/** Rows without a positive-integer `number` are ignored by the gh readers already. */
function hasLabel(row: IssueRow, label: string): boolean {
  return row.labels.includes(label);
}

function bump(h: Record<string, number>, key: GlmUnpickableReason): void {
  h[key] = (h[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// runPick
// ---------------------------------------------------------------------------

/** Pure config read: names match what the bash driver read. */
function readConfig(env: NodeJS.ProcessEnv): { dryRun: boolean } {
  return { dryRun: env.HYDRA_GLM_DRAINER_DRY_RUN === "1" };
}

async function recoverStaleClaims(deps: PickDeps): Promise<void> {
  const res = await deps.listGlmEligible(RECOVERY_FIELDS, PICK_FETCH_LIMIT);
  if (isIssueReadFailure(res)) return; // silent no-op, as bash
  const now = deps.now();
  const stale: number[] = [];
  for (const row of res.rows) {
    if (!hasLabel(row, ORCH_BOARD_LABELS.in_progress)) continue;
    const updated = Date.parse(row.updatedAt ?? "");
    if (!Number.isFinite(updated)) continue;
    if ((now - updated) / 1000 > STALE_IN_PROGRESS_SECONDS) stale.push(row.number);
  }
  if (stale.length === 0) return;
  deps.log(`recovering ${stale.length} stale glm-eligible in-progress issue(s): ${stale.join(" ")}`);
  const code = await deps.runRecoverStale(stale);
  if (code !== 0) deps.log("WARN recover-stale.sh exited non-zero (non-fatal)");
}

type PickMeta = { candidates?: number; histogram?: Record<string, number> };

async function pickInner(deps: PickDeps): Promise<PickResult & PickMeta> {
  // INV-6: recovery re-queues stale claims as ready-for-agent, so it runs
  // BEFORE the candidate fetch (bash could pick a just-recovered issue).
  await recoverStaleClaims(deps);

  const listed = await deps.listGlmEligible(CANDIDATE_FIELDS, PICK_FETCH_LIMIT);
  const rows = isIssueReadFailure(listed)
    ? []
    : listed.rows.filter((r) => hasLabel(r, ORCH_BOARD_LABELS.ready_for_agent));
  const candidates = rows.length;
  const skipped: Record<string, number> = {};

  const ordered = [...rows].sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));

  let openPrs: PrRow[] = [];
  const openRes = await deps.listOpenPrs();
  if (isIssueReadFailure(openRes)) {
    deps.log(
      "WARN gh pr list failed while building the open-PR skip list — proceeding without it this tick (duplicate-dispatch protection degraded, not blocked)",
    );
  } else {
    openPrs = openRes.rows;
  }
  let mergedPrs: PrRow[] = [];
  const mergedRes = await deps.listMergedPrs();
  if (isIssueReadFailure(mergedRes)) {
    deps.log(
      "WARN gh pr list --state merged failed while building the merged-PR skip list — proceeding without it this tick (shipped-work skip degraded, not blocked)",
    );
  } else {
    mergedPrs = mergedRes.rows;
  }

  // One batched blocker lookup over the union of every candidate's strict refs.
  const blockerRefs = new Set<number>();
  for (const row of ordered) {
    for (const n of extractStrictBlockerRefs(row.body)) if (n !== row.number) blockerRefs.add(n);
  }
  const openBlockers: ReadonlySet<number> =
    blockerRefs.size === 0 ? new Set() : await deps.fetchOpenBlockers([...blockerRefs]);

  for (const row of ordered) {
    const n = row.number;
    const base = { openPrs, mergedPrs, openBlockers, now: deps.now() };
    let verdict = glmPickVerdict(row, { ...base, artifact: null });
    // Lazy artifact fetch: the artifact arms are the verdict's LAST checks, so
    // every earlier outcome is independent of the artifact.
    if (!verdict.pickable && verdict.reason === "artifact-missing") {
      verdict = glmPickVerdict(row, { ...base, artifact: await deps.fetchArtifact(n) });
    }
    if (verdict.pickable === false) {
      const why: GlmUnpickableReason = verdict.reason;
      if (why === "open-pr") {
        deps.log(
          `skipping issue #${n} — an open PR already references it (Closes #${n} or equivalent) — not re-dispatching`,
        );
      } else if (why === "merged-pr") {
        deps.log(
          `skipping issue #${n} — a MERGED PR already references it (shipped; the issue is likely open only because that PR body had no closing keyword) — not re-dispatching; close or re-scope the issue by hand`,
        );
      }
      bump(skipped, why);
      continue;
    }
    const reason = verdict.reason;

    deps.log(`picked issue #${n} (grill-clear: ${reason})`);
    let resumeBranch: string | null = null;
    let resumeCommits: number | null = null;
    try {
      const resume = pickResumeBranch(await deps.listResumeRows(n));
      if (resume) {
        resumeBranch = resume.branch;
        resumeCommits = resume.aheadCount;
      }
    } catch (err) {
      logger.error({ err, issue: n }, "[glm-pick] resume-branch listing threw — starting fresh");
    }
    return { issue: n, reason, resumeBranch, resumeCommits, candidates, histogram: skipped };
  }
  deps.log(`idle: candidates=${candidates} skipped=${JSON.stringify(skipped)}`);
  return { idle: true, skipped, candidates, histogram: skipped };
}

/**
 * Run one pick tick. Never throws. Publishes the verdict to Redis on every
 * non-dry-run tick (idle or picked); a publish failure never fails the tick.
 */
export async function runPick(deps: PickDeps): Promise<PickResult> {
  if (readConfig(deps.env).dryRun) {
    deps.log("would-recover-stale glm-eligible in-progress issues (DRY_RUN=1)");
    deps.log("would-pick-eligible-issue (DRY_RUN=1)");
    return { idle: true, skipped: {}, dryRun: true };
  }
  let out: PickResult & PickMeta;
  try {
    out = await pickInner(deps);
  } catch (err) {
    logger.error({ err }, "[glm-pick] pick phase threw — resolving idle");
    out = { idle: true, skipped: {}, candidates: 0 };
  }
  const { candidates, histogram, ...result } = out;
  try {
    await deps.publishLastPick({
      picked: "issue" in result ? result.issue : null,
      reason: "issue" in result ? result.reason : "idle",
      candidates: candidates ?? 0,
      skipped: histogram ?? {},
    });
  } catch (err) {
    logger.error({ err }, "[glm-pick] last-pick publish threw (non-fatal)");
  }
  return result as PickResult;
}

// ---------------------------------------------------------------------------
// Default (real) dependencies
// ---------------------------------------------------------------------------

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Build the production deps from an env (names match what bash read). */
export function buildDefaultPickDeps(env: NodeJS.ProcessEnv = process.env): PickDeps {
  const repo = env.HYDRA_AUTOPILOT_REPO || "gaberoo322/hydra";
  const dcUrl =
    env.HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL || "http://localhost:4000/api/design-concepts";
  const repoRoot = env.HYDRA_GLM_DRAINER_REPO_ROOT || DEFAULT_REPO_ROOT;
  return {
    env,
    now: () => Date.now(),
    log: (msg) => {
      process.stderr.write(`hydra-glm-drainer: ${msg}\n`);
    },
    listGlmEligible: (fields, limit) =>
      listIssuesByLabel(ORCH_BOARD_LABELS.glm_eligible, { repo, state: "open", fields, limit }),
    listOpenPrs: () =>
      listOpenPrs({ repo, state: "open", fields: "number,body,headRefName", limit: 100 }),
    listMergedPrs: () =>
      listOpenPrs({ repo, state: "merged", fields: "number,title,body", limit: 100 }),
    fetchOpenBlockers: (numbers) => fetchOpenBlockerNumbers(numbers, { githubRepo: repo }),
    fetchArtifact: async (issue) => {
      try {
        const res = await fetch(`${dcUrl}/issue-${issue}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return null;
        const json = (await res.json()) as { status?: unknown; createdAt?: unknown };
        return {
          status: typeof json?.status === "string" ? json.status : "parse-error",
          createdAt: typeof json?.createdAt === "number" ? json.createdAt : Number.NaN,
        };
      } catch (err) {
        logger.warn({ err, issue }, "[glm-pick] design-concept fetch failed — treating as not approved");
        return null;
      }
    },
    runRecoverStale: (issues) =>
      runRecoverStaleScript(`${repoRoot}/scripts/autopilot/recover-stale.sh`, issues),
    listResumeRows: async (issue) => {
      // Fetch failure is ignored (bash: `|| true`); listing failure -> no rows.
      await gitExec(["fetch", "origin", "--quiet"], { cwd: repoRoot });
      const heads = await lsRemoteHeads(`worktree-agent-glm-${issue}-*`, { cwd: repoRoot });
      if (!heads.ok) return [];
      const rows: ResumeRow[] = [];
      for (const h of heads.data) {
        const ts = resumeBranchTs(h.branch);
        if (ts === null) continue;
        const counted = await gitExec(["rev-list", "--count", `origin/master..${h.sha}`], {
          cwd: repoRoot,
        });
        const n = counted.ok ? Number(counted.data.stdout.trim()) : 0;
        rows.push({ branch: h.branch, aheadCount: Number.isFinite(n) ? n : 0, ts });
      }
      return rows;
    },
    publishLastPick: (verdict) => setGlmDrainerLastPick(verdict),
  };
}

/**
 * Spawn recover-stale.sh with its stdout routed to OUR stderr (fd 2). The
 * driver's stdout must carry exactly one JSON line (INV-10); the script's
 * `[autopilot] recover-stale: ...` progress lines would otherwise precede it
 * and break the bash loop's jq parse (false idle tick). Resolves the exit code.
 */
export function runRecoverStaleScript(script: string, issues: number[]): Promise<number> {
  return new Promise<number>((res) => {
    const child = spawn("bash", [script, "stale_in_progress", ...issues.map(String), "stale_blocked"], {
      stdio: ["ignore", 2, "inherit"],
    });
    child.on("error", (err) => {
      logger.error({ err }, "[glm-pick] recover-stale.sh failed to spawn");
      res(1);
    });
    child.on("close", (code) => res(code ?? 1));
  });
}
