/**
 * Operator advance / reopen (ADR-0047 Decision 3, issues #5313 and #5618).
 *
 * The operator's sanctioned path through the seam: split out of `seam.ts` so the
 * transition spine stays the deep core. Both entry points reuse the spine's
 * `entry` / `journalEntry` / `observedOf` helpers.
 */
import { logger } from "../logger.ts";
import type { IssueActionWriteResult } from "../github/issue-actions.ts";
import type { JournalSource, LifecycleJournalEntry } from "../redis/lifecycle-journal.ts";
import { isPullRequestUrl } from "./gates.ts";
import { resetsCapsOnExit } from "./caps.ts";
import { postCapReset } from "./park.ts";
import { entry, journalEntry as journal, normaliseCloseReason, observedOf, type AdvanceResult } from "./seam.ts";
import type { LifecycleMode, SeamDeps } from "./seam-deps.ts";
import {
  findOperatorTransition,
  isLifecycleState,
  isOperatorTarget,
  stateLabelsOf,
  type LifecycleState,
} from "./transitions.ts";
// ---------------------------------------------------------------------------
// operatorAdvance / operatorReopen (ADR-0047 Decision 3, issue #5313)
// ---------------------------------------------------------------------------
//
// The operator's sanctioned path through the seam. `source` is FIXED to
// `operator-route` here and is never a caller parameter; `advance()` above
// keeps `source: "cli"` and refuses every human-hold exit. Only
// src/api/autopilot-board.ts imports these (pinned by a test); the CLI never
// does. Legality is the generated OPERATOR_TRANSITIONS table; the operator
// may also repair a 0-or-many state-label pre-state. Both entry points share
// the seam's entry/journal helpers and the re-read verify.

export interface OperatorAdvanceInput {
  issue: number;
  to: string;
  closeReason?: string;
  /** `board:<action>`. */
  actor: string;
}

const OPERATOR_SOURCE: JournalSource = "operator-route";

function operatorEntry(
  deps: SeamDeps,
  over: Partial<LifecycleJournalEntry> & Pick<LifecycleJournalEntry, "kind" | "result" | "written">,
  input: { to: string; actor: string },
): LifecycleJournalEntry {
  return entry(deps, over, { to: input.to, actor: input.actor }, OPERATOR_SOURCE);
}

