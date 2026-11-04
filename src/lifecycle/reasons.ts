/**
 * Lifecycle reason enums (ADR-0047 Decision 4, issue #5310).
 *
 * Closed vocabularies for the `--reason` argument of judgment transitions and
 * for the ADR-0005 operator escalation. Pure data; no I/O.
 */
import type { LifecycleState } from "./transitions.ts";

/** ADR-0005 operator-escalation enum. `-> ready-for-human` accepts only these. */
export const ADR5_REASONS = [
  "credentials",
  "external-account",
  "t4-deep-qa-exhausted",
  "vision-conflict",
] as const;
export type Adr5Reason = (typeof ADR5_REASONS)[number];

/**
 * Per-target reason lists for judgment transitions. A target absent from this
 * record is not a judgment target (no `--reason` required). Cap exhaustion
 * parks with `cap:<arm>`, so `parked` accepts the `cap:` prefix as well (see
 * {@link isAllowedReason}).
 */
export const TRIAGE_REASONS: Partial<Record<LifecycleState, readonly string[]>> = {
  "needs-info": ["missing-repro", "missing-acceptance", "ambiguous-scope", "awaiting-answer"],
  "needs-research": ["unknown-root-cause", "unknown-prior-art", "unknown-feasibility"],
  "hitl-grill": ["design-decision", "vision-question", "scope-negotiation"],
  "needs-tickets": ["plan-resolved", "epic-needs-slicing"],
  "needs-triage": ["rerouted", "needs-retriage"],
  "ready-for-agent": ["scoped", "unblocked", "research-complete", "grill-complete"],
  blocked: ["blocked-by-issue", "blocked-by-external"],
  parked: ["deferred", "off-list-escalation", "duplicate-candidate"],
  closed: ["completed", "not-planned"],
};

/** Reason prefix a cap exhaustion carries into `parked` (ADR-0047 D6). */
export const CAP_REASON_PREFIX = "cap:";

/** True when `reason` is a member of the closed list for `to`. */
export function isAllowedReason(to: LifecycleState, reason: string): boolean {
  if (
    to === "parked" &&
    reason.startsWith(CAP_REASON_PREFIX) &&
    reason.length > CAP_REASON_PREFIX.length
  ) {
    return true;
  }
  const list = TRIAGE_REASONS[to];
  return list !== undefined && list.includes(reason);
}

export function isAdr5Reason(reason: string): reason is Adr5Reason {
  return (ADR5_REASONS as readonly string[]).includes(reason);
}
