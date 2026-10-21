/**
 * turn-snapshot/pr-gate.ts — the in-flight PR + PR-gate reachability
 * collector (ADR-0043 slice 1, issue #4929), moved whole — fetch included —
 * out of `collect-state.sh`'s `collect_orch_inflight_prs` and
 * `collect_pr_gate_reachability`.
 *
 * Shape (the ADR-0040 Decision 2 precedent): pure classifiers over typed
 * inputs ({@link applyMergeStateRepoll}, {@link inflightRefs},
 * {@link classifyPrGate}) plus ONE orchestrating collector
 * ({@link collectPrGate}) over injected deps. Reads (all through the
 * `TurnSnapshotGithub` port):
 *
 *   - ONE `gh pr list` payload feeds every consumer (the in-flight reference
 *     sets AND the PR-gate buckets); the #4812 UNKNOWN re-poll is the single
 *     sanctioned second PR read, issued only when the first holds an UNKNOWN.
 *   - two `actions/runs` reads (newest push / pull_request run) feed the
 *     repo-wide `orch_ci_trigger_stale` discriminator — fail-OPEN (INV-E).
 *   - the required-contexts + needs-dev-resume reads feed the unified
 *     dev-resume pick — fail-CLOSED (INV-5).
 *
 * What it computes (semantics unchanged from the bash; the long-form history
 * of each rule lives in the issues named inline):
 *
 *   in-flight sets   issues an open PR references — union / branch-only /
 *                    body-only (#3851, #3964, #4334) — the exclusion input
 *                    the grill + dev picks and the Candidate Exclusion
 *                    telemetry consume (exported back to the bash).
 *   orch_prs_dirty   DIRTY, not draft, not ready-for-human (#4240).
 *   orch_prs_behind  BEHIND, not draft, no `no-rebase`, quiet > 5400s.
 *   orch_prs_unchecked  empty rollup, state not DIRTY/UNKNOWN/BEHIND, not
 *                    draft/surfaced, older than the grace window.
 *   orch_ci_trigger_stale  an unchecked PR is newer than the newest push AND
 *                    pull_request run (only when both timestamps parse).
 *   dev-resume pick  ANY provenance (#5058), not draft / ready-for-human /
 *                    DIRTY / UNKNOWN, quiescent, exactly one closing issue, no
 *                    required check pending, and the issue labelled
 *                    needs-dev-resume (#4518) OR a required check red (the
 *                    retired GLM-only #4460 arm, now provenance-agnostic).
 *   red-resume       the pick candidates that qualified ONLY through the
 *                    red-CI arm — decide.py's per-PR forward-fix cap scope.
 *   dirty fix-forward  pin / surface / wait split of the dirty bucket (#4807).
 *
 * Reference detection reuses src/github/pr-refs.ts (the TS port of
 * pr-refs.py) — no third regex copy. Never throws: every read failure is a
 * `DegradedMarker` plus a stderr note naming the same reason code.
 */

import { closedIssues, referencedIssues, type PrRefRow } from "../../github/pr-refs.ts";
import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import {
  DEFAULT_NOPR_RESUME_QUIESCENCE_SECONDS,
  isResumableHead,
  pickDevResume,
  pickNoPrResume,
  type NoPrResumeRow,
} from "./dev-resume.ts";
import { ghTimestampSeconds, type GhJsonRead, type TurnSnapshotGithub } from "./github-port.ts";
import type { QaVerdictRunner } from "./host-port.ts";

export const PR_GATE_COLLECTOR = "pr-gate";

/** `<anchor>:<pr>:<headRefName>` — a pinned dispatch target. */
export interface PrPick {
  readonly issue: number;
  readonly pr: number;
  readonly headRefName: string;
}

/** One dirty PR to surface to the operator this turn (`<pr>:<closingIssue|none>`). */
interface DirtySurfaceEntry {
  readonly pr: number;
  readonly closingIssue: number | null;
}

/** The three in-flight reference sets (sorted ascending). */
export interface InflightRefs {
  readonly union: readonly number[];
  readonly branch: readonly number[];
  readonly body: readonly number[];
}

/**
 * One `orch_qa_verdict_recheck` entry (#5052): the stdout of
 * `qa-verdict-event.sh <PR> <TIER>` for a PR that could merge once its QA
 * verdict binds to the current head - the durable twin of the session's
 * in-memory `qa-verdict` event.
 */
export interface QaRecheckEntry {
  readonly pr: number;
  readonly tier: number;
  readonly verdict: string;
  readonly verdictSha: string;
  readonly headSha: string;
}

export interface PrGateSnapshot {
  readonly inflight: InflightRefs;
  readonly dirty: readonly number[];
  readonly unchecked: readonly number[];
  readonly behind: readonly number[];
  /** Fail-open: degraded → rendered `false`. */
  readonly ciTriggerStale: Classified<boolean>;
  /**
   * The resume-pick candidates that qualified ONLY through the red-CI arm
   * (a required check red at the head, closing issue NOT labelled
   * `needs-dev-resume`), sorted ascending. decide.py caps forward-fix
   * dispatches per PR on exactly this set (#5058, ex-#4460 INV-8).
   * Fail-closed: degraded → empty.
   */
  readonly redResume: Classified<readonly number[]>;
  /**
   * The ONE provenance-agnostic durable resume pick (#4518 + the retired
   * GLM-only #4460 arm, unified by #5058). Fail-closed: degraded → `none`.
   */
  readonly devResumePick: Classified<PrPick | null>;
  /**
   * The no-PR durable resume pick (#4808): the lowest-numbered
   * `needs-dev-resume` issue NO open PR references, or `null`. Fail-closed on
   * any unusable input — degraded renders `null`, never a guess.
   */
  readonly devResumeNoprPick: Classified<number | null>;
  /** Fail-closed: degraded → `none` + empty surface. */
  readonly dirtyFix: Classified<{ readonly pick: PrPick | null; readonly surface: readonly DirtySurfaceEntry[] }>;
  /**
   * #5052: PRs to re-evaluate for merge this turn. Fail-closed: degraded ->
   * `[]`; no path synthesises a PASS.
   */
  readonly qaVerdictRecheck: Classified<readonly QaRecheckEntry[]>;
}

