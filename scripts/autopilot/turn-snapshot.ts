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
 *     --collectors pr-gate --format kv [--gh-list-limit N] [--exports-file PATH]
 *
 *   --collectors LIST      comma-separated, run and printed in the given order:
 *                          pr-gate            in-flight PRs + PR-gate (slice 1)
 *                          orch-board         orch board counts + needs-triage
 *                                             items (slice 2)
 *                          untriaged-orphans  the orphan backstop count (slice 2)
 *                          needs-qa           the ordered needs-qa numbers (slice 2)
 *   --format kv            today's `key=value` wire (the only format until slice 6)
 *   --gh-list-limit N      `gh … --limit` page size (collect-state.sh passes
 *                          its GH_ISSUE_LIST_LIMIT); default 100
 *   --exports-file PATH    also write the globals the still-bash consumers
 *                          need as `NAME=value` lines for collect-state.sh to
 *                          read back: the in-flight sets (`ORCH_INFLIGHT_*`,
 *                          pr-gate) and the board-state reading
 *                          (`ORCH_BOARD_DEGRADED`, `BOARD_STATE_*`, orch-board)
 *
 * FAIL-OPEN: the CLI never crashes the turn. A collector that throws is
 * reported as a stderr note and rendered as the fully-degraded fallback (the
 * same lines the bash printed when every read failed); exit 0. Only a usage
 * error exits non-zero (2) — collect-state.sh then prints its own fallback.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  collectPrGate,
  prGateFallbackSnapshot,
  PR_GATE_COLLECTOR,
  type PrGateDeps,
  type PrGateSnapshot,
} from "../../src/autopilot/turn-snapshot/pr-gate.ts";
import { createTurnSnapshotGithub } from "../../src/autopilot/turn-snapshot/github-port.ts";
import { renderInflightExports, renderPrGateKv } from "../../src/autopilot/turn-snapshot/render-kv.ts";
import {
  collectNeedsQaNumbers,
  collectOrchBoard,
  collectUntriagedOrphans,
  NEEDS_QA_COLLECTOR,
  ORCH_BOARD_COLLECTOR,
  orchBoardFallbackSnapshot,
  UNTRIAGED_ORPHANS_COLLECTOR,
} from "../../src/autopilot/turn-snapshot/orch-board.ts";
import { createTurnSnapshotHydra, type TurnSnapshotHydra } from "../../src/autopilot/turn-snapshot/hydra-http.ts";
import {
  renderNeedsQaNumbersKv,
  renderOrchBoardExports,
  renderOrchBoardKv,
  renderUntriagedOrphansKv,
} from "../../src/autopilot/turn-snapshot/render-kv.ts";

export interface CliArgs {
  collectors: string[];
  format: string;
  ghListLimit: number;
  exportsFile: string | null;
}

const KNOWN_COLLECTORS = new Set([PR_GATE_COLLECTOR, ORCH_BOARD_COLLECTOR, UNTRIAGED_ORPHANS_COLLECTOR, NEEDS_QA_COLLECTOR]);
const DEFAULT_GH_LIST_LIMIT = 100;

/** Parse argv; returns an error string on a usage error. */
export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = { collectors: [], format: "kv", ghListLimit: DEFAULT_GH_LIST_LIMIT, exportsFile: null };
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
    else return { error: `unknown flag ${flag}` };
  }
  if (args.collectors.length === 0) return { error: "--collectors is required" };
  const unknown = args.collectors.filter((c) => !KNOWN_COLLECTORS.has(c));
  if (unknown.length > 0) return { error: `unknown collector(s): ${unknown.join(",")}` };
  if (args.format !== "kv") return { error: `unsupported --format ${args.format} (only kv until ADR-0043 slice 6)` };
  return args;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  writeFile(path: string, text: string): void;
}

/** Everything the CLI needs besides argv — production values come from {@link productionDeps}. */
export type CliDeps = Omit<PrGateDeps, "ghListLimit"> & {
  /** The hydra HTTP adapter (slice 2's orch-board read). Defaults to the production `hydra` CLI adapter. */
  hydra?: TurnSnapshotHydra;
};

/** One collector's rendered output: kv lines for stdout, `NAME=value` lines for the exports file. */
interface Rendered {
  kv: string;
  exports: string;
}

