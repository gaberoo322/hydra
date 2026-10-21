/**
 * turn-snapshot/target-board.ts — the Target board collector (ADR-0043
 * slice 4, issue #4932; degraded arm re-derived in #4946), moved whole —
 * fetches included — out of `collect-state.sh`'s `collect_target_board`.
 *
 * Reads (the Target repo is the port's repo, resolved per realm by the CLI
 * through src/target-config.ts — ADR-0002 / ADR-0026; never a literal):
 *
 *   1. `GET /api/autopilot/board-state?scope=target` (HTTP adapter) — the
 *      healthy counts, plus `glm_withheld` (W) and `blocker_excluded` (B).
 *      FALLBACK (endpoint down / degraded / not a board): `gh issue list
 *      --json number,labels,body` parsed by `parseIssueRows` and bucketed by
 *      `deriveBoardState` (src/autopilot/board-state.ts) — ONE predicate, no
 *      hand-rolled label tally (ADR-0043 D2, issue #4946). The #3059
 *      strict-blocker exclusion therefore applies on this arm too: openness
 *      is resolved through the port's `searchOpenIssueNumbers` (ONE batched
 *      `--search`, fail-safe all-open) and `blockerExcludedIssueNumbers`
 *      feeds `target_ready_blocker_excluded`. `glmPartitionActive` is ALWAYS
 *      false here — the degraded arm exists because the service (and its
 *      Redis drainer heartbeat) is unreachable, which IS the stale-heartbeat
 *      condition, so `glm-eligible` rows COUNT (fail-open toward work,
 *      #3754; the orch-board slice-2 precedent). A failed fallback read
 *      (empty / unparseable / non-array — the orch-board slice-2 rule)
 *      latches the lane-degraded accumulator (#4130) and emits zeros.
 *      `needs_triage` stays a RAW label tally either way (#3709): triage
 *      must not exclude blocked items.
 *   2. The open-PR REST read (`gh api …/pulls`), ONE payload feeding the
 *      in-flight exclusion (#4474), the WIP liveness (#4475), the needs-qa PR
 *      ref (#4576/#4653) and the dev-resume pick (#4739).
 *   3. REST label reads: ready-for-agent (healthy arm only — the fallback
 *      derives R from its own payload), in-progress, needs-qa (only when the
 *      count is non-zero), needs-dev-resume.
 *
 * What it computes (semantics unchanged from the bash; history in the issues):
 *   target_ready_for_agent  max(0, base − |(R ∩ P) − W − B|)  (#4474, #4823)
 *                           (base itself now excludes open strict blockers
 *                           on BOTH arms — #4946)
 *   starvation note         adjusted 0 while B is non-empty   (#4823, both
 *                           arms since #4946)
 *   target_wip_*            live = |InProgress ∩ P|, saturated = live ≥ 3
 *                           (#4475; target-wip.py stays the build playbook's
 *                           leaf — {@link TARGET_WIP_LIMIT} is pinned to it)
 *   target_needs_qa_pr_*    the first needs-qa issue's closing PR (#4576)
 *   target_dev_resume_pick  the shared pick (dev-resume.ts, #4739 policy)
 *
 * Never throws on a read failure: each degrades to a typed field (a
 * `Classified` reason and/or a `DegradedMarker`), and the reads the bash
 * reported keep their stderr note, which names the failure in plain words or
 * a reason code (`unparseable`) — never parser exception text. The JSON
 * builder (json-snapshot.ts) owns the fail-open values a degraded field
 * projects to.
 */

