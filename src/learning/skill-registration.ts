/**
 * learning/skill-registration.ts — OpenViking skill catalog + registration
 *
 * Extracted from learning.ts (issue #219). Registers the four agent
 * "skills" with OpenViking on startup so the OV resource catalog includes
 * them. Non-blocking — failures are logged and ignored.
 */

import { OV_URL, OV_KEY } from "./ov-search.ts";

const OV_SKILLS = [
  {
    name: "planner",
    description: "Proposes one bounded development task per cycle. Reads priorities, grounding, and knowledge context. Outputs structured JSON with title, scope boundary, acceptance criteria, and verification plan.",
    content: `# planner\n\nPropose one bounded development task per cycle.\n\n## Capabilities\n- Reads project priorities, goals, and operator vision\n- Analyzes codebase grounding (test counts, typecheck status, file tree)\n- Searches OpenViking knowledge base for relevant context\n- Proposes tasks with concrete scope boundaries and verification plans\n- Adapts complexity: quick-fix (1-2 files) or standard (full analysis)\n\n## Input\n- Anchor (what to work on): failing test, queued item, research finding, or priorities doc\n- Grounding: npm test results, typecheck status, git state\n- Priorities: operator-authored direction document\n- Knowledge: OpenViking search results relevant to the anchor\n\n## Output\nJSON with: title, description, scopeBoundary, acceptanceCriteria, verificationPlan\n\n## Constraints\n- One task per cycle (never multiple)\n- Must be anchored to real evidence\n- Scope boundary must list specific files\n- Verification plan must use npm test and npm run typecheck\n`,
  },
  {
    name: "executor",
    description: "Writes code on a feature branch to implement a planned task. Has full codebase access. Runs tests before committing. Never merges to main.",
    content: `# executor\n\nWrite code to implement a planned task.\n\n## Capabilities\n- Full read/write access to the target project codebase\n- Creates feature branches, writes code, runs tests\n- Follows existing test patterns from the project\n- Respects scope boundaries from the planner\n\n## Input\n- Task with title, description, scope boundary, acceptance criteria\n- Grounding summary with current test counts and file structure\n- Agent memory with prevention rules from past failures\n\n## Output\nJSON with: summary, filesChanged, commits, branch, testsRun\n\n## Constraints\n- Must stay within scope boundary\n- Must run npm test before committing\n- Never merges to main — control loop handles merging\n- Creates one feature branch per cycle\n`,
  },
  {
    name: "skeptic",
    description: "Challenges proposed tasks before execution. Has veto power. Checks for duplicates, scope issues, and feasibility. Skipped for quick-fix and research-vetted tasks.",
    content: `# skeptic\n\nChallenge a proposed task before it gets executed.\n\n## Capabilities\n- Reviews task proposals for anchoring, scope, feasibility\n- Checks recent cycle history for duplicate work\n- Reads prevention rules from past failures\n- Can approve or reject with a reason\n\n## Input\n- Proposed task (title, description, scope, criteria)\n- Recent cycle history (last 5 cycles)\n- Agent memory with prevention rules\n\n## Output\nJSON with: verdict (approve/reject), reason\n\n## Constraints\n- Should lean toward approve when uncertain\n- Skip for research-vetted items and quick-fixes\n- Must provide concrete reason for rejection\n`,
  },
  {
    name: "director",
    description: "Synthesizes operator vision, codebase state, and multi-stream research into a prioritized feature roadmap. Writes priorities.md and ranks opportunities.",
    content: `# director\n\nSynthesize vision + codebase state + research into priorities.\n\n## Capabilities\n- Reads operator vision (short intent document)\n- Analyzes structured codebase state (modules, API routes, gaps)\n- Processes domain, technical, and market research findings\n- Produces ranked opportunity list with alignment scores\n- Writes complete priorities.md for the planner\n\n## Input\n- Operator vision (5-20 lines)\n- Codebase analysis (modules, API routes, test count, gaps)\n- Three research streams (domain, technical, market)\n\n## Output\nJSON with: priorities (markdown string), opportunities (ranked list), summary, researchHighlights\n\n## Constraints\n- Features over hardening (follow operator vision)\n- Concrete tasks over vague direction\n- Wire existing code before building new things\n- Research-backed recommendations\n`,
  },
];

export async function registerSkills() {
  let registered = 0;
  for (const skill of OV_SKILLS) {
    try {
      const res = await fetch(`${OV_URL}/api/v1/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
        body: JSON.stringify({ data: skill }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        registered++;
      } else {
        const text = await res.text().catch(() => "");
        console.error(`[Learning] Failed to register skill ${skill.name}: ${res.status} ${text.slice(0, 150)}`);
      }
    } catch (err: any) {
      console.error(`[Learning] Failed to register skill ${skill.name}: ${err.message}`);
    }
  }
  if (registered > 0) {
    console.log(`[Learning] Registered ${registered}/${OV_SKILLS.length} OV skills`);
  }
}
