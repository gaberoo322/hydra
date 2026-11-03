/**
 * Lifecycle writer seam (ADR-0047 Decisions 3, 4, 5, 7; issue #5310).
 *
 * The re-read -> gate -> write -> verify spine, generalised from
 * `runVerifiedAction` (src/api/autopilot-board.ts). Spine order is fixed:
 *
 *   re-read (viewIssue) -> derive state -> human-hold refuse -> legality ->
 *   fetch records (injected) -> pure gate -> mode branch -> ONE gh write ->
 *   re-read verify -> journal append
 *
 * Never throws and never falls back to a direct label write: a failed fetch is
 * a `fetch-failed` refusal, a failed write is `write-failed:<gh-code>`, a
 * post-write mismatch is `write-unverified`. Every external effect (gh, Redis,
 * clock, mode) is an injectable dep so the whole spine is testable offline.
 *
 * Shadow vs enforce: in `shadow` a failing/illegal (non-human-hold) transition
 * STILL writes and journals ONE `refused` entry `shadow-would-refuse:<code>`
 * (`written:true`); in `enforce` it journals `refused:<code>` (`written:false`).
 * Human-hold exits are refused in BOTH modes, before the mode branch.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.ts";
import {
  closeIssue,
  editIssueLabels,
  viewIssue,
  type IssueActionWriteResult,
  type IssueViewResult,
} from "../github/issue-actions.ts";
import { resolveGithubRepo, viewPr } from "../github/issues.ts";
import {
  CLAIM_OWNER_MISMATCH,
  appendLifecycleEntry,
  closeDispatchClaim,
  expireJournalOnClose,
  openDispatchClaim,
  type CloseClaimResult,
  type DispatchClaim,
  type JournalWriteResult,
  type LifecycleJournalEntry,
  type OpenClaimResult,
} from "../redis/lifecycle-journal.ts";
import { getDesignConceptHash } from "../redis/design-concept.ts";
import {
  evaluateGate,
  parsePrEvidence,
  recordsNeeded,
  type DesignConceptRecord,
  type Fetched,
  type GateInput,
  type GateRecords,
  type PrRecord,
} from "./gates.ts";
import {
  findTransition,
  isHumanHold,
  isLifecycleState,
  stateLabelsOf,
  type LifecycleState,
} from "./transitions.ts";

// ---------------------------------------------------------------------------
// Rollout switch
// ---------------------------------------------------------------------------

export const LIFECYCLE_ROLLOUT_CONFIG_PATH = "config/orchestrator/lifecycle-rollout.json";
export type LifecycleMode = "shadow" | "enforce";
export type ModeReason = "config-missing" | "key-missing" | "value-malformed";

export interface ResolvedMode {
  mode: LifecycleMode;
  /** Why the mode fell back to shadow; null when the file said so explicitly. */
  reason: ModeReason | null;
}

/** Pure and total over unknown input: anything but the literal `'enforce'` is shadow. */
export function resolveLifecycleMode(raw: unknown): ResolvedMode {
  if (raw === undefined) return { mode: "shadow", reason: "config-missing" };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { mode: "shadow", reason: "value-malformed" };
  }
  const obj = raw as Record<string, unknown>;
  if (!("lifecycle-seam" in obj)) return { mode: "shadow", reason: "key-missing" };
  const v = obj["lifecycle-seam"];
  if (v === "enforce") return { mode: "enforce", reason: null };
  if (v === "shadow") return { mode: "shadow", reason: null };
  return { mode: "shadow", reason: "value-malformed" };
}