import {
  blockerExcludedIssueNumbers,
  deriveBoardState,
  glmWithheldIssueNumbers,
  resolveOpenBlockers,
} from "../board-state.ts";
import { openNumbersFromRows } from "../../github/blockers.ts";
import { parseIssueRows, type IssueRow } from "../../github/issues.ts";
import type { PrRefRow } from "../../github/pr-refs.ts";
import { TARGET_BOARD_LABELS } from "../../target-board-labels.ts";
import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import { pickDevResume } from "./dev-resume.ts";
import { parseJsonRead, type GhJsonRead, type TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import { DEFAULT_PR_REF_PREDICATES, type PrPick, type PrRefsAvailability } from "./pr-gate.ts";

export const TARGET_BOARD_COLLECTOR = "target-board";

/**
 * The Target WIP limit (ADR-0031 Decision 4). `scripts/autopilot/target-wip.py`
 * still owns it for hydra-target-build's pre-flight gate; a test pins the two
 * equal (`target-wip.py --limit`).
 */
export const TARGET_WIP_LIMIT = 3;

/** The board-count lines, already in emit order (healthy and fallback orders differ). */
export type TargetBoardCounts = readonly (readonly [key: string, value: string])[];

export interface TargetWip {
  readonly limit: number;
  readonly inProgress: number;
  readonly live: number;
  readonly saturated: boolean;
}

export interface TargetNeedsQaPr {
  readonly ref: string;
  readonly head: string;
  /**
   * #4796: set (only ever `true`) when EVERY labelled needs-qa issue has at
   * least one closing PR in a non-truncated PR window and ALL of them were
   * skipped as already PASSed at head — the
   * `needs_qa_target` signal is suppressed so qa_target does not fire an
   * unpinned dispatch that would re-resolve and re-review the PASSed PR.
   */
  readonly allSkipped?: boolean;
}

export interface TargetBoardSnapshot {
  /**
   * The count lines. `ok:false` = the fallback read failed (empty /
   * unparseable / non-array payload) → the degraded zeros. The historical
   * `value: null` arm (the bash's un-talliable jq-error line) is gone: the
   * parser is `parseIssueRows`, which is lenient exactly the way the healthy
   * endpoint's is (issue #4946).
   */
  readonly counts: Classified<TargetBoardCounts>;
  /** Fail-open: degraded → limit/zeros/false. */
  readonly wip: Classified<TargetWip>;
  /** Fail-open: empty strings when nothing resolves. */
  readonly needsQaPr: TargetNeedsQaPr;
  /** Fail-closed: degraded → `none`. */
  readonly devResumePick: Classified<PrPick | null>;
  /** The lane-degraded accumulator (#4130) the scan-board collector reads. */
  readonly laneDegraded: boolean;
}

export interface TargetBoardDeps {
  /** The port, built against the Target repo. */
  readonly github: Pick<TurnSnapshotGithub, "listOpenIssueBlockerRows" | "listOpenPullsRest" | "listOpenIssuesByLabelRest" | "searchOpenIssueNumbers" | "listQaVerdictCommentsRest">;
  /** The unified hydra client — only its Target board-state read (`$(hydra raw GET …)` semantics). */
  readonly hydra: Pick<TurnSnapshotHydra, "targetBoardState">;
  /** Epoch milliseconds — the degraded arm's `deriveBoardState` staleness clock (inert for the counts emitted). */
  readonly now: () => number;
  /** `gh … --limit` / `per_page` (collect-state.sh's GH_ISSUE_LIST_LIMIT). */
  readonly ghListLimit: number;
  /** Defaults to the src/github/pr-refs.ts predicates (see pr-gate.ts). */
  readonly prRefs?: PrRefsAvailability;
}

// ---------------------------------------------------------------------------
// jq-equivalent projections (pure). `null` = jq would have errored.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const isObj = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);

/** An integer JSON field (a boolean reads as 0/1, as the board fields always have); `null` for anything else. */
const asInt = (v: unknown): number | null => (typeof v === "boolean" ? Number(v) : typeof v === "number" && Number.isInteger(v) ? v : null);

/** The integer entries of a JSON list field, in order (see {@link asInt}). */
const intEntries = (xs: readonly unknown[]): number[] => xs.map(asInt).filter((n): n is number => n !== null);

/** `.[]` — an array's elements or an object's values; anything else errors. */
function eachValue(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.values(v);
  return null;
}

const readData = (r: GhJsonRead): unknown => (r.kind === "ok" ? r.data : undefined);

/** `[.[] | select(.pull_request == null) | .number]` — open issue numbers, PRs filtered out. */
export function nonPrIssueNumbers(read: GhJsonRead): unknown[] | null {
  if (read.kind !== "ok") return null;
  const items = eachValue(read.data);
  if (items === null) return null;
  const out: unknown[] = [];
  for (const e of items) {
    if (e === null) {
      out.push(null);
      continue;
    }
    if (!isObj(e)) return null;
    if ((e.pull_request ?? null) === null) out.push(e.number ?? null);
  }
  return out;
}

/** `[.[] | {headRefName: .head.ref, body: (.body // "")}]` — REST pulls to pr-refs rows. */
export function projectPrRefs(read: GhJsonRead): PrRefRow[] | null {
  if (read.kind !== "ok") return null;
  const items = eachValue(read.data);
  if (items === null) return null;
  const out: PrRefRow[] = [];
  for (const e of items) {
    if (e === null) {
      out.push({ headRefName: null, body: "" });
      continue;
    }
    if (!isObj(e)) return null;
    const head = e.head ?? null;
    if (head !== null && !isObj(head)) return null;
    const ref = head === null ? null : ((head as Row).ref ?? null);
    const body = e.body === null || e.body === undefined || e.body === false ? "" : e.body;
    out.push({ headRefName: typeof ref === "string" ? ref : null, body: typeof body === "string" ? body : "" });
  }
  return out;
}

/**
 * The degraded arm's derivation (issue #4946, ADR-0043 D2): the ONE
 * `deriveBoardState` predicate over the fallback payload's rows, plus the
 * lists the in-flight subtraction and the starvation note consume. Pure
 * except for the injected `resolveOpen` (the port-backed openness lookup).
 *
 * `glmPartitionActive` is pinned `false` (#3754): this arm exists because the
 * service — and so its Redis drainer heartbeat — is unreachable, which IS
 * the stale-heartbeat condition, so `glm-eligible` rows count (fail-open
 * toward work; `glmWithheldIssueNumbers` therefore yields `[]`).
 */
export async function deriveFallbackBoard(
  rows: readonly IssueRow[],
  resolveOpen: (numbers: number[]) => Promise<Set<number>>,
  nowMs: number,
): Promise<{ counts: TargetBoardCounts; readyNumbers: unknown[]; glmWithheld: number[]; blockerExcluded: number[] }> {
  const openBlockers = await resolveOpenBlockers(rows, undefined, false, resolveOpen);
  const d = deriveBoardState(rows, nowMs, openBlockers, false);
  const blockerExcluded = blockerExcludedIssueNumbers(rows, openBlockers, false);
  const glmWithheld = glmWithheldIssueNumbers(rows, false);
  return {
    counts: [
      ["target_ready_for_agent", String(d.ready_for_agent)],
      ["target_ready_blocker_excluded", String(blockerExcluded.length)],
      ["target_needs_qa", String(d.needs_qa)],
      ["target_needs_triage", String(d.needs_triage)],
      ["target_needs_research", String(d.needs_research)],
    ],
    readyNumbers: rows.filter((r) => r.labels.includes(TARGET_BOARD_LABELS.ready_for_agent)).map((r) => r.number),
    glmWithheld,
    blockerExcluded,
  };
}

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

/** The healthy board-state payload, or `null` when the endpoint read must fall back. */
export function parseHealthyBoard(body: string): Row | null {
  const parsed = parseJsonRead(body);
  if (parsed.kind !== "ok") return null;
  const d = parsed.data;
  if (!isObj(d) || !("ready_for_agent" in d)) return null;
  // `degraded` set: anything but null / false / 0 / "" / an empty list or object.
  const flag = d.degraded;
  if (flag !== null && typeof flag === "object" ? Object.keys(flag).length > 0 : Boolean(flag)) return null;
  return d;
}

/**
 * The healthy count lines (each field's text — a string verbatim, anything
 * else as JSON — or `0` when absent, plus `len(blocker_excluded)`).
 */
export function healthyCounts(d: Row): TargetBoardCounts {
  const get = (k: string) => (!(k in d) ? "0" : typeof d[k] === "string" ? (d[k] as string) : JSON.stringify(d[k]));
  const be = d.blocker_excluded;
  return [
    ["target_ready_for_agent", get("ready_for_agent")],
    ["target_needs_qa", get("needs_qa")],
    ["target_needs_triage", get("needs_triage")],
    ["target_needs_research", get("needs_research")],
    ["target_ready_blocker_excluded", String(Array.isArray(be) ? be.length : 0)],
  ];
}

/** An int list field of the board payload (`glm_withheld` W / `blocker_excluded` B); non-list → empty. */
export function boardIssueList(d: Row, key: string): number[] {
  const v = d[key];
  if (!Array.isArray(v)) return [];
  return intEntries(v);
}

/** `max(0, base − |(R ∩ P) − W − B|)` (#4474, #4823). `base` is the emitted count string. */
export function adjustedReadyForAgent(inputs: {
  readonly base: string;
  readonly ready: readonly unknown[] | null;
  readonly inflight: ReadonlySet<number>;
  readonly glmWithheld: readonly number[];
  readonly blockerExcluded: readonly number[];
}): number {
  const r = new Set(intEntries(inputs.ready ?? []));
  const w = new Set(inputs.glmWithheld);
  const b = new Set(inputs.blockerExcluded);
  // A decimal integer count (surrounding whitespace, a sign and single `_` separators allowed), else 0.
  const baseText = inputs.base.trim();
  const base = /^[+-]?\d+(?:_\d+)*$/.test(baseText) ? Number(baseText.replace(/_/g, "")) : 0;
  let excluded = 0;
  for (const n of r) if (inputs.inflight.has(n) && !w.has(n) && !b.has(n)) excluded++;
  return Math.max(0, base - excluded);
}

/** WIP liveness (target-wip.py `wip_status`): live = |InProgress ∩ referenced(P)|. */
export function wipStatus(inProgress: readonly unknown[], prs: readonly PrRefRow[], referenced: (rows: readonly PrRefRow[]) => ReadonlySet<number>): TargetWip {
  const ip = new Set(inProgress.filter((n): n is number => typeof n === "number" && Number.isInteger(n)));
  const refs = referenced(prs);
  let live = 0;
  for (const n of ip) if (refs.has(n)) live++;
  return { limit: TARGET_WIP_LIMIT, inProgress: ip.size, live, saturated: live >= TARGET_WIP_LIMIT };
}

/** The open-issue numbers of a REST issues payload (dicts, `pull_request` null, int number). */
function labelledIssueNumbers(list: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const it of list) {
    if (!isObj(it) || (it.pull_request ?? null) !== null) continue;
    const n = asInt(it.number);
    if (n !== null) out.push(n);
  }
  return out;
}

