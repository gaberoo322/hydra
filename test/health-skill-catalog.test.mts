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
