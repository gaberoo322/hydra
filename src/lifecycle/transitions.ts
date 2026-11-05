/**
 * Lifecycle state set + transition table (ADR-0047 Decisions 2-3, issue #5310).
 *
 * The table is DATA. Sources: #5286 (state set / table) as corrected by #5288
 * D5 (`qa-passed` exits split by cause). `human-hold -> *` rows never appear:
 * the seam refuses them before legality is consulted.
 */

export const LIFECYCLE_STATES = [
  "needs-triage",
  "needs-info",
  "needs-research",
  "hitl-grill",
  "needs-tickets",
  "ready-for-agent",
  "blocked",
  "in-progress",
  "needs-dev-resume",
  "needs-qa",
  "qa-passed",
  "ready-for-human",
  "parked",
  "closed",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/** The 13 states that exist as GitHub labels (everything except `closed`). */
export type OpenState = Exclude<LifecycleState, "closed">;
export const OPEN_STATES: readonly OpenState[] = LIFECYCLE_STATES.filter(
  (s): s is OpenState => s !== "closed",
);

/** Agents may enter these; only the operator exits them. */
export const HUMAN_HOLD_STATES = [
  "ready-for-human",
  "parked",
  "hitl-grill",
  "needs-info",
] as const;
export type HumanHoldState = (typeof HUMAN_HOLD_STATES)[number];

export function isLifecycleState(v: string): v is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(v);
}

export function isHumanHold(s: string): boolean {
  return (HUMAN_HOLD_STATES as readonly string[]).includes(s);
}

export type FiredBy = "dispatcher" | "worker" | "agent" | "reconcile" | "cap" | "operator";

/** Gate ids; implemented in gates.ts. `not-yet-implemented` refuses `gate-unimplemented`. */
export type GateId =
  | "none"
  | "judgment"
  | "adr5"
  | "dispatch"
  | "pr-open"
  | "close"
  | "research-exit"
  | "qa-exit"
  | "qa-verdict"
  | "not-yet-implemented";

export interface Transition {
  readonly from: Exclude<LifecycleState, HumanHoldState | "closed">;
  readonly to: LifecycleState;
  readonly firedBy: FiredBy;
  readonly gate: GateId;
}

function rows(
  from: Transition["from"],
  firedBy: FiredBy,
  gate: GateId,
  targets: readonly LifecycleState[],
): Transition[] {
  return targets.map((to) => ({ from, to, firedBy, gate }));
}