// ---------------------------------------------------------------------------
// Reference predicates (src/github/pr-refs.ts), injectable so a test can model
// the predicate being unavailable — the bash's `pr-refs.py import FAILED`
// fail-closed arm (#4460 INV-5, #4807 INV-4).
// ---------------------------------------------------------------------------

export interface PrRefPredicates {
  referenced(rows: readonly PrRefRow[]): ReadonlySet<number>;
  branch(rows: readonly PrRefRow[]): ReadonlySet<number>;
  body(rows: readonly PrRefRow[]): ReadonlySet<number>;
  closing(rows: readonly PrRefRow[]): ReadonlySet<number>;
}

export const DEFAULT_PR_REF_PREDICATES: PrRefPredicates = {
  referenced: (rows) => referencedIssues(rows),
  branch: (rows) => referencedIssues(rows.map((r) => ({ headRefName: r.headRefName }))),
  body: (rows) => referencedIssues(rows.map((r) => ({ body: r.body }))),
  closing: (rows) => closedIssues(rows),
};

export type PrRefsAvailability =
  | { readonly ok: true; readonly predicates: PrRefPredicates }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function asRow(v: unknown): Row | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null;
}

function rowsOf(list: readonly unknown[]): Row[] {
  return list.map(asRow).filter((r): r is Row => r !== null);
}

/**
 * Whether a decoded JSON field carries a value — the classifier's `x or
 * default` reading: `null`, `false`, `0`, `""` and an EMPTY list or object
 * read as unset; a non-empty list or object does not.
 */
function isSet(v: unknown): boolean {
  return v !== null && typeof v === "object" ? Object.keys(v).length > 0 : Boolean(v);
}

/** A decoded JSON value as note / set-key text: a string verbatim, anything else as JSON. */
function jsonText(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? "null");
}

/**
 * A PR's label names. Only non-empty STRING names are kept: every consumer
 * tests membership of a literal label, which a non-string name can never be.
 */
function labelsOf(pr: Row): Set<string> {
  const out = new Set<string>();
  const labels = pr.labels;
  if (!Array.isArray(labels)) return out;
  for (const l of labels) {
    const name = asRow(l)?.name;
    if (typeof name === "string" && name !== "") out.add(name);
  }
  return out;
}

function refRow(pr: Row): PrRefRow {
  return {
    headRefName: typeof pr.headRefName === "string" ? pr.headRefName : null,
    body: typeof pr.body === "string" ? pr.body : null,
  };
}

/** `pr.get(k) or ""` */
function orEmpty(v: unknown): unknown {
  return isSet(v) ? v : "";
}

function upper(v: unknown): string {
  return isSet(v) ? String(v).toUpperCase() : "";
}

const ascending = (a: number, b: number) => a - b;

/**
 * GLM provenance (label or worktree-branch prefix). Display / telemetry only
 * since #5058 — no selector gates on provenance any more.
 */
export function isGlmProvenance(names: Set<unknown>, head: unknown): boolean {
  return names.has("glm-authored") || (typeof head === "string" && head.startsWith("worktree-agent-glm-"));
}

// ---------------------------------------------------------------------------
// #4812 — the UNKNOWN mergeStateStatus re-poll reducer (pure)
// ---------------------------------------------------------------------------

/** Does the first payload hold >=1 UNKNOWN PR (the re-poll trigger)? */
export function hasUnknownMergeState(first: readonly unknown[]): boolean {
  return first.some((p) => asRow(p)?.mergeStateStatus === "UNKNOWN");
}

/** A Python dict key for a JSON value, or `null` when Python would raise `unhashable type`. */
function pyKey(v: unknown): string | null {
  if (v === undefined || v === null) return "None";
  if (typeof v === "boolean") return `n:${v ? 1 : 0}`;
  if (typeof v === "number") return `n:${v}`;
  if (typeof v === "string") return `s:${v}`;
  return null;
}

export type RepollResult =
  /** Re-poll merged: only mergeStateStatus changed, only for first-payload PRs. */
  | { readonly kind: "merged"; readonly rows: readonly unknown[]; readonly resolved: readonly string[]; readonly still: readonly string[] }
  /** Re-poll unusable (empty / unparseable / non-list): first payload kept. */
  | { readonly kind: "failed"; readonly rows: readonly unknown[]; readonly reason: string; readonly unknown: readonly string[] }
  /** Re-poll payload broke the merge (a non-scalar PR number): first payload kept (INV-5). */
  | { readonly kind: "reducer-failed"; readonly rows: readonly unknown[] };

/**
 * Merge the re-poll into the first payload by PR number. Only
 * `mergeStateStatus` is overwritten, only for first-payload UNKNOWN PRs, and
 * only with a non-UNKNOWN value; re-poll-only PRs are ignored. Never blanks
 * the first payload.
 */
export function applyMergeStateRepoll(first: readonly unknown[], repoll: GhJsonRead): RepollResult {
  if (repoll.kind !== "ok" || !Array.isArray(repoll.data)) {
    const reason = repoll.kind === "empty" ? "empty-payload" : repoll.kind === "unparseable" ? "unparseable" : "not a list";
    const unknown = first
      .map(asRow)
      .filter((p): p is Row => p !== null && p.mergeStateStatus === "UNKNOWN")
      .map((p) => jsonText(p.number));
    return { kind: "failed", rows: first, reason, unknown };
  }
  const fresh = new Map<string, unknown>();
  for (const p of rowsOf(repoll.data)) {
    if (!("number" in p)) continue;
    const key = pyKey(p.number);
    if (key === null) return { kind: "reducer-failed", rows: first };
    fresh.set(key, p.mergeStateStatus);
  }
  const resolved: string[] = [];
  const still: string[] = [];
  const rows: unknown[] = [];
  for (const raw of first) {
    const p = asRow(raw);
    if (p === null || p.mergeStateStatus !== "UNKNOWN") {
      rows.push(raw);
      continue;
    }
    const key = pyKey(p.number);
    if (key === null) return { kind: "reducer-failed", rows: first };
    const next = fresh.get(key);
    if (isSet(next) && next !== "UNKNOWN") {
      rows.push({ ...p, mergeStateStatus: next });
      resolved.push(`${jsonText(p.number)}=${jsonText(next)}`);
    } else {
      rows.push(raw);
      still.push(jsonText(p.number));
    }
  }
  return { kind: "merged", rows, resolved, still };
}

