/**
 * turn-snapshot/target-cli.ts — the Target-board family's slot in the
 * one-shot Turn Snapshot CLI (ADR-0043 slice 4, issue #4932).
 *
 * `scripts/autopilot/turn-snapshot.ts` stays a thin argv shell; this module
 * runs a consecutive run of Target collectors IN THE ORDER GIVEN, renders
 * their kv lines + exports, reports their notes, and owns their fail-open
 * crash arm. The Target deps are a
 * lazily-built factory so a pr-gate-only invocation never resolves the
 * Target realm (src/target-config.ts) at all.
 *
 *   target-board          counts / in-flight exclusion / WIP / needs-qa PR /
 *                         dev-resume pick; `--exports-file` gets
 *                         `TARGET_LANE_DEGRADED=0|1` for the scan-board call
 *   target-scan-boards    takes `--target-lane-degraded 0|1` and
 *                         `--target-work-queue N` from collect-state.sh
 *   target-risk-surface   the Target Manifest risk surface line
 */

import { InvariantViolationError } from "../../errors.ts";
import type { CollectorOutcome } from "./collector.ts";
import type { TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import type { PrRefsAvailability } from "./pr-gate.ts";
import {
  renderTargetBoardExports,
  renderTargetBoardKv,
  renderTargetRiskSurfaceKv,
  renderTargetScanKv,
} from "./render-kv.ts";
import { collectTargetBoard, targetBoardFallbackSnapshot, TARGET_BOARD_COLLECTOR, type TargetBoardSnapshot } from "./target-board.ts";
import {
  collectTargetRiskSurface,
  TARGET_RISK_SURFACE_COLLECTOR,
  type TargetRiskSurfaceSnapshot,
} from "./target-risk-surface.ts";
import {
  collectTargetScanBoards,
  targetScanFallbackSnapshot,
  TARGET_SCAN_BOARDS_COLLECTOR,
  type TargetScanSnapshot,
} from "./target-scan-boards.ts";

export const TARGET_COLLECTORS: readonly string[] = [TARGET_BOARD_COLLECTOR, TARGET_SCAN_BOARDS_COLLECTOR, TARGET_RISK_SURFACE_COLLECTOR];

/** What the Target collectors need — production values come from the CLI's factory. */
export interface TargetCliDeps {
  /** The `TurnSnapshotGithub` port built against the TARGET repo. */
  readonly github: TurnSnapshotGithub;
  readonly hydra: Pick<TurnSnapshotHydra, "targetBoardState">;
  /** The Target workspace (`HYDRA_TARGET_REPO`, else the seam's workspace). */
  readonly workspace: () => string;
  /** The Target facts (print-target-facts.ts's `collectTargetFacts`). */
  readonly facts: () => unknown;
  readonly prRefs?: PrRefsAvailability;
  readonly adrPresent?: (workspace: string) => boolean;
}

export interface TargetCliArgs {
  readonly ghListLimit: number;
  readonly targetLaneDegraded?: boolean;
  readonly targetWorkQueue?: number;
}

export interface TargetCliIo {
  stderr(text: string): void;
}

/** A run's rendered output: the kv lines and the `--exports-file` shell assignments. */
export interface TargetCliOutput {
  readonly kv: string;
  readonly exports: string;
}

/** True for a Target-board family collector name. */
export function isTargetCollector(name: string): boolean {
  return TARGET_COLLECTORS.includes(name);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Run one collector; a throw becomes a stderr note and the fallback snapshot. */
async function guarded<T>(name: string, io: TargetCliIo, run: () => Promise<CollectorOutcome<T>>, fallback: () => T): Promise<T> {
  try {
    const outcome = await run();
    for (const note of outcome.notes) io.stderr(`${note}\n`);
    return outcome.value;
  } catch (err) {
    /* intentional: fail-open — the crash is reported as a stderr note via io.stderr and the fallback renders */
    io.stderr(`target turn-snapshot ${name} collector crashed (${errMsg(err)}) — emitting its fail-closed fallback (issue #4932)\n`);
    return fallback();
  }
}

/**
 * Run the given Target collectors in order and render them. Never throws: an
 * unwired deps factory surfaces inside each collector's crash arm.
 * target-board contributes `TARGET_LANE_DEGRADED=0|1` to the exports.
 */
export async function runTargetCollectors(
  names: readonly string[],
  args: TargetCliArgs,
  depsFactory: (() => TargetCliDeps) | undefined,
  io: TargetCliIo,
): Promise<TargetCliOutput> {
  let deps: TargetCliDeps | null = null;
  const getDeps = (): TargetCliDeps => {
    if (deps !== null) return deps;
    if (depsFactory === undefined) throw new InvariantViolationError("no Target deps wired into the turn-snapshot CLI");
    deps = depsFactory();
    return deps;
  };

  let kv = "";
  let exportsText = "";
  for (const collector of names) {
    if (collector === TARGET_BOARD_COLLECTOR) {
      const s: TargetBoardSnapshot = await guarded(
        collector,
        io,
        () => {
          const d = getDeps();
          return collectTargetBoard({ github: d.github, hydra: d.hydra, ghListLimit: args.ghListLimit, prRefs: d.prRefs });
        },
        () => targetBoardFallbackSnapshot("collector-crashed"),
      );
      exportsText += renderTargetBoardExports(s);
      kv += renderTargetBoardKv(s);
    } else if (collector === TARGET_SCAN_BOARDS_COLLECTOR) {
      const s: TargetScanSnapshot = await guarded(
        collector,
        io,
        () => {
          const d = getDeps();
          return collectTargetScanBoards({
            github: d.github,
            ghListLimit: args.ghListLimit,
            laneDegraded: args.targetLaneDegraded ?? false,
            workQueue: args.targetWorkQueue ?? 0,
            workspace: d.workspace(),
            adrPresent: d.adrPresent,
          });
        },
        () => targetScanFallbackSnapshot("collector-crashed"),
      );
      kv += renderTargetScanKv(s);
    } else if (collector === TARGET_RISK_SURFACE_COLLECTOR) {
      const s: TargetRiskSurfaceSnapshot = await guarded(
        collector,
        io,
        () => collectTargetRiskSurface({ facts: () => getDeps().facts() }),
        () => ({ manifest: { ok: false, reason: "collector crashed" } }),
      );
      kv += renderTargetRiskSurfaceKv(s);
    }
  }
  return { kv, exports: exportsText };
}
