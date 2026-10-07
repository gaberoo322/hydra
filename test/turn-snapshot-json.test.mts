/**
 * The JSON Turn Snapshot (ADR-0043 Decision 5, issue #4934).
 *
 *   1. Plan parity (the critical gate): every distinct decide() input the
 *      existing test suite produces (test/fixtures/turn-snapshot-parity/
 *      decide-inputs.jsonl.gz, captured by capture/sitecustomize.py),
 *      converted to the JSON form with `signals` and every blob field REMOVED,
 *      yields a Plan byte-identical to the golden Plan recorded from the 6a
 *      expand PR's JSON path (decide-plans.jsonl.gz) — so decide.py reads
 *      nothing around scripts/autopilot/turn_snapshot.py and plans exactly as
 *      before the kv wire was retired.
 *   2. Contract: golden documents round-trip through the zod schema
 *      (src/schemas/turn-snapshot.ts) and the Python accessor
 *      (accessor_check.py). No generated JSON Schema is committed.
 *   3. Validation on emit degrades PER FIELD: an invalid field takes its
 *      all-degraded value with a marker and the rest survives; only a
 *      structurally invalid document becomes the all-degraded document.
 *   4. Every failure mode still plans: a failed emit, non-JSON, a wrong
 *      schema_version, validation.ok=false, a non-object signals map and a
 *      per-field-invalid document each reach decide.py (all-degraded or
 *      repaired) and produce a Plan; the all-degraded Plan is conservative.
 *   5. The all-degraded signals are ONE table in two languages (drift test).
 *   6. The CLI's `--format json` runs every collector in one process and never
 *      crashes, even with every adapter down.
 *
 * Regenerate the golden documents after an intentional shape change:
 *   UPDATE_TURN_SNAPSHOT_JSON_GOLDEN=1 npm run test:file -- test/turn-snapshot-json.test.mts
 * Re-record the golden Plans only for an INTENTIONAL decide.py change, from
 * the reference commit's scripts/autopilot (see plan_parity.py --write-golden).
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  allDegradedTurnSnapshot,
  buildTurnSnapshot,
  serializeTurnSnapshot,
  staleDays,
  pyFromIsoformatEpoch,
  type TurnSnapshotValues,
} from "../src/autopilot/turn-snapshot/json-snapshot.ts";
import { ALL_DEGRADED_SIGNALS, TurnSnapshotSchema } from "../src/schemas/turn-snapshot.ts";
import { prGateFallbackSnapshot } from "../src/autopilot/turn-snapshot/pr-gate.ts";
import { picksFallbackSnapshot } from "../src/autopilot/turn-snapshot/picks.ts";
import { orchBoardFallbackSnapshot } from "../src/autopilot/turn-snapshot/orch-board.ts";
import { targetBoardFallbackSnapshot } from "../src/autopilot/turn-snapshot/target-board.ts";
import { targetScanFallbackSnapshot } from "../src/autopilot/turn-snapshot/target-scan-boards.ts";
import { main } from "../scripts/autopilot/turn-snapshot.ts";
import { runTargetCollectors } from "../src/autopilot/turn-snapshot/target-cli.ts";

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
    health: { service: ok({ status: "ok", redis: true }), failedServices: 0 },
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
    retro: { runs: ok({ available: true, candidate: "9ede5aef" }), drillable: true },
    wayfinder: { frontier: "4880", ticketType: "task", inflightGlobal: 1 },
    tickets: ok("4890"),
    scoutAlerts: { eligible: ok(2) },
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
    health: { service: FAILED, failedServices: 0 },
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
    retro: { runs: FAILED, drillable: null },
    wayfinder: { frontier: null, ticketType: "", inflightGlobal: 0 },
    tickets: FAILED,
    scoutAlerts: { eligible: FAILED },
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

/** The inherited derivations (TODO(#4949), fromisoformat), the degraded arms and the "previous value kept" arms. */
function edgeValues(): TurnSnapshotValues {
  const h = healthyValues();
  return {
    ...h,
    // service status not `ok`, but no failed unit
    health: { service: ok({ status: "degraded", redis: false }), failedServices: 0 },
    // the gh-derived counts read as zero (TODO(#4949))
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
    retro: { runs: ok({ available: true, candidate: "abc" }), drillable: null },
    wayfinder: { frontier: null, ticketType: "", inflightGlobal: 2 },
    tickets: ok(null),
    realmShare: ok(0.99995),
    // unparseable body → absent (the previous state value is kept)
    usageEligibility: ok("<html>502 Bad Gateway</html>"),
    // a body with trailing data after the JSON value → unparseable → absent
    classStats: ok('{"scoreboard":{"classes":[]},"shadow":{"verdicts":[]}}\n{"trailing":1}'),
    slotEvents: ok('{"events": [], "last_id": null}'),
  };
}

