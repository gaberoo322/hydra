/**
 * learning/subagent-capture.ts — Lesson-capture hook for autopilot subagents
 * (issue #392).
 *
 * After codex-runner / control-loop are deleted by issue #383, nothing writes
 * to `hydra:memory:{agent}:patterns` from the in-process control loop. The
 * autopilot-dispatched subagents (`hydra-dev`, `hydra-qa`,
 * `hydra-target-build`) are the new producers of cycle-level evidence, but
 * each one is amnesic — they read `config/feedback/to-*.md` and never
 * contribute back.
 *
 * `captureSubagentLesson()` is the single entry point those subagents use
 * (directly when running in-process, or transitively via
 * `POST /api/memory/subagent-lesson` when they run in a worktree subprocess).
 * It wraps `recordPattern()` 1:1 so the existing 3-hit auto-promotion
 * pipeline keeps producing durable cardinal rules in
 * `config/feedback/to-{agent}.md`.
 *
 * Design notes:
 *   - The writer interface mirrors the codex-cycle writer (same pattern
 *     shape, same Redis key, same promotion threshold). The only difference
 *     is the `source: 'subagent'` discriminator carried as metadata, which
 *     lets `/api/learning/*` endpoints attribute future patterns to a
 *     specific origin without changing any math.
 *   - Idempotency on `(skill, outcome, cue)` keys is handled at the agent
 *     layer: agents must NOT call this twice for the same logical event.
 *     The endpoint, however, deduplicates by deferring to `recordPattern`'s
 *     own category-merge semantics — two calls with the same `cue` merge
 *     into the same pattern (hit count increments, examples roll) which is
 *     the same behaviour the codex-cycle path always had.
 *   - The skill→agent mapping is the `learningAgent` column of the
 *     Dispatch-Class Taxonomy (`scripts/autopilot/classes.json`, epic #1669):
 *     QA failures train the planner (the missed criterion), `hydra-dev` /
 *     `hydra-target-build` verification failures train the executor. The
 *     mapping is exposed via `agentForSkill()` so the API endpoint can
 *     validate inputs.
 */

import { recordPattern } from "./agent-memory.ts";
import { DISPATCH_CLASSES } from "../taxonomy/classes.ts";
import { InvariantViolationError } from "../errors.ts";

/**
 * Skills that produce subagent lessons — exactly the rows of the
 * Dispatch-Class Taxonomy whose `learningAgent` column is non-null. The
 * literal union below is the compile-time mirror of those rows; the runtime
 * list and the skill→agent mapping derive from the table itself, and
 * test/taxonomy-classes.test.mts pins union and table in lock-step.
 */
export type SubagentSkill =
  | "hydra-qa"
  | "hydra-dev"
  | "hydra-target-build"
  | "hydra-target-qa";

/** Outcomes that warrant a learning hit. Other outcomes are ignored. */
export type SubagentOutcome =
  | "qa-fail"
  | "verification-failure"
  | "no-diff"
  | "rollback";

export type SubagentLesson = {
  skill: SubagentSkill;
  outcome: SubagentOutcome;
  /**
   * Short, machine-readable cue used as the pattern category. Multiple hits
   * with the same `cue` merge into one pattern (hit count increments) — this
   * is exactly the same dedupe semantics the codex-cycle path always had.
   * Keep cues stable across runs: e.g. "acceptance-criterion-unmet",
   * "verification-failure", not the full criterion text.
   */
  cue: string;
  /**
   * Free-form context for the `examples` list. Operators read this when
   * reviewing patterns in the dashboard or auto-promoted rules.
   * Examples: PR title + diff area, failed test names, the unmet criterion.
   */
  context: string;
  /**
   * Optional human-readable action sentence. Defaults to a sensible
   * template derived from `outcome` if omitted.
   */
  action?: string;
  /**
   * Optional severity. Defaults to "prevent" — these patterns describe
   * failure modes the agent should avoid. Reinforcement lessons (positive
   * outcomes) currently go through the codex-cycle path only.
   */
  severity?: "prevent" | "reinforce";
  /**
   * Cycle/run identifier. Defaults to `subagent-<skill>-<timestamp>` if
   * omitted so the writer never fails on missing metadata.
   */
  cycleId?: string;
};

