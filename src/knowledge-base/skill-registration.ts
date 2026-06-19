/**
 * learning/skill-registration.ts — OpenViking skill catalog + registration
 *
 * Extracted from learning.ts (issue #219). Registers the four agent
 * "skills" with OpenViking on startup so the OV resource catalog includes
 * them. Non-blocking — failures are logged and ignored.
 */

// Issue #954: OV HTTP requests route through the OpenViking Request Adapter.
import { ovPostJson, isOvFailure } from "./ov-request.ts";
import type { OvErrorCode } from "./ov-request.ts";

// Issue #1828: skill registration timed out systematically (~8-12x/hour) under
// OpenViking indexing load — a fire-and-forget single attempt with a 60s budget
// per skill, run ONCE at startup. When the `/api/v1/skills` endpoint is busy
// indexing it doesn't answer in 60s, so the catalog stayed empty until the next
// process restart. We now (a) raise the per-attempt budget to 120s (the endpoint
// eventually succeeds — delayed registration beats none), and (b) retry the two
// *transient* failure codes with exponential backoff so a load spike no longer
// permanently loses the registration.

/** Per-attempt timeout (#1828: raised from 60s — the endpoint succeeds eventually). */
const SKILL_REGISTER_TIMEOUT_MS = 120_000;

/** Max attempts per skill (1 initial + retries). */
const SKILL_REGISTER_MAX_ATTEMPTS = 3;

/** Base backoff between attempts; doubles each retry (1s, 2s, …). */
const SKILL_REGISTER_BACKOFF_BASE_MS = 1_000;

/**
 * Only the transient transport/timeout codes are worth retrying. A `ov-non-2xx`
 * (OV rejected the payload) or `ov-malformed-json` (OV answered garbage) will not
 * heal on a retry — those are surfaced immediately so a real bug isn't masked by
 * three identical failures.
 */
