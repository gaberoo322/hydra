/**
 * OpenViking Skills Registry
 *
 * Registers Hydra's agent capabilities as OV skills on startup.
 * The Director and research agents can query available skills to
 * compose better task plans.
 */

const OV_URL = process.env.OPENVIKING_URL || "http://localhost:1933";
const OV_KEY = process.env.OPENVIKING_API_KEY || "1080bb34205409e58aa433512cb5e5d6344560adce963c442543001808181115";

const SKILLS = [
  {
    name: "planner",
    description: "Proposes one bounded development task per cycle. Reads priorities, grounding, and knowledge context. Outputs structured JSON with title, scope boundary, acceptance criteria, and verification plan.",
    content: `# planner

Propose one bounded development task per cycle.

## Capabilities
- Reads project priorities, goals, and operator vision
- Analyzes codebase grounding (test counts, typecheck status, file tree)
- Searches OpenViking knowledge base for relevant context
- Proposes tasks with concrete scope boundaries and verification plans
- Adapts complexity: quick-fix (1-2 files) or standard (full analysis)

## Input
- Anchor (what to work on): failing test, queued item, research finding, or priorities doc
- Grounding: npm test results, typecheck status, git state
- Priorities: operator-authored direction document
- Knowledge: OpenViking search results relevant to the anchor

## Output
JSON with: title, description, scopeBoundary, acceptanceCriteria, verificationPlan

## Constraints
- One task per cycle (never multiple)
- Must be anchored to real evidence
- Scope boundary must list specific files
- Verification plan must use npm test and npm run typecheck
`,
  },
  {
    name: "executor",
    description: "Writes code on a feature branch to implement a planned task. Has full codebase access. Runs tests before committing. Never merges to main.",
    content: `# executor

Write code to implement a planned task.

## Capabilities
- Full read/write access to the target project codebase
- Creates feature branches, writes code, runs tests
- Follows existing test patterns from the project
- Respects scope boundaries from the planner

## Input
- Task with title, description, scope boundary, acceptance criteria
- Grounding summary with current test counts and file structure
- Agent memory with prevention rules from past failures

## Output
JSON with: summary, filesChanged, commits, branch, testsRun

## Constraints
- Must stay within scope boundary
- Must run npm test before committing
- Never merges to main — control loop handles merging
- Creates one feature branch per cycle
`,
  },
  {
    name: "skeptic",
    description: "Challenges proposed tasks before execution. Has veto power. Checks for duplicates, scope issues, and feasibility. Skipped for quick-fix and research-vetted tasks.",
    content: `# skeptic

Challenge a proposed task before it gets executed.

## Capabilities
- Reviews task proposals for anchoring, scope, feasibility
- Checks recent cycle history for duplicate work
- Reads prevention rules from past failures
- Can approve or reject with a reason

## Input
- Proposed task (title, description, scope, criteria)
- Recent cycle history (last 5 cycles)
- Agent memory with prevention rules

## Output
JSON with: verdict (approve/reject), reason

## Constraints
- Should lean toward approve when uncertain
- Skip for research-vetted items and quick-fixes
- Must provide concrete reason for rejection
`,
  },
  {
    name: "director",
    description: "Synthesizes operator vision, codebase state, and multi-stream research into a prioritized feature roadmap. Writes priorities.md and ranks opportunities.",
    content: `# director

Synthesize vision + codebase state + research into priorities.

## Capabilities
- Reads operator vision (short intent document)
- Analyzes structured codebase state (modules, routes, gaps)
- Processes domain, technical, and market research findings
- Produces ranked opportunity list with alignment scores
- Writes complete priorities.md for the planner

## Input
- Operator vision (5-20 lines)
- Codebase analysis (modules, API routes, test count, gaps)
- Three research streams (domain, technical, market)

## Output
JSON with: priorities (markdown string), opportunities (ranked list), summary, researchHighlights

## Constraints
- Features over hardening (follow operator vision)
- Concrete tasks over vague direction
- Wire existing code before building new things
- Research-backed recommendations
`,
  },
];

/**
 * Register all agent skills with OpenViking.
 * Called once on startup. Idempotent — re-registering updates the skill.
 */
export async function registerSkills() {
  let registered = 0;
  for (const skill of SKILLS) {
    try {
      const res = await fetch(`${OV_URL}/api/v1/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": OV_KEY },
        body: JSON.stringify({ data: skill }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        registered++;
      } else {
        const text = await res.text().catch(() => "");
        console.error(`[OVSkills] Failed to register ${skill.name}: ${res.status} ${text.slice(0, 150)}`);
      }
    } catch (err) {
      console.error(`[OVSkills] Failed to register ${skill.name}: ${err.message}`);
    }
  }
  if (registered > 0) {
    console.log(`[OVSkills] Registered ${registered}/${SKILLS.length} agent skills`);
  }
}