// Derived views over the taxonomy's learningAgent column (slice #1671).
const LEARNING_ROWS = DISPATCH_CLASSES.filter((r) => r.learningAgent !== null);

const AGENT_BY_SKILL: ReadonlyMap<string, "planner" | "executor"> = new Map(
  LEARNING_ROWS.map((r) => [r.skill, r.learningAgent as "planner" | "executor"]),
);

/**
 * Map subagent skills to the agent whose memory the lesson trains — a read
 * of the taxonomy's `learningAgent` column.
 *   - QA failures (`hydra-qa`, `hydra-target-qa`) → planner (it approved a
 *     plan whose AC the QA pass couldn't verify; planner should narrow its
 *     acceptance criteria or scope).
 *   - `hydra-dev` and `hydra-target-build` failures → executor (the code
 *     written didn't satisfy verification; executor should be stricter
 *     about npm test / typecheck before committing).
 *
 * Exported so the API endpoint can validate inputs and so tests can assert
 * the mapping stays stable.
 */
export function agentForSkill(skill: SubagentSkill): "planner" | "executor" {
  const agent = AGENT_BY_SKILL.get(skill);
  if (!agent) {
    // Unreachable when callers validate via isValidSkill() first — reaching
    // here means the SubagentSkill union and the taxonomy table drifted.
    // Boundary/invariant guard, so throwing is the documented convention.
    throw new InvariantViolationError(
      `agentForSkill: skill "${skill}" has no learningAgent row in the ` +
        "dispatch-class taxonomy (scripts/autopilot/classes.json)",
    );
  }
  return agent;
}

function defaultAction(skill: SubagentSkill, outcome: SubagentOutcome): string {
  switch (outcome) {
    case "qa-fail":
      return `QA rejected a PR from ${skill}. Tighten acceptance criteria so each one can be mechanically verified against the diff.`;
    case "verification-failure":
      return `Run npm test + npm run typecheck before declaring a change complete (${skill}).`;
    case "no-diff":
      return `Subagent (${skill}) produced zero file changes. Either the work was already done or the prompt was unclear — verify before retrying.`;
    case "rollback":
      return `A merge from ${skill} was auto-reverted. Re-check regression test coverage in the touched area before retrying.`;
  }
}

// Derived from the taxonomy, not hand-enumerated: every skill some dispatch
// class trains a learning agent with. The cast is pinned against the
// SubagentSkill union by test/taxonomy-classes.test.mts.
const VALID_SKILLS: readonly SubagentSkill[] = Object.freeze(
  Array.from(new Set(LEARNING_ROWS.map((r) => r.skill))),
) as readonly SubagentSkill[];
const VALID_OUTCOMES: readonly SubagentOutcome[] = [
  "qa-fail",
  "verification-failure",
  "no-diff",
  "rollback",
];

export function isValidSkill(s: unknown): s is SubagentSkill {
  return typeof s === "string" && (VALID_SKILLS as readonly string[]).includes(s);
}

export function isValidOutcome(o: unknown): o is SubagentOutcome {
  return typeof o === "string" && (VALID_OUTCOMES as readonly string[]).includes(o);
}

/**
 * Capture one lesson from a Claude-driven subagent run. Wraps
 * `recordPattern()` 1:1 so the auto-promotion pipeline (3-hit → write to
 * `config/feedback/to-{agent}.md`) keeps working unchanged.
 *
 * Safe to call from inside an autopilot dispatch (in-process) or from an
 * HTTP handler (`/api/memory/subagent-lesson`).
 */
