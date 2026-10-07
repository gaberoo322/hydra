/**
 * The JSON Turn Snapshot (ADR-0043 Decision 5, issue #4934 — slice 6 expand PR).
 *
 *   1. Plan parity (the critical gate): every distinct decide() input the
 *      existing test suite produces (test/fixtures/turn-snapshot-parity/
 *      decide-inputs.jsonl.gz, captured by capture/sitecustomize.py) yields a
 *      byte-identical Plan from the legacy kv state and from the same state in
 *      the JSON form with `signals` and every blob field REMOVED — so decide.py
 *      reads nothing around scripts/autopilot/turn_snapshot.py.
 *   2. Wire parity: for typed collector values, merge-signals.py over the kv
 *      lines they render to and turn_snapshot.py's apply() over the JSON they
 *      build to produce the same state fields, and decide.py the same Plan.
 *   3. Contract: golden documents round-trip through the zod schema
 *      (src/schemas/turn-snapshot.ts) and the Python accessor. No generated
 *      JSON Schema is committed (ADR-0043 Decision 5).
 *   4. Validation on emit: a failure is a marker + a note, never a throw.
 *   5. The CLI's `--format json` runs every collector in one process and never
 *      crashes, even with every adapter down.
 *
 * Regenerate the golden documents after an intentional shape change:
 *   UPDATE_TURN_SNAPSHOT_JSON_GOLDEN=1 npm run test:file -- test/turn-snapshot-json.test.mts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildTurnSnapshot, serializeTurnSnapshot, staleDays, pyFromIsoformatEpoch, type TurnSnapshotValues } from "../src/autopilot/turn-snapshot/json-snapshot.ts";
import { TurnSnapshotSchema } from "../src/schemas/turn-snapshot.ts";
import {
  renderClassStatsKv,
  renderCapacityKv,
  renderDirectionDriftKv,
  renderEmergencyBrakeKv,
  renderHealthKv,
  renderRealmShareKv,
  renderRecommendationsKv,
  renderSchedulerKv,
  renderScoutAlertsKv,
  renderSlotEventsKv,
  renderUsageEligibilityKv,
} from "../src/autopilot/turn-snapshot/render-kv-passthrough.ts";
import {
  renderNeedsQaNumbersKv,
  renderOrchBoardKv,
  renderPicksKv,
  renderPrGateKv,
  renderTargetBoardKv,
  renderTargetRiskSurfaceKv,
  renderTargetScanKv,
  renderUntriagedOrphansKv,
} from "../src/autopilot/turn-snapshot/render-kv.ts";
import {
  renderArchCleanupBoardsKv,
  renderHitlGrillKv,
  renderRedisQueuesKv,
  renderRetroKv,
  renderScoutKv,
  renderTicketsKv,
  renderWayfinderKv,
} from "../src/autopilot/turn-snapshot/render-kv-remaining.ts";
import { prGateFallbackSnapshot } from "../src/autopilot/turn-snapshot/pr-gate.ts";
import { picksFallbackSnapshot } from "../src/autopilot/turn-snapshot/picks.ts";
import { orchBoardFallbackSnapshot } from "../src/autopilot/turn-snapshot/orch-board.ts";
import { targetBoardFallbackSnapshot } from "../src/autopilot/turn-snapshot/target-board.ts";
import { targetScanFallbackSnapshot } from "../src/autopilot/turn-snapshot/target-scan-boards.ts";
import { main } from "../scripts/autopilot/turn-snapshot.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PARITY_DIR = join(REPO_ROOT, "test", "fixtures", "turn-snapshot-parity");
const UPDATE_GOLDEN = process.env.UPDATE_TURN_SNAPSHOT_JSON_GOLDEN === "1";
/** 2026-10-07T12:00:00Z — every scenario's clock. */
const NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 0);
const FAILED = { ok: false, reason: "all-reads-failed" } as const;
const ok = <T,>(value: T) => ({ ok: true as const, value });

// ---------------------------------------------------------------------------
// Scenarios: typed collector values
// ---------------------------------------------------------------------------

