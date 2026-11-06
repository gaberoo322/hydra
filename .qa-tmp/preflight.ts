/**
 * scripts/qa/preflight.ts — hydra-qa steps 1–6.7 in ONE call (issue #5269,
 * ADR-0046 Decision 7).
 *
 *   node --experimental-strip-types scripts/qa/preflight.ts \
 *     --issue N [--pr N] [--repo owner/name]
 *
 * READ-ONLY: no label, comment, checkout or Redis write. Prints ONE JSON
 * object ({@link PreflightResultSchema}). Every unknown fails closed exactly
 * as the playbook's bash did: an unreachable tier classifier is `tier.num:
 * null, adversarial: true`; a failed admission call is `admit`; a failed
 * fan-out sizing keeps the tier fan-out; an unreadable checks fetch is the
 * rollup-only all-optional mapping tagged in `degraded`. `ok:false` (with a
 * `stage`) is still exit 0 — the playbook stub posts `stop` and ends; exit 2 is
 * usage only, exit 1 means no result could be produced.
 *
 * Every verdict-adjacent decision (admission, fan-out) is the engine's, via
 * `runQaVerdictPhase`; nothing is re-implemented here.
 */

import {
  DEFAULT_API_BASE,
  DEFAULT_REPO,
  createProductionPorts,
  flagValue,
  intFlag,
  isEntrypoint,
  isRecord,
  runCli,
  tryParse,
  type PlumbingPorts,
} from "./_lib.ts";
import { PreflightResultSchema, type PreflightResult } from "../../src/schemas/qa-plumbing-cli.ts";

export interface PreflightOptions {
  issue?: number;
  pr?: number;
  repo: string;
  /** `warn` (Phase A) or `enforce` — `$DESIGN_CONCEPT_MODE`. */
  mode: string;
}

const NO_CHECKS: PreflightResult["checks"] = { list: [], degraded: true, source: null };
const NO_FANOUT: PreflightResult["fanout"] = { mode: "standard", reviewers: [], reason: "no review fan-out on this stage" };
const NO_GATE: PreflightResult["gate"] = {
  action: "admit",
  reason: "no gate on this stage",
  redRequired: [],
  skipVerdict: null,
  skipCiSummary: null,
};

function stopResult(
  stage: PreflightResult["stage"],
  issue: number | null,
  stop: PreflightResult["stop"],
  rest: Partial<PreflightResult> = {},
): PreflightResult {
  return {
    ok: false,
    stage,
    issue,
    pr: null,
    fixedSha: null,
    changedPaths: [],
    checks: NO_CHECKS,
    spec: { found: false, input: null, skippedReason: null, mode: "warn" },
    tier: { num: null, adversarial: true },
    gate: NO_GATE,
    fanout: NO_FANOUT,
    stop,
    degraded: [],
    ...rest,
  };
}

/** The first `Closes|Fixes|Refs #N` issue number in a PR body (the step-4 grep). */
export function parentIssueOf(body: string): number | null {
  const m = /(?:closes|fixes|refs)\s*#(\d+)/i.exec(body);
  return m ? Number(m[1]) : null;
}

async function ghJson(ports: PlumbingPorts, args: string[]): Promise<unknown | undefined> {
  const r = await ports.gh(args);
  if (!r.ok) return undefined;
  return tryParse(r.stdout);
}

