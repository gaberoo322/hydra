/**
 * scripts/qa/preflight.ts — hydra-qa steps 1-6.7 in one READ-ONLY call
 * (issue #5269, ADR-0046 Decision 7).
 *
 *   node --experimental-strip-types scripts/qa/preflight.ts --issue N [--pr N] [--repo owner/name]
 *
 * Prints ONE JSON object validated by `PreflightResultSchema`. It performs
 * zero writes (no labels, comments, checkout, Redis): the only mutation-shaped
 * command is `git fetch origin <base>`, which moves a remote-tracking ref and
 * nothing in the work tree. Every engine decision (admission, fanout) is the
 * qa-verdict engine's; this file only gathers the facts and applies the
 * fail-closed defaults the playbook used to carry in bash:
 *   - unreachable tier classifier  -> tier.num null, adversarial true
 *   - checks fetch failure         -> the engine's rollup-only all-optional mapping
 *   - admission produced no action -> admit (full fan-out)
 *   - fanout failure               -> the tier fan-out, "kept the tier path"
 *   - resolve unreachable in warn  -> the Phase A skip reason
 * `ok:false` (no-issue | no-pr | spec-missing-enforce) is exit 0; exit 2 is
 * usage/schema only; exit 1 is "no result could be produced".
 */

import {
  DEFAULT_REPO,
  UsageError,
  defaultGh,
  defaultGit,
  defaultHttpGet,
  finish,
  flagValue,
  intFlag,
  isEntrypoint,
  isRecord,
  productionPhaseRunner,
  usageExit,
  type CmdRunner,
  type HttpGet,
  type PhaseRunner,
} from "./common.ts";
import { PreflightResultSchema, type PreflightResult } from "../../src/schemas/qa-plumbing-cli.ts";

const ORCH_API = "http://localhost:4000";

export interface PreflightDeps {
  gh: CmdRunner;
  git: CmdRunner;
  httpGet: HttpGet;
  phase: PhaseRunner;
  env: Record<string, string | undefined>;
}

export interface PreflightArgs {
  issue?: number;
  pr?: number;
  repo: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error("[qa-preflight] JSON parse failed:", err);
    return undefined;
  }
}