function healthyValues(): TurnSnapshotValues {
  return {
    health: { service: ok({ status: "ok", redis: true }), failedServices: 0, failedServicesFallbackZero: true },
    directionDrift: false,
    orchBoard: {
      counts: {
        source: "service",
        values: { needs_qa: 2, ready_for_agent: 3, needs_triage: 0, needs_research: 1, in_progress: 2, blocked: 1, stale_in_progress: 0, stale_blocked: 0 },
      },
      boardState: { needs_qa: 2, ready_for_agent: 3, glm_withheld: [] },
      orchBoardDegraded: false,
      needsTriageItems: ok([4928, 4930]),
    },
    targetBoard: {
      counts: ok([
        ["target_ready_for_agent", "2"],
        ["target_ready_blocker_excluded", "1"],
        ["target_needs_qa", "1"],
        ["target_needs_triage", "0"],
        ["target_needs_research", "0"],
      ]),
      wip: ok({ limit: 3, inProgress: 3, live: 3, saturated: true }),
      needsQaPr: { ref: "https://github.com/example/target/pull/274", head: "feature/f454182f-t2-dev_target" },
      devResumePick: ok({ issue: 812, pr: 815, headRefName: "feature/resume-812" }),
      laneDegraded: false,
    },
    untriagedOrphans: ok(1),
    needsQaNumbers: ok([4941, 4936, 4941]),
    prGate: {
      inflight: { union: [4900], branch: [4900], body: [] },
      dirty: [4938, 4814, 4814],
      unchecked: [4950],
      behind: [4952, 4951, 4953],
      ciTriggerStale: ok(false),
      glmRed: ok({ bucket: [4881], pick: { issue: 4876, pr: 4881, headRefName: "worktree-agent-glm-4876-1791218911" } }),
      devResumePick: ok({ issue: 4718, pr: 4890, headRefName: "worktree-agent-a1b2" }),
      dirtyFix: ok({ pick: { issue: 4810, pr: 4814, headRefName: "fix/4810" }, surface: [{ pr: 4938, closingIssue: 4934 }, { pr: 4818, closingIssue: null }] }),
    },
    picks: {
      grillPick: 4931,
      devReadyPick: 4934,
      candidateExclusions: [{ anchor: "issue-4900", member: "in-flight-dev-exclusion", verdict: "excluded", evidence: "open PR #4901" }],
      activeDevOrch: 1,
      boardDegraded: false,
    },
    redisQueues: { "work-queue": ok(2), "reframe-queue": ok(0), "prior-failures": ok(0) },
    scout: { lastWalkIso: ok('"2026-10-05T08:00:00Z"'), openEnhancements: ok("25"), tokensToday: "1200", spendUsd: "0.42", mirrored: ok(true) },
    archBoards: {
      lastRunIso: ok("2026-10-06T00:00:00Z"),
      workQueue: 2,
      board: ok({ backfillIdle: false, archOpenScan: 1, archOpenEnhancements: 4, archSaturated: true, cleanupOpenScan: 0, cleanupSaturated: false, skillPruneOpen: 0, skillPruneSaturated: false }),
      orchBoardDegraded: "0",
    },
    hitlGrill: ok({ open: 17, saturated: true }),
    targetScan: {
      signalsDegraded: false,
      signals: ok({ truncated: false, needsTriageItems: [301, 299], backfillIdle: false, cleanupOpenScan: 0, cleanupSaturated: false, wireOrRetireTriage: 2, wireOrRetireUnlabelled: 0, designQaOpen: 0, designQaSaturated: false }),
      adrPresent: true,
    },
    targetRiskSurface: { manifest: ok({ ok: true, riskSurface: ["src/execution/", "src/risk/"], weight: 1.5 }) },
    retro: { runs: ok({ available: true, candidate: "9ede5aef" }), drillable: true, bundleFetchFailed: false },
    wayfinder: { frontier: "4880", ticketType: "task", inflightGlobal: 1 },
    tickets: ok("4890"),
    scoutAlerts: { eligible: ok(2), fetchFailed: false },
    realmShare: ok(0.123456),
    usageEligibility: ok('{"allow": true, "shed": ["scout_orch"], "usage": {"percentLast5h": 85.0, "percentSinceReset": 41.5}, "reasons": {"calibrated": true}}'),
    emergencyBrake: ok('{"engaged":false}'),
    classStats: ok('{"scoreboard":{"classes":[{"cls":"dev_orch","merged":3}]},"shadow":{"verdicts":[]}}'),
    capacity: ok({ share: 0.5, floorMet: true, floorStatus: "met", window: 7 }),
    scheduler: { codexRunning: ok(false), scheduler: ok({ state: "running", nonMerges: 1 }) },
    recommendations: ok({ count: 0, firstAction: null }),
    slotEvents: ok('{"events": [{"id": "1791-0", "kind": "subagent_stop", "slot": "dev_orch"}], "last_id": "1791-0"}'),
  };
}