/** Run one collector and render it; a throw becomes a stderr note plus that collector's fully-degraded fallback. */
async function runCollector(name: string, deps: CliDeps, ghListLimit: number, io: CliIo): Promise<Rendered> {
  const crashed = (err: unknown) => {
    /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`orch turn-snapshot ${name} collector crashed (${msg}) — emitting the fail-open ${name} fallback (issue #4930)\n`);
  };
  const emitNotes = (notes: readonly string[]) => {
    for (const note of notes) io.stderr(`${note}\n`);
  };
  if (name === ORCH_BOARD_COLLECTOR) {
    let snapshot = orchBoardFallbackSnapshot("collector-crashed");
    try {
      const outcome = await collectOrchBoard({ github: deps.github, hydra: deps.hydra ?? createTurnSnapshotHydra(), now: deps.now, ghListLimit });
      emitNotes(outcome.notes);
      snapshot = outcome.value;
    } catch (err) {
      crashed(err);
    }
    return { kv: renderOrchBoardKv(snapshot), exports: renderOrchBoardExports(snapshot) };
  }
  if (name === UNTRIAGED_ORPHANS_COLLECTOR) {
    try {
      const outcome = await collectUntriagedOrphans({ github: deps.github, ghListLimit });
      emitNotes(outcome.notes);
      return { kv: renderUntriagedOrphansKv(outcome.value), exports: "" };
    } catch (err) {
      crashed(err);
      return { kv: renderUntriagedOrphansKv({ ok: false, reason: "collector-crashed" }), exports: "" };
    }
  }
  if (name === NEEDS_QA_COLLECTOR) {
    try {
      const outcome = await collectNeedsQaNumbers({ github: deps.github, ghListLimit });
      emitNotes(outcome.notes);
      return { kv: renderNeedsQaNumbersKv(outcome.value), exports: "" };
    } catch (err) {
      crashed(err);
      return { kv: renderNeedsQaNumbersKv({ ok: false, reason: "collector-crashed" }), exports: "" };
    }
  }
  return runPrGate(deps, ghListLimit, io);
}

/** The slice-1 pr-gate collector, rendered (its crash note keeps the slice-1 wording). */
async function runPrGate(deps: CliDeps, ghListLimit: number, io: CliIo): Promise<Rendered> {
  let snapshot: PrGateSnapshot;
  try {
    const outcome = await collectPrGate({ ...deps, ghListLimit });
    for (const note of outcome.notes) io.stderr(`${note}\n`);
    snapshot = outcome.value;
  } catch (err) {
    /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`orch turn-snapshot pr-gate collector crashed (${msg}) — emitting the fail-open PR-gate fallback (issue #4929)\n`);
    snapshot = prGateFallbackSnapshot("collector-crashed");
  }
  return { kv: renderPrGateKv(snapshot), exports: renderInflightExports(snapshot.inflight) };
}

/** Run the CLI. Returns the exit code; never throws. */
export async function main(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.stderr(`turn-snapshot: ${args.error}\n`);
    return 2;
  }
  const rendered: Rendered[] = [];
  for (const name of args.collectors) rendered.push(await runCollector(name, deps, args.ghListLimit, io));
  if (args.exportsFile !== null) {
    try {
      io.writeFile(args.exportsFile, rendered.map((r) => r.exports).join(""));
    } catch (err) {
      /* intentional: reported as a stderr note via io.stderr; the kv lines still print */
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`orch turn-snapshot could not write the in-flight exports file (${msg}) — in-flight sets read as empty (issue #4929)\n`);
    }
  }
  io.stdout(rendered.map((r) => r.kv).join(""));
  return 0;
}

/** The production deps: the real gh port + hydra adapter, wall clock, real sleep, HYDRA_ORCH_* windows. */
export function productionDeps(): CliDeps {
  return {
    github: createTurnSnapshotGithub(),
    hydra: createTurnSnapshotHydra(),
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
  };
  const code = await main(process.argv.slice(2), productionDeps(), io);
  // Flush stdout, then exit hard: the gh seam's rate-limit gate may hold a
  // lazily-opened Redis handle that would otherwise keep the process alive.
  process.stdout.write(out.join(""), () => process.exit(code));
}
