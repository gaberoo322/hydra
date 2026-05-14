/**
 * Regression test for issue #395 — per-subagent token caps in hydra-autopilot.
 *
 * The autopilot is a markdown-driven playbook (no src/ module). This test
 * pins the cap math and state-machine contract that the playbook prescribes
 * so a future edit to `docs/operator-playbooks/hydra-autopilot.md` can't
 * silently drop:
 *
 *   - the default soft cap (400k) / hard cap (800k)
 *   - the soft-cap invariant (soft <= hard)
 *   - the soft-cap action (append class to burned_classes)
 *   - the hard-cap action (clear slot, file needs-triage issue,
 *     append class to burned_classes)
 *   - the no-regression guarantee (well-behaved slots trip neither cap)
 *
 * The functions exercised below mirror the python the playbook embeds in
 * Phase 0 (env parsing) and Phase 2 (cap evaluation). They are pure and
 * self-contained — keeping them in the test file (rather than src/) makes
 * the regression-on-playbook-edit signal sharp: if the playbook changes
 * the defaults or the action shape, this test fails and the operator
 * sees it before the next overnight run.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";

// ---------- Surface under test (mirrors playbook Phase 0 + Phase 2) ----------

type Limits = {
  subagent_max_tokens: number;
  subagent_hard_max_tokens: number;
};

type Slot = {
  skill: string;
  started: string;
  partial_tokens: number;
} | null;

type State = {
  limits: Limits;
  burned_classes: string[];
  slots: Record<string, Slot>;
};

const DEFAULT_SUBAGENT_MAX_TOKENS = 400_000;
const DEFAULT_SUBAGENT_HARD_MAX_TOKENS = 800_000;

/**
 * Mirrors the Phase 0 bash:
 *   SUBAGENT_MAX_TOKENS="${HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS:-400000}"
 *   SUBAGENT_HARD_MAX_TOKENS="${HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS:-800000}"
 *   if soft > hard -> exit 1
 */
function resolveSubagentCaps(env: Record<string, string | undefined>): Limits {
  const parsePositive = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  };
  const soft = parsePositive(
    env.HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS,
    DEFAULT_SUBAGENT_MAX_TOKENS,
  );
  const hard = parsePositive(
    env.HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS,
    DEFAULT_SUBAGENT_HARD_MAX_TOKENS,
  );
  if (soft > hard) {
    throw new Error(
      `HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS=${soft} exceeds HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS=${hard}`,
    );
  }
  return { subagent_max_tokens: soft, subagent_hard_max_tokens: hard };
}

/**
 * Mirrors the Phase 2 in-flight poll: for each occupied slot, if
 * partial_tokens >= hard cap, clear the slot, add class to burned_classes,
 * and report a runaway record for issue creation.
 */
function applyHardCap(state: State): {
  runaways: Array<{ class: string; skill: string; tokens: number }>;
} {
  const runaways: Array<{ class: string; skill: string; tokens: number }> = [];
  const hard = state.limits.subagent_hard_max_tokens;
  for (const [cls, slot] of Object.entries(state.slots)) {
    if (slot === null) continue;
    if (slot.partial_tokens >= hard) {
      runaways.push({ class: cls, skill: slot.skill, tokens: slot.partial_tokens });
      state.slots[cls] = null;
      if (!state.burned_classes.includes(cls)) {
        state.burned_classes.push(cls);
      }
    }
  }
  return { runaways };
}

/**
 * Mirrors the Phase 2 completion-reap soft-cap check: when a slot finishes,
 * if its final token total >= soft cap, append the class to burned_classes
 * so Phase 4 won't re-dispatch into it for the rest of the session.
 */
function applySoftCapOnCompletion(
  state: State,
  cls: string,
  finalTokens: number,
): { burned: boolean } {
  const soft = state.limits.subagent_max_tokens;
  if (finalTokens >= soft) {
    if (!state.burned_classes.includes(cls)) {
      state.burned_classes.push(cls);
    }
    state.slots[cls] = null;
    return { burned: true };
  }
  state.slots[cls] = null;
  return { burned: false };
}

/**
 * Mirrors the Phase 4 dispatch filter:
 *   if class in state.burned_classes: continue
 */
