/**
 * Regression tests for research-to-build ratio throttle (issue #84).
 *
 * Bug: Research cycles ran unthrottled (164 research vs ~50 builds),
 * creating a growing backlog of stale opportunities. The throttle
 * suppresses research when:
 * 1. Queue depth >= threshold (default 6)
 * 2. Research-to-build ratio exceeds max (default 3:1 rolling 24h)
 *
 * After the scheduler/research-decision split, the pure policy lives
 * in `src/scheduler/research-decision.ts::decideResearchAction`. These
 * tests target the decision function directly — the same policy that
 * production now consults, so coverage is no longer hypothetical.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideResearchAction,
  type ResearchSnapshot,
} from "../src/scheduler/research-decision.ts";

/**
 * Build a snapshot that, with all defaults, decides "run / queue-low".
 * Each test overrides only the fields it cares about.
 */
function snapshot(overrides: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
  return {
    forced: false,
    queueLen: 0,
    queueLenTotal: 0,
    orphanLen: 0,
    researchCount24h: 0,
    buildCount24h: 0,
    ratio: 0,
    floor: { shouldFire: false, reason: null },
    lastResearchAtMs: null,
    researchMinIntervalMs: 2 * 60 * 60 * 1000,
    nowMs: 1_700_000_000_000,
    dailySpend: { usd: 0, date: "2026-05-25", source: "none" },
    dailySpendCap: Infinity,
    backlog: { total: 0, queued: 0, inProgress: 0 },
    queueThreshold: 6,
    ratioMax: 3,
    lowWatermark: 3,
    ...overrides,
  };
}

