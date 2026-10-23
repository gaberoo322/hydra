/**
 * Regression tests for the /runs dashboard page (issue #4009 — dashboard v3
 * slice delta, ADR-0034 §2: "why did that fail?").
 *
 * The dashboard ships no JSX test runner and the worktree resolves no
 * `react`, so — exactly like test/health-page.test.mts and
 * test/builder-page.test.mts — the slice is pinned at the two boundaries
 * that ARE mechanically checkable:
 *
 *   1. The PURE derivations the page's behaviour keys off, imported from the
 *      react-free module dashboard/src/components/pages/runs/runs-state.js
 *      (the cross-tab-families.js lane): the outcome classifier absorbed
 *      from the retired Explore › Behavior tab, the failing-turn selection
 *      the run-detail landing keys off (INV-4), and the dispatch-trigger
 *      attribution with its explicit unattributed state (INV-8).
 *   2. The HTTP boundary of the one server field this slice adds:
 *      GET /autopilot/runs gains a top-level generatedAt (INV-3) — the
 *      field the slice-alpha trust seam (derivePageStatus) needs, without
 *      which the whole runs list renders UNKNOWN forever.
 *   3. Structural source pins for the JSX half that cannot be imported:
 *      route wiring incl. the legacy /autopilot/:runId redirect (INV-5),
 *      the usePageItems delegation (INV-2), zero trend-chart components
 *      (INV-1), the two distinct resume/re-dispatch controls (INV-6), and
 *      FrictionPanel's two-source split (INV-7).
 *
 * Lifecycle: top-level describes with their OWN before/after (per the
 * CLAUDE.md shared-Redis-teardown authoring rule — nothing nests under a
 * sibling suite's after()).
 */

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Redis from "ioredis";

import { createAutopilotRunsRouter } from "../src/api/autopilot-runs.ts";
import {
  classifyRunOutcome,
  findFailingTurn,
  describeDispatchTrigger,
  formatRunDuration,
} from "../dashboard/src/components/pages/runs/runs-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/1";

