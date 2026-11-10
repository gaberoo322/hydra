/**
 * Cap park + cap reset (ADR-0047 Decision 6, issue #5314).
 *
 * `parkForCap` is ONE seam operation: close any held dispatch claim (owner
 * checked), ONE gh label edit `<state> -> parked` (re-read verified), journal
 * the transition, post ONE unified comment on the ISSUE. It never touches the
 * PR. It only writes through a legal `<state> -> parked` transition row; from a
 * state with none it writes no label and journals `refused:park-illegal-from`.
 *
 * Never throws (STD-VERIFY-NEVER-THROW); every effect is an injectable
 * `SeamDeps` member.
 */
import { logger } from "../logger.ts";
import type { LifecycleJournalEntry } from "../redis/lifecycle-journal.ts";
import { CAP_RESET_PREFIX, renderCapCounts, type CapCount } from "./caps.ts";
import type { SeamDeps } from "./seam.ts";
import { findTransition, isLifecycleState } from "./transitions.ts";

export interface ParkInput {
  issue: number;
  /** The single re-read state label, or null when none / ambiguous. */
  from: string | null;
  over: CapCount;
  counts: readonly CapCount[];
  pr: number | null;
  actor?: string;
  /** Extra evidence for the transition entry (e.g. the timeline seed). */
  evidence?: Record<string, string>;
}

export interface ParkResult {
  /** Whether the `parked` label write landed. */
  written: boolean;
}

function parkEvidence(over: CapCount, pr: number | null): Record<string, string> {
  return {
    arm: over.arm,
    count: String(over.count),
    limit: String(over.limit),
    source: over.source,
    ...(pr !== null ? { pr: String(pr) } : {}),
  };
}

/** The `Hydra-Cap-Park:` machine line plus the human-readable unified comment. */
export function renderParkComment(input: ParkInput, nowIso: string): string {
  const { over, counts, pr } = input;
  const rows = counts.map((c) => `| ${c.arm} | ${c.count} | ${c.limit} | ${c.unit} |`);
  return [
    "## Hydra cap park",
    "",
    `This issue was parked automatically: the \`${over.arm}\` cap was reached (${over.count} of ${over.limit} per ${over.unit}).`,
    "",
    "| Arm | Count | Limit | Unit |",
    "|---|---|---|---|",
    ...rows,
    "",
    "To un-park: investigate why the attempts keep failing, then un-park through the board route " +
      "(`POST /api/autopilot/board/relabel` or `promote`), which posts the reset on the issue and the PR. By hand, remove the " +
      `\`parked\` label, add the right state label, and post \`${CAP_RESET_PREFIX} by=<you> ts=<ISO-8601>\` on this issue` +
      `${pr !== null ? ` AND on PR #${pr}` : ""} so every count restarts from that moment.`,
    "",
    `Hydra-Cap-Park: arm=${over.arm} count=${over.count} limit=${over.limit} unit=${over.unit}` +
      `${pr !== null ? ` pr=${pr}` : ""} source=${over.source} ts=${nowIso}`,
  ].join("\n");
}

export async function parkForCap(input: ParkInput, deps: SeamDeps): Promise<ParkResult> {
  const { issue, over } = input;
  const actor = input.actor ?? "cli";
  const rationale = renderCapCounts(input.counts);
  const base = (over2: Partial<LifecycleJournalEntry> & Pick<LifecycleJournalEntry, "kind" | "result" | "written">): LifecycleJournalEntry => ({
    v: 1,
    ts: deps.now(),
    from: input.from,
    to: "parked",
    source: "cli",
    actor,
    evidence: { ...parkEvidence(over, input.pr), ...(input.evidence ?? {}) },
    reason: `cap:${over.arm}`,
    rationale,
    ...over2,
  });
  const append = async (e: LifecycleJournalEntry): Promise<void> => {
    const res = await deps.journal.append(deps.repo, issue, e);
    if (res.ok === false) logger.error({ issue, error: res.error }, "[lifecycle] journal append failed");
  };

  try {
    // (a) close any held dispatch claim via the owner-checked compare-and-delete.
    const held = await deps.journal.readClaim(deps.repo, issue);
    if (held.ok && held.claim) {
      const closed = await deps.journal.closeClaim(deps.repo, issue, held.claim.dispatchId);
      if (closed.ok === false) {
        logger.error({ issue, error: closed.error }, "[lifecycle] park could not close the held claim");
      } else {
        await append({
          v: 1,
          ts: deps.now(),
          kind: "claim-closed",
          from: null,
          to: null,
          source: "cli",
          actor,
          evidence: { dispatch: held.claim.dispatchId, class: held.claim.class, outcome: "released" },
          reason: null,
          rationale: null,
          result: "ok",
          written: true,
        });
      }
    }

    // (b) legality: only a real `<state> -> parked` row may write.
    const row = input.from !== null && isLifecycleState(input.from) ? findTransition(input.from, "parked") : undefined;
    if (!row) {
      await append(
        base({ kind: "refused", from: input.from, result: `refused:park-illegal-from:${input.from ?? "none"}`, written: false }),
      );
      return { written: false };
    }

    const write = await deps.edit(issue, { remove: [row.from], add: ["parked"] });
    if (write.ok === false) {
      await append(base({ kind: "refused", result: `write-failed:${write.code}`, written: false }));
      return { written: false };
    }
    const after = await deps.view(issue);
    const verified = after.ok && after.row.labels.includes("parked") && !after.row.labels.includes(row.from);
    if (!verified) {
      await append(base({ kind: "refused", result: "write-unverified", written: true }));
      return { written: true };
    }

    // (c) journal, (d) ONE unified comment on the ISSUE (never the PR).
    await append(base({ kind: "transition", result: `parked:${over.arm}`, written: true }));
    const posted = await deps.comment(issue, renderParkComment(input, new Date(deps.now()).toISOString()));
    if (posted.ok === false) logger.error({ issue, code: posted.code }, "[lifecycle] park comment failed");
    return { written: true };
  } catch (err) {
    logger.error({ err, issue }, "[lifecycle] parkForCap crashed");
    return { written: false };
  }
}

