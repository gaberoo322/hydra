#!/usr/bin/env -S node --no-warnings --experimental-strip-types
/**
 * turn-snapshot.ts — the one-shot Turn Snapshot CLI (ADR-0043 Decision 2).
 *
 * A thin shell over `src/autopilot/turn-snapshot/`: parse argv, build the
 * production deps (the `TurnSnapshotGithub` port over the GitHub CLI Adapter,
 * the wall clock, the HYDRA_ORCH_* windows), run the requested collectors,
 * print their `kv` lines on stdout and their notes on stderr. It runs per
 * turn under `node --experimental-strip-types` (no build step, no service
 * dependency — the autopilot keeps deciding while the data plane is down).
 *
 *   node --no-warnings --experimental-strip-types scripts/autopilot/turn-snapshot.ts \
 *     --collectors pr-gate[,picks] --format kv [--gh-list-limit N] [--exports-file PATH]
 *     [--board-state-file PATH]
 *
 *   --collectors LIST      comma-separated; each collector's lines print in
 *                          the order given (pr-gate + picks as one block):
 *   --collectors pr-gate   the in-flight PR + PR-gate collector (slice 1)
 *   --collectors orch-board  orch board counts + needs-triage items (slice 2)
 *   --collectors untriaged-orphans  the orphan backstop count (slice 2)
 *   --collectors needs-qa  the ordered needs-qa numbers (slice 2)
 *   --collectors picks     the grill / dev-ready picks, Candidate Exclusions,
 *                          merged-PR refusal and active_dev_orch (slice 3);
 *                          needs pr-gate in the SAME run — it takes the
 *                          in-flight sets from pr-gate's outcome in-process
 *   --collectors <passthrough>  health, direction-drift, scout-alerts,
 *                          realm-share, usage-eligibility, emergency-brake,
 *                          class-stats, capacity, scheduler, recommendations,
 *                          slot-events (slice 5, #4933); a consecutive run of
 *                          them reads concurrently, printed in the order given
 *   --collectors <5B>      redis-queues, scout, arch-cleanup-boards, hitl-grill,
 *                          retro, wayfinder-frontier, tickets (slice 5B, #4933);
 *                          a consecutive run of them reads concurrently,
 *                          printed in the order given
 *   --collectors target-board | target-scan-boards | target-risk-surface
 *                          the Target board family (slice 4, #4932), against
 *                          the Target repo/workspace/manifest from
 *                          src/target-config.ts; a consecutive run of them
 *                          runs in the order given (src/autopilot/turn-snapshot/target-cli.ts)
 *   --target-lane-degraded 0|1   target-scan-boards: the lane accumulator (#4130)
 *                          collect-state.sh read back from target-board's exports
 *   --target-work-queue N  target-scan-boards: the work-queue length (backfill_idle)
 *   --orch-board-degraded V  collect-state.sh's ORCH_BOARD_DEGRADED going into
 *                          arch-cleanup-boards (`1` = an earlier orch board read
 *                          failed); default 0
 *   --format kv            the legacy `key=value` wire (collect-state.sh's calls)
 *   --format json          (no --collectors) EVERY collector in one run, printed as ONE
 *                          JSON Turn Snapshot validated on emit against
 *                          src/schemas/turn-snapshot.ts (ADR-0043 slice 6, #4934);
 *                          turn.sh feeds it to decide.py via turn_snapshot.py
 *   --gh-list-limit N      `gh … --limit` page size (collect-state.sh passes
 *                          its GH_ISSUE_LIST_LIMIT); default 100
 *   --exports-file PATH    also write the shell assignments the still-bash
 *                          collectors read back (picks: ORCH_BOARD_DEGRADED;
 *                          orch-board: ORCH_BOARD_DEGRADED, BOARD_STATE_DEGRADED,
 *                          BOARD_STATE_JSON — the healthy body collect-state.sh
 *                          hands to the later picks run via --board-state-file;
 *                          arch-cleanup-boards: ARCH_WORK_QUEUE, ORCH_BOARD_DEGRADED;
 *                          target-board: TARGET_LANE_DEGRADED)
 *   --board-state-file PATH  the HEALTHY orch board-state body (the picks'
 *                          glm_withheld source); omit it when that read degraded
 *
 * FAIL-OPEN: the CLI never crashes the turn. A collector that throws is
 * reported as a stderr note and rendered as the fully-degraded fallback (the
 * same lines the bash printed when every read failed); exit 0. Only a usage
 * error exits non-zero (2) — collect-state.sh then prints its own fallback.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectPrGate,
  prGateFallbackSnapshot,
  PR_GATE_COLLECTOR,
  type PrGateDeps,
  type PrGateSnapshot,
} from "../../src/autopilot/turn-snapshot/pr-gate.ts";
import { createTurnSnapshotGithub, type GhTransport, type TurnSnapshotGithub } from "../../src/autopilot/turn-snapshot/github-port.ts";
import { renderPicksExports, renderPicksKv, renderPrGateKv } from "../../src/autopilot/turn-snapshot/render-kv.ts";
import { collectPicks, picksFallbackSnapshot, PICKS_COLLECTOR, type PicksSnapshot } from "../../src/autopilot/turn-snapshot/picks.ts";
import { createTurnSnapshotHydra, type TurnSnapshotHydra } from "../../src/autopilot/turn-snapshot/hydra-http.ts";
import {
  collectNeedsQaNumbers,
  collectOrchBoard,
  collectUntriagedOrphans,
  NEEDS_QA_COLLECTOR,
  ORCH_BOARD_COLLECTOR,
  orchBoardFallbackSnapshot,
  UNTRIAGED_ORPHANS_COLLECTOR,
} from "../../src/autopilot/turn-snapshot/orch-board.ts";
import {
  renderNeedsQaNumbersKv,
  renderOrchBoardExports,
  renderOrchBoardKv,
  renderUntriagedOrphansKv,
} from "../../src/autopilot/turn-snapshot/render-kv.ts";
import {
  isPassthroughCollector,
  PASSTHROUGH_COLLECTORS,
  runPassthroughCollectors,
  type PassthroughDeps,
} from "../../src/autopilot/turn-snapshot/passthrough.ts";
import { createTurnSnapshotHost } from "../../src/autopilot/turn-snapshot/host-port.ts";
import { getTargetGithubRepo, getTargetWorkspace } from "../../src/target-config.ts";
import { isTargetCollector, runTargetCollectors, TARGET_COLLECTORS, type TargetCliDeps } from "../../src/autopilot/turn-snapshot/target-cli.ts";
import { collectTargetFacts } from "../target/print-target-facts.ts";
import { isRemainingCollector, REMAINING_COLLECTORS, runRemainingCollectors } from "../../src/autopilot/turn-snapshot/remaining.ts";
import { createTurnSnapshotRedis, type TurnSnapshotRedis } from "../../src/autopilot/turn-snapshot/redis-port.ts";
import type { Classified, DegradedMarker } from "../../src/autopilot/turn-snapshot/collector.ts";
import type { OrchBoardSnapshot } from "../../src/autopilot/turn-snapshot/orch-board.ts";
import {
  buildTurnSnapshot,
  serializeTurnSnapshot,
  type SnapshotDegraded,
  type TurnSnapshotValues,
} from "../../src/autopilot/turn-snapshot/json-snapshot.ts";
import { TARGET_BOARD_COLLECTOR } from "../../src/autopilot/turn-snapshot/target-board.ts";
import { TARGET_RISK_SURFACE_COLLECTOR } from "../../src/autopilot/turn-snapshot/target-risk-surface.ts";
import { TARGET_SCAN_BOARDS_COLLECTOR } from "../../src/autopilot/turn-snapshot/target-scan-boards.ts";

export interface CliArgs {
  collectors: string[];
  format: string;
  ghListLimit: number;
  exportsFile: string | null;
  boardStateFile: string | null;
  /** collect-state.sh's ORCH_BOARD_DEGRADED going into arch-cleanup-boards (slice 5B). */
  orchBoardDegraded: string;
  /** target-scan-boards: the lane-degraded accumulator collect-state.sh read back from target-board. */
  targetLaneDegraded?: boolean;
  /** target-scan-boards: the orchestrator work-queue length (`backfill_idle`). */
  targetWorkQueue?: number;
  /** `--format json` only: the healthy board-state body handed from orch-board to picks in-process (null = degraded). */
  boardStateText?: string | null;
}

