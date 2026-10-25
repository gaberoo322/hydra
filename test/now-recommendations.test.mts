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
    const reader: CurrentRunIdReader = async () => ({ ok: true, runId: "run-LIVE" });
    assert.deepEqual(await resolveRunId("current", reader), { ok: true, runId: "run-LIVE" });
    assert.deepEqual(await resolveRunId("run-X", reader), { ok: true, runId: "run-X" });
  });
});

// ---------------------------------------------------------------------------
// getActiveRecommendations
// ---------------------------------------------------------------------------

describe("aggregator: getActiveRecommendations", () => {
  test("a FAILED current-run read degrades to sourcesOk:false, never an asserted no-run (#5162 INV-7)", async () => {
    const { redis } = makeRecsFake();
    const out = await getActiveRecommendations(
      "current",
      makeDeps(redis, async () => ({ ok: false, code: "redis", detail: "boom" })),
    );
    assert.equal(out.run_id, null);
    assert.deepEqual(out.items, []);
    assert.equal(out.sourcesOk, false);
  });

  test("an asserted no-run and a healthy read both carry sourcesOk:true", async () => {
    const { redis } = makeRecsFake();
    const none = await getActiveRecommendations("current", makeDeps(redis, async () => ({ ok: true, runId: null })));
    assert.equal(none.sourcesOk, true);
    const live = await getActiveRecommendations("current", makeDeps(redis, async () => ({ ok: true, runId: "run-A" })));
    assert.equal(live.sourcesOk, true);
  });

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
      makeDeps(redis, async () => ({ ok: true, runId: "run-A" })),
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
      makeDeps(redis, async () => ({ ok: true, runId: null })),
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
      makeDeps(redis, async () => ({ ok: true, runId: "run-A" })),
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
      makeDeps(redis, async () => ({ ok: true, runId: "run-A" })),
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
      makeDeps(redis, async () => ({ ok: true, runId: null })),
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
      makeDeps(redis, async () => ({ ok: true, runId: "run-A" })),
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
        return { ok: true, runId: "should-not-resolve" };
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
      makeDeps(redis, async () => ({ ok: true, runId: null })),
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
    const router = createNowRecommendationsRouter({ recsRedis: redis, readCurrentRunId: async () => ({ ok: true, runId: "run-A" }) });
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
    const router = createNowRecommendationsRouter({ recsRedis: redis, readCurrentRunId: async () => ({ ok: true, runId: current }) });
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

  test("a failed current-run read: GET is 200 sourcesOk:false; dismiss and mute are 503, never the asserted-no-run 404 (#5162 INV-8)", async () => {
    const { redis } = makeRecsFake();
    const router = createNowRecommendationsRouter({
      recsRedis: redis,
      readCurrentRunId: async () => ({ ok: false, code: "redis" }),
    });
    const read = fakeRes();
    await routeHandler(router, "GET", "/now/recommendations")({ query: {}, params: {}, body: {} }, read);
    assert.equal(read._body.sourcesOk, false);
    assert.equal(read._body.run_id, null);
    const dismiss = fakeRes();
    await routeHandler(router, "POST", "/now/recommendations/:id/dismiss")({ params: { id: "x" }, body: {}, query: {} }, dismiss);
    assert.equal(dismiss._status, 503);
    assert.equal(dismiss._body.code, "redis");
    const mute = fakeRes();
    await routeHandler(router, "POST", "/now/recommendations/mute-class")({ params: {}, body: { severity: "warn" }, query: {} }, mute);
    assert.equal(mute._status, 503);
  });

  test("a missing current run reads as run_id null — the panel's explicit no-run evidence", async () => {
    const { redis } = makeRecsFake();
    const router = createNowRecommendationsRouter({ recsRedis: redis, readCurrentRunId: async () => ({ ok: true, runId: null }) });
    const res = fakeRes();
    await routeHandler(router, "GET", "/now/recommendations")({ query: {}, params: {}, body: {} }, res);
    assert.equal(res._body.run_id, null);
    assert.deepEqual(res._body.items, []);
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
  });
});

