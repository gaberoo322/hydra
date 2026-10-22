/**
 * test/now-recommendations.test.mts — covers the pure now-recommendations
 * aggregator leaf (`src/aggregators/now-recommendations.ts`, issue #3570).
 *
 * These assert on the aggregator's TYPED result shapes (which recs survive a
 * mute/dismiss filter, what a dismissal / mute returns, how a missing current
 * run degrades) with injected in-memory deps — no HTTP layer, no Redis. The
 * companion `test/recommendations-api.test.mts` still exercises the thin route
 * adapters that call these entrypoints.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getActiveRecommendations,
  dismissRecommendationForRun,
  muteSeverityClassForRun,
  filterActiveRecommendations,
  resolveRunId,
  type NowRecommendationsDeps,
  type RecommendationsReaderDeps,
  type CurrentRunIdReader,
} from "../src/aggregators/now-recommendations.ts";

// ---------------------------------------------------------------------------
// In-memory rec storage facade (mirrors recommendations-api.test.mts)
// ---------------------------------------------------------------------------

interface RecRow {
  id: string;
  severity: "info" | "warn" | "critical";
  message: string;
  evidence_id: string;
  run_id: string;
  created_at: string;
}

function makeRecsFake(
  initial: {
    recs?: Record<string, RecRow[]>;
    dismissed?: Record<string, string[]>;
    muted?: Record<string, string[]>;
  } = {},
): { redis: RecommendationsReaderDeps; state: any } {
  const state = {
    recs: new Map<string, Map<string, string>>(),
    dismissed: new Map<string, Set<string>>(),
    muted: new Map<string, Set<string>>(),
  };
  for (const [runId, rows] of Object.entries(initial.recs ?? {})) {
    const h = new Map<string, string>();
    for (const r of rows) h.set(r.id, JSON.stringify(r));
    state.recs.set(runId, h);
  }
  for (const [runId, ids] of Object.entries(initial.dismissed ?? {})) {
    state.dismissed.set(runId, new Set(ids));
  }
  for (const [runId, sevs] of Object.entries(initial.muted ?? {})) {
    state.muted.set(runId, new Set(sevs));
  }

  const redis: RecommendationsReaderDeps = {
    async getAllRecommendations(runId) {
      const h = state.recs.get(runId);
      if (!h) return {};
      return Object.fromEntries(h);
    },
    async getDismissedSet(runId) {
      return Array.from(state.dismissed.get(runId) ?? []);
    },
    async getMutedClassesSet(runId) {
      return Array.from(state.muted.get(runId) ?? []);
    },
    async dismissRecommendation(runId, recId) {
      const s = state.dismissed.get(runId) ?? new Set<string>();
      s.add(recId);
      state.dismissed.set(runId, s);
    },
    async muteSeverityClass(runId, severity) {
      const s = state.muted.get(runId) ?? new Set<string>();
      s.add(severity);
      state.muted.set(runId, s);
    },
  };

  return { redis, state };
}

function rec(overrides: Partial<RecRow> = {}): RecRow {
  return {
    id: "run-A:1:0",
    severity: "info",
    message: "test rec",
    evidence_id: "turn:1",
    run_id: "run-A",
    created_at: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(
  redis: RecommendationsReaderDeps,
  readCurrentRunId: CurrentRunIdReader,
  nowIso = "2026-05-28T00:00:30.000Z",
): NowRecommendationsDeps {
  return {
    recsRedis: redis,
    readCurrentRunId,
    now: () => new Date(nowIso),
    ttlSeconds: 3600,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (re-homed to the aggregator leaf)
// ---------------------------------------------------------------------------

describe("aggregator: filterActiveRecommendations", () => {
  test("returns parsed recs newest-first by created_at", () => {
    const rawHash = {
      a: JSON.stringify(rec({ id: "a", created_at: "2026-05-28T00:00:00Z" })),
      b: JSON.stringify(rec({ id: "b", created_at: "2026-05-28T00:00:10Z" })),
      c: JSON.stringify(rec({ id: "c", created_at: "2026-05-28T00:00:05Z" })),
    };
    const out = filterActiveRecommendations({ rawHash, dismissed: [], muted: [] });
    assert.deepEqual(
      out.map((r) => r.id),
      ["b", "c", "a"],
    );
  });

  test("skips unparseable rows without throwing", () => {
    const rawHash = {
      a: "not json{",
      b: JSON.stringify(rec({ id: "b" })),
    };
    const out = filterActiveRecommendations({ rawHash, dismissed: [], muted: [] });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "b");
  });
});

describe("aggregator: resolveRunId", () => {
  test("'current' delegates to the reader; explicit is verbatim", async () => {
    const reader: CurrentRunIdReader = async () => "run-LIVE";
    assert.equal(await resolveRunId("current", reader), "run-LIVE");
    assert.equal(await resolveRunId("run-X", reader), "run-X");
  });
});

// ---------------------------------------------------------------------------
// getActiveRecommendations
// ---------------------------------------------------------------------------

describe("aggregator: getActiveRecommendations", () => {
  test("returns active recs newest-first with a resolved run_id and clock stamp", async () => {
    const { redis } = makeRecsFake({
      recs: {
        "run-A": [
          rec({ id: "a", created_at: "2026-05-28T00:00:00Z" }),
          rec({ id: "b", created_at: "2026-05-28T00:00:10Z" }),
        ],
      },
    });
    const result = await getActiveRecommendations(
      "current",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.run_id, "run-A");
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].id, "b");
    assert.equal(result.generatedAt, "2026-05-28T00:00:30.000Z");
  });

  test("degrades to an empty list with run_id null when no current run", async () => {
    const { redis } = makeRecsFake();
    const result = await getActiveRecommendations(
      "current",
      makeDeps(redis, async () => null),
    );
    assert.equal(result.run_id, null);
    assert.deepEqual(result.items, []);
  });

  test("applies the dismissal + muting policy", async () => {
    const { redis } = makeRecsFake({
      recs: {
        "run-A": [
          rec({ id: "a", severity: "info" }),
          rec({ id: "b", severity: "warn" }),
          rec({ id: "c", severity: "critical" }),
        ],
      },
      dismissed: { "run-A": ["c"] },
      muted: { "run-A": ["info"] },
    });
    const result = await getActiveRecommendations(
      "current",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].id, "b");
  });
});

// ---------------------------------------------------------------------------
// dismissRecommendationForRun
// ---------------------------------------------------------------------------

describe("aggregator: dismissRecommendationForRun", () => {
  test("records the dismissal and returns the canonical run_id", async () => {
    const { redis, state } = makeRecsFake({
      recs: { "run-A": [rec({ id: "a" })] },
    });
    const result = await dismissRecommendationForRun(
      "current",
      "a",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.run_id, "run-A");
      assert.equal(result.rec_id, "a");
      assert.equal(result.dismissed, true);
    }
    assert.ok(state.dismissed.get("run-A")?.has("a"));
  });

  test("returns run_missing when 'current' resolves to no run", async () => {
    const { redis } = makeRecsFake();
    const result = await dismissRecommendationForRun(
      "current",
      "a",
      makeDeps(redis, async () => null),
    );
    assert.equal(result.kind, "run_missing");
  });
});

// ---------------------------------------------------------------------------
// muteSeverityClassForRun
// ---------------------------------------------------------------------------

describe("aggregator: muteSeverityClassForRun", () => {
  test("records the mute against the resolved run", async () => {
    const { redis, state } = makeRecsFake();
    const result = await muteSeverityClassForRun(
      "current",
      "warn",
      makeDeps(redis, async () => "run-A"),
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.run_id, "run-A");
      assert.equal(result.severity, "warn");
      assert.equal(result.muted, true);
    }
    assert.ok(state.muted.get("run-A")?.has("warn"));
  });

  test("honours an explicit run_id without consulting the reader", async () => {
    const { redis, state } = makeRecsFake();
    let readerCalled = false;
    const result = await muteSeverityClassForRun(
      "run-X",
      "critical",
      makeDeps(redis, async () => {
        readerCalled = true;
        return "should-not-resolve";
      }),
    );
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") assert.equal(result.run_id, "run-X");
    assert.equal(readerCalled, false);
    assert.ok(state.muted.get("run-X")?.has("critical"));
  });

  test("returns run_missing when 'current' resolves to no run", async () => {
    const { redis } = makeRecsFake();
    const result = await muteSeverityClassForRun(
      "current",
      "warn",
      makeDeps(redis, async () => null),
    );
    assert.equal(result.kind, "run_missing");
  });
});

// ===========================================================================
// Issue #4634 (design-concept a7e7fedb INV-2/4/9/10/11) — the /now
// RecommendationsPanel: the route contract it relies on (HTTP, injected
// deps) plus source pins for the JSX half (no JSX runner in this suite).
// ===========================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createNowRecommendationsRouter } from "../src/api/now-recommendations.ts";

const REPO_ROOT_4634 = fileURLToPath(new URL("..", import.meta.url));
const readRepo4634 = (rel: string) => readFileSync(join(REPO_ROOT_4634, rel), "utf8");
const PANEL = "dashboard/src/pages/now-console/RecommendationsPanel.jsx";

function routeHandler(router: any, method: string, path: string): Function {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method.toLowerCase()]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`no ${method} ${path} handler`);
}

function fakeRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
  };
  return res;
}

describe("#4634 — the recommendation routes the /now panel writes through", () => {
  test("mute-class accepts exactly info | warn | critical — the panel's hard-coded vocabulary", async () => {
    const { redis } = makeRecsFake();
    const router = createNowRecommendationsRouter({ recsRedis: redis, readCurrentRunId: async () => "run-A" });
    const mute = routeHandler(router, "POST", "/now/recommendations/mute-class");
    for (const severity of ["info", "warn", "critical"]) {
      const res = fakeRes();
      await mute({ body: { run_id: "run-A", severity }, params: {}, query: {} }, res);
      assert.equal(res._status, 200, `${severity} is accepted`);
      assert.equal(res._body.muted, true);
    }
    const bad = fakeRes();
    await mute({ body: { run_id: "run-A", severity: "error" }, params: {}, query: {} }, bad);
    assert.equal(bad._status, 400, "a severity outside the closed enum is rejected");
  });

  test("a dismiss carrying the GET's run_id lands on THAT run even after 'current' rolls over", async () => {
    const { redis, state } = makeRecsFake({ recs: { "run-A": [rec({ id: "run-A:1:0" })] } });
    let current = "run-A";
    const router = createNowRecommendationsRouter({ recsRedis: redis, readCurrentRunId: async () => current });
    const read = fakeRes();
    await routeHandler(router, "GET", "/now/recommendations")({ query: {}, params: {}, body: {} }, read);
    assert.equal(read._body.run_id, "run-A", "the GET resolves and RETURNS the concrete run id");
    current = "run-B"; // a new run starts between the read and the click
    const res = fakeRes();
    await routeHandler(router, "POST", "/now/recommendations/:id/dismiss")(
      { params: { id: "run-A:1:0" }, body: { run_id: read._body.run_id }, query: {} },
      res,
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.run_id, "run-A");
    assert.ok(state.dismissed.get("run-A")?.has("run-A:1:0"), "the write targets the run the panel read");
    assert.equal(state.dismissed.get("run-B"), undefined, "the new run is untouched");
  });

  test("a missing current run reads as run_id null — the panel's explicit no-run evidence", async () => {
    const { redis } = makeRecsFake();
    const router = createNowRecommendationsRouter({ recsRedis: redis, readCurrentRunId: async () => null });
    const res = fakeRes();
    await routeHandler(router, "GET", "/now/recommendations")({ query: {}, params: {}, body: {} }, res);
    assert.equal(res._body.run_id, null);
    assert.deepEqual(res._body.items, []);
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
  });
});

describe("#4634 — RecommendationsPanel source pins", () => {
  test("the panel is the single owner of the GET and both POST literals; NowConsole only mounts it", () => {
    const src = readRepo4634(PANEL);
    assert.match(src, /usePageItems\(\s*"\/now\/recommendations"/, "the GET rides usePageItems");
    assert.ok(src.includes("apiFetch(`/now/recommendations/${encodeURIComponent(rec.id)}/dismiss`"), "dismiss POST literal");
    assert.ok(src.includes('writeMute("/now/recommendations/mute-class"'), "mute-class POST literal");
    const shell = readRepo4634("dashboard/src/pages/now-console/NowConsole.jsx");
    assert.ok(!shell.includes("/now/recommendations"), "NowConsole.jsx owns no recommendation literal");
    assert.ok(!shell.includes("apiFetch"), "NowConsole.jsx gains no apiFetch");
    const stuck = shell.indexOf("<StuckSignals />");
    const panel = shell.indexOf("<RecommendationsPanel />");
    const strip = shell.indexOf("<RunHistoryStrip");
    assert.ok(stuck >= 0 && panel > stuck && strip > panel, "mounted between StuckSignals and RunHistoryStrip");
  });

  test("dismiss is immediate-undo through the shared undo host; mute is confirm-first through the write hook", () => {
    const src = readRepo4634(PANEL);
    for (const seam of ["useUndoWindowHost", "UndoToastStack", "triggerDisabled", "useServerConfirmedWrite"]) {
      assert.ok(src.includes(seam), `the panel composes ${seam}`);
    }
    assert.ok(src.includes("dismiss-rec:${rec.id}"), "one undo window per rec");
    assert.ok(src.includes("Confirm mute ${muteArmed.severity}?"), "mute arms a confirm step");
    assert.match(src, /const SEVERITIES = \["info", "warn", "critical"\];/, "exactly the route's closed enum");
  });

  test("both writes carry the run_id the panel read — never the literal 'current'", () => {
    const src = readRepo4634(PANEL);
    assert.ok(!src.includes('"current"'), "no 'current' run_id literal");
    assert.ok(src.includes("body: JSON.stringify({ run_id: runId })"), "dismiss body pins the read run_id");
    assert.ok(src.includes("{ run_id: runId, severity }"), "mute body pins the arm-time run_id");
  });

  test("results are server-confirmed: ✓ only after the re-read, and a failed re-read says so", () => {
    const src = readRepo4634(PANEL);
    assert.ok(src.includes("const reread = await refreshChecked();"), "dismiss awaits the panel's re-read");
    assert.ok(src.includes("✓ accepted · re-read FAILED — list may be stale"), "the #4628 failed-re-read wording");
    assert.ok(src.includes("no autopilot run — nothing to recommend"), "run_id null renders the explicit no-run row");
    assert.ok(src.includes("there is no un-dismiss route"), "dismiss consequence stated at the control");
    assert.ok(src.includes("there is no un-mute route"), "mute consequence stated at the control");
  });
});
