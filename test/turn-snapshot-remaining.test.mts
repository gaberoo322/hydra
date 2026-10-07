/**
 * Turn Snapshot — the last seven collect-state.sh collectors (ADR-0043 slice
 * 5B, #4933): redis-queues, scout, arch-cleanup-boards, hitl-grill, retro,
 * wayfinder-frontier, tickets.
 *
 * All at the TS interface: no `gh`, `docker`, `hydra`, `python3`, Redis or
 * network.
 *
 * 1. GOLDEN (ADR-0043 Decision 4): every file under
 *    test/fixtures/turn-snapshot/remaining/ was captured by running the OLD
 *    bash collectors at the slice's base SHA (capture/ holds the harness and
 *    scenarios; README.md the recipe) with fake `gh`/`docker`/`date` binaries
 *    and the real `hydra` CLI against a local HTTP server — failure paths
 *    (gh error, unparseable/mis-shaped payloads, Redis down, HTTP 500/404,
 *    transport error) included. Each is replayed through the real CLI `main`,
 *    the production gh port and hydra HTTP client over fake transports, and a
 *    fake Redis port: stdout byte for byte, the stderr-note set, the gh argv
 *    set (the bash's argv minus `--jq <expr>`), the data-plane paths, the
 *    Redis writes and the exported globals.
 *
 * 2. PORTED behavioural cases, 1:1 at the collector interface, from
 *    test/autopilot-hitl-grill-saturation-signal.test.mts (#4391, deleted —
 *    every case moved here), test/autopilot-arch-fallback-signals.test.mts
 *    (#789, #4657, #4130's ARCH-read cases), the retro_run_drillable cases of
 *    test/autopilot-collect-state-signals.test.mts (#4584), the wayfinder
 *    sentinel + tickets producer cases of test/autopilot-scripts.test.mts
 *    (#3400, #4014) and the skill-prune three-arm case of
 *    test/decide-signal-classes.test.mts (#4607).
 *
 * 3. Interface cases for the new seams (Redis port bounding, jq/awk parity,
 *    fail-open runner, CLI wiring).
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { main, parseArgs, type CliDeps } from "../scripts/autopilot/turn-snapshot.ts";
import { createTurnSnapshotGithub, type GhTransport, wayfinderFrontierQuery } from "../src/autopilot/turn-snapshot/github-port.ts";
import { createTurnSnapshotHydraHttp, type HttpTransport } from "../src/autopilot/turn-snapshot/hydra-http.ts";
import { createTurnSnapshotRedis, type TurnSnapshotRedis, type TurnSnapshotRedisOps } from "../src/autopilot/turn-snapshot/redis-port.ts";
import { REMAINING_COLLECTORS, runRemainingCollectors } from "../src/autopilot/turn-snapshot/remaining.ts";
import {
  ARCH_BOARD_ENHANCEMENT_CAP,
  ARCH_BOARD_SATURATION_CAP,
  ARCH_SCAN_LABEL,
  awkNumber,
  HITL_GRILL_INBOX_CAP,
  HITL_GRILL_LABEL,
  scoutSpendUsd,
} from "../src/autopilot/turn-snapshot/board-saturation.ts";
import { foldRetroBundle, foldWayfinderFrontier, NEEDS_TICKETS_LABEL } from "../src/autopilot/turn-snapshot/afk-frontier.ts";
import { jqCompare, jqLength, jqSort, jqText } from "../src/autopilot/turn-snapshot/jq-compat.ts";
import { DEFAULT_GITHUB_REPO } from "../src/github/issues.ts";

const GOLDEN_DIR = resolve(import.meta.dirname, "fixtures", "turn-snapshot", "remaining");
const BASE = "http://golden.invalid";
const NOT_FOUND_HTML = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET</pre>\n</body>\n</html>\n";

interface GhScript {
  json?: unknown;
  raw?: string;
  exitCode?: number;
}

interface RedisWorld {
  down?: boolean;
  lists?: Record<string, number>;
  strings?: Record<string, string>;
  hashes?: Record<string, Record<string, string>>;
}

interface World {
  collectors: string[];
  date?: string;
  orchBoardDegraded?: string;
  env?: Record<string, string>;
  gh?: Record<string, GhScript>;
  redis?: RedisWorld;
  http?: Record<string, { status?: number; body?: string; network?: boolean }>;
}

interface Golden extends Required<World> {
  name: string;
  expected: {
    stdout: string;
    stderrNotes: string[];
    ghCalls: string[][];
    httpCalls: string[];
    redisWrites: string[][];
    exports: string | null;
  };
}

/** The fixture key the capture harness's fake `gh` used for an argv. */
function ghKey(args: readonly string[]): string {
  const after = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  if (args[0] === "api" && args[1] === "graphql") return `graphql:${String(after("-F")).replace(/^n=/, "")}`;
  return `issue-list:${after("--label") ?? "-"}:${after("--json")}`;
}