export async function captureSubagentLesson(lesson: SubagentLesson): Promise<{
  agent: "planner" | "executor";
  category: string;
}> {
  if (!isValidSkill(lesson.skill)) {
    throw new Error(`captureSubagentLesson: invalid skill "${lesson.skill}"`);
  }
  if (!isValidOutcome(lesson.outcome)) {
    throw new Error(`captureSubagentLesson: invalid outcome "${lesson.outcome}"`);
  }
  if (typeof lesson.cue !== "string" || lesson.cue.trim().length === 0) {
    throw new Error("captureSubagentLesson: cue is required");
  }

  const agent = agentForSkill(lesson.skill);
  const category = lesson.cue.trim();
  const cycleId =
    lesson.cycleId && lesson.cycleId.trim().length > 0
      ? lesson.cycleId
      : `subagent-${lesson.skill}-${Date.now()}`;

  // Issue #823 — recordPattern now dispatches the escalation internally
  // (record-then-escalate, best-effort, never throws). No separate
  // escalateIfNeeded call: the lifecycle can't be half-applied.
  await recordPattern(agent, category, {
    severity: lesson.severity || "prevent",
    action: lesson.action || defaultAction(lesson.skill, lesson.outcome),
    example: lesson.context || "",
    cycleId,
    source: "subagent",
  });

  return { agent, category };
}

// ===========================================================================
// Issue #512 — Friction capture (soft friction, not hard failure)
// ===========================================================================

/**
 * Friction items are the soft surface — anything an agent worked AROUND
 * without failing. Captured even on success runs so successor agents
 * don't re-discover the same friction.
 *
 * Stored in the `hydra:friction:{skill}:patterns` namespace (NOT the
 * planner/executor memory keys) so friction doesn't pollute the
 * lesson-promotion pipeline. Threshold-cross still fires the GitHub
 * escalation hook to surface chronic friction as tracked work.
 */
export type SubagentFriction = {
  skill: SubagentSkill;
  /** kebab-case identifier, stable across runs (e.g. `stale-local-master-ref`). */
  cue: string;
  /** One line — what the agent did to work around the friction. */
  workaround: string;
  /** One line — file paths or other identifying context. */
  context: string;
  /** Optional cycle/run ID. Auto-generated if omitted. */
  cycleId?: string;
};

/**
 * Capture a soft-friction item from a subagent run. Friction items don't
 * promote to feedback files (there is no per-skill feedback file) but they
 * DO escalate to GitHub when the same cue crosses the promotion threshold.
 *
 * Idempotent on `(skill, cue)` — multiple calls merge into one pattern
 * (hit count increments, workarounds roll into the examples list).
 */
export async function captureSubagentFriction(item: SubagentFriction): Promise<{
  skill: SubagentSkill;
  category: string;
}> {
  if (!isValidSkill(item.skill)) {
    throw new Error(`captureSubagentFriction: invalid skill "${item.skill}"`);
  }
  if (typeof item.cue !== "string" || item.cue.trim().length === 0) {
    throw new Error("captureSubagentFriction: cue is required");
  }
  if (typeof item.workaround !== "string" || item.workaround.trim().length === 0) {
    throw new Error("captureSubagentFriction: workaround is required");
  }

  const category = item.cue.trim();
  const cycleId =
    item.cycleId && item.cycleId.trim().length > 0
      ? item.cycleId
      : `friction-${item.skill}-${Date.now()}`;

  // The `agent` slot in the namespace is reused as the skill name — friction
  // is scoped per-skill, not per-agent-role.
  // Issue #823 — recordPattern dispatches the friction escalation internally
  // (escalationContext = `friction/<skill>/<cue>`). No separate call needed.
  await recordPattern(item.skill, category, {
    severity: "prevent",
    action: item.workaround.trim(),
    example: item.context ? item.context.trim() : "",
    cycleId,
    source: "subagent",
    namespace: "friction",
  });

  return { skill: item.skill, category };
}
