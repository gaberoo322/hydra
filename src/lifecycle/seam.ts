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
import { ghExec, ghJson } from "../github/gh.ts";
import { isGhFailure } from "../github/exec.ts";
import { resolveGithubRepo, viewPr } from "../github/issues.ts";
import { listRequiredStatusContextsOrNull, parseRollupEntries } from "../github/prs.ts";
import { foldRollup, isRed, isSettled } from "../github/check-rollup.ts";
import {
  CLAIM_OWNER_MISMATCH,
  appendLifecycleEntry,
  closeDispatchClaim,
  expireJournalOnClose,
  openDispatchClaim,
  readDispatchClaim,
  readLifecycleJournal,
  type CloseClaimResult,
  type DispatchClaim,
  type JournalWriteResult,
  type LifecycleJournalEntry,
  type OpenClaimResult,
  type ReadClaimResult,
  type ReadJournalResult,
} from "../redis/lifecycle-journal.ts";
import { getDesignConceptHash } from "../redis/design-concept.ts";
import {
  evaluateGate,
  parseCommentEvidence,
  parsePrEvidence,
  recordsNeeded,
  type CommentRecord,
  type DesignConceptRecord,
  type Fetched,
  type GateInput,
  type GateRecords,
  type PrRecord,
  type QaLivePr,
  type StateEntryRecord,
} from "./gates.ts";
import {
  buildSeedEvidence,
  countReviewedFailRoundsSinceReset,
  evaluateCaps,
  isJournalMiss,
  latestResetMs,
  resolveCapLimits,
  type CapAttempt,
  type CapEvaluation,
  type TimelineLabelEvent,
} from "./caps.ts";
import { parkForCap } from "./park.ts";
import { classRole } from "./caps.ts";
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
  /** Post a comment on an issue or PR number. */
  comment: (number: number, body: string) => Promise<IssueActionWriteResult>;
  /** Env the cap limits are resolved from (`HYDRA_LIFECYCLE_CAP_*`). */
  env: () => Readonly<Record<string, string | undefined>>;
  fetch: {
    designConcept: (issue: number) => Promise<Fetched<DesignConceptRecord>>;
    pr: (prNumber: number) => Promise<Fetched<PrRecord>>;
    comment: (commentId: number) => Promise<Fetched<CommentRecord>>;
    /** Latest `labeled` event time for `state` on the issue (the entry clock). */
    stateEntry: (issue: number, state: string) => Promise<Fetched<StateEntryRecord>>;
    /** The issue's comment bodies (carry the `Hydra-Cap-Reset:` marker). */
    issueComments: (issue: number) => Promise<Fetched<string[]>>;
    /** The issue's `labeled` / `unlabeled` timeline events. */
    timeline: (issue: number) => Promise<Fetched<TimelineLabelEvent[]>>;
    /** A PR's comment bodies then review bodies, chronological (carry `QA-Verdict:` trailers). */
    prBodies: (prNumber: number) => Promise<Fetched<string[]>>;
    /** A PR read live at head for the `qa-passed` exit gate; absent = fail closed (`fetch-failed`). */
    qaLive?: (prNumber: number) => Promise<Fetched<QaLivePr>>;
  };
  journal: {
    append: (repo: string, issue: number, entry: LifecycleJournalEntry) => Promise<JournalWriteResult>;
    expireOnClose: (repo: string, issue: number) => Promise<JournalWriteResult>;
    openClaim: (repo: string, issue: number, claim: DispatchClaim) => Promise<OpenClaimResult>;
    closeClaim: (repo: string, issue: number, expectedDispatchId: string) => Promise<CloseClaimResult>;
    read: (repo: string, issue: number) => Promise<ReadJournalResult>;
    readClaim: (repo: string, issue: number) => Promise<ReadClaimResult>;
  };
  now: () => number;
}