const ANCHOR_KEYS = {
  "work-queue": "hydra:anchors:work-queue",
  "reframe-queue": "hydra:anchors:reframe-queue",
  "prior-failures": "hydra:anchors:prior-failures",
} as const;

/** A fake Redis port over the scenario keyspace (the keys the bash's redis-cli calls named). */
function fakeRedis(world: RedisWorld, writes: string[][]): TurnSnapshotRedis {
  const read = async <T,>(v: T) => (world.down ? { ok: false as const, reason: "down" } : { ok: true as const, value: v });
  return {
    anchorQueueLength: (q) => read(world.lists?.[ANCHOR_KEYS[q]] ?? 0),
    scoutLastCalendarWalk: () => read(world.strings?.["hydra:scout:last-calendar-walk"] ?? null),
    architectureLastRun: () => read(world.strings?.["hydra:architecture:last-run"] ?? null),
    scoutTokens: (d) => read(world.hashes?.[`hydra:metrics:tokens:by-skill:daily:${d}`]?.["hydra-tool-scout"] ?? null),
    mirrorScoutSpend: async (d, v, ttl) => {
      if (world.down) return { ok: false, reason: "down" };
      writes.push(["SET", `hydra:scout:spend:${d}`, v, "EX", String(ttl)]);
      return { ok: true, value: true };
    },
    close: () => {},
  };
}

interface Run {
  code: number;
  stdout: string;
  stderrNotes: string[];
  ghCalls: string[][];
  httpCalls: string[];
  redisWrites: string[][];
  exports: string | null;
}

/** Run the CLI over a scenario world exactly as the golden replay does. */
async function runWorld(w: World): Promise<Run> {
  const ghCalls: string[][] = [];
  const httpCalls: string[] = [];
  const redisWrites: string[][] = [];
  const transport: GhTransport = async (args) => {
    ghCalls.push([...args]);
    const r = w.gh?.[ghKey(args)];
    if (r === undefined || r.exitCode) return { ok: false, stderr: "gh: scripted failure" };
    return { ok: true, stdout: typeof r.raw === "string" ? r.raw : JSON.stringify(r.json), stderr: "" };
  };
  const http: HttpTransport = async (url) => {
    const path = url.slice(`${BASE}/api`.length);
    httpCalls.push(path);
    const r = w.http?.[path];
    if (r === undefined) return { status: 404, body: NOT_FOUND_HTML };
    if (r.network) throw new Error("socket hang up");
    return { status: r.status ?? 200, body: r.body ?? "" };
  };
  const deps: CliDeps = {
    github: createTurnSnapshotGithub({ transport, repo: DEFAULT_GITHUB_REPO }),
    now: () => Date.parse(`${w.date ?? "2026-10-07"}T12:00:00Z`),
    sleep: async () => {},
    env: {},
    remaining: {
      hydra: createTurnSnapshotHydraHttp({ baseUrl: BASE, transport: http }),
      redis: fakeRedis(w.redis ?? {}, redisWrites),
      env: w.env ?? {},
    },
  };
  let stdout = "";
  let stderr = "";
  let exports: string | null = null;
  const code = await main(
    [
      "--collectors",
      w.collectors.join(","),
      "--format",
      "kv",
      "--gh-list-limit",
      "100",
      "--orch-board-degraded",
      w.orchBoardDegraded ?? "0",
      "--exports-file",
      "exports",
    ],
    deps,
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), writeFile: (_p, t) => (exports = t) },
  );
  return { code, stdout, stderrNotes: stderr.split("\n").filter((l) => l !== ""), ghCalls, httpCalls, redisWrites, exports };
}

/** stdout as a key→value map (last write wins; non-kv lines keep their text as the key). */
function kv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n").filter(Boolean)) {
    const i = line.indexOf("=");
    out[i > 0 ? line.slice(0, i) : line] = i > 0 ? line.slice(i + 1) : "";
  }
  return out;
}

const goldenFiles = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json")).sort();
const loadGolden = (f: string) => JSON.parse(readFileSync(join(GOLDEN_DIR, f), "utf-8")) as Golden;
const sortedJson = (xs: readonly unknown[]) => xs.map((x) => JSON.stringify(x)).sort();

