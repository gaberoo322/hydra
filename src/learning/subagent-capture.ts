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
 *   - The skill→agent mapping is intentional: `hydra-qa` failures train the
 *     planner (the missed criterion), `hydra-dev` / `hydra-target-build`
 *     verification failures train the executor. The mapping is exposed via
 *     `agentForSkill()` so the API endpoint can validate inputs.
 */

import { recordPattern } from "./agent-memory.ts";

/** Skills that produce subagent lessons. Keep in sync with autopilot dispatch. */
export type SubagentSkill = "hydra-qa" | "hydra-dev" | "hydra-target-build";

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

/**
 * Map subagent skills to the agent whose memory the lesson trains.
 *   - `hydra-qa` failures → planner (it approved a plan whose AC the QA
 *     pass couldn't verify; planner should narrow its acceptance criteria
 *     or scope).
 *   - `hydra-dev` and `hydra-target-build` failures → executor (the code
 *     written didn't satisfy verification; executor should be stricter
 *     about npm test / typecheck before committing).
 *
 * Exported so the API endpoint can validate inputs and so tests can assert
 * the mapping stays stable.
 */
export function agentForSkill(skill: SubagentSkill): "planner" | "executor" {
  if (skill === "hydra-qa") return "planner";
  return "executor";
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

const VALID_SKILLS: readonly SubagentSkill[] = [
  "hydra-qa",
  "hydra-dev",
  "hydra-target-build",
];
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

  await recordPattern(agent, category, {
    severity: lesson.severity || "prevent",
    action: lesson.action || defaultAction(lesson.skill, lesson.outcome),
    example: lesson.context || "",
    cycleId,
    source: "subagent",
  });

  return { agent, category };
}