const RETRYABLE_OV_CODES: ReadonlySet<OvErrorCode> = new Set<OvErrorCode>([
  "ov-timeout",
  "ov-service-down",
]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Skill-catalog registration state (issue #1968)
//
// Before #1968 `registerSkills` was a fire-and-forget tally logged once to the
// console: when OpenViking timed out or 5xx'd under indexing load, ALL four
// skill registrations could silently fail and the OV skill catalog stayed empty
// — but the service reported a clean startup and no health surface reflected it.
// Planners then ran without skill context, degrading forecast quality with no
// visible alarm.
//
// We now record an in-process, queryable **skill-catalog state**: which skills
// registered, the last failure code per skill, when the registration pass
// completed, and how many of the OV_SKILLS succeeded. `getSkillCatalogState()`
// exposes it so a health surface can gate on "is the catalog populated?" instead
// of trusting the silent console.error path. State is in-process (resets on
// restart) by design — it mirrors the OV liveness probe's "live snapshot"
// semantics and needs no Redis round-trip on the /health hot path.
// ---------------------------------------------------------------------------

/** Per-skill registration outcome in the in-process catalog state. */
interface SkillRegistrationEntry {
  /** The skill name (planner/executor/skeptic/director). */
  name: string;
  /** true once OV has accepted this skill at least once this process lifetime. */
  registered: boolean;
  /** The last OV failure code seen for this skill, or null if it ever succeeded. */
  lastError: OvErrorCode | null;
  /** Epoch ms of the last successful registration, or null if never. */
  lastSuccessAt: number | null;
}

/** Queryable in-process state of the OV skill catalog. */
export interface SkillCatalogState {
  /** One entry per OV_SKILLS member, populated as `registerSkills` runs. */
  skills: SkillRegistrationEntry[];
  /** Count of skills currently registered. */
  registered: number;
  /** Total skills the catalog expects (OV_SKILLS.length). */
  total: number;
  /** true once a `registerSkills` pass has finished (success OR failure). */
  completed: boolean;
  /** Epoch ms the last `registerSkills` pass finished, or null if it never has. */
  lastAttemptAt: number | null;
}

// Seeded so a query before the first pass reports the expected total with every
// skill un-registered — distinguishable from a pass that ran and left them empty
// (`completed:true`). The entry order matches OV_SKILLS.
const skillCatalogState: SkillCatalogState = {
  skills: [],
  registered: 0,
  total: 0,
  completed: false,
  lastAttemptAt: null,
};

/**
 * Return a defensive copy of the current in-process skill-catalog state. Pure
 * read — never throws, never touches Redis or OV. A health surface (or
 * `/api/health/skills`) calls this to tell "catalog populated" from the
 * silent-empty-catalog failure mode (#1968).
 */
export function getSkillCatalogState(): SkillCatalogState {
  return {
    skills: skillCatalogState.skills.map((s) => ({ ...s })),
    registered: skillCatalogState.registered,
    total: skillCatalogState.total,
    completed: skillCatalogState.completed,
    lastAttemptAt: skillCatalogState.lastAttemptAt,
  };
}

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

/**
 * POST one skill to `/api/v1/skills`, retrying the transient OV failure codes
 * (`ov-timeout`, `ov-service-down`) with exponential backoff (#1828). The
 * adapter owns the URL join + auth headers + timeout + non-2xx/transport
 * classification; this helper layers the retry policy on top and keeps the
 * "never throw, return a boolean" contract the caller's tally relies on.
 *
 * Returns `true` once OV accepts the skill, `false` after the attempt budget is
 * exhausted (or on the first non-retryable failure). Non-retryable failures
 * short-circuit so a genuine payload/parse bug isn't masked by N identical logs.
 */
/**
 * Tunables for {@link registerSkills}. Production calls it argument-free (the
 * constants above apply); tests pass a tiny `backoffBaseMs` so the retry path is
 * exercised without real second-long sleeps.
 */
export interface RegisterSkillsOptions {
  /** Base backoff in ms (doubles each retry). Defaults to {@link SKILL_REGISTER_BACKOFF_BASE_MS}. */
  backoffBaseMs?: number;
}

/** Outcome of one skill's registration: success, or the last failure code. */
type RegisterOutcome = { ok: true } | { ok: false; code: OvErrorCode };

async function registerOneSkill(
  skill: (typeof OV_SKILLS)[number],
  backoffBaseMs: number,
): Promise<RegisterOutcome> {
  let lastCode: OvErrorCode = "ov-service-down";
  for (let attempt = 1; attempt <= SKILL_REGISTER_MAX_ATTEMPTS; attempt++) {
    const result = await ovPostJson(
      "/api/v1/skills",
      { data: skill },
      { timeout: SKILL_REGISTER_TIMEOUT_MS },
    );
    if (!isOvFailure(result)) return { ok: true };
    lastCode = result.code;

    const lastAttempt = attempt === SKILL_REGISTER_MAX_ATTEMPTS;
    const retryable = RETRYABLE_OV_CODES.has(result.code);
    if (!retryable || lastAttempt) {
      console.error(
        `[Learning] Failed to register skill ${skill.name}: ${result.code}` +
          (retryable ? ` (gave up after ${attempt} attempts)` : ""),
      );
      return { ok: false, code: result.code };
    }

    // Exponential backoff: base, 2×base, 4×base, … before the next attempt.
    const backoff = backoffBaseMs * 2 ** (attempt - 1);
    console.error(
      `[Learning] Transient OV failure registering skill ${skill.name}: ${result.code} — ` +
        `retrying in ${backoff}ms (attempt ${attempt}/${SKILL_REGISTER_MAX_ATTEMPTS})`,
    );
    await sleep(backoff);
  }
  return { ok: false, code: lastCode };
}

export async function registerSkills(opts: RegisterSkillsOptions = {}) {
  const backoffBaseMs = opts.backoffBaseMs ?? SKILL_REGISTER_BACKOFF_BASE_MS;
  // Reset the in-process catalog state for this pass: every skill starts
  // un-registered and is updated as the loop resolves each one (issue #1968).
  const entries: SkillRegistrationEntry[] = OV_SKILLS.map((s) => ({
    name: s.name,
    registered: false,
    lastError: null,
    lastSuccessAt: null,
  }));
  let registered = 0;
  for (let i = 0; i < OV_SKILLS.length; i++) {
    const outcome = await registerOneSkill(OV_SKILLS[i], backoffBaseMs);
    if (outcome.ok === true) {
      entries[i].registered = true;
      entries[i].lastError = null;
      entries[i].lastSuccessAt = Date.now();
      registered++;
    } else {
      entries[i].registered = false;
      entries[i].lastError = outcome.code;
    }
  }

  // Publish the completed pass to the queryable state so a health surface can
  // detect the silent empty-catalog failure (#1968) instead of trusting the
  // console.error log path nobody watches.
  skillCatalogState.skills = entries;
  skillCatalogState.registered = registered;
  skillCatalogState.total = OV_SKILLS.length;
  skillCatalogState.completed = true;
  skillCatalogState.lastAttemptAt = Date.now();

  if (registered > 0) {
    console.log(`[Learning] Registered ${registered}/${OV_SKILLS.length} OV skills`);
  } else {
    // Fail loud (repo convention): a fully-empty catalog is the #1968 failure
    // mode — surface it distinctly from the per-skill failures above so the
    // operator (and /api/health/skills) sees "catalog empty", not just N logs.
    console.error(
      `[Learning] OV skill catalog EMPTY — all ${OV_SKILLS.length} skill registrations failed. ` +
        `Planners will run without skill context (see issue #1968); check OpenViking load (#1924/#1831).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Post-startup re-registration (issue #2148)
//
// `registerSkills()` runs EXACTLY ONCE at startup (learning-lifecycle.ts,
// fire-and-forget). Under a sustained OpenViking indexing-load window the
// bounded #1828 retries (3 attempts, 120s budget) all exhaust, the catalog
// stays empty/partial, and NOTHING re-attempts until a manual process restart —
// the `autoRecovery:false` gap the health surface (#1992) advertises.
//
// `reRegisterMissingSkills()` is the additive recovery entry point an hourly
// Housekeeping chore calls once OpenViking has recovered. It re-POSTs ONLY the
// still-un-registered skills (registered===false) and MERGES each per-skill
// outcome back into the SAME in-process `skillCatalogState` that
// `getSkillCatalogState()` / `GET /api/health/skills` read — so a successful
// recovery flips empty→ok WITHOUT a restart, and a skill that already succeeded
// at startup is never clobbered or re-POSTed. Startup-path semantics are
// unchanged: `registerSkills()` still owns the once-at-startup full pass.
// ---------------------------------------------------------------------------

/** Result of a {@link reRegisterMissingSkills} pass: what it attempted and how it went. */
export interface ReRegisterResult {
  /** false when the guard short-circuited (no pass yet, or catalog already full). */
  attempted: boolean;
  /** Number of previously-missing skills this pass newly registered. */
  recovered: number;
  /** Number of skills still un-registered after this pass. */
  stillMissing: number;
}

/**
 * Re-register only the skills still marked `registered:false` in the in-process
 * catalog state, merging outcomes back into the existing entries (#2148).
 *
 * Guarded so it is a no-op (`attempted:false`) when there is nothing to do:
 *  - the startup pass has not completed yet (`completed:false`) — registration
 *    is still in flight; let it finish, don't race it.
 *  - the catalog is already full (`registered >= total`) — idempotent no-op.
 *
 * The caller (the Housekeeping chore) additionally gates on OpenViking liveness,
 * so this function assumes OV is reachable and simply re-attempts the gap. It
 * preserves the #1828 retry policy (it reuses `registerOneSkill`) and the
 * never-throw contract — it returns a result object and never raises.
 */
export async function reRegisterMissingSkills(
  opts: RegisterSkillsOptions = {},
): Promise<ReRegisterResult> {
  const backoffBaseMs = opts.backoffBaseMs ?? SKILL_REGISTER_BACKOFF_BASE_MS;

  // Guard: nothing to do before the startup pass finishes, or once the catalog
  // is already full. Matches the {ran, skipped} chore contract — a guard miss
  // is a skip, not work.
  if (!skillCatalogState.completed || skillCatalogState.registered >= skillCatalogState.total) {
    return { attempted: false, recovered: 0, stillMissing: skillCatalogState.total - skillCatalogState.registered };
  }

  // Re-POST only the still-missing skills, by name, against the live OV_SKILLS
  // definitions. Merge each outcome into the existing entry in place so a skill
  // that already succeeded is never reset.
  let recovered = 0;
  for (let i = 0; i < skillCatalogState.skills.length; i++) {
    const entry = skillCatalogState.skills[i];
    if (entry.registered) continue;
    const def = OV_SKILLS.find((s) => s.name === entry.name);
    if (!def) continue; // defensive: state is seeded from OV_SKILLS, so always found
    const outcome = await registerOneSkill(def, backoffBaseMs);
    if (outcome.ok === true) {
      entry.registered = true;
      entry.lastError = null;
      entry.lastSuccessAt = Date.now();
      recovered++;
    } else {
      entry.lastError = outcome.code;
    }
  }

  // Recompute the rollup so getSkillCatalogState()/health see the recovery
  // immediately. `completed` stays true; bump lastAttemptAt to this pass.
  skillCatalogState.registered = skillCatalogState.skills.filter((s) => s.registered).length;
  skillCatalogState.lastAttemptAt = Date.now();

  const stillMissing = skillCatalogState.total - skillCatalogState.registered;
  // Issue #2163: ALWAYS log an executed recovery pass (attempted=true), not only
  // when recovered>0. Before this, a pass that ran but recovered 0 skills (OV
  // answered the liveness gate but the registrations still failed) emitted
  // NOTHING — the operator could not tell "ran-and-failed" from "skipped",
  // exactly the invisibility that masked this bug. Fail-loud convention: a
  // 0-recovery pass logs at error level (work happened but did not heal the
  // catalog), a recovering pass logs at info level.
  if (recovered > 0) {
    console.log(
      `[Learning] OV skill catalog recovery: re-registered ${recovered} skill(s), ` +
        `now ${skillCatalogState.registered}/${skillCatalogState.total}` +
        (stillMissing > 0 ? ` (${stillMissing} still missing)` : ""),
    );
  } else {
    console.error(
      `[Learning] OV skill catalog recovery pass ran but recovered 0 skill(s) — ` +
        `still ${skillCatalogState.registered}/${skillCatalogState.total} ` +
        `(${stillMissing} missing). OV answered the liveness gate but the skill ` +
        `registrations still failed this pass (see per-skill logs above; #2163).`,
    );
  }
  return { attempted: true, recovered, stillMissing };
}
