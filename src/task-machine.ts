/**
 * Pure Task state machine — no Redis, no I/O.
 *
 * Defines the 9 states, all valid transitions as data, and a single
 * `transition()` function that returns the next state or a rejection reason.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskState =
  | "proposed"
  | "approved"
  | "in-progress"
  | "changed-code"
  | "verified"
  | "blocked"
  | "merged"
  | "failed"
  | "abandoned";

export type TaskEvent =
  | "approve"
  | "start"
  | "change-code"
  | "verify"
  | "merge"
  | "fail"
  | "abandon"
  | "block"
  | "unblock";

export type TransitionOk = { ok: true; state: TaskState };
export type TransitionErr = { ok: false; reason: string };
export type TransitionResult = TransitionOk | TransitionErr;

// ---------------------------------------------------------------------------
// Transition table — every valid (state, event) → nextState
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<string, TaskState> = {
  "proposed:approve":        "approved",
  "proposed:abandon":        "abandoned",
  "approved:start":          "in-progress",
  "approved:abandon":        "abandoned",
  "in-progress:change-code": "changed-code",
  "in-progress:block":       "blocked",
  "in-progress:fail":        "failed",
  "in-progress:abandon":     "abandoned",
  "changed-code:verify":     "verified",
  "changed-code:fail":       "failed",
  "changed-code:abandon":    "abandoned",
  "verified:merge":          "merged",
  "verified:fail":           "failed",
  "blocked:unblock":         "approved",
  "blocked:abandon":         "abandoned",
};

// ---------------------------------------------------------------------------
// Terminal states — no outbound transitions
// ---------------------------------------------------------------------------

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "merged",
  "failed",
  "abandoned",
]);

// ---------------------------------------------------------------------------
// Allowed targets per state (derived from TRANSITIONS for documentation)
// ---------------------------------------------------------------------------

export const VALID_TARGETS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  proposed:       ["approved", "abandoned"],
  approved:       ["in-progress", "abandoned"],
  "in-progress":  ["changed-code", "blocked", "failed", "abandoned"],
  "changed-code": ["verified", "failed", "abandoned"],
  verified:       ["merged", "failed"],
  blocked:        ["approved", "abandoned"],
  merged:         [],
  failed:         [],
  abandoned:      [],
};

// ---------------------------------------------------------------------------
// Core transition function
// ---------------------------------------------------------------------------

/**
 * Pure state transition. Returns the next state for a valid (state, event)
 * pair, or a rejection reason for invalid ones.
 */
export function transition(currentState: TaskState, event: TaskEvent): TransitionResult {
  const key = `${currentState}:${event}`;
  const nextState = TRANSITIONS[key];

  if (nextState !== undefined) {
    return { ok: true, state: nextState };
  }

  // Provide a descriptive rejection reason
  if (TERMINAL_STATES.has(currentState)) {
    return { ok: false, reason: `State "${currentState}" is terminal — no transitions allowed` };
  }

  const allowed = Object.entries(TRANSITIONS)
    .filter(([k]) => k.startsWith(`${currentState}:`))
    .map(([k]) => k.split(":")[1]);

  return {
    ok: false,
    reason: `Event "${event}" is not valid from state "${currentState}" (valid events: ${allowed.join(", ")})`,
  };
}

/**
 * Check whether a target state is reachable from the current state.
 * Used by task-tracker.ts to validate state-to-state transitions
 * (the control loop passes target states, not events).
 */
export function canTransitionTo(currentState: TaskState, targetState: TaskState): TransitionResult {
  const targets = VALID_TARGETS[currentState];

  if (!targets) {
    return { ok: false, reason: `Unknown state "${currentState}"` };
  }

  if (targets.includes(targetState)) {
    return { ok: true, state: targetState };
  }

  if (TERMINAL_STATES.has(currentState)) {
    return { ok: false, reason: `State "${currentState}" is terminal — no transitions allowed` };
  }

  return {
    ok: false,
    reason: `Cannot transition from "${currentState}" to "${targetState}" (allowed: ${targets.join(", ")})`,
  };
}

/**
 * Check if a state is terminal (no outbound transitions).
 */
export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}