describe("decideResearchAction — queue depth gate", () => {
  test("suppresses when queue depth equals threshold", () => {
    const action = decideResearchAction(snapshot({ queueLen: 6 }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip") {
      assert.equal(action.reason, "queue-not-low");
      assert.equal(action.queueLen, 6);
      assert.equal(action.threshold, 6);
    }
  });

  test("suppresses when queue depth exceeds threshold", () => {
    const action = decideResearchAction(snapshot({ queueLen: 10 }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip") assert.equal(action.reason, "queue-not-low");
  });

  test("does not suppress when queue depth is below threshold", () => {
    const action = decideResearchAction(snapshot({ queueLen: 2 }));
    assert.notEqual(action.kind, "skip");
  });
});

describe("decideResearchAction — ratio gate", () => {
  test("suppresses when ratio exceeds max", () => {
    const action = decideResearchAction(snapshot({ researchCount24h: 4, buildCount24h: 0, ratio: 4 }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip" && action.reason === "ratio-cap") {
      assert.equal(action.ratio, 4);
      assert.equal(action.max, 3);
    } else {
      assert.fail(`expected skip:ratio-cap, got ${JSON.stringify(action)}`);
    }
  });

  test("ratio = research/build when both > 0", () => {
    // 10/2 = 5 > 3 → suppress
    const action = decideResearchAction(snapshot({ researchCount24h: 10, buildCount24h: 2, ratio: 5 }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip") assert.equal(action.reason, "ratio-cap");
  });

  test("ratio under max passes", () => {
    // 6/2 = 3, not > 3
    const action = decideResearchAction(snapshot({ researchCount24h: 6, buildCount24h: 2, ratio: 3 }));
    assert.notEqual(action.kind, "skip");
  });

  test("ratio gate doesn't fire when no research has run today", () => {
    // The guard is `researchCount24h > 0 && ratio > max`. With 0 research,
    // we're not over the cap regardless of build count.
    const action = decideResearchAction(snapshot({ researchCount24h: 0, buildCount24h: 5, ratio: 0 }));
    assert.notEqual(action.kind, "skip");
  });
});

describe("decideResearchAction — defaults", () => {
  test("threshold default is 6", () => {
    const action = decideResearchAction(snapshot({ queueLen: 6 }));
    assert.equal(action.kind, "skip");
  });

  test("ratio default is 3", () => {
    const action = decideResearchAction(snapshot({ researchCount24h: 4, buildCount24h: 1, ratio: 4 }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip") assert.equal(action.reason, "ratio-cap");
  });
});

describe("decideResearchAction — force-once override", () => {
  test("force-once bypasses queue + ratio + watermark gates", () => {
    const action = decideResearchAction(snapshot({
      forced: true,
      queueLen: 10,
      researchCount24h: 20,
      buildCount24h: 1,
      ratio: 20,
    }));
    assert.equal(action.kind, "force-once");
  });

  test("force-once still wins over spend-cap and throttle", () => {
    const action = decideResearchAction(snapshot({
      forced: true,
      dailySpend: { usd: 999, date: "2026-05-25", source: "mixed" },
      dailySpendCap: 50,
      lastResearchAtMs: 1_700_000_000_000 - 1000,
    }));
    assert.equal(action.kind, "force-once");
  });
});

describe("decideResearchAction — capacity floor override", () => {
  test("floor.shouldFire overrides queue-depth suppression", () => {
    const action = decideResearchAction(snapshot({
      queueLen: 10,
      floor: { shouldFire: true, reason: "ratio-min 0.2" },
    }));
    assert.equal(action.kind, "run");
    if (action.kind === "run") {
      assert.equal(action.reason, "floor-fire");
      assert.equal(action.floorReason, "ratio-min 0.2");
    }
  });

  test("floor.shouldFire overrides ratio-cap suppression", () => {
    const action = decideResearchAction(snapshot({
      researchCount24h: 10, buildCount24h: 1, ratio: 10,
      floor: { shouldFire: true, reason: "silence-window" },
    }));
    assert.equal(action.kind, "run");
    if (action.kind === "run") assert.equal(action.reason, "floor-fire");
  });

  test("floor.shouldFire overrides low-watermark suppression", () => {
    const action = decideResearchAction(snapshot({
      queueLen: 4,
      floor: { shouldFire: true, reason: "ratio-min" },
    }));
    assert.equal(action.kind, "run");
    if (action.kind === "run") assert.equal(action.reason, "floor-fire");
  });

  test("floor.shouldFire skips backlog promotion (floor's job is to run research)", () => {
    const action = decideResearchAction(snapshot({
      queueLen: 0,
      backlog: { total: 5, queued: 0, inProgress: 0 },
      floor: { shouldFire: true, reason: "silence-window" },
    }));
    assert.equal(action.kind, "run");
    if (action.kind === "run") assert.equal(action.reason, "floor-fire");
  });

  test("spend-cap still wins over floor", () => {
    const action = decideResearchAction(snapshot({
      floor: { shouldFire: true, reason: "ratio-min" },
      dailySpend: { usd: 100, date: "2026-05-25", source: "mixed" },
      dailySpendCap: 50,
    }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip") assert.equal(action.reason, "spend-cap");
  });
});

describe("decideResearchAction — backlog promotion", () => {
  test("prefers backlog promotion when queue is low and backlog has items", () => {
    const action = decideResearchAction(snapshot({
      queueLen: 0,
      backlog: { total: 5, queued: 0, inProgress: 0 },
    }));
    assert.equal(action.kind, "promote-backlog");
    if (action.kind === "promote-backlog") {
      assert.equal(action.needed, 6);
      assert.equal(action.queueLen, 0);
      assert.equal(action.backlogAvailable, 5);
    }
  });

  test("falls through to throttle/run when backlog is empty", () => {
    const action = decideResearchAction(snapshot({
      queueLen: 0,
      backlog: { total: 0, queued: 0, inProgress: 0 },
    }));
    assert.equal(action.kind, "run");
  });

  test("re-decide with skipBacklogPromotion bypasses promotion branch", () => {
    const snap = snapshot({
      queueLen: 0,
      backlog: { total: 5, queued: 0, inProgress: 0 },
    });
    const first = decideResearchAction(snap);
    assert.equal(first.kind, "promote-backlog");
    const second = decideResearchAction(snap, { skipBacklogPromotion: true });
    assert.equal(second.kind, "run");
  });
});

describe("decideResearchAction — low-watermark gate", () => {
  test("suppresses when queue depth >= low-watermark but < threshold", () => {
    // queue=3 is below threshold (6) but >= low-watermark (3)
    const action = decideResearchAction(snapshot({ queueLen: 3 }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip") {
      assert.equal(action.reason, "low-watermark");
      assert.equal(action.watermark, 3);
    }
  });

  test("does not fire below low-watermark", () => {
    const action = decideResearchAction(snapshot({ queueLen: 2 }));
    assert.notEqual(action.kind, "skip");
  });
});

describe("decideResearchAction — throttle gate", () => {
  test("suppresses when within minIntervalMs of last research", () => {
    const action = decideResearchAction(snapshot({
      lastResearchAtMs: 1_700_000_000_000 - 60_000, // 1 minute ago
      researchMinIntervalMs: 2 * 60 * 60 * 1000, // 2h
    }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip" && action.reason === "throttled") {
      assert.ok(action.remainingMs > 0);
      assert.ok(action.remainingMs < action.minIntervalMs);
    } else {
      assert.fail(`expected skip:throttled, got ${JSON.stringify(action)}`);
    }
  });

  test("does not throttle when min interval has elapsed", () => {
    const action = decideResearchAction(snapshot({
      lastResearchAtMs: 1_700_000_000_000 - 3 * 60 * 60 * 1000, // 3h ago
      researchMinIntervalMs: 2 * 60 * 60 * 1000, // 2h
    }));
    assert.equal(action.kind, "run");
  });

  test("does not throttle on cold start (lastResearchAtMs = null)", () => {
    const action = decideResearchAction(snapshot({ lastResearchAtMs: null }));
    assert.equal(action.kind, "run");
  });
});

describe("decideResearchAction — spend cap gate", () => {
  test("suppresses when daily spend >= cap and carries the source through", () => {
    const action = decideResearchAction(snapshot({
      dailySpend: { usd: 55, date: "2026-05-25", source: "autopilot-surrogate" },
      dailySpendCap: 50,
    }));
    assert.equal(action.kind, "skip");
    if (action.kind === "skip" && action.reason === "spend-cap") {
      assert.equal(action.spentUsd, 55);
      assert.equal(action.capUsd, 50);
      // Source flows from the surrogate snapshot through into the verdict
      // so operators can see which accounting stream tripped the gate
      // without re-reading env vars.
      assert.equal(action.source, "autopilot-surrogate");
    } else {
      assert.fail(`expected skip:spend-cap, got ${JSON.stringify(action)}`);
    }
  });

  test("source 'none' surfaces when neither writer has contributed", () => {
    // The realistic post-cutover default: HYDRA_TOKEN_USD_RATE unset AND
    // no legacy recordSpend has fired today → the gate effectively reports
    // "zero spend from no known source", which matches the pre-PR behavior
    // where the gate was silently disabled.
    const action = decideResearchAction(snapshot({
      dailySpend: { usd: 200, date: "2026-05-25", source: "none" },
      dailySpendCap: 50,
    }));
    if (action.kind === "skip" && action.reason === "spend-cap") {
      assert.equal(action.source, "none");
    } else {
      assert.fail(`expected skip:spend-cap, got ${JSON.stringify(action)}`);
    }
  });

  test("does not suppress when spend below cap", () => {
    const action = decideResearchAction(snapshot({
      dailySpend: { usd: 10, date: "2026-05-25", source: "autopilot-surrogate" },
      dailySpendCap: 50,
    }));
    assert.equal(action.kind, "run");
  });

  test("cap of Infinity disables the gate", () => {
    const action = decideResearchAction(snapshot({
      dailySpend: { usd: 9999, date: "2026-05-25", source: "mixed" },
      dailySpendCap: Infinity,
    }));
    assert.equal(action.kind, "run");
  });
});

describe("decideResearchAction — run reason", () => {
  test("queue-low when queue is below all gates and no floor fire", () => {
    const action = decideResearchAction(snapshot({ queueLen: 0 }));
    assert.equal(action.kind, "run");
    if (action.kind === "run") {
      assert.equal(action.reason, "queue-low");
      assert.equal(action.queueLen, 0);
      assert.equal(action.floorReason, undefined);
    }
  });

  test("floor-fire when floor demands it (queue can be anything)", () => {
    const action = decideResearchAction(snapshot({
      queueLen: 8,
      floor: { shouldFire: true, reason: "starvation" },
    }));
    assert.equal(action.kind, "run");
    if (action.kind === "run") {
      assert.equal(action.reason, "floor-fire");
      assert.equal(action.floorReason, "starvation");
    }
  });
});

describe("scheduler env-knob exports preserved", () => {
  test("RESEARCH_QUEUE_THRESHOLD and RESEARCH_BUILD_RATIO_MAX still exported", async () => {
    const mod = await import("../src/scheduler/loop.ts");
    assert.equal(typeof mod.RESEARCH_QUEUE_THRESHOLD, "number");
    assert.equal(typeof mod.RESEARCH_BUILD_RATIO_MAX, "number");
  });
});