/** The producer grammar (scripts/ci/qa-verdict.ts), line-anchored so a mid-line prose mention is never honoured. */
const QA_TRAILER_RE =
  /^QA-Verdict:[ \t]+(PASS-pending-CI|FAIL-pending-CI|PASS|FAIL)[ \t]+pr=(\d+)[ \t]+round=(\d+)[ \t]+sha=([0-9a-fA-F]{7,40}|unknown)[ \t]+blockers=(\d+)[ \t]+max_severity=(high|medium|low|none)[ \t]*\r?$/gm;

export interface QaTrailer {
  readonly pr: number;
  readonly verdict: string;
  readonly sha: string;
}

/** #4796: only these author associations may mint a trailer — a drive-by commenter's forged PASS must not suppress QA of a money-critical PR. */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * #4796: trailers ascending by created_at, then line order within a body.
 * Comments lacking a trusted `author_association` are ignored. The feed is
 * newest-first, so equal-timestamp ties break by DESCENDING input index
 * (the earlier-in-feed comment is the newer one). A non-list document is [].
 */
export function parseQaTrailers(comments: unknown): QaTrailer[] {
  if (!Array.isArray(comments)) return [];
  const ok = comments.filter((c): c is Row => isObj(c) && typeof c.body === "string" && typeof c.author_association === "string" && TRUSTED_ASSOCIATIONS.has(c.author_association));
  const key = (c: Row): string => (typeof c.created_at === "string" ? c.created_at : "");
  const sorted = ok.map((c, i) => ({ c, i })).sort((a, b) => (key(a.c) < key(b.c) ? -1 : key(a.c) > key(b.c) ? 1 : b.i - a.i));
  const out: QaTrailer[] = [];
  for (const { c } of sorted) {
    for (const m of (c.body as string).matchAll(QA_TRAILER_RE)) out.push({ pr: Number(m[2]), verdict: m[1], sha: m[4].toLowerCase() });
  }
  return out;
}