// ---------------------------------------------------------------------------
// 1. Golden files
// ---------------------------------------------------------------------------

describe("Turn Snapshot slice 5B — golden files from the bash collectors (ADR-0043 D4)", () => {
  test("the golden corpus is present and covers every collector (guards a vacuous pass)", () => {
    assert.ok(goldenFiles.length >= 100, `expected the captured corpus, found ${goldenFiles.length} files`);
    const covered = new Set(goldenFiles.flatMap((f) => loadGolden(f).collectors));
    assert.deepEqual([...covered].sort(), Object.keys(REMAINING_COLLECTORS).sort());
  });

  for (const file of goldenFiles) {
    const g = loadGolden(file);
    test(`golden: ${g.name}`, async () => {
      const r = await runWorld(g);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, g.expected.stdout);
      assert.deepEqual(r.stderrNotes, g.expected.stderrNotes);
      // The TS collectors read concurrently, so the order differs; the set may not.
      assert.deepEqual(sortedJson(r.ghCalls), sortedJson(g.expected.ghCalls), "gh argv (minus --jq) must match the bash's calls");
      assert.deepEqual([...r.httpCalls].sort(), [...g.expected.httpCalls].sort());
      assert.deepEqual(r.redisWrites, g.expected.redisWrites);
      assert.equal(r.exports, g.expected.exports);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Ported behavioural cases
// ---------------------------------------------------------------------------

const BOARD = "issue-list:-:number,labels";
const HITL = `issue-list:${HITL_GRILL_LABEL}:number`;
const issue = (n: number, ...labels: string[]) => ({ number: n, labels: labels.map((name) => ({ name })) });
function boardOf(counts: Record<string, number>): ReturnType<typeof issue>[] {
  const label: Record<string, string[]> = {
    ready_for_agent: ["ready-for-agent"],
    needs_research: ["needs-research"],
    needs_triage: ["needs-triage"],
    arch_sourced: [ARCH_SCAN_LABEL],
    cleanup_sourced: ["cleanup-scan"],
    skill_prune_sourced: ["skill-prune"],
    enhancement_sourced: ["enhancement"],
  };
  const out: ReturnType<typeof issue>[] = [];
  for (const [k, n] of Object.entries(counts)) for (let i = 0; i < n; i++) out.push(issue(out.length + 1, ...(label[k] as string[])));
  return out;
}
async function arch(counts: Record<string, number>, workQueue = 0, extra: Partial<World> = {}): Promise<Record<string, string>> {
  return kv(
    (await runWorld({ collectors: ["arch-cleanup-boards"], gh: { [BOARD]: { json: boardOf(counts) } }, redis: { lists: { "hydra:anchors:work-queue": workQueue } }, ...extra })).stdout,
  );
}
async function hitl(script: GhScript | undefined): Promise<Record<string, string>> {
  return kv((await runWorld({ collectors: ["hitl-grill"], gh: script === undefined ? {} : { [HITL]: script } })).stdout);
}
const nums = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1 }));

describe("hitl-grill inbox saturation signals (issue #4391; ported from autopilot-hitl-grill-saturation-signal)", () => {
  test("documents the inbox cap as a constant (10 — the arch-scan 'park NOTHING' number)", () => {
    assert.equal(HITL_GRILL_INBOX_CAP, 10, "hydra-architecture-scan.md step 4c: 'At 10 or more open hitl-grill issues, park NOTHING'");
  });

  test("reads the inbox depth via a dedicated --label hitl-grill read (the arch-scan step-4c query)", async () => {
    const r = await runWorld({ collectors: ["hitl-grill"], gh: { [HITL]: { json: nums(3) } } });
    assert.deepEqual(r.ghCalls, [["issue", "list", "--repo", DEFAULT_GITHUB_REPO, "--state", "open", "--label", "hitl-grill", "--limit", "100", "--json", "number"]]);
  });

  test("saturated uses an INCLUSIVE >= cap comparison (unlike the siblings' strict >)", async () => {
    assert.deepEqual(await hitl({ json: nums(9) }), { hitl_grill_open: "9", hitl_grill_saturated: "false" });
    assert.deepEqual(await hitl({ json: nums(10) }), { hitl_grill_open: "10", hitl_grill_saturated: "true" });
    assert.deepEqual(await hitl({ json: nums(11) }), { hitl_grill_open: "11", hitl_grill_saturated: "true" });
  });

  test("a failed gh read degrades to open=0 AND saturated=true — never a fake 'inbox empty'", async () => {
    assert.deepEqual(await hitl({ exitCode: 1 }), { hitl_grill_open: "0", hitl_grill_saturated: "true" });
  });

  test("garbage (non-JSON) output degrades the same way", async () => {
    assert.deepEqual(await hitl({ raw: "gh: error (rate limit)" }), { hitl_grill_open: "0", hitl_grill_saturated: "true" });
  });

  test("a healthy read over an EMPTY inbox prints 0 and is NOT saturated", async () => {
    assert.deepEqual(await hitl({ json: [] }), { hitl_grill_open: "0", hitl_grill_saturated: "false" });
  });

  test("the crash fallback emits the same suppressing defaults", () => {
    assert.equal(REMAINING_COLLECTORS["hitl-grill"]!.fallback.text, "hitl_grill_open=0\nhitl_grill_saturated=true\n");
  });

  test("a failed hitl-grill read does NOT flip ORCH_BOARD_DEGRADED (the #4130 three-read enumeration is unchanged)", async () => {
    const r = await runWorld({ collectors: ["arch-cleanup-boards", "hitl-grill"], gh: { [BOARD]: { json: [] } }, redis: {} });
    assert.equal(kv(r.stdout).orch_board_signals_degraded, "false");
    assert.equal(kv(r.stdout).hitl_grill_saturated, "true");
    assert.equal(r.exports, "ARCH_WORK_QUEUE=0\nORCH_BOARD_DEGRADED=0\n");
  });

  test("the inbox depth is its own read, NOT folded into the shared ARCH board read", async () => {
    // The board read is capped at the page size over the WHOLE board, so a
    // fold would under-count past it; hitl-grill counts only its labelled read.
    const r = await runWorld({ collectors: ["hitl-grill"], gh: { [BOARD]: { json: boardOf({ needs_triage: 50 }) }, [HITL]: { json: nums(2) } } });
    assert.equal(kv(r.stdout).hitl_grill_open, "2");
    assert.ok(!r.ghCalls.some((a) => ghKey(a) === BOARD), "hitl-grill must not read the shared board");
  });
});

describe("architecture fallback signals (issue #789; ported from autopilot-arch-fallback-signals)", () => {
  test("defines the stable architecture-sourced label", () => {
    assert.equal(ARCH_SCAN_LABEL, "architecture-scan");
  });

  test("documents the saturation cap as a constant (6, within 5-10)", () => {
    assert.ok(ARCH_BOARD_SATURATION_CAP >= 5 && ARCH_BOARD_SATURATION_CAP <= 10);
  });

  test("emits the unified orch_backfill_idle signal + arch_* keys, counting the architecture-scan label", async () => {
    const out = await arch({ arch_sourced: 2 });
    assert.equal(out.orch_backfill_idle, "true");
    assert.equal(out.arch_board_open_scan, "2");
    assert.ok("arch_board_saturated" in out);
    assert.ok(!("arch_fallback_due" in out), "the old arch_fallback_due emit must be gone (unified)");
  });

  test("orch_backfill_idle=true ONLY when the board is fully idle", async () => {
    const out = await arch({});
    assert.equal(out.orch_backfill_idle, "true");
    assert.equal(out.arch_board_saturated, "false");
  });

  test("orch_backfill_idle=false when work_queue is non-empty", async () => {
    assert.equal((await arch({}, 3)).orch_backfill_idle, "false");
  });

  test("orch_backfill_idle=false when any actionable label count is non-zero", async () => {
    for (const label of ["ready_for_agent", "needs_research", "needs_triage"]) {
      assert.equal((await arch({ [label]: 2 })).orch_backfill_idle, "false", `non-zero ${label} must suppress backfill-idle`);
    }
  });

  test("arch_board_saturated uses a strict > cap comparison", async () => {
    const atCap = await arch({ arch_sourced: 6 });
    assert.equal(atCap.arch_board_saturated, "false", "== cap is not saturated");
    assert.equal(atCap.arch_board_open_scan, "6");
    const overCap = await arch({ arch_sourced: 7 });
    assert.equal(overCap.arch_board_saturated, "true", "> cap is saturated");
    assert.equal(overCap.arch_board_open_scan, "7");
  });

  test("malformed board JSON degrades to safe zeros", async () => {
    // The bash's `--jq` failed on a malformed payload, so gh printed nothing —
    // the #4130 suppressing arm (never idle, never saturated).
    const out = kv((await runWorld({ collectors: ["arch-cleanup-boards"], gh: { [BOARD]: { raw: "not json" } }, redis: {} })).stdout);
    assert.equal(out.arch_board_open_scan, "0");
    assert.equal(out.arch_board_saturated, "false");
    assert.equal(out.orch_backfill_idle, "false");
  });
});

describe("arch_board_saturated enhancement>20 fold (issue #4657; ported from autopilot-arch-fallback-signals)", () => {
  test("documents the enhancement saturation cap as a constant (20)", () => {
    assert.equal(ARCH_BOARD_ENHANCEMENT_CAP, 20);
  });

  test("the enhancement count comes from the SAME single board read (no second gh call)", async () => {
    const r = await runWorld({ collectors: ["arch-cleanup-boards"], gh: { [BOARD]: { json: boardOf({ enhancement_sourced: 3 }) } }, redis: {} });
    assert.equal(kv(r.stdout).arch_board_open_enhancements, "3");
    assert.deepEqual(r.ghCalls.map(ghKey), [BOARD]);
  });

  test("emits arch_board_open_enhancements next to arch_board_open_scan", async () => {
    const keys = Object.keys(await arch({}));
    assert.equal(keys.indexOf("arch_board_open_enhancements"), keys.indexOf("arch_board_open_scan") + 1);
  });

  test("enhancement_sourced at the cap (20) does NOT saturate; over the cap (21) does", async () => {
    const atCap = await arch({ enhancement_sourced: 20 });
    assert.equal(atCap.arch_board_saturated, "false");
    assert.equal(atCap.arch_board_open_enhancements, "20");
    const overCap = await arch({ enhancement_sourced: 21 });
    assert.equal(overCap.arch_board_saturated, "true", "> cap saturates even with arch_sourced=0");
    assert.equal(overCap.arch_board_open_enhancements, "21");
  });

  test("the architecture-scan arm still saturates alone when enhancement_sourced=0", async () => {
    const out = await arch({ arch_sourced: 7 });
    assert.equal(out.arch_board_saturated, "true");
    assert.equal(out.arch_board_open_enhancements, "0");
  });

  test("a board without enhancement issues reads an enhancement count of 0", async () => {
    const out = await arch({ arch_sourced: 1 });
    assert.equal(out.arch_board_open_enhancements, "0");
    assert.equal(out.arch_board_saturated, "false");
  });

  test("both degraded arms (failed read, crash fallback) emit arch_board_open_enhancements=0", async () => {
    assert.equal(kv((await runWorld({ collectors: ["arch-cleanup-boards"], gh: {}, redis: {} })).stdout).arch_board_open_enhancements, "0");
    assert.match(REMAINING_COLLECTORS["arch-cleanup-boards"]!.fallback.text, /^arch_board_open_enhancements=0$/m);
  });
});

describe("orch board degraded flag — the ARCH read (issue #4130; ported from autopilot-arch-fallback-signals)", () => {
  test("a failed ARCH read never substitutes fake zeros into the idle computation", async () => {
    const out = kv((await runWorld({ collectors: ["arch-cleanup-boards"], gh: {}, redis: { lists: { "hydra:anchors:work-queue": 0 } } })).stdout);
    assert.equal(out.orch_backfill_idle, "false", "an all-zero board computed from a read that never happened is the inverse-fire bug");
  });

  test("a failed ARCH read takes the suppressing arm and flags the lane degraded", async () => {
    const r = await runWorld({ collectors: ["arch-cleanup-boards"], gh: {}, redis: {} });
    assert.equal(
      r.stdout,
      "arch_last_run_iso=\norch_backfill_idle=false\narch_board_open_scan=0\narch_board_open_enhancements=0\narch_board_saturated=false\n" +
        "cleanup_board_open_scan=0\ncleanup_board_saturated=false\nskill_prune_board_open=0\nskill_prune_board_saturated=false\norch_board_signals_degraded=true\n",
    );
    assert.equal(r.exports, "ARCH_WORK_QUEUE=0\nORCH_BOARD_DEGRADED=1\n");
  });

  test("orch_board_signals_degraded is emitted UNCONDITIONALLY (both branches), last, and folds in an earlier orch read failure", async () => {
    const healthy = await runWorld({ collectors: ["arch-cleanup-boards"], gh: { [BOARD]: { json: [] } }, redis: {} });
    assert.match(healthy.stdout, /orch_board_signals_degraded=false\n$/);
    const upstream = await runWorld({ collectors: ["arch-cleanup-boards"], gh: { [BOARD]: { json: [] } }, redis: {}, orchBoardDegraded: "1" });
    assert.match(upstream.stdout, /orch_board_signals_degraded=true\n$/);
    assert.equal(upstream.exports, "ARCH_WORK_QUEUE=0\nORCH_BOARD_DEGRADED=1\n");
  });
});

describe("skill-prune cap pair on every arm (issue #4607; ported from decide-signal-classes)", () => {
  test("the healthy arm, the failed-read arm and the crash fallback each emit both keys", async () => {
    const healthy = (await runWorld({ collectors: ["arch-cleanup-boards"], gh: { [BOARD]: { json: boardOf({ skill_prune_sourced: 4 }) } }, redis: {} })).stdout;
    const failed = (await runWorld({ collectors: ["arch-cleanup-boards"], gh: {}, redis: {} })).stdout;
    const crash = REMAINING_COLLECTORS["arch-cleanup-boards"]!.fallback.text;
    assert.match(healthy, /^skill_prune_board_open=4\nskill_prune_board_saturated=true$/m);
    for (const text of [failed, crash]) assert.match(text, /^skill_prune_board_open=0\nskill_prune_board_saturated=false$/m);
  });
});

const RUNS = "/autopilot/runs?limit=14";
/** A run-found crash bundle with every legacy drill trigger empty. */
function emptyBundle(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runFound: true,
    run: { run_id: "run-4584", term_reason: "crash", crash_detail: { exit_code: 1 } },
    dispatches: [{ cycleId: "", flagged: false, undrillable: true, abandonReason: "run-crash" }],
    reflections: [],
    stuckSignals: [],
    recommendations: [],
    ...over,
  };
}
async function drillable(bundle: unknown): Promise<string> {
  const r = await runWorld({
    collectors: ["retro"],
    http: {
      [RUNS]: { body: JSON.stringify({ runs: [{ run_id: "run-4584", status: "ended" }] }) },
      "/autopilot/runs/run-4584/retro": { body: JSON.stringify(bundle) },
    },
  });
  return kv(r.stdout).retro_run_drillable as string;
}

