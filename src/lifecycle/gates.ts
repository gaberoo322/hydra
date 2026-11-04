/**
 * Pure per-transition gate predicates (ADR-0047 Decision 4, issue #5310).
 *
 * The `evaluateQaMergeGuard` shape: every predicate takes ALREADY-FETCHED
 * records plus evidence and returns `{ok, code}`. No fs / network / Redis in
 * this file; the fetchers live in `seam.ts` behind an injectable `deps.fetch`.
 * A failed fetch is a refusal (`fetch-failed`), never a pass.
 */
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

export interface GateRecords {
  designConcept?: Fetched<DesignConceptRecord>;
  pr?: Fetched<PrRecord>;
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

/** Which fetches a gate needs; the seam runs exactly these. */
export function recordsNeeded(gate: GateId): { designConcept: boolean; pr: boolean } {
  return {
    designConcept: gate === "dispatch",
    pr: gate === "pr-open" || gate === "close",
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
    case "not-yet-implemented":
      return fail("gate-unimplemented");
  }
}
