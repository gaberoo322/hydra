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
 *   --collectors pr-gate   the in-flight PR + PR-gate collector (slice 1)
 *   --collectors picks     the grill / dev-ready picks, Candidate Exclusions,
 *                          merged-PR refusal and active_dev_orch (slice 3);
 *                          needs pr-gate in the SAME run — it takes the
 *                          in-flight sets from pr-gate's outcome in-process
 *   --format kv            today's `key=value` wire (the only format until slice 6)
 *   --gh-list-limit N      `gh … --limit` page size (collect-state.sh passes
 *                          its GH_ISSUE_LIST_LIMIT); default 100
 *   --exports-file PATH    also write the shell assignments the still-bash
 *                          collectors read back (picks: ORCH_BOARD_DEGRADED)
 *   --board-state-file PATH  the HEALTHY orch board-state body (the picks'
 *                          glm_withheld source); omit it when that read degraded
 *
 * FAIL-OPEN: the CLI never crashes the turn. A collector that throws is
 * reported as a stderr note and rendered as the fully-degraded fallback (the
 * same lines the bash printed when every read failed); exit 0. Only a usage
 * error exits non-zero (2) — collect-state.sh then prints its own fallback.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  collectPrGate,
  prGateFallbackSnapshot,
  PR_GATE_COLLECTOR,
  type PrGateDeps,
  type PrGateSnapshot,
} from "../../src/autopilot/turn-snapshot/pr-gate.ts";
import { createTurnSnapshotGithub } from "../../src/autopilot/turn-snapshot/github-port.ts";
import { renderPicksExports, renderPicksKv, renderPrGateKv } from "../../src/autopilot/turn-snapshot/render-kv.ts";
import { collectPicks, picksFallbackSnapshot, PICKS_COLLECTOR, type PicksSnapshot } from "../../src/autopilot/turn-snapshot/picks.ts";
import { createTurnSnapshotHydraHttp, type TurnSnapshotHydraHttp } from "../../src/autopilot/turn-snapshot/hydra-http.ts";

export interface CliArgs {
  collectors: string[];
  format: string;
  ghListLimit: number;
  exportsFile: string | null;
  boardStateFile: string | null;
}

const KNOWN_COLLECTORS = new Set([PR_GATE_COLLECTOR, PICKS_COLLECTOR]);
const DEFAULT_GH_LIST_LIMIT = 100;

/** Parse argv; returns an error string on a usage error. */
export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = { collectors: [], format: "kv", ghListLimit: DEFAULT_GH_LIST_LIMIT, exportsFile: null, boardStateFile: null };
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
    else return { error: `unknown flag ${flag}` };
  }
  if (args.collectors.length === 0) return { error: "--collectors is required" };
  const unknown = args.collectors.filter((c) => !KNOWN_COLLECTORS.has(c));
  if (unknown.length > 0) return { error: `unknown collector(s): ${unknown.join(",")}` };
  if (args.collectors.includes(PICKS_COLLECTOR) && !args.collectors.includes(PR_GATE_COLLECTOR)) {
    return { error: `${PICKS_COLLECTOR} needs ${PR_GATE_COLLECTOR} in the same run (it takes the in-flight sets in-process)` };
  }
  if (args.format !== "kv") return { error: `unsupported --format ${args.format} (only kv until ADR-0043 slice 6)` };
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
export type CliDeps = Omit<PrGateDeps, "ghListLimit"> & {
  /** The hydra-service HTTP port the picks collector probes design concepts through. */
  readonly hydra?: TurnSnapshotHydraHttp;
};

/** Run the CLI. Returns the exit code; never throws. */
export async function main(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.stderr(`turn-snapshot: ${args.error}\n`);
    return 2;
  }
  const wantPrGate = args.collectors.includes(PR_GATE_COLLECTOR);
  const wantPicks = args.collectors.includes(PICKS_COLLECTOR);
  let stdout = "";
  let exportsText = "";

  let prGate: PrGateSnapshot = prGateFallbackSnapshot("not-requested");
  if (wantPrGate) {
    try {
      const outcome = await collectPrGate({ ...deps, ghListLimit: args.ghListLimit });
      for (const note of outcome.notes) io.stderr(`${note}\n`);
      prGate = outcome.value;
    } catch (err) {
      /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`orch turn-snapshot pr-gate collector crashed (${msg}) — emitting the fail-open PR-gate fallback (issue #4929)\n`);
      prGate = prGateFallbackSnapshot("collector-crashed");
    }
    stdout += renderPrGateKv(prGate);
  }

  if (wantPicks) {
    let picks: PicksSnapshot;
    try {
      const outcome = await collectPicks({
        github: deps.github,
        hydra: deps.hydra ?? createTurnSnapshotHydraHttp(),
        now: deps.now,
        ghListLimit: args.ghListLimit,
        inflight: prGate.inflight,
        boardState: readBoardState(args.boardStateFile, io),
      });
      for (const note of outcome.notes) io.stderr(`${note}\n`);
      picks = outcome.value;
    } catch (err) {
      /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`orch turn-snapshot picks collector crashed (${msg}) — emitting the fail-open picks fallback; orch lane flagged degraded (issue #4931)\n`);
      picks = picksFallbackSnapshot();
    }
    stdout += renderPicksKv(picks);
    exportsText += renderPicksExports(picks);
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
  return {
    github: createTurnSnapshotGithub(),
    hydra: createTurnSnapshotHydraHttp(),
    now: () => Date.now(),
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0)),
    env: {
      uncheckedGraceSeconds: process.env.HYDRA_ORCH_PR_UNCHECKED_GRACE_SECONDS,
      glmRedQuiescenceSeconds: process.env.HYDRA_ORCH_GLM_RED_QUIESCENCE_SECONDS,
      unknownRepollDelaySeconds: process.env.HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS,
    },
  };
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
