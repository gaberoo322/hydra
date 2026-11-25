/**
 * Lifecycle seam deps (ADR-0047 Decision 3; issue #5618).
 *
 * The rollout switch (`loadLifecycleMode`), the injectable `SeamDeps` surface and
 * its production binding `defaultSeamDeps` (gh record fetchers + Redis journal).
 * Pure adapters: this module knows nothing about the transition spine, so
 * `seam.ts`, `claim.ts`, `operator.ts`, `park.ts` and `reconcile.ts` all depend on
 * it and it depends on none of them.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.ts";
import {
  closeIssue,
  editIssueLabels,
  reopenIssue,
  viewIssue,
  type IssueActionWriteResult,
  type IssueViewResult,
} from "../github/issue-actions.ts";
import { ghExec, ghJson } from "../github/gh.ts";
import { resolveBlockerRefState } from "../github/blockers.ts";
import { isGhFailure } from "../github/exec.ts";
import { resolveGithubRepo, viewPr } from "../github/issues.ts";
import { listRequiredStatusContextsOrNull, parseRollupEntries } from "../github/prs.ts";
import { foldRollup, isRed, isSettled } from "../github/check-rollup.ts";
import {
  appendLifecycleEntry,
  closeDispatchClaim,
  expireJournalOnClose,
  listDispatchClaims,
  openDispatchClaim,
  persistJournal,
  readDispatchClaim,
  readLifecycleJournal,
  type CloseClaimResult,
  type DispatchClaim,
  type JournalWriteResult,
  type LifecycleIndexSelector,
  type ListClaimsResult,
  type LifecycleJournalEntry,
  type OpenClaimResult,
  type ReadClaimResult,
  type ReadJournalResult,
} from "../redis/lifecycle-journal.ts";
import { getDesignConceptHash } from "../redis/design-concept.ts";
import {
  prRecordFromView,
  type BlockerRecord,
  type CommentRecord,
  type DesignConceptRecord,
  type Fetched,
  type PrRecord,
  type QaLivePr,
  type StateEntryRecord,
} from "./gates.ts";
import type { TimedBody, TimelineLabelEvent } from "./caps.ts";

// ---------------------------------------------------------------------------
// Rollout switch
// ---------------------------------------------------------------------------

const LIFECYCLE_ROLLOUT_CONFIG_PATH = "config/orchestrator/lifecycle-rollout.json";
export type LifecycleMode = "shadow" | "enforce";
type ModeReason = "config-missing" | "key-missing" | "value-malformed";

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
  /** Reopen write, used only by {@link operatorReopen}. */
  reopen?: (issue: number) => Promise<IssueActionWriteResult>;
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
    /** A PR's comment bodies then review bodies, each with its creation time (carry `QA-Verdict:` trailers). */
    prBodies: (prNumber: number) => Promise<Fetched<TimedBody[]>>;
    /** A PR read live at head for the `qa-passed` exit gate; absent = fail closed (`fetch-failed`). */
    qaLive?: (prNumber: number) => Promise<Fetched<QaLivePr>>;
    /** Resolve clearance blocker refs for the `unblocked` gate; absent = fail closed (`fetch-failed`). */
    blockers?: (refs: number[]) => Promise<Fetched<BlockerRecord[]>>;
  };
  journal: {
    /** `index` opts into the hold-exit index (#5313); cap events (#5324) are always indexed. Both join the append's one MULTI. */
    append: (repo: string, issue: number, entry: LifecycleJournalEntry, index?: LifecycleIndexSelector) => Promise<JournalWriteResult>;
    expireOnClose: (repo: string, issue: number) => Promise<JournalWriteResult>;
    openClaim: (repo: string, issue: number, claim: DispatchClaim) => Promise<OpenClaimResult>;
    closeClaim: (repo: string, issue: number, expectedDispatchId: string) => Promise<CloseClaimResult>;
    /** Drop the close-retention clock on reopen (operatorReopen only). */
    persist?: (repo: string, issue: number) => Promise<JournalWriteResult>;
    /** Index an unsanctioned human-hold exit for the attention feed (#5313). */
    read: (repo: string, issue: number) => Promise<ReadJournalResult>;
    readClaim: (repo: string, issue: number) => Promise<ReadClaimResult>;
    /** SCAN the held claims (stale arm, release-by-dispatch). Absent = those paths report `redis-failed`. */
    listClaims?: (repo: string) => Promise<ListClaimsResult>;
  };
  now: () => number;
}

