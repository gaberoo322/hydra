/**
 * scripts/qa/route.ts — hydra-qa steps 8.5–10 in ONE call (issue #5269,
 * ADR-0046 Decision 7): the SINGLE owner of every verdict effect.
 *
 *   node --experimental-strip-types scripts/qa/route.ts \
 *     --preflight <file> --findings <file> --summaries <file> \
 *     [--packet <file>] [--defer] [--dry-run] [--repo owner/name]
 *
 * One pass: fold -> trailer -> round-action through the qa-verdict engine
 * (`runQaVerdictPhase`, in-process; findings are bound RAW so a malformed file
 * reaches the fold and fails closed to the `reviewer-output-malformed` high
 * blocker), then the step-10 / step-6.6 effects, then ONE JSON result.
 *
 * No verdict rule lives here. The verdict literal, the round cap, the Deep-QA
 * action, the PASS/FAIL markers and the escalation label sets all come from the
 * engine's result; this file only spells the comment bodies (byte-for-byte the
 * playbook's old bash templates) and the gh calls, in a pinned order.
 *
 * A non-zero fold / trailer / round-action result is a PRE-VERDICT EXIT: exit 1
 * with at most one best-effort `QA-Verdict-Error` comment and `needs-qa` untouched.
 * `--defer` is the only path that posts without a verdict.
 *
 * Issue-state moves ride the lifecycle seam (`scripts/lifecycle.ts advance`, ADR-0047
 * D3, #5317) via `ports.advance`: this file performs NO direct state-label write.
 * A PASS enters `qa-passed` AFTER its verdict comment (the seam's `qa-verdict` gate
 * reads the trailer at head); the 3rd reviewed FAIL is parked by the seam. `--dry-run` computes the identical effect plan and
 * performs no write.
 *
 * `gh pr merge --auto` is deliberately NOT here: the merge call site stays in
 * the playbook behind the QA merge guard (test/qa-merge-guard-callsites).
 * `nextStep: 'arm-auto-merge'` tells the session to run it. The only
 * `gh pr merge` in this file is the `--disable-auto` disarm.
 */

import { readFileSync } from "node:fs";
import {
  DEFAULT_API_BASE,
  DEFAULT_REPO,
  UsageError,
  createProductionPorts,
  flagValue,
  hasFlag,
  isEntrypoint,
  isRecord,
  runCli,
  tryParse,
  type AdvanceResult,
  type PlumbingPorts,
} from "./_lib.ts";
import { readPreflight } from "./packet.ts";
import {
  PacketResultSchema,
  RouteResultSchema,
  SummariesSchema,
  type PreflightResult,
  type RouteEffect,
  type RouteResult,
} from "../../src/schemas/qa-plumbing-cli.ts";
import { QA_ADMISSION_SKIP_MARKER } from "../../src/qa/round-action.ts";
import { parseQaVerdictTrailer } from "../../src/qa/verdict-trailer.ts";
import { rowsFromFold } from "../../src/qa/review-findings-extract.ts";
import type { StoredReviewFindingRow } from "../../src/redis/review-findings.ts";

type Severity = "high" | "medium" | "low" | "none";

export interface RouteOptions {
  repo: string;
  defer: boolean;
  dryRun: boolean;
  findingsPath?: string;
  summariesPath?: string;
  packetPath?: string;
}