function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : ""))
    .filter((n) => n.length > 0);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function runPreflight(args: PreflightArgs, deps: PreflightDeps): Promise<PreflightResult> {
  const { gh, git, httpGet, phase, env } = deps;
  const repo = args.repo;
  const degraded: string[] = [];

  // 1. Select issue.
  let issue = args.issue;
  if (issue === undefined) {
    const r = gh(["issue", "list", "--repo", repo, "--label", "needs-qa", "--state", "open", "--json", "number,title"]);
    const first = r.ok ? parseJson(r.stdout) : undefined;
    const n = Array.isArray(first) && isRecord(first[0]) ? first[0].number : undefined;
    if (typeof n !== "number") {
      return { ok: false, stage: "no-issue", issue: null, pr: null, message: null, commentTarget: null, degraded };
    }
    issue = n;
  }

  // 2. Find the linked PR.
  let prNumber = args.pr;
  if (prNumber === undefined) {
    const r = gh([
      "pr", "list", "--repo", repo, "--state", "open",
      "--json", "number,title,body,headRefOid,baseRefName,labels",
    ]);
    const list = r.ok ? parseJson(r.stdout) : undefined;
    const re = new RegExp(`(?:closes|fixes) #${issue}(?!\\d)`, "i");
    if (Array.isArray(list)) {
      const hit = list.find((p) => isRecord(p) && typeof p.body === "string" && re.test(p.body));
      if (isRecord(hit) && typeof hit.number === "number") prNumber = hit.number;
    }
    if (prNumber === undefined) {
      return {
        ok: false,
        stage: "no-pr",
        issue,
        pr: null,
        message:
          `> *Automated QA — no linked PR*\n\nNo open PR with \`Closes #${issue}\` was found for this issue, so there is nothing to review. QA has exited.`,
        commentTarget: "issue",
        degraded,
      };
    }
  }

  // 3. Pin the fixed point (one gh pr view carries every PR fact).
  const view = gh([
    "pr", "view", String(prNumber), "--repo", repo,
    "--json", "baseRefName,mergeStateStatus,headRefName,headRefOid,labels,body",
  ]);
  const prJson = view.ok ? parseJson(view.stdout) : undefined;
  if (!isRecord(prJson)) throw new Error(`gh pr view ${prNumber} failed or returned a non-object payload`);
  const baseRefName = str(prJson.baseRefName);
  const headRefName = str(prJson.headRefName);
  const mergeStateStatus = str(prJson.mergeStateStatus);
  const prLabels = labelNames(prJson.labels);
  const prBody = str(prJson.body);
  const glmAuthored = headRefName.startsWith("worktree-agent-glm-") || prLabels.includes("glm-authored");

  const fetched = git(["fetch", "origin", baseRefName]);
  if (!fetched.ok) throw new Error(`git fetch origin ${baseRefName} failed: ${fetched.stderr}`);
  const rev = git(["rev-parse", `origin/${baseRefName}`]);
  if (!rev.ok) throw new Error(`git rev-parse origin/${baseRefName} failed: ${rev.stderr}`);
  const fixedSha = rev.stdout.trim();
  const headSha = str(prJson.headRefOid);

  const diffNames = git(["diff", "--no-renames", "--name-only", `${fixedSha}...HEAD`]);
  if (!diffNames.ok) degraded.push("changed-paths");
  const changedPaths = diffNames.ok ? diffNames.stdout.split("\n").filter((l) => l.length > 0) : [];

  // 4. Resolve the spec source — design-concept artifact.
  const parentMatch = /(?:closes|fixes|refs)\s*#(\d+)/i.exec(prBody);
  const parentIssue = parentMatch ? (parentMatch[1] as string) : "";
  const mode = env.DESIGN_CONCEPT_MODE || "warn";
  let resolve: Record<string, unknown> | null = null;
  if (parentIssue !== "") {
    const got = await httpGet(`${ORCH_API}/api/design-concepts/${parentIssue}/resolve`);
    const parsed = got ? parseJson(got.body) : undefined;
    if (isRecord(parsed)) resolve = parsed;
  }
  const resolveFound = resolve !== null && resolve.found === true;

  let issueLabels: string[] = [];
  if (parentIssue !== "") {
    const r = gh(["issue", "view", parentIssue, "--repo", repo, "--json", "labels"]);
    const parsed = r.ok ? parseJson(r.stdout) : undefined;
    if (isRecord(parsed)) issueLabels = labelNames(parsed.labels);
    else degraded.push("issue-labels");
  }
  const hasPrExempt = prLabels.includes("design-concept-exempt");
  const hasCleanup = issueLabels.includes("cleanup-scan");
  const hasIssueExempt = issueLabels.includes("design-concept-exempt");

  let specInput: Record<string, unknown> | null = null;
  let skippedReason: string | null = null;
  if (resolveFound) {
    const concept = (resolve as Record<string, unknown>).concept;
    specInput = isRecord(concept) ? concept : null;
  } else if (hasPrExempt) {
    skippedReason = "design-concept-exempt label present (operator override)";
  } else if (hasCleanup || hasIssueExempt) {
    skippedReason = hasCleanup
      ? "cleanup-scan label present on parent issue (deterministic-exempt class)"
      : "design-concept-exempt label present on parent issue (deterministic-exempt class)";
  } else if (mode === "enforce") {
    const reason = str(resolve?.reason) || "design-concept artifact missing";
    const handle = isRecord(resolve?.handle) ? str((resolve?.handle as Record<string, unknown>).redisKey) : "";
    return {
      ok: false,
      stage: "spec-missing-enforce",
      issue,
      pr: prNumber,
      message:
        `> *Automated QA — design-concept artifact required*\n\n` +
        `This PR cannot be reviewed because the design-concept artifact for issue #${parentIssue} is not persisted/retrievable.\n\n` +
        `**Resolver reason:** ${reason}\n**Stable handle probed:** \`${handle || "(handle unknown)"}\`\n\n` +
        `**To unblock:**\n1. Run \`hydra-grill\` on issue #${parentIssue} to produce the artifact, OR\n` +
        `2. Apply the \`design-concept-exempt\` label (operator-only — audit-logged) to bypass the Spec axis.\n\n` +
        `QA mode: \`${mode}\`. See [epic #437](https://github.com/gaberoo322/hydra/issues/437) for the design-concept gate rollout plan.`,
      commentTarget: "pr",
      degraded,
    };
  } else {
    const reason = str(resolve?.reason) || "design-concept artifact missing (resolve unreachable)";
    console.error(`WARN: ${reason} — proceeding in Phase A shadow mode (Standards axis only).`);
    skippedReason = `no persisted artifact (Phase A shadow mode — DESIGN_CONCEPT_MODE=${mode}): ${reason}`;
  }

  // 5. CI state (the engine's checks phase owns the rollup fold + INV-7 fallback).
  const checksOut = await phase("checks", { pr: prNumber });
  let checksList: unknown[] | null = null;
  const checksDegraded: string[] = [];
  if (checksOut === null) {
    checksDegraded.push("checks-phase");
  } else {
    checksList = Array.isArray(checksOut.checks) ? (checksOut.checks as unknown[]) : null;
    if (Array.isArray(checksOut.degraded)) checksDegraded.push(...(checksOut.degraded as string[]));
  }

  // 6.5 Tier — the single authority is the live classifier; unreachable => deeper path.
  let tierNum: number | null = null;
  {
    const csv = changedPaths.join(",");
    const got = await httpGet(`${ORCH_API}/api/tier?files=${encodeURIComponent(csv)}`);
    const parsed = got && got.status >= 200 && got.status < 300 ? parseJson(got.body) : undefined;
    if (isRecord(parsed) && typeof parsed.tier === "number") tierNum = parsed.tier;
  }
  if (tierNum === null) console.error("WARN: tier classifier unreachable — defaulting to T3 adversarial QA (over-verify).");
  let adversarial = tierNum === null || tierNum >= 3;

  // 6 / 6.6 Admission — one engine call answers the bypass, the gate and the red-required list.
  const admissionInput: Record<string, unknown> = { pr: prNumber, tier: tierNum, changedPaths };
  if (checksList !== null) admissionInput.checks = checksList;
  if (mergeStateStatus !== "") admissionInput.mergeStateStatus = mergeStateStatus;
  const adm = await phase("admission", admissionInput);
  const admission = adm !== null && isRecord(adm.admission) ? adm.admission : null;
  let gateAction = "admit" as "admit" | "defer" | "skip-required-failed";
  let gateReason = "gate produced no output; fail-closed to full review";
  if (admission !== null && typeof admission.action === "string") {
    gateAction = admission.action as typeof gateAction;
    gateReason = str(admission.reason);
  } else {
    console.error("WARN: reviewer admission gate produced no action — fail-closed to admit (full fan-out).");
    degraded.push("admission");
  }
  const redRequired = adm && Array.isArray(adm.redRequired) ? (adm.redRequired as string[]) : [];
  if (adm?.promptOnly === true && specInput === null && skippedReason === null) {
    skippedReason = "Tier-1 auto-bypass (diff is prompt-only and no artifact present)";
  }
  const skipVerdict =
    gateAction === "skip-required-failed" && adm && isRecord(adm.skipVerdict)
      ? { verdict: str(adm.skipVerdict.verdict) || "FAIL", reason: str(adm.skipVerdict.reason) || "required CI check failed" }
      : gateAction === "skip-required-failed"
        ? { verdict: "FAIL", reason: "required CI check failed" }
        : null;
  const skipCiSummary =
    gateAction === "skip-required-failed" ? (typeof adm?.skipCiSummary === "string" ? adm.skipCiSummary : "_(checks block unavailable)_") : null;

  // 6.7 Fan-out sizing (admit only).
  let fanout = { mode: "none", reviewers: [] as string[], reason: "" };
  if (gateAction === "admit") {
    const fo = await phase("fanout", { pr: prNumber, tier: tierNum, changedPaths });
    if (fo !== null && typeof fo.mode === "string" && fo.mode !== "") {
      fanout = {
        mode: fo.mode,
        reviewers: Array.isArray(fo.reviewers) ? (fo.reviewers as string[]) : [],
        reason: str(fo.reason),
      };
    } else {
      console.error("WARN: fan-out sizing failed — keeping the tier fan-out.");
      degraded.push("fanout");
      const mode2 = adversarial ? "adversarial" : "standard";
      fanout = {
        mode: mode2,
        reviewers: adversarial
          ? ["reviewer-A-standards", "reviewer-A-spec", "reviewer-B-standards", "reviewer-B-spec"]
          : ["standards", "spec"],
        reason: `Review fan-out: ${mode2} — change-shape sizing unavailable, kept the tier path.`,
      };
    }
    if (fanout.mode === "single") adversarial = false;
  }

  return {
    ok: true,
    stage: "ready",
    issue,
    repo,
    pr: { number: prNumber, headSha, headRefName, baseRefName, mergeStateStatus, glmAuthored },
    fixedSha,
    changedPaths,
    checks: { list: checksList as never, degraded: checksDegraded },
    spec: { found: resolveFound, input: specInput, skippedReason, mode },
    tier: { num: tierNum, adversarial },
    gate: { action: gateAction, reason: gateReason, redRequired, skipVerdict, skipCiSummary },
    fanout,
    degraded,
  };
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  const repo = flagValue(argv, "--repo", DEFAULT_REPO) as string;
  const issue = intFlag(argv, "--issue");
  const pr = intFlag(argv, "--pr");
  if (issue === undefined && pr === undefined && argv.includes("--issue")) {
    usageExit([{ message: "--issue must be a positive integer" }]);
  } else {
    try {
      const phase = await productionPhaseRunner(repo);
      const result = await runPreflight(
        { issue, pr, repo },
        { gh: defaultGh, git: defaultGit, httpGet: defaultHttpGet, phase, env: process.env },
      );
      const parsed = PreflightResultSchema.safeParse(result);
      if (!parsed.success) usageExit(parsed.error.issues);
      else finish(0, parsed.data);
    } catch (err) {
      console.error(err instanceof UsageError ? err.message : "[qa-preflight] no result produced:", err);
      finish(1);
    }
  }
}