const SCENARIOS: Record<string, () => TurnSnapshotValues> = {
  healthy: healthyValues,
  "all-fallback": fallbackValues,
  edge: edgeValues,
};

function emit(name: string): string {
  return serializeTurnSnapshot(buildTurnSnapshot(SCENARIOS[name]!(), { nowMs: NOW_MS })).text;
}

function python(script: string, input?: string, args: string[] = []): any {
  const res = spawnSync("python3", [join(PARITY_DIR, script), ...args], { input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
  assert.equal(res.status, 0, `${script} exited ${res.status}: ${res.stderr}\n${res.stdout.slice(0, 2000)}`);
  return JSON.parse(res.stdout);
}

// Golden regeneration happens before any suite collects (the suites below read the files at collection time).
if (UPDATE_GOLDEN) for (const name of Object.keys(SCENARIOS)) writeFileSync(join(PARITY_DIR, `golden-${name}.json`), emit(name));

// ---------------------------------------------------------------------------

describe("turn snapshot JSON: plan parity over every captured decide() input (#4934)", () => {
  const dumpDir = mkdtempSync(join(tmpdir(), "turn-snapshot-parity-"));
  const dump = join(dumpDir, "converted.jsonl");
  after(() => rmSync(dumpDir, { recursive: true, force: true }));

  test("the JSON-only state yields the golden Plan (the 6a JSON path) for every corpus entry", () => {
    const r = python("plan_parity.py", undefined, ["--dump", dump]);
    assert.ok(r.entries >= 600, `corpus shrank to ${r.entries} entries — regenerate it (capture/sitecustomize.py)`);
    assert.equal(r.golden, r.entries, "one golden Plan per corpus entry");
    assert.ok(r.with_signals >= 300, `only ${r.with_signals} entries carry signals — the corpus no longer exercises the accessor`);
    assert.ok(r.distinct_plans >= 400, `only ${r.distinct_plans} distinct Plans — the corpus no longer discriminates`);
    assert.deepEqual(r.unrepresentable, []);
    assert.deepEqual(r.diverged, []);
    assert.equal(r.identical, r.entries);
  });

  test("every converted JSON-form value the parity run fed decide.py is schema-valid (zod, per field)", () => {
    const signalShape = (TurnSnapshotSchema.shape.signals as unknown as { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape;
    const blobShape = (TurnSnapshotSchema.shape.blobs as unknown as { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape;
    const bad: string[] = [];
    let checked = 0;
    const docs = readFileSync(dump, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(docs.length >= 600, `only ${docs.length} converted documents were dumped`);
    for (const d of docs) {
      assert.equal(TurnSnapshotSchema.shape.schema_version.safeParse(d.schema_version).success, true);
      assert.equal(TurnSnapshotSchema.shape.validation.safeParse(d.validation).success, true);
      for (const [k, v] of Object.entries(d.signals as Record<string, unknown>)) {
        // a key outside the schema is a fixture-authored producerless signal, carried verbatim
        if (!signalShape[k]) continue;
        checked++;
        if (!signalShape[k].safeParse(v).success) bad.push(`signals.${k}=${JSON.stringify(v)}`);
      }
      for (const [k, v] of Object.entries(d.blobs as Record<string, unknown>)) {
        checked++;
        if (!blobShape[k]?.safeParse(v).success) bad.push(`blobs.${k}`);
      }
    }
    assert.deepEqual(bad, []);
    assert.ok(checked >= 1000, `only ${checked} converted values were checked`);
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

  const goldens = Object.keys(SCENARIOS).map((name) => ({ name, snapshot: readFileSync(join(PARITY_DIR, `golden-${name}.json`), "utf-8") }));
  const readings: any[] = python("accessor_check.py", JSON.stringify(goldens)).cases;

  for (const r of readings) {
    test(`${r.name}: every typed field reads back through turn_snapshot.py unchanged, and decide.py plans`, () => {
      const doc = JSON.parse(goldens.find((g) => g.name === r.name)!.snapshot);
      assert.equal(r.form, "json");
      assert.equal(r.plan_ok, true, r.error);
      assert.deepEqual(r.degraded, doc.degraded, "a valid document is stored as emitted (no repair markers)");
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
    assert.ok(fields.includes("class_stats"), "a body with trailing data is unparseable → absent + marker");
    assert.equal("class_stats" in doc.blobs, false);
    assert.equal(doc.signals.orch_work_available, false, "the derived counts read as zero — inherited, TODO(#4949)");
  });

  test("the healthy scenario is not vacuous (decide.py dispatches from it)", () => {
    assert.ok(readings.find((r) => r.name === "healthy").actions.some((a: { type: string }) => a.type === "dispatch"));
  });

  test("the observability section carries the collector values no decide.py rule reads", () => {
    const doc = JSON.parse(readFileSync(join(PARITY_DIR, "golden-healthy.json"), "utf-8"));
    assert.deepEqual(Object.keys(doc.observability).sort(), ["capacity", "direction_drift", "health", "recommendations", "redis_queues", "scheduler"]);
    assert.equal(doc.observability.scheduler.stall, "ok");
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

  test("blobs are spliced as the service's exact JSON text (85.0 stays a float lexeme)", () => {
    const text = emit("healthy");
    assert.ok(text.includes('"percentLast5h": 85.0'), "the usage body must be the service's own text");
  });

  test("realm share rounds to 4 dp (the precision decide.py's cap has always compared at)", () => {
    assert.equal(JSON.parse(emit("healthy")).signals.orch_realm_weekly_share, 0.1235);
  });

  test("scout_board_saturated is pinned at > 20 open enhancements (a strict cap)", () => {
    const at = (open: string) => {
      const h = healthyValues();
      return buildTurnSnapshot({ ...h, scout: { ...h.scout, openEnhancements: ok(open) } }, { nowMs: NOW_MS }).doc.signals.scout_board_saturated;
    };
    assert.equal(at("20"), false, "20 open is at the cap, not over it");
    assert.equal(at("21"), true);
  });

  test("scout_walk_due is pinned at 7 days (6.9 fresh, 7.1 due)", () => {
    const at = (days: number) => {
      const h = healthyValues();
      const iso = new Date(NOW_MS - days * 86_400_000).toISOString();
      return buildTurnSnapshot({ ...h, scout: { ...h.scout, lastWalkIso: ok(iso) } }, { nowMs: NOW_MS }).doc.signals.scout_walk_due;
    };
    assert.equal(at(6.9), false);
    assert.equal(at(7.1), true);
    assert.equal(staleDays(new Date(NOW_MS - 6.9 * 86_400_000).toISOString(), 7, NOW_MS), false);
    assert.equal(staleDays(new Date(NOW_MS - 7.1 * 86_400_000).toISOString(), 7, NOW_MS), true);
  });

  test("scout_walk_due follows stale_days (empty / unparseable → due)", () => {
    assert.equal(staleDays("", 7, NOW_MS), true);
    assert.equal(staleDays("not-a-date", 7, NOW_MS), true);
    assert.equal(staleDays("2026-10-05T08:00:00Z", 7, NOW_MS), false);
    assert.equal(staleDays("2026-09-01T08:00:00+02:00", 7, NOW_MS), true);
    assert.equal(pyFromIsoformatEpoch("2026-10-07T12:00:00+00:00"), NOW_MS / 1000);
    assert.equal(pyFromIsoformatEpoch("2026-02-30"), null);
  });

});

// ---------------------------------------------------------------------------
// Validation on emit — per-field repair (TS)
// ---------------------------------------------------------------------------

describe("turn snapshot JSON: validation degrades PER FIELD on emit (#4934)", () => {
  const built = () => buildTurnSnapshot(healthyValues(), { nowMs: NOW_MS });

  test("an invalid signal takes its all-degraded value with a marker; every other field survives", () => {
    const b = built();
    const broken = { ...b, doc: { ...b.doc, signals: { ...b.doc.signals, orch_prs_dirty: [0], hitl_grill_open: -3 } } };
    const out = serializeTurnSnapshot(broken);
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, true);
    assert.equal(out.repaired, true);
    assert.match(out.note ?? "", /failed schema validation.*signals\.orch_prs_dirty.*repaired/);
    assert.deepEqual(doc.validation, { ok: true });
    assert.ok(TurnSnapshotSchema.safeParse(doc).success);
    assert.deepEqual(doc.signals.orch_prs_dirty, ALL_DEGRADED_SIGNALS.orch_prs_dirty);
    assert.equal(doc.signals.hitl_grill_open, ALL_DEGRADED_SIGNALS.hitl_grill_open);
    // the rest of the document is the emitted one
    const { orch_prs_dirty: _a, hitl_grill_open: _b, ...rest } = doc.signals;
    const { orch_prs_dirty: _c, hitl_grill_open: _d, ...want } = JSON.parse(serializeTurnSnapshot(b).text).signals;
    assert.deepEqual(rest, want);
    assert.equal(doc.blobs.usage_eligibility.allow, true, "blobs survive");
    const markers = doc.degraded.filter((d: { collector: string }) => d.collector === "turn-snapshot");
    assert.deepEqual(markers.map((d: { field: string }) => d.field).sort(), ["signals.hitl_grill_open", "signals.orch_prs_dirty"]);
    assert.ok(markers.every((d: { reason: string }) => d.reason.startsWith("schema-invalid: ")));
  });

  test("an unknown signal is dropped with a marker", () => {
    const b = built();
    const out = serializeTurnSnapshot({ ...b, doc: { ...b.doc, signals: { ...b.doc.signals, bogus_signal: true } as never } });
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, true);
    assert.equal("bogus_signal" in doc.signals, false);
    assert.ok(doc.degraded.some((d: { field: string }) => d.field === "signals.bogus_signal"));
  });

  test("an invalid blob is dropped (absent = previous state value kept) with a marker; its raw text is not spliced", () => {
    const b = built();
    const out = serializeTurnSnapshot({ ...b, doc: { ...b.doc, blobs: { ...b.doc.blobs, candidate_exclusions: [{ anchor: 1 }] as never } } });
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, true);
    assert.equal("candidate_exclusions" in doc.blobs, false);
    assert.ok(doc.degraded.some((d: { field: string }) => d.field === "blobs.candidate_exclusions"));
    assert.ok(out.text.includes('"percentLast5h": 85.0'), "the other blobs keep their spliced text");
  });

  test("an invalid scout spend / degraded entry / observability is dropped, the rest survives", () => {
    const b = built();
    const out = serializeTurnSnapshot({
      ...b,
      doc: { ...b.doc, scout_spend_usd_today: -1, degraded: [{ collector: "", field: "x", reason: "y" }], observability: "nope" as never },
    });
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, true);
    assert.equal("scout_spend_usd_today" in doc, false);
    assert.equal("observability" in doc, false);
    assert.equal(doc.degraded.some((d: { collector: string }) => d.collector === ""), false);
    assert.ok(doc.degraded.some((d: { field: string; reason: string }) => d.field === "degraded" && d.reason === "malformed-entry-dropped"));
    assert.deepEqual(doc.signals, JSON.parse(serializeTurnSnapshot(b).text).signals);
  });

  test("only a STRUCTURAL fault (here a wrong schema_version) replaces the whole document with the all-degraded one", () => {
    const b = built();
    const out = serializeTurnSnapshot({ ...b, doc: { ...b.doc, schema_version: 2 as never } });
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, false);
    assert.match(out.note ?? "", /structurally invalid.*all-degraded/);
    assert.ok(TurnSnapshotSchema.safeParse(doc).success, "the replacement is itself a valid document");
    assert.deepEqual(doc.signals, ALL_DEGRADED_SIGNALS);
    assert.deepEqual(doc.blobs, {});
    assert.equal(doc.degraded.length, 1);
    assert.match(doc.degraded[0].reason, /^schema-invalid: schema_version/);
  });

  test("a valid document is emitted untouched (no repair, no note)", () => {
    const out = serializeTurnSnapshot(built());
    assert.equal(out.valid, true);
    assert.equal(out.repaired, false);
    assert.equal(out.note, null);
  });
});

// ---------------------------------------------------------------------------
// Every failure mode still plans (Python apply + decide.py)
// ---------------------------------------------------------------------------

describe("turn snapshot JSON: every failure mode still produces a Plan (#4934)", () => {
  const healthy = emit("healthy");
  const healthyDoc = JSON.parse(healthy);
  const variant = (f: (d: any) => void) => {
    const d = structuredClone(healthyDoc);
    f(d);
    return JSON.stringify(d);
  };
  const cases: { name: string; snapshot: string | null }[] = [
    { name: "emit-failed", snapshot: null },
    { name: "empty", snapshot: "" },
    { name: "not-json", snapshot: "<html>502 Bad Gateway</html>" },
    { name: "truncated", snapshot: healthy.slice(0, healthy.length / 2) },
    { name: "not-an-object", snapshot: "[1, 2]" },
    { name: "schema-version", snapshot: variant((d) => (d.schema_version = 2)) },
    { name: "validation-false", snapshot: variant((d) => (d.validation = { ok: false, issues: [] })) },
    { name: "signals-not-object", snapshot: variant((d) => (d.signals = "x")) },
    {
      name: "per-field",
      snapshot: variant((d) => {
        d.signals.orch_work_available = "yes";
        d.signals.orch_dev_resume_pick = { issue: 4718, pr: "x", branch: "b" };
        delete d.signals.health_fail;
        d.signals.made_up = 1;
        d.blobs.candidate_exclusions = "nope";
        d.blobs.unknown_blob = {};
        d.scout_spend_usd_today = "free";
        d.degraded.push({ collector: 3 });
      }),
    },
  ];
  const results: any[] = python("accessor_check.py", JSON.stringify(cases)).cases;
  const byName = (n: string) => results.find((r) => r.name === n);

  for (const c of cases) {
    test(`${c.name}: apply never fails and decide.py returns a Plan`, () => {
      const r = byName(c.name);
      assert.equal(r.plan_ok, true, r.error);
      assert.ok(Array.isArray(r.actions));
    });
  }

  test("every structurally unusable document reads as the all-degraded snapshot", () => {
    for (const n of ["emit-failed", "empty", "not-json", "truncated", "not-an-object", "schema-version", "validation-false", "signals-not-object"]) {
      const r = byName(n);
      assert.equal(r.form, "all-degraded", n);
      assert.equal(r.degraded.length, 1, n);
      assert.equal(r.degraded[0].field, "*", n);
      for (const [k, v] of Object.entries(ALL_DEGRADED_SIGNALS)) {
        if (Array.isArray(v)) assert.deepEqual(r.readings[k].scalar, v, `${n}: ${k}`);
        else assert.equal(r.readings[k].scalar, v, `${n}: ${k}`);
      }
    }
  });

  test("a per-field-invalid document keeps every valid field and degrades only the bad ones, with markers", () => {
    const r = byName("per-field");
    assert.equal(r.form, "json");
    assert.equal(r.readings.orch_work_available.scalar, false, "a non-bool flag → its all-degraded value");
    assert.equal(r.readings.orch_dev_resume_pick.pin, null, "a malformed pin → none");
    assert.equal(r.readings.health_fail.scalar, true, "a missing signal → its all-degraded value");
    assert.equal(r.readings.made_up, undefined, "an unknown signal is dropped");
    // valid fields survive untouched
    assert.deepEqual(r.readings.orch_prs_dirty.ordered, healthyDoc.signals.orch_prs_dirty);
    assert.equal(r.readings.target_needs_qa_pr_ref.text, healthyDoc.signals.target_needs_qa_pr_ref);
    assert.deepEqual(r.readings.orch_glm_red_forward_fix.pin, [4876, 4881, "worktree-agent-glm-4876-1791218911"]);
    assert.deepEqual(r.readings._blobs.usage_eligibility, healthyDoc.blobs.usage_eligibility, "a valid blob survives");
    const markers = r.degraded.filter((d: { collector: string }) => d.collector === "turn-snapshot");
    const fields = markers.map((d: { field: string }) => d.field).sort();
    assert.deepEqual(fields, ["candidate_exclusions", "degraded", "health_fail", "made_up", "orch_dev_resume_pick", "orch_work_available", "scout_spend_usd_today", "unknown_blob"]);
  });

  test("the all-degraded Plan is conservative: the doctor runs, no snapshot-driven producer or worker dispatches", () => {
    const r = byName("emit-failed");
    const dispatched = r.actions.filter((a: { type: string }) => a.type === "dispatch");
    assert.ok(dispatched.some((a: { slot: string; skill: string }) => a.slot === "health" && a.skill === "hydra-doctor"), JSON.stringify(r.actions));
    for (const a of dispatched) {
      if (a.slot === "health") continue;
      // the only other dispatch the base fixture can earn is a TIME-based staleness floor, never a snapshot fact
      assert.equal(a.slot, "discover_orch", JSON.stringify(a));
      assert.match(a.reason, /staleness floor/);
    }
  });
});

// ---------------------------------------------------------------------------
// The all-degraded signals: one table, two languages
// ---------------------------------------------------------------------------

describe("turn snapshot JSON: the all-degraded snapshot (#4934)", () => {
  test("ALL_DEGRADED_SIGNALS covers exactly the schema's signals and validates", () => {
    const keys = Object.keys((TurnSnapshotSchema.shape.signals as unknown as { shape: Record<string, unknown> }).shape).sort();
    assert.deepEqual(Object.keys(ALL_DEGRADED_SIGNALS).sort(), keys);
    assert.ok(TurnSnapshotSchema.safeParse(allDegradedTurnSnapshot("t", "r")).success);
  });

  test("turn_snapshot.py holds the SAME table (drift guard)", () => {
    const res = spawnSync(
      "python3",
      ["-c", "import json,sys; sys.path.insert(0, sys.argv[1]); import turn_snapshot as ts; print(json.dumps(ts.ALL_DEGRADED_SIGNALS))", join(REPO_ROOT, "scripts", "autopilot")],
      { encoding: "utf-8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(res.stdout), ALL_DEGRADED_SIGNALS);
  });

  test("it is conservative by construction: nothing available or due, every producer cap saturated, the doctor raised", () => {
    const s = ALL_DEGRADED_SIGNALS as Record<string, unknown>;
    for (const [k, v] of Object.entries(s)) {
      if (k.endsWith("_saturated") || k === "health_fail" || k === "orch_board_signals_degraded") assert.equal(v, true, k);
      else if (typeof v === "boolean") assert.equal(v, false, k);
    }
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

  test("runTargetCollectors returns each collector's degraded markers, attributed", async () => {
    const out = await runTargetCollectors(
      ["target-risk-surface"],
      { ghListLimit: 100 },
      () => ({ github: down(), hydra: down(), workspace: () => "/nonexistent", facts: () => ({}) }),
      { stderr: () => {} },
    );
    assert.deepEqual(out.degraded, [{ collector: "target-risk-surface", field: "manifest", reason: "no manifest field" }]);
    const crashed = await runTargetCollectors(["target-board"], { ghListLimit: 100 }, undefined, { stderr: () => {} });
    assert.deepEqual(crashed.degraded, [{ collector: "target-board", field: "target-board", reason: "collector-crashed" }]);
  });

  test("--format json refuses --collectors (one run is every collector)", async () => {
    const err: string[] = [];
    const io = { stdout: () => {}, stderr: (t: string) => err.push(t) };
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
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
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
    // the Target family's markers reach the envelope too (crash arms and a non-crash degraded read)
    const collectors = new Set(doc.degraded.map((d: { collector: string }) => d.collector));
    for (const c of ["target-board", "target-scan-boards", "target-risk-surface"]) assert.ok(collectors.has(c), `${c} missing from degraded: ${JSON.stringify(doc.degraded)}`);
    assert.ok(
      doc.degraded.some((d: { collector: string; field: string; reason: string }) => d.collector === "target-risk-surface" && d.field === "manifest" && d.reason === "no manifest field"),
      "the risk-surface collector's own (non-crash) marker is carried, not only crash markers",
    );
    assert.ok(err.join("").includes("crashed"), "the crashes are reported on stderr");
  });
});