const KNOWN_COLLECTORS = new Set([
  PR_GATE_COLLECTOR,
  PICKS_COLLECTOR,
  ORCH_BOARD_COLLECTOR,
  UNTRIAGED_ORPHANS_COLLECTOR,
  NEEDS_QA_COLLECTOR,
  ...Object.keys(PASSTHROUGH_COLLECTORS),
  ...Object.keys(REMAINING_COLLECTORS),
  ...TARGET_COLLECTORS,
]);
const DEFAULT_GH_LIST_LIMIT = 100;

/** Parse argv; returns an error string on a usage error. */
export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = { collectors: [], format: "kv", ghListLimit: DEFAULT_GH_LIST_LIMIT, exportsFile: null, boardStateFile: null, orchBoardDegraded: "0" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) return { error: `missing value for ${flag}` };
    i++;
    if (flag === "--collectors") args.collectors = value.split(",").filter(Boolean);
    else if (flag === "--format") args.format = value;
    else if (flag === "--gh-list-limit") {
      if (!/^[1-9]\d*$/.test(value)) return { error: `--gh-list-limit must be a positive integer, got '${value}'` };
      args.ghListLimit = Number(value);
    } else if (flag === "--exports-file") args.exportsFile = value;
    else if (flag === "--board-state-file") args.boardStateFile = value;
    else if (flag === "--orch-board-degraded") args.orchBoardDegraded = value;
    else if (flag === "--target-lane-degraded") {
      if (value !== "0" && value !== "1") return { error: `--target-lane-degraded must be 0 or 1, got '${value}'` };
      args.targetLaneDegraded = value === "1";
    } else if (flag === "--target-work-queue") {
      if (!/^\d+$/.test(value)) return { error: `--target-work-queue must be a non-negative integer, got '${value}'` };
      args.targetWorkQueue = Number(value);
    }
    else return { error: `unknown flag ${flag}` };
  }
  if (args.format === "json") {
    // The JSON Turn Snapshot (ADR-0043 slice 6) is EVERY collector, in one run.
    if (args.collectors.length > 0) return { error: "--format json runs every collector; drop --collectors" };
    if (args.exportsFile !== null || args.boardStateFile !== null) return { error: "--format json hands accumulators over in-process; drop --exports-file/--board-state-file" };
    return args;
  }
  if (args.collectors.length === 0) return { error: "--collectors is required" };
  const unknown = args.collectors.filter((c) => !KNOWN_COLLECTORS.has(c));
  if (unknown.length > 0) return { error: `unknown collector(s): ${unknown.join(",")}` };
  if (args.collectors.includes(PICKS_COLLECTOR) && !args.collectors.includes(PR_GATE_COLLECTOR)) {
    return { error: `${PICKS_COLLECTOR} needs ${PR_GATE_COLLECTOR} in the same run (it takes the in-flight sets in-process)` };
  }
  if (args.format !== "kv") return { error: `unsupported --format ${args.format} (kv | json)` };
  return args;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  writeFile(path: string, text: string): void;
  /** Read a text file (`--board-state-file`); absent → the file reads as unavailable. */
  readFile?(path: string): string;
}

