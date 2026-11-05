/**
 * Pure per-transition gate predicates (ADR-0047 Decision 4, issue #5310).
 *
 * The `evaluateQaMergeGuard` shape: every predicate takes ALREADY-FETCHED
 * records plus evidence and returns `{ok, code}`. No fs / network / Redis in
 * this file; the fetchers live in `seam.ts` behind an injectable `deps.fetch`.
 * A failed fetch is a refusal (`fetch-failed`), never a pass.
 */
import { hasScopeSection } from "../scope-section.ts";
import { isFailVerdict, isPassVerdict, parseQaVerdictTrailers, qaVerdictShaMatches, type FinalVerdict } from "../qa/verdict-trailer.ts";
import { isAdr5Reason, isAllowedReason } from "./reasons.ts";
import type { GateId, LifecycleState } from "./transitions.ts";

export type GateResult = { ok: true; code: string } | { ok: false; code: string };

/** A record the seam tried to fetch. `ok:false` means the fetch failed. */
export type Fetched<T> = { ok: true; value: T } | { ok: false };

export interface DesignConceptRecord {
  /** False when no artifact exists for the anchor. */
  exists: boolean;
  /** `draft | approved | stale` as stored on the artifact. */
  status: string;
}

export interface PrRecord {
  number: number;
  /** Upper-cased `OPEN | MERGED | CLOSED`. */
  state: string;
  body: string;
}

/** A GitHub issue comment, bound to its repo + issue via the REST `issue_url`. */
export interface CommentRecord {
  id: number;
  /** `owner/name`, derived from the comment's `issue_url`. */
  repo: string;
  issue: number;
  /** GitHub server `created_at` (never `updated_at`), epoch ms. */
  createdAtMs: number;
  body: string;
}

/** When the issue last entered a state (latest `labeled` event); null = never seen. */
export interface StateEntryRecord {
  enteredAtMs: number | null;
}

/**
 * A PR read live at head for the `qa-passed` exit decision (ADR-0047 D4). The
 * fetcher folds the required-check rollup to `checks`; `bodies` are the PR's
 * comment then review bodies (they carry the `QA-Verdict:` trailers).
 */
export interface QaLivePr {
  number: number;
  /** Upper-cased `OPEN | MERGED | CLOSED`. */
  state: string;
  isDraft: boolean;
  /** Upper-cased GitHub `mergeStateStatus` (`DIRTY`, `CLEAN`, `UNKNOWN`, ...). */
  mergeStateStatus: string;
  headSha: string;
  /** Required checks folded: `unknown` when they could not be read. */
  checks: "red" | "green" | "pending" | "unknown";
  bodies: readonly string[];
  /**
   * The same comment + review bodies with their post time (epoch ms; null when
   * unreadable). Absent = no timed record, so the `qa-verdict` gate refuses.
   */
  timedBodies?: readonly { body: string; createdAtMs: number | null }[];
}

export type QaExitTarget = "closed" | "ready-for-agent" | "needs-dev-resume" | "needs-qa";

/**
 * The ONE pure predicate for a `qa-passed` exit (ADR-0047 D4, #5316 INV-3):
 * the reconcile uses it to CHOOSE the target and the `qa-exit` gate uses it to
 * VERIFY the requested one. Decision order is fixed: MERGED -> closed; CLOSED
 * unmerged -> ready-for-agent; draft -> none; DIRTY -> needs-dev-resume;
 * settled-red required checks -> needs-dev-resume; settled-green with no PASS
 * trailer matching the head sha -> needs-qa; otherwise none.
 */
export function classifyQaPassedExit(live: QaLivePr): QaExitTarget | "none" {
  if (live.state === "MERGED") return "closed";
  if (live.state === "CLOSED") return "ready-for-agent";
  if (live.state !== "OPEN" || live.isDraft) return "none";
  if (live.mergeStateStatus === "DIRTY") return "needs-dev-resume";
  if (live.checks === "red") return "needs-dev-resume";
  if (live.checks === "green") {
    const passAtHead = live.bodies.some((b) =>
      parseQaVerdictTrailers(b).some(
        (t) => isPassVerdict(t.verdict) && t.pr === live.number && qaVerdictShaMatches(t, live.headSha),
      ),
    );
    return passAtHead ? "none" : "needs-qa";
  }
  return "none";
}

export type QaVerdictTarget = "qa-passed" | "needs-dev-resume" | "ready-for-agent";