/** A LIST read where a failed call must NOT read as "nothing found": a failure throws (pre-stage exit). */
async function ghList(ports: PlumbingPorts, args: string[]): Promise<unknown[]> {
  const r = await ports.gh(args);
  if (!r.ok) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${r.stderr}`);
  const v = tryParse(r.stdout);
  if (!Array.isArray(v)) throw new Error(`gh ${args.slice(0, 2).join(" ")} returned no readable list`);
  return v;
}

function labelNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((l) => (isRecord(l) && typeof l.name === "string" ? l.name : "")).filter((n) => n !== "");
}

function enforceStopBody(parent: number | null, mode: string, reason: string, handle: string): string {
  return `> *Automated QA — design-concept artifact required*

This PR cannot be reviewed because the design-concept artifact for issue #${parent ?? "?"} is not persisted/retrievable.

**Resolver reason:** ${reason}
**Stable handle probed:** \`${handle}\`

**To unblock:**
1. Run \`hydra-grill\` on issue #${parent ?? "?"} to produce the artifact, OR
2. Apply the \`design-concept-exempt\` label (operator-only — audit-logged) to bypass the Spec axis.

QA mode: \`${mode}\`. See [epic #437](https://github.com/gaberoo322/hydra/issues/437) for the design-concept gate rollout plan.`;
}