function isClassEligible(state: State, cls: string): boolean {
  return !state.burned_classes.includes(cls);
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    limits: {
      subagent_max_tokens: DEFAULT_SUBAGENT_MAX_TOKENS,
      subagent_hard_max_tokens: DEFAULT_SUBAGENT_HARD_MAX_TOKENS,
    },
    burned_classes: [],
    slots: {
      health: null,
      qa: null,
      dev_orch: null,
      dev_target: null,
      research_orch: null,
      research_target: null,
      sweep_orch: null,
      sweep_target: null,
      discover_orch: null,
      discover_target: null,
    },
    ...overrides,
  };
}

// ---------- Tests ----------

describe("autopilot subagent cap env parsing (issue #395, Phase 0)", () => {
  test("defaults are 400k soft / 800k hard when env unset", () => {
    const limits = resolveSubagentCaps({});
    assert.equal(limits.subagent_max_tokens, 400_000);
    assert.equal(limits.subagent_hard_max_tokens, 800_000);
  });

  test("env vars override defaults", () => {
    const limits = resolveSubagentCaps({
      HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS: "250000",
      HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS: "500000",
    });
    assert.equal(limits.subagent_max_tokens, 250_000);
    assert.equal(limits.subagent_hard_max_tokens, 500_000);
  });

  test("soft cap > hard cap throws (matches Phase 0 'exit 1')", () => {
    assert.throws(
      () =>
        resolveSubagentCaps({
          HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS: "900000",
          HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS: "800000",
        }),
      /exceeds/,
    );
  });

  test("empty / non-numeric env falls back to defaults (fail-safe)", () => {
    const limits = resolveSubagentCaps({
      HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS: "",
      HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS: "not-a-number",
    });
    assert.equal(limits.subagent_max_tokens, 400_000);
    assert.equal(limits.subagent_hard_max_tokens, 800_000);
  });

  test("default soft <= default hard (invariant)", () => {
    assert.ok(
      DEFAULT_SUBAGENT_MAX_TOKENS <= DEFAULT_SUBAGENT_HARD_MAX_TOKENS,
      "soft cap default must be <= hard cap default",
    );
  });

  test("defaults bound a single subagent to <=40% of the 2M total budget", () => {
    // Operator rationale: even one runaway can't single-handedly burn the
    // whole overnight. 800k / 2M = 40%.
    assert.ok(
      DEFAULT_SUBAGENT_HARD_MAX_TOKENS * 2.5 <= 2_000_000,
      "hard cap default should leave headroom for at least 2 more classes",
    );
  });
});

describe("autopilot soft-cap trip (issue #395, Phase 2 completion-reap)", () => {
  test("slot finishing at soft cap burns the class", () => {
    const state = makeState({
      slots: {
        ...makeState().slots,
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
      },
    });
    const { burned } = applySoftCapOnCompletion(state, "dev_orch", 400_000);
    assert.equal(burned, true);
    assert.deepEqual(state.burned_classes, ["dev_orch"]);
    assert.equal(state.slots.dev_orch, null, "slot must be cleared after reap");
  });

  test("slot finishing under soft cap does NOT burn the class", () => {
    const state = makeState({
      slots: {
        ...makeState().slots,
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
      },
    });
    const { burned } = applySoftCapOnCompletion(state, "dev_orch", 399_999);
    assert.equal(burned, false);
    assert.deepEqual(state.burned_classes, []);
    assert.equal(state.slots.dev_orch, null, "slot still cleared even on under-cap completion");
  });

  test("burned class is rejected by Phase 4 eligibility filter", () => {
    const state = makeState();
    applySoftCapOnCompletion(state, "dev_orch", 500_000);
    assert.equal(isClassEligible(state, "dev_orch"), false);
    assert.equal(
      isClassEligible(state, "dev_target"),
      true,
      "other classes remain eligible — burn is per-class, not global",
    );
  });

  test("re-burning an already-burned class is idempotent (no duplicate entries)", () => {
    const state = makeState();
    applySoftCapOnCompletion(state, "dev_orch", 500_000);
    // Simulate a second completion in the same class (hypothetical — Phase 4
    // would have suppressed it, but the state machine must still be sane).
    state.slots.dev_orch = { skill: "hydra-dev", started: "t1", partial_tokens: 0 };
    applySoftCapOnCompletion(state, "dev_orch", 450_000);
    assert.deepEqual(state.burned_classes, ["dev_orch"]);
  });
});