export interface RouteDeps {
  readText: (path: string) => string | null;
  /** The review-findings Redis seam (`await import()`ed in production). */
  appendRows: (rows: StoredReviewFindingRow[]) => Promise<unknown>;
  now: () => Date;
  /** Backoff between the disarm attempts (defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** Pause before the single disarm retry, so a transient gh/API blip can clear. */
export const DISARM_RETRY_BACKOFF_MS = 1500;

// ---------------------------------------------------------------------------
// Comment-body templates — byte-identical to the post-#5306 playbook bash.
// ---------------------------------------------------------------------------

const redLine = (red: string): string => (red === "" ? "" : `\n\nRed required check(s): ${red}`);

export const bodies = {
  pass: (report: string, reason: string, checks: string, trailer: string): string =>
    `> *Automated QA — two-axis review*\n\n${report}\n\n---\n\n**Verdict:** \`PASS\` — ${reason}\n\n${checks}\n\n${trailer}`,
  passProof: (line: string): string =>
    `> *T4 Verifier-Core deep-QA — PASS proof*\n\n${line}\n\nThe Verifier-Core deep-QA branch passed against this exact head SHA. The \`deep-qa-gate\` required check verifies this marker before merge; new commits invalidate it and force re-QA.`,
  passPendingCi: (report: string, checks: string, trailer: string): string =>
    `> *Automated QA — two-axis review (pending CI)*\n\n${report}\n\n---\n\nCode review **PASS**. Awaiting CI:\n\n${checks}\n\nVerdict: \`PASS-pending-CI\`. Autopilot will re-evaluate once required checks conclude. **The QA subagent has exited — no background wait.**\n\n${trailer}`,
  fail: (report: string, verdict: string, reason: string, checks: string, trailer: string): string =>
    `> *Automated QA — two-axis review*\n\n${report}\n\n---\n\n**Verdict:** \`${verdict}\` — ${reason}\n\n${checks}\n\n${trailer}`,
  failEscalated: (verdict: string, pr: number, summary: string, escalation: string, trailer: string): string =>
    `> *Automated QA escalated — round cap reached*\n\n\`${verdict}\` on PR #${pr} — ${summary}. The issue is \`parked\`; no dev lane will pick it up until the operator un-parks it.\n\n${escalation}\n\n${trailer}`,
  failGlm: (verdict: string, pr: number, summary: string, red: string, trailer: string): string =>
    `> *Automated QA failed (GLM-authored PR)*\n\n\`${verdict}\` on PR #${pr} — ${summary}. Full review on the PR.${redLine(red)}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the GLM drainer skips open-PR anchors; the autopilot's pinned forward-fix (issue #4460) owns the retry on this branch.\n\n${trailer}`,
  failOpen: (verdict: string, pr: number, summary: string, red: string, trailer: string): string =>
    `> *Automated QA failed (open PR)*\n\n\`${verdict}\` on PR #${pr} — ${summary}. Full review on the PR.${redLine(red)}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the retry on this branch.\n\n${trailer}`,
  failNotOpen: (verdict: string, pr: number, summary: string, trailer: string): string =>
    `> *Automated QA failed*\n\n\`${verdict}\` on PR #${pr} — ${summary}. Full review on the PR.\n\nReturning to ready-for-agent for retry.\n\n${trailer}`,
  t4Review: (report: string, verdict: string, reason: string, marker: string, failNo: number, checks: string, trailer: string): string =>
    `> *Automated QA — T4 Verifier-Core deep review*\n\n${report}\n\n---\n\n**Verdict:** \`${verdict}\` — ${reason}\n\n${marker} (fail #${failNo} on this PR)\n\n${checks}\n\n${trailer}`,
  t4Blocked: (verdict: string, pr: number, failNo: number, summary: string, trailer: string): string =>
    `> *T4 Deep-QA blocked — operator decision needed*\n\nPR #${pr} failed the Verifier-Core deep-QA gate **twice consecutively** (fail #${failNo}). Per the Deep-QA Remediation Loop the PR is now **blocked** and routed to the operator instead of bouncing again.\n\n\`${verdict}\` — ${summary}. Full findings on PR #${pr} (both passes).\n\nThis issue is now on the \`/hydra-review\` pickup set. Resolve by either fixing the Verifier-Core concern and re-running QA, or closing the PR.\n\n${trailer}`,
  t4Bounce: (verdict: string, pr: number, summary: string, label: string, trailer: string): string =>
    `> *T4 Deep-QA failed (1st) — bouncing to dev*\n\n\`${verdict}\` on PR #${pr} — ${summary}. Full review on the PR.\n\nReturning to ${label} for remediation. A second consecutive deep-QA FAIL on this PR will block it and escalate to the operator.\n\n${trailer}`,
  deferPr: (reason: string): string =>
    `> *Automated QA — review deferred*\n\n${reason}\n\nNo verdict is being emitted — the PR cannot merge on this pass. The full review (including the Verifier-Core fan-out for a T4 PR) runs once the PR is rebased / CI is green. QA has exited; the autopilot re-queues it when the PR is ready.`,
  deferGlm: (reason: string, red: string): string =>
    `> *Automated QA — review deferred (GLM-authored PR)*\n\n${reason}${redLine(red)}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — this PR is GLM-authored with an open PR, which the GLM drainer skips; the autopilot's pinned forward-fix (issue #4460) owns the next attempt on this branch.`,
  deferOpen: (reason: string, red: string): string =>
    `> *Automated QA — review deferred (open PR)*\n\n${reason}${redLine(red)}\n\nRelabelled \`needs-dev-resume\` (not \`ready-for-agent\`) — the PR is still open, so the autopilot's durable resume pin (issue #4518) owns the next attempt on this branch.`,
};

/** `$REVIEW_REPORT` of the step-6.6 skip-required-failed path (no reviewer ran). */
export const SKIP_REVIEW_REPORT = `_${QA_ADMISSION_SKIP_MARKER} (issue #3815): a required CI check already failed, so the review verdict cannot change the FAIL \`classifyVerdict\` returns regardless of the reviewers' finding._`;

const ESC_FALLBACK_SUMMARY = "See the PR thread for the round-by-round findings.";

/** Thrown by the advance helper when the PR merged under us: reconcile owns needs-qa -> closed, so stop with exit 0. */
class PrMergedStop extends Error {
  constructor() {
    super("pr-merged");
    this.name = "PrMergedStop";
  }
}

// ---------------------------------------------------------------------------

function requireField<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined || (typeof v === "string" && v === "")) {
    throw new Error(`${what} is missing from the engine result`);
  }
  return v;
}