function fallbackValues(): TurnSnapshotValues {
  return {
    health: { service: FAILED, failedServices: 0, failedServicesFallbackZero: true },
    directionDrift: false,
    orchBoard: orchBoardFallbackSnapshot("collector-crashed"),
    targetBoard: targetBoardFallbackSnapshot("collector-crashed"),
    untriagedOrphans: FAILED,
    needsQaNumbers: FAILED,
    prGate: prGateFallbackSnapshot("collector-crashed"),
    picks: picksFallbackSnapshot(),
    redisQueues: { "work-queue": FAILED, "reframe-queue": FAILED, "prior-failures": FAILED },
    scout: { lastWalkIso: FAILED, openEnhancements: FAILED, tokensToday: "0", spendUsd: "0.00", mirrored: FAILED },
    archBoards: { lastRunIso: FAILED, workQueue: 1, board: FAILED, orchBoardDegraded: "1" },
    hitlGrill: FAILED,
    targetScan: targetScanFallbackSnapshot("collector-crashed"),
    targetRiskSurface: { manifest: { ok: false, reason: "collector crashed" } },
    retro: { runs: FAILED, drillable: null, bundleFetchFailed: false },
    wayfinder: { frontier: null, ticketType: "", inflightGlobal: 0 },
    tickets: FAILED,
    scoutAlerts: { eligible: FAILED, fetchFailed: true },
    realmShare: FAILED,
    usageEligibility: FAILED,
    emergencyBrake: FAILED,
    classStats: FAILED,
    capacity: FAILED,
    scheduler: { codexRunning: FAILED, scheduler: FAILED },
    recommendations: FAILED,
    slotEvents: FAILED,
  };
}

/** The kv quirks the JSON reproduces on purpose, plus the "previous value kept" arms. */
function edgeValues(): TurnSnapshotValues {
  const h = healthyValues();
  return {
    ...h,
    // service status not `ok`, but no failed unit
    health: { service: ok({ status: "degraded", redis: false }), failedServices: 0, failedServicesFallbackZero: true },
    // the gh-derived counts line starts {"blocked"… → invisible to merge-signals.py
    orchBoard: {
      counts: { source: "derived", values: { needs_qa: 4, ready_for_agent: 5, needs_triage: 1, needs_research: 0, in_progress: 0, blocked: 0, stale_in_progress: 0, stale_blocked: 0 } as never },
      boardState: null,
      orchBoardDegraded: true,
      needsTriageItems: ok([]),
    },
    // an un-tallied Target payload (blank line), a failed WIP read
    targetBoard: { ...h.targetBoard, counts: ok(null), wip: FAILED, needsQaPr: { ref: "", head: "" }, devResumePick: ok(null) },
    needsQaNumbers: FAILED,
    prGate: {
      ...h.prGate,
      ciTriggerStale: ok(true),
      glmRed: ok({ bucket: [4881, 4882], pick: null }),
      devResumePick: FAILED,
      dirtyFix: ok({ pick: null, surface: [] }),
    },
    picks: { ...h.picks, grillPick: null, devReadyPick: null, candidateExclusions: [], boardDegraded: true },
    scout: { lastWalkIso: ok("2020-01-01T00:00:00"), openEnhancements: ok("3"), tokensToday: "0", spendUsd: "n/a", mirrored: FAILED },
    targetScan: { ...h.targetScan, adrPresent: false },
    retro: { runs: ok({ available: true, candidate: "abc" }), drillable: null, bundleFetchFailed: true },
    wayfinder: { frontier: null, ticketType: "", inflightGlobal: 2 },
    tickets: ok(null),
    realmShare: ok(0.99995),
    // unparseable body → absent (the kv path keeps the previous state value)
    usageEligibility: ok("<html>502 Bad Gateway</html>"),
    // a body with a newline — the kv line carried only its first line
    classStats: ok('{"scoreboard":{"classes":[]},"shadow":{"verdicts":[]}}\n{"trailing":1}'),
    slotEvents: ok('{"events": [], "last_id": null}'),
  };
}