/**
 * The ONE pure predicate for a `needs-qa` verdict exit (ADR-0047 D4, #5317
 * INV-3). The verdict record is the LATEST `QA-Verdict:` trailer naming this
 * PR whose `sha=` matches the live head. Returns the routing target, or a
 * refusal code: `qa-verdict-missing` (no trailer at head), `qa-verdict-stale`
 * (the trailer predates `enteredAtMs`), `pr-merged` (reconcile owns it).
 */
export function classifyQaVerdictTarget(
  live: QaLivePr,
  enteredAtMs: number,
): { ok: true; target: QaVerdictTarget } | { ok: false; code: string } {
  // INV-3: the LATEST trailer is the one with the max post time (NOT array
  // order: comments are listed before reviews, so a stale review-body trailer
  // would otherwise override a newer comment trailer). Ties keep the later
  // array position; an unreadable time sorts oldest.
  let latest: { verdict: FinalVerdict; createdAtMs: number | null } | undefined;
  const rank = (ms: number | null): number => (ms === null ? Number.NEGATIVE_INFINITY : ms);
  for (const tb of live.timedBodies ?? []) {
    for (const t of parseQaVerdictTrailers(tb.body)) {
      if (t.pr === live.number && qaVerdictShaMatches(t, live.headSha)) {
        if (latest === undefined || rank(tb.createdAtMs) >= rank(latest.createdAtMs)) {
          latest = { verdict: t.verdict, createdAtMs: tb.createdAtMs };
        }
      }
    }
  }
  if (latest === undefined) return { ok: false, code: "qa-verdict-missing" };
  if (latest.createdAtMs === null || !(latest.createdAtMs > enteredAtMs)) {
    return { ok: false, code: "qa-verdict-stale" };
  }
  if (live.state === "MERGED") return { ok: false, code: "pr-merged" };
  if (isPassVerdict(latest.verdict)) {
    return live.state === "OPEN" ? { ok: true, target: "qa-passed" } : { ok: false, code: "pr-not-open" };
  }
  if (!isFailVerdict(latest.verdict)) return { ok: false, code: "qa-verdict-missing" };
  if (live.state === "OPEN") return { ok: true, target: "needs-dev-resume" };
  if (live.state === "CLOSED") return { ok: true, target: "ready-for-agent" };
  return { ok: false, code: "pr-not-open" };
}

export interface GateRecords {
  qaLive?: Fetched<QaLivePr>;
  designConcept?: Fetched<DesignConceptRecord>;
  pr?: Fetched<PrRecord>;
  comment?: Fetched<CommentRecord>;
  stateEntry?: Fetched<StateEntryRecord>;
}

export interface GateInput {
  issue: number;
  from: LifecycleState;
  to: LifecycleState;
  /** Non-state labels on the issue (flags). */
  flags: readonly string[];
  evidence: Readonly<Record<string, string>>;
  reason?: string;
  rationale?: string;
  /** `completed | not planned` when `to === "closed"`. */
  closeReason?: string;
  /** `owner/name` the seam operates on (record binding). */
  repo?: string;
  /** Issue body as re-read by the seam (spine step 1). */
  body?: string;
}

const pass = (code = "ok"): GateResult => ({ ok: true, code });
const fail = (code: string): GateResult => ({ ok: false, code });

/** Judgment transitions: closed `--reason` list for the target + non-empty rationale. */
export function gateJudgment(input: GateInput): GateResult {
  if (!input.reason) return fail("reason-required");
  if (!isAllowedReason(input.to, input.reason)) return fail("reason-not-allowed");
  if (!input.rationale || input.rationale.trim().length === 0) return fail("rationale-required");
  return pass();
}

/** `-> ready-for-human` accepts only the ADR-0005 enum. */
export function gateAdr5(input: GateInput): GateResult {
  if (!input.reason) return fail("reason-required");
  if (!isAdr5Reason(input.reason)) return fail("reason-not-allowed");
  if (!input.rationale || input.rationale.trim().length === 0) return fail("rationale-required");
  return pass();
}

export const DESIGN_CONCEPT_FLAG = "needs-design-concept";

/**
 * Dispatch (`ready-for-agent|needs-dev-resume -> in-progress`). When the issue
 * carries the `needs-design-concept` flag a fresh `approved` artifact must
 * exist; otherwise the gate passes. Fails closed on a fetch miss.
 */
export function gateDispatch(input: GateInput, records: GateRecords): GateResult {
  if (!input.flags.includes(DESIGN_CONCEPT_FLAG)) return pass();
  const dc = records.designConcept;
  if (dc === undefined || dc.ok === false) return fail("design-concept-fetch-failed");
  if (!dc.value.exists) return fail("design-concept-missing");
  if (dc.value.status === "stale") return fail("design-concept-expired");
  if (dc.value.status !== "approved") return fail("design-concept-draft");
  return pass();
}

