/**
 * Skill-catalog re-registration chore (issue #2148).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`, #2090 layout).
 *
 * Closes the `autoRecovery:false` gap the skill-catalog health surface (#1992)
 * advertises: `registerSkills()` runs EXACTLY ONCE at startup (fire-and-forget,
 * learning-lifecycle.ts). Under a sustained OpenViking indexing-load window the
 * bounded #1828 startup retries all exhaust, the catalog stays empty/partial,
 * and NOTHING re-attempts until a manual process restart.
 *
 * This chore is the additive post-startup recovery path. On each hourly
 * Housekeeping tick it:
 *   1. reads the in-process skill-catalog state (no I/O),
 *   2. SKIPS unless a startup pass has completed AND skills are still missing
 *      (an already-full catalog is an idempotent no-op — the {ran,skipped}
 *      contract routes that to `skipped`),
 *   3. gates on the SKILLS-endpoint liveness (`probeSkillsEndpoint`
 *      status==="running") — the resource it writes to (`POST /api/v1/skills`),
 *      NOT OV-the-app's shallow `GET /health`. Issue #2163: a `probeOv` gate
 *      answered <100ms even while the skills POST handler was timing out under
 *      indexing load (#1831), green-lighting a guaranteed-doomed pass every hour
 *      that then hammered the down handler for up to ~24min. Probing the actual
 *      resource means it only re-attempts once that resource is responsive,
 *   4. re-registers ONLY the still-missing skills, merging outcomes into the
 *      same in-process state the health surface reads — so a recovery flips
 *      empty→ok WITHOUT a restart.
 *
 * It preserves the #1828 RETRYABLE_OV_CODES discrimination (it reuses
 * `reRegisterMissingSkills`, which reuses `registerOneSkill`): a persistent
 * non-retryable failure surfaces per-skill and is not masked by blind hourly
 * retries. No new runtime dependency (ADR-0005) — node stdlib plus the existing
 * ov-request seam and health probe only. Never throws (the `runChore` wrapper
 * also try/catches, but this body returns rather than raises).
 */

import { getSkillCatalogState, reRegisterMissingSkills } from "../../knowledge-base/skill-registration.ts";
import { probeSkillsEndpoint } from "../../health/probe.ts";

/** External touchpoints of the skill-catalog-reregister chore (injectable for tests). */
export interface SkillCatalogReregisterDeps {
  /** Read the live in-process skill-catalog state. Defaults to the real getter. */
  getState?: typeof getSkillCatalogState;
  /**
   * Probe the OpenViking SKILLS endpoint — the resource this chore writes to.
   * Defaults to the real `probeSkillsEndpoint` (issue #2163: the old `probeOv`
   * GET /health gate was decoupled from `POST /api/v1/skills`, green-lighting a
   * doomed pass every hour). Gate on the resource the chore actually exercises.
   */
  probeSkillsImpl?: typeof probeSkillsEndpoint;
  /** Re-register the still-missing skills. Defaults to the real entry point. */
  reRegister?: typeof reRegisterMissingSkills;
}

/**
 * Re-register the skills missing from the OV catalog, once OpenViking is live
 * again (issue #2148).
 *
 * Returns `false` (→ `skipped`) when there is nothing to do or OV is still
 * down, and `void`/`true` (→ `ran`) when a recovery pass actually executed.
 * Never throws — it returns on every branch.
 */
export async function runSkillCatalogReregister(
  deps: SkillCatalogReregisterDeps = {},
): Promise<boolean> {
  const getState = deps.getState ?? getSkillCatalogState;
  const probe = deps.probeSkillsImpl ?? probeSkillsEndpoint;
  const reRegister = deps.reRegister ?? reRegisterMissingSkills;

  const state = getState();

  // Cheap in-process guard FIRST (no network): skip unless a startup pass has
  // completed and the catalog is genuinely short. This avoids probing OV when
  // there is nothing to recover.
  if (!state.completed || state.registered >= state.total) {
    return false;
  }

  // Gate on the SKILLS-endpoint liveness (issue #2163) — probe the resource this
  // chore actually writes to (`POST /api/v1/skills`), NOT OV-the-app's shallow
  // GET /health. The old probeOv gate answered <100ms even while the skills POST
  // handler was timing out under indexing load (#1831), green-lighting a
  // guaranteed-doomed pass every hour. probeSkillsEndpoint folds to `failed`
  // when the skills handler cannot answer in its short window, so we only
  // re-attempt once the resource the chore depends on is genuinely responsive.
  const skills = await probe();
  if (skills.status !== "running") {
    return false;
  }

  const result = await reRegister();
  // `attempted:false` means the state changed between the guard above and the
  // re-register call (e.g. the startup pass just filled the catalog) — route to
  // skipped. `recovered:0` with `attempted:true` means OV answered the liveness
  // probe but still failed the actual registrations this pass; that IS work
  // (we tried), so count it as ran so the operator sees the attempt happened.
  if (!result.attempted) {
    return false;
  }
  return true;
}