const SCENARIOS: Record<string, () => TurnSnapshotValues> = {
  healthy: healthyValues,
  "all-fallback": fallbackValues,
  edge: edgeValues,
};

/** The kv lines the same values render to, in collect-state.sh's emit order. */
function renderAllKv(v: TurnSnapshotValues): string {
  return [
    renderHealthKv(v.health),
    renderDirectionDriftKv(v.directionDrift),
    renderOrchBoardKv(v.orchBoard),
    renderTargetBoardKv(v.targetBoard),
    renderUntriagedOrphansKv(v.untriagedOrphans),
    renderNeedsQaNumbersKv(v.needsQaNumbers),
    renderPrGateKv(v.prGate),
    renderPicksKv(v.picks),
    renderRedisQueuesKv(v.redisQueues),
    renderScoutKv(v.scout),
    renderArchCleanupBoardsKv(v.archBoards),
    renderHitlGrillKv(v.hitlGrill),
    renderTargetScanKv(v.targetScan),
    renderTargetRiskSurfaceKv(v.targetRiskSurface),
    renderRetroKv(v.retro),
    renderWayfinderKv(v.wayfinder),
    renderTicketsKv(v.tickets),
    renderScoutAlertsKv(v.scoutAlerts),
    renderRealmShareKv(v.realmShare),
    renderUsageEligibilityKv(v.usageEligibility),
    renderEmergencyBrakeKv(v.emergencyBrake),
    renderClassStatsKv(v.classStats),
    renderCapacityKv(v.capacity),
    renderSchedulerKv(v.scheduler),
    renderRecommendationsKv(v.recommendations),
    renderSlotEventsKv(v.slotEvents),
  ].join("");
}

function emit(name: string): string {
  return serializeTurnSnapshot(buildTurnSnapshot(SCENARIOS[name]!(), { nowMs: NOW_MS })).text;
}

