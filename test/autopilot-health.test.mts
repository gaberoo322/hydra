/**
 * Regression tests for the autopilot-health aggregator (issue #890,
 * now-console-3).
 *
 * Three layers:
 *   1. The four pure heuristic functions (detectStalledDispatch,
 *      detectUnproductiveLoops, detectIdleStreak, detectIssuePrChurn) +
 *      rankSignals — no Redis, no clock.
 *   2. The getAutopilotHealth entrypoint's never-throw contract — a reader
 *      that rejects degrades to an empty contribution, the rest still ship.
 *   3. The GET /now/autopilot-health route handler — query validation
 *      (400 on bad input), response shape validates against the schema.
 *
 * Follows the test/now-page.test.mts pattern — wires the router with stubbed
 * aggregators and calls the handler directly. No live server, no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getAutopilotHealth,
  detectStalledDispatch,
  detectUnproductiveLoops,
  detectIdleStreak,
  detectIssuePrChurn,
  rankSignals,
  DEFAULT_HEALTH_THRESHOLDS,
  type LiveRunView,
  type RunDigest,
} from "../src/aggregators/autopilot-health.ts";
import { createNowPageRouter } from "../src/api/now-page.ts";
import {
  AutopilotHealthResponseSchema,
  StuckSignalSchema,
} from "../src/schemas/now-page.ts";

const T = DEFAULT_HEALTH_THRESHOLDS;

// ---------------------------------------------------------------------------
// Heuristic 1: stalled-dispatch
// ---------------------------------------------------------------------------

describe("detectStalledDispatch (issue #890)", () => {
  function liveRun(over: Partial<LiveRunView>): LiveRunView {
    return {
      run_id: "ap-1",
      status: "running",
      age_s: T.stalledDispatchAgeS + 60,
      turns: [{ turn_n: 5, actions: [{ type: "dispatch", outcome: null }] }],
      ...over,
    };
  }

  test("no live run → no signal", () => {
    assert.deepEqual(detectStalledDispatch(null, T), []);
  });

  test("terminal run → no signal", () => {
    assert.deepEqual(detectStalledDispatch(liveRun({ status: "ended" }), T), []);
  });

  test("running but within cadence window → no signal", () => {
    const sig = detectStalledDispatch(liveRun({ age_s: 10 }), T);
    assert.deepEqual(sig, []);
  });

  test("running, stale, open dispatch → warn signal", () => {
    const sig = detectStalledDispatch(liveRun({}), T);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "stalled-dispatch");
    assert.equal(sig[0].severity, "warn");
    assert.equal(sig[0].evidence.runId, "ap-1");
    assert.equal(sig[0].evidence.openDispatches, 1);
    assert.equal(StuckSignalSchema.safeParse(sig[0]).success, true);
  });

  test("age past 2x threshold → critical", () => {
    const sig = detectStalledDispatch(
      liveRun({ age_s: T.stalledDispatchAgeS * 2 + 1 }),
      T,
    );
    assert.equal(sig[0].severity, "critical");
  });

  test("latest turn has a RESOLVED dispatch → no signal", () => {
    const sig = detectStalledDispatch(
      liveRun({
        turns: [
          { turn_n: 5, actions: [{ type: "dispatch", outcome: { status: "merged" } }] },
        ],
      }),
      T,
    );
    assert.deepEqual(sig, []);
  });

  test("latest turn has no dispatch action → no signal", () => {
    const sig = detectStalledDispatch(
      liveRun({ turns: [{ turn_n: 5, actions: [{ type: "noop" }] }] }),
      T,
    );
    assert.deepEqual(sig, []);
  });

  test("no turns → no signal", () => {
    const sig = detectStalledDispatch(liveRun({ turns: [] }), T);
    assert.deepEqual(sig, []);
  });
});

// ---------------------------------------------------------------------------
// Heuristic 2: unproductive-loop
// ---------------------------------------------------------------------------

describe("detectUnproductiveLoops (issue #890)", () => {
  test("too few dispatches → no signal", () => {
    const history: RunDigest[] = [{ dispatches: 1, merged_count: 0, failed_count: 1 }];
    assert.deepEqual(detectUnproductiveLoops(history, T), []);
  });

  test("any merge in window → no signal (window is productive)", () => {
    const history: RunDigest[] = [
      { dispatches: 3, merged_count: 1, failed_count: 2 },
      { dispatches: 2, merged_count: 0, failed_count: 2 },
    ];
    assert.deepEqual(detectUnproductiveLoops(history, T), []);
  });

  test("enough dispatches, zero merged, low fail ratio → warn", () => {
    const history: RunDigest[] = [
      { dispatches: 2, merged_count: 0, failed_count: 1 },
      { dispatches: 2, merged_count: 0, failed_count: 0 },
    ];
    const sig = detectUnproductiveLoops(history, T);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "unproductive-loop");
    assert.equal(sig[0].severity, "warn");
    assert.equal(sig[0].evidence.dispatches, 4);
    assert.equal(sig[0].evidence.merged, 0);
  });

  test("zero merged + high fail ratio → critical", () => {
    const history: RunDigest[] = [
      { dispatches: 4, merged_count: 0, failed_count: 4 },
    ];
    const sig = detectUnproductiveLoops(history, T);
    assert.equal(sig[0].severity, "critical");
  });

  test("string-typed numeric fields are coerced", () => {
    const history: RunDigest[] = [
      { dispatches: "3", merged_count: "0", failed_count: "3" } as unknown as RunDigest,
    ];
    const sig = detectUnproductiveLoops(history, T);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].evidence.dispatches, 3);
  });
});

// ---------------------------------------------------------------------------
// Heuristic 3: idle-streak
// ---------------------------------------------------------------------------

describe("detectIdleStreak (issue #890)", () => {
  test("short streak → no signal", () => {
    const history: RunDigest[] = [
      { term_reason: "idle", dispatches: 0 },
      { term_reason: "budget", dispatches: 2 },
    ];
    assert.deepEqual(detectIdleStreak(history, T), []);
  });

  test("leading idle streak at threshold → warn", () => {
    const history: RunDigest[] = [
      { term_reason: "idle", dispatches: 0 },
      { dispatches: 0 }, // no-op run also counts
      { term_reason: "idle", dispatches: 0 },
      { dispatches: 5, merged_count: 1 }, // breaks the streak
    ];
    const sig = detectIdleStreak(history, T);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "idle-streak");
    assert.equal(sig[0].severity, "warn");
    assert.equal(sig[0].evidence.streak, 3);
  });

  test("long streak → critical", () => {
    const history: RunDigest[] = Array.from({ length: 5 }, () => ({
      term_reason: "idle",
      dispatches: 0,
    }));
    const sig = detectIdleStreak(history, T);
    assert.equal(sig[0].severity, "critical");
    assert.equal(sig[0].evidence.streak, 5);
  });

  test("streak broken at the newest end → no signal even if older runs idle", () => {
    const history: RunDigest[] = [
      { dispatches: 3, merged_count: 1 }, // newest, productive
      { term_reason: "idle", dispatches: 0 },
      { term_reason: "idle", dispatches: 0 },
      { term_reason: "idle", dispatches: 0 },
    ];
    assert.deepEqual(detectIdleStreak(history, T), []);
  });
});

// ---------------------------------------------------------------------------
// Heuristic 4: issue-pr-churn
// ---------------------------------------------------------------------------

describe("detectIssuePrChurn (issue #890)", () => {
  test("ref recurring below threshold → no signal", () => {
    const history: RunDigest[] = [
      { issue_ref: "issue-42", merged_count: 0 } as unknown as RunDigest,
      { issue_ref: "issue-42", merged_count: 0 } as unknown as RunDigest,
    ];
    assert.deepEqual(detectIssuePrChurn(history, T), []);
  });

  test("ref recurring at threshold without merge → warn", () => {
    const history: RunDigest[] = Array.from({ length: 3 }, () => ({
      issue_ref: "issue-42",
      merged_count: 0,
    })) as unknown as RunDigest[];
    const sig = detectIssuePrChurn(history, T);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].type, "issue-pr-churn");
    assert.equal(sig[0].severity, "warn");
    assert.equal(sig[0].evidence.ref, "issue-42");
    assert.equal(sig[0].evidence.recurrences, 3);
  });

  test("a merge on any run carrying the ref → not churn", () => {
    const history: RunDigest[] = [
      { issue_ref: "issue-42", merged_count: 0 },
      { issue_ref: "issue-42", merged_count: 0 },
      { issue_ref: "issue-42", merged_count: 1 },
    ] as unknown as RunDigest[];
    assert.deepEqual(detectIssuePrChurn(history, T), []);
  });

  test("high recurrence → critical, sorted most-churned first", () => {
    const history: RunDigest[] = [
      ...Array.from({ length: 5 }, () => ({ pr_ref: "pr-7", merged_count: 0 })),
      ...Array.from({ length: 3 }, () => ({ issue_ref: "issue-9", merged_count: 0 })),
    ] as unknown as RunDigest[];
    const sig = detectIssuePrChurn(history, T);
    assert.equal(sig.length, 2);
    assert.equal(sig[0].evidence.ref, "pr-7");
    assert.equal(sig[0].severity, "critical");
    assert.equal(sig[1].evidence.ref, "issue-9");
    assert.equal(sig[1].severity, "warn");
  });
});

// ---------------------------------------------------------------------------
// rankSignals
// ---------------------------------------------------------------------------

describe("rankSignals (issue #890)", () => {
  test("critical → warn → info, ties broken by type", () => {
    const ranked = rankSignals([
      { type: "idle-streak", severity: "warn", summary: "", evidence: {} },
      { type: "issue-pr-churn", severity: "critical", summary: "", evidence: {} },
      { type: "stalled-dispatch", severity: "info", summary: "", evidence: {} },
      { type: "unproductive-loop", severity: "critical", summary: "", evidence: {} },
    ]);
    assert.deepEqual(
      ranked.map((s) => `${s.severity}:${s.type}`),
      [
        "critical:issue-pr-churn",
        "critical:unproductive-loop",
        "warn:idle-streak",
        "info:stalled-dispatch",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// getAutopilotHealth — never-throw contract + composition
// ---------------------------------------------------------------------------

describe("getAutopilotHealth — never-throw + composition (issue #890)", () => {
  test("a rejecting reader degrades to empty contribution; the rest still ship", async () => {
    const signals = await getAutopilotHealth({
      readLiveRun: async () => {
        throw new Error("redis down");
      },
      readRecentRuns: async () => [
        { term_reason: "idle", dispatches: 0 },
        { term_reason: "idle", dispatches: 0 },
        { term_reason: "idle", dispatches: 0 },
      ],
    });
    // live-run reader threw → no stalled signal, but the idle-streak from the
    // history reader still ships.
    assert.equal(signals.some((s) => s.type === "idle-streak"), true);
    assert.equal(signals.some((s) => s.type === "stalled-dispatch"), false);
  });

  test("both readers empty → empty signal list (never throws)", async () => {
    const signals = await getAutopilotHealth({
      readLiveRun: async () => null,
      readRecentRuns: async () => [],
    });
    assert.deepEqual(signals, []);
  });

  test("composes + ranks signals across both sources", async () => {
    const signals = await getAutopilotHealth({
      readLiveRun: async () => ({
        run_id: "ap-live",
        status: "running",
        age_s: T.stalledDispatchAgeS * 2 + 10, // critical
        turns: [{ turn_n: 1, actions: [{ type: "dispatch", outcome: null }] }],
      }),
      readRecentRuns: async () => [
        { dispatches: 4, merged_count: 0, failed_count: 4 }, // unproductive critical
      ],
    });
    // The critical signals come first.
    assert.ok(signals.length >= 2);
    assert.equal(signals[0].severity, "critical");
    assert.equal(AutopilotHealthResponseSchema.safeParse({
      signals,
      historyWindow: 14,
      generatedAt: new Date().toISOString(),
    }).success, true);
  });
});

// ---------------------------------------------------------------------------
// GET /now/autopilot-health route handler
// ---------------------------------------------------------------------------

function mockReq(query: Record<string, unknown> = {}): any {
  return { method: "GET", url: "/x", headers: {}, query, params: {}, body: {} };
}
function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
    send(body: any) { res._body = body; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return res;
}
function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

describe("GET /now/autopilot-health route (issue #890)", () => {
  test("returns ranked signals + validates against schema", async () => {
    const router = createNowPageRouter({
      getAutopilotHealth: async () => [
        { type: "idle-streak", severity: "warn", summary: "3 idle runs", evidence: { streak: 3 } },
      ],
      now: () => new Date("2026-06-02T12:00:00.000Z"),
    });
    const handler = findHandler(router, "GET", "/now/autopilot-health");
    assert.ok(handler);
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 200);
    assert.equal(res._body.signals.length, 1);
    assert.equal(res._body.historyWindow, 14);
    assert.equal(res._body.generatedAt, "2026-06-02T12:00:00.000Z");
    assert.equal(AutopilotHealthResponseSchema.safeParse(res._body).success, true);
  });

  test("passes a validated historyWindow through to the aggregator", async () => {
    let seen = -1;
    const router = createNowPageRouter({
      getAutopilotHealth: async (deps) => {
        seen = deps?.historyWindow ?? -1;
        return [];
      },
    });
    const handler = findHandler(router, "GET", "/now/autopilot-health");
    const res = mockRes();
    await handler!(mockReq({ historyWindow: "30" }), res);
    assert.equal(res._status, 200);
    assert.equal(seen, 30);
    assert.equal(res._body.historyWindow, 30);
  });

  test("bad query → 400 schema-validation-failed", async () => {
    const router = createNowPageRouter({
      getAutopilotHealth: async () => [],
    });
    const handler = findHandler(router, "GET", "/now/autopilot-health");
    const res = mockRes();
    await handler!(mockReq({ historyWindow: "not-a-number" }), res);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
  });

  test("aggregator throwing → 500, handler does not propagate", async () => {
    const router = createNowPageRouter({
      getAutopilotHealth: async () => {
        throw new Error("boom");
      },
    });
    const handler = findHandler(router, "GET", "/now/autopilot-health");
    const res = mockRes();
    await handler!(mockReq(), res);
    assert.equal(res._status, 500);
  });
});
