/**
 * Lifecycle state set, transition table and reason enums (ADR-0047, issue #5310).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ADR5_REASONS,
  HUMAN_HOLD_STATES,
  LIFECYCLE_STATES,
  OPEN_STATES,
  OPERATOR_TARGETS,
  OPERATOR_TRANSITIONS,
  HOLD_EXIT_ALERT_WINDOW_DAYS,
  TRANSITIONS,
  findOperatorTransition,
  findTransition,
  isUnsanctionedHoldExit,
  isAdr5Reason,
  isAllowedReason,
  isHumanHold,
  isLegalTransition,
  stateLabelsOf,
} from "../src/lifecycle/index.ts";
import { RELABEL_TARGETS } from "../src/schemas/autopilot-board.ts";

describe("lifecycle state set (INV-1)", () => {
  test("is exactly the 13 open states plus closed", () => {
    assert.deepEqual([...LIFECYCLE_STATES].sort(), [
      "blocked", "closed", "hitl-grill", "in-progress", "needs-dev-resume", "needs-info",
      "needs-qa", "needs-research", "needs-tickets", "needs-triage", "parked", "qa-passed",
      "ready-for-agent", "ready-for-human",
    ]);
    assert.equal(OPEN_STATES.length, 13);
    assert.equal(OPEN_STATES.includes("closed" as never), false);
  });

  test("human-hold states are the four ADR-0047 D2 names", () => {
    assert.deepEqual([...HUMAN_HOLD_STATES].sort(), ["hitl-grill", "needs-info", "parked", "ready-for-human"]);
    assert.equal(isHumanHold("parked"), true);
    assert.equal(isHumanHold("in-progress"), false);
  });

  test("stateLabelsOf ignores flags", () => {
    assert.deepEqual(stateLabelsOf(["glm-eligible", "in-progress", "enhancement"]), ["in-progress"]);
    assert.deepEqual(stateLabelsOf(["enhancement"]), []);
  });
});

describe("transition table (INV-2)", () => {
  test("has no human-hold or closed source rows", () => {
    for (const t of TRANSITIONS) {
      assert.equal(isHumanHold(t.from), false, `${t.from} -> ${t.to}`);
      assert.notEqual(t.from, "closed");
    }
  });

  test("has no duplicate (from,to) pairs and only known states", () => {
    const seen = new Set<string>();
    for (const t of TRANSITIONS) {
      const k = `${t.from}>${t.to}`;
      assert.equal(seen.has(k), false, `duplicate ${k}`);
      seen.add(k);
      assert.ok((LIFECYCLE_STATES as readonly string[]).includes(t.from));
      assert.ok((LIFECYCLE_STATES as readonly string[]).includes(t.to));
    }
  });

  test("isLegalTransition is a pure lookup", () => {
    assert.equal(isLegalTransition("ready-for-agent", "in-progress"), true);
    assert.equal(isLegalTransition("in-progress", "needs-qa"), true);
    assert.equal(isLegalTransition("needs-triage", "in-progress"), false);
    assert.equal(isLegalTransition("parked", "ready-for-agent"), false);
    assert.equal(isLegalTransition("hitl-grill", "ready-for-agent"), false);
    assert.equal(isLegalTransition("closed", "needs-triage"), false);
  });

  test("qa-passed exits are split by cause and reconcile-fired", () => {
    for (const to of ["needs-dev-resume", "needs-qa", "closed", "ready-for-agent"] as const) {
      assert.equal(findTransition("qa-passed", to)?.firedBy, "reconcile", to);
    }
  });

  test("ready-for-agent -> needs-qa is reconcile-fired through pr-open with no cap (#5489)", () => {
    const t = findTransition("ready-for-agent", "needs-qa");
    assert.equal(t?.firedBy, "reconcile");
    assert.equal(t?.gate, "pr-open");
    assert.equal(t?.cap, undefined);
  });

  test("the dispatcher owns ready-for-agent -> in-progress", () => {
    assert.equal(findTransition("ready-for-agent", "in-progress")?.firedBy, "dispatcher");
  });

  test("every non-hold open state can reach ready-for-human only through the adr5 gate", () => {
    for (const t of TRANSITIONS.filter((x) => x.to === "ready-for-human")) {
      assert.equal(t.gate, "adr5", t.from);
    }
  });
});

describe("reason enums (INV-8)", () => {
  test("ADR-0005 enum is closed", () => {
    assert.deepEqual([...ADR5_REASONS], ["credentials", "external-account", "t4-deep-qa-exhausted", "vision-conflict"]);
    assert.equal(isAdr5Reason("credentials"), true);
    assert.equal(isAdr5Reason("tired"), false);
  });

  test("per-target reasons gate judgment targets; parked accepts cap:<arm>", () => {
    assert.equal(isAllowedReason("needs-info", "missing-repro"), true);
    assert.equal(isAllowedReason("needs-info", "vibes"), false);
    assert.equal(isAllowedReason("parked", "cap:qa-fail-rounds"), true);
    assert.equal(isAllowedReason("parked", "cap:"), false);
    assert.equal(isAllowedReason("in-progress", "anything"), false);
  });
});

describe("operator-route legality is data (#5313 INV-3)", () => {
  test("OPERATOR_TRANSITIONS is every open state x every operator target, no self-moves", () => {
    assert.equal(OPERATOR_TRANSITIONS.length, OPERATOR_TARGETS.length * OPEN_STATES.length - OPERATOR_TARGETS.filter((t) => t !== "closed").length);
    for (const t of OPERATOR_TRANSITIONS) {
      assert.equal(t.firedBy, "operator");
      assert.equal(t.gate, "none");
      assert.notEqual(t.from, t.to);
    }
    for (const hold of HUMAN_HOLD_STATES) {
      assert.ok(findOperatorTransition(hold, "needs-triage"), hold);
    }
  });

  test("agent-owned states are never operator targets", () => {
    for (const s of ["in-progress", "qa-passed", "parked"]) {
      assert.equal((OPERATOR_TARGETS as readonly string[]).includes(s), false, s);
      assert.equal(findOperatorTransition("needs-triage", s as never), undefined, s);
    }
  });

  test("needs-dev-resume and needs-qa are operator targets (the #5058 hand-back lanes)", () => {
    for (const s of ["needs-dev-resume", "needs-qa"]) {
      assert.equal((OPERATOR_TARGETS as readonly string[]).includes(s), true, s);
      assert.ok(findOperatorTransition("ready-for-human", s as never), s);
    }
  });

  test("the agent TRANSITIONS table still has no human-hold-from rows", () => {
    for (const t of TRANSITIONS) assert.equal(isHumanHold(t.from), false, t.from);
  });

  test("RELABEL_TARGETS (the board schema) is a subset of OPERATOR_TARGETS", () => {
    for (const t of RELABEL_TARGETS) assert.ok((OPERATOR_TARGETS as readonly string[]).includes(t), t);
  });
});

describe("isUnsanctionedHoldExit (#5313 INV-9)", () => {
  const e = (over: object) => ({
    kind: "external" as const, written: true, source: "external" as const,
    from: "parked" as string | null, to: "ready-for-agent" as string | null, ...over,
  });

  test("true for a written non-operator-route exit out of a human-hold state", () => {
    assert.equal(isUnsanctionedHoldExit(e({})), true);
    assert.equal(isUnsanctionedHoldExit(e({ kind: "transition", source: "cli" })), true);
    assert.equal(isUnsanctionedHoldExit(e({ source: "workflow" })), true);
    assert.equal(isUnsanctionedHoldExit(e({ from: "needs-triage,hitl-grill" })), true);
    // A shadow-mode write is journaled kind refused with written:true (#5313 round 3).
    assert.equal(isUnsanctionedHoldExit(e({ kind: "refused", source: "cli" })), true);
  });

  test("false for operator-route, refused, unwritten, non-hold, null-from and hold-to-itself", () => {
    assert.equal(isUnsanctionedHoldExit(e({ source: "operator-route" })), false);
    assert.equal(isUnsanctionedHoldExit(e({ kind: "refused", written: false })), false);
    assert.equal(isUnsanctionedHoldExit(e({ written: false })), false);
    assert.equal(isUnsanctionedHoldExit(e({ from: "needs-triage" })), false);
    assert.equal(isUnsanctionedHoldExit(e({ from: null })), false);
    assert.equal(isUnsanctionedHoldExit(e({ to: "parked" })), false);
  });

  test("the alert window is 7 days", () => {
    assert.equal(HOLD_EXIT_ALERT_WINDOW_DAYS, 7);
  });
});