/** Everything the CLI needs besides argv — production values come from {@link productionDeps}. */
export type CliDeps = Omit<PrGateDeps, "ghListLimit" | "github"> & {
  /** The FULL orch port: pr-gate reads only its `PrGateGithub` subset (pr-gate.ts), the other slices the rest. */
  readonly github: TurnSnapshotGithub;
  /** The hydra HTTP client (orch-board's board-state read, picks' design-concept probe). Defaults to the production client. */
  readonly hydra?: TurnSnapshotHydra;
  /** The passthrough collectors' non-HTTP deps (slice 5); absent → those collectors are a usage error. */
  readonly passthrough?: Omit<PassthroughDeps, "hydra">;
  /** The slice-5B collectors' non-gh/HTTP deps (#4933); absent → those collectors are a usage error. */
  readonly remaining?: {
    readonly redis: TurnSnapshotRedis;
    readonly env: { readonly HYDRA_TOKEN_USD_RATE?: string };
  };
  /** The Target-board family's deps (slice 4), built lazily — only a Target collector resolves the Target realm. */
  readonly target?: () => TargetCliDeps;
};

/** The slice-1/3 block: pr-gate, then picks fed pr-gate's in-flight sets in-process. */
async function runPrGateAndPicks(
  args: CliArgs,
  deps: CliDeps,
  io: CliIo,
): Promise<{ kv: string; exports: string; prGate: PrGateSnapshot; picks: PicksSnapshot | null; degraded: SnapshotDegraded[] }> {
  const wantPrGate = args.collectors.includes(PR_GATE_COLLECTOR);
  const wantPicks = args.collectors.includes(PICKS_COLLECTOR);
  let stdout = "";
  let exportsText = "";

  const degraded: SnapshotDegraded[] = [];
  let prGate: PrGateSnapshot = prGateFallbackSnapshot("not-requested");
  if (wantPrGate) {
    try {
      const outcome = await collectPrGate({ ...deps, ghListLimit: args.ghListLimit });
      for (const note of outcome.notes) io.stderr(`${note}\n`);
      degraded.push(...outcome.degraded.map((d) => ({ collector: PR_GATE_COLLECTOR, ...d })));
      prGate = outcome.value;
    } catch (err) {
      /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`orch turn-snapshot pr-gate collector crashed (${msg}) — emitting the fail-open PR-gate fallback (issue #4929)\n`);
      prGate = prGateFallbackSnapshot("collector-crashed");
      degraded.push({ collector: PR_GATE_COLLECTOR, field: PR_GATE_COLLECTOR, reason: "collector-crashed" });
    }
    stdout += renderPrGateKv(prGate);
  }

  let picks: PicksSnapshot | null = null;
  if (wantPicks) {
    try {
      const outcome = await collectPicks({
        github: deps.github,
        hydra: deps.hydra ?? createTurnSnapshotHydra(),
        now: deps.now,
        ghListLimit: args.ghListLimit,
        inflight: prGate.inflight,
        boardState: args.boardStateText !== undefined ? args.boardStateText : readBoardState(args.boardStateFile, io),
      });
      for (const note of outcome.notes) io.stderr(`${note}\n`);
      degraded.push(...outcome.degraded.map((d) => ({ collector: PICKS_COLLECTOR, ...d })));
      picks = outcome.value;
    } catch (err) {
      /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`orch turn-snapshot picks collector crashed (${msg}) — emitting the fail-open picks fallback; orch lane flagged degraded (issue #4931)\n`);
      picks = picksFallbackSnapshot();
      degraded.push({ collector: PICKS_COLLECTOR, field: PICKS_COLLECTOR, reason: "collector-crashed" });
    }
    stdout += renderPicksKv(picks);
    exportsText += renderPicksExports(picks);
  }

  return { kv: stdout, exports: exportsText, prGate, picks, degraded };
}

