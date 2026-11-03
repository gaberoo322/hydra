/**
 * scripts/qa/route.ts — hydra-qa steps 9 / 9.5 / 9.6 / 10 (and the step-6.6
 * defer bounce): the SINGLE effect owner of a QA round (issue #5269, ADR-0046
 * Decision 7).
 *
 *   node --experimental-strip-types scripts/qa/route.ts --preflight <file>
 *     [--findings <file> --summaries <file>] [--packet <file>] [--defer] [--dry-run] [--repo owner/name]
 *
 * One pass: fold -> classify -> trailer -> round-action through the qa-verdict
 * engine IN-PROCESS (findings bound RAW, so a malformed file reaches the fold
 * and fails closed to the high `reviewer-output-malformed` blocker), then the
 * step-10 effects, then the printed plan/result. `--dry-run` prints the
 * identical plan with zero writes. `--defer` is the ONLY path that posts
 * without a verdict.
 *
 * No verdict rule lives here (INV-1/INV-12): this file never maps a degraded
 * fold or an empty round-action to PASS, never spells a deep-QA marker (it
 * posts the engine's rendered pass/fail marker lines), and never arms
 * auto-merge: the merge call stays in the playbook behind the QA merge guard,
 * so a PASS returns `nextStep:'arm-auto-merge'`.
 *
 * A non-zero fold / trailer / round-action result is a PRE-VERDICT exit (exit
 * 1): NOTHING is posted and `needs-qa` stays, so the next dispatch retries.
 */

import { readFileSync } from "node:fs";
import {
  DEFAULT_REPO,
  defaultGh,
  finish,
  flagValue,
  hasFlag,
  isEntrypoint,
  isRecord,
  productionPhaseRunner,
  usageExit,
  type CmdRunner,
  type PhaseName,
  type PhaseRunner,
} from "./common.ts";
import { parseQaVerdictTrailer } from "../../src/qa/verdict-trailer.ts";
import { rowsFromFold } from "../../src/qa/review-findings-extract.ts";
import { QaVerdictCliSchemas } from "../../src/schemas/qa-verdict-cli.ts";
import {
  PreflightResultSchema,
  RouteResultSchema,
  type PreflightReady,
  type RouteEffect,
  type RouteResult,
} from "../../src/schemas/qa-plumbing-cli.ts";

type StoredRows = ReturnType<typeof rowsFromFold>;

export interface RouteDeps {
  gh: CmdRunner;
  phase: PhaseRunner;
  /** Append review-findings rows (STD-REDIS-SEAM); default lazy-imports the Redis accessor. */
  appendRows: (rows: StoredRows) => Promise<unknown>;
  now: () => string;
}

export interface RouteOptions {
  pre: PreflightReady;
  /** Raw text of the step-8 per-reviewer findings map ('' when the file is absent). */
  findingsText: string;
  summaries: { standards: string; spec: string };
  /** The packet result's merge-danger gap line, appended to the report when set. */
  gapLine: string | null;
  defer: boolean;
  dryRun: boolean;
}

export type RouteOutcome =
  | { exitCode: 0; result: RouteResult }
  | { exitCode: 1; result: null; reason: string };

const SKIP_REVIEW_REPORT =
  "_Review skipped by the admission gate (issue #3815): a required CI check already failed, so the review verdict cannot change the FAIL `classifyVerdict` returns regardless of the reviewers' finding._";

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Run an engine phase behind its CLI input schema: a schema miss is "no result", like the CLI's exit 2. */
async function callPhase(
  phase: PhaseRunner,
  name: PhaseName,
  input: unknown,
): Promise<Record<string, unknown> | null> {
  const parsed = QaVerdictCliSchemas[name].safeParse(input);
  if (!parsed.success) {
    console.error(`[qa-route] ${name} input failed its schema:`, JSON.stringify(parsed.error.issues));
    return null;
  }
  return phase(name, parsed.data);
}