// ---------------------------------------------------------------------------
// In-flight reference sets (pure)
// ---------------------------------------------------------------------------

const EMPTY_INFLIGHT: InflightRefs = { union: [], branch: [], body: [] };

/** The three in-flight sets over the (re-polled) open-PR payload; unavailable predicates → empty. */
function inflightRefs(prs: readonly unknown[], prRefs: PrRefsAvailability): InflightRefs {
  if (!prRefs.ok) return EMPTY_INFLIGHT;
  const rows = rowsOf(prs).map(refRow);
  const sorted = (s: ReadonlySet<number>) => [...s].sort(ascending);
  return {
    union: sorted(prRefs.predicates.referenced(rows)),
    branch: sorted(prRefs.predicates.branch(rows)),
    body: sorted(prRefs.predicates.body(rows)),
  };
}

// ---------------------------------------------------------------------------
// PR-gate classification (pure)
// ---------------------------------------------------------------------------

/** Behind-bucket + dirty-surface quiescence window (seconds). */
const BEHIND_QUIESCENCE_SECONDS = 5400;
/** Attempted-and-quiescent dirty surface window (seconds, #4807). */
const DIRTY_ATTEMPTED_SURFACE_SECONDS = 5400;
const DEFAULT_UNCHECKED_GRACE_SECONDS = 600;
/**
 * The resume / dirty-fix quiescence window (seconds). The env knob keeps its
 * historical `HYDRA_ORCH_GLM_RED_QUIESCENCE_SECONDS` name (operator-facing);
 * the window itself is provenance-agnostic.
 */
const DEFAULT_GLM_RED_QUIESCENCE_SECONDS = 1800;

interface PrGateInputs {
  /** The (re-polled) open-PR rows; non-object rows are skipped. */
  readonly prs: readonly unknown[];
  readonly nowSeconds: number;
  readonly uncheckedGraceSeconds: number;
  readonly glmRedQuiescenceSeconds: number;
  /** Newest push / pull_request run `created_at`; `null` when the read degraded. */
  readonly runsPushCreatedAt: string | null;
  readonly runsPullRequestCreatedAt: string | null;
  readonly requiredContexts: Classified<ReadonlySet<string>>;
  readonly devResumeIssues: Classified<ReadonlySet<number>>;
  readonly prRefs: PrRefsAvailability;
  /**
   * #4808 (INV-4): `false` when the open-PR read was empty/unparseable — an
   * empty in-flight set from a failed read would make EVERY resume issue look
   * PR-less, so the no-PR pick fails closed on it.
   */
  readonly prListReadOk: boolean;
  /** The widened needs-dev-resume rows (#4808, INV-3); `{ok:false}` on an empty/unparseable read. */
  readonly devResumeRows: Classified<readonly NoPrResumeRow[]>;
  /** The no-PR pick's quiescence window in seconds (#4808). */
  readonly noprQuiescenceSeconds: number;
  /**
   * The open-PR read's `--limit`: a payload at/over the limit is a saturated
   * page that may hide the referencing PR, so the no-PR pick fails closed
   * (#4808 INV-4). `undefined` = unbounded (no saturation check).
   */
  readonly ghListLimit?: number;
}

/** One orch-pre-qualified resume candidate (its required-check verdict read once). */
interface ResumeCandidate {
  readonly pr: number;
  readonly headRefName: string | null;
  readonly row: Row;
  /** A required check is red at the head (the red-CI arm). */
  readonly red: boolean;
  /** Every required check is present and none is pending. */
  readonly settled: boolean;
}

const RED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/**
 * De-duplicate rollup entries by check name KEEPING THE LATEST (greatest
 * startedAt; ties → later list index). CheckRun rows key on `name`,
 * StatusContext rows on `context`. CANCELLED is never red (#4460 INV-4).
 */
function rollupLatest(rollup: readonly unknown[]): Map<string, { pending: boolean; red: boolean }> {
  const latest = new Map<string, { started: number; pending: boolean; red: boolean }>();
  rollup.forEach((raw) => {
    const e = asRow(raw);
    if (e === null) return;
    const name = isSet(e.name) ? e.name : isSet(e.context) ? e.context : "";
    if (!isSet(name)) return;
    const key = typeof name === "string" ? name : `\u0000${JSON.stringify(name)}`;
    let pending: boolean;
    let red: boolean;
    if ("conclusion" in e || e.__typename === "CheckRun") {
      const status = upper(e.status);
      pending = status !== "COMPLETED";
      red = status === "COMPLETED" && RED_CONCLUSIONS.has(upper(e.conclusion));
    } else {
      const state = upper(e.state);
      pending = state === "" || state === "PENDING" || state === "EXPECTED";
      red = state === "FAILURE" || state === "ERROR";
    }
    const started = ghTimestampSeconds(e.startedAt) || 0;
    const prev = latest.get(key);
    if (prev === undefined || started >= prev.started) latest.set(key, { started, pending, red });
  });
  return new Map([...latest].map(([k, v]) => [k, { pending: v.pending, red: v.red }]));
}

/** Required-check verdict for one PR: `null` = some required context missing or pending. */
function requiredVerdict(rollup: unknown, required: ReadonlySet<string>): { red: boolean } | null {
  if (!Array.isArray(rollup)) return null;
  const latest = rollupLatest(rollup);
  const entries = [...latest].filter(([n]) => required.has(n)).map(([, v]) => v);
  if (entries.length !== required.size) return null;
  if (entries.some((v) => v.pending)) return null;
  return { red: entries.some((v) => v.red) };
}

/**
 * The `Tier: N` line of a PR body (N in 1-4), or `null` when absent/unparseable.
 * Line-anchored so a mid-sentence mention never counts.
 */
export function parseTierLine(body: unknown): number | null {
  if (typeof body !== "string") return null;
  const m = /^[ \t>*_-]*Tier\s*:\s*[*_]*\s*([1-4])(?!\d)/im.exec(body);
  return m === null ? null : Number(m[1]);
}