/** A slice-2 collector's typed value. */
type Slice2Value = OrchBoardSnapshot | Classified<number> | Classified<readonly number[]>;

/** One slice-2 collector, rendered; a throw becomes a stderr note plus that collector's fully-degraded fallback. */
async function runSlice2Collector(
  name: string,
  deps: CliDeps,
  ghListLimit: number,
  io: CliIo,
): Promise<{ kv: string; exports: string; value: Slice2Value; degraded: SnapshotDegraded[] }> {
  const crashed = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`orch turn-snapshot ${name} collector crashed (${msg}) — emitting the fail-open ${name} fallback (issue #4930)\n`);
  };
  const emitNotes = (notes: readonly string[]) => {
    for (const note of notes) io.stderr(`${note}\n`);
  };
  const tag = (ds: readonly DegradedMarker[]): SnapshotDegraded[] => ds.map((d) => ({ collector: name, ...d }));
  const crashMarker: SnapshotDegraded[] = [{ collector: name, field: name, reason: "collector-crashed" }];
  if (name === ORCH_BOARD_COLLECTOR) {
    let snapshot = orchBoardFallbackSnapshot("collector-crashed");
    let degraded = crashMarker;
    try {
      const outcome = await collectOrchBoard({ github: deps.github, hydra: deps.hydra ?? createTurnSnapshotHydra(), now: deps.now, ghListLimit });
      emitNotes(outcome.notes);
      snapshot = outcome.value;
      degraded = tag(outcome.degraded);
    } catch (err) {
      /* intentional: fail-open — crashed() reports it as a stderr note via io.stderr and the fallback renders */
      crashed(err);
    }
    return { kv: renderOrchBoardKv(snapshot), exports: renderOrchBoardExports(snapshot), value: snapshot, degraded };
  }
  if (name === UNTRIAGED_ORPHANS_COLLECTOR) {
    try {
      const outcome = await collectUntriagedOrphans({ github: deps.github, ghListLimit });
      emitNotes(outcome.notes);
      return { kv: renderUntriagedOrphansKv(outcome.value), exports: "", value: outcome.value, degraded: tag(outcome.degraded) };
    } catch (err) {
      /* intentional: fail-open — crashed() reports it as a stderr note via io.stderr and the fallback renders */
      crashed(err);
      const value: Classified<number> = { ok: false, reason: "collector-crashed" };
      return { kv: renderUntriagedOrphansKv(value), exports: "", value, degraded: crashMarker };
    }
  }
  try {
    const outcome = await collectNeedsQaNumbers({ github: deps.github, ghListLimit });
    emitNotes(outcome.notes);
    return { kv: renderNeedsQaNumbersKv(outcome.value), exports: "", value: outcome.value, degraded: tag(outcome.degraded) };
  } catch (err) {
    /* intentional: fail-open — crashed() reports it as a stderr note via io.stderr and the fallback renders */
    crashed(err);
    const value: Classified<readonly number[]> = { ok: false, reason: "collector-crashed" };
    return { kv: renderNeedsQaNumbersKv(value), exports: "", value, degraded: crashMarker };
  }
}

