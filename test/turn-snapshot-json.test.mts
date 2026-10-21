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
 *      (accessor_check.py), which stores each one AS EMITTED (store-only,
 *      #5083). No generated JSON Schema is committed.
 *   3. Validation on emit degrades PER FIELD: an invalid field takes its
 *      all-degraded value with a marker and the rest survives; only a
 *      structurally invalid document becomes the all-degraded document. The
 *      TS emitter is the ONLY validator (the Python repair was deleted, #5083).
 *   4. Every failure mode still plans: a failed emit (the marker document),
 *      non-JSON, a non-object document or signals map, and the TS
 *      all-degraded document each reach decide.py and produce a Plan; the
 *      marker plans exactly as the all-degraded document, conservatively.
 *   5. The all-degraded signals are ONE table, in TS, conservative by a naming
 *      convention the marker reading relies on.
 *   6. The CLI's `--format json` runs every collector in one process and never
 *      crashes, even with every adapter down; `--all-degraded` prints the
 *      all-degraded document (turn.sh's fallback, #5083).
 *   7. Replay mode fails loud: with HYDRA_AUTOPILOT_SNAPSHOT_REPLAY set, a
 *      signal decide.py reads that the document lacks raises; in production
 *      the same read degrades (#5083).
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
/** Every signal key the schema defines (the readings each accessor case reports). */
const SIGNAL_KEYS = Object.keys((TurnSnapshotSchema.shape.signals as unknown as { shape: Record<string, unknown> }).shape).sort();
/** The env with the replay switch removed (production reads) or set (fail-loud reads). */
const productionEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.HYDRA_AUTOPILOT_SNAPSHOT_REPLAY;
  return env;
};

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
      qaVerdictRecheck: ok([]),
      ciTriggerStale: ok(false),
      redResume: ok([4890]),
      devResumePick: ok({ issue: 4718, pr: 4890, headRefName: "worktree-agent-a1b2" }),
      devResumeNoprPick: ok(4806),
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

/** The inherited derivation (fromisoformat), the degraded arms and the "previous value kept" arms. */
function edgeValues(): TurnSnapshotValues {
  const h = healthyValues();
  return {
    ...h,
    // service status not `ok`, but no failed unit
    health: { service: ok({ status: "degraded", redis: false }), failedServices: 0 },
    // the gh-derived counts (the #4949 fallback path)
    orchBoard: {
      counts: { source: "derived", values: { needs_qa: 4, ready_for_agent: 5, needs_triage: 1, needs_research: 0, in_progress: 0, blocked: 0, stale_in_progress: 0, stale_blocked: 0 } as never },
      boardState: null,
      orchBoardDegraded: true,
      needsTriageItems: ok([]),
    },
    // a failed Target counts read (every count key emits 0), a failed WIP read
    targetBoard: { ...h.targetBoard, counts: FAILED, wip: FAILED, needsQaPr: { ref: "", head: "" }, devResumePick: ok(null) },
    needsQaNumbers: FAILED,
    prGate: {
      ...h.prGate,
      ciTriggerStale: ok(true),
      redResume: ok([4881, 4882]),
      devResumePick: FAILED,
      devResumeNoprPick: FAILED,
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

/**
 * `healthyValues` with ONLY the board-state read degraded (#4949): the service
 * body is unusable, so the collector took the `deriveBoardState` fallback over
 * the gh rows — non-zero counts, everything else healthy. This is the
 * production shape of "the data plane is down, gh still answers":
 * `orchBoardDegraded` stays false (the #4130 flag is set only on a FAILED
 * fallback read, and a successful derived read never flips it).
 */
function boardStateDownValues(): TurnSnapshotValues {
  const h = healthyValues();
  return {
    ...h,
    orchBoard: {
      counts: {
        source: "derived",
        values: { needs_qa: 4, ready_for_agent: 3, needs_triage: 1, needs_research: 0, in_progress: 2, blocked: 1, stale_in_progress: [], stale_blocked: [] },
      },
      boardState: null,
      orchBoardDegraded: false,
      needsTriageItems: ok([4949]),
    },
  };
}

const SCENARIOS: Record<string, () => TurnSnapshotValues> = {
  healthy: healthyValues,
  "all-fallback": fallbackValues,
  edge: edgeValues,
  "board-state-down": boardStateDownValues,
};

function emit(name: string): string {
  return serializeTurnSnapshot(buildTurnSnapshot(SCENARIOS[name]!(), { nowMs: NOW_MS })).text;
}

function python(script: string, input?: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): any {
  const res = spawnSync("python3", [join(PARITY_DIR, script), ...args], { input, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 240_000, env });
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
    const allDegraded = join(dumpDir, "all-degraded.json");
    writeFileSync(allDegraded, serializeTurnSnapshot({ doc: allDegradedTurnSnapshot("plan-parity", "turn-snapshot.ts exited 1"), rawBlobs: {} }).text);
    const r = python("plan_parity.py", undefined, ["--dump", dump, "--all-degraded", allDegraded], productionEnv());
    assert.ok(r.entries >= 600, `corpus shrank to ${r.entries} entries — regenerate it (capture/sitecustomize.py)`);
    assert.equal(r.golden, r.entries, "one golden Plan per corpus entry");
    assert.ok(r.with_signals >= 300, `only ${r.with_signals} entries carry signals — the corpus no longer exercises the accessor`);
    assert.ok(r.distinct_plans >= 400, `only ${r.distinct_plans} distinct Plans — the corpus no longer discriminates`);
    assert.deepEqual(r.unrepresentable, []);
    assert.deepEqual(r.diverged, []);
    assert.equal(r.identical, r.entries);
    // #5083: the marker document (node could not run) plans byte-identically to the TS all-degraded document
    assert.equal(r.marker_checked, r.entries);
    assert.deepEqual(r.marker_diverged, []);
    assert.equal(r.marker_identical, r.entries);
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
  const readings: any[] = python("accessor_check.py", JSON.stringify(goldens), [], productionEnv()).cases;

  for (const r of readings) {
    test(`${r.name}: every typed field reads back through turn_snapshot.py unchanged, and decide.py plans`, () => {
      const doc = JSON.parse(goldens.find((g) => g.name === r.name)!.snapshot);
      assert.equal(r.form, "json");
      assert.equal(r.plan_ok, true, r.error);
      assert.equal(r.stored_identical, true, "apply stores the TS document as emitted, field for field (store-only, #5083)");
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
        } else if (Array.isArray(value) && key === "orch_qa_verdict_recheck") {
          const entries = value as { pr: number; tier: number; verdict: string; verdict_sha: string; head_sha: string }[];
          assert.deepEqual(
            rd[key].recheck.map((e: Record<string, unknown>) => [e.pr_number, e.tier, e.verdict, e.verdict_sha, e.head_sha]),
            [...entries].sort((a, b) => a.pr - b.pr).map((e) => [e.pr, e.tier, e.verdict, e.verdict_sha, e.head_sha]),
            key,
          );
        } else if (Array.isArray(value)) {
          assert.deepEqual(rd[key].ordered, value, key);
          assert.deepEqual(rd[key].prs, [...new Set(value as number[])].sort((a, b) => a - b), key);
        } else if (["orch_pending_grill_anchor", "orch_dev_ready_anchor", "orch_dev_resume_nopr_anchor", "wayfinder_orch_frontier", "tickets_orch_pending_spec"].includes(key)) {
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
    assert.equal(doc.signals.orch_work_available, true, "the derived counts feed the signals by field (#4949)");
    assert.equal(doc.signals.needs_qa_orch, true, "derived needs_qa=4 > 0 (#4949)");
    assert.equal(doc.signals.needs_triage_orch, true, "derived needs_triage=1 > 0 (#4949)");
    assert.equal(doc.signals.needs_research, false, "derived needs_research=0 stays false (#4949)");
  });

  test("the healthy scenario is not vacuous (decide.py dispatches from it)", () => {
    assert.ok(readings.find((r) => r.name === "healthy").actions.some((a: { type: string }) => a.type === "dispatch"));
  });

  test("the observability section carries the collector values no decide.py rule reads", () => {
    const doc = JSON.parse(readFileSync(join(PARITY_DIR, "golden-healthy.json"), "utf-8"));
    assert.deepEqual(Object.keys(doc.observability).sort(), ["active_dev_orch", "capacity", "direction_drift", "health", "recommendations", "redis_queues", "scheduler"]);
    assert.equal(doc.observability.scheduler.stall, "ok");
    assert.equal(typeof doc.observability.active_dev_orch, "number");
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
    const v = { ...h, prGate: { ...h.prGate, devResumePick: ok({ issue: 4876, pr: 4881, headRefName: "bad:branch" }) } };
    assert.equal(buildTurnSnapshot(v, { nowMs: NOW_MS }).doc.signals.orch_dev_resume_pick, null);
  });

  test("blobs are spliced as the service's exact JSON text (85.0 stays a float lexeme)", () => {
    const text = emit("healthy");
    assert.ok(text.includes('"percentLast5h": 85.0'), "the usage body must be the service's own text");
  });

  test("realm share rounds to 4 dp (the precision decide.py's cap has always compared at)", () => {
    assert.equal(JSON.parse(emit("healthy")).signals.orch_realm_weekly_share, 0.1235);
  });

  test("realm share rounds an exact binary tie to EVEN, like format(x, '.4f') (#5084)", () => {
    const share = (x: number) => buildTurnSnapshot({ ...healthyValues(), realmShare: ok(x) }, { nowMs: NOW_MS }).doc.signals.orch_realm_weekly_share;
    assert.equal(share(1 / 32), 0.0312, "0.03125 is a tie: 2 is even (toFixed alone gives 0.0313)");
    assert.equal(share(3 / 32), 0.0938, "0.09375 is a tie: 8 is even");
    assert.equal(share(5 / 32), 0.1562, "0.15625 is a tie: 2 is even");
    assert.equal(share(0.12345), 0.1235, "0.12345 is 0.123450000000000004174… — not a tie, rounds up");
    assert.equal(share(1), 1);
    assert.equal(share(0), 0);
  });

  test("the target_risk_surface blob keeps json.dumps' separators and ensure_ascii escapes (#5084)", () => {
    const manifest = { ok: true, a: "é\u007f", b: [1, 2], c: {}, d: [], e: { f: "x, y: z\n" }, g: "😀", h: 1.5 };
    const text = serializeTurnSnapshot(buildTurnSnapshot({ ...healthyValues(), targetRiskSurface: { manifest: ok(manifest) } }, { nowMs: NOW_MS })).text;
    assert.ok(
      text.includes('"target_risk_surface":{"ok": true, "a": "\\u00e9\\u007f", "b": [1, 2], "c": {}, "d": [], "e": {"f": "x, y: z\\n"}, "g": "\\ud83d\\ude00", "h": 1.5}'),
      "the blob is spliced as Python json.dumps text",
    );
    assert.deepEqual(JSON.parse(text).blobs.target_risk_surface, manifest, "and it still parses back to the manifest");
    const holes = { ok: true, u: undefined, v: [1, undefined], w: { x: undefined } };
    const holeText = serializeTurnSnapshot(buildTurnSnapshot({ ...healthyValues(), targetRiskSurface: { manifest: ok(holes) } }, { nowMs: NOW_MS })).text;
    assert.ok(
      holeText.includes('"target_risk_surface":{"ok": true, "u": null, "v": [1, null], "w": {"x": null}}'),
      "an undefined field prints as null (the deleted pyJsonDumps rule), never silently dropped",
    );
    const failed =serializeTurnSnapshot(buildTurnSnapshot({ ...healthyValues(), targetRiskSurface: { manifest: { ok: false, reason: "no manifest field" } } }, { nowMs: NOW_MS })).text;
    assert.ok(failed.includes('"target_risk_surface":{"ok": false, "errors": ["target_risk_surface_json: no manifest field"]}'));
  });

  test("health: only a string status whose first token is `ok` is healthy; any other value fails (#5084)", () => {
    const fail = (status: unknown, redis: unknown = true) =>
      buildTurnSnapshot({ ...healthyValues(), health: { service: ok({ status, redis }), failedServices: 0 } }, { nowMs: NOW_MS }).doc.signals.health_fail;
    assert.equal(fail("ok"), false);
    assert.equal(fail("ok degraded-detail", { nested: "x" }), false);
    for (const bad of ["degraded", "", "  ", null, true, 0, ["ok"], { ok: true }]) assert.equal(fail(bad), true, `${JSON.stringify(bad)} is not a healthy status`);
  });

  test("an orch board count reads only as a JSON integer — a string or float count is 0 (#5084)", () => {
    const work = (ready_for_agent: unknown) => {
      const h = healthyValues();
      const counts = { source: "service" as const, values: { ...(h.orchBoard.counts as { values: Record<string, unknown> }).values, ready_for_agent } };
      return buildTurnSnapshot({ ...h, orchBoard: { ...h.orchBoard, counts: counts as never } }, { nowMs: NOW_MS }).doc.signals.orch_work_available;
    };
    assert.equal(work(3), true);
    for (const notInt of ["3", 2.5, [3], { n: 3 }, true]) assert.equal(work(notInt), false, `${JSON.stringify(notInt)} is not a count`);
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
// The degraded (gh-derived) orch board counts — issue #4949
// ---------------------------------------------------------------------------

describe("turn snapshot JSON: the degraded orch board counts feed the signals by field (#4949)", () => {
  test("every BoardCounts variant that carries values is read by field — only a withheld read (`none`) is zero", () => {
    const doc = JSON.parse(emit("board-state-down"));
    assert.equal(doc.signals.orch_work_available, true, "derived ready_for_agent=3 > 0 — the kv wire's `{\"needs_qa\"` prefix rule never parsed this line");
    assert.equal(doc.signals.needs_qa_orch, true, "derived needs_qa=4 > 0");
    assert.equal(doc.signals.needs_triage_orch, true, "derived needs_triage=1 > 0");
    assert.equal(doc.signals.needs_research, false, "derived needs_research=0");
    assert.equal(doc.signals.orch_board_signals_degraded, false, "a successful derived read never flips the degraded flag (#4130)");
    // the withheld read (the #4130 fail-closed arm) still reads as zero, and the
    // collector's fallback-read-failed flag is carried through untouched: the values
    // assembly derives archBoards.orchBoardDegraded from the collector's boolean,
    // so "1" here models what a real fallback-read-failed turn carries.
    const down = boardStateDownValues();
    const withheld = buildTurnSnapshot(
      { ...down, orchBoard: orchBoardFallbackSnapshot("fallback-read-failed"), archBoards: { ...down.archBoards, orchBoardDegraded: "1" } },
      { nowMs: NOW_MS },
    );
    for (const sig of ["orch_work_available", "needs_qa_orch", "needs_research", "needs_triage_orch"] as const) {
      assert.equal(withheld.doc.signals[sig], false, `a withheld counts line still reads ${sig} false (#4130)`);
    }
    assert.equal(withheld.doc.signals.orch_board_signals_degraded, true, "the #4130 flag the collector set is carried through, not recomputed");
  });

  test("a degraded board-state with non-zero fallback counts still plans work: decide.py dispatches dev_orch (#4949)", () => {
    const r = python("accessor_check.py", JSON.stringify([{ name: "board-state-down", snapshot: emit("board-state-down") }]), [], productionEnv()).cases[0];
    assert.equal(r.form, "json", r.error);
    assert.equal(r.readings.orch_work_available.scalar, true, "the Python accessor reads the signal the builder derived from the fallback counts");
    assert.ok(
      r.actions.some((a: { type: string; slot?: string }) => a.type === "dispatch" && a.slot === "dev_orch"),
      `the plan must see orch work — got ${JSON.stringify(r.actions)}`,
    );
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

  test("a non-object usage_eligibility / emergency_brake blob is dropped (fails CLOSED: the previous value is kept), with markers", () => {
    const b = built();
    const out = serializeTurnSnapshot({ ...b, doc: { ...b.doc, blobs: { ...b.doc.blobs, usage_eligibility: [1] as never, emergency_brake: "engaged" as never } } });
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, true);
    assert.equal("usage_eligibility" in doc.blobs, false);
    assert.equal("emergency_brake" in doc.blobs, false);
    const fields = doc.degraded.map((d: { field: string }) => d.field);
    assert.ok(fields.includes("blobs.usage_eligibility") && fields.includes("blobs.emergency_brake"), JSON.stringify(fields));
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

  test("a missing signal, a non-boolean flag, a malformed pin and an unknown blob are repaired on emit (the cases the Python apply repaired until #5083)", () => {
    const b = built();
    const signals = { ...b.doc.signals, orch_work_available: "yes", orch_dev_resume_pick: { issue: 4718, pr: "x", branch: "b" } } as Record<string, unknown>;
    delete signals.health_fail;
    const out = serializeTurnSnapshot({ ...b, doc: { ...b.doc, signals: signals as never, blobs: { ...b.doc.blobs, unknown_blob: {} } as never } });
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, true);
    assert.equal(out.repaired, true);
    assert.ok(TurnSnapshotSchema.safeParse(doc).success);
    assert.equal(doc.signals.health_fail, ALL_DEGRADED_SIGNALS.health_fail, "a missing signal → its all-degraded value");
    assert.equal(doc.signals.orch_work_available, ALL_DEGRADED_SIGNALS.orch_work_available, "a non-bool flag → its all-degraded value");
    assert.equal(doc.signals.orch_dev_resume_pick, null, "a malformed pin → none");
    assert.equal("unknown_blob" in doc.blobs, false, "an unknown blob is dropped");
    assert.deepEqual(doc.signals.orch_dirty_forward_fix, { issue: 4810, pr: 4814, branch: "fix/4810" }, "valid fields survive untouched");
    const fields = doc.degraded.filter((d: { collector: string }) => d.collector === "turn-snapshot").map((d: { field: string }) => d.field).sort();
    assert.deepEqual(fields, ["blobs.unknown_blob", "signals.health_fail", "signals.orch_dev_resume_pick", "signals.orch_work_available"]);
  });

  test("a non-object signals map is structural: the all-degraded document replaces it", () => {
    const b = built();
    const out = serializeTurnSnapshot({ ...b, doc: { ...b.doc, signals: "x" as never } });
    const doc = JSON.parse(out.text);
    assert.equal(out.valid, false);
    assert.ok(TurnSnapshotSchema.safeParse(doc).success);
    assert.deepEqual(doc.signals, ALL_DEGRADED_SIGNALS);
    assert.deepEqual(doc.blobs, {});
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
  const allDegraded = serializeTurnSnapshot({ doc: allDegradedTurnSnapshot("t", "turn-snapshot.ts exited 1"), rawBlobs: {} }).text;
  const cases: { name: string; snapshot: string | null; names: string[] }[] = [
    { name: "emit-failed", snapshot: null },
    { name: "empty", snapshot: "" },
    { name: "not-json", snapshot: "<html>502 Bad Gateway</html>" },
    { name: "truncated", snapshot: healthy.slice(0, healthy.length / 2) },
    { name: "not-an-object", snapshot: "[1, 2]" },
    { name: "signals-not-object", snapshot: variant((d) => (d.signals = "x")) },
    { name: "ts-all-degraded", snapshot: allDegraded },
  ].map((c) => ({ ...c, names: SIGNAL_KEYS }));
  const results: any[] = python("accessor_check.py", JSON.stringify(cases), [], productionEnv()).cases;
  const byName = (n: string) => results.find((r) => r.name === n);
  const UNREADABLE = ["emit-failed", "empty", "not-json", "truncated", "not-an-object"];

  for (const c of cases) {
    test(`${c.name}: apply never fails and decide.py returns a Plan`, () => {
      const r = byName(c.name);
      assert.equal(r.plan_ok, true, r.error);
      assert.ok(Array.isArray(r.actions));
    });
  }

  test("an unreadable document is stored as the marker document: no signals, one `*` marker", () => {
    for (const n of UNREADABLE) {
      const r = byName(n);
      assert.equal(r.form, "marker", n);
      assert.equal(r.degraded.length, 1, n);
      assert.equal(r.degraded[0].field, "*", n);
    }
  });

  test("a document without signals reads every signal degraded: absent values, and only the fault / cap flags raised", () => {
    for (const n of [...UNREADABLE, "signals-not-object"]) {
      const rd = byName(n).readings;
      for (const [k, v] of Object.entries(ALL_DEGRADED_SIGNALS)) {
        // Python truthiness of the all-degraded value: only a `true` flag is raised ([], "", 0 and null are not)
        assert.equal(rd[k].present, v === true, `${n}: ${k}`);
        assert.equal(rd[k].scalar, null, `${n}: ${k}`);
        assert.equal(rd[k].pin, null, `${n}: ${k}`);
        assert.equal(rd[k].anchor, null, `${n}: ${k}`);
        assert.deepEqual(rd[k].prs, [], `${n}: ${k}`);
        assert.deepEqual(rd[k].recheck, [], `${n}: ${k}`);
      }
    }
  });

  test("the TS all-degraded document is stored as emitted and reads back its own values", () => {
    const r = byName("ts-all-degraded");
    assert.equal(r.form, "json");
    assert.equal(r.stored_identical, true);
    for (const [k, v] of Object.entries(ALL_DEGRADED_SIGNALS)) {
      if (Array.isArray(v)) assert.deepEqual(r.readings[k].ordered, v, k);
      else assert.equal(r.readings[k].scalar, v, k);
    }
  });

  test("the marker document plans exactly as the TS all-degraded document (node could not run, #5083)", () => {
    const want = byName("ts-all-degraded").actions;
    for (const n of [...UNREADABLE, "signals-not-object"]) assert.deepEqual(byName(n).actions, want, n);
  });

  test("the CLI: a pathologically nested document (RecursionError) stores the marker document and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-deep-"));
    try {
      const statePath = join(dir, "state.json");
      const snapPath = join(dir, "snapshot.json");
      writeFileSync(statePath, JSON.stringify({ turn: 1, slots: {} }));
      writeFileSync(snapPath, healthy.replace('"blobs":{', `"blobs":{"class_stats":${"[".repeat(200_000)}${"]".repeat(200_000)},`));
      const r = spawnSync("python3", [join(REPO_ROOT, "scripts", "autopilot", "turn_snapshot.py"), "apply", snapPath, statePath], { encoding: "utf-8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).form, "marker");
      const st = JSON.parse(readFileSync(statePath, "utf-8"));
      assert.equal(st.turn_snapshot.degraded[0].field, "*");
      assert.match(st.turn_snapshot.degraded[0].reason, /RecursionError/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the all-degraded Plan is conservative: the doctor runs, no snapshot-driven producer or worker dispatches", () => {
    const r = byName("ts-all-degraded");
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

  test("it is conservative by construction: nothing available or due, every producer cap saturated, the doctor raised", () => {
    // The naming convention the accessor's marker reading relies on (#5083): a
    // flag is raised in the all-degraded document IFF its name ends `_fail`,
    // `_degraded` or `_saturated` — a new fault / cap flag must follow it. Every
    // NON-boolean value must read exactly as an absent key does on a marker
    // turn (the accessor returns None there), so it is null, 0, "" or [].
    const s = ALL_DEGRADED_SIGNALS as Record<string, unknown>;
    assert.ok(s.health_fail === true && s.orch_board_signals_degraded === true && s.arch_board_saturated === true);
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === "boolean") assert.equal(v, /_(fail|degraded|saturated)$/.test(k), k);
      else assert.ok(v === null || v === 0 || v === "" || (Array.isArray(v) && v.length === 0), `${k}=${JSON.stringify(v)} must be null, 0, "" or [] (what an absent key reads as)`);
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
      () => ({ github: down(), hydra: down(), workspace: () => "/nonexistent", facts: () => ({}), now: () => NOW_MS }),
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
        target: () => ({ github: down(), hydra: down(), workspace: () => "/nonexistent", facts: () => ({ ok: false, errors: ["down"] }), now: () => NOW_MS }),
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

describe("turn snapshot JSON: the CLI's --all-degraded (turn.sh's fallback, #5083)", () => {
  const deps = { github: {} as never, now: () => NOW_MS, sleep: async () => {} };
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, deps, { stdout: (t) => out.push(t), stderr: (t) => err.push(t) });
    return { code, stdout: out.join(""), stderr: err.join("") };
  };

  test("prints the TS all-degraded document, valid against the schema, with the reason on its `*` marker; no collector runs", async () => {
    const r = await run(["--all-degraded", "--reason", "turn-snapshot.ts exited 1"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    const doc = JSON.parse(r.stdout);
    assert.ok(TurnSnapshotSchema.safeParse(doc).success);
    assert.deepEqual(doc, allDegradedTurnSnapshot(new Date(NOW_MS).toISOString(), "turn-snapshot.ts exited 1"));
    assert.deepEqual(doc.degraded, [{ collector: "turn-snapshot", field: "*", reason: "turn-snapshot.ts exited 1" }]);
  });

  test("usage errors exit 2: no --reason, an empty reason, --reason alone, or another flag beside it", async () => {
    for (const argv of [["--all-degraded"], ["--all-degraded", "--reason", " "], ["--reason", "x"], ["--all-degraded", "--reason", "x", "--format", "json"]]) {
      const r = await run(argv);
      assert.equal(r.code, 2, argv.join(" "));
      assert.equal(r.stdout, "", argv.join(" "));
    }
  });
});

describe("turn snapshot JSON: replay mode fails loud on a signal the document lacks (#5083)", () => {
  // A golden document minus one signal decide.py reads every turn (the #4130 board-degraded stamp).
  const doc = JSON.parse(readFileSync(join(PARITY_DIR, "golden-healthy.json"), "utf-8"));
  delete doc.signals.orch_board_signals_degraded;
  const cases = [{ name: "missing-signal", snapshot: JSON.stringify(doc), names: ["orch_board_signals_degraded", "orch_work_available"] }];

  test("production: the read degrades to absent and decide.py still plans", () => {
    const r = python("accessor_check.py", JSON.stringify(cases), [], productionEnv()).cases[0];
    assert.equal(r.form, "json");
    assert.equal(r.readings.orch_board_signals_degraded.scalar, null);
    assert.equal(r.readings.orch_board_signals_degraded.present, false);
    assert.equal(r.plan_ok, true, r.error);
  });

  test("replay (HYDRA_AUTOPILOT_SNAPSHOT_REPLAY set): the same read raises and decide.py fails instead of planning", () => {
    const r = python("accessor_check.py", JSON.stringify(cases), [], { ...productionEnv(), HYDRA_AUTOPILOT_SNAPSHOT_REPLAY: "golden" }).cases[0];
    assert.match(r.readings.orch_board_signals_degraded.raised ?? "", /UnknownSignalError: .*'orch_board_signals_degraded'/);
    assert.equal(r.readings.orch_work_available.scalar, true, "a signal the document carries still reads normally");
    assert.equal(r.plan_ok, false);
    assert.match(r.error ?? "", /UnknownSignalError: .*orch_board_signals_degraded/);
  });

  test("replay of a complete golden document plans normally (the fail-loud mode is not vacuous-red)", () => {
    const whole = [{ name: "healthy", snapshot: readFileSync(join(PARITY_DIR, "golden-healthy.json"), "utf-8") }];
    const r = python("accessor_check.py", JSON.stringify(whole), [], { ...productionEnv(), HYDRA_AUTOPILOT_SNAPSHOT_REPLAY: "golden" }).cases[0];
    assert.equal(r.plan_ok, true, r.error);
  });
});

describe("turn snapshot JSON: needs_qa_target suppression (issue #4796)", () => {
  const signals = (needsQaPr: { ref: string; head: string; allSkipped?: boolean }) => {
    const h = healthyValues();
    return buildTurnSnapshot({ ...h, targetBoard: { ...h.targetBoard, needsQaPr } }, { nowMs: NOW_MS }).doc.signals;
  };
  test("an all-skipped (already PASSed at head) board drops needs_qa_target; an ordinary empty pick keeps it", () => {
    assert.equal(signals({ ref: "", head: "", allSkipped: true }).needs_qa_target, false);
    assert.equal(signals({ ref: "", head: "" }).needs_qa_target, true);
  });
});