/**
 * #5052 INV-6: the pure pre-filter over the ONE open-PR read. A candidate is
 * open, non-draft, not `ready-for-human`, not already armed for auto-merge
 * (`autoMergeRequest === null` - an absent field is NOT proof it is unarmed),
 * mergeable-shaped (not DIRTY/UNKNOWN), carries a parseable `Tier: N` line,
 * and has every required check settled and none red. No script run or read is
 * spent on anything else.
 */
export function qaRecheckCandidates(
  prs: readonly unknown[],
  required: ReadonlySet<string>,
): { readonly pr: number; readonly tier: number }[] {
  const out: { pr: number; tier: number }[] = [];
  for (const pr of rowsOf(prs)) {
    const number = pr.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (isSet(pr.isDraft) || labelsOf(pr).has("ready-for-human")) continue;
    if (pr.autoMergeRequest !== null) continue;
    const state = orEmpty(pr.mergeStateStatus);
    if (state === "DIRTY" || state === "UNKNOWN") continue;
    const tier = parseTierLine(pr.body);
    if (tier === null) continue;
    const verdict = requiredVerdict(pr.statusCheckRollup, required);
    if (verdict === null || verdict.red) continue;
    out.push({ pr: number, tier });
  }
  return out.sort((a, b) => a.pr - b.pr);
}

/** A `qa-verdict-event.sh` stdout object as a typed entry, or `null` when it is not the expected shape. */
export function parseQaRecheckEntry(raw: unknown, pr: number, tier: number): QaRecheckEntry | null {
  const e = asRow(raw);
  if (e === null) return null;
  if (e.pr_number !== pr || e.tier !== tier) return null;
  if (typeof e.verdict !== "string" || e.verdict === "") return null;
  if (typeof e.verdict_sha !== "string" || typeof e.head_sha !== "string") return null;
  return { pr, tier, verdict: e.verdict, verdictSha: e.verdict_sha, headSha: e.head_sha };
}