export const TRANSITIONS: readonly Transition[] = [
  // Triage routing is agent judgment: reason + rationale required.
  ...rows("needs-triage", "agent", "judgment", [
    "needs-info",
    "needs-research",
    "hitl-grill",
    "needs-tickets",
    "ready-for-agent",
    "blocked",
    "parked",
  ]),
  { from: "needs-triage", to: "ready-for-human", firedBy: "agent", gate: "adr5" },
  { from: "needs-triage", to: "closed", firedBy: "agent", gate: "close" },
  // Research exits need a Hydra-Research trailer (#5320).
  ...rows("needs-research", "agent", "research-exit", [
    "needs-triage",
    "needs-info",
    "hitl-grill",
    "needs-tickets",
    "ready-for-agent",
  ]),
  ...rows("needs-tickets", "agent", "judgment", ["ready-for-agent", "hitl-grill", "parked"]),
  { from: "needs-tickets", to: "closed", firedBy: "agent", gate: "close" },
  // Dispatch.
  { from: "ready-for-agent", to: "in-progress", firedBy: "dispatcher", gate: "dispatch" },
  ...rows("ready-for-agent", "agent", "judgment", ["blocked", "needs-triage", "parked"]),
  { from: "ready-for-agent", to: "ready-for-human", firedBy: "agent", gate: "adr5" },
  { from: "ready-for-agent", to: "closed", firedBy: "agent", gate: "close" },
  { from: "blocked", to: "ready-for-agent", firedBy: "reconcile", gate: "not-yet-implemented" },
  ...rows("blocked", "agent", "judgment", ["needs-triage", "parked"]),
  { from: "blocked", to: "closed", firedBy: "agent", gate: "close" },
  // Work in flight.
  { from: "in-progress", to: "needs-qa", firedBy: "reconcile", gate: "pr-open" },
  { from: "in-progress", to: "needs-dev-resume", firedBy: "reconcile", gate: "not-yet-implemented" },
  { from: "in-progress", to: "ready-for-agent", firedBy: "reconcile", gate: "not-yet-implemented" },
  { from: "in-progress", to: "parked", firedBy: "cap", gate: "judgment" },
  { from: "in-progress", to: "ready-for-human", firedBy: "agent", gate: "adr5" },
  { from: "in-progress", to: "blocked", firedBy: "agent", gate: "judgment" },
  { from: "in-progress", to: "closed", firedBy: "agent", gate: "close" },
  { from: "needs-dev-resume", to: "in-progress", firedBy: "dispatcher", gate: "dispatch" },
  { from: "needs-dev-resume", to: "parked", firedBy: "cap", gate: "judgment" },
  { from: "needs-dev-resume", to: "ready-for-agent", firedBy: "reconcile", gate: "not-yet-implemented" },
  { from: "needs-dev-resume", to: "ready-for-human", firedBy: "agent", gate: "adr5" },
  { from: "needs-dev-resume", to: "closed", firedBy: "agent", gate: "close" },
  // Review.
  { from: "needs-qa", to: "qa-passed", firedBy: "agent", gate: "qa-verdict" },
  { from: "needs-qa", to: "needs-dev-resume", firedBy: "agent", gate: "qa-verdict" },
  // FAIL with the PR already CLOSED (unmerged) is a fresh pick (#4766 INV-2).
  { from: "needs-qa", to: "ready-for-agent", firedBy: "agent", gate: "qa-verdict" },
  { from: "needs-qa", to: "parked", firedBy: "cap", gate: "judgment" },
  { from: "needs-qa", to: "ready-for-human", firedBy: "agent", gate: "adr5" },
  { from: "needs-qa", to: "closed", firedBy: "reconcile", gate: "close" },
  // qa-passed exits are reconcile-fired, split by cause (#5288 D5).
  { from: "qa-passed", to: "needs-dev-resume", firedBy: "reconcile", gate: "qa-exit" },
  { from: "qa-passed", to: "needs-qa", firedBy: "reconcile", gate: "qa-exit" },
  { from: "qa-passed", to: "closed", firedBy: "reconcile", gate: "close" },
  { from: "qa-passed", to: "ready-for-agent", firedBy: "reconcile", gate: "qa-exit" },
  { from: "qa-passed", to: "ready-for-human", firedBy: "agent", gate: "adr5" },
];

export function findTransition(from: LifecycleState, to: LifecycleState): Transition | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Pure lookup. `human-hold -> *` is never legal here (refused earlier). */
export function isLegalTransition(from: LifecycleState, to: LifecycleState): boolean {
  return findTransition(from, to) !== undefined;
}

/** State labels present in `labels`, in {@link OPEN_STATES} order. */
export function stateLabelsOf(labels: readonly string[]): OpenState[] {
  return OPEN_STATES.filter((s) => labels.includes(s));
}

// ---------------------------------------------------------------------------
// Operator-route legality (ADR-0047 Decision 3, issue #5313)
// ---------------------------------------------------------------------------

/**
 * The only states the board HTTP routes may move an issue INTO. Agent-owned
 * states (`in-progress`, `needs-qa`, `qa-passed`, `parked`, ...) are never set
 * by hand from the board.
 */
export const OPERATOR_TARGETS = [
  "needs-triage",
  "needs-info",
  "ready-for-human",
  "blocked",
  "ready-for-agent",
  "closed",
] as const;
export type OperatorTarget = (typeof OPERATOR_TARGETS)[number];

export interface OperatorTransition {
  readonly from: OpenState;
  readonly to: OperatorTarget;
  readonly firedBy: "operator";
  readonly gate: "none";
}

/**
 * The operator's table, generated: every open state (human-hold included) x
 * every {@link OPERATOR_TARGETS} entry except a self-move. A SEPARATE table
 * from {@link TRANSITIONS}, whose "no human-hold-from rows" guarantee stays
 * intact; the operator's click is the judgment, so every row is gate-free.
 */
export const OPERATOR_TRANSITIONS: readonly OperatorTransition[] = OPERATOR_TARGETS.flatMap(
  (to) =>
    OPEN_STATES.filter((from) => from !== to).map(
      (from): OperatorTransition => ({ from, to, firedBy: "operator", gate: "none" }),
    ),
);

export function isOperatorTarget(v: string): v is OperatorTarget {
  return (OPERATOR_TARGETS as readonly string[]).includes(v);
}

export function findOperatorTransition(
  from: OpenState,
  to: LifecycleState,
): OperatorTransition | undefined {
  return OPERATOR_TRANSITIONS.find((t) => t.from === from && t.to === to);
}