describe("retro_run_drillable reads runFlagged (#4584; ported from autopilot-collect-state-signals)", () => {
  test("runFlagged=true with everything else empty -> true", async () => {
    assert.equal(await drillable(emptyBundle({ runFlagged: true, runFlagReason: "crash" })), "true");
  });

  test("runFlagged absent with everything else empty -> false (older server; no shell re-derivation)", async () => {
    assert.equal(await drillable(emptyBundle()), "false");
  });

  test("runFlagged=false with everything else empty -> false", async () => {
    assert.equal(await drillable(emptyBundle({ runFlagged: false, runFlagReason: null })), "false");
  });

  test("runFlagged truthy-but-not-true (string) -> false", async () => {
    assert.equal(await drillable(emptyBundle({ runFlagged: "true" })), "false");
  });

  test("runFound=false still degrades to true (#4244 regression)", async () => {
    assert.equal(await drillable(emptyBundle({ runFound: false, runFlagged: false })), "true");
  });

  test("the predicate never reads term_reason or crash_detail directly", () => {
    // Behavioural form of the old source pin: a run view that SAYS crash, with
    // no runFlagged, still reads not-drillable — only the TS-computed runFlagged counts.
    assert.equal(foldRetroBundle(JSON.stringify(emptyBundle({ run: { term_reason: "crash", crash_detail: { exit_code: 9 } } }))), false);
  });
});