export interface CapResetInput {
  by: string;
  /** ISO-8601 reset timestamp. */
  ts: string;
}

/** PR-side outcome of a cap reset: `lookup-failed` = the park journal was unreadable, `post-failed` = the PR comment write failed. */
export type CapResetPrOutcome = "none" | "posted" | "post-failed" | "lookup-failed";

export type CapResetResult = { ok: true; pr: CapResetPrOutcome } | { ok: false; code: string };

/** Evidence value for `capReset` derived from the PR outcome (shared by the operator route). */
export function capResetEvidence(pr: CapResetPrOutcome): string {
  if (pr === "posted") return "issue+pr";
  if (pr === "none") return "issue";
  return `issue+pr-${pr}`;
}

/**
 * The PR named by the latest `cap:` park journal entry, or null. The
 * `qa-fail-rounds` arm counts PR comment bodies, so a reset must land there too.
 */
export async function latestCapParkPr(
  issue: number,
  deps: SeamDeps,
): Promise<{ ok: true; pr: number | null } | { ok: false }> {
  const journal = await deps.journal.read(deps.repo, issue);
  if (!journal.ok) return { ok: false };
  for (const e of [...journal.entries].reverse()) {
    if (typeof e.reason === "string" && e.reason.startsWith("cap:") && e.to === "parked") {
      const n = Number(e.evidence.pr);
      return { ok: true, pr: Number.isInteger(n) && n > 0 ? n : null };
    }
  }
  return { ok: true, pr: null };
}

export interface CapResetTargets {
  issue: boolean;
  pr: boolean;
}

/**
 * Post `Hydra-Cap-Reset: by=<by> ts=<iso>` on the issue and, when the latest
 * `cap:` park names `pr=`, the same line on that PR (decideQaRoundAction reads
 * only PR bodies). Wired to the operator-route un-park (operatorAdvance) and the
 * reconciler's external un-park; `targets` narrows which surface(s) to post on.
 */
export async function postCapReset(
  issue: number,
  input: CapResetInput,
  deps: SeamDeps,
  targets: CapResetTargets = { issue: true, pr: true },
): Promise<CapResetResult> {
  try {
    if (Number.isNaN(Date.parse(input.ts)) || !/^\S+$/.test(input.by)) {
      return { ok: false, code: "invalid-reset-input" };
    }
    const line = `${CAP_RESET_PREFIX} by=${input.by} ts=${input.ts}`;
    if (targets.issue) {
      const posted = await deps.comment(issue, line);
      if (posted.ok === false) return { ok: false, code: `comment-failed:${posted.code}` };
    }

    let outcome: CapResetPrOutcome = "none";
    if (targets.pr) {
      const found = await latestCapParkPr(issue, deps);
      if (!found.ok) {
        logger.error({ issue }, "[lifecycle] cap reset PR lookup failed: park journal unreadable");
        outcome = "lookup-failed";
      } else if (found.pr !== null) {
        const prRes = await deps.comment(found.pr, line);
        if (prRes.ok === false) logger.error({ issue, pr: found.pr, code: prRes.code }, "[lifecycle] cap reset PR comment failed");
        outcome = prRes.ok ? "posted" : "post-failed";
      }
    }
    return { ok: true, pr: outcome };
  } catch (err) {
    logger.error({ err, issue }, "[lifecycle] postCapReset crashed");
    return { ok: false, code: "crashed" };
  }
}