describe("#4634 — RecommendationsPanel source pins (registry-driven since #5152)", () => {
  test("the panel is the single owner of the GET; the two POST routes live in the registry, not the panel", () => {
    const src = readRepo4634(PANEL);
    assert.match(src, /usePageItems\(\s*"\/now\/recommendations"/, "the GET rides usePageItems");
    // #5152 flips #4634's page-local POST literals: both routes are registry
    // in-dashboard routes (ADR-0034 §9.1), fired by ActionAffordance.
    assert.ok(!src.includes("/now/recommendations/mute-class"), "no mute-class route literal in the panel");
    assert.ok(!src.includes("/dismiss"), "no dismiss route literal in the panel");
    assert.ok(!src.includes("apiFetch"), "no hand-rolled write");
    assert.ok(!src.includes("useServerConfirmedWrite"), "the write rides the affordance, not a page hook");
    const shell = readRepo4634("dashboard/src/pages/now-console/NowConsole.jsx");
    assert.ok(!shell.includes("/now/recommendations"), "NowConsole.jsx owns no recommendation literal");
    assert.ok(!shell.includes("apiFetch"), "NowConsole.jsx gains no apiFetch");
    const stuck = shell.indexOf("<StuckSignals />");
    const panel = shell.indexOf("<RecommendationsPanel />");
    const strip = shell.indexOf("<RunHistoryStrip");
    assert.ok(stuck >= 0 && panel > stuck && strip > panel, "mounted between StuckSignals and RunHistoryStrip");
  });

  test("dismiss (per row) and mute render through ControlAffordance under the panel's own undo host", () => {
    const src = readRepo4634(PANEL);
    for (const seam of ["useUndoWindowHost()", "<UndoToastStack", "<UndoWindowContext.Provider value={undoHost}>", "useOperatorActions()"]) {
      assert.ok(src.includes(seam), `the panel composes ${seam}`);
    }
    const row = src.slice(src.indexOf("function RecRow("), src.indexOf("export default function RecommendationsPanel("));
    assert.ok(row.includes('controlKey="control:now/rec-dismiss"'), "one Dismiss control per row");
    assert.ok(row.includes("resolveControlRoute(route, { id: recId })"), "the {id} route is resolved per rec — one undo window per rec");
    assert.ok(row.includes("resolveRoute={resolveRoute}"));
    assert.ok(src.includes("<RecRow\n                key={rec.id}"), "rows are keyed by rec id — never sharing affordance state");
    const panel = src.slice(src.indexOf("export default function RecommendationsPanel("));
    assert.ok(panel.includes('controlKey="control:now/rec-mute-class"'), "one Mute control in the header");
    assert.ok(panel.includes("<div key={`rec-mute-${muteChoice?.severity ?? \"none\"}`}>"), "a new pick remounts the mute control (never a silent swap of an armed Confirm)");
    assert.ok(src.includes("REC_SEVERITIES.map("), "the picker offers exactly the closed enum");
  });

  test("both writes carry the run_id the panel read — never the literal 'current'", () => {
    const src = readRepo4634(PANEL);
    assert.ok(!src.includes('"current"'), "no 'current' run_id literal");
    assert.ok(src.includes("const readRunId = readRunIdOf(data);"), "the run id comes from the panel's own GET");
    assert.ok(src.includes("context={recDismissContext(readRunId)}"), "dismiss context pins the read run_id");
    assert.ok(src.includes("setMuteChoice(chooseMute(severity, readRunId))"), "the pick captures the run_id at pick (arm) time");
    assert.ok(src.includes("context={recMuteContext(muteChoice)}"), "mute context carries the captured run_id");
  });

  test("results are server-confirmed: onFired is a CHECKED re-read of the panel's read; nothing is removed optimistically", () => {
    const src = readRepo4634(PANEL);
    assert.ok(src.includes("const refreshChecked = useCheckedRefresh(read);"), "a checked re-read of the usePageItems read");
    // The mute control and every RecRow get refreshChecked; RecRow forwards it
    // to its Dismiss control unchanged.
    assert.equal((src.match(/onFired=\{refreshChecked\}/g) ?? []).length, 2, "both controls await the re-read");
    const row = src.slice(src.indexOf("function RecRow("), src.indexOf("export default function RecommendationsPanel("));
    assert.ok(row.includes("onFired={onFired}"), "the row's Dismiss awaits the forwarded re-read");
    assert.equal((src.match(/rereadNoun="\/now"/g) ?? []).length, 2, "the result line names what was re-read");
    assert.ok(!/items\.filter\(/.test(src), "no optimistic local removal — only the re-read drops a rec");
    assert.ok(src.includes("no autopilot run — nothing to recommend"), "run_id null renders the explicit no-run row");
    // The consequences moved to the registry (#5152) — the panel re-spells none.
    assert.ok(!src.includes("there is no un-dismiss route"), "dismiss consequence is registry text");
    assert.ok(!src.includes("there is no un-mute route"), "mute consequence is registry text");
  });
});

// ===========================================================================
// Issue #5152 — the verdict + context leaf behind the /now registry controls
// (dashboard/src/lib/now-verdicts.ts).
// ===========================================================================

import {
  REC_SEVERITIES,
  chooseMute,
  muteChoiceMatchesRead,
  readRunIdOf,
  recDismissContext,
  recDismissVerdicts,
  recMuteContext,
  recMuteVerdicts,
} from "../dashboard/src/lib/now-verdicts.ts";

describe("#5152 — now-verdicts leaf", () => {
  test("REC_SEVERITIES is exactly the mute-class route's closed enum", () => {
    assert.deepEqual([...REC_SEVERITIES], ["info", "warn", "critical"]);
  });

  test("readRunIdOf accepts only a non-empty string run_id", () => {
    assert.equal(readRunIdOf({ run_id: "run-A" }), "run-A");
    assert.equal(readRunIdOf({ run_id: null }), null);
    assert.equal(readRunIdOf({ run_id: "" }), null);
    assert.equal(readRunIdOf({ run_id: 7 }), null);
    assert.equal(readRunIdOf(null), null);
  });

  test("dismiss: rec-run-id-read is ✓ only with a read run id; the context carries it", () => {
    assert.deepEqual(recDismissVerdicts("run-A"), { "rec-run-id-read": true });
    assert.deepEqual(recDismissVerdicts(null), { "rec-run-id-read": false });
    assert.deepEqual(recDismissContext("run-A"), { runId: "run-A" });
    assert.deepEqual(recDismissContext(undefined), { runId: null });
  });

  test("mute: severity-chosen stays ✗ until a pick; an unknown severity records nothing", () => {
    assert.deepEqual(recMuteVerdicts(null, "run-A"), { "rec-run-id-read": true, "severity-chosen": false });
    assert.equal(chooseMute("error", "run-A"), null);
    const choice = chooseMute("warn", "run-A");
    assert.deepEqual(choice, { severity: "warn", runId: "run-A" });
    assert.deepEqual(recMuteVerdicts(choice, "run-A"), { "rec-run-id-read": true, "severity-chosen": true });
  });

  test("mute: the pick pins the run id read AT PICK TIME — a later read never re-binds it", () => {
    const choice = chooseMute("critical", "run-A");
    // The write carries the pick-time run id, never a later read's.
    assert.deepEqual(recMuteContext(choice), { runId: "run-A", severity: "critical" });
    assert.equal(recMuteVerdicts(choice, "run-A")["rec-run-id-read"], true);
    // PR #5158 review: after a rollover the captured run id no longer matches
    // the panel's read — the line fails closed (✗ disables the trigger), so a
    // stale choice can never POST {run_id: A} and render ✓ for a write that
    // changed nothing on run B.
    assert.equal(recMuteVerdicts(choice, "run-B")["rec-run-id-read"], false);
    assert.equal(recMuteVerdicts(choice, null)["rec-run-id-read"], false);
    // A pick made while the read named no run can never enable the write.
    const blind = chooseMute("info", null);
    assert.deepEqual(recMuteVerdicts(blind, "run-B"), { "rec-run-id-read": false, "severity-chosen": true });
    assert.deepEqual(recMuteContext(null), { runId: null, severity: null });
  });

  test("muteChoiceMatchesRead: a choice survives only while the read still names its run (PR #5158 review)", () => {
    assert.equal(muteChoiceMatchesRead(null, "run-A"), true, "no choice — nothing to clear");
    assert.equal(muteChoiceMatchesRead(chooseMute("warn", "run-A"), "run-A"), true);
    assert.equal(muteChoiceMatchesRead(chooseMute("warn", "run-A"), "run-B"), false, "rollover clears it");
    assert.equal(muteChoiceMatchesRead(chooseMute("warn", "run-A"), null), false, "a read with no run clears it");
    assert.equal(muteChoiceMatchesRead(chooseMute("warn", null), null), false, "a blind pick never matches");
  });

  test("the panel clears the choice on a run_id change and after a successful mute (PR #5158 review)", () => {
    const src = readRepo4634(PANEL);
    const panel = src.slice(src.indexOf("export default function RecommendationsPanel("));
    assert.ok(
      panel.includes("setMuteChoice((prev) => (muteChoiceMatchesRead(prev, readRunId) ? prev : null));\n    setMuteDone(null);\n  }, [readRunId]);"),
      "a rollover drops the choice and the old run's ✓ line",
    );
    const onResult = panel.slice(panel.indexOf("const onMuteResult = useCallback("), panel.indexOf("const unknown ="));
    assert.ok(onResult.includes("if (result?.ok) {\n      setMuteChoice(null);"), "success clears the choice — a second mute needs a fresh pick");
    assert.ok(panel.includes("<ResultLine result={muteDone} />"), "the success line survives the control's remount");
  });
});

// INV-6: default current-run reader mapping (#5162)
import { mapCurrentRunResult } from "../src/api/now-recommendations.ts";

describe("mapCurrentRunResult (INV-6)", () => {
  test("not-found maps to a confident no-run", () => {
    assert.deepEqual(
      mapCurrentRunResult({ ok: false, code: "not-found", detail: "none" } as never),
      { ok: true, runId: null },
    );
  });

  test("a Redis error maps to a failed read, not no-run", () => {
    const r = mapCurrentRunResult({ ok: false, code: "errRedis", detail: "boom" } as never);
    assert.equal(r.ok, false);
    assert.equal((r as { code: string }).code, "errRedis");
  });

  test("a present run_id is returned; a blank one is no-run", () => {
    assert.deepEqual(
      mapCurrentRunResult({ ok: true, view: { run_id: "r1" } } as never),
      { ok: true, runId: "r1" },
    );
    assert.deepEqual(
      mapCurrentRunResult({ ok: true, view: {} } as never),
      { ok: true, runId: null },
    );
  });
});