const MAPS = "issue-list:wayfinder:map:number,labels";
describe("wayfinder frontier no-pick sentinel (#3400; ported from autopilot-scripts)", () => {
  test("a map whose only line is the in-flight count (no space) yields NO pick — never issue-0", async () => {
    // The `cut -s` semantics: the no-pick sentinel `0` has no delimiter, so
    // neither the pick number nor the ticket type is extracted.
    assert.deepEqual(foldWayfinderFrontier(["0"]), { frontier: null, ticketType: "", inflightGlobal: 0 });
    const r = await runWorld({
      collectors: ["wayfinder-frontier"],
      gh: { [MAPS]: { json: [issue(10, "wayfinder:map")] }, "graphql:10": { json: { data: { repository: { issue: { subIssues: { nodes: [] } } } } } } },
    });
    assert.equal(kv(r.stdout).wayfinder_orch_frontier, "none");
    assert.equal(kv(r.stdout).wayfinder_orch_ticket_type, "");
  });
});

const TICKETS = `issue-list:${NEEDS_TICKETS_LABEL}:number,assignees`;
const tickets = async (script: GhScript | undefined) =>
  runWorld({ collectors: ["tickets"], gh: script === undefined ? {} : { [TICKETS]: script } });
describe("tickets_orch producer (#4014; ported from autopilot-scripts)", () => {
  test("emits tickets_available as a direct true/false boolean (not a count)", async () => {
    const yes = kv((await tickets({ json: [{ number: 5, assignees: [] }, { number: 6, assignees: [] }] })).stdout);
    const no = kv((await tickets({ json: [] })).stdout);
    assert.equal(yes.tickets_available, "true");
    assert.equal(no.tickets_available, "false");
  });

  test("board condition is the EXISTING needs-tickets label (no new label)", async () => {
    const r = await tickets({ json: [] });
    assert.deepEqual(r.ghCalls, [["issue", "list", "--repo", DEFAULT_GITHUB_REPO, "--state", "open", "--label", "needs-tickets", "--limit", "100", "--json", "number,assignees"]]);
  });

  test("excludes currently-assigned needs-tickets issues (in-flight dedup)", async () => {
    const out = kv((await tickets({ json: [{ number: 3, assignees: [{ login: "a" }] }, { number: 9, assignees: [] }] })).stdout);
    assert.equal(out.tickets_orch_pending_spec, "issue-9");
  });

  test("emits the companion tickets_orch_pending_spec ref (verbatim-string seam)", async () => {
    assert.equal(kv((await tickets({ json: [{ number: 42, assignees: [] }] })).stdout).tickets_orch_pending_spec, "issue-42");
    assert.equal(kv((await tickets({ json: [] })).stdout).tickets_orch_pending_spec, "none");
  });

  test("promotes only a bare positive integer (fail-closed on gh-down / empty lane)", async () => {
    for (const script of [{ exitCode: 1 }, { json: [] }, { json: [{ number: null, assignees: [] }] }, { json: [{ number: 7.5, assignees: [] }] }]) {
      assert.equal((await tickets(script)).stdout, "tickets_available=false\ntickets_orch_pending_spec=none\n");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Interface cases
// ---------------------------------------------------------------------------

describe("Turn Snapshot Redis port — bounded, fail-open, closes", () => {
  function ops(over: Partial<TurnSnapshotRedisOps>, log: string[]): TurnSnapshotRedisOps {
    return {
      anchorQueueLength: async () => 4,
      scoutLastCalendarWalk: async () => "iso",
      architectureLastRun: async () => null,
      scoutTokens: async () => "12",
      mirrorScoutSpend: async (d, v, t) => void log.push(`set ${d} ${v} ${t}`),
      open: () => void log.push("open"),
      close: () => void log.push("close"),
      ...over,
    };
  }

  test("a healthy op resolves ok; open happens once, close only after an op", async () => {
    const log: string[] = [];
    const r = createTurnSnapshotRedis({ ops: ops({}, log) });
    r.close();
    assert.deepEqual(log, [], "close before any call must not touch the connection");
    assert.deepEqual(await r.anchorQueueLength("work-queue"), { ok: true, value: 4 });
    assert.deepEqual(await r.mirrorScoutSpend("2026-10-07", "12", 604800), { ok: true, value: true });
    r.close();
    assert.deepEqual(log, ["open", "set 2026-10-07 12 604800", "close"]);
  });

  test("a throwing op is ok:false, never a throw", async () => {
    const r = createTurnSnapshotRedis({ ops: ops({ scoutTokens: async () => Promise.reject(new Error("ECONNREFUSED")) }, []) });
    assert.deepEqual(await r.scoutTokens("d"), { ok: false, reason: "redis: ECONNREFUSED" });
  });

  test("a hung op times out as ok:false instead of wedging the turn", async () => {
    const r = createTurnSnapshotRedis({ ops: ops({ architectureLastRun: () => new Promise(() => {}) }, []), timeoutMs: 20 });
    const started = Date.now();
    assert.deepEqual(await r.architectureLastRun(), { ok: false, reason: "redis: timed out after 20ms" });
    assert.ok(Date.now() - started < 2000);
  });
});

describe("Turn Snapshot slice 5B — jq / gawk parity leaves", () => {
  test("jq length, order and text", () => {
    assert.equal(jqLength(null), 0);
    assert.equal(jqLength({ a: 1, b: 2 }), 2);
    assert.equal(jqLength(-3), 3);
    assert.throws(() => jqLength(true));
    assert.deepEqual(jqSort([3, "2", null, true, 1, [0], { a: 1 }, false]), [null, false, true, 1, 3, "2", [0], { a: 1 }]);
    assert.ok(jqCompare("1", 0) > 0, "strings sort after numbers (so a string totalCount counts as > 0)");
    assert.deepEqual([jqText("x"), jqText(12), jqText(null), jqText([1, "a"])], ["x", "12", "null", '[1,"a"]']);
  });

  test("gawk numeric coercion and the scout USD line", () => {
    assert.deepEqual(["2.5usd", " 7", "1e3", ".5", "abc", "0x10", "inf", "+inf"].map(awkNumber), [2.5, 7, 1000, 0.5, 0, 0, 0, Infinity]);
    assert.equal(scoutSpendUsd("12345", "0"), "0.00");
    assert.equal(scoutSpendUsd("0", "3"), "0.00");
    assert.equal(scoutSpendUsd("1000000", "0.0078125"), "0.007812", "glibc %.6f rounds the exact tie half-to-even");
    assert.equal(scoutSpendUsd("12345", "3"), "0.037035");
  });

  test("the wayfinder GraphQL query is built from the resolved repo, not a literal", () => {
    assert.match(wayfinderFrontierQuery("acme/widgets"), /repository\(owner:"acme", name:"widgets"\)/);
  });
});

describe("Turn Snapshot slice 5B — CLI and fail-open runner", () => {
  test("a collector that throws renders its full fallback plus a note; the others still render; redis is closed", async () => {
    let closed = 0;
    const github = createTurnSnapshotGithub({ transport: async () => ({ ok: false, stderr: "" }), repo: DEFAULT_GITHUB_REPO });
    const run = await runRemainingCollectors(["tickets", "redis-queues"], {
      github: { ...github, openIssueAssigneesWithLabel: async () => Promise.reject(new Error("boom")) },
      hydra: createTurnSnapshotHydraHttp({ transport: async () => assert.fail("no HTTP read") }),
      redis: { ...fakeRedis({ lists: { "hydra:anchors:work-queue": 2, "hydra:anchors:reframe-queue": 2, "hydra:anchors:prior-failures": 2 } }, []), close: () => void closed++ },
      now: () => 0,
      ghListLimit: 100,
      orchBoardDegraded: "0",
      env: {},
    });
    assert.equal(run.stdout, "tickets_available=false\ntickets_orch_pending_spec=none\nbacklog_subsystem=retired-adr0031\nwork_queue=2\nreframe_queue=2\nprior_failures=2\n");
    assert.deepEqual(run.notes, ["orch turn-snapshot tickets collector crashed (boom) — emitting its fail-open fallback (issue #4933)"]);
    assert.equal(closed, 1);
  });

  test("slice-5B collectors are known to --collectors but cannot be mixed with another family", () => {
    assert.ok(!("error" in parseArgs(["--collectors", "redis-queues,tickets", "--orch-board-degraded", "1"])));
    assert.match((parseArgs(["--collectors", "pr-gate,tickets"]) as { error: string }).error, /cannot be combined/);
    assert.match((parseArgs(["--collectors", "health,tickets"]) as { error: string }).error, /cannot be combined/);
  });

  test("remaining deps missing → usage error (exit 2), nothing on stdout", async () => {
    let stdout = "";
    const github = createTurnSnapshotGithub({ transport: async () => ({ ok: false, stderr: "" }), repo: DEFAULT_GITHUB_REPO });
    const code = await main(["--collectors", "tickets"], { github, now: () => 0, sleep: async () => {}, env: {} }, {
      stdout: (t) => (stdout += t),
      stderr: () => {},
      writeFile: () => {},
    });
    assert.equal(code, 2);
    assert.equal(stdout, "");
  });

  test("every registry fallback concatenates to the bash all-reads-failed goldens", () => {
    const head = loadGolden("remaining-group-a-all-failed.json").expected.stdout;
    const tail = loadGolden("remaining-group-b-all-failed.json").expected.stdout;
    const fb = (names: string[]) => names.map((n) => REMAINING_COLLECTORS[n]!.fallback.text).join("");
    assert.equal(fb(["redis-queues", "scout", "arch-cleanup-boards", "hitl-grill"]), head);
    assert.equal(fb(["retro", "wayfinder-frontier", "tickets"]), tail);
    assert.equal(REMAINING_COLLECTORS["arch-cleanup-boards"]!.fallback.exports, "ARCH_WORK_QUEUE=0\nORCH_BOARD_DEGRADED=1\n");
  });
});