/** #4796: true iff the LATEST trailer naming this PR is exactly PASS at a hex prefix of the PR's current head.sha. */
export function passAtHead(pr: Row, trailers: readonly QaTrailer[]): boolean {
  const num = pr.number;
  const head = isObj(pr.head) ? (pr.head as Row).sha : null;
  if (typeof num !== "number" || !Number.isInteger(num) || typeof head !== "string" || head === "") return false;
  let latest: QaTrailer | null = null;
  for (const t of trailers) if (t.pr === num) latest = t;
  if (latest === null || latest.verdict !== "PASS") return false;
  return /^[0-9a-f]{7,40}$/.test(latest.sha) && head.toLowerCase().startsWith(latest.sha);
}

const bodyRow = (pr: Row): PrRefRow => ({ body: typeof pr.body === "string" ? pr.body : null });

/** #4576/#4653: the html_url + head.ref of the first needs-qa issue's closing PR (REST issue order). */
export function resolveNeedsQaPr(
  issues: readonly unknown[],
  prs: readonly unknown[],
  closing: (rows: readonly PrRefRow[]) => ReadonlySet<number>,
  trailers: readonly QaTrailer[] = [],
  opts: { readonly prWindowTruncated?: boolean } = {},
): TargetNeedsQaPr {
  let issuesSeen = 0;
  let issuesAllSkipped = 0;
  for (const n of labelledIssueNumbers(issues)) {
    issuesSeen++;
    let closingSeen = 0;
    let skipped = 0;
    for (const pr of prs) {
      if (!isObj(pr)) continue;
      const url = pr.html_url;
      if (typeof url !== "string" || url === "") continue;
      if (!closing([bodyRow(pr)]).has(n)) continue;
      closingSeen++;
      if (passAtHead(pr, trailers)) { skipped++; continue; } // #4796: already PASSed at this head; try the next closing PR
      const head = isObj(pr.head) ? (pr.head as Row).ref : null;
      // The bash printed `url\nhead` and read it back line by line (`sed -n 1p` / `2p`).
      const lines = `${url}\n${typeof head === "string" ? head : ""}`.split("\n");
      return { ref: lines[0], head: lines[1] ?? "" };
    }
    if (closingSeen > 0 && skipped === closingSeen) issuesAllSkipped++;
  }
  // #4796: suppress qa_target only when EVERY labelled needs-qa issue is fully PASSed-at-head.
  // An issue with ZERO closing PRs in the fetched window is UNKNOWN, not "nothing to review": its
  // real PR may be Refs-only or beyond the page limit, so it keeps the signal alive (#4871 QA FAIL).
  // Likewise a PR read that filled its page (possibly truncated) never suppresses. The trailer
  // page-window fail-open (a PASS trailer scrolled off the newest-first feed) is accepted: the skip
  // is then simply not applied, never a false suppression.
  if (issuesSeen > 0 && issuesAllSkipped === issuesSeen && opts.prWindowTruncated !== true) return { ref: "", head: "", allSkipped: true };
  return { ref: "", head: "" };
}