/** Run the CLI. Returns the exit code; never throws. */
export async function main(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.stderr(`turn-snapshot: ${args.error}\n`);
    return 2;
  }
  const passthroughNames = args.collectors.filter(isPassthroughCollector);
  if (passthroughNames.length > 0 && deps.passthrough === undefined) {
    io.stderr("turn-snapshot: passthrough collectors need passthrough deps\n");
    return 2;
  }
  if (args.format === "json") return runJsonSnapshot(args, deps, io);
  if (args.collectors.some(isRemainingCollector) && deps.remaining === undefined) {
    io.stderr("turn-snapshot: slice-5B collectors need remaining deps\n");
    return 2;
  }
  let stdout = "";
  let exportsText = "";
  let prGateBlockDone = false;
  // The Target realm resolves at most once per run, and only if a Target collector asked for it.
  let targetCache: TargetCliDeps | null = null;
  const targetFactory = deps.target;
  const targetDeps = targetFactory === undefined ? undefined : () => (targetCache ??= targetFactory());
  for (let i = 0; i < args.collectors.length; i++) {
    const name = args.collectors[i] as string;
    let r: { kv: string; exports: string };
    if (isPassthroughCollector(name)) {
      // A consecutive run of passthrough collectors reads concurrently (slice 5).
      const run: string[] = [name];
      while (i + 1 < args.collectors.length && isPassthroughCollector(args.collectors[i + 1] as string)) run.push(args.collectors[++i] as string);
      const out = await runPassthroughCollectors(run, { ...(deps.passthrough as Omit<PassthroughDeps, "hydra">), hydra: deps.hydra ?? createTurnSnapshotHydra() });
      for (const note of out.notes) io.stderr(`${note}\n`);
      r = { kv: out.stdout, exports: "" };
    } else if (isRemainingCollector(name)) {
      // A consecutive run of slice-5B collectors reads concurrently; the Redis connection is closed after it.
      const run: string[] = [name];
      while (i + 1 < args.collectors.length && isRemainingCollector(args.collectors[i + 1] as string)) run.push(args.collectors[++i] as string);
      const remaining = deps.remaining as NonNullable<CliDeps["remaining"]>;
      const out = await runRemainingCollectors(run, {
        github: deps.github,
        hydra: deps.hydra ?? createTurnSnapshotHydra(),
        redis: remaining.redis,
        env: remaining.env,
        now: deps.now,
        ghListLimit: args.ghListLimit,
        orchBoardDegraded: args.orchBoardDegraded,
      });
      for (const note of out.notes) io.stderr(`${note}\n`);
      r = { kv: out.stdout, exports: out.exports ?? "" };
    } else if (isTargetCollector(name)) {
      // A consecutive run of Target collectors (slice 4) runs in the order given, against the Target realm.
      const run: string[] = [name];
      while (i + 1 < args.collectors.length && isTargetCollector(args.collectors[i + 1] as string)) run.push(args.collectors[++i] as string);
      r = await runTargetCollectors(run, args, targetDeps, io);
    } else if (name === PR_GATE_COLLECTOR || name === PICKS_COLLECTOR) {
      if (prGateBlockDone) continue;
      prGateBlockDone = true;
      r = await runPrGateAndPicks(args, deps, io);
    } else {
      r = await runSlice2Collector(name, deps, args.ghListLimit, io);
    }
    stdout += r.kv;
    exportsText += r.exports;
  }

  if (args.exportsFile !== null) {
    try {
      io.writeFile(args.exportsFile, exportsText);
    } catch (err) {
      /* intentional: reported as a stderr note via io.stderr; the kv lines still print */
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`orch turn-snapshot could not write the exports file (${msg}) — the still-bash collectors read their defaults (issue #4931)\n`);
    }
  }
  io.stdout(stdout);
  return 0;
}