/** The effect runner: records every gh call; `dryRun` records the plan and runs nothing. */
function effectRunner(gh: CmdRunner, dryRun: boolean, effects: RouteEffect[]) {
  return (kind: string, target: string, args: string[]): { ok: boolean; stderr: string } => {
    if (dryRun) {
      effects.push({ kind, target, ok: true });
      return { ok: true, stderr: "" };
    }
    const r = gh(args);
    effects.push({ kind, target, ok: r.ok });
    return { ok: r.ok, stderr: r.stderr };
  };
}

export async function runRoute(opts: RouteOptions, deps: RouteDeps): Promise<RouteOutcome> {
  const { pre } = opts;
  const { gh, phase } = deps;
  const repo = pre.repo;
  const prNum = pre.pr.number;
  const issue = pre.issue;
  const degraded: string[] = [];
  const effects: RouteEffect[] = [];
  const run = effectRunner(gh, opts.dryRun, effects);
  const redList = pre.gate.redRequired.join(", ");
  const redSuffix = redList !== "" ? `\n\nRed required check(s): ${redList}` : "";

  // qa_bounce_label (issue #4766): a LIVE per-call read; CLOSED/MERGED => ready-for-agent,
  // anything else (including a failed or empty read) => needs-dev-resume.
  const bounceLabel = (): "ready-for-agent" | "needs-dev-resume" => {
    const r = gh(["pr", "view", String(prNum), "--repo", repo, "--json", "state", "--jq", '.state // ""']);
    const state = r.ok ? r.stdout.trim() : "";
    return state === "CLOSED" || state === "MERGED" ? "ready-for-agent" : "needs-dev-resume";
  };
  const prComment = (body: string) =>
    run("pr-comment", `pr#${prNum}`, ["pr", "comment", String(prNum), "--repo", repo, "--body", body]);
  const issueComment = (body: string) =>
    run("issue-comment", `issue#${issue}`, ["issue", "comment", String(issue), "--repo", repo, "--body", body]);
  const issueEdit = (add: string) =>
    run("issue-label-edit", `issue#${issue}`, [
      "issue", "edit", String(issue), "--repo", repo, "--remove-label", "needs-qa", "--add-label", add,
    ]);
  const disarm = () => {
    const r = run("disable-auto", `pr#${prNum}`, ["pr", "merge", String(prNum), "--repo", repo, "--disable-auto"]);
    if (!r.ok) console.error(`[hydra-qa] WARN: --disable-auto on PR #${prNum} failed (non-fatal — likely not armed)`);
  };

  // ---- --defer: the ONLY path that posts without a verdict (step 6.6) -------
  if (opts.defer) {
    const reason = pre.gate.reason;
    prComment(
      `> *Automated QA — review deferred*\n\n${reason}\n\nNo verdict is being emitted — the PR cannot merge on this pass. The full review (including the Verifier-Core fan-out for a T4 PR) runs once the PR is rebased / CI is green. QA has exited; the autopilot re-queues it when the PR is ready.`,
    );
    const label = bounceLabel();
    if (label === "needs-dev-resume") {
      issueEdit("needs-dev-resume");
      issueComment(
        pre.pr.glmAuthored
          ? `> *Automated QA — review deferred (GLM-authored PR)*\n\n${reason}${redSuffix}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — this PR is GLM-authored with an open PR, which the GLM drainer skips; the autopilot's pinned forward-fix (issue #4460) owns the next attempt on this branch.`
          : `> *Automated QA — review deferred (open PR)*\n\n${reason}${redSuffix}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the next attempt on this branch.`,
      );
    } else {
      // Not-open fallback (#4766): live read confirmed CLOSED/MERGED.
      issueEdit("ready-for-agent");
    }
    return {
      exitCode: 0,
      result: {
        verdict: null,
        reason,
        reviewVerdict: null,
        blockers: 0,
        maxSeverity: "none",
        worstFinding: "",
        trailer: null,
        round: null,
        deepQa: null,
        effects,
        nextStep: "none",
        degraded,
      },
    };
  }

  // ---- 9. fold + classify (or the skip-required-failed short-circuit) -------
  const skipPath = pre.gate.action === "skip-required-failed";
  let reviewVerdict: string;
  let reviewReport: string;
  let verdict: string;
  let verdictReason: string;
  let checksBlock: string;
  let blockers: number;
  let maxSeverity: string;
  let worstFinding: string;
  let foldResult: Record<string, unknown> | null = null;

  if (skipPath) {
    reviewVerdict = "PASS"; // nominal — classifyVerdict ignores it when requiredFailed > 0
    reviewReport = SKIP_REVIEW_REPORT;
    verdict = pre.gate.skipVerdict?.verdict ?? "FAIL";
    verdictReason = pre.gate.skipVerdict?.reason ?? "required CI check failed";
    checksBlock = pre.gate.skipCiSummary ?? "_(checks block unavailable)_";
    blockers = Math.max(pre.gate.redRequired.length, 1);
    maxSeverity = "high";
    worstFinding = `required CI check(s) red: ${redList !== "" ? redList : "see checks block"}`;
  } else {
    let findings: unknown = opts.findingsText;
    try {
      findings = JSON.parse(opts.findingsText);
    } catch {
      /* intentional: a malformed findings file travels RAW so the engine fails closed to reviewer-output-malformed */
    }
    foldResult = await callPhase(phase, "fold", {
      tier: pre.tier.num,
      findings,
      spawnedReviewers: pre.fanout.reviewers.map((r) => r.trim()).filter((r) => r.length > 0),
      checks: pre.checks.list,
      standardsSummary: opts.summaries.standards,
      specSummary: opts.summaries.spec,
      fanoutReason: pre.fanout.reason,
    });
    const fold = foldResult !== null && isRecord(foldResult.fold) ? foldResult.fold : null;
    const counts = foldResult !== null && isRecord(foldResult.counts) ? foldResult.counts : null;
    const v = foldResult !== null && isRecord(foldResult.verdict) ? foldResult.verdict : null;
    const rv = fold ? asString(fold.reviewVerdict) : null;
    const rep = foldResult ? asString(foldResult.report) : null;
    const ci = foldResult ? asString(foldResult.ciSummary) : null;
    const vv = v ? asString(v.verdict) : null;
    const vr = v ? asString(v.reason) : null;
    const ms = counts ? asString(counts.maxSeverity) : null;
    const bl = counts && typeof counts.blockers === "number" ? counts.blockers : null;
    if (rv === null || rep === null || ci === null || vv === null || vr === null || ms === null || bl === null) {
      const reason = "fold phase produced no usable result — pre-verdict exit, nothing posted";
      console.error(`[hydra-qa] ERROR: ${reason}`);
      return { exitCode: 1, result: null, reason };
    }
    reviewVerdict = rv;
    reviewReport = rep;
    checksBlock = ci;
    verdict = vv;
    verdictReason = vr;
    maxSeverity = ms;
    blockers = bl;
    worstFinding = fold ? (asString(fold.worstFinding) ?? "") : "";
  }
  if (opts.gapLine) reviewReport = `${reviewReport}\n\n${opts.gapLine}`;

  // ---- 9.5 trailer (the engine reads the PR thread and counts the round) -----
  const trailerOut = await callPhase(phase, "trailer", {
    pr: prNum,
    verdict,
    blockers,
    maxSeverity,
  });
  const trailer = trailerOut ? asString(trailerOut.trailer) : null;
  if (trailer === null || trailer === "") {
    const reason = "trailer phase returned no trailer — pre-verdict exit, nothing posted";
    console.error(`[hydra-qa] ERROR: ${reason}`);
    return { exitCode: 1, result: null, reason };
  }
  if (Array.isArray(trailerOut?.degraded)) degraded.push(...(trailerOut.degraded as string[]).map((d) => `trailer:${d}`));
  const round = typeof trailerOut?.round === "number" ? trailerOut.round : null;
  const blockerSummary = `${blockers} blocker(s), worst: ${maxSeverity}${worstFinding !== "" ? ` — ${worstFinding}` : ""}`;

  // ---- 9.6 round-action (BEFORE this round's comment is posted) --------------
  const roundOut = await callPhase(phase, "round-action", {
    pr: prNum,
    tier: pre.tier.num,
    verdict,
    reviewVerdict,
    currentReviewed: !skipPath,
    currentTrailer: trailer,
  });
  const roundObj = roundOut && isRecord(roundOut.round) ? roundOut.round : null;
  if (roundOut === null || roundObj === null || typeof roundObj.action !== "string") {
    const reason = "round-action returned no .round.action — pre-verdict exit, nothing posted";
    console.error(`[hydra-qa] ERROR: ${reason}`);
    return { exitCode: 1, result: null, reason };
  }
  if (Array.isArray(roundOut.degraded)) degraded.push(...(roundOut.degraded as string[]).map((d) => `round-action:${d}`));
  const deepQa = isRecord(roundOut.deepQa) ? roundOut.deepQa : null;
  const labels = isRecord(roundOut.labels) ? roundOut.labels : {};
  const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  // ---- 10. effects ------------------------------------------------------------
  const tier4 = pre.tier.num === 4;
  const verdictBody = (heading: string, middle: string) => `> *${heading}*\n\n${reviewReport}\n\n---\n\n${middle}\n\n${trailer}`;
  let nextStep: "arm-auto-merge" | "none" = "none";

  const appendFindingRows = async () => {
    if (opts.dryRun || skipPath || foldResult === null || !isRecord(foldResult.fold)) return;
    const t = parseQaVerdictTrailer(trailer);
    if (t === null || typeof t.round !== "number") return;
    try {
      const rows = rowsFromFold(
        foldResult.fold as unknown as Parameters<typeof rowsFromFold>[0],
        { pr: prNum, round: t.round, sha: t.sha },
        { at: deps.now(), source: "route" },
      );
      await deps.appendRows(rows);
    } catch (err) {
      console.error("[hydra-qa] review-findings append failed (non-fatal):", err);
      degraded.push("review-findings");
    }
  };

  if (verdict === "PASS") {
    // Strip needs-qa FIRST (issue #974), before anything that can abort; `in-progress` rides the same call.
    issueEdit("in-progress");
    prComment(
      verdictBody("Automated QA — two-axis review", `**Verdict:** \`PASS\` — ${verdictReason}\n\n${checksBlock}`),
    );
    await appendFindingRows();
    if (tier4) {
      const passMarker = asString(roundOut.passMarker) ?? "";
      if (passMarker !== "") {
        prComment(
          `> *T4 Verifier-Core deep-QA — PASS proof*\n\n${passMarker}\n\nThe Verifier-Core deep-QA branch passed against this exact head SHA. The \`deep-qa-gate\` required check verifies this marker before merge; new commits invalidate it and force re-QA.`,
        );
      } else {
        console.error("[hydra-qa] WARN: no deep-QA PASS marker from round-action (degraded) — none posted");
        degraded.push("pass-marker");
      }
    }
    nextStep = "arm-auto-merge";
  } else if (verdict === "PASS-pending-CI") {
    prComment(
      `> *Automated QA — two-axis review (pending CI)*\n\n${reviewReport}\n\n---\n\nCode review **PASS**. Awaiting CI:\n\n${checksBlock}\n\nVerdict: \`PASS-pending-CI\`. Autopilot will re-evaluate once required checks conclude. **The QA subagent has exited — no background wait.**\n\n${trailer}`,
    );
    await appendFindingRows();
    // Clear needs-qa (issue #638); bridge with `in-progress` in the same call.
    issueEdit("in-progress");
  } else if (!tier4) {
    // FAIL / FAIL-pending-CI, T1-T3 (and unknown tier): disarm first, then the round-capped bounce.
    disarm();
    prComment(
      verdictBody("Automated QA — two-axis review", `**Verdict:** \`${verdict}\` — ${verdictReason}\n\n${checksBlock}`),
    );
    await appendFindingRows();
    if (roundObj.action === "escalate") {
      const summary = asString(roundOut.escalationSummary) ?? "";
      let labelsOk = true;
      // Add first, so the issue is in the operator queue even if a removal fails.
      for (const l of strList(labels.issueAdd)) {
        const r = run("label-add", `issue#${issue}:${l}`, [
          "api", "-X", "POST", `repos/${repo}/issues/${issue}/labels`, "-f", `labels[]=${l}`,
        ]);
        if (!r.ok) {
          labelsOk = false;
          console.error(`[hydra-qa] ERROR: could not add ${l} to issue #${issue}`);
        }
      }
      // The label name goes in the URL path (sent as a form field it would wipe ALL labels); a 404 is success.
      for (const l of strList(labels.issueRemove)) {
        const r = run("label-remove", `issue#${issue}:${l}`, [
          "api", "-X", "DELETE", `repos/${repo}/issues/${issue}/labels/${encodeURIComponent(l)}`,
        ]);
        if (!r.ok) {
          if (/404|Label does not exist/.test(r.stderr)) {
            effects[effects.length - 1] = { kind: "label-remove", target: `issue#${issue}:${l}`, ok: true };
          } else {
            labelsOk = false;
            console.error(`[hydra-qa] ERROR: could not remove ${l} from issue #${issue}: ${r.stderr}`);
          }
        }
      }
      for (const l of strList(labels.prAdd)) {
        const r = run("label-add", `pr#${prNum}:${l}`, [
          "api", "-X", "POST", `repos/${repo}/issues/${prNum}/labels`, "-f", `labels[]=${l}`,
        ]);
        if (!r.ok) {
          labelsOk = false;
          console.error(`[hydra-qa] ERROR: could not add ${l} to PR #${prNum}`);
        }
      }
      const note = labelsOk
        ? "Labelled `ready-for-human` (issue and PR) and removed every dev-lane label; no dev lane will pick this up."
        : "**Label routing FAILED** (see the QA log): add `ready-for-human` and remove `needs-qa`, `ready-for-agent`, `needs-dev-resume` and `in-progress` by hand, or QA will re-run on this issue.";
      issueComment(
        `> *Automated QA escalated — operator decision needed*\n\n\`${verdict}\` on PR #${prNum} — ${blockerSummary}. ${note}\n\n${summary}\n\n${trailer}`,
      );
    } else {
      const label = bounceLabel();
      if (label === "needs-dev-resume") {
        issueEdit("needs-dev-resume");
        issueComment(
          pre.pr.glmAuthored
            ? `> *Automated QA failed (GLM-authored PR)*\n\n\`${verdict}\` on PR #${prNum} — ${blockerSummary}. Full review on the PR.${redSuffix}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the GLM drainer skips open-PR anchors; the autopilot's pinned forward-fix (issue #4460) owns the retry on this branch.\n\n${trailer}`
            : `> *Automated QA failed (open PR)*\n\n\`${verdict}\` on PR #${prNum} — ${blockerSummary}. Full review on the PR.${redSuffix}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the retry on this branch.\n\n${trailer}`,
        );
      } else {
        // Not-open fallback (#4766): no open PR remains, so a fresh dev pick is the right lane.
        issueEdit("ready-for-agent");
        issueComment(
          `> *Automated QA failed*\n\n\`${verdict}\` on PR #${prNum} — ${blockerSummary}. Full review on the PR.\n\nReturning to ready-for-agent for retry.\n\n${trailer}`,
        );
      }
    }
  } else {
    // T4: the Deep-QA Remediation Loop. The PR is the per-attempt ledger; the engine counted the prior markers.
    disarm();
    const action = deepQa ? (asString(deepQa.action) ?? "bounce") : "bounce";
    const failNo = deepQa && typeof deepQa.failNumber === "number" ? deepQa.failNumber : 1;
    const failMarker = asString(roundOut.failMarker) ?? "";
    prComment(
      verdictBody(
        "Automated QA — T4 Verifier-Core deep review",
        `**Verdict:** \`${verdict}\` — ${verdictReason}\n\n${failMarker} (fail #${failNo} on this PR)\n\n${checksBlock}`,
      ),
    );
    await appendFindingRows();
    if (action === "block-and-escalate") {
      issueEdit("ready-for-human");
      issueComment(
        `> *T4 Deep-QA blocked — operator decision needed*\n\nPR #${prNum} failed the Verifier-Core deep-QA gate **twice consecutively** (fail #${failNo}). Per the Deep-QA Remediation Loop the PR is now **blocked** and routed to the operator instead of bouncing again.\n\n\`${verdict}\` — ${blockerSummary}. Full findings on PR #${prNum} (both passes).\n\nThis issue is now on the \`/hydra-review\` pickup set. Resolve by either fixing the Verifier-Core concern and re-running QA, or closing the PR.\n\n${trailer}`,
      );
    } else {
      const label = bounceLabel();
      issueEdit(label);
      issueComment(
        `> *T4 Deep-QA failed (1st) — bouncing to dev*\n\n\`${verdict}\` on PR #${prNum} — ${blockerSummary}. Full review on the PR.\n\nReturning to ${label} for remediation. A second consecutive deep-QA FAIL on this PR will block it and escalate to the operator.\n\n${trailer}`,
      );
    }
  }

  return {
    exitCode: 0,
    result: {
      verdict,
      reason: verdictReason,
      reviewVerdict,
      blockers,
      maxSeverity,
      worstFinding,
      trailer,
      round,
      deepQa,
      effects,
      nextStep,
      degraded,
    },
  };
}