export async function loadLifecycleMode(
  repoRoot: string,
  deps: { readFile?: (path: string) => Promise<string> } = {},
): Promise<ResolvedMode> {
  const read = deps.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  let text: string;
  try {
    text = await read(join(repoRoot, LIFECYCLE_ROLLOUT_CONFIG_PATH));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "ENOENT") {
      logger.warn({ err }, "[lifecycle] rollout config unreadable; defaulting to shadow");
    }
    return resolveLifecycleMode(undefined);
  }
  try {
    return resolveLifecycleMode(JSON.parse(text));
  } catch (err) {
    logger.warn({ err }, "[lifecycle] rollout config malformed; defaulting to shadow");
    return { mode: "shadow", reason: "value-malformed" };
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SeamDeps {
  repo: string;
  mode: () => Promise<LifecycleMode>;
  view: (issue: number) => Promise<IssueViewResult>;
  edit: (
    issue: number,
    labels: { remove: string[]; add: string[] },
  ) => Promise<IssueActionWriteResult>;
  close: (issue: number, reason: string) => Promise<IssueActionWriteResult>;
  fetch: {
    designConcept: (issue: number) => Promise<Fetched<DesignConceptRecord>>;
    pr: (prNumber: number) => Promise<Fetched<PrRecord>>;
  };
  journal: {
    append: (repo: string, issue: number, entry: LifecycleJournalEntry) => Promise<JournalWriteResult>;
    expireOnClose: (repo: string, issue: number) => Promise<JournalWriteResult>;
    openClaim: (repo: string, issue: number, claim: DispatchClaim) => Promise<OpenClaimResult>;
    closeClaim: (repo: string, issue: number, expectedDispatchId: string) => Promise<CloseClaimResult>;
  };
  now: () => number;
}

/** Production deps: real gh, real Redis, mode read from the git-tracked config. */
export function defaultSeamDeps(repoRoot: string): SeamDeps {
  return {
    repo: resolveGithubRepo(),
    mode: async () => (await loadLifecycleMode(repoRoot)).mode,
    view: (n) => viewIssue(n),
    edit: (n, labels) => editIssueLabels(n, labels),
    close: (n, reason) => closeIssue(n, reason),
    fetch: {
      designConcept: async (n) => {
        try {
          const hash = await getDesignConceptHash(`issue-${n}`);
          return {
            ok: true,
            value: { exists: Object.keys(hash).length > 0, status: hash.status ?? "" },
          };
        } catch (err) {
          logger.error({ err }, "[lifecycle] design-concept fetch failed");
          return { ok: false };
        }
      },
      pr: async (prNumber) => {
        try {
          const pr = await viewPr<{ number?: number; state?: string; body?: string }>(
            prNumber,
            "number,state,body",
          );
          if (pr === null || typeof pr.number !== "number") return { ok: false };
          return {
            ok: true,
            value: { number: pr.number, state: String(pr.state ?? "").toUpperCase(), body: pr.body ?? "" },
          };
        } catch (err) {
          logger.error({ err, prNumber }, "[lifecycle] pr fetch failed");
          return { ok: false };
        }
      },
    },
    journal: {
      append: appendLifecycleEntry,
      expireOnClose: expireJournalOnClose,
      openClaim: openDispatchClaim,
      closeClaim: closeDispatchClaim,
    },
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

export interface AdvanceInput {
  issue: number;
  to: string;
  evidence?: Record<string, string>;
  reason?: string;
  rationale?: string;
  /** `completed` (default) or `not planned`, when `to === "closed"`. */
  closeReason?: string;
  actor?: string;
}

export type AdvanceResult =
  | {
      ok: true;
      issue: number;
      from: string | null;
      to: LifecycleState;
      mode: LifecycleMode;
      /** Set in shadow when the transition would have been refused in enforce. */
      wouldRefuse?: string;
    }
  | { ok: false; issue: number; code: string; mode: LifecycleMode | null; written: boolean };

function entry(
  deps: SeamDeps,
  over: Partial<LifecycleJournalEntry> & Pick<LifecycleJournalEntry, "kind" | "result" | "written">,
  input: AdvanceInput,
): LifecycleJournalEntry {
  return {
    v: 1,
    ts: deps.now(),
    from: null,
    to: input.to,
    source: "cli",
    actor: input.actor ?? "cli",
    evidence: input.evidence ?? {},
    reason: input.reason ?? null,
    rationale: input.rationale ?? null,
    ...over,
  };
}

async function journal(deps: SeamDeps, issue: number, e: LifecycleJournalEntry): Promise<void> {
  const res = await deps.journal.append(deps.repo, issue, e);
  if (res.ok === false) logger.error({ issue, error: res.error }, "[lifecycle] journal append failed");
}

/** `not-planned` (artifact / reasons spelling) and `not planned` (gh spelling) are one reason. */
export function normaliseCloseReason(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : raw.trim().toLowerCase().replace(/[-_]+/g, " ");
}

export async function advance(input: AdvanceInput, deps: SeamDeps): Promise<AdvanceResult> {
  const issue = input.issue;
  if (!isLifecycleState(input.to)) {
    return { ok: false, issue, code: "unknown-target-state", mode: null, written: false };
  }
  const to: LifecycleState = input.to;
  const closeReason = normaliseCloseReason(input.closeReason);
  const mode = await deps.mode();

  // 1. re-read
  const before = await deps.view(issue);
  if (before.ok === false) {
    await journal(deps, issue, entry(deps, { kind: "refused", result: "refused:fetch-failed", written: false }, input));
    return { ok: false, issue, code: "fetch-failed", mode, written: false };
  }

  // 2. derive state
  const isClosed = before.row.state === "CLOSED";
  const stateLabels = stateLabelsOf(before.row.labels);
  const flags = before.row.labels.filter((l) => !(stateLabels as string[]).includes(l));
  const from: string | null = isClosed
    ? "closed"
    : stateLabels.length === 1
      ? stateLabels[0]
      : null;

  // 3. human-hold exit: refused in BOTH modes, before the mode branch.
  if (!isClosed && stateLabels.some((s) => isHumanHold(s))) {
    await journal(
      deps,
      issue,
      entry(deps, { kind: "refused", from: stateLabels.join(","), result: "refused:human-hold-exit", written: false }, input),
    );
    return { ok: false, issue, code: "human-hold-exit", mode, written: false };
  }
  // A closed issue has nothing to advance: refused in both modes.
  if (isClosed) {
    await journal(deps, issue, entry(deps, { kind: "refused", from, result: "refused:issue-closed", written: false }, input));
    return { ok: false, issue, code: "issue-closed", mode, written: false };
  }

  // 4. legality. `none` (zero state labels) may only enter needs-triage, gate-free;
  //    every other move refuses `state-missing`. `many` refuses `state-ambiguous`.
  const transition = from === null ? undefined : findTransition(from as LifecycleState, to);
  let verdict: { ok: boolean; code: string };
  if (stateLabels.length === 0) {
    verdict = to === "needs-triage" ? { ok: true, code: "ok" } : { ok: false, code: "state-missing" };
  } else if (stateLabels.length > 1) {
    verdict = { ok: false, code: "state-ambiguous" };
  } else if (transition === undefined) {
    verdict = { ok: false, code: "illegal-transition" };
  } else {
    // 5. fetch records via injected fetchers, then the pure gate.
    const needs = recordsNeeded(transition.gate);
    const records: GateRecords = {};
    if (needs.designConcept) records.designConcept = await deps.fetch.designConcept(issue);
    if (needs.pr) {
      const prNumber = parsePrEvidence(input.evidence ?? {});
      records.pr = prNumber !== null && prNumber > 0 ? await deps.fetch.pr(prNumber) : undefined;
    }
    const gateInput: GateInput = {
      issue,
      from: transition.from,
      to,
      flags,
      evidence: input.evidence ?? {},
      reason: input.reason,
      rationale: input.rationale,
      closeReason: to === "closed" ? (closeReason ?? "completed") : undefined,
    };
    verdict = evaluateGate(transition.gate, gateInput, records);
  }

  // 6. mode branch
  if (!verdict.ok && mode === "enforce") {
    await journal(deps, issue, entry(deps, { kind: "refused", from, result: `refused:${verdict.code}`, written: false }, input));
    return { ok: false, issue, code: verdict.code, mode, written: false };
  }

  // 7. ONE gh write
  const removed = stateLabels.filter((s) => s !== to);
  const write =
    to === "closed"
      ? await deps.close(issue, closeReason ?? "completed")
      : await deps.edit(issue, { remove: [...removed], add: [to] });
  if (write.ok === false) {
    const code = `write-failed:${write.code}`;
    await journal(deps, issue, entry(deps, { kind: "refused", from, result: code, written: false }, input));
    return { ok: false, issue, code, mode, written: false };
  }

  // 8. re-read verify
  const after = await deps.view(issue);
  const verified =
    after.ok &&
    (to === "closed"
      ? after.row.state === "CLOSED"
      : after.row.labels.includes(to) && removed.every((s) => !after.row.labels.includes(s)));
  if (!verified) {
    await journal(deps, issue, entry(deps, { kind: "refused", from, result: "write-unverified", written: true }, input));
    return { ok: false, issue, code: "write-unverified", mode, written: true };
  }

  // 9. journal (after verify, so `result` reflects what GitHub shows)
  if (verdict.ok) {
    await journal(deps, issue, entry(deps, { kind: "transition", from, result: "ok", written: true }, input));
  } else {
    await journal(
      deps,
      issue,
      entry(deps, { kind: "refused", from, result: `shadow-would-refuse:${verdict.code}`, written: true }, input),
    );
  }
  if (to === "closed") {
    const exp = await deps.journal.expireOnClose(deps.repo, issue);
    if (exp.ok === false) logger.error({ issue, error: exp.error }, "[lifecycle] journal expire failed");
  }
  return {
    ok: true,
    issue,
    from,
    to,
    mode,
    ...(verdict.ok ? {} : { wouldRefuse: verdict.code }),
  };
}

// ---------------------------------------------------------------------------
// claim / release (change no label)
// ---------------------------------------------------------------------------

export interface ClaimInput {
  issue: number;
  dispatchId: string;
  class: string;
  run: string;
  artifactHash?: string | null;
  actor?: string;
}

export type ClaimResult =
  | { ok: true; claim: DispatchClaim }
  | { ok: false; code: "claim-held" | "redis-failed"; existing?: DispatchClaim | null };

function claimEntry(
  deps: SeamDeps,
  kind: "claim-opened" | "claim-closed",
  actor: string,
  evidence: Record<string, string>,
): LifecycleJournalEntry {
  return {
    v: 1,
    ts: deps.now(),
    kind,
    from: null,
    to: null,
    source: "cli",
    actor,
    evidence,
    reason: null,
    rationale: null,
    result: "ok",
    written: true,
  };
}

export async function openClaim(input: ClaimInput, deps: SeamDeps): Promise<ClaimResult> {
  const claim: DispatchClaim = {
    dispatchId: input.dispatchId,
    class: input.class,
    run: input.run,
    artifactHash: input.artifactHash ?? null,
    openedAt: deps.now(),
  };
  const res = await deps.journal.openClaim(deps.repo, input.issue, claim);
  if (res.ok === false) {
    return res.code === "claim-held"
      ? { ok: false, code: "claim-held", existing: res.existing }
      : { ok: false, code: "redis-failed" };
  }
  await journal(
    deps,
    input.issue,
    claimEntry(deps, "claim-opened", input.actor ?? "cli", { dispatch: input.dispatchId, class: input.class, run: input.run }),
  );
  return { ok: true, claim };
}

/**
 * Release a dispatch claim. `dispatchId` is REQUIRED: every release goes through
 * the atomic compare-and-delete ownership check (INV-11), so a release can never
 * delete a claim another dispatch holds. There is deliberately no force path.
 */
export async function releaseClaim(
  issue: number,
  dispatchId: string,
  deps: SeamDeps,
  actor = "cli",
): Promise<{ ok: true; prior: DispatchClaim | null } | { ok: false; code: "redis-failed" | "claim-owner-mismatch" }> {
  const res = await deps.journal.closeClaim(deps.repo, issue, dispatchId);
  if (res.ok === false) {
    return { ok: false, code: res.error === CLAIM_OWNER_MISMATCH ? "claim-owner-mismatch" : "redis-failed" };
  }
  await journal(
    deps,
    issue,
    claimEntry(deps, "claim-closed", actor, res.prior ? { dispatch: res.prior.dispatchId } : {}),
  );
  return { ok: true, prior: res.prior };
}