export async function operatorAdvance(input: OperatorAdvanceInput, deps: SeamDeps): Promise<AdvanceResult> {
  const issue = input.issue;
  const refuse = async (code: string, mode: LifecycleMode | null, from: string | null): Promise<AdvanceResult> => {
    await journal(deps, issue, operatorEntry(deps, { kind: "refused", from, result: `refused:${code}`, written: false }, input));
    return { ok: false, issue, code, mode, written: false };
  };
  if (!isLifecycleState(input.to)) {
    return { ok: false, issue, code: "unknown-target-state", mode: null, written: false };
  }
  const to: LifecycleState = input.to;
  const mode = await deps.mode();

  const before = await deps.view(issue);
  if (before.ok === false) return refuse("fetch-failed", mode, null);
  if (isPullRequestUrl(before.row.url)) {
    logger.warn({ issue }, "[lifecycle] operatorAdvance refused: not an issue (pull request)");
    return { ok: false, issue, code: "not-an-issue", mode, written: false };
  }
  if (before.row.state === "CLOSED") {
    // Closing an already-closed issue stays idempotent (the pre-seam spine
    // accepted it): ok with the observed state, no write, no journal.
    if (to === "closed") return { ok: true, issue, from: "closed", to, mode, observed: observedOf(before) };
    return refuse("issue-closed", mode, "closed");
  }

  const stateLabels = stateLabelsOf(before.row.labels);
  const from = stateLabels.length > 0 ? stateLabels.join(",") : null;

  // Legality: a single pre-state needs an operator row; 0 / many states are
  // the operator's to repair, but the TARGET must still be operator-owned.
  const selfMove = stateLabels.length === 1 && stateLabels[0] === to;
  const legal =
    isOperatorTarget(to) &&
    (stateLabels.length !== 1 || findOperatorTransition(stateLabels[0], to) !== undefined);
  if (!legal && !selfMove) return refuse("illegal-transition", mode, from);

  const removed = stateLabels.filter((s) => s !== to);
  const alreadyThere = (stateLabels as string[]).includes(to);
  const closeReason = normaliseCloseReason(input.closeReason);
  // Leaving Park or ready-for-human (and not closing) restarts every Cap Arm: post the issue-side marker BEFORE the
  // label write. While `parked` is still set no lane can claim the issue, so the marker is harmless
  // early and there is no window where a claim counts the pre-reset FAIL rounds and re-parks (QA
  // r1 on #5457). The outcome is evidence only; a failed post never changes `ok`.
  let capReset: string | null = null;
  if (removed.some(resetsCapsOnExit) && to !== "closed") {
    const res = await postCapReset(
      issue,
      { by: input.actor, ts: new Date(deps.now()).toISOString() },
      deps,
    );
    capReset = res.ok === false ? `failed:${res.code}` : "posted";
  }

  // A marker posted before a refused / unverified write is still on the issue: journal it so the stray
  // marker is never evidence-free (QA r2 on #5457, INV-3/INV-4).
  const capEvidence: Partial<LifecycleJournalEntry> = capReset !== null ? { evidence: { capReset } } : {};
  let write: IssueActionWriteResult = { ok: true };
  if (to === "closed") {
    write = await deps.close(issue, closeReason ?? "completed");
  } else if (removed.length > 0 || !alreadyThere) {
    write = await deps.edit(issue, { remove: [...removed], add: alreadyThere ? [] : [to] });
  }
  if (write.ok === false) {
    const code = `write-failed:${write.code}`;
    await journal(deps, issue, operatorEntry(deps, { kind: "refused", from, result: code, written: false, ...capEvidence }, input));
    return { ok: false, issue, code, mode, written: false };
  }

  const after = await deps.view(issue);
  const verified =
    after.ok &&
    (to === "closed"
      ? after.row.state === "CLOSED"
      : after.row.labels.includes(to) && removed.every((s) => !after.row.labels.includes(s)));
  if (!verified) {
    await journal(deps, issue, operatorEntry(deps, { kind: "refused", from, result: "write-unverified", written: true, ...capEvidence }, input));
    return { ok: false, issue, code: "write-unverified", mode, written: true };
  }

  if (!selfMove) {
    await journal(
      deps,
      issue,
      operatorEntry(
        deps,
        {
          kind: "transition",
          from,
          result: "ok",
          written: true,
          ...(capReset !== null ? { evidence: { capReset } } : {}),
        },
        input,
      ),
    );
  }
  if (to === "closed") {
    const exp = await deps.journal.expireOnClose(deps.repo, issue);
    if (exp.ok === false) logger.error({ issue, error: exp.error }, "[lifecycle] journal expire failed");
  }
  return { ok: true, issue, from, to, mode, observed: observedOf(after) };
}

export async function operatorReopen(
  input: { issue: number; actor: string },
  deps: SeamDeps,
): Promise<AdvanceResult> {
  const issue = input.issue;
  const mode = await deps.mode();
  const jIn = { to: "reopened", actor: input.actor };
  const fail = async (code: string, from: string | null, written: boolean): Promise<AdvanceResult> => {
    await journal(
      deps,
      issue,
      operatorEntry(deps, { kind: "refused", from, result: written ? code : `refused:${code}`, written }, jIn),
    );
    return { ok: false, issue, code, mode, written };
  };

  const before = await deps.view(issue);
  if (before.ok === false) return fail("fetch-failed", null, false);
  if (before.row.state !== "CLOSED") {
    // Reopening an already-OPEN issue stays idempotent (the pre-seam spine
    // accepted it): ok with the observed state, no write, no persist, no journal.
    const open = stateLabelsOf(before.row.labels);
    return {
      ok: true,
      issue,
      from: open.length > 0 ? open.join(",") : null,
      to: (open[0] ?? "needs-triage") as LifecycleState,
      mode,
      observed: observedOf(before),
    };
  }
  if (!deps.reopen) return fail("write-failed:no-reopen", "closed", false);
  const write = await deps.reopen(issue);
  if (write.ok === false) return fail(`write-failed:${write.code}`, "closed", false);

  const after = await deps.view(issue);
  if (after.ok === false || after.row.state !== "OPEN") return fail("write-unverified", "closed", true);

  // Decision 5: reopening drops the close-retention clock BEFORE journaling.
  if (deps.journal.persist) {
    const p = await deps.journal.persist(deps.repo, issue);
    if (p.ok === false) logger.error({ issue, error: p.error }, "[lifecycle] journal persist failed");
  }
  const derived = stateLabelsOf(after.row.labels);
  await journal(
    deps,
    issue,
    operatorEntry(
      deps,
      { kind: "transition", from: "closed", to: derived.length > 0 ? derived.join(",") : null, result: "ok", written: true },
      jIn,
    ),
  );
  return {
    ok: true,
    issue,
    from: "closed",
    to: (derived[0] ?? "needs-triage") as LifecycleState,
    mode,
    observed: observedOf(after),
  };
}