/** #4739: the Target dev-resume pick over the REST payloads, through the shared pick. */
export function targetDevResumePick(issues: readonly unknown[], prs: readonly unknown[], closing: (rows: readonly PrRefRow[]) => ReadonlySet<number>): PrPick | null {
  const candidates: { pr: number; headRefName: string | null; row: Row }[] = [];
  for (const pr of prs) {
    if (!isObj(pr) || pr.draft === true) continue;
    const n = asInt(pr.number);
    if (n === null) continue;
    const head = isObj(pr.head) ? (pr.head as Row).ref : null;
    candidates.push({ pr: n, headRefName: typeof head === "string" ? head : null, row: pr });
  }
  return pickDevResume({
    candidates,
    resumeIssues: new Set(labelledIssueNumbers(issues)),
    closing: (c) => closing([bodyRow(c.row)]),
    policy: "lowest-unambiguous-issue",
  });
}

/** `jq -cs '{issues: .[0], prs: .[1]}'` over two reads: `null` when either payload is unparseable. */
function slurpPair(a: GhJsonRead, b: GhJsonRead): { first: unknown; second: unknown } | null {
  if (a.kind === "unparseable" || b.kind === "unparseable") return null;
  const docs = [a, b].filter((r) => r.kind === "ok").map(readData);
  return { first: docs[0] ?? null, second: docs[1] ?? null };
}

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

