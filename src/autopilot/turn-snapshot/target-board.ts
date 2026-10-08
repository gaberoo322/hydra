/**
 * turn-snapshot/target-board.ts — the Target board collector (ADR-0043
 * slice 4, issue #4932), moved whole — fetches included — out of
 * `collect-state.sh`'s `collect_target_board`.
 *
 * Reads (the Target repo is the port's repo, resolved per realm by the CLI
 * through src/target-config.ts — ADR-0002 / ADR-0026; never a literal):
 *
 *   1. `GET /api/autopilot/board-state?scope=target` (HTTP adapter) — the
 *      healthy counts, plus `glm_withheld` (W) and `blocker_excluded` (B).
 *      FALLBACK (endpoint down / degraded / not a board): `gh issue list
 *      --json number,labels` and a bare label tally (#3709). A failed
 *      fallback read latches the lane-degraded accumulator (#4130) and emits
 *      zeros. The fallback deliberately applies NO blocker filter; replacing
 *      it with `deriveBoardState` is behaviour-changing (out of scope, D4).
 *   2. The open-PR REST read (`gh api …/pulls`), ONE payload feeding the
 *      in-flight exclusion (#4474), the WIP liveness (#4475), the needs-qa PR
 *      ref (#4576/#4653) and the dev-resume pick (#4739).
 *   3. REST label reads: ready-for-agent (healthy arm only — the fallback
 *      derives R from its own payload), in-progress, needs-qa (only when the
 *      count is non-zero), needs-dev-resume.
 *
 * What it computes (semantics unchanged from the bash; history in the issues):
 *   target_ready_for_agent  max(0, base − |(R ∩ P) − W − B|)  (#4474, #4823)
 *   starvation note         adjusted 0 while B is non-empty   (#4823)
 *   target_wip_*            live = |InProgress ∩ P|, saturated = live ≥ 3
 *                           (#4475; target-wip.py stays the build playbook's
 *                           leaf — {@link TARGET_WIP_LIMIT} is pinned to it)
 *   target_needs_qa_pr_*    the first needs-qa issue's closing PR (#4576)
 *   target_dev_resume_pick  the shared pick (dev-resume.ts, #4739 policy)
 *
 * Never throws on a read failure: each degrades to a typed field plus the
 * verbatim stderr note the bash printed. The `kv` renderer owns the fallback
 * lines.
 */

import type { PrRefRow } from "../../github/pr-refs.ts";
import { TARGET_BOARD_LABELS } from "../../target-board-labels.ts";
import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import { pickDevResume } from "./dev-resume.ts";
import type { GhJsonRead, TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import { DEFAULT_PR_REF_PREDICATES, type PrPick, type PrRefsAvailability } from "./pr-gate.ts";
import { pyInt, pyIntOf, pyIsInt, pyJsonLoads, pyStrRepr, pyTruthy } from "./py-compat.ts";

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
}