function mockReq(overrides: any = {}): any {
  return { method: "GET", url: "/autopilot/runs", headers: {}, query: {}, params: {}, body: {}, ...overrides };
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

async function readSource(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/** A dispatch action as the run-detail projection serves it. */
function dispatchAction(overrides: any = {}): any {
  return { type: "dispatch", slot: "dev", skill: "hydra-dev", ...overrides };
}

/** A turn row as /autopilot/runs/:id serves them (newest-first). */
function turn(turnN: number, actions: any[] = []): any {
  return { turn_n: turnN, epoch: 1786856000 + turnN * 60, actions, reasons: [] };
}

// ---------------------------------------------------------------------------
// classifyRunOutcome — the Behavior-tab outcome classifier, absorbed
// ---------------------------------------------------------------------------

describe("classifyRunOutcome — absorbed Behavior-tab decision table", () => {
  test("running → in-progress", () => {
    assert.equal(classifyRunOutcome("running", null, null), "in-progress");
  });

  test("aborted / cancelled → aborted, via status OR term_reason", () => {
    assert.equal(classifyRunOutcome("aborted", null, null), "aborted");
    assert.equal(classifyRunOutcome("cancelled", 1, null), "aborted");
    assert.equal(classifyRunOutcome("completed", 0, "aborted"), "aborted");
    assert.equal(classifyRunOutcome("completed", 0, "Cancelled"), "aborted");
  });

  test("failed (server-side sweep verdict) → failure regardless of exit code", () => {
    assert.equal(classifyRunOutcome("failed", 0, null), "failure");
    assert.equal(classifyRunOutcome("failed", null, "sweep"), "failure");
  });

  test("completed + exit_code 0 → success; finite non-zero → failure", () => {
    assert.equal(classifyRunOutcome("completed", 0, null), "success");
    assert.equal(classifyRunOutcome("completed", 3, null), "failure");
    assert.equal(classifyRunOutcome("completed", -1, null), "failure");
  });

  test("completed with no exit code recorded → success (pre-#498 schema leniency)", () => {
    assert.equal(classifyRunOutcome("completed", null, null), "success");
  });

  test("anything else → unknown, never a guess", () => {
    assert.equal(classifyRunOutcome("", null, null), "unknown");
    assert.equal(classifyRunOutcome("weird-state", 0, null), "unknown");
    assert.equal(classifyRunOutcome(undefined as any, undefined as any, undefined as any), "unknown");
  });

  test("field-for-field agreement with the server-side classifier's closed set", () => {
    // The server authority (src/aggregators/behavior-gallery.ts classifyOutcome)
    // maps onto exactly these five values; the client mirror must never invent
    // a sixth (/runs and /explore/behavior must not disagree).
    const inputs: Array<[string, number | null, string | null]> = [
      ["running", null, null],
      ["completed", 0, null],
      ["completed", 2, null],
      ["failed", 2, null],
      ["aborted", null, null],
      ["mystery", null, null],
    ];
    const outcomes = new Set(inputs.map(([s, e, r]) => classifyRunOutcome(s, e, r)));
    for (const o of outcomes) {
      assert.ok(
        ["success", "failure", "aborted", "in-progress", "unknown"].includes(o),
        `unexpected outcome value: ${o}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// findFailingTurn — INV-4, the failed step auto-expands
// ---------------------------------------------------------------------------

describe("findFailingTurn — the landing turn for a failed run (INV-4)", () => {
  test("lands on the turn carrying the failed dispatch action", () => {
    const turns = [
      turn(3, [dispatchAction({ outcome: { status: "merged" } })]),
      turn(2, [dispatchAction({ outcome: { status: "failed" } })]),
      turn(1, [dispatchAction({ outcome: { status: "merged" } })]),
    ];
    assert.equal(findFailingTurn(turns, true)?.turn_n, 2);
  });

  test("multiple failed turns → the NEWEST (where the run stood when it died)", () => {
    const turns = [
      turn(4, [dispatchAction({ outcome: { status: "failed" } })]),
      turn(2, [dispatchAction({ outcome: { status: "failed" } })]),
    ];
    assert.equal(findFailingTurn(turns, true)?.turn_n, 4);
  });

  test("run-level death (failed run, no failed action) → the newest turn, where it stopped", () => {
    const turns = [turn(2), turn(1, [dispatchAction({ outcome: { status: "merged" } })])];
    assert.equal(findFailingTurn(turns, true)?.turn_n, 2);
  });

  test("a NON-failed run never gets a landing target", () => {
    const turns = [turn(2, [dispatchAction({ outcome: { status: "failed" } })])];
    // A failed dispatch inside an otherwise-completed run is visible in the
    // timeline, but the page does not hijack the landing for a healthy run.
    assert.equal(findFailingTurn(turns, false), null);
  });

  test("no turns at all → null (never a crash, never a fabricated target)", () => {
    assert.equal(findFailingTurn([], true), null);
    assert.equal(findFailingTurn(undefined as any, true), null);
  });

  test("malformed action shapes are skipped safely", () => {
    const turns = [
      turn(2, [null, { type: "note" }, dispatchAction({ outcome: "corrupt-string" })]),
      turn(1, [dispatchAction({ outcome: { status: "failed" } })]),
    ];
    assert.equal(findFailingTurn(turns, true)?.turn_n, 1);
  });
});

// ---------------------------------------------------------------------------
// describeDispatchTrigger — INV-8, attribution + explicit unattributed
// ---------------------------------------------------------------------------

describe("describeDispatchTrigger — who or what triggered it (INV-8)", () => {
  test("autopilot dispatch with a joined issue → attributed, names trigger + target", () => {
    const d = describeDispatchTrigger({
      source: "autopilot",
      classLabel: "pace-gate",
      issueRef: "issue-4009",
    });
    assert.equal(d.attributed, true);
    assert.equal(d.trigger, "autopilot · pace-gate");
    assert.equal(d.target, "issue-4009");
  });

  test("subagent dispatch with skill label → who is the SOURCE, not the label", () => {
    const d = describeDispatchTrigger({ source: "subagent", classLabel: "hydra-dev", issueRef: "#12" });
    assert.equal(d.trigger, "subagent · hydra-dev");
    assert.equal(d.target, "#12");
  });

  test("operator dispatch → operator named as the trigger", () => {
    const d = describeDispatchTrigger({ source: "operator", classLabel: "manual" });
    assert.equal(d.trigger, "operator · manual");
  });

  test("MISSING dispatch→issue join → the literal 'unattributed' state, never a fabricated source", () => {
    // The known-weak join (~4.97%, ADR-0034 §2) is the thing this page exists
    // to make visible. Absence must render absence.
    for (const issueRef of [undefined, null, "", "   "]) {
      const d = describeDispatchTrigger({ source: "autopilot", classLabel: "pace-gate", issueRef });
      assert.equal(d.attributed, false, `issueRef=${JSON.stringify(issueRef)}`);
      assert.equal(d.target, "unattributed");
    }
  });

  test("unknown/missing source → named as unknown, not guessed", () => {
    assert.equal(describeDispatchTrigger({}).trigger, "unknown source");
    assert.equal(describeDispatchTrigger({ source: "cron-ish?" }).trigger, "unknown source");
  });

  test("missing classLabel degrades to the bare source, no '· —' artifact", () => {
    assert.equal(describeDispatchTrigger({ source: "operator" }).trigger, "operator");
  });
});

// ---------------------------------------------------------------------------
// formatRunDuration — the absorbed Behavior-tab formatter
// ---------------------------------------------------------------------------

describe("formatRunDuration — absorbed Behavior-tab formatting", () => {
  test("null / invalid / negative → the em-dash placeholder, never a confident 0m", () => {
    assert.equal(formatRunDuration(null), "—");
    assert.equal(formatRunDuration(undefined as any), "—");
    assert.equal(formatRunDuration(Number.NaN), "—");
    assert.equal(formatRunDuration(-5), "—");
  });

  test("sub-hour → whole minutes; over an hour → Hh Mm (zero minutes rendered, #4564)", () => {
    assert.equal(formatRunDuration(707), "11m");
    assert.equal(formatRunDuration(0), "0m");
    assert.equal(formatRunDuration(3600), "1h 0m");
    assert.equal(formatRunDuration(3660), "1h 1m");
  });
});

// ---------------------------------------------------------------------------
// GET /autopilot/runs — generatedAt (INV-3, the server half)
// ---------------------------------------------------------------------------

describe("GET /autopilot/runs — gains generatedAt (INV-3)", () => {
  let redis: any;
  let handler: Function | null;

  before(async () => {
    redis = new Redis(REDIS_URL);
    const router = createAutopilotRunsRouter();
    handler = findHandler(router, "GET", "/autopilot/runs");
    assert.ok(handler, "GET /autopilot/runs route not found on the runs router");
  });

  beforeEach(async () => {
    const keys = await redis.keys("hydra:autopilot:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  after(async () => {
    if (redis) redis.disconnect();
  });

  async function seedRun(runId: string, fields: Record<string, string>) {
    await redis.hset(`hydra:autopilot:run:${runId}`, { started: "2026-08-15T10:00:00Z", ...fields });
    await redis.zadd("hydra:autopilot:runs:index", Date.now(), runId);
  }

  test("carries a parseable top-level generatedAt ISO timestamp", async () => {
    await seedRun("run-gen-1", { status: "completed", exit_code: "0", trigger: "pace-gate" });
    const res = mockRes();
    await handler!(mockReq({ query: { limit: "5" } }), res);
    assert.equal(res._status, 200);
    assert.equal(typeof res._body.generatedAt, "string");
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)), "generatedAt must parse as ISO");
  });

  test("additive only — runs and terminationHealth survive unchanged (non-breaking shape)", async () => {
    await seedRun("run-gen-2", { status: "completed", exit_code: "0" });
    const res = mockRes();
    await handler!(mockReq({ query: { limit: "5" } }), res);
    assert.equal(res._status, 200);
    assert.ok(Array.isArray(res._body.runs), "runs array must survive");
    assert.equal(res._body.runs.length, 1);
    assert.equal(res._body.runs[0].run_id, "run-gen-2");
    // terminationHealth (issue #1352) is the pre-existing sibling — it keeps
    // its name and shape alongside the new field.
    assert.ok(res._body.terminationHealth && typeof res._body.terminationHealth === "object");
  });

  test("the empty list is still a clean 200 with generatedAt — the trust seam reads the field, not the rows", async () => {
    const res = mockRes();
    await handler!(mockReq({ query: { limit: "5" } }), res);
    assert.equal(res._status, 200);
    assert.deepEqual(res._body.runs, []);
    assert.ok(Number.isFinite(Date.parse(res._body.generatedAt)));
  });
});

// ---------------------------------------------------------------------------
// Structural source pins — the JSX half (no JSX runner exists; these pin
// the wiring the pure tests cannot reach)
// ---------------------------------------------------------------------------

describe("/runs page source structure (INV-1/2/4/5/6/7/8 pins)", () => {
  test("App.jsx mounts /runs, /runs/:runId, and redirects legacy /autopilot/:runId → /runs/:runId (INV-5)", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    assert.match(src, /path="\/runs"/, "the /runs list route must be mounted");
    assert.match(src, /path="\/runs\/:runId"/, "the /runs/:runId detail route must be mounted");
    assert.match(src, /path="\/autopilot\/:runId"/, "the legacy deep link must still resolve");
    // The redirect must TARGET /runs (the absorbing page), carrying the param.
    assert.match(src, /\/runs\/\$\{runId\}/, "the redirect must forward the runId to /runs/:runId");
  });

  test("RunsList derives its whole status machine through usePageItems — no bespoke ternary (INV-2)", async () => {
    const src = await readSource("../dashboard/src/components/pages/runs/RunsList.jsx");
    assert.match(src, /usePageItems\(\s*"\/autopilot\/runs/, "RunsList must source /autopilot/runs via usePageItems");
    // A page that re-implements the loading/error/empty ternary would gate its
    // rows on the raw useApi fields instead of the seam's status.
    assert.ok(!src.includes("useApi("), "RunsList must not call useApi directly");
  });

  test("zero trend/aggregate-chart components on the /runs page (INV-1)", async () => {
    // /Chart/ is capital-C only: the anti-scope COMMENTS legitimately say
    // "trends" (lowercase); a component import would be `Sparkline`/`…Chart`.
    for (const rel of [
      "../dashboard/src/pages/Runs.jsx",
      "../dashboard/src/components/pages/runs/RunsList.jsx",
      "../dashboard/src/components/pages/runs/FrictionPanel.jsx",
    ]) {
      const src = await readSource(rel);
      assert.doesNotMatch(src, /Sparkline|Chart/, `${rel} must not render a chart component`);
    }
  });

  test("resume and re-dispatch are two DISTINCT, separately labelled controls (INV-6)", async () => {
    const src = await readSource("../dashboard/src/pages/Autopilot.jsx");
    assert.ok(src.includes('data-testid="resume-session"'), "the resume control must exist");
    assert.ok(src.includes('data-testid="re-dispatch"'), "the re-dispatch control must exist");
    // Distinct wording is the invariant: each control names its own operation
    // and its own cost, so the pair can never collapse into one "retry".
    assert.match(src, /Resume the stalled session/);
    assert.match(src, /Re-dispatch from scratch/);
    assert.match(src, /never one overloaded retry button/);
  });

  test("FrictionPanel: primary list from /explore/friction via usePageItems; /learning/friction-patterns stays a non-list strip outside the seam (INV-7)", async () => {
    const src = await readSource("../dashboard/src/components/pages/runs/FrictionPanel.jsx");
    assert.match(src, /usePageItems\(\s*"\/explore\/friction"/, "the primary list must ride the trust seam");
    // The totals endpoint emits no generatedAt — forcing it through
    // usePageItems would classify it unknown forever. It must be a plain
    // useApi summary strip.
    assert.ok(
      !src.includes('usePageItems("/learning/friction-patterns"'),
      "/learning/friction-patterns must never be forced through usePageItems",
    );
    assert.match(src, /useApi\(\s*"\/learning\/friction-patterns"/, "the totals strip fetches via plain useApi");
  });

  test("the failing-turn landing is a backward-compatible optional prop on RunView (INV-4)", async () => {
    const src = await readSource("../dashboard/src/components/RunView.jsx");
    assert.match(src, /focusFailingTurn = false/, "the prop must be optional with a default");
    assert.match(src, /scrollIntoView/, "mount must auto-focus (scroll) the failing turn");
    assert.match(src, /findFailingTurn/, "the selection is the pure, tested helper");
  });

  test("a missing dispatch→issue join renders the explicit unattributed state (INV-8)", async () => {
    const src = await readSource("../dashboard/src/pages/Runs.jsx");
    assert.match(src, /unattributed/, "the dispatch row carries the literal unattributed state");
    assert.match(src, /describeDispatchTrigger/, "attribution is the pure, tested derivation");
    assert.match(src, /"\/now\/active-dispatches"/, "dispatch events come from the registry endpoint");
  });
});

// ===========================================================================
// Issue #4634 (design-concept a7e7fedb) — /runs Behavior fold restored,
// /runs/:runId retro bundle, the dead /metrics?run= link deleted.
// Source pins (no JSX runner — same rationale as the suite above).
// ===========================================================================

import { readdirSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT_4634 = fileURLToPath(new URL("..", import.meta.url));

/** Repo-relative dashboard/src files whose source contains `needle`. */
function dashboardFilesContaining(needle: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(REPO_ROOT_4634, rel))) {
      if (name === "node_modules") continue;
      const child = `${rel}/${name}`;
      if (statSync(join(REPO_ROOT_4634, child)).isDirectory()) walk(child);
      else if (/\.(jsx?|tsx?)$/.test(name) && readFileSync(join(REPO_ROOT_4634, child), "utf8").includes(needle)) {
        out.push(child);
      }
    }
  };
  walk("dashboard/src");
  return out;
}

describe("#4634 INV-2/6 — BehaviorGallery on /runs", () => {
  test('"/explore/behavior?limit=50" lives in exactly one file: BehaviorGallery.jsx', () => {
    assert.deepEqual(dashboardFilesContaining('"/explore/behavior?limit=50"'), [
      "dashboard/src/components/pages/runs/BehaviorGallery.jsx",
    ]);
  });

  test("rides usePageItems with a client-side outcome filter — one fetch, no query rewrite", async () => {
    const src = await readSource("../dashboard/src/components/pages/runs/BehaviorGallery.jsx");
    assert.match(src, /usePageItems\(\s*"\/explore\/behavior\?limit=50"/);
    assert.match(src, /\bfilter,/, "the outcome filter rides usePageItems' filter option");
    assert.ok(!src.includes("outcome="), "no server-side outcome query rewrite");
    assert.ok(src.includes("BEHAVIOR_OUTCOMES"), "the closed outcome set (runs-state.js, pinned behaviourally below)");
  });

  test("links to /runs/${runId}, never the retired detailHref; empty classes are explicit", async () => {
    const src = await readSource("../dashboard/src/components/pages/runs/BehaviorGallery.jsx");
    assert.ok(src.includes("to={`/runs/${encodeURIComponent(r.runId)}`}"), "canonical run link built from runId");
    assert.ok(!src.includes("r.detailHref") && !src.includes("row.detailHref"), "never the server's detailHref");
    assert.ok(src.includes("no classes recorded"), "an empty classes[] renders a literal, never a blank");
    assert.ok(src.includes("Behavior — which classes each run dispatched"), "the section heading");
  });

  test("Runs.jsx mounts BehaviorGallery between DispatchEvents and OutcomeAttribution and owns no literal", async () => {
    const src = await readSource("../dashboard/src/pages/Runs.jsx");
    const d = src.indexOf("<DispatchEvents />");
    const b = src.indexOf("<BehaviorGallery />");
    const o = src.indexOf("<OutcomeAttribution />");
    assert.ok(d >= 0 && b > d && o > b, "BehaviorGallery sits between DispatchEvents and OutcomeAttribution");
    assert.ok(!src.includes('"/explore/behavior'), "Runs.jsx must not own the behavior route literal");
  });

  test("the new /runs panels render no trend or chart component (ADR-0034 §2 anti-scope)", async () => {
    for (const rel of [
      "../dashboard/src/components/pages/runs/BehaviorGallery.jsx",
      "../dashboard/src/components/pages/runs/RunRetroBundle.jsx",
    ]) {
      const src = await readSource(rel);
      assert.doesNotMatch(src, /Sparkline|Chart/, `${rel} must not render a chart component`);
    }
  });
});

describe("#4634 INV-2/4/7 — RunRetroBundle on /runs/:runId", () => {
  test("the retro bundle path lives in exactly one file: RunRetroBundle.jsx", () => {
    assert.deepEqual(dashboardFilesContaining("`/autopilot/runs/${encodeURIComponent(runId)}/retro`"), [
      "dashboard/src/components/pages/runs/RunRetroBundle.jsx",
    ]);
  });

  test("fetched once (no poll) through the shared derivePageStatus seam", async () => {
    const src = await readSource("../dashboard/src/components/pages/runs/RunRetroBundle.jsx");
    assert.ok(src.includes("derivePageStatus"), "must import the shared trust seam");
    assert.match(src, /useApi\(`\/autopilot\/runs\/\$\{encodeURIComponent\(runId\)\}\/retro`\)/, "one-shot: no options, no poll");
  });

  test("a partial bundle is visible, runFound=false is UNKNOWN, crossRunTrend is not rendered", async () => {
    const src = await readSource("../dashboard/src/components/pages/runs/RunRetroBundle.jsx");
    // The partial line and the per-source UNKNOWN tiles come from the pure
    // helpers driven behaviourally below (review follow-up: a string pin let
    // a mutated `errors.length > 0` gate stay green).
    for (const helper of ["retroPartialLine(data?.errors)", "retroCountTiles(data)", "topFrictionPatterns(data, 3)"]) {
      assert.ok(src.includes(helper), `the panel renders through ${helper}`);
    }
    assert.ok(src.includes("t.count === null"), "a failed source's tile renders UNKNOWN");
    assert.ok(src.includes("friction.unknown"), "a failed friction source renders the list UNKNOWN");
    assert.ok(src.includes("data?.runFound === false"), "an unloaded run record renders UNKNOWN");
    assert.ok(!/\.crossRunTrend/.test(src), "the cross-run trend is /builder's, never read here");
    for (const field of ["runFlagged", "runFlagReason"]) {
      assert.ok(src.includes(field), `the bundle panel renders ${field}`);
    }
  });

  test("AutopilotDetail mounts RunRetroBundle after RunView and FailureNextSteps; the shell owns no retro literal", async () => {
    const src = await readSource("../dashboard/src/pages/Autopilot.jsx");
    const view = src.indexOf('<RunView run={run} turns={turns} mode="detail"');
    const steps = src.indexOf("{runFailed && <FailureNextSteps run={run} />}");
    const retro = src.indexOf("<RunRetroBundle runId={runId} />");
    assert.ok(view >= 0 && steps > view && retro > steps, "retro panel sits after RunView and next steps");
    assert.ok(!src.includes("/retro`"), "Autopilot.jsx must not fetch the retro bundle itself");
  });
});

describe("#4634 INV-8 — the dead /metrics?run= link is gone", () => {
  test("HistoryTable.jsx carries neither the link nor its label; the row link stays", async () => {
    const src = await readSource("../dashboard/src/components/HistoryTable.jsx");
    assert.ok(!src.includes("/metrics?run="), "the dead /metrics?run= link must be deleted");
    assert.ok(!src.includes("see cycles"), "the dead link's label must be deleted");
    assert.ok(src.includes("to={`/autopilot/${encodeURIComponent(r.run_id)}`}"), "the run row link is unchanged");
  });

  test("no dashboard file links to /metrics?run=", () => {
    assert.deepEqual(dashboardFilesContaining("/metrics?run="), []);
  });
});

// ---------------------------------------------------------------------------
// #4634 review follow-up — behavioural pins for the pure derivations the
// RunRetroBundle and BehaviorGallery panels render through.
// ---------------------------------------------------------------------------

import {
  retroCountTiles,
  retroPartialLine,
  topFrictionPatterns,
  unverifiedRetroFields,
} from "../dashboard/src/lib/retro-bundle-tiles.ts";
import { BEHAVIOR_OUTCOMES, describeBehaviorClasses } from "../dashboard/src/components/pages/runs/runs-state.js";
import { BehaviorGalleryQuerySchema } from "../src/schemas/explore-page.ts";

const tileCount = (tiles: Array<{ field: string; count: number | null }>, field: string) =>
  tiles.find((t) => t.field === field)?.count;

describe("#4634 review — retro bundle: a failed source is UNKNOWN, never a confident zero", () => {
  const clean = {
    runFound: true,
    dispatches: [{}, {}],
    dispatchOutcomes: [{}],
    reflections: [],
    stuckSignals: [{}],
    frictionPatterns: [
      { category: "low", hitCount: 1 },
      { category: "high", hitCount: 9 },
      { category: "mid", hitCount: 4 },
      { category: "tail", hitCount: 2 },
    ],
    errors: [],
  };

  test("a clean bundle renders observed counts — an asserted 0 stays 0", () => {
    const tiles = retroCountTiles(clean);
    assert.deepEqual(
      tiles.map((t) => [t.field, t.count]),
      [
        ["dispatches", 2],
        ["dispatchOutcomes", 1],
        ["reflections", 0],
        ["stuckSignals", 1],
        ["frictionPatterns", 4],
      ],
    );
    assert.equal(retroPartialLine(clean.errors), null, "no partial line on a clean assembly");
  });

  test("a failed friction source turns its tile AND its list UNKNOWN; other tiles keep their counts", () => {
    const bundle = { ...clean, frictionPatterns: [], errors: [{ source: "friction", detail: "redis down" }] };
    const tiles = retroCountTiles(bundle);
    assert.equal(tileCount(tiles, "frictionPatterns"), null, "never the [] fallback rendered as 0");
    assert.equal(tileCount(tiles, "dispatches"), 2);
    assert.equal(tileCount(tiles, "stuckSignals"), 1);
    assert.deepEqual(topFrictionPatterns(bundle), { unknown: true, patterns: [] });
  });

  test("each never-throw source maps to the field its empty fallback would falsely zero", () => {
    assert.deepEqual([...unverifiedRetroFields([{ source: "stuck-signals" }])], ["stuckSignals"]);
    assert.deepEqual([...unverifiedRetroFields([{ source: "reflections" }])], ["reflections"]);
    assert.deepEqual([...unverifiedRetroFields([{ source: "dispatch-outcomes" }])], ["dispatchOutcomes"]);
    assert.deepEqual([...unverifiedRetroFields([{ source: "friction" }])], ["frictionPatterns"]);
    // Row enrichment / unrendered fields leave every count verified.
    for (const source of ["cycle-metrics", "cycle-record", "recommendations", "cross-run-trend"]) {
      assert.equal(unverifiedRetroFields([{ source }]).size, 0, `${source} feeds no count tile`);
    }
  });

  test("an unrecognised failed source fails safe — every count turns UNKNOWN", () => {
    const tiles = retroCountTiles({ ...clean, errors: [{ source: "some-new-source", detail: "x" }] });
    assert.ok(tiles.every((t) => t.count === null), "UNKNOWN over a guessed zero");
  });

  test("any non-empty errors[] yields the persistent partial-bundle line naming each source", () => {
    const line = retroPartialLine([
      { source: "friction", detail: "redis down" },
      { source: "cycle-record", detail: "timeout" },
    ]);
    assert.equal(line, "partial bundle — 2 source(s) failed: friction: redis down · cycle-record: timeout");
    // Even an error that feeds no tile must still mark the bundle partial.
    assert.ok(retroPartialLine([{ source: "cross-run-trend", detail: "x" }])?.startsWith("partial bundle — 1 source(s)"));
  });

  test("top friction patterns are the three highest by hitCount", () => {
    const { unknown, patterns } = topFrictionPatterns(clean);
    assert.equal(unknown, false);
    assert.deepEqual(patterns.map((p) => p.category), ["high", "mid", "tail"]);
  });
});

describe("#4634 review — BehaviorGallery class chips and outcome filter", () => {
  test("empty classes with dispatches > 0 is classes UNKNOWN, never 'no classes recorded'", () => {
    assert.deepEqual(describeBehaviorClasses({ classes: [], dispatches: 6 }), { kind: "unknown" });
    assert.deepEqual(describeBehaviorClasses({ classes: [] }), { kind: "unknown" }, "an unrecorded count asserts nothing");
  });

  test("'no classes recorded' only when the run dispatched nothing", () => {
    assert.deepEqual(describeBehaviorClasses({ classes: [], dispatches: 0 }), { kind: "none" });
  });

  test("recorded classes render as chips", () => {
    assert.deepEqual(describeBehaviorClasses({ classes: ["dev_orch", "qa_orch"], dispatches: 3 }), {
      kind: "classes",
      classes: ["dev_orch", "qa_orch"],
    });
  });

  test("BEHAVIOR_OUTCOMES is exactly the route's closed outcome enum, unknown included", () => {
    assert.ok(BEHAVIOR_OUTCOMES.includes("unknown"), "unknown rows must be selectable");
    for (const outcome of BEHAVIOR_OUTCOMES) {
      assert.equal(BehaviorGalleryQuerySchema.safeParse({ outcome }).success, true, `${outcome} is in the enum`);
    }
    assert.equal(BehaviorGalleryQuerySchema.safeParse({ outcome: "bogus" }).success, false);
    // Every value the classifier can emit has a filter chip.
    for (const [status, exit, reason] of [
      ["running", null, null],
      ["aborted", null, null],
      ["failed", 1, null],
      ["completed", 0, null],
      ["ended", 0, "handoff"],
    ] as const) {
      assert.ok(BEHAVIOR_OUTCOMES.includes(classifyRunOutcome(status, exit, reason)));
    }
  });

  test("BehaviorGallery renders through the shared helpers", async () => {
    const src = await readSource("../dashboard/src/components/pages/runs/BehaviorGallery.jsx");
    assert.ok(src.includes("[null, ...BEHAVIOR_OUTCOMES]"), "filter chips come from the closed set");
    assert.ok(src.includes("describeBehaviorClasses(row)"), "class chips come from the tested derivation");
    assert.ok(src.includes("classes UNKNOWN"), "the unknown branch renders");
  });
});