function python(script: string, input?: string): any {
  const res = spawnSync("python3", [join(PARITY_DIR, script)], { input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
  assert.equal(res.status, 0, `${script} exited ${res.status}: ${res.stderr}\n${res.stdout.slice(0, 2000)}`);
  return JSON.parse(res.stdout);
}

// Golden regeneration happens before any suite collects (the suites below read the files at collection time).
if (UPDATE_GOLDEN) for (const name of Object.keys(SCENARIOS)) writeFileSync(join(PARITY_DIR, `golden-${name}.json`), emit(name));

// ---------------------------------------------------------------------------

describe("turn snapshot JSON: plan parity over every captured decide() input (#4934)", () => {
  test("legacy kv state and JSON-only state produce an identical Plan for every corpus entry", () => {
    const r = python("plan_parity.py");
    assert.ok(r.entries >= 600, `corpus shrank to ${r.entries} entries — regenerate it (capture/sitecustomize.py)`);
    assert.ok(r.with_signals >= 300, `only ${r.with_signals} entries carry signals — the corpus no longer exercises the accessor`);
    assert.deepEqual(r.unrepresentable, []);
    assert.deepEqual(r.diverged, []);
    assert.equal(r.identical, r.entries);
  });
});

describe("turn snapshot JSON: wire parity with merge-signals.py (#4934)", () => {
  const cases = Object.keys(SCENARIOS).map((name) => ({ name, kv: renderAllKv(SCENARIOS[name]!()), snapshot: emit(name) }));
  const results: any[] = python("wire_parity.py", JSON.stringify(cases)).cases;

  for (const r of results) {
    test(`${r.name}: merge-signals(kv) and apply(json) write the same state fields`, () => {
      assert.deepEqual(r.diffs, {});
      assert.equal(r.state_equal, true);
    });
    test(`${r.name}: decide.py plans identically from the kv state and the JSON-only state`, () => {
      assert.equal(r.plan_equal, true);
    });
  }

  test("the healthy scenario is not vacuous (decide.py dispatches from it)", () => {
    assert.ok(results.find((r) => r.name === "healthy").plan_actions > 0);
  });
});

describe("turn snapshot JSON: contract — golden documents through zod and the Python accessor (#4934)", () => {
  for (const name of Object.keys(SCENARIOS)) {
    test(`${name}: the emitted document matches its golden file byte for byte and validates`, () => {
      const text = emit(name);
      const path = join(PARITY_DIR, `golden-${name}.json`);
      assert.equal(text, readFileSync(path, "utf-8"));
      const parsed = TurnSnapshotSchema.safeParse(JSON.parse(text));
      assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
      assert.deepEqual(JSON.parse(text).validation, { ok: true });
    });
  }

  const goldens = Object.keys(SCENARIOS).map((name) => ({ name, kv: "", snapshot: readFileSync(join(PARITY_DIR, `golden-${name}.json`), "utf-8") }));
  const readings: any[] = python("wire_parity.py", JSON.stringify(goldens)).cases;

  for (const r of readings) {
    test(`${r.name}: every typed field reads back through turn_snapshot.py unchanged`, () => {
      const doc = JSON.parse(goldens.find((g) => g.name === r.name)!.snapshot);
      const rd = r.readings;
      for (const [key, value] of Object.entries(doc.signals as Record<string, unknown>)) {
        assert.ok(rd[key], `the accessor never saw ${key}`);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          const p = value as { issue: number; pr: number; branch: string };
          assert.deepEqual(rd[key].pin, [p.issue, p.pr, p.branch], key);
        } else if (Array.isArray(value) && key === "orch_prs_dirty_surface") {
          const pairs = (value as { pr: number; closing_issue: number | null }[]).map((e) => [e.pr, e.closing_issue]).sort((a, b) => (a[0] as number) - (b[0] as number));
          assert.deepEqual(rd[key].pairs, pairs, key);
        } else if (Array.isArray(value)) {
          assert.deepEqual(rd[key].ordered, value, key);
          assert.deepEqual(rd[key].prs, [...new Set(value as number[])].sort((a, b) => a - b), key);
        } else if (["orch_pending_grill_anchor", "orch_dev_ready_anchor", "wayfinder_orch_frontier", "tickets_orch_pending_spec"].includes(key)) {
          assert.equal(rd[key].anchor, value === null ? null : `issue-${value}`, key);
        } else if (key === "target_dev_resume_pick" || key.endsWith("_forward_fix") || key === "orch_dev_resume_pick") {
          assert.equal(rd[key].pin, null, key);
        } else {
          assert.deepEqual(rd[key].scalar, value, key);
          assert.equal(rd[key].present, Boolean(value), key);
        }
      }
      for (const [field, value] of Object.entries(doc.blobs as Record<string, unknown>)) {
        if (field === "slot_events") {
          // a per-turn working buffer apply() seeds on state (Decision 8), not a blob read
          const ev = value as { events?: unknown; last_id?: unknown };
          assert.deepEqual(rd._slot_events.events, Array.isArray(ev.events) ? ev.events : [], field);
          if (ev.last_id) assert.equal(rd._slot_events.last_id, ev.last_id);
        } else assert.deepEqual(rd._blobs[field], value, field);
      }
      if ("scout_spend_usd_today" in doc) assert.equal(rd._blobs.scout_spend_usd_today, doc.scout_spend_usd_today);
    });
  }

  test("the edge golden records the documented divergences as degraded markers", () => {
    const doc = JSON.parse(readFileSync(join(PARITY_DIR, "golden-edge.json"), "utf-8"));
    assert.equal("usage_eligibility" in doc.blobs, false, "an unparseable body is absent, never a fabricated default");
    assert.equal("scout_spend_usd_today" in doc, false);
    const fields = doc.degraded.map((d: { field: string }) => d.field);
    assert.ok(fields.includes("usage_eligibility") && fields.includes("scout_spend_usd_today"), JSON.stringify(doc.degraded));
    assert.equal(doc.signals.orch_work_available, false, "the derived counts line is invisible to merge-signals.py — reproduced");
  });
});

describe("turn snapshot JSON: builder details (#4934)", () => {
  test("a non-numeric anchor becomes null plus a degraded marker (the packed wire would have dispatched on it)", () => {
    const v = { ...healthyValues(), wayfinder: { frontier: "abc", ticketType: "task", inflightGlobal: 0 } };
    const built = buildTurnSnapshot(v, { nowMs: NOW_MS });
    assert.equal(built.doc.signals.wayfinder_orch_frontier, null);
    assert.deepEqual(built.doc.degraded, [{ collector: "wayfinder-frontier", field: "wayfinder_orch_frontier", reason: "not-an-issue-number" }]);
  });

  test("a pin the packed wire could not carry (a branch with ':') is no pin, as decide.py's parser read it", () => {
    const h = healthyValues();
    const v = { ...h, prGate: { ...h.prGate, glmRed: ok({ bucket: [4881], pick: { issue: 4876, pr: 4881, headRefName: "bad:branch" } }) } };
    assert.equal(buildTurnSnapshot(v, { nowMs: NOW_MS }).doc.signals.orch_glm_red_forward_fix, null);
  });

  test("blobs are spliced as the exact kv JSON text (85.0 stays a float lexeme)", () => {
    const text = emit("healthy");
    assert.ok(text.includes('"percentLast5h": 85.0'), "the usage body must be the service's own text");
  });

  test("realm share rounds to the 4 dp the kv line carried", () => {
    assert.equal(JSON.parse(emit("healthy")).signals.orch_realm_weekly_share, 0.1235);
  });

  test("scout_walk_due follows merge-signals.py's stale_days", () => {
    assert.equal(staleDays("", 7, NOW_MS), true);
    assert.equal(staleDays("not-a-date", 7, NOW_MS), true);
    assert.equal(staleDays("2026-10-05T08:00:00Z", 7, NOW_MS), false);
    assert.equal(staleDays("2026-09-01T08:00:00+02:00", 7, NOW_MS), true);
    assert.equal(pyFromIsoformatEpoch("2026-10-07T12:00:00+00:00"), NOW_MS / 1000);
    assert.equal(pyFromIsoformatEpoch("2026-02-30"), null);
  });

  test("a schema violation is a validation marker plus a note, never a throw", () => {
    const built = buildTurnSnapshot(healthyValues(), { nowMs: NOW_MS });
    const broken = { ...built, doc: { ...built.doc, signals: { ...built.doc.signals, orch_prs_dirty: [0] } } };
    const out = serializeTurnSnapshot(broken);
    assert.equal(out.valid, false);
    assert.match(out.note ?? "", /failed schema validation.*signals\.orch_prs_dirty/);
    assert.equal(JSON.parse(out.text).validation.ok, false);
  });
});

describe("turn snapshot JSON: the CLI's --format json (#4934)", () => {
  /** Every adapter down: each method throws, so every collector takes its crash arm. */
  const down = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) => (prop === "then" ? undefined : prop === "close" ? () => {} : async () => {
          throw new Error("adapter down");
        }),
      },
    ) as never;

  test("--format json refuses --collectors / --exports-file (one run is every collector)", async () => {
    const err: string[] = [];
    const io = { stdout: () => {}, stderr: (t: string) => err.push(t), writeFile: () => {} };
    assert.equal(await main(["--format", "json", "--collectors", "health"], { github: down(), now: () => NOW_MS, sleep: async () => {} }, io), 2);
    assert.match(err.join(""), /drop --collectors/);
  });

  test("with every adapter down it still emits ONE valid, fully fail-closed snapshot (exit 0)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["--format", "json"],
      {
        github: down(),
        hydra: down(),
        now: () => NOW_MS,
        sleep: async () => {},
        env: {},
        passthrough: { host: down(), env: {}, taxonomyPath: "/nonexistent/classes.json", targetWorkspace: () => "/nonexistent" },
        remaining: { redis: down(), env: {} },
        target: () => ({ github: down(), hydra: down(), workspace: () => "/nonexistent", facts: () => ({ ok: false, errors: ["down"] }) }),
      },
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t), writeFile: () => {} },
    );
    assert.equal(code, 0);
    const doc = JSON.parse(out.join(""));
    assert.ok(TurnSnapshotSchema.safeParse(doc).success);
    assert.deepEqual(doc.validation, { ok: true });
    assert.equal(doc.signals.orch_board_signals_degraded, true);
    assert.equal(doc.signals.orch_dev_resume_pick, null);
    assert.equal(doc.signals.target_cleanup_board_saturated, true);
    assert.equal(doc.blobs.usage_eligibility.allow, true);
    assert.ok(doc.degraded.length > 0, "every crashed collector is named");
    assert.ok(err.join("").includes("crashed"), "the crashes are reported on stderr");
  });
});