/**
 * `--format json` (ADR-0043 slice 6, #4934): run EVERY collector in
 * collect-state.sh's order, handing the cross-collector accumulators over
 * in-process exactly as collect-state.sh threaded them through
 * `--exports-file` (ORCH_BOARD_DEGRADED, the healthy board-state body,
 * TARGET_LANE_DEGRADED, ARCH_WORK_QUEUE), build the JSON Turn Snapshot from
 * the typed values, validate it on emit and print it. Never throws; a
 * validation failure is a marker in the document plus a stderr note, exit 0.
 */
async function runJsonSnapshot(args: CliArgs, deps: CliDeps, io: CliIo): Promise<number> {
  if (deps.passthrough === undefined || deps.remaining === undefined) {
    io.stderr("turn-snapshot: --format json needs the passthrough and remaining deps\n");
    return 2;
  }
  const hydra = deps.hydra ?? createTurnSnapshotHydra();
  const passthroughDeps = { ...deps.passthrough, hydra };
  const degraded: SnapshotDegraded[] = [];
  const note = (notes: readonly string[]) => {
    for (const n of notes) io.stderr(`${n}\n`);
  };
  let targetCache: TargetCliDeps | null = null;
  const targetFactory = deps.target;
  const targetDeps = targetFactory === undefined ? undefined : () => (targetCache ??= targetFactory());

  // 1. health + direction drift
  const head = await runPassthroughCollectors(["health", "direction-drift"], passthroughDeps);
  note(head.notes);
  degraded.push(...head.degraded);
  // 2. orch board — seeds the #4130 accumulator and the healthy board-state body
  const orch = await runSlice2Collector(ORCH_BOARD_COLLECTOR, deps, args.ghListLimit, io);
  degraded.push(...orch.degraded);
  const orchBoard = orch.value as OrchBoardSnapshot;
  let orchBoardDegraded = orchBoard.orchBoardDegraded;
  // 3. Target board — the Target lane accumulator
  const tb = await runTargetCollectors([TARGET_BOARD_COLLECTOR], args, targetDeps, io);
  degraded.push(...tb.degraded);
  // 4. untriaged orphans + needs-qa numbers
  const orphans = await runSlice2Collector(UNTRIAGED_ORPHANS_COLLECTOR, deps, args.ghListLimit, io);
  const needsQa = await runSlice2Collector(NEEDS_QA_COLLECTOR, deps, args.ghListLimit, io);
  degraded.push(...orphans.degraded, ...needsQa.degraded);
  // 5. PR gate + picks, fed the healthy board-state body (null = degraded: no glm_withheld refusal)
  const gate = await runPrGateAndPicks(
    { ...args, collectors: [PR_GATE_COLLECTOR, PICKS_COLLECTOR], boardStateText: orchBoard.boardState === null ? null : JSON.stringify(orchBoard.boardState) },
    deps,
    io,
  );
  degraded.push(...gate.degraded);
  const picks = gate.picks ?? picksFallbackSnapshot();
  if (picks.boardDegraded) orchBoardDegraded = true;
  // 6. Redis queues, scout, arch/cleanup/skill-prune boards, hitl-grill, retro, wayfinder, tickets
  const remaining = deps.remaining;
  const rest = await runRemainingCollectors(
    ["redis-queues", "scout", "arch-cleanup-boards", "hitl-grill", "retro", "wayfinder-frontier", "tickets"],
    {
      github: deps.github,
      hydra,
      redis: remaining.redis,
      env: remaining.env,
      now: deps.now,
      ghListLimit: args.ghListLimit,
      orchBoardDegraded: orchBoardDegraded ? "1" : "0",
    },
  );
  note(rest.notes);
  degraded.push(...rest.degraded);
  const rv = rest.values as Required<typeof rest.values>;
  // 7. Target scan boards + risk surface, fed the lane accumulator and the work-queue depth
  const targetBoard = tb.values.targetBoard as NonNullable<typeof tb.values.targetBoard>;
  const ts = await runTargetCollectors(
    [TARGET_SCAN_BOARDS_COLLECTOR, TARGET_RISK_SURFACE_COLLECTOR],
    { ...args, targetLaneDegraded: targetBoard.laneDegraded, targetWorkQueue: rv["arch-cleanup-boards"].workQueue },
    targetDeps,
    io,
  );
  degraded.push(...ts.degraded);
  // 8. the data-plane passthroughs
  const tail = await runPassthroughCollectors(
    ["scout-alerts", "realm-share", "usage-eligibility", "emergency-brake", "class-stats", "capacity", "scheduler", "recommendations", "slot-events"],
    passthroughDeps,
  );
  note(tail.notes);
  degraded.push(...tail.degraded);
  const pv = { ...head.values, ...tail.values } as Required<typeof head.values>;

  const values: TurnSnapshotValues = {
    health: pv.health,
    directionDrift: pv["direction-drift"],
    orchBoard,
    targetBoard,
    untriagedOrphans: orphans.value as Classified<number>,
    needsQaNumbers: needsQa.value as Classified<readonly number[]>,
    prGate: gate.prGate,
    picks,
    redisQueues: rv["redis-queues"],
    scout: rv.scout,
    archBoards: rv["arch-cleanup-boards"],
    hitlGrill: rv["hitl-grill"],
    targetScan: ts.values.targetScan as NonNullable<typeof ts.values.targetScan>,
    targetRiskSurface: ts.values.targetRiskSurface as NonNullable<typeof ts.values.targetRiskSurface>,
    retro: rv.retro,
    wayfinder: rv["wayfinder-frontier"],
    tickets: rv.tickets,
    scoutAlerts: pv["scout-alerts"],
    realmShare: pv["realm-share"],
    usageEligibility: pv["usage-eligibility"],
    emergencyBrake: pv["emergency-brake"],
    classStats: pv["class-stats"],
    capacity: pv.capacity,
    scheduler: pv.scheduler,
    recommendations: pv.recommendations,
    slotEvents: pv["slot-events"],
  };
  const out = serializeTurnSnapshot(buildTurnSnapshot(values, { nowMs: deps.now(), degraded }));
  if (out.note !== null) io.stderr(`${out.note}\n`);
  io.stdout(out.text);
  return 0;
}