/** Findings text -> the value the engine's fold binds (a parsed value, else the RAW string). */
function bindFindings(raw: string, mergeDangerRow: unknown): unknown {
  const parsed = tryParse(raw);
  if (parsed === undefined) return raw;
  if (mergeDangerRow !== null && isRecord(parsed)) {
    return { ...parsed, "merge-danger-check": [mergeDangerRow] };
  }
  return parsed;
}

/** Shared between runRoute and its impl: lets the wrapper post the pre-verdict failure signal. */
interface RouteCtx {
  /** Set by the impl once the first verdict effect is about to run. */
  effectsStarted: boolean;
  /** Set by the impl once its gh helpers exist. */
  postPreVerdictError: ((reason: string) => Promise<boolean>) | null;
}

/**
 * A fold / trailer / round-action failure is a PRE-VERDICT exit (no verdict, needs-qa
 * stays, exit 1). A persistent failure must not re-dispatch the fan-out forever in
 * silence, so leave the visible, best-effort `QA-Verdict-Error` PR comment first (it
 * carries no round=, so it is never counted as a round; ADR-0046 INV-7). Usage errors
 * (bad flags / files) and dry runs post nothing.
 */
export async function runRoute(
  opts: RouteOptions,
  pre: PreflightResult,
  ports: PlumbingPorts,
  deps: RouteDeps,
): Promise<RouteResult> {
  const ctx: RouteCtx = { effectsStarted: false, postPreVerdictError: null };
  try {
    return await runRouteImpl(opts, pre, ports, deps, ctx);
  } catch (err) {
    if (!(err instanceof UsageError) && !ctx.effectsStarted && !opts.dryRun && ctx.postPreVerdictError !== null) {
      try {
        await ctx.postPreVerdictError("fold-phase-failed");
      } catch (postErr) {
        console.error("[hydra-qa] WARN: QA-Verdict-Error comment failed:", postErr);
      }
    }
    throw err;
  }
}

