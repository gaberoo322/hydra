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
 *   - the required-contexts + needs-dev-resume reads feed the glm-red
 *     forward-fix and the dev-resume pick — fail-CLOSED (INV-5).
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
 *   glm-red          GLM-provenance, quiescent, exactly one closing issue, no
 *                    required check pending, and a required check red OR the
 *                    issue labelled needs-dev-resume (#4460 INV-3).
 *   dev-resume pick  the same minus GLM provenance, gated on needs-dev-resume (#4518).
 *   dirty fix-forward  pin / surface / wait split of the dirty bucket (#4807).
 *
 * Reference detection reuses src/github/pr-refs.ts (the TS port of
 * pr-refs.py) — no third regex copy. Never throws: every read failure is a
 * `DegradedMarker` plus the verbatim stderr note the bash printed.
 */

import { closedIssues, referencedIssues, type PrRefRow } from "../../github/pr-refs.ts";
import type { Classified, CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { GhJsonRead, TurnSnapshotGithub } from "./github-port.ts";
import { pyEpochSeconds, pyFloatOr, pyJsonLoads, pyStr, pyTruthy } from "./py-compat.ts";

export const PR_GATE_COLLECTOR = "pr-gate";

/** `<anchor>:<pr>:<headRefName>` — a pinned dispatch target. */
export interface PrPick {
  readonly issue: number;
  readonly pr: number;
  readonly headRefName: string;
}

/** One dirty PR to surface to the operator this turn (`<pr>:<closingIssue|none>`). */
export interface DirtySurfaceEntry {
  readonly pr: number;
  readonly closingIssue: number | null;
}

/** The three in-flight reference sets (sorted ascending). */
export interface InflightRefs {
  readonly union: readonly number[];
  readonly branch: readonly number[];
  readonly body: readonly number[];
}

export interface PrGateSnapshot {
  readonly inflight: InflightRefs;
  readonly dirty: readonly number[];
  readonly unchecked: readonly number[];
  readonly behind: readonly number[];
  /** Fail-open: degraded → rendered `false`. */
  readonly ciTriggerStale: Classified<boolean>;
  /** Fail-closed: degraded → empty bucket + `none`. */
  readonly glmRed: Classified<{ readonly bucket: readonly number[]; readonly pick: PrPick | null }>;
  /** Fail-closed: degraded → `none`. */
  readonly devResumePick: Classified<PrPick | null>;
  /** Fail-closed: degraded → `none` + empty surface. */
  readonly dirtyFix: Classified<{ readonly pick: PrPick | null; readonly surface: readonly DirtySurfaceEntry[] }>;
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

function labelsOf(pr: Row): Set<unknown> {
  const out = new Set<unknown>();
  const labels = pr.labels;
  if (!Array.isArray(labels)) return out;
  for (const l of labels) {
    const name = asRow(l)?.name;
    if (pyTruthy(name)) out.add(name);
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
  return pyTruthy(v) ? v : "";
}

function upper(v: unknown): string {
  return pyTruthy(v) ? String(v).toUpperCase() : "";
}

const ascending = (a: number, b: number) => a - b;

function isGlmProvenance(names: Set<unknown>, head: unknown): boolean {
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
    const reason =
      repoll.kind === "empty"
        ? (pyJsonLoads("") as { error: string }).error
        : repoll.kind === "unparseable"
          ? repoll.error
          : "not a list";
    const unknown = first
      .map(asRow)
      .filter((p): p is Row => p !== null && p.mergeStateStatus === "UNKNOWN")
      .map((p) => pyStr(p.number));
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
    if (pyTruthy(next) && next !== "UNKNOWN") {
      rows.push({ ...p, mergeStateStatus: next });
      resolved.push(`${pyStr(p.number)}=${pyStr(next)}`);
    } else {
      rows.push(raw);
      still.push(pyStr(p.number));
    }
  }
  return { kind: "merged", rows, resolved, still };
}

// ---------------------------------------------------------------------------
// In-flight reference sets (pure)
// ---------------------------------------------------------------------------

export const EMPTY_INFLIGHT: InflightRefs = { union: [], branch: [], body: [] };

/** The three in-flight sets over the (re-polled) open-PR payload; unavailable predicates → empty. */
export function inflightRefs(prs: readonly unknown[], prRefs: PrRefsAvailability): InflightRefs {
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
export const BEHIND_QUIESCENCE_SECONDS = 5400;
/** Attempted-and-quiescent dirty surface window (seconds, #4807). */
export const DIRTY_ATTEMPTED_SURFACE_SECONDS = 5400;
export const DEFAULT_UNCHECKED_GRACE_SECONDS = 600;
export const DEFAULT_GLM_RED_QUIESCENCE_SECONDS = 1800;

export interface PrGateInputs {
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
}

const RED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

/**
 * De-duplicate rollup entries by check name KEEPING THE LATEST (greatest
 * startedAt; ties → later list index). CheckRun rows key on `name`,
 * StatusContext rows on `context`. CANCELLED is never red (#4460 INV-4).
 */
export function rollupLatest(rollup: readonly unknown[]): Map<string, { pending: boolean; red: boolean }> {
  const latest = new Map<string, { started: number; pending: boolean; red: boolean }>();
  rollup.forEach((raw) => {
    const e = asRow(raw);
    if (e === null) return;
    const name = pyTruthy(e.name) ? e.name : pyTruthy(e.context) ? e.context : "";
    if (!pyTruthy(name)) return;
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
    const started = pyEpochSeconds(e.startedAt) || 0;
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

/** Classify every open PR. Returns the snapshot fields (minus in-flight) plus the classifier's stderr notes. */
export function classifyPrGate(inputs: PrGateInputs): { value: Omit<PrGateSnapshot, "inflight">; notes: string[] } {
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
    const created = pyEpochSeconds(pr.createdAt);
    const updated = pyEpochSeconds(pr.updatedAt);
    const draft = pyTruthy(pr.isDraft);
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
    const push = pyEpochSeconds(inputs.runsPushCreatedAt);
    const prRun = pyEpochSeconds(inputs.runsPullRequestCreatedAt);
    if (push !== null && prRun !== null && unchecked.length > 0) {
      const newest = Math.max(push, prRun);
      for (const n of unchecked) {
        const pr = prs.find((p) => p.number === n);
        const created = pyEpochSeconds(pr?.createdAt);
        if (created !== null && created > newest) {
          stale = true;
          break;
        }
      }
    }
    ciTriggerStale = { ok: true, value: stale };
  }

  // glm-red forward-fix (#4460) — fail closed on any unavailable input (INV-5).
  const req = inputs.requiredContexts;
  const resume = inputs.devResumeIssues;
  const refs = inputs.prRefs;
  let glmRed: PrGateSnapshot["glmRed"];
  let devResumePick: PrGateSnapshot["devResumePick"];
  if (!req.ok || !resume.ok || !refs.ok) {
    const reason = "required-contexts / needs-dev-resume / pr-refs input unavailable";
    notes.push(`orch glm-red classifier fail-closed (${reason}) — issue #4460 INV-5`);
    glmRed = { ok: false, reason };
    devResumePick = { ok: false, reason };
  } else {
    const closingOf = (pr: Row, number: number, issueRef: string, failNote: string): ReadonlySet<number> | null => {
      try {
        return refs.predicates.closing([refRow(pr)]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`orch ${issueRef} closing_issues() failed for PR ${number} (${msg}) — ${failNote}`);
        return null;
      }
    };

    const bucket: number[] = [];
    let pick: PrPick | null = null;
    for (const pr of prs) {
      const number = pr.number;
      if (typeof number !== "number") continue;
      const names = labelsOf(pr);
      const head = orEmpty(pr.headRefName);
      if (!isGlmProvenance(names, head)) continue;
      if (pyTruthy(pr.isDraft) || names.has("ready-for-human")) continue;
      const state = orEmpty(pr.mergeStateStatus);
      if (state === "DIRTY" || state === "UNKNOWN") continue;
      const updated = pyEpochSeconds(pr.updatedAt);
      if (updated === null || now - updated < quiet) continue;
      const closed = closingOf(pr, number, "glm-red", "skipping PR (issue #4460)");
      if (closed === null || closed.size !== 1) continue;
      const issue = [...closed][0];
      const verdict = requiredVerdict(pr.statusCheckRollup, req.value);
      if (verdict === null) continue;
      if (!(verdict.red || resume.value.has(issue))) continue;
      bucket.push(number);
      if (pick === null || number < pick.pr) pick = { issue, pr: number, headRefName: String(head) };
    }
    glmRed = { ok: true, value: { bucket: bucket.sort(ascending), pick } };

    // Claude-lane durable dev resume pick (#4518): glm-red minus GLM provenance.
    let resumePick: PrPick | null = null;
    for (const pr of prs) {
      const number = pr.number;
      if (typeof number !== "number") continue;
      const names = labelsOf(pr);
      const head = orEmpty(pr.headRefName);
      if (!pyTruthy(head) || String(head).includes(":")) continue;
      if (isGlmProvenance(names, head)) continue;
      if (pyTruthy(pr.isDraft) || names.has("ready-for-human")) continue;
      const state = orEmpty(pr.mergeStateStatus);
      if (state === "DIRTY" || state === "UNKNOWN") continue;
      const updated = pyEpochSeconds(pr.updatedAt);
      if (updated === null || now - updated < quiet) continue;
      const closed = closingOf(pr, number, "dev-resume", "skipping PR (issue #4518)");
      if (closed === null || closed.size !== 1) continue;
      const issue = [...closed][0];
      if (!resume.value.has(issue)) continue;
      if (requiredVerdict(pr.statusCheckRollup, req.value) === null) continue;
      if (resumePick === null || number < resumePick.pr) resumePick = { issue, pr: number, headRefName: String(head) };
    }
    devResumePick = { ok: true, value: resumePick };
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
      const updated = pyEpochSeconds(pr.updatedAt);
      let closed: number[];
      try {
        closed = [...refs.predicates.closing([refRow(pr)])];
      } catch (err) {
        // An unparseable body can never be pinned: surface it (a terminal wait strands the PR).
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`orch dirty-fix closing_issues() failed for PR ${number} (${msg}) — surfacing (issue #4807)`);
        closed = [];
      }
      const single = closed.length === 1 ? closed[0] : null;
      const age = updated !== null ? now - updated : null;
      if (!names.has("conflict-fix-attempted")) {
        const head = orEmpty(pr.headRefName);
        if (single === null || !pyTruthy(head) || String(head).includes(":")) {
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

  return {
    value: {
      dirty: dirty.sort(ascending),
      unchecked: unchecked.sort(ascending),
      behind: behind.sort(ascending),
      ciTriggerStale,
      glmRed,
      devResumePick,
      dirtyFix,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Input parsers (pure) — the JSON-vs-empty discipline of #4130
// ---------------------------------------------------------------------------

/** Branch protection `.contexts`: list → the truthy entries as strings; null/other JSON → healthy empty set. */
export function parseRequiredContexts(read: GhJsonRead): Classified<ReadonlySet<string>> {
  if (read.kind === "empty") return { ok: false, reason: "empty-payload" };
  if (read.kind === "unparseable") return { ok: false, reason: "unparseable" };
  if (!Array.isArray(read.data)) return { ok: true, value: new Set() };
  return { ok: true, value: new Set(read.data.filter(pyTruthy).map(pyStr)) };
}

/** `[{"number": N}, …]` → the issue numbers. A non-iterable JSON value is a failed read (Python's TypeError). */
export function parseDevResumeIssues(read: GhJsonRead): Classified<ReadonlySet<number>> {
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

// ---------------------------------------------------------------------------
// The collector (orchestration over injected deps)
// ---------------------------------------------------------------------------

/** Raw env-window strings (the bash read them from HYDRA_ORCH_*; unset/empty = default). */
export interface PrGateEnv {
  readonly uncheckedGraceSeconds?: string;
  readonly glmRedQuiescenceSeconds?: string;
  readonly unknownRepollDelaySeconds?: string;
}

export interface PrGateDeps {
  readonly github: TurnSnapshotGithub;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep: (seconds: number) => Promise<void>;
  /** `gh … --limit` page size (collect-state.sh's GH_ISSUE_LIST_LIMIT). */
  readonly ghListLimit: number;
  readonly env?: PrGateEnv;
  /** Defaults to the src/github/pr-refs.ts predicates. */
  readonly prRefs?: PrRefsAvailability;
}

const DEFAULT_REPOLL_DELAY = "5";

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
    notes.push(`orch pr-gate UNKNOWN probe could not parse first payload (${first.error}) — skipping re-poll (issue #4812)`);
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

  // 3. The glm-red / dev-resume inputs — fail CLOSED (INV-5).
  const requiredRead = await deps.github.requiredStatusContexts();
  if (requiredRead.kind === "empty") {
    notes.push(
      "orch glm-red required-contexts read FAILED (empty payload) — orch_prs_glm_red/orch_glm_red_forward_fix fail closed to none (issue #4460, INV-5)",
    );
  }
  const resumeRead = await deps.github.openIssueNumbersByLabel("needs-dev-resume", limit);
  if (resumeRead.kind === "empty") {
    notes.push(
      "orch glm-red needs-dev-resume issue read FAILED (empty payload) — orch_prs_glm_red/orch_glm_red_forward_fix fail closed to none (issue #4460, INV-5)",
    );
  }

  // 4. Classification inputs (the old heredoc's own preamble notes).
  if (payload.kind !== "ok") {
    const error = payload.kind === "unparseable" ? payload.error : (pyJsonLoads("") as { error: string }).error;
    notes.push(`orch pr-gate PR-list JSON parse FAILED (${error}) — falling back to empty PR list (issue #4240)`);
    degraded.push({ field: "prList", reason: payload.kind === "empty" ? "empty-payload" : "unparseable" });
  }
  const grace = pyFloatOr(env.uncheckedGraceSeconds || String(DEFAULT_UNCHECKED_GRACE_SECONDS), DEFAULT_UNCHECKED_GRACE_SECONDS);
  if (grace.error !== null) {
    notes.push(
      `orch pr-gate ORCH_PR_UNCHECKED_GRACE_SECONDS unparsable (${grace.error}) — falling back to 600s default (issue #4240)`,
    );
  }
  if (!prRefs.ok) {
    notes.push(`orch glm-red pr-refs.py import FAILED (${prRefs.error}) — fail closed (issue #4460)`);
    degraded.push({ field: "prRefs", reason: "predicate-unavailable" });
  }
  const quiet = pyFloatOr(
    env.glmRedQuiescenceSeconds || String(DEFAULT_GLM_RED_QUIESCENCE_SECONDS),
    DEFAULT_GLM_RED_QUIESCENCE_SECONDS,
  );
  if (quiet.error !== null) {
    notes.push(
      `orch glm-red ORCH_GLM_RED_QUIESCENCE_SECONDS unparsable (${quiet.error}) — falling back to 1800s default (issue #4460)`,
    );
  }

  const requiredContexts = parseRequiredContexts(requiredRead);
  const devResumeIssues = parseDevResumeIssues(resumeRead);
  if (!requiredContexts.ok) degraded.push({ field: "requiredContexts", reason: requiredContexts.reason });
  if (!devResumeIssues.ok) degraded.push({ field: "devResumeIssues", reason: devResumeIssues.reason });

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
  });
  notes.push(...classified.notes);

  return {
    collector: PR_GATE_COLLECTOR,
    value: { inflight, ...classified.value },
    degraded,
    notes,
  };
}

/** The snapshot the CLI renders when the collector itself could not run (every field degraded). */
export function prGateFallbackSnapshot(reason: string): PrGateSnapshot {
  return {
    inflight: EMPTY_INFLIGHT,
    dirty: [],
    unchecked: [],
    behind: [],
    ciTriggerStale: { ok: false, reason },
    glmRed: { ok: false, reason },
    devResumePick: { ok: false, reason },
    dirtyFix: { ok: false, reason },
  };
}