/** The `--board-state-file` body, or `null` (degraded: no glm_withheld pin refusal) when absent/unreadable. */
function readBoardState(path: string | null, io: CliIo): string | null {
  if (path === null) return null;
  try {
    if (io.readFile === undefined) throw new Error("no file reader");
    return io.readFile(path).replace(/\n+$/, "");
  } catch (err) {
    /* intentional: reported as a stderr note via io.stderr; a missing board-state is the degraded (fail-open) read */
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`orch turn-snapshot could not read the board-state file (${msg}) — GLM-withheld set empty this pass (issue #4931)\n`);
    return null;
  }
}

/** The production deps: the real gh port, wall clock, real sleep, HYDRA_ORCH_* windows. */
export function productionDeps(): CliDeps {
  const hydra = createTurnSnapshotHydra();
  return {
    github: createTurnSnapshotGithub(),
    hydra,
    now: () => Date.now(),
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0)),
    env: {
      uncheckedGraceSeconds: process.env.HYDRA_ORCH_PR_UNCHECKED_GRACE_SECONDS,
      glmRedQuiescenceSeconds: process.env.HYDRA_ORCH_GLM_RED_QUIESCENCE_SECONDS,
      unknownRepollDelaySeconds: process.env.HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS,
    },
    passthrough: {
      host: createTurnSnapshotHost(),
      env: {
        HOME: process.env.HOME,
        HYDRA_CONFIG_PATH: process.env.HYDRA_CONFIG_PATH,
        HYDRA_TARGET_REPO: process.env.HYDRA_TARGET_REPO,
        HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID: process.env.HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID,
        HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT: process.env.HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT,
      },
      taxonomyPath: join(dirname(fileURLToPath(import.meta.url)), "classes.json"),
      targetWorkspace: quietTargetWorkspace,
    },
    remaining: {
      redis: createTurnSnapshotRedis(),
      env: { HYDRA_TOKEN_USD_RATE: process.env.HYDRA_TOKEN_USD_RATE },
    },
    target: () => productionTargetDeps({ hydra }),
  };
}