if (isEntrypoint(import.meta.url)) {
  const argv = process.argv.slice(2);
  const repo = flagValue(argv, "--repo", DEFAULT_REPO) as string;
  const preflightFile = flagValue(argv, "--preflight");
  const defer = hasFlag(argv, "--defer");
  const findingsFile = flagValue(argv, "--findings");
  const summariesFile = flagValue(argv, "--summaries");
  const packetFile = flagValue(argv, "--packet");
  const readText = (p: string | undefined): string => {
    if (!p) return "";
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      console.error(`[hydra-qa] cannot read ${p}:`, err);
      return "";
    }
  };
  if (!preflightFile) {
    usageExit([{ message: "usage: route.ts --preflight <file> [--findings <file> --summaries <file>] [--packet <file>] [--defer] [--dry-run]" }]);
  } else {
    try {
      const pre = PreflightResultSchema.safeParse(JSON.parse(readFileSync(preflightFile, "utf8")));
      if (!pre.success) usageExit(pre.error.issues);
      else if (!pre.data.ok) usageExit([{ message: "preflight result is not ok:true — nothing to route" }]);
      else {
        let summaries = { standards: "", spec: "" };
        if (summariesFile) {
          try {
            const s = JSON.parse(readText(summariesFile)) as Record<string, unknown>;
            summaries = { standards: String(s.standards ?? ""), spec: String(s.spec ?? "") };
          } catch (err) {
            console.error("[hydra-qa] summaries file unparseable, using empty summaries:", err);
          }
        }
        if (summaries.spec === "" && pre.data.spec.skippedReason) summaries.spec = `_Skipped: ${pre.data.spec.skippedReason}_`;
        let gapLine: string | null = null;
        if (packetFile) {
          try {
            const p = JSON.parse(readText(packetFile)) as { mergeDanger?: { gapLine?: unknown } };
            gapLine = typeof p.mergeDanger?.gapLine === "string" ? p.mergeDanger.gapLine : null;
          } catch (err) {
            console.error("[hydra-qa] packet file unparseable, no merge-danger gap line:", err);
          }
        }
        const phase = await productionPhaseRunner(repo);
        const out = await runRoute(
          { pre: pre.data, findingsText: readText(findingsFile), summaries, gapLine, defer, dryRun: hasFlag(argv, "--dry-run") },
          {
            gh: defaultGh,
            phase,
            appendRows: async (rows) => {
              const m = await import("../../src/redis/review-findings.ts");
              return m.appendReviewFindingRows(rows);
            },
            now: () => new Date().toISOString(),
          },
        );
        if (out.exitCode !== 0) finish(1);
        else {
          const parsed = RouteResultSchema.safeParse(out.result);
          if (!parsed.success) usageExit(parsed.error.issues);
          else finish(0, parsed.data);
        }
      }
    } catch (err) {
      console.error("[hydra-qa] route: no result produced:", err);
      finish(1);
    }
  }
}