/** Gather and classify the Target board signals. Never throws on a read failure. */
export async function collectTargetBoard(deps: TargetBoardDeps): Promise<CollectorOutcome<TargetBoardSnapshot>> {
  const notes: string[] = [];
  const degraded: DegradedMarker[] = [];
  const limit = deps.ghListLimit;
  const prRefs: PrRefsAvailability = deps.prRefs ?? { ok: true, predicates: DEFAULT_PR_REF_PREDICATES };
  let laneDegraded = false;

  // 1. Counts: the healthy endpoint, else the gh fallback derived through
  //    `deriveBoardState` (issue #4946 — ONE predicate, blocker filter and all).
  const read = await deps.hydra.targetBoardState();
  const board = read.kind === "ok" ? parseHealthyBoard(read.body) : null;
  let counts: Classified<TargetBoardCounts>;
  let glmWithheld: number[] = [];
  let blockerExcluded: number[] = [];
  let fallbackReady: unknown[] | null = null;
  if (board !== null) {
    counts = { ok: true, value: healthyCounts(board) };
    glmWithheld = boardIssueList(board, "glm_withheld");
    blockerExcluded = boardIssueList(board, "blocker_excluded");
  } else {
    degraded.push({ field: "boardState", reason: "endpoint-degraded" });
    const issues = await deps.github.listOpenIssueBlockerRows(limit);
    if (issues.kind === "ok" && Array.isArray(issues.data)) {
      // Openness rides the port (ADR-0043 D1): ONE batched --search over the
      // CANDIDATE refs only (`resolveOpenBlockers` applies the filter and skips
      // the round-trip when no candidate declares a strict blocker). A non-ok
      // search read fails safe: every referenced blocker treated as OPEN.
      const resolveOpen = async (refs: number[]): Promise<Set<number>> => {
        const search = await deps.github.searchOpenIssueNumbers(refs.join(" "), limit);
        if (search.kind !== "ok" || !Array.isArray(search.data)) {
          degraded.push({ field: "openBlockers", reason: "fail-safe-all-open" });
          return new Set(refs);
        }
        return openNumbersFromRows(parseIssueRows(search.data, ""), refs);
      };
      const derived = await deriveFallbackBoard(parseIssueRows(issues.data, ""), resolveOpen, deps.now());
      counts = { ok: true, value: derived.counts };
      glmWithheld = derived.glmWithheld;
      blockerExcluded = derived.blockerExcluded;
      fallbackReady = derived.readyNumbers;
    } else {
      laneDegraded = true;
      counts = { ok: false, reason: "fallback-read-failed" };
      degraded.push({ field: "counts", reason: "fallback-read-failed" });
    }
  }

  // 2. P — the open-PR REST payload, projected to pr-refs rows.
  const pulls = await deps.github.listOpenPullsRest(limit);
  if (pulls.kind === "empty") {
    notes.push(
      "target open-PR REST read FAILED (empty payload) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' (issue #4474)",
    );
  }
  const prRows = projectPrRefs(pulls);
  const inflight: ReadonlySet<number> = prRefs.ok && prRows !== null ? prRefs.predicates.referenced(prRows) : new Set();

  // 3. R — healthy: a REST read; fallback: derived from the fallback payload.
  let ready: unknown[] | null;
  if (board !== null) {
    const rfa = await deps.github.listOpenIssuesByLabelRest(TARGET_BOARD_LABELS.ready_for_agent, limit);
    if (rfa.kind === "empty") {
      notes.push(
        "target ready-for-agent REST read FAILED (empty payload) — target_ready_for_agent in-flight exclusion fails CLOSED to 'exclude nothing' (issue #4474)",
      );
    }
    ready = nonPrIssueNumbers(rfa);
  } else {
    ready = fallbackReady;
  }

  // 4. The subtraction, then the starvation note (#4823).
  const countLines = counts.ok ? counts.value : null;
  const baseLine = countLines?.find(([k]) => k === "target_ready_for_agent");
  const adjusted = adjustedReadyForAgent({ base: baseLine?.[1] ?? "", ready, inflight, glmWithheld, blockerExcluded });
  if (counts.ok) {
    counts = { ok: true, value: counts.value.map(([k, v]) => (k === "target_ready_for_agent" ? [k, String(adjusted)] : [k, v])) };
  }
  if (adjusted === 0 && blockerExcluded.length > 0) {
    notes.push(
      `target board STARVED, not empty: ready-for-agent issues held out by an open strict blocker: ${blockerExcluded.join(" ")} (issue #4823)`,
    );
  }

  // 5. WIP liveness (#4475) — fail OPEN.
  const inProgress = nonPrIssueNumbers(await deps.github.listOpenIssuesByLabelRest(TARGET_BOARD_LABELS.in_progress, limit));
  let wip: Classified<TargetWip>;
  if (inProgress === null || prRows === null) {
    notes.push("target WIP read FAILED (in-progress or open-PR payload unreadable) — target_wip_saturated fails OPEN to false (issue #4475)");
    wip = { ok: false, reason: "wip-read-failed" };
  } else if (!prRefs.ok) {
    wip = { ok: false, reason: "pr-refs unavailable" };
  } else {
    wip = { ok: true, value: wipStatus(inProgress, prRows, prRefs.predicates.referenced) };
  }
  if ("reason" in wip) degraded.push({ field: "wip", reason: wip.reason });

  // 6. needs-qa PR pre-resolution (#4576/#4653) — fail OPEN, skipped on a zero count.
  const nqaCount = countLines?.find(([k]) => k === "target_needs_qa")?.[1] ?? "";
  let needsQaPr: TargetNeedsQaPr = { ref: "", head: "" };
  if (nqaCount !== "" && nqaCount !== "0") {
    const nqa = await deps.github.listOpenIssuesByLabelRest(TARGET_BOARD_LABELS.needs_qa, limit);
    if (nqa.kind === "empty") {
      notes.push("target needs-qa REST read FAILED (empty payload) — target_needs_qa_pr_ref fails OPEN to empty (issue #4576)");
    } else {
      if ("error" in prRefs) notes.push(`target-qa pr-refs.py import FAILED (${prRefs.error}) — fail open (issue #4576)`);
      const pair = slurpPair(nqa, pulls);
      if (pair === null) notes.push("target-qa stdin JSON parse FAILED (unparseable) — fail open (issue #4576)");
      if (prRefs.ok && pair !== null) {
        const issues = Array.isArray(pair.first) ? pair.first : [];
        const prs = Array.isArray(pair.second) ? pair.second : [];
        // #4796: ONE repo-wide comments read; any failure degrades to [] (fail open, skip disabled).
        const verdicts = await deps.github.listQaVerdictCommentsRest(limit);
        if (verdicts.kind !== "ok") notes.push("target-qa verdict-comments REST read FAILED or empty — PASS-at-head skip disabled this turn (issue #4796)");
        const trailers = verdicts.kind === "ok" ? parseQaTrailers(verdicts.data) : [];
        // A PR page filled to `limit` may be truncated: the skip must not suppress on a partial window.
        needsQaPr = resolveNeedsQaPr(issues, prs, prRefs.predicates.closing, trailers, { prWindowTruncated: prs.length >= limit });
      }
    }
  }

  // 7. Target dev-resume pick (#4739) — fail CLOSED.
  const ndr = await deps.github.listOpenIssuesByLabelRest("needs-dev-resume", limit);
  let resumeOk = true;
  if (ndr.kind === "empty") {
    notes.push("target needs-dev-resume REST read FAILED (empty payload) — target_dev_resume_pick fails closed to none (issue #4739)");
    resumeOk = false;
  }
  if (pulls.kind === "empty") {
    notes.push("target open-PR REST payload empty — target_dev_resume_pick fails closed to none (issue #4739)");
    resumeOk = false;
  }
  let devResumePick: Classified<PrPick | null>;
  if (!resumeOk) {
    notes.push("target-dev-resume read degraded (failed REST read) — fail closed to none (issue #4739)");
    devResumePick = { ok: false, reason: "resume-read-failed" };
  } else if ("error" in prRefs) {
    notes.push(`target-dev-resume pr-refs.py import FAILED (${prRefs.error}) — fail closed to none (issue #4739)`);
    notes.push("target-dev-resume pr-refs.py unavailable — fail closed to none (issue #4739)");
    devResumePick = { ok: false, reason: "pr-refs unavailable" };
  } else {
    const pair = slurpPair(ndr, pulls);
    if (pair === null) notes.push("target-dev-resume stdin JSON parse FAILED (unparseable) — fail closed to none (issue #4739)");
    const issues = pair !== null && Array.isArray(pair.first) ? pair.first : null;
    const prs = pair !== null && Array.isArray(pair.second) ? pair.second : null;
    if (issues === null) notes.push("target-dev-resume issues payload is not a list — treated as empty (issue #4739)");
    if (prs === null) notes.push("target-dev-resume prs payload is not a list — treated as empty (issue #4739)");
    devResumePick = { ok: true, value: targetDevResumePick(issues ?? [], prs ?? [], prRefs.predicates.closing) };
  }
  if ("reason" in devResumePick) degraded.push({ field: "devResumePick", reason: devResumePick.reason });

  return {
    collector: TARGET_BOARD_COLLECTOR,
    value: { counts, wip, needsQaPr, devResumePick, laneDegraded },
    degraded,
    notes,
  };
}

/** The snapshot the CLI renders when the collector itself could not run (every read failed). */
export function targetBoardFallbackSnapshot(reason: string): TargetBoardSnapshot {
  return {
    counts: { ok: false, reason },
    wip: { ok: false, reason },
    needsQaPr: { ref: "", head: "" },
    devResumePick: { ok: false, reason },
    laneDegraded: true,
  };
}