/** One `gh api` read of an issue comment; binds repo + issue from `issue_url`. Never throws. */
async function fetchComment(repo: string, commentId: number): Promise<Fetched<CommentRecord>> {
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
async function fetchStateEntry(
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
async function fetchIssueComments(repo: string, issue: number): Promise<Fetched<string[]>> {
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
async function fetchLabelTimeline(repo: string, issue: number): Promise<Fetched<TimelineLabelEvent[]>> {
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

/**
 * A PR's comment bodies followed by its review bodies, each with its time
 * (`createdAt` for comments, `submittedAt` for reviews; null when missing or
 * unparseable, which the count treats as newer than any reset). Never throws.
 */
async function fetchPrBodies(repo: string, prNumber: number): Promise<Fetched<TimedBody[]>> {
  try {
    const res = await ghJson<{ comments?: unknown; reviews?: unknown }>([
      "pr", "view", String(prNumber), "--repo", repo, "--json", "comments,reviews",
    ]);
    if (isGhFailure(res) || !res.data || typeof res.data !== "object") return { ok: false };
    const timed = (list: unknown, field: string): TimedBody[] =>
      Array.isArray(list)
        ? list.map((c) => {
            const rec = c as Record<string, unknown> | null;
            const raw = rec?.[field];
            const t = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
            return { body: String(rec?.body ?? ""), tsMs: Number.isNaN(t) ? null : t };
          })
        : [];
    return { ok: true, value: [...timed(res.data.comments, "createdAt"), ...timed(res.data.reviews, "submittedAt")] };
  } catch (err) {
    logger.error({ err, prNumber }, "[lifecycle] pr bodies fetch failed");
    return { ok: false };
  }
}

/**
 * Resolve each clearance blocker ref with ONE `gh api repos/<repo>/issues/<n>`
 * (issues and PRs share the endpoint). closed+merged PR -> merged; closed
 * unmerged PR -> unknown; closed -> closed; open -> open; any failure ->
 * unknown. Never throws.
 */
async function fetchBlockerRefs(repo: string, refs: number[]): Promise<Fetched<BlockerRecord[]>> {
  try {
    const out: BlockerRecord[] = [];
    for (const n of refs) {
      const state = await resolveBlockerRefState(repo, n);
      if (state === "unknown") logger.warn({ repo, ref: n }, "[lifecycle] blocker ref unresolved");
      out.push({ number: n, state });
    }
    return { ok: true, value: out };
  } catch (err) {
    logger.error({ err, repo }, "[lifecycle] blocker refs fetch failed");
    return { ok: false };
  }
}

/**
 * Fold a raw `statusCheckRollup` to the one verdict the `qa-passed` exit reads.
 * The single home of that fold: `fetchQaLive` calls it and the tests exercise
 * it directly, so a drift here fails them.
 */
export function foldQaLiveChecks(rawRollup: unknown, required: readonly string[]): QaLivePr["checks"] {
  const fold = foldRollup(parseRollupEntries(rawRollup), { required });
  return !isSettled(fold) ? "pending" : isRed(fold) ? "red" : "green";
}

/**
 * A PR read live at head for the `qa-passed` exit decision: state, draft,
 * `mergeStateStatus`, head sha, the REQUIRED checks folded to one verdict, and
 * the comment + review bodies (they carry the `QA-Verdict:` trailers). Required
 * contexts are read, never guessed; an unreadable set folds to `unknown`.
 * Never throws.
 */
async function fetchQaLive(repo: string, prNumber: number): Promise<Fetched<QaLivePr>> {
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
      checks = foldQaLiveChecks(d.statusCheckRollup, required);
    }
    const bodies = (list: unknown): string[] =>
      Array.isArray(list) ? list.map((c) => String((c as { body?: unknown } | null)?.body ?? "")) : [];
    // Comments carry `createdAt`, reviews `submittedAt`; an unparseable time is null (never post-dated).
    const timed = (list: unknown, field: string): { body: string; createdAtMs: number | null }[] =>
      Array.isArray(list)
        ? list.map((c) => {
            const rec = c as Record<string, unknown> | null;
            const raw = rec?.[field];
            const t = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
            return { body: String(rec?.body ?? ""), createdAtMs: Number.isNaN(t) ? null : t };
          })
        : [];
    return {
      ok: true,
      value: {
        timedBodies: [...timed(d.comments, "createdAt"), ...timed(d.reviews, "submittedAt")],
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
    reopen: (n) => reopenIssue(n),
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
          const pr = await viewPr<{ number?: number; state?: string; body?: string; mergedAt?: string | null }>(
            prNumber,
            "number,state,body,mergedAt",
          );
          if (pr === null || typeof pr.number !== "number") return { ok: false };
          return { ok: true, value: prRecordFromView({ ...pr, number: pr.number }) };
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
      blockers: (refs) => fetchBlockerRefs(resolveGithubRepo(), refs),
    },
    journal: {
      append: appendLifecycleEntry,
      expireOnClose: expireJournalOnClose,
      openClaim: openDispatchClaim,
      closeClaim: closeDispatchClaim,
      persist: persistJournal,
      read: readLifecycleJournal,
      readClaim: readDispatchClaim,
      listClaims: listDispatchClaims,
    },
    now: () => Date.now(),
  };
}