/** One `gh api` read of an issue comment; binds repo + issue from `issue_url`. Never throws. */
export async function fetchComment(repo: string, commentId: number): Promise<Fetched<CommentRecord>> {
  try {
    const res = await ghJson<{ id?: unknown; body?: unknown; created_at?: unknown; issue_url?: unknown }>([
      "api",
      `repos/${repo}/issues/comments/${commentId}`,
    ]);
    if (isGhFailure(res)) return { ok: false };
    const d = res.data;
    const url = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(typeof d.issue_url === "string" ? d.issue_url : "");
    const createdAtMs = typeof d.created_at === "string" ? Date.parse(d.created_at) : Number.NaN;
    if (!url || typeof d.body !== "string" || Number.isNaN(createdAtMs)) {
      logger.error({ commentId }, "[lifecycle] comment record malformed");
      return { ok: false };
    }
    return { ok: true, value: { id: commentId, repo: url[1], issue: Number(url[2]), createdAtMs, body: d.body } };
  } catch (err) {
    logger.error({ err, commentId }, "[lifecycle] comment fetch failed");
    return { ok: false };
  }
}

/** Latest `labeled` event for `state` from the issue's paginated events. Never throws. */
export async function fetchStateEntry(
  repo: string,
  issue: number,
  state: string,
): Promise<Fetched<StateEntryRecord>> {
  try {
    const res = await ghJson<unknown>(["api", `repos/${repo}/issues/${issue}/events`, "--paginate", "--slurp"]);
    if (isGhFailure(res) || !Array.isArray(res.data)) return { ok: false };
    const events = res.data.flatMap((page) => (Array.isArray(page) ? page : [page]));
    let latest: number | null = null;
    for (const ev of events) {
      const e = ev as { event?: unknown; label?: { name?: unknown }; created_at?: unknown } | null;
      if (!e || e.event !== "labeled" || e.label?.name !== state) continue;
      const t = typeof e.created_at === "string" ? Date.parse(e.created_at) : Number.NaN;
      if (Number.isNaN(t)) {
        logger.error({ issue, state }, "[lifecycle] state-entry event has unparseable created_at");
        return { ok: false };
      }
      if (latest === null || t > latest) latest = t;
    }
    return { ok: true, value: { enteredAtMs: latest } };
  } catch (err) {
    logger.error({ err, issue }, "[lifecycle] state-entry fetch failed");
    return { ok: false };
  }
}

/** Issue comment bodies in order. Never throws. */
export async function fetchIssueComments(repo: string, issue: number): Promise<Fetched<string[]>> {
  try {
    const res = await ghJson<unknown>(["api", `repos/${repo}/issues/${issue}/comments`, "--paginate", "--slurp"]);
    if (isGhFailure(res) || !Array.isArray(res.data)) return { ok: false };
    const comments = res.data.flatMap((page) => (Array.isArray(page) ? page : [page]));
    return { ok: true, value: comments.map((c) => String((c as { body?: unknown } | null)?.body ?? "")) };
  } catch (err) {
    logger.error({ err, issue }, "[lifecycle] issue comments fetch failed");
    return { ok: false };
  }
}

/** The issue timeline reduced to label events. Never throws. */
export async function fetchLabelTimeline(repo: string, issue: number): Promise<Fetched<TimelineLabelEvent[]>> {
  try {
    const res = await ghJson<unknown>(["api", `repos/${repo}/issues/${issue}/timeline`, "--paginate", "--slurp"]);
    if (isGhFailure(res) || !Array.isArray(res.data)) return { ok: false };
    const events = res.data.flatMap((page) => (Array.isArray(page) ? page : [page]));
    const out: TimelineLabelEvent[] = [];
    for (const ev of events) {
      const e = ev as { event?: unknown; label?: { name?: unknown }; created_at?: unknown } | null;
      if (!e || (e.event !== "labeled" && e.event !== "unlabeled") || typeof e.label?.name !== "string") continue;
      const t = typeof e.created_at === "string" ? Date.parse(e.created_at) : Number.NaN;
      if (Number.isNaN(t)) {
        logger.error({ issue }, "[lifecycle] timeline event has unparseable created_at");
        return { ok: false };
      }
      out.push({ event: e.event, label: e.label.name, tsMs: t });
    }
    return { ok: true, value: out };
  } catch (err) {
    logger.error({ err, issue }, "[lifecycle] timeline fetch failed");
    return { ok: false };
  }
}