/**
 * Run a Target realm read with its console diagnostics muted (target-config's
 * one-time "env var unset" warnings, loadManifest's manifest errors): the strangled bash resolved these facts through
 * `print-target-facts.ts 2>/dev/null`, so the turn's stderr never carried
 * them (ADR-0043 D4 — same stderr-note set).
 */
function quietTargetConfig<T>(read: () => T): T {
  const warn = console.warn;
  const error = console.error;
  console.warn = () => {};
  // loadManifest (src/target/manifest.ts) reports a missing/malformed manifest
  // via console.error; the outcome itself still renders as ok:false.
  console.error = () => {};
  try {
    return read();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

/**
 * The Target realm (ADR-0002 / ADR-0026): the repo + workspace resolve
 * through src/target-config.ts (HYDRA_TARGET_REPO still overrides the
 * workspace, as in collect-state.sh), the manifest through
 * print-target-facts.ts's `collectTargetFacts` — imported, never shelled to.
 * The board-state read goes through the ONE unified hydra client.
 */
export function productionTargetDeps(opts: { transport?: GhTransport; hydra?: TurnSnapshotHydra } = {}): TargetCliDeps {
  return {
    github: createTurnSnapshotGithub({ repo: quietTargetConfig(getTargetGithubRepo), transport: opts.transport }),
    hydra: opts.hydra ?? createTurnSnapshotHydra(),
    workspace: () => process.env.HYDRA_TARGET_REPO || quietTargetConfig(getTargetWorkspace),
    facts: () => quietTargetConfig(() => collectTargetFacts()),
  };
}

/**
 * The Target workspace from src/target-config.ts with its one-time
 * "HYDRA_PROJECT_WORKSPACE is unset" warning dropped — the bash read it via
 * print-target-facts.ts with `2>/dev/null`, so the stderr-note set stays the same.
 */
function quietTargetWorkspace(): string {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return getTargetWorkspace();
  } finally {
    console.warn = warn;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => process.stderr.write(t),
    writeFile: (p, t) => writeFileSync(p, t),
    readFile: (p) => readFileSync(p, "utf-8"),
  };
  const code = await main(process.argv.slice(2), productionDeps(), io);
  // Flush stdout, then exit hard: the gh seam's rate-limit gate may hold a
  // lazily-opened Redis handle that would otherwise keep the process alive.
  process.stdout.write(out.join(""), () => process.exit(code));
}