export function parsePrEvidence(evidence: Readonly<Record<string, string>>): number | null {
  const raw = evidence.pr;
  if (raw === undefined) return null;
  const m = /^#?(\d+)$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/** True when the PR body carries a closing reference to `issue`. */
export function bodyClosesIssue(body: string, issue: number): boolean {
  const re = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, "i");
  return re.test(body);
}

/** `in-progress -> needs-qa`: evidence `pr=N` must be an OPEN PR closing the issue. */
export function gatePrOpen(input: GateInput, records: GateRecords): GateResult {
  const prNumber = parsePrEvidence(input.evidence);
  if (prNumber === null) return fail("evidence-required:pr");
  const pr = records.pr;
  if (pr === undefined || pr.ok === false) return fail("fetch-failed");
  if (pr.value.number !== prNumber) return fail("record-binding-mismatch");
  if (pr.value.state !== "OPEN") return fail("pr-not-open");
  if (!bodyClosesIssue(pr.value.body, input.issue)) return fail("pr-does-not-close-issue");
  return pass();
}

/**
 * `-> closed`. `completed` needs a MERGED PR (evidence `pr=N`) closing the
 * issue; `not planned` needs a named superseding issue or PR
 * (`superseded-by=#N`), per ADR-0047 D2.
 */
export function gateClose(input: GateInput, records: GateRecords): GateResult {
  if (input.closeReason === "not planned") {
    const ref = input.evidence["superseded-by"];
    if (ref === undefined || !/^#?\d+$/.test(ref.trim())) return fail("evidence-required:superseded-by");
    return pass();
  }
  if (input.closeReason !== undefined && input.closeReason !== "completed") {
    return fail("close-reason-not-allowed");
  }
  const prNumber = parsePrEvidence(input.evidence);
  if (prNumber === null) return fail("evidence-required:pr");
  const pr = records.pr;
  if (pr === undefined || pr.ok === false) return fail("fetch-failed");
  if (pr.value.number !== prNumber) return fail("record-binding-mismatch");
  if (pr.value.state !== "MERGED") return fail("pr-not-merged");
  if (!bodyClosesIssue(pr.value.body, input.issue)) return fail("pr-does-not-close-issue");
  return pass();
}

/**
 * `qa-passed -> needs-dev-resume | needs-qa | ready-for-agent`: evidence `pr=N`
 * must be re-read live at head and {@link classifyQaPassedExit} must name the
 * requested target. Fails closed on a fetch miss.
 */
export function gateQaExit(input: GateInput, records: GateRecords): GateResult {
  const prNumber = parsePrEvidence(input.evidence);
  if (prNumber === null) return fail("evidence-required:pr");
  const live = records.qaLive;
  if (live === undefined || live.ok === false) return fail("fetch-failed");
  if (live.value.number !== prNumber) return fail("record-binding-mismatch");
  return classifyQaPassedExit(live.value) === input.to ? pass() : fail("qa-exit-cause-mismatch");
}

/**
 * `needs-qa -> qa-passed | needs-dev-resume | ready-for-agent`: evidence `pr=N`
 * is a locator; the verdict record is the live trailer at head posted after the
 * issue entered `needs-qa`, and its classified target must equal `to`.
 */
export function gateQaVerdict(input: GateInput, records: GateRecords): GateResult {
  const prNumber = parsePrEvidence(input.evidence);
  if (prNumber === null) return fail("evidence-required:pr");
  const live = records.qaLive;
  const entry = records.stateEntry;
  if (live === undefined || live.ok === false) return fail("fetch-failed");
  if (entry === undefined || entry.ok === false) return fail("fetch-failed");
  if (live.value.number !== prNumber) return fail("record-binding-mismatch");
  // Defer arm (hydra-qa step 6.6): no verdict was emitted, so there is no
  // trailer to gate on. `defer=1` evidence admits ONLY the live-state bounce
  // (OPEN -> needs-dev-resume, CLOSED -> ready-for-agent); never qa-passed.
  if (input.evidence.defer === "1") {
    const deferTarget =
      live.value.state === "OPEN" ? "needs-dev-resume" : live.value.state === "CLOSED" ? "ready-for-agent" : null;
    if (deferTarget === null) return fail("pr-merged");
    return deferTarget === input.to ? pass() : fail("qa-verdict-mismatch");
  }
  if (entry.value.enteredAtMs === null) return fail("state-entry-unknown");
  const c = classifyQaVerdictTarget(live.value, entry.value.enteredAtMs);
  if (c.ok === false) return fail(c.code);
  return c.target === input.to ? pass() : fail("qa-verdict-mismatch");
}

export const RESEARCH_TRAILER_PREFIX = "Hydra-Research:";

export type ResearchTrailer =
  | { kind: "ok"; issue: number; next: string }
  | { kind: "missing" | "malformed" | "ambiguous" };

/**
 * Parse the `Hydra-Research: issue=<N> next=<state>` trailer (ADR-0047 D4).
 * Line-anchored, trailing whitespace tolerated; pure, never throws.
 */
export function parseResearchTrailer(body: string): ResearchTrailer {
  const prefixed = body.split(/\r?\n/).filter((l) => l.startsWith(RESEARCH_TRAILER_PREFIX));
  if (prefixed.length === 0) return { kind: "missing" };
  if (prefixed.length > 1) return { kind: "ambiguous" };
  const m = /^Hydra-Research: issue=(\d+) next=([a-z][a-z-]*)\s*$/.exec(prefixed[0]);
  return m ? { kind: "ok", issue: Number(m[1]), next: m[2] } : { kind: "malformed" };
}

/** `comment=<url ending #issuecomment-<id> | bare numeric id>` -> comment id. */
export function parseCommentEvidence(evidence: Readonly<Record<string, string>>): number | null {
  const raw = evidence.comment;
  if (raw === undefined) return null;
  const m = /^(?:\d+|https?:\/\/\S+#issuecomment-(\d+))$/.exec(raw.trim());
  if (!m) return null;
  const id = Number(m[1] ?? raw.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * `needs-research -> *`. Composes {@link gateJudgment} FIRST (its codes win),
 * then requires a `Hydra-Research:` trailer comment, bound to this repo+issue,
 * created strictly after the issue entered `needs-research`. `-> ready-for-agent`
 * also requires a `## Files in scope` section on the re-read body.
 */
export function gateResearchExit(input: GateInput, records: GateRecords): GateResult {
  const judged = gateJudgment(input);
  if (!judged.ok) return judged;
  if (parseCommentEvidence(input.evidence) === null) return fail("evidence-required:comment");
  const comment = records.comment;
  const entry = records.stateEntry;
  if (comment === undefined || comment.ok === false) return fail("fetch-failed");
  if (entry === undefined || entry.ok === false) return fail("fetch-failed");
  const c = comment.value;
  if (input.repo === undefined || c.repo.toLowerCase() !== input.repo.toLowerCase() || c.issue !== input.issue) {
    return fail("record-binding-mismatch");
  }
  const trailer = parseResearchTrailer(c.body);
  if (trailer.kind !== "ok") return fail(`research-trailer-${trailer.kind}`);
  if (trailer.issue !== input.issue) return fail("record-binding-mismatch");
  if (trailer.next !== input.to) return fail("research-trailer-next-mismatch");
  if (entry.value.enteredAtMs === null) return fail("state-entry-unknown");
  if (!(c.createdAtMs > entry.value.enteredAtMs)) return fail("research-trailer-stale");
  if (input.to === "ready-for-agent" && !hasScopeSection(input.body ?? "")) {
    return fail("scope-section-missing");
  }
  return pass();
}

/** Which fetches a gate needs; the seam runs exactly these. */
export function recordsNeeded(gate: GateId): {
  designConcept: boolean;
  pr: boolean;
  comment: boolean;
  stateEntry: boolean;
  qaLive: boolean;
} {
  return {
    qaLive: gate === "qa-exit" || gate === "qa-verdict",
    designConcept: gate === "dispatch",
    pr: gate === "pr-open" || gate === "close",
    comment: gate === "research-exit",
    stateEntry: gate === "research-exit" || gate === "qa-verdict",
  };
}

/** Dispatch on gate id. Pure. */
export function evaluateGate(gate: GateId, input: GateInput, records: GateRecords): GateResult {
  switch (gate) {
    case "none":
      return pass();
    case "judgment":
      return gateJudgment(input);
    case "adr5":
      return gateAdr5(input);
    case "dispatch":
      return gateDispatch(input, records);
    case "pr-open":
      return gatePrOpen(input, records);
    case "close":
      return gateClose(input, records);
    case "research-exit":
      return gateResearchExit(input, records);
    case "qa-exit":
      return gateQaExit(input, records);
    case "qa-verdict":
      return gateQaVerdict(input, records);
    case "not-yet-implemented":
      return fail("gate-unimplemented");
  }
}