/** A PR's comment bodies followed by its review bodies. Never throws. */
export async function fetchPrBodies(repo: string, prNumber: number): Promise<Fetched<string[]>> {
  try {
    const res = await ghJson<{ comments?: unknown; reviews?: unknown }>([
      "pr", "view", String(prNumber), "--repo", repo, "--json", "comments,reviews",
    ]);
    if (isGhFailure(res) || !res.data || typeof res.data !== "object") return { ok: false };
    const bodies = (list: unknown): string[] =>
      Array.isArray(list) ? list.map((c) => String((c as { body?: unknown } | null)?.body ?? "")) : [];
    return { ok: true, value: [...bodies(res.data.comments), ...bodies(res.data.reviews)] };
  } catch (err) {
    logger.error({ err, prNumber }, "[lifecycle] pr bodies fetch failed");
    return { ok: false };
  }
}

/**
 * A PR read live at head for the `qa-passed` exit decision: state, draft,
 * `mergeStateStatus`, head sha, the REQUIRED checks folded to one verdict, and
 * the comment + review bodies (they carry the `QA-Verdict:` trailers). Required
 * contexts are read, never guessed; an unreadable set folds to `unknown`.
 * Never throws.
 */
export async function fetchQaLive(repo: string, prNumber: number): Promise<Fetched<QaLivePr>> {
  try {
    const res = await ghJson<Record<string, unknown>>([
      "pr", "view", String(prNumber), "--repo", repo, "--json",
      "number,state,isDraft,mergeStateStatus,headRefOid,statusCheckRollup,comments,reviews",
    ]);
    if (isGhFailure(res) || !res.data || typeof res.data !== "object") return { ok: false };
    const d = res.data;
    if (typeof d.number !== "number" || typeof d.state !== "string") return { ok: false };
    const required = await listRequiredStatusContextsOrNull("lifecycle", { repo });
    let checks: QaLivePr["checks"] = "unknown";
    if (required !== null) {
      const fold = foldRollup(parseRollupEntries(d.statusCheckRollup), { required });
      checks = !isSettled(fold) ? "pending" : isRed(fold) ? "red" : "green";
    }
    const bodies = (list: unknown): string[] =>
      Array.isArray(list) ? list.map((c) => String((c as { body?: unknown } | null)?.body ?? "")) : [];
    return {
      ok: true,
      value: {
        number: d.number,
        state: d.state.toUpperCase(),
        isDraft: d.isDraft === true,
        mergeStateStatus: typeof d.mergeStateStatus === "string" ? d.mergeStateStatus.toUpperCase() : "",
        headSha: typeof d.headRefOid === "string" ? d.headRefOid : "",
        checks,
        bodies: [...bodies(d.comments), ...bodies(d.reviews)],
      },
    };
  } catch (err) {
    logger.error({ err, prNumber }, "[lifecycle] qa-live pr fetch failed");
    return { ok: false };
  }
}

/** Post a comment on an issue or PR number. Never throws. */
export async function postIssueComment(repo: string, number: number, body: string): Promise<IssueActionWriteResult> {
  try {
    const res = await ghExec(["issue", "comment", String(number), "--repo", repo, "--body", body]);
    if (res.ok === false) return { ok: false, code: res.code, stderr: res.stderr };
    return { ok: true };
  } catch (err) {
    logger.error({ err, number }, "[lifecycle] comment post failed");
    return { ok: false, code: "gh-failed", stderr: String(err) };
  }
}