async function runRouteImpl(
  opts: RouteOptions,
  pre: PreflightResult,
  ports: PlumbingPorts,
  deps: RouteDeps,
  ctx: RouteCtx,
): Promise<RouteResult> {
  const { repo } = opts;
  const issue = pre.issue ?? 0;
  const pr = pre.pr?.number ?? 0;
  const tier = pre.tier.num;
  const redList = pre.gate.redRequired.join(", ");
  const degraded: string[] = [];
  const effects: RouteEffect[] = [];

  if (opts.defer && pre.gate.action !== "defer") {
    throw new UsageError(`--defer is only valid when preflight gate.action is 'defer' (got '${pre.gate.action}')`);
  }
  const deferring = pre.gate.action === "defer";

  // One recorded effect. A failure is logged with context and never stops the
  // remaining effects (the old bash ran each call independently).
  const gh = async (kind: string, target: string, args: string[]): Promise<boolean> => {
    if (opts.dryRun) {
      effects.push({ kind, target, ok: true });
      return true;
    }
    const res = await ports.gh(args);
    effects.push({ kind, target, ok: res.ok });
    if (!res.ok) console.error(`[hydra-qa] WARN: ${kind} on ${target} failed:`, res.stderr.slice(0, 300));
    return res.ok;
  };
  const prComment = (body: string, kind = "pr-comment") =>
    gh(kind, `pr#${pr}`, ["pr", "comment", String(pr), "--repo", repo, "--body", body]);
  const issueComment = (body: string, kind = "issue-comment") =>
    gh(kind, `issue#${issue}`, ["issue", "comment", String(issue), "--repo", repo, "--body", body]);
  /**
   * One lifecycle-seam advance (the only state-label writer). A `pr-merged` refusal is
   * not an error: the PR merged under us and reconcile owns needs-qa -> closed, so it
   * stops the remaining effects with exit 0 (the #974 busy-loop guard).
   */
  const advance = async (to: string, evidence: string[], kind: string, extra: string[] = []): Promise<AdvanceResult> => {
    const args = [String(issue), to, ...evidence.flatMap((e) => ["--evidence", e]), ...extra, "--actor", "hydra-qa"];
    if (opts.dryRun) {
      effects.push({ kind, target: `issue#${issue}`, ok: true });
      return { rc: 0, code: "", wouldPark: "" };
    }
    const res = await ports.advance(args);
    effects.push({ kind, target: `issue#${issue}`, ok: res.rc === 0 });
    if (res.rc !== 0 && res.code === "pr-merged") throw new PrMergedStop();
    if (res.rc !== 0) console.error(`[hydra-qa] WARN: lifecycle advance ${to} on issue#${issue} refused (${res.code || "unknown"})`);
    return res;
  };
  /** An advance whose refusal ends the route (exit 1): never a by-hand label edit (ADR-0047 D4). */
  const advanceOrThrow = async (to: string, evidence: string[], kind: string, extra: string[] = []): Promise<AdvanceResult> => {
    const res = await advance(to, evidence, kind, extra);
    if (res.rc !== 0) throw new Error(`lifecycle advance ${to} refused (${res.code || "unknown"}) - not editing labels by hand`);
    return res;
  };
  /**
   * PASS entry to `qa-passed`, with a deterministic exit on every refusal (#5317 round 3): a
   * QA-Verdict-Error comment, then the seam's trailer-less defer edge off needs-qa. Returns
   * whether qa-passed was entered.
   */
  const passAdvance = async (kind: string): Promise<boolean> => {
    const res = await advance("qa-passed", [`pr=${pr}`], kind);
    if (res.rc === 0) return true;
    await prComment(
      `QA-Verdict-Error: verdict=PASS pr=${pr} reason=lifecycle advance to qa-passed refused (${res.code || "unknown"}); routing the issue off needs-qa through the seam`,
      "pass-refusal-error-comment",
    );
    await advanceOrThrow(await bounceLabel(), [`pr=${pr}`, "defer=1"], "pass-refusal-defer");
    degraded.push("qa-passed-refused");
    return false;
  };
  const disarm = () => gh("disarm-auto-merge", `pr#${pr}`, ["pr", "merge", String(pr), "--repo", repo, "--disable-auto"]);

  /** Disarm once, retry once; a still-failed disarm leaves auto-merge armed on a FAILed PR, so surface it. */
  const disarmChecked = async (): Promise<void> => {
    if (await disarm()) return;
    await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(DISARM_RETRY_BACKOFF_MS);
    if (await disarm()) return;
    // A FAILed PR must never stay auto-merge-armed: the playbook treats this tag as a HARD STOP.
    degraded.push("disarm-failed");
  };

  /** The bounce lane: a LIVE per-call read; ready-for-agent only on a confirmed CLOSED/MERGED PR (#4766). */
  const bounceLabel = async (): Promise<"needs-dev-resume" | "ready-for-agent"> => {
    const res = await ports.gh(["pr", "view", String(pr), "--repo", repo, "--json", "state", "--jq", '.state // ""']);
    const state = res.ok ? res.stdout.trim() : "";
    return state === "CLOSED" || state === "MERGED" ? "ready-for-agent" : "needs-dev-resume";
  };

  /** The result of a path that posted without a verdict (a stop comment or a defer). */
  const noVerdict = (reason: string): RouteResult => ({
    verdict: null,
    reason,
    reviewVerdict: null,
    blockers: 0,
    maxSeverity: "none",
    worstFinding: "",
    trailer: "",
    round: null,
    deepQa: null,
    effects,
    nextStep: "none",
    dryRun: opts.dryRun,
    degraded,
  });

  // ---- A non-ready preflight stage (no issue / no PR / spec missing in enforce): post its ONE comment and end. ----
  if (!pre.ok) {
    if (pre.stop) {
      if (pre.stop.target === "pr" && pre.pr) await prComment(pre.stop.body, "stop-pr-comment");
      else if (pre.stop.target === "issue" && pre.issue !== null) await issueComment(pre.stop.body, "stop-issue-comment");
      else throw new UsageError(`preflight stage '${pre.stage}' has a stop comment with no target to post it on`);
    }
    return noVerdict(`preflight stage '${pre.stage}'`);
  }
  if (pre.pr === null || pre.issue === null) {
    throw new UsageError(`preflight stage '${pre.stage}' carries no issue / PR to route`);
  }

  // ---- --defer: PR comment -> bounce relabel -> issue comment, no verdict. ----
  if (deferring) {
    await prComment(bodies.deferPr(pre.gate.reason), "defer-pr-comment");
    const label = await bounceLabel();
    try {
      await advanceOrThrow(label, [`pr=${pr}`, "defer=1"], "defer-relabel");
      if (label === "needs-dev-resume") {
        await issueComment(
          pre.pr.glmAuthored ? bodies.deferGlm(pre.gate.reason, redList) : bodies.deferOpen(pre.gate.reason, redList),
          "defer-issue-comment",
        );
      }
    } catch (err) {
      if (!(err instanceof PrMergedStop)) throw err;
      degraded.push("pr-merged");
    }
    return noVerdict(pre.gate.reason);
  }

  // ---- Compute the verdict (engine), BEFORE any write. ----
  if (pre.checks.source === null) {
    throw new Error("checks were unreadable at preflight; a verdict cannot be computed (pre-verdict exit)");
  }
  // From here a throw is a fold-phase failure: arm the visible QA-Verdict-Error signal.
  ctx.postPreVerdictError = (reason) =>
    prComment(
      `> *Automated QA — fold failed, no verdict emitted*\n\nQA-Verdict-Error: pr=${pr} reason=${reason}`,
      "pre-verdict-error-comment",
    );
  let reviewVerdict: "PASS" | "FAIL";
  let report: string;
  let verdict: string;
  let verdictReason: string;
  let checksBlock: string;
  let blockers: number;
  let maxSeverity: Severity;
  let worstFinding: string;
  let foldResult: Record<string, unknown> | null = null;
  const currentReviewed = pre.gate.action !== "skip-required-failed";

  if (!currentReviewed) {
    // skip-required-failed: the FAIL the fold already determined; zero reviewers ran.
    reviewVerdict = "PASS"; // nominal — classifyVerdict ignores it when requiredFailed > 0
    report = SKIP_REVIEW_REPORT;
    verdict = pre.gate.skipVerdict?.verdict ?? "FAIL";
    verdictReason = pre.gate.skipVerdict?.reason ?? "required CI check failed";
    checksBlock = pre.gate.skipCiSummary ?? "_(checks block unavailable)_";
    blockers = Math.max(1, pre.gate.redRequired.length);
    maxSeverity = "high";
    worstFinding = `required CI check(s) red: ${redList || "see checks block"}`;
  } else {
    if (opts.findingsPath === undefined || opts.summariesPath === undefined) {
      throw new UsageError("--findings and --summaries are required unless preflight gate.action is 'defer' or 'skip-required-failed'");
    }
    const summaries = SummariesSchema.safeParse(tryParse(deps.readText(opts.summariesPath) ?? ""));
    if (!summaries.success) throw new UsageError(`--summaries is not {standardsSummary, specSummary}: ${summaries.error.issues[0]?.message ?? "invalid"}`);
    let packet: ReturnType<typeof PacketResultSchema.parse> | null = null;
    if (opts.packetPath !== undefined) {
      const p = PacketResultSchema.safeParse(tryParse(deps.readText(opts.packetPath) ?? ""));
      if (!p.success) throw new UsageError(`--packet is not a packet result: ${p.error.issues[0]?.message ?? "invalid"}`);
      packet = p.data;
    }
    // A missing/unreadable findings file is malformed reviewer output, not a crash:
    // the empty raw text reaches the engine, which fails closed to the high blocker.
    const findingsRaw = deps.readText(opts.findingsPath) ?? "";
    foldResult = await ports.phase("fold", {
      tier,
      findings: bindFindings(findingsRaw, packet?.mergeDanger.finding ?? null),
      spawnedReviewers: pre.fanout.reviewers,
      checks: pre.checks.list,
      standardsSummary: summaries.data.standardsSummary,
      specSummary: summaries.data.specSummary,
      fanoutReason: pre.fanout.reason,
    });
    const fold = isRecord(foldResult.fold) ? foldResult.fold : {};
    const counts = isRecord(foldResult.counts) ? foldResult.counts : {};
    const v = isRecord(foldResult.verdict) ? foldResult.verdict : {};
    const rv = requireField(fold.reviewVerdict as string | undefined, "fold.reviewVerdict");
    if (rv !== "PASS" && rv !== "FAIL") throw new Error(`fold.reviewVerdict '${rv}' is not PASS|FAIL`);
    reviewVerdict = rv;
    report = requireField(foldResult.report as string | undefined, "report");
    blockers = requireField(counts.blockers as number | undefined, "counts.blockers");
    maxSeverity = requireField(counts.maxSeverity as Severity | undefined, "counts.maxSeverity");
    verdict = requireField(v.verdict as string | undefined, "verdict.verdict");
    verdictReason = requireField(v.reason as string | undefined, "verdict.reason");
    checksBlock = requireField(foldResult.ciSummary as string | undefined, "ciSummary");
    worstFinding = typeof fold.worstFinding === "string" ? fold.worstFinding : "";
    if (packet?.mergeDanger.gapLine) report = `${report}\n\n${packet.mergeDanger.gapLine}`;
  }

  const trailerOut = await ports.phase("trailer", { pr, verdict, blockers, maxSeverity });
  const trailer = requireField(trailerOut.trailer as string | undefined, "trailer");
  const roundOut = await ports.phase("round-action", {
    pr,
    tier,
    verdict,
    reviewVerdict,
    currentReviewed,
    currentTrailer: trailer,
  });
  const round = isRecord(roundOut.round) ? roundOut.round : {};
  const roundAction = requireField(round.action as string | undefined, "round.action");
  if (Array.isArray(roundOut.degraded)) degraded.push(...roundOut.degraded.map(String));
  if (Array.isArray(trailerOut.degraded)) degraded.push(...trailerOut.degraded.map(String));

  const summary = `${blockers} blocker(s), worst: ${maxSeverity}${worstFinding ? ` — ${worstFinding}` : ""}`;
  let nextStep: RouteResult["nextStep"] = "none";

  // A T4 FAIL with no deep-QA decision is a pre-verdict exit: validate it BEFORE effectsStarted
  // flips, so the visible QA-Verdict-Error comment still posts for it.
  if (verdict !== "PASS" && verdict !== "PASS-pending-CI" && tier === 4 && !isRecord(roundOut.deepQa)) {
    throw new Error("T4 FAIL without a deepQa decision (pre-verdict exit)");
  }

  // ---- Effects (step 10). ----
  ctx.effectsStarted = true;
  try {
    if (verdict === "PASS") {
      // The verdict comment FIRST: the seam's qa-verdict gate reads the PASS trailer at head (#5317 INV-8).
      const commented = await prComment(bodies.pass(report, verdictReason, checksBlock, trailer));
      let proofOk = true;
      if (tier === 4) {
        const line = typeof roundOut.passMarker === "string" ? roundOut.passMarker : "";
        if (line !== "") proofOk = await prComment(bodies.passProof(line), "t4-pass-proof");
        else {
          console.error("[hydra-qa] WARN: no deep-QA PASS marker from round-action (degraded) - none posted");
          degraded.push("pass-marker");
        }
      }
      // needs-qa -> qa-passed through the seam BEFORE the merge call; arm auto-merge only once the
      // PASS is durably recorded: the verdict comment, the seam entry, and (T4) the pass-proof marker.
      const entered = await passAdvance("pass-advance");
      if (entered && commented && proofOk) nextStep = "arm-auto-merge";
      else degraded.push("pass-effects");
    } else if (verdict === "PASS-pending-CI") {
      await prComment(bodies.passPendingCi(report, checksBlock, trailer), "pending-ci-pr-comment");
      // PASS-pending-CI is a PASS for routing: qa-passed; reconcile reads CI live (a red CI bounces it back).
      await passAdvance("pending-ci-advance");
    } else if (tier === 4) {
      // T4 FAIL: the Deep-QA Remediation Loop. Disarm FIRST (#4737), then the marker comment.
      const deep = roundOut.deepQa as Record<string, unknown>; // narrowed by the pre-check above
      const action = String(deep.action ?? "");
      const failNo = typeof deep.failNumber === "number" ? deep.failNumber : 1;
      const marker = typeof roundOut.failMarker === "string" ? roundOut.failMarker : "";
      await disarmChecked();
      await prComment(bodies.t4Review(report, verdict, verdictReason, marker, failNo, checksBlock, trailer), "t4-review-comment");
      if (action === "block-and-escalate") {
        await advanceOrThrow("ready-for-human", [], "t4-escalate-advance", [
          "--reason", "t4-deep-qa-exhausted",
          "--rationale", `T4 deep-QA failed twice consecutively on PR #${pr} (fail #${failNo})`,
        ]);
        await issueComment(bodies.t4Blocked(verdict, pr, failNo, summary, trailer), "t4-blocked-comment");
      } else {
        const label = await bounceLabel();
        await advanceOrThrow(label, [`pr=${pr}`], "t4-bounce-advance");
        await issueComment(bodies.t4Bounce(verdict, pr, summary, label, trailer), "t4-bounce-comment");
      }
    } else {
      // T1/T2/T3 (and unknown-tier) FAIL: the universal remediation bounce. The verdict comment
      // (carrying this round's trailer) goes FIRST; the seam owns the 3rd-reviewed-FAIL cap.
      await disarmChecked();
      await prComment(bodies.fail(report, verdict, verdictReason, checksBlock, trailer));
      const label = await bounceLabel();
      let escalate = false;
      const adv = await advance(label, [`pr=${pr}`], "fail-bounce-advance");
      if (adv.rc !== 0) {
        // The seam parks the 3rd reviewed FAIL in enforce AND shadow (qa-fail-rounds is a live arm), posting
        // the unified park comment itself; any other refusal ends the route.
        if (adv.code !== "parked:qa-fail-rounds") throw new Error(`lifecycle advance ${label} refused (${adv.code || "unknown"}) - not editing labels by hand`);
        escalate = true;
      }
      if (escalate) {
        // Off-list escalation (ADR-0047 D6): the issue is PARKED, never ready-for-human.
        const esc = typeof roundOut.escalationSummary === "string" && roundOut.escalationSummary !== "" ? roundOut.escalationSummary : ESC_FALLBACK_SUMMARY;
        await issueComment(bodies.failEscalated(verdict, pr, summary, esc, trailer), "escalate-issue-comment");
      } else if (label === "needs-dev-resume") {
        await issueComment(
          pre.pr.glmAuthored
            ? bodies.failGlm(verdict, pr, summary, redList, trailer)
            : bodies.failOpen(verdict, pr, summary, redList, trailer),
        );
      } else {
        await issueComment(bodies.failNotOpen(verdict, pr, summary, trailer));
      }
    }
  } catch (err) {
    if (!(err instanceof PrMergedStop)) {
      // A throw after a still-failed disarm exits 1 with no result JSON, bypassing the playbook HARD STOP:
      // re-attempt the disarm once and say so LOUDLY on stderr (round-4 finding).
      if (degraded.includes("disarm-failed")) {
        const ok = opts.dryRun ? false : await disarm();
        console.error(
          `[hydra-qa] HARD STOP: auto-merge may still be ARMED on FAILed PR #${pr} (disarm-failed, route aborted); ` +
            (ok ? "final re-disarm succeeded" : `run: gh pr merge ${pr} --repo ${repo} --disable-auto`),
        );
      }
      throw err;
    }
    nextStep = "none";
    degraded.push("pr-merged");
  }

  // ---- Review-findings rows (ADR-0046 D8 / R1 #5270): last, never fatal, never reorders the gh effects. ----
  const parsedTrailer = parseQaVerdictTrailer(trailer);
  if (foldResult !== null && parsedTrailer !== null && !opts.dryRun) {
    try {
      const rows = rowsFromFold(
        foldResult.fold as Parameters<typeof rowsFromFold>[0],
        { pr, round: parsedTrailer.round, sha: parsedTrailer.sha },
        { at: deps.now().toISOString(), source: "route" },
      );
      await deps.appendRows(rows);
    } catch (err) {
      console.error("[hydra-qa] WARN: review-findings append failed (non-fatal):", err);
      degraded.push("review-findings");
    }
  }

  return {
    verdict: verdict as RouteResult["verdict"],
    reason: verdictReason,
    reviewVerdict,
    blockers,
    maxSeverity,
    worstFinding,
    trailer,
    round: typeof trailerOut.round === "number" ? trailerOut.round : null,
    deepQa: roundOut.deepQa ?? null,
    effects,
    nextStep,
    dryRun: opts.dryRun,
    degraded,
  };
}