export interface TargetBoardSnapshot {
  /**
   * The count lines. `ok:false` = the fallback read failed → the degraded
   * zeros; `value: null` = the fallback payload could not be tallied (the
   * bash printed an empty line).
   */
  readonly counts: Classified<TargetBoardCounts | null>;
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
  readonly github: Pick<TurnSnapshotGithub, "listOpenIssueLabelRows" | "listOpenPullsRest" | "listOpenIssuesByLabelRest" | "listQaVerdictCommentsRest">;
  /** The unified hydra client — only its Target board-state read (`$(hydra raw GET …)` semantics). */
  readonly hydra: Pick<TurnSnapshotHydra, "targetBoardState">;
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

/** `.[]` — an array's elements or an object's values; anything else errors. */
function jqIterate(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.values(v);
  return null;
}

const readData = (r: GhJsonRead): unknown => (r.kind === "ok" ? r.data : undefined);

/** `[.[] | select(.pull_request == null) | .number]` — open issue numbers, PRs filtered out. */
export function nonPrIssueNumbers(read: GhJsonRead): unknown[] | null {
  if (read.kind !== "ok") return null;
  const items = jqIterate(read.data);
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
  const items = jqIterate(read.data);
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

/** `.labels | map(.name)` of one issue row, or `null` when jq would error. */
function labelNames(e: unknown): unknown[] | null {
  const labels = e === null ? null : isObj(e) ? (e.labels ?? null) : undefined;
  if (labels === undefined) return null;
  const items = jqIterate(labels);
  if (items === null) return null;
  const names: unknown[] = [];
  for (const l of items) {
    if (l === null) names.push(null);
    else if (isObj(l)) names.push(l.name ?? null);
    else return null;
  }
  return names;
}

/** The fallback `gh issue list --json number,labels` payload, tallied by label (and R). */
export function fallbackTally(read: GhJsonRead): { counts: TargetBoardCounts; readyNumbers: unknown[] } | null {
  if (read.kind !== "ok") return null;
  const items = jqIterate(read.data);
  if (items === null) return null;
  const n = { ready: 0, qa: 0, triage: 0, research: 0 };
  const readyNumbers: unknown[] = [];
  for (const e of items) {
    const names = labelNames(e);
    if (names === null) return null;
    if (names.includes(TARGET_BOARD_LABELS.ready_for_agent)) {
      n.ready++;
      readyNumbers.push(isObj(e) ? (e.number ?? null) : null);
    }
    if (names.includes(TARGET_BOARD_LABELS.needs_qa)) n.qa++;
    if (names.includes(TARGET_BOARD_LABELS.needs_triage)) n.triage++;
    if (names.includes(TARGET_BOARD_LABELS.needs_research)) n.research++;
  }
  return {
    counts: [
      ["target_ready_for_agent", String(n.ready)],
      // The labels-only fallback applies no blocker filter: nothing is excluded (#4823).
      ["target_ready_blocker_excluded", "0"],
      ["target_needs_qa", String(n.qa)],
      ["target_needs_triage", String(n.triage)],
      ["target_needs_research", String(n.research)],
    ],
    readyNumbers,
  };
}

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

/** The healthy board-state payload, or `null` when the endpoint read must fall back. */
export function parseHealthyBoard(body: string): Row | null {
  const parsed = pyJsonLoads(body);
  if (!parsed.ok) return null;
  const d = parsed.value;
  if (!isObj(d) || pyTruthy(d.degraded) || !("ready_for_agent" in d)) return null;
  return d;
}

/** The healthy count lines (`str(d.get(k, 0))`, plus `len(blocker_excluded)`). */
export function healthyCounts(d: Row): TargetBoardCounts {
  const get = (k: string) => (k in d ? pyStrRepr(d[k]) : "0");
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
  return v.filter(pyIsInt).map(pyIntOf);
}

/** `max(0, base − |(R ∩ P) − W − B|)` (#4474, #4823). `base` is the emitted count string. */
export function adjustedReadyForAgent(inputs: {
  readonly base: string;
  readonly ready: readonly unknown[] | null;
  readonly inflight: ReadonlySet<number>;
  readonly glmWithheld: readonly number[];
  readonly blockerExcluded: readonly number[];
}): number {
  const r = new Set((inputs.ready ?? []).filter(pyIsInt).map(pyIntOf));
  const w = new Set(inputs.glmWithheld);
  const b = new Set(inputs.blockerExcluded);
  const base = inputs.base === "" ? 0 : (pyInt(inputs.base) ?? 0);
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
    if (pyIsInt(it.number)) out.push(pyIntOf(it.number));
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

/** #4796: trailers ascending by created_at (stable), then line order within a body. A non-list document is []. */
export function parseQaTrailers(comments: unknown): QaTrailer[] {
  if (!Array.isArray(comments)) return [];
  const ok = comments.filter((c): c is Row => isObj(c) && typeof c.body === "string");
  const key = (c: Row): string => (typeof c.created_at === "string" ? c.created_at : "");
  const sorted = ok.map((c, i) => ({ c, i })).sort((a, b) => (key(a.c) < key(b.c) ? -1 : key(a.c) > key(b.c) ? 1 : a.i - b.i));
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
export function resolveNeedsQaPr(issues: readonly unknown[], prs: readonly unknown[], closing: (rows: readonly PrRefRow[]) => ReadonlySet<number>, trailers: readonly QaTrailer[] = []): TargetNeedsQaPr {
  for (const n of labelledIssueNumbers(issues)) {
    for (const pr of prs) {
      if (!isObj(pr)) continue;
      const url = pr.html_url;
      if (typeof url !== "string" || url === "") continue;
      if (!closing([bodyRow(pr)]).has(n)) continue;
      if (passAtHead(pr, trailers)) continue; // #4796: already PASSed at this head — next candidate
      const head = isObj(pr.head) ? (pr.head as Row).ref : null;
      // The bash printed `url\nhead` and read it back line by line (`sed -n 1p` / `2p`).
      const lines = `${url}\n${typeof head === "string" ? head : ""}`.split("\n");
      return { ref: lines[0], head: lines[1] ?? "" };
    }
  }
  return { ref: "", head: "" };
}

/** #4739: the Target dev-resume pick over the REST payloads, through the shared pick. */
export function targetDevResumePick(issues: readonly unknown[], prs: readonly unknown[], closing: (rows: readonly PrRefRow[]) => ReadonlySet<number>): PrPick | null {
  const candidates: { pr: number; headRefName: string | null; row: Row }[] = [];
  for (const pr of prs) {
    if (!isObj(pr) || pr.draft === true) continue;
    if (!pyIsInt(pr.number)) continue;
    const head = isObj(pr.head) ? (pr.head as Row).ref : null;
    candidates.push({ pr: pyIntOf(pr.number), headRefName: typeof head === "string" ? head : null, row: pr });
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

const EMPTY_JSON_ERROR = (pyJsonLoads("") as { error: string }).error;

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

  // 1. Counts: the healthy endpoint, else the gh fallback tally.
  const read = await deps.hydra.targetBoardState();
  const board = read.kind === "ok" ? parseHealthyBoard(read.body) : null;
  let counts: Classified<TargetBoardCounts | null>;
  let glmWithheld: number[] = [];
  let blockerExcluded: number[] = [];
  let fallbackReady: unknown[] | null = null;
  if (board !== null) {
    counts = { ok: true, value: healthyCounts(board) };
    glmWithheld = boardIssueList(board, "glm_withheld");
    blockerExcluded = boardIssueList(board, "blocker_excluded");
  } else {
    degraded.push({ field: "boardState", reason: "endpoint-degraded" });
    const issues = await deps.github.listOpenIssueLabelRows(limit);
    if (issues.kind === "empty") {
      laneDegraded = true;
      counts = { ok: false, reason: "fallback-read-failed" };
      degraded.push({ field: "counts", reason: "fallback-read-failed" });
    } else {
      const tally = fallbackTally(issues);
      counts = { ok: true, value: tally === null ? null : tally.counts };
      fallbackReady = tally === null ? null : tally.readyNumbers;
      if (tally === null) degraded.push({ field: "counts", reason: "fallback-untallyable" });
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
  if (counts.ok && counts.value !== null) {
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
      if (pair === null) notes.push(`target-qa stdin JSON parse FAILED (${EMPTY_JSON_ERROR}) — fail open (issue #4576)`);
      if (prRefs.ok && pair !== null) {
        const issues = Array.isArray(pair.first) ? pair.first : [];
        const prs = Array.isArray(pair.second) ? pair.second : [];
        // #4796: ONE repo-wide comments read; any failure degrades to [] (fail open, skip disabled).
        const verdicts = await deps.github.listQaVerdictCommentsRest(limit);
        if (verdicts.kind !== "ok") notes.push("target-qa verdict-comments REST read FAILED or empty — PASS-at-head skip disabled this turn (issue #4796)");
        const trailers = verdicts.kind === "ok" ? parseQaTrailers(verdicts.data) : [];
        needsQaPr = resolveNeedsQaPr(issues, prs, prRefs.predicates.closing, trailers);
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
    if (pair === null) notes.push(`target-dev-resume stdin JSON parse FAILED (${EMPTY_JSON_ERROR}) — fail closed to none (issue #4739)`);
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
