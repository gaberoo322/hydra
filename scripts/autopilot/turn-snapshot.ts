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
 *   --collectors pr-gate   the in-flight PR + PR-gate collector (slice 1)
 *   --collectors <a,b,…>   passthrough collectors (slice 5, #4933), emitted in
 *                          the order given: health, direction-drift,
 *                          scout-alerts, realm-share, usage-eligibility,
 *                          emergency-brake, class-stats, capacity, scheduler,
 *                          recommendations, slot-events (not mixable with pr-gate)
 *   --format kv            today's `key=value` wire (the only format until slice 6)
 *   --gh-list-limit N      `gh … --limit` page size (collect-state.sh passes
 *                          its GH_ISSUE_LIST_LIMIT); default 100
 *   --exports-file PATH    also write the in-flight sets as `ORCH_INFLIGHT_*=…`
 *                          lines for collect-state.sh to read back into its
 *                          globals (the still-bash consumers need them)
 *
 * FAIL-OPEN: the CLI never crashes the turn. A collector that throws is
 * reported as a stderr note and rendered as the fully-degraded fallback (the
 * same lines the bash printed when every read failed); exit 0. Only a usage
 * error exits non-zero (2) — collect-state.sh then prints its own fallback.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  isPassthroughCollector,
  PASSTHROUGH_COLLECTORS,
  runPassthroughCollectors,
  type PassthroughDeps,
} from "../../src/autopilot/turn-snapshot/passthrough.ts";
import { createTurnSnapshotHydraHttp } from "../../src/autopilot/turn-snapshot/hydra-http.ts";
import { createTurnSnapshotHost } from "../../src/autopilot/turn-snapshot/host-port.ts";
import { getTargetWorkspace } from "../../src/target-config.ts";

export interface CliArgs {
  collectors: string[];
  format: string;
  ghListLimit: number;
  exportsFile: string | null;
}

const KNOWN_COLLECTORS = new Set([PR_GATE_COLLECTOR, ...Object.keys(PASSTHROUGH_COLLECTORS)]);
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
  if (args.collectors.some(isPassthroughCollector) && !args.collectors.every(isPassthroughCollector)) {
    return { error: "passthrough collectors cannot be combined with pr-gate in one run" };
  }
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
  /** The passthrough collectors' deps (slice 5); absent → those collectors are a usage error. */
  passthrough?: PassthroughDeps;
};

/** Run the CLI. Returns the exit code; never throws. */
export async function main(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.stderr(`turn-snapshot: ${args.error}\n`);
    return 2;
  }
  if (args.collectors.every(isPassthroughCollector)) {
    if (deps.passthrough === undefined) {
      io.stderr("turn-snapshot: passthrough collectors need passthrough deps\n");
      return 2;
    }
    const run = await runPassthroughCollectors(args.collectors, deps.passthrough);
    for (const note of run.notes) io.stderr(`${note}\n`);
    io.stdout(run.stdout);
    return 0;
  }
  let snapshot: PrGateSnapshot;
  try {
    const outcome = await collectPrGate({ ...deps, ghListLimit: args.ghListLimit });
    for (const note of outcome.notes) io.stderr(`${note}\n`);
    snapshot = outcome.value;
  } catch (err) {
    /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`orch turn-snapshot pr-gate collector crashed (${msg}) — emitting the fail-open PR-gate fallback (issue #4929)\n`);
    snapshot = prGateFallbackSnapshot("collector-crashed");
  }
  if (args.exportsFile !== null) {
    try {
      io.writeFile(args.exportsFile, renderInflightExports(snapshot.inflight));
    } catch (err) {
      /* intentional: reported as a stderr note via io.stderr; the kv lines still print */
      const msg = err instanceof Error ? err.message : String(err);
      io.stderr(`orch turn-snapshot could not write the in-flight exports file (${msg}) — in-flight sets read as empty (issue #4929)\n`);
    }
  }
  io.stdout(renderPrGateKv(snapshot));
  return 0;
}

/** The production deps: the real gh port, wall clock, real sleep, HYDRA_ORCH_* windows. */
export function productionDeps(): CliDeps {
  return {
    github: createTurnSnapshotGithub(),
    now: () => Date.now(),
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0)),
    env: {
      uncheckedGraceSeconds: process.env.HYDRA_ORCH_PR_UNCHECKED_GRACE_SECONDS,
      glmRedQuiescenceSeconds: process.env.HYDRA_ORCH_GLM_RED_QUIESCENCE_SECONDS,
      unknownRepollDelaySeconds: process.env.HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS,
    },
    passthrough: {
      hydra: createTurnSnapshotHydraHttp({ baseUrl: process.env.HYDRA_BASE_URL }),
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
  };
  const code = await main(process.argv.slice(2), productionDeps(), io);
  // Flush stdout, then exit hard: the gh seam's rate-limit gate may hold a
  // lazily-opened Redis handle that would otherwise keep the process alive.
  process.stdout.write(out.join(""), () => process.exit(code));
}