export async function runPreflight(opts: PreflightOptions, ports: PlumbingPorts): Promise<PreflightResult> {
  const { repo } = opts;
  const degraded: string[] = [];

  // 1. Select issue.
  let issue = opts.issue ?? null;
  if (issue === null) {
    const list = await ghList(ports, [
      "issue", "list", "--repo", repo, "--label", "needs-qa", "--state", "open", "--json", "number", "--limit", "1",
    ]);
    const first = Array.isArray(list) && isRecord(list[0]) ? list[0].number : undefined;
    if (typeof first !== "number") return stopResult("no-issue", null, null);
    issue = first;
  }

  // 2. Find the linked open PR.
  let prNumber = opts.pr ?? null;
  if (prNumber === null) {
    const open = await ghList(ports, [
      "pr", "list", "--repo", repo, "--state", "open", "--json", "number,body", "--limit", "200",
    ]);
    const re = new RegExp(`(?:closes|fixes) #${issue}(?!\\d)`, "i");
    if (Array.isArray(open)) {
      for (const p of open) {
        if (isRecord(p) && typeof p.number === "number" && typeof p.body === "string" && re.test(p.body)) {
          prNumber = p.number;
          break;
        }
      }
    }
  }
  if (prNumber === null) {
    return stopResult("no-pr", issue, {
      target: "issue",
      body: `> *Automated QA — no linked PR*\n\nQA found no open PR whose body closes #${issue} (\`Closes #${issue}\` / \`Fixes #${issue}\`). Nothing to review; the issue's labels are unchanged.`,
    });
  }

  // 3. Pin the fixed point.
  const view = await ghJson(ports, [
    "pr", "view", String(prNumber), "--repo", repo, "--json",
    "baseRefName,mergeStateStatus,headRefName,headRefOid,labels,body",
  ]);
  if (!isRecord(view)) throw new Error(`gh pr view ${prNumber} returned no readable payload`);
  const baseRefName = String(view.baseRefName ?? "");
  const headRefName = String(view.headRefName ?? "");
  const prLabels = labelNames(view.labels);
  const body = typeof view.body === "string" ? view.body : "";
  const mergeStateStatus = typeof view.mergeStateStatus === "string" ? view.mergeStateStatus : "";
  const glmAuthored = headRefName.startsWith("worktree-agent-glm-") || prLabels.includes("glm-authored");
  const pr = {
    number: prNumber,
    headSha: String(view.headRefOid ?? ""),
    headRefName,
    baseRefName,
    mergeStateStatus,
    glmAuthored,
  };
  if (baseRefName === "") throw new Error(`PR #${prNumber} has no baseRefName`);

  const fetched = await ports.git(["fetch", "origin", baseRefName]);
  if (!fetched.ok) throw new Error(`git fetch origin ${baseRefName} failed: ${fetched.stderr}`);
  const rev = await ports.git(["rev-parse", `origin/${baseRefName}`]);
  if (!rev.ok) throw new Error(`git rev-parse origin/${baseRefName} failed: ${rev.stderr}`);
  const fixedSha = rev.stdout.trim();
  const paths = await ports.git(["diff", "--no-renames", "--name-only", `${fixedSha}...HEAD`]);
  if (!paths.ok) throw new Error(`git diff --name-only failed: ${paths.stderr}`);
  const changedPaths = paths.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");

  // 4. Resolve the spec source — the design-concept artifact.
  const parent = parentIssueOf(body);
  let resolve: Record<string, unknown> | null = null;
  if (parent !== null) {
    const res = await ports.http(`/api/design-concepts/${parent}/resolve`);
    const parsed = res ? tryParse(res.body) : undefined;
    resolve = isRecord(parsed) ? parsed : null;
  }
  const found = resolve?.found === true && isRecord(resolve.concept);
  let specInput: unknown = null;
  let skippedReason: string | null = null;
  if (found) {
    specInput = resolve?.concept ?? null;
  } else if (prLabels.includes("design-concept-exempt")) {
    skippedReason = "design-concept-exempt label present (operator override)";
  } else {
    let issueLabels: string[] = [];
    if (parent !== null) {
      const il = await ghJson(ports, ["issue", "view", String(parent), "--repo", repo, "--json", "labels"]);
      issueLabels = isRecord(il) ? labelNames(il.labels) : [];
    }
    const cleanup = issueLabels.includes("cleanup-scan");
    const exempt = issueLabels.includes("design-concept-exempt");
    const missReason =
      typeof resolve?.reason === "string" ? resolve.reason : "design-concept artifact missing (resolve unreachable)";
    if (cleanup || exempt) {
      skippedReason = cleanup
        ? "cleanup-scan label present on parent issue (deterministic-exempt class)"
        : "design-concept-exempt label present on parent issue (deterministic-exempt class)";
    } else if (opts.mode === "enforce") {
      const handle = isRecord(resolve?.handle) && typeof resolve.handle.redisKey === "string"
        ? resolve.handle.redisKey
        : "(handle unknown)";
      return stopResult(
        "spec-missing-enforce",
        issue,
        { target: "pr", body: enforceStopBody(parent, opts.mode, missReason, handle) },
        { pr, fixedSha, changedPaths, spec: { found: false, input: null, skippedReason: null, mode: opts.mode } },
      );
    } else {
      console.error(`WARN: ${missReason} — proceeding in Phase A shadow mode (Standards axis only).`);
      skippedReason = `no persisted artifact (Phase A shadow mode — DESIGN_CONCEPT_MODE=${opts.mode}): ${missReason}`;
      degraded.push("spec-unresolved");
    }
  }

  // 5. Current CI state (the engine's checks phase: branch-protection required-ness).
  let checks: PreflightResult["checks"] = NO_CHECKS;
  try {
    const out = await ports.phase("checks", { pr: prNumber });
    if (Array.isArray(out.checks)) {
      const source = typeof out.source === "string" ? out.source : null;
      checks = { list: out.checks as PreflightResult["checks"]["list"], degraded: source !== "branch-protection", source };
      if (checks.degraded) degraded.push("checks-all-optional");
    } else {
      degraded.push("checks-unreadable");
    }
  } catch (err) {
    console.error("[preflight] checks phase failed — checks unreadable:", err);
    degraded.push("checks-unreadable");
  }

  // 6.5 Modification tier — the live tier API, the single authority.
  let tierNum: number | null = null;
  const tierRes = await ports.http(`/api/tier?files=${encodeURIComponent(changedPaths.join(","))}`);
  const tierJson = tierRes && tierRes.status === 200 ? tryParse(tierRes.body) : undefined;
  if (isRecord(tierJson) && typeof tierJson.tier === "number") tierNum = tierJson.tier;
  if (tierNum === null) {
    console.error("WARN: tier classifier unreachable — defaulting to T3 adversarial QA (over-verify).");
    degraded.push("tier-unreachable");
  }
  let adversarial = tierNum === null || tierNum >= 3;

  // 6 / 6.6 Reviewer admission gate (one engine call answers both).
  let gate: PreflightResult["gate"] = {
    action: "admit",
    reason: "gate produced no output; fail-closed to full review",
    redRequired: [],
    skipVerdict: null,
    skipCiSummary: null,
  };
  let promptOnly = false;
  try {
    const input: Record<string, unknown> = { pr: prNumber, tier: tierNum, changedPaths };
    if (checks.source !== null) input.checks = checks.list;
    if (mergeStateStatus !== "") input.mergeStateStatus = mergeStateStatus;
    const out = await ports.phase("admission", input);
    const adm = isRecord(out.admission) ? out.admission : null;
    if (adm && (adm.action === "admit" || adm.action === "defer" || adm.action === "skip-required-failed")) {
      const sv = isRecord(out.skipVerdict) ? out.skipVerdict : null;
      gate = {
        action: adm.action,
        reason: String(adm.reason ?? ""),
        redRequired: Array.isArray(out.redRequired) ? out.redRequired.map(String) : [],
        skipVerdict: sv ? { verdict: String(sv.verdict ?? "FAIL"), reason: String(sv.reason ?? "required CI check failed") } : null,
        skipCiSummary: typeof out.skipCiSummary === "string" ? out.skipCiSummary : null,
      };
    }
    promptOnly = out.promptOnly === true;
  } catch (err) {
    console.error("WARN: reviewer admission gate produced no action — fail-closed to admit (full fan-out):", err);
    degraded.push("admission-failed");
  }
  if (promptOnly && specInput === null && skippedReason === null) {
    skippedReason = "Tier-1 auto-bypass (diff is prompt-only and no artifact present)";
  }

  // 6.7 Size the reviewer fan-out by change shape — only on admit.
  let fanout: PreflightResult["fanout"] = {
    mode: adversarial ? "adversarial" : "standard",
    reviewers: [],
    reason: `no review fan-out: gate action ${gate.action}`,
  };
  if (gate.action === "admit") {
    let sized: PreflightResult["fanout"] | null = null;
    try {
      const out = await ports.phase("fanout", { pr: prNumber, tier: tierNum, changedPaths });
      if (
        (out.mode === "single" || out.mode === "standard" || out.mode === "adversarial") &&
        Array.isArray(out.reviewers)
      ) {
        sized = { mode: out.mode, reviewers: out.reviewers.map(String), reason: String(out.reason ?? "") };
      }
    } catch (err) {
      console.error("WARN: fan-out sizing failed — keeping the tier fan-out:", err);
    }
    if (sized === null) {
      degraded.push("fanout-failed");
      const mode = adversarial ? "adversarial" : "standard";
      sized = {
        mode,
        reviewers: adversarial
          ? ["reviewer-A-standards", "reviewer-A-spec", "reviewer-B-standards", "reviewer-B-spec"]
          : ["standards", "spec"],
        reason: `Review fan-out: ${mode} — change-shape sizing unavailable, kept the tier path.`,
      };
    }
    fanout = sized;
    if (fanout.mode === "single") adversarial = false; // the fold reads one reviewer's verdict
  }

  return {
    ok: true,
    stage: "ready",
    issue,
    pr,
    fixedSha,
    changedPaths,
    checks,
    spec: { found, input: specInput, skippedReason, mode: opts.mode },
    tier: { num: tierNum, adversarial },
    gate,
    fanout,
    stop: null,
    degraded,
  };
}

if (isEntrypoint(import.meta.url)) {
  await runCli("qa-preflight", async () => {
    const argv = process.argv.slice(2);
    const repo = flagValue(argv, "--repo") ?? DEFAULT_REPO;
    const opts: PreflightOptions = {
      issue: intFlag(argv, "--issue"),
      pr: intFlag(argv, "--pr"),
      repo,
      mode: process.env.DESIGN_CONCEPT_MODE || "warn",
    };
    const ports = await createProductionPorts(repo, process.env.HYDRA_API_BASE || DEFAULT_API_BASE);
    return PreflightResultSchema.parse(await runPreflight(opts, ports));
  });
}