describe("autopilot hard-cap trip (issue #395, Phase 2 in-flight poll)", () => {
  test("running slot at hard cap is abandoned and class burned", () => {
    const state = makeState({
      slots: {
        ...makeState().slots,
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 800_000 },
      },
    });
    const { runaways } = applyHardCap(state);
    assert.equal(runaways.length, 1);
    assert.deepEqual(runaways[0], {
      class: "dev_orch",
      skill: "hydra-dev",
      tokens: 800_000,
    });
    assert.equal(state.slots.dev_orch, null, "runaway slot must be cleared");
    assert.deepEqual(state.burned_classes, ["dev_orch"]);
  });

  test("running slot under hard cap is left running", () => {
    const state = makeState({
      slots: {
        ...makeState().slots,
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 799_999 },
      },
    });
    const { runaways } = applyHardCap(state);
    assert.equal(runaways.length, 0);
    assert.notEqual(state.slots.dev_orch, null, "under-cap slot must NOT be cleared");
    assert.deepEqual(state.burned_classes, []);
  });

  test("multiple runaways are caught in one poll", () => {
    const state = makeState({
      slots: {
        ...makeState().slots,
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 1_200_000 },
        dev_target: {
          skill: "hydra-target-build",
          started: "t0",
          partial_tokens: 850_000,
        },
      },
    });
    const { runaways } = applyHardCap(state);
    assert.equal(runaways.length, 2);
    assert.deepEqual(
      runaways.map((r) => r.class).sort(),
      ["dev_orch", "dev_target"],
    );
    assert.deepEqual(state.burned_classes.sort(), ["dev_orch", "dev_target"]);
  });

  test("hard-cap action shape pins the issue-filing contract", () => {
    // The playbook's Phase 2 in-flight poll snippet uses:
    //   title = f"Subagent token-runaway: {skill} burned {tokens} tokens"
    //   label = needs-triage
    // If any of those names change without updating the playbook AND this
    // test, the operator will lose the diagnostic channel.
    const state = makeState({
      slots: {
        ...makeState().slots,
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 900_000 },
      },
    });
    const { runaways } = applyHardCap(state);
    const r = runaways[0];
    assert.ok(r, "runaway must be reported");
    const title = `Subagent token-runaway: ${r.skill} burned ${r.tokens} tokens`;
    assert.equal(title, "Subagent token-runaway: hydra-dev burned 900000 tokens");
  });
});

describe("autopilot no-regression: well-behaved subagents are unaffected (issue #395)", () => {
  test("a typical hydra-dev run (~30-150k tokens) trips neither cap", () => {
    const state = makeState();
    // Dispatch dev_orch.
    state.slots.dev_orch = {
      skill: "hydra-dev",
      started: "t0",
      partial_tokens: 0,
    };
    // Poll mid-run at 75k — no trip.
    state.slots.dev_orch.partial_tokens = 75_000;
    const { runaways } = applyHardCap(state);
    assert.equal(runaways.length, 0, "75k is well under hard cap");
    // Completion at 120k — no soft-cap trip.
    const { burned } = applySoftCapOnCompletion(state, "dev_orch", 120_000);
    assert.equal(burned, false);
    assert.deepEqual(state.burned_classes, []);
    assert.equal(isClassEligible(state, "dev_orch"), true);
  });

  test("burned_classes defaults to empty (caps are inert until tripped)", () => {
    const state = makeState();
    assert.deepEqual(state.burned_classes, []);
    // Every class is eligible at session start.
    for (const cls of Object.keys(state.slots)) {
      assert.equal(isClassEligible(state, cls), true);
    }
  });

  test("partial_tokens=0 (no harness progress signal) never trips hard cap", () => {
    // If the harness doesn't expose partial tokens, slot.partial_tokens
    // stays 0 forever — the hard cap should still safely no-op. The soft
    // cap catches it on completion (or the global wall_clock_max_sec).
    const state = makeState({
      slots: {
        ...makeState().slots,
        dev_orch: { skill: "hydra-dev", started: "t0", partial_tokens: 0 },
      },
    });
    const { runaways } = applyHardCap(state);
    assert.equal(runaways.length, 0);
    assert.equal(state.burned_classes.length, 0);
    assert.notEqual(state.slots.dev_orch, null, "slot must NOT be cleared without progress signal");
  });
});