/** Production deps: real gh, real Redis, mode read from the git-tracked config. */
export function defaultSeamDeps(repoRoot: string): SeamDeps {
  return {
    repo: resolveGithubRepo(),
    mode: async () => (await loadLifecycleMode(repoRoot)).mode,
    view: (n) => viewIssue(n),
    edit: (n, labels) => editIssueLabels(n, labels),
    close: (n, reason) => closeIssue(n, reason),
    comment: (n, body) => postIssueComment(resolveGithubRepo(), n, body),
    env: () => process.env,
    fetch: {
      designConcept: async (n) => {
        try {
          const hash = await getDesignConceptHash(`issue-${n}`);
          return {
            ok: true,
            value: {
              exists: Object.keys(hash).length > 0,
              status: hash.status ?? "",
              artifactHash: hash.artifactHash ? hash.artifactHash : null,
            },
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
      comment: (commentId) => fetchComment(resolveGithubRepo(), commentId),
      stateEntry: (issue, state) => fetchStateEntry(resolveGithubRepo(), issue, state),
      issueComments: (issue) => fetchIssueComments(resolveGithubRepo(), issue),
      timeline: (issue) => fetchLabelTimeline(resolveGithubRepo(), issue),
      prBodies: (prNumber) => fetchPrBodies(resolveGithubRepo(), prNumber),
      qaLive: (prNumber) => fetchQaLive(resolveGithubRepo(), prNumber),
    },
    journal: {
      append: appendLifecycleEntry,
      expireOnClose: expireJournalOnClose,
      openClaim: openDispatchClaim,
      closeClaim: closeDispatchClaim,
      read: readLifecycleJournal,
      readClaim: readDispatchClaim,
    },
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// cap check (ADR-0047 D6, issue #5314)
// ---------------------------------------------------------------------------

export type CapCheck =
  | { status: "skipped" }
  | { status: "checked"; evaluation: CapEvaluation };

/**
 * Gather every cap source and evaluate. Any fetch failure (issue comments,
 * journal AND timeline, PR bodies) skips the check for this call (INV-12): the
 * attempt proceeds and never parks. Never throws.
 */
async function checkCaps(
  deps: SeamDeps,
  issue: number,
  attempt: CapAttempt,
  pr: number | null,
): Promise<CapCheck> {
  try {
    const comments = await deps.fetch.issueComments(issue);
    if (comments.ok === false) return { status: "skipped" };
    const resetMs = latestResetMs(comments.value);
    const resolved = resolveCapLimits(deps.env());
    for (const w of resolved.warnings) logger.warn({ issue }, `[lifecycle] ${w}`);

    const journalRead = await deps.journal.read(deps.repo, issue);
    const entries = journalRead.ok ? journalRead.entries : [];
    const journalFailed = journalRead.ok === false;
    let timeline: TimelineLabelEvent[] | null = null;
    if (isJournalMiss(entries, resetMs, journalFailed)) {
      const t = await deps.fetch.timeline(issue);
      if (t.ok === false) return { status: "skipped" };
      timeline = t.value;
    }
    let trailerRounds: number | null = null;
    if (pr !== null) {
      const bodies = await deps.fetch.prBodies(pr);
      if (bodies.ok === false) return { status: "skipped" };
      trailerRounds = countReviewedFailRoundsSinceReset(bodies.value, pr);
    }
    const evaluation = evaluateCaps({
      attempt,
      entries,
      journalFailed,
      resetMs,
      timeline,
      trailerRounds,
      limits: resolved.limits,
    });
    return { status: "checked", evaluation };
  } catch (err) {
    logger.error({ err, issue }, "[lifecycle] cap check crashed; skipping");
    return { status: "skipped" };
  }
}

/** Stamps cap evidence onto the FIRST journal entry of a call (skip marker or timeline seed). */
class CapStamp {
  private done = false;
  private check: CapCheck | null;
  constructor(check: CapCheck | null) {
    this.check = check;
  }
  /** The cap evidence to add to `e` (once per call); {} afterwards or when nothing applies. */
  extra(e: LifecycleJournalEntry): Record<string, string> {
    if (this.done || this.check === null) return {};
    this.done = true;
    if (this.check.status === "skipped") return { "cap-check": "skipped:fetch-failed" };
    const tl = this.check.evaluation.timelineCounts;
    return tl === null ? {} : buildSeedEvidence(tl, e);
  }
  apply(e: LifecycleJournalEntry): LifecycleJournalEntry {
    const extra = this.extra(e);
    return Object.keys(extra).length === 0 ? e : { ...e, evidence: { ...e.evidence, ...extra } };
  }
}

/** A throwaway entry shaped like the park transition, used only to compute seed contributions. */
function parkEntryProbe(deps: SeamDeps, over: NonNullable<CapEvaluation["over"]>): LifecycleJournalEntry {
  return {
    v: 1, ts: deps.now(), kind: "transition", from: null, to: "parked", source: "cli", actor: "cli",
    evidence: {}, reason: `cap:${over.arm}`, rationale: null, result: `parked:${over.arm}`, written: true,
  };
}

function shadowParkEntry(
  deps: SeamDeps,
  over: NonNullable<CapEvaluation["over"]>,
  from: string | null,
  pr: number | null,
  actor: string,
): LifecycleJournalEntry {
  return {
    v: 1,
    ts: deps.now(),
    kind: "refused",
    from,
    to: "parked",
    source: "cli",
    actor,
    evidence: {
      arm: over.arm,
      count: String(over.count),
      limit: String(over.limit),
      source: over.source,
      ...(pr !== null ? { pr: String(pr) } : {}),
    },
    reason: `cap:${over.arm}`,
    rationale: null,
    result: `shadow-would-park:${over.arm}`,
    written: false,
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
      /** Set in shadow when a cap check would have parked the issue in enforce. */
      wouldPark?: string;
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
  let stamp = new CapStamp(null);
  const gateEvidence = input.evidence ?? {};
  const jr = async (e: LifecycleJournalEntry): Promise<void> => journal(deps, issue, stamp.apply(e));

  // 1. re-read
  const before = await deps.view(issue);
  if (before.ok === false) {
    await jr(entry(deps, { kind: "refused", result: "refused:fetch-failed", written: false }, input));
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
    await jr(
      entry(deps, { kind: "refused", from: stateLabels.join(","), result: "refused:human-hold-exit", written: false }, input),
    );
    return { ok: false, issue, code: "human-hold-exit", mode, written: false };
  }
  // A closed issue has nothing to advance: refused in both modes.
  if (isClosed) {
    await jr(entry(deps, { kind: "refused", from, result: "refused:issue-closed", written: false }, input));
    return { ok: false, issue, code: "issue-closed", mode, written: false };
  }

  // 3b. cap check (ADR-0047 D6): the in-progress -> ready-for-agent edge IS the stale
  //     re-queue. Over cap in enforce the seam parks INSTEAD of writing ready-for-agent.
  let shadowOver: NonNullable<CapEvaluation["over"]> | null = null;
  if (stateLabels.length === 1 && from === "in-progress" && to === "ready-for-agent") {
    const check = await checkCaps(deps, issue, { kind: "requeue" }, null);
    stamp = new CapStamp(check);
    const over = check.status === "checked" ? check.evaluation.over : null;
    if (check.status === "checked" && over !== null) {
      if (mode === "enforce") {
        const park = await parkForCap(
          {
            issue,
            from,
            over,
            counts: check.evaluation.counts,
            pr: null,
            actor: input.actor,
            evidence: stamp.extra(parkEntryProbe(deps, over)),
          },
          deps,
        );
        return { ok: false, issue, code: `parked:${over.arm}`, mode, written: park.written };
      }
      shadowOver = over;
    }
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
      const prNumber = parsePrEvidence(gateEvidence);
      records.pr = prNumber !== null && prNumber > 0 ? await deps.fetch.pr(prNumber) : undefined;
    }
    if (needs.comment) {
      const commentId = parseCommentEvidence(gateEvidence);
      records.comment = commentId !== null ? await deps.fetch.comment(commentId) : undefined;
    }
    if (needs.qaLive) {
      const prNumber = parsePrEvidence(gateEvidence);
      records.qaLive =
        prNumber !== null && prNumber > 0 && deps.fetch.qaLive !== undefined
          ? await deps.fetch.qaLive(prNumber)
          : { ok: false };
    }
    if (needs.stateEntry) records.stateEntry = await deps.fetch.stateEntry(issue, transition.from);
    const gateInput: GateInput = {
      issue,
      repo: deps.repo,
      body: before.row.body,
      from: transition.from,
      to,
      flags,
      evidence: gateEvidence,
      reason: input.reason,
      rationale: input.rationale,
      closeReason: to === "closed" ? (closeReason ?? "completed") : undefined,
    };
    verdict = evaluateGate(transition.gate, gateInput, records);
  }

  // 6. mode branch
  if (!verdict.ok && mode === "enforce") {
    await jr(entry(deps, { kind: "refused", from, result: `refused:${verdict.code}`, written: false }, input));
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
    await jr(entry(deps, { kind: "refused", from, result: code, written: false }, input));
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
    await jr(entry(deps, { kind: "refused", from, result: "write-unverified", written: true }, input));
    return { ok: false, issue, code: "write-unverified", mode, written: true };
  }

  // 9. journal (after verify, so `result` reflects what GitHub shows)
  if (verdict.ok) {
    await jr(entry(deps, { kind: "transition", from, result: "ok", written: true }, input));
  } else {
    await jr(
      entry(deps, { kind: "refused", from, result: `shadow-would-refuse:${verdict.code}`, written: true }, input),
    );
  }
  if (shadowOver !== null) await jr(shadowParkEntry(deps, shadowOver, from, null, input.actor ?? "cli"));
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
    ...(shadowOver !== null ? { wouldPark: shadowOver.arm } : {}),
  };
}

// ---------------------------------------------------------------------------
// claim / release (change no label, except a cap park)
// ---------------------------------------------------------------------------

export type ClaimPurpose = "fresh" | "resume" | "forward-fix";
export const CLAIM_PURPOSES: readonly ClaimPurpose[] = ["fresh", "resume", "forward-fix"];

/** Closed enum a claim is released with (ADR-0047 D5/D6). */
export const CLAIM_OUTCOMES = ["pr-opened", "no-pr", "verdict-posted", "stall", "released"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/** Class of the one-time placeholder claim `scripts/lifecycle-legacy-backfill.ts` opens. */
export const LEGACY_BACKFILL_CLASS = "legacy-backfill";

export interface ClaimInput {
  issue: number;
  dispatchId: string;
  class: string;
  run: string;
  artifactHash?: string | null;
  actor?: string;
  /** The PR this dispatch works on (QA / forward-fix); arms the PR-unit caps. */
  pr?: number;
  purpose?: ClaimPurpose;
}

export type ClaimResult =
  | {
      ok: true;
      claim: DispatchClaim;
      /** Set in shadow when the cap check would have parked this claim in enforce. */
      wouldPark?: string;
    }
  | { ok: false; code: "claim-held" | "redis-failed"; existing?: DispatchClaim | null }
  | { ok: false; code: `parked:${string}`; written: boolean };

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
  const issue = input.issue;
  const actor = input.actor ?? "cli";
  const claim: DispatchClaim = {
    dispatchId: input.dispatchId,
    class: input.class,
    run: input.run,
    artifactHash: input.artifactHash ?? null,
    openedAt: deps.now(),
  };

  // INV-10: the claim-held check runs BEFORE any counting or park.
  // INV-2 (#5315): SET NX is the concurrency gate in both modes. The ONE exception is a
  // held `legacy-backfill` placeholder: it is released (ownership-checked by its own
  // dispatchId, outcome `released`) and the real dispatch's claim is opened in this call.
  let held = await deps.journal.readClaim(deps.repo, issue);
  if (held.ok && held.claim && held.claim.class === LEGACY_BACKFILL_CLASS) {
    const released = await releaseClaim(issue, held.claim.dispatchId, deps, actor, "released");
    if (released.ok) held = { ok: true, claim: null };
  }
  if (held.ok && held.claim) return { ok: false, code: "claim-held", existing: held.claim };

  // Re-read the issue to stamp `state` (INV-13). A failed read skips the cap check (INV-12).
  const mode = await deps.mode();
  const view = await deps.view(issue);
  let state = "unknown";
  let capState = "";
  if (view.ok) {
    const labels = stateLabelsOf(view.row.labels);
    state = labels.length === 1 ? labels[0] : "none";
    capState = labels.length === 1 ? labels[0] : "";
  }
  const check: CapCheck = view.ok
    ? await checkCaps(
        deps,
        issue,
        { kind: "claim", class: input.class, state: capState, pr: input.pr ?? null, purpose: input.purpose ?? null },
        input.pr ?? null,
      )
    : { status: "skipped" };
  const stamp = new CapStamp(check);
  const over = check.status === "checked" ? check.evaluation.over : null;

  if (check.status === "checked" && over !== null && mode === "enforce") {
    const park = await parkForCap(
      {
        issue,
        from: capState === "" ? null : capState,
        over,
        counts: check.evaluation.counts,
        pr: input.pr ?? null,
        actor,
        evidence: stamp.extra(parkEntryProbe(deps, over)),
      },
      deps,
    );
    return { ok: false, code: `parked:${over.arm}`, written: park.written };
  }

  const res = await deps.journal.openClaim(deps.repo, issue, claim);
  if (res.ok === false) {
    return res.code === "claim-held"
      ? { ok: false, code: "claim-held", existing: res.existing }
      : { ok: false, code: "redis-failed" };
  }
  await journal(
    deps,
    issue,
    stamp.apply(
      claimEntry(deps, "claim-opened", actor, {
        dispatch: input.dispatchId,
        class: input.class,
        run: input.run,
        state,
        ...(input.pr !== undefined ? { pr: String(input.pr) } : {}),
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      }),
    ),
  );
  if (check.status === "checked" && over !== null) {
    await journal(deps, issue, shadowParkEntry(deps, over, capState === "" ? null : capState, input.pr ?? null, actor));
    return { ok: true, claim, wouldPark: over.arm };
  }
  return { ok: true, claim };
}

/**
 * Release a dispatch claim. `dispatchId` is REQUIRED: every release goes through
 * the atomic compare-and-delete ownership check (INV-11), so a release can never
 * delete a claim another dispatch holds. There is deliberately no force path.
 * The optional `outcome` is recorded on the claim-closed entry for the cap arms.
 */
export async function releaseClaim(
  issue: number,
  dispatchId: string,
  deps: SeamDeps,
  actor = "cli",
  outcome?: ClaimOutcome,
): Promise<{ ok: true; prior: DispatchClaim | null } | { ok: false; code: "redis-failed" | "claim-owner-mismatch" }> {
  const res = await deps.journal.closeClaim(deps.repo, issue, dispatchId);
  if (res.ok === false) {
    return { ok: false, code: res.error === CLAIM_OWNER_MISMATCH ? "claim-owner-mismatch" : "redis-failed" };
  }
  await journal(
    deps,
    issue,
    claimEntry(deps, "claim-closed", actor, {
      ...(res.prior ? { dispatch: res.prior.dispatchId, class: res.prior.class } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    }),
  );
  return { ok: true, prior: res.prior };
}

// ---------------------------------------------------------------------------
// dispatch (ADR-0047 D4/D7, issue #5315): the dispatcher's one composite verb
// ---------------------------------------------------------------------------

/** States a dev-role dispatch advances to `in-progress` from. */
const DISPATCHABLE_STATES: readonly string[] = ["ready-for-agent", "needs-dev-resume"];

export interface DispatchInput {
  issue: number;
  dispatchId: string;
  class: string;
  run: string;
  pr?: number;
  purpose?: ClaimPurpose;
  actor?: string;
}

export type DispatchResult =
  | {
      ok: true;
      claim: DispatchClaim;
      /** The `-> in-progress` advance; `null` for a label-free (qa / other) claim or an already-in-progress issue. */
      advanced: AdvanceResult | null;
      /** Set when a dev claim was opened but no advance fired (zero/multiple/non-dispatchable state labels). */
      advanceSkipped?: "non-dispatchable-state";
      /** Set in shadow when the advance would have been refused in enforce. */
      wouldRefuse?: string;
      /** Set in shadow when a cap check would have parked the issue in enforce. */
      wouldPark?: string;
    }
  | { ok: false; code: string; existing?: DispatchClaim | null; mode?: LifecycleMode | null; written?: boolean };

/**
 * Open the claim, then (dev role only) fire `ready-for-agent|needs-dev-resume ->
 * in-progress`. Fixed order: design-concept record -> claim (artifactHash copied
 * only from an `approved` record) -> advance -> on a refused advance, release the
 * claim BEFORE returning, so a claim never outlives a refused dispatch. Never throws
 * and never falls back to a direct label write.
 */
export async function dispatch(input: DispatchInput, deps: SeamDeps): Promise<DispatchResult> {
  const issue = input.issue;
  const actor = input.actor ?? "cli";

  // (a) the Design Concept record; (b) its hash is copied onto the claim only when approved.
  const dc = await deps.fetch.designConcept(issue);
  const artifactHash =
    dc.ok && dc.value.exists && dc.value.status === "approved" ? (dc.value.artifactHash ?? null) : null;

  const opened = await openClaim(
    {
      issue,
      dispatchId: input.dispatchId,
      class: input.class,
      run: input.run,
      artifactHash,
      actor,
      pr: input.pr,
      purpose: input.purpose,
    },
    deps,
  );
  if (opened.ok === false) return opened;
  const parkNote = opened.wouldPark !== undefined ? { wouldPark: opened.wouldPark } : {};

  // A qa / other role class opens a label-free claim: steps (a)-(b) only.
  if (classRole(input.class) !== "dev") return { ok: true, claim: opened.claim, advanced: null, ...parkNote };

  const releaseAfterRefusal = async (): Promise<void> => {
    const rel = await releaseClaim(issue, input.dispatchId, deps, actor, "released");
    if (rel.ok === false) {
      logger.error(
        { issue, dispatchId: input.dispatchId, code: rel.code },
        "[lifecycle] claim release after refused dispatch failed",
      );
    }
  };

  // (c) advance only from a single dispatchable state label.
  const view = await deps.view(issue);
  if (view.ok === false) {
    await releaseAfterRefusal();
    return { ok: false, code: "fetch-failed", mode: null, written: false };
  }
  const labels = stateLabelsOf(view.row.labels);
  if (labels.length !== 1 || !DISPATCHABLE_STATES.includes(labels[0])) {
    logger.warn(
      { issue, dispatchId: input.dispatchId, labels },
      "[lifecycle] dev claim opened without an advance: issue not in a single dispatchable state",
    );
    return { ok: true, claim: opened.claim, advanced: null, advanceSkipped: "non-dispatchable-state", ...parkNote };
  }
  const adv = await advance(
    { issue, to: "in-progress", evidence: { dispatch: input.dispatchId, class: input.class, run: input.run }, actor },
    deps,
  );
  if (adv.ok === false) {
    // (d) a refused advance (enforce gate, park, write failure) releases the claim first.
    await releaseAfterRefusal();
    return { ok: false, code: adv.code, mode: adv.mode, written: adv.written };
  }
  const wouldPark = adv.wouldPark ?? opened.wouldPark;
  return {
    ok: true,
    claim: opened.claim,
    advanced: adv,
    ...(adv.wouldRefuse !== undefined ? { wouldRefuse: adv.wouldRefuse } : {}),
    ...(wouldPark !== undefined ? { wouldPark } : {}),
  };
}