/** Classify every open PR. Returns the snapshot fields (minus in-flight) plus the classifier's stderr notes. */
function classifyPrGate(inputs: PrGateInputs): { value: Omit<PrGateSnapshot, "inflight">; notes: string[] } {
  const notes: string[] = [];
  const now = inputs.nowSeconds;
  const quiet = inputs.glmRedQuiescenceSeconds;
  const prs = rowsOf(inputs.prs);

  const dirty: number[] = [];
  const unchecked: number[] = [];
  const behind: number[] = [];
  for (const pr of prs) {
    const number = pr.number;
    if (typeof number !== "number") continue;
    const state = orEmpty(pr.mergeStateStatus);
    const names = labelsOf(pr);
    const created = ghTimestampSeconds(pr.createdAt);
    const updated = ghTimestampSeconds(pr.updatedAt);
    const draft = isSet(pr.isDraft);
    // ready-for-human is the surfacing idempotency key (classifyPR parity).
    const surfaced = names.has("ready-for-human");
    if (state === "DIRTY" && !surfaced && !draft) {
      dirty.push(number);
      continue;
    }
    if (state === "BEHIND" && !draft && !names.has("no-rebase") && updated !== null && now - updated > BEHIND_QUIESCENCE_SECONDS) {
      behind.push(number);
      continue;
    }
    const rollup = pr.statusCheckRollup;
    if (
      !surfaced &&
      !draft &&
      Array.isArray(rollup) &&
      rollup.length === 0 &&
      state !== "DIRTY" &&
      state !== "UNKNOWN" &&
      state !== "BEHIND" &&
      created !== null &&
      now - created > inputs.uncheckedGraceSeconds
    ) {
      unchecked.push(number);
    }
  }

  // ci_trigger_stale: only when BOTH run timestamps were read (INV-E fail-open).
  let ciTriggerStale: Classified<boolean>;
  if (inputs.runsPushCreatedAt === null || inputs.runsPullRequestCreatedAt === null) {
    ciTriggerStale = { ok: false, reason: "runs-read-failed" };
  } else {
    let stale = false;
    const push = ghTimestampSeconds(inputs.runsPushCreatedAt);
    const prRun = ghTimestampSeconds(inputs.runsPullRequestCreatedAt);
    if (push !== null && prRun !== null && unchecked.length > 0) {
      const newest = Math.max(push, prRun);
      for (const n of unchecked) {
        const pr = prs.find((p) => p.number === n);
        const created = ghTimestampSeconds(pr?.createdAt);
        if (created !== null && created > newest) {
          stale = true;
          break;
        }
      }
    }
    ciTriggerStale = { ok: true, value: stale };
  }

  // The unified durable dev-resume pick (#4518 + #4460, unified by #5058) —
  // fail closed on any unavailable input (INV-5).
  const req = inputs.requiredContexts;
  const resume = inputs.devResumeIssues;
  const refs = inputs.prRefs;
  let redResume: PrGateSnapshot["redResume"];
  let devResumePick: PrGateSnapshot["devResumePick"];
  if (!req.ok || !resume.ok || !refs.ok) {
    const reason = "required-contexts / needs-dev-resume / pr-refs input unavailable";
    notes.push(`orch dev-resume classifier fail-closed (${reason}) — issue #4460 INV-5`);
    redResume = { ok: false, reason };
    devResumePick = { ok: false, reason };
  } else {
    // Provenance-agnostic (#5058): a GLM, Claude or any future worker lane's
    // PR qualifies alike. Only the orch pre-qualification gates live here; the
    // selection is the ONE pick both realms share (dev-resume.ts, #4932).
    // `ready-for-human` stays a hard exclusion: it is the operator's cue
    // (QA round-cap #4735, conflict / cap-exhausted surface) and the
    // surface-pr idempotency key — /hydra-review clears it when the operator
    // hands the PR back to an autonomous lane.
    const candidates: ResumeCandidate[] = [];
    for (const pr of prs) {
      const number = pr.number;
      if (typeof number !== "number") continue;
      const names = labelsOf(pr);
      const head = orEmpty(pr.headRefName);
      if (isSet(pr.isDraft) || names.has("ready-for-human")) continue;
      const state = orEmpty(pr.mergeStateStatus);
      if (state === "DIRTY" || state === "UNKNOWN") continue;
      const updated = ghTimestampSeconds(pr.updatedAt);
      if (updated === null || now - updated < quiet) continue;
      const verdict = requiredVerdict(pr.statusCheckRollup, req.value);
      candidates.push({
        pr: number,
        headRefName: isSet(head) ? String(head) : null,
        row: pr,
        red: verdict?.red === true,
        settled: verdict !== null,
      });
    }
    // Memoised so the pick and the red-resume bucket read each PR's closing
    // set (and emit its failure note) exactly once.
    const closingMemo = new Map<number, ReadonlySet<number> | null>();
    const closing = (c: ResumeCandidate): ReadonlySet<number> | null => {
      const memo = closingMemo.get(c.pr);
      if (memo !== undefined) return memo;
      let closed: ReadonlySet<number> | null;
      try {
        closed = refs.predicates.closing([refRow(c.row)]);
      } catch (err) {
        /* intentional: surfaced as a stderr note on the outcome; the PR is skipped, never the turn */
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`orch dev-resume closing_issues() failed for PR ${c.pr} (${msg}) — skipping PR (issue #4518)`);
        closed = null;
      }
      closingMemo.set(c.pr, closed);
      return closed;
    };
    devResumePick = {
      ok: true,
      value: pickDevResume({
        candidates,
        resumeIssues: resume.value,
        closing,
        settled: (c) => c.settled,
        alsoQualifies: (c) => c.red,
        policy: "lowest-pr",
      }),
    };
    const bucket: number[] = [];
    for (const c of candidates) {
      if (!c.red || !c.settled || !isResumableHead(c.headRefName)) continue;
      const closed = closing(c);
      if (closed === null || closed.size !== 1) continue;
      if (resume.value.has([...closed][0])) continue;
      bucket.push(c.pr);
    }
    redResume = { ok: true, value: bucket.sort(ascending) };
  }

  // Dirty-PR conflict fix-forward (#4807): pin / surface / wait. The dirty
  // bucket itself stays whole (the auto-merge sweep's hold reads it).
  let dirtyFix: PrGateSnapshot["dirtyFix"];
  if (!refs.ok) {
    if (dirty.length > 0) {
      notes.push(
        "orch dirty-fix classifier fail-closed (pr-refs.py unavailable) — orch_dirty_forward_fix=none, empty surface (issue #4807, INV-4)",
      );
    }
    dirtyFix = { ok: false, reason: "pr-refs unavailable" };
  } else {
    const byNumber = new Map<unknown, Row>();
    for (const p of prs) byNumber.set(p.number, p);
    let pick: PrPick | null = null;
    const surface: DirtySurfaceEntry[] = [];
    for (const number of [...dirty].sort(ascending)) {
      const pr = byNumber.get(number);
      if (pr === undefined) continue;
      const names = labelsOf(pr);
      const updated = ghTimestampSeconds(pr.updatedAt);
      let closed: number[];
      try {
        closed = [...refs.predicates.closing([refRow(pr)])];
      } catch (err) {
        /* intentional: surfaced as a stderr note on the outcome — an unparseable body can never be pinned, so surface it (a terminal wait strands the PR) */
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`orch dirty-fix closing_issues() failed for PR ${number} (${msg}) — surfacing (issue #4807)`);
        closed = [];
      }
      const single = closed.length === 1 ? closed[0] : null;
      const age = updated !== null ? now - updated : null;
      if (!names.has("conflict-fix-attempted")) {
        const head = orEmpty(pr.headRefName);
        if (single === null || !isSet(head) || String(head).includes(":")) {
          surface.push({ pr: number, closingIssue: single });
          continue;
        }
        if (age === null || age < quiet) continue;
        if (pick === null) pick = { issue: single, pr: number, headRefName: String(head) };
      } else if (age === null || age >= DIRTY_ATTEMPTED_SURFACE_SECONDS) {
        surface.push({ pr: number, closingIssue: single });
      }
    }
    dirtyFix = { ok: true, value: { pick, surface } };
  }

  // No-PR durable dev resume (#4808): a `needs-dev-resume` issue NO open PR
  // references — exactly the anchor none of the PR-keyed pins above can name.
  // Fail closed on any unusable input (INV-4): an empty in-flight set from a
  // failed open-PR read would make every resume issue look PR-less, unavailable
  // pr-refs predicates silently empty the same set, and a saturated page may
  // hide the referencing PR. Independent of the required-contexts read by
  // design (the pick needs no CI verdict — there is no PR to judge).
  let devResumeNoprPick: PrGateSnapshot["devResumeNoprPick"];
  const noprFail = (reason: string): PrGateSnapshot["devResumeNoprPick"] => {
    notes.push(`orch dev-resume no-PR pick fail-closed (${reason}) — issue #4808 INV-4`);
    return { ok: false, reason };
  };
  const noprRows = inputs.devResumeRows;
  if (!inputs.prListReadOk) {
    devResumeNoprPick = noprFail("pr-list read failed");
  } else if (!refs.ok) {
    devResumeNoprPick = noprFail("pr-refs unavailable");
  } else if ("reason" in noprRows) {
    devResumeNoprPick = noprFail(`needs-dev-resume read ${noprRows.reason}`);
  } else if (inputs.ghListLimit !== undefined && inputs.prs.length >= inputs.ghListLimit) {
    devResumeNoprPick = noprFail("open-PR page saturated");
  } else {
    devResumeNoprPick = {
      ok: true,
      value: pickNoPrResume({
        rows: noprRows.value,
        inflightUnion: new Set(inflightRefs(inputs.prs, inputs.prRefs).union),
        nowSeconds: now,
        quiescenceSeconds: inputs.noprQuiescenceSeconds,
      }),
    };
  }

  return {
    value: {
      dirty: dirty.sort(ascending),
      unchecked: unchecked.sort(ascending),
      behind: behind.sort(ascending),
      ciTriggerStale,
      redResume,
      devResumePick,
      devResumeNoprPick,
      dirtyFix,
      // Filled by collectPrGate (it needs the host port); fail-closed until then.
      qaVerdictRecheck: { ok: false, reason: "not-evaluated" },
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Input parsers (pure) — the JSON-vs-empty discipline of #4130
// ---------------------------------------------------------------------------

/** Branch protection `.contexts`: list → the set entries as strings; null/other JSON → healthy empty set. */
function parseRequiredContexts(read: GhJsonRead): Classified<ReadonlySet<string>> {
  if (read.kind === "empty") return { ok: false, reason: "empty-payload" };
  if (read.kind === "unparseable") return { ok: false, reason: "unparseable" };
  if (!Array.isArray(read.data)) return { ok: true, value: new Set() };
  return { ok: true, value: new Set(read.data.filter(isSet).map(jsonText)) };
}

/** `[{"number": N}, …]` → the issue numbers. A non-iterable JSON value is a failed read (Python's TypeError). */
function parseDevResumeIssues(read: GhJsonRead): Classified<ReadonlySet<number>> {
  if (read.kind === "empty") return { ok: false, reason: "empty-payload" };
  if (read.kind === "unparseable") return { ok: false, reason: "unparseable" };
  const data = read.data;
  if (typeof data === "string" || (data !== null && typeof data === "object" && !Array.isArray(data))) {
    return { ok: true, value: new Set() };
  }
  if (!Array.isArray(data)) return { ok: false, reason: "not-iterable" };
  const out = new Set<number>();
  for (const row of rowsOf(data)) {
    const n = row.number;
    if (typeof n === "boolean") out.add(n ? 1 : 0);
    else if (typeof n === "number" && Number.isInteger(n)) out.add(n);
  }
  return { ok: true, value: out };
}

/**
 * The #4808 no-PR-pick rows off the SAME widened read (INV-3):
 * `[{"number": N, "labels": [{name}], "updatedAt": "..."}]` → the parsed
 * rows. A row's missing/unparseable `updatedAt` is a SKIPPED row (the pure
 * pick's rule), never a failed read; the same empty/unparseable/not-iterable
 * discipline as {@link parseDevResumeIssues}.
 */
function parseNoPrResumeRows(read: GhJsonRead): Classified<readonly NoPrResumeRow[]> {
  if (read.kind === "empty") return { ok: false, reason: "empty-payload" };
  if (read.kind === "unparseable") return { ok: false, reason: "unparseable" };
  const data = read.data;
  if (typeof data === "string" || (data !== null && typeof data === "object" && !Array.isArray(data))) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(data)) return { ok: false, reason: "not-iterable" };
  const out: NoPrResumeRow[] = [];
  for (const row of rowsOf(data)) {
    const n = row.number;
    if (typeof n !== "number" || !Number.isInteger(n)) continue;
    out.push({ number: n, labels: labelsOf(row), updatedAt: ghTimestampSeconds(row.updatedAt) });
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// The collector (orchestration over injected deps)
// ---------------------------------------------------------------------------

/** Raw env-window strings (the bash read them from HYDRA_ORCH_*; unset/empty = default). */
export interface PrGateEnv {
  readonly uncheckedGraceSeconds?: string;
  readonly glmRedQuiescenceSeconds?: string;
  readonly unknownRepollDelaySeconds?: string;
  /** #4808: the no-PR resume pick's quiescence window (unset/empty = 5400s). */
  readonly devResumeNoprQuiescenceSeconds?: string;
}

/** The port reads this collector issues (a narrow view, so a fake needs only these). */
type PrGateGithub = Pick<
  TurnSnapshotGithub,
  "listOpenPrs" | "listOpenPrMergeStates" | "latestWorkflowRunCreatedAt" | "requiredStatusContexts" | "listOpenIssueRowsByLabel"
>;

export interface PrGateDeps {
  readonly github: PrGateGithub;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep: (seconds: number) => Promise<void>;
  /** `gh … --limit` page size (collect-state.sh's GH_ISSUE_LIST_LIMIT). */
  readonly ghListLimit: number;
  readonly env?: PrGateEnv;
  /** Defaults to the src/github/pr-refs.ts predicates. */
  readonly prRefs?: PrRefsAvailability;
  /**
   * #5052 INV-2: runs `qa-verdict-event.sh` for each recheck candidate. Absent
   * -> the recheck fails closed (`[]` + a degraded marker) when a candidate exists.
   */
  readonly host?: QaVerdictRunner;
}

const DEFAULT_REPOLL_DELAY = "5";

/**
 * The env windows' accepted grammar: a decimal float literal (optional sign,
 * digits with single `_` separators, optional fraction and exponent), or
 * `inf` / `infinity` / `nan` in any case — the forms the windows have always
 * accepted (#4240, #4460, #4808).
 */
const WINDOW_SECONDS_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.?\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*\.|inf(?:inity)?|nan)$/i;

/**
 * One `HYDRA_ORCH_*_SECONDS` window: unset/empty → `fallback` silently; a
 * {@link WINDOW_SECONDS_RE} literal (surrounding whitespace ignored) → its
 * value; anything else → `fallback` plus a `not-numeric` reason quoting the
 * raw text for the stderr note.
 */
function windowSeconds(raw: string | undefined, fallback: number): { value: number; error: string | null } {
  if (raw === undefined || raw === "") return { value: fallback, error: null };
  const s = raw.trim();
  if (!WINDOW_SECONDS_RE.test(s)) return { value: fallback, error: `not-numeric: ${JSON.stringify(raw)}` };
  const lower = s.toLowerCase().replace(/^[+]/, "");
  if (/^-?inf(inity)?$/.test(lower)) return { value: lower.startsWith("-") ? -Infinity : Infinity, error: null };
  if (/^-?nan$/.test(lower)) return { value: Number.NaN, error: null };
  return { value: Number(s.replace(/_/g, "")), error: null };
}

/** A non-negative decimal (`[0-9.]` with at most one dot) — the bash `case` guard on the re-poll delay. */
function isValidDelay(raw: string): boolean {
  return raw !== "" && /^[0-9.]+$/.test(raw) && (raw.match(/\./g)?.length ?? 0) <= 1;
}

/** Gather and classify the in-flight PR sets + PR-gate signals. Never throws on a read failure. */
export async function collectPrGate(deps: PrGateDeps): Promise<CollectorOutcome<PrGateSnapshot>> {
  const notes: string[] = [];
  const degraded: DegradedMarker[] = [];
  const env = deps.env ?? {};
  const prRefs: PrRefsAvailability = deps.prRefs ?? { ok: true, predicates: DEFAULT_PR_REF_PREDICATES };
  const limit = deps.ghListLimit;

  // 1. The ONE open-PR read, then the #4812 conditional re-poll.
  const first = await deps.github.listOpenPrs(limit);
  let payload: GhJsonRead = first;
  if (first.kind === "unparseable") {
    notes.push("orch pr-gate UNKNOWN probe could not parse first payload (unparseable) — skipping re-poll (issue #4812)");
  } else if (first.kind === "ok" && Array.isArray(first.data) && hasUnknownMergeState(first.data)) {
    const rawDelay = env.unknownRepollDelaySeconds || DEFAULT_REPOLL_DELAY;
    let delay = rawDelay;
    if (!isValidDelay(rawDelay)) {
      notes.push(
        `orch UNKNOWN re-poll: non-numeric HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS='${rawDelay}' — using 5 (issue #4812)`,
      );
      delay = DEFAULT_REPOLL_DELAY;
    }
    await deps.sleep(Number(delay));
    const repoll = await deps.github.listOpenPrMergeStates(limit);
    const merged = applyMergeStateRepoll(first.data, repoll.read);
    if (merged.kind === "failed") {
      const why = repoll.stderrHead ? `${merged.reason}; gh stderr: ${repoll.stderrHead}` : merged.reason;
      notes.push(
        `orch pr-gate UNKNOWN re-poll FAILED (${why}) — keeping first payload; UNKNOWN PR(s) stay skipped: ${merged.unknown.join(" ")} (issue #4812)`,
      );
      degraded.push({ field: "repoll", reason: merged.reason });
    } else if (merged.kind === "reducer-failed") {
      notes.push(
        "orch UNKNOWN re-poll reducer failed or produced no output — keeping first payload; UNKNOWN PR(s) stay skipped (issue #4812)",
      );
      degraded.push({ field: "repoll", reason: "reducer-failed" });
    } else {
      if (merged.resolved.length > 0) {
        notes.push(`orch pr-gate re-poll resolved mergeStateStatus for PR(s): ${merged.resolved.join(" ")} (issue #4812)`);
      }
      if (merged.still.length > 0) {
        notes.push(`orch pr-gate mergeStateStatus UNKNOWN after re-poll — skipping PR(s): ${merged.still.join(" ")} (issue #4812)`);
      }
    }
    payload = { kind: "ok", data: merged.rows };
  }

  const prs: readonly unknown[] = payload.kind === "ok" && Array.isArray(payload.data) ? payload.data : [];
  const inflight = inflightRefs(prs, prRefs);

  // 2. The repo-wide trigger-staleness reads — fail OPEN (INV-E).
  let runsPush = await deps.github.latestWorkflowRunCreatedAt("push");
  let runsPr = await deps.github.latestWorkflowRunCreatedAt("pull_request");
  if (runsPush === null || runsPr === null) {
    runsPush = null;
    runsPr = null;
    notes.push("orch ci-trigger runs read FAILED (empty payload) — orch_ci_trigger_stale fails open to false (issue #4240, INV-E)");
    degraded.push({ field: "ciTriggerStale", reason: "runs-read-failed" });
  }
  if (payload.kind === "empty") {
    notes.push("orch pr-gate PR-list read FAILED (empty payload) — emitting empty PR-gate buckets (issue #4240)");
  }

  // 3. The dev-resume inputs — fail CLOSED (INV-5).
  const requiredRead = await deps.github.requiredStatusContexts();
  if (requiredRead.kind === "empty") {
    notes.push(
      "orch dev-resume required-contexts read FAILED (empty payload) — orch_prs_red_resume/orch_dev_resume_pick fail closed to none (issue #4460, INV-5)",
    );
  }
  const resumeRead = await deps.github.listOpenIssueRowsByLabel("needs-dev-resume", limit);
  if (resumeRead.kind === "empty") {
    notes.push(
      "orch dev-resume needs-dev-resume issue read FAILED (empty payload) — orch_prs_red_resume/orch_dev_resume_pick fail closed to none (issue #4460, INV-5)",
    );
  }

  // 4. Classification inputs (the old heredoc's own preamble notes).
  if (payload.kind !== "ok") {
    const reason = payload.kind === "empty" ? "empty-payload" : "unparseable";
    notes.push(`orch pr-gate PR-list JSON parse FAILED (${reason}) — falling back to empty PR list (issue #4240)`);
    degraded.push({ field: "prList", reason });
  }
  const grace = windowSeconds(env.uncheckedGraceSeconds, DEFAULT_UNCHECKED_GRACE_SECONDS);
  if (grace.error !== null) {
    notes.push(
      `orch pr-gate ORCH_PR_UNCHECKED_GRACE_SECONDS unparsable (${grace.error}) — falling back to 600s default (issue #4240)`,
    );
  }
  if ("error" in prRefs) {
    notes.push(`orch dev-resume pr-refs.py import FAILED (${prRefs.error}) — fail closed (issue #4460)`);
    degraded.push({ field: "prRefs", reason: "predicate-unavailable" });
  }
  const quiet = windowSeconds(env.glmRedQuiescenceSeconds, DEFAULT_GLM_RED_QUIESCENCE_SECONDS);
  if (quiet.error !== null) {
    notes.push(
      `orch pr-gate ORCH_GLM_RED_QUIESCENCE_SECONDS unparsable (${quiet.error}) — falling back to 1800s default (issue #4460)`,
    );
  }
  const noprQuiet = windowSeconds(env.devResumeNoprQuiescenceSeconds, DEFAULT_NOPR_RESUME_QUIESCENCE_SECONDS);
  if (noprQuiet.error !== null) {
    notes.push(
      `orch dev-resume no-PR pick HYDRA_ORCH_DEV_RESUME_NOPR_QUIESCENCE_SECONDS unparsable (${noprQuiet.error}) — falling back to 5400s default (issue #4808)`,
    );
  }

  const requiredContexts = parseRequiredContexts(requiredRead);
  const devResumeIssues = parseDevResumeIssues(resumeRead);
  const devResumeRows = parseNoPrResumeRows(resumeRead);
  if ("reason" in requiredContexts) degraded.push({ field: "requiredContexts", reason: requiredContexts.reason });
  if ("reason" in devResumeIssues) degraded.push({ field: "devResumeIssues", reason: devResumeIssues.reason });

  const classified = classifyPrGate({
    prs,
    nowSeconds: deps.now() / 1000,
    uncheckedGraceSeconds: grace.value,
    glmRedQuiescenceSeconds: quiet.value,
    runsPushCreatedAt: runsPush,
    runsPullRequestCreatedAt: runsPr,
    requiredContexts,
    devResumeIssues,
    prRefs,
    prListReadOk: payload.kind === "ok",
    devResumeRows,
    noprQuiescenceSeconds: noprQuiet.value,
    ghListLimit: limit,
  });
  notes.push(...classified.notes);
  // INV-4: the no-PR pick's degradation is its OWN marker — never
  // orch_board_signals_degraded (that is the board read's flag, not pr-gate's).
  const noprOutcome = classified.value.devResumeNoprPick;
  if ("reason" in noprOutcome) {
    degraded.push({ field: "devResumeNoprPick", reason: noprOutcome.reason });
  }

  // 5. #5052: the durable QA-verdict recheck - fail CLOSED, never a synthesised PASS.
  const qaVerdictRecheck = await collectQaRecheck(prs, payload.kind === "ok", requiredContexts, deps.host, notes, deps.now());
  if ("reason" in qaVerdictRecheck) degraded.push({ field: "qaVerdictRecheck", reason: qaVerdictRecheck.reason });

  return {
    collector: PR_GATE_COLLECTOR,
    value: { inflight, ...classified.value, qaVerdictRecheck },
    degraded,
    notes,
  };
}

/** Max `qa-verdict-event.sh` runs in flight at once, and per snapshot turn (#5052 QA round 1). */
const QA_RECHECK_CONCURRENCY = 3; // matches the gh secondary-rate-limit-safe parallelism used elsewhere in the snapshot
const QA_RECHECK_MAX_PER_TURN = 12; // 4 waves at concurrency 3: ~1 minute typical, up to 4 x 90s per-script timeout worst case
/**
 * #5052 QA rounds 2-3: pick at most `max` candidates, starting at a pseudo-random
 * offset derived from a hash of the wall-clock millisecond and wrapping, so a
 * persistent set of non-mergeable low-numbered PRs cannot starve higher-numbered
 * PASS-pending-CI PRs. Stateless, and (unlike a linear `floor(now/period)*max`
 * offset) it cannot alias with a fixed turn cadence: the start is a mixed hash,
 * not an arithmetic progression, so no turn spacing pins the same window.
 */
export function rotateQaRecheckBatch<T>(candidates: readonly T[], max: number, nowMs: number): T[] {
  if (candidates.length <= max) return [...candidates];
  // 32-bit integer mix (murmur3 finalizer) of the epoch-ms value.
  let h = (Math.floor(nowMs) ^ Math.floor(nowMs / 4294967296)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  const start = h % candidates.length;
  return Array.from({ length: max }, (_, k) => candidates[(start + k) % candidates.length]);
}

async function collectQaRecheck(
  prs: readonly unknown[],
  prListReadOk: boolean,
  requiredContexts: Classified<ReadonlySet<string>>,
  host: PrGateDeps["host"],
  notes: string[],
  nowMs: number,
): Promise<Classified<readonly QaRecheckEntry[]>> {
  if (!prListReadOk) return { ok: false, reason: "pr-list-unreadable" };
  if (!requiredContexts.ok) return { ok: false, reason: "required-contexts-unreadable" };
  const candidates = qaRecheckCandidates(prs, requiredContexts.value);
  if (candidates.length === 0) return { ok: true, value: [] };
  if (host === undefined) return { ok: false, reason: "host-unavailable" };
  // Bounded: at most QA_RECHECK_MAX_PER_TURN scripts per turn in a ROTATING window
  // (no starvation), QA_RECHECK_CONCURRENCY at a time. Skipped PRs are omitted (fail closed) and named.
  const batch = rotateQaRecheckBatch(candidates, QA_RECHECK_MAX_PER_TURN, nowMs);
  if (candidates.length > batch.length) {
    const picked = new Set(batch.map((c) => c.pr));
    const skipped = candidates.filter((c) => !picked.has(c.pr)).map((c) => `#${c.pr}`);
    notes.push(
      `orch qa-verdict recheck capped at ${QA_RECHECK_MAX_PER_TURN} PR(s) this turn; skipped ${skipped.join(", ")} (rotates next turn; issue #5052)`,
    );
  }
  const results: (QaRecheckEntry | null)[] = new Array(batch.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batch.length) {
      const i = next++;
      const c = batch[i];
      try {
        results[i] = parseQaRecheckEntry(await host.runQaVerdictEvent(c.pr, c.tier), c.pr, c.tier);
      } catch (err) {
        /* intentional: surfaced as a stderr note; the PR's entry is omitted (fail closed), never the turn */
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`orch qa-verdict recheck host call threw for PR ${c.pr} (${msg}) - omitting entry (issue #5052)`);
        results[i] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(QA_RECHECK_CONCURRENCY, batch.length) }, () => worker()));
  const entries: QaRecheckEntry[] = [];
  results.forEach((entry, i) => {
    if (entry === null) {
      notes.push(`orch qa-verdict recheck produced no usable event for PR ${batch[i].pr} - omitting entry (issue #5052)`);
    } else {
      entries.push(entry);
    }
  });
  return { ok: true, value: entries };
}

/** The snapshot the CLI renders when the collector itself could not run (every field degraded). */
export function prGateFallbackSnapshot(reason: string): PrGateSnapshot {
  return {
    inflight: EMPTY_INFLIGHT,
    dirty: [],
    unchecked: [],
    behind: [],
    ciTriggerStale: { ok: false, reason },
    redResume: { ok: false, reason },
    devResumePick: { ok: false, reason },
    devResumeNoprPick: { ok: false, reason },
    dirtyFix: { ok: false, reason },
    qaVerdictRecheck: { ok: false, reason },
  };
}
