/**
 * Unit tests for the Skill-Catalog Health Seam (issue #1992; gate first added
 * in #1968).
 *
 * `assessSkillCatalog` is the pure verdict over the in-process skill-catalog
 * state produced by startup `registerSkills`. It was extracted out of the
 * Health Assessment pipeline (`src/health/diagnostics.ts`) into its own focused
 * module — the test now imports from that module, so the test's intent is
 * legible without the ~700-line pipeline seam as context. The verdict is pure
 * (plain `SkillCatalogSnapshot` literals in, assessment out): no Redis, no OV,
 * no HTTP layer.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assessSkillCatalog, type SkillCatalogSnapshot } from "../src/health/skill-catalog.ts";

describe("assessSkillCatalog (#1968)", () => {
  const skill = (name: string, registered: boolean, lastError: string | null = null) => ({
    name,
    registered,
    lastError,
  });

  test("no pass completed yet is ok/in-flight with no diagnostic", () => {
    const snap: SkillCatalogSnapshot = { registered: 0, total: 4, completed: false, skills: [] };
    const a = assessSkillCatalog(snap);
    assert.equal(a.status, "ok");
    assert.equal(a.diagnostic, null);
  });

  test("all skills registered is ok with no diagnostic", () => {
    const snap: SkillCatalogSnapshot = {
      registered: 4,
      total: 4,
      completed: true,
      skills: ["planner", "executor", "skeptic", "director"].map((n) => skill(n, true)),
    };
    const a = assessSkillCatalog(snap);
    assert.equal(a.status, "ok");
    assert.equal(a.diagnostic, null);
  });

  test("zero registered after a completed pass is EMPTY with an error diagnostic", () => {
    const snap: SkillCatalogSnapshot = {
      registered: 0,
      total: 4,
      completed: true,
      skills: ["planner", "executor", "skeptic", "director"].map((n) =>
        skill(n, false, "ov-timeout"),
      ),
    };
    const a = assessSkillCatalog(snap);
    assert.equal(a.status, "empty");
    assert.equal(a.diagnostic?.severity, "error");
    assert.equal(a.diagnostic?.component, "intelligence");
    assert.match(a.diagnostic!.what, /empty/i);
    // The per-skill failure codes are surfaced in the action detail.
    assert.match(a.diagnostic!.action, /ov-timeout/);
  });

  test("partial registration is DEGRADED with a warning naming the missing skills", () => {
    const snap: SkillCatalogSnapshot = {
      registered: 3,
      total: 4,
      completed: true,
      skills: [
        skill("planner", true),
        skill("executor", true),
        skill("skeptic", true),
        skill("director", false, "ov-non-2xx"),
      ],
    };
    const a = assessSkillCatalog(snap);
    assert.equal(a.status, "degraded");
    assert.equal(a.diagnostic?.severity, "warning");
    assert.match(a.diagnostic!.what, /3\/4/);
    assert.match(a.diagnostic!.action, /director \(ov-non-2xx\)/);
  });
});

describe("assessSkillCatalog: VLM-deferred graceful degradation (#2277)", () => {
  const deferredSnap = (): SkillCatalogSnapshot => ({
    registered: 0,
    total: 4,
    completed: true,
    vlmDeferred: true,
    skills: ["planner", "executor", "skeptic", "director"].map((n) => ({
      name: n,
      registered: false,
      lastError: "vlm-deferred",
    })),
  });

  test("a deferred empty catalog is DEGRADED (warning, auto-recovering), NOT empty/error", () => {
    const a = assessSkillCatalog(deferredSnap());
    // The key #2277 acceptance: zero-registered but VLM-deferred must NOT fold to
    // the #1968 `empty`/`error` framing — it is a deliberate, self-healing
    // degradation, so it is a `degraded` warning.
    assert.equal(a.status, "degraded");
    assert.equal(a.diagnostic?.severity, "warning");
    assert.equal(a.diagnostic?.component, "intelligence");
    assert.match(a.diagnostic!.what, /defer/i);
    assert.match(a.diagnostic!.why, /VLM/i);
    // Auto-recovering: the hourly chore re-registers once the VLM is back, so the
    // diagnostic advertises autoRecovery — distinct from the #1968 empty (false).
    assert.equal(a.diagnostic?.autoRecovery, true);
    assert.match(a.diagnostic!.action, /ollama-recovery/);
  });

  test("vlmDeferred takes precedence over the empty rule at registered:0", () => {
    // Same zero-registered shape, but without the deferred flag it would be the
    // hard `empty`/error verdict — proving the flag is what flips the framing.
    const notDeferred = deferredSnap();
    notDeferred.vlmDeferred = false;
    const empty = assessSkillCatalog(notDeferred);
    assert.equal(empty.status, "empty");
    assert.equal(empty.diagnostic?.severity, "error");

    const deferred = assessSkillCatalog(deferredSnap());
    assert.equal(deferred.status, "degraded");
    assert.equal(deferred.diagnostic?.severity, "warning");
  });
});

describe("assessSkillCatalog: skills-endpoint-deferred graceful degradation (#3402)", () => {
  // Sibling of the #2277 VLM-deferred block above: the /api/v1/skills handler was
  // load-gated at startup, so registration was DEFERRED (skipped), not failed. The
  // population gate must emit the SAME self-healing verdict shape the vlmDeferred
  // path does — degraded/warning/autoRecovery:true — NOT the #1968 empty/error.
  const deferredSnap = (): SkillCatalogSnapshot => ({
    registered: 0,
    total: 4,
    completed: true,
    skillsDeferred: true,
    skills: ["planner", "executor", "skeptic", "director"].map((n) => ({
      name: n,
      registered: false,
      lastError: "skills-deferred",
    })),
  });

  test("a skills-deferred empty catalog is DEGRADED (warning, auto-recovering), NOT empty/error", () => {
    const a = assessSkillCatalog(deferredSnap());
    // The key #3402 acceptance: zero-registered but skills-deferred must NOT fold
    // to the #1968 `empty`/`error` framing — it is a deliberate, self-healing
    // degradation, so it is a `degraded` warning that advertises auto-recovery
    // (the hourly chore re-registers once the /skills endpoint answers). This is
    // the SAME verdict shape the vlmDeferred sibling produces.
    assert.equal(a.status, "degraded");
    assert.equal(a.diagnostic?.severity, "warning");
    assert.equal(a.diagnostic?.component, "intelligence");
    assert.match(a.diagnostic!.what, /defer/i);
    assert.match(a.diagnostic!.why, /skills/i);
    assert.equal(a.diagnostic?.autoRecovery, true);
    // Must NOT mis-route the operator to the #1968 "restart the orchestrator" path.
    assert.doesNotMatch(a.diagnostic!.action, /restart the orchestrator/i);
  });

  test("skillsDeferred takes precedence over the empty rule at registered:0", () => {
    // Same zero-registered shape, but without the deferred flag it would be the
    // hard `empty`/error verdict — proving the flag is what flips the framing.
    const notDeferred = deferredSnap();
    notDeferred.skillsDeferred = false;
    const empty = assessSkillCatalog(notDeferred);
    assert.equal(empty.status, "empty");
    assert.equal(empty.diagnostic?.severity, "error");

    const deferred = assessSkillCatalog(deferredSnap());
    assert.equal(deferred.status, "degraded");
    assert.equal(deferred.diagnostic?.severity, "warning");
  });

  test("skills-deferred and vlm-deferred produce the same self-healing verdict shape", () => {
    // Symmetry assertion (#3402): both deferral modes must yield an identical
    // verdict *shape* — degraded status, warning severity, intelligence component,
    // autoRecovery:true — so a consumer treats them the same self-healing way.
    const vlm = assessSkillCatalog({
      registered: 0,
      total: 4,
      completed: true,
      vlmDeferred: true,
      skills: [{ name: "planner", registered: false, lastError: "vlm-deferred" }],
    });
    const skills = assessSkillCatalog(deferredSnap());
    assert.equal(vlm.status, skills.status);
    assert.equal(vlm.diagnostic?.severity, skills.diagnostic?.severity);
    assert.equal(vlm.diagnostic?.component, skills.diagnostic?.component);
    assert.equal(vlm.diagnostic?.autoRecovery, skills.diagnostic?.autoRecovery);
  });
});