/** Bound the Redis write so an unreachable Redis can never hold the dispatch. */
const APPEND_TIMEOUT_MS = 4000;

if (isEntrypoint(import.meta.url)) {
  await runCli("qa-route", async () => {
    const argv = process.argv.slice(2);
    const preflightPath = flagValue(argv, "--preflight");
    if (preflightPath === undefined) {
      throw new UsageError(
        "usage: route.ts --preflight <file> --findings <file> --summaries <file> [--packet <file>] [--defer] [--dry-run] [--repo owner/name]",
      );
    }
    const repo = flagValue(argv, "--repo") ?? DEFAULT_REPO;
    const pre = readPreflight(preflightPath);
    const ports = await createProductionPorts(repo, process.env.HYDRA_API_BASE || DEFAULT_API_BASE);
    const result = await runRoute(
      {
        repo,
        defer: hasFlag(argv, "--defer"),
        dryRun: hasFlag(argv, "--dry-run"),
        findingsPath: flagValue(argv, "--findings"),
        summariesPath: flagValue(argv, "--summaries"),
        packetPath: flagValue(argv, "--packet"),
      },
      pre,
      ports,
      {
        readText: (p) => {
          try {
            return readFileSync(p, "utf8");
          } catch (err) {
            console.error(`[qa-route] cannot read ${p}:`, err);
            return null;
          }
        },
        appendRows: async (rows) => {
          // Dynamic: keeps ioredis out of this file's static import graph (STD-REDIS-SEAM accessor).
          const { appendReviewFindingRows } = await import("../../src/redis/review-findings.ts");
          return Promise.race([
            appendReviewFindingRows(rows),
            new Promise((_, reject) => setTimeout(() => reject(new Error("review-findings append timed out")), APPEND_TIMEOUT_MS)),
          ]);
        },
        now: () => new Date(),
      },
    );
    return RouteResultSchema.parse(result);
  });
}
