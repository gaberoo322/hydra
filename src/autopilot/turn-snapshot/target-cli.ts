/**
 * turn-snapshot/target-cli.ts — the Target-board family's slot in the
 * one-shot Turn Snapshot CLI (ADR-0043 slice 4, issue #4932).
 *
 * `scripts/autopilot/turn-snapshot.ts` stays a thin argv shell; this module
 * runs a consecutive run of Target collectors IN THE ORDER GIVEN, returns
 * their typed values, reports their notes, and owns their fail-open crash
 * arm. The Target deps are a lazily-built factory so a pr-gate-only
 * invocation never resolves the Target realm (src/target-config.ts) at all.
 *
 *   target-board          counts / in-flight exclusion / WIP / needs-qa PR /
 *                         dev-resume pick; its `laneDegraded` feeds the
 *                         scan-board call
 *   target-scan-boards    takes the lane-degraded accumulator and the
 *                         work-queue depth (`--target-lane-degraded 0|1`,
 *                         `--target-work-queue N` when run alone)
 *   target-risk-surface   the Target Manifest risk surface
 */

import { InvariantViolationError } from "../../errors.ts";
import type { CollectorOutcome, DegradedMarker } from "./collector.ts";
import type { TurnSnapshotGithub } from "./github-port.ts";
import type { TurnSnapshotHydra } from "./hydra-http.ts";
import type { PrRefsAvailability } from "./pr-gate.ts";
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
  /** Epoch milliseconds — the board collector's degraded-arm `deriveBoardState` clock. */
  readonly now: () => number;
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

/** Each Target collector's typed value (the JSON Turn Snapshot is built from these, ADR-0043 slice 6). */
export interface TargetValues {
  targetBoard?: TargetBoardSnapshot;
  targetScan?: TargetScanSnapshot;
  targetRiskSurface?: TargetRiskSurfaceSnapshot;
}

/** A run's output: the typed values and their degraded markers. */
export interface TargetCliOutput {
  readonly values: TargetValues;
  /** Every degraded field the run's collectors reported (a crash is one `collector-crashed` marker), attributed by collector. */
  readonly degraded: readonly (DegradedMarker & { readonly collector: string })[];
}

/** True for a Target-board family collector name. */
export function isTargetCollector(name: string): boolean {
  return TARGET_COLLECTORS.includes(name);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Run one collector; a throw becomes a stderr note and the fallback snapshot. Its degraded markers go to `sink`. */
async function guarded<T>(
  name: string,
  io: TargetCliIo,
  run: () => Promise<CollectorOutcome<T>>,
  fallback: () => T,
  sink: (DegradedMarker & { readonly collector: string })[],
): Promise<T> {
  try {
    const outcome = await run();
    for (const note of outcome.notes) io.stderr(`${note}\n`);
    sink.push(...outcome.degraded.map((d) => ({ collector: name, ...d })));
    return outcome.value;
  } catch (err) {
    /* intentional: fail-open — the crash is reported as a stderr note via io.stderr, a collector-crashed marker, and the fallback renders */
    io.stderr(`target turn-snapshot ${name} collector crashed (${errMsg(err)}) — emitting its fail-closed fallback (issue #4932)\n`);
    sink.push({ collector: name, field: name, reason: "collector-crashed" });
    return fallback();
  }
}

/**
 * Run the given Target collectors in order. Never throws: an unwired deps
 * factory surfaces inside each collector's crash arm.
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

  const values: TargetValues = {};
  const degraded: (DegradedMarker & { readonly collector: string })[] = [];
  for (const collector of names) {
    if (collector === TARGET_BOARD_COLLECTOR) {
      const s: TargetBoardSnapshot = await guarded(
        collector,
        io,
        () => {
          const d = getDeps();
          return collectTargetBoard({ github: d.github, hydra: d.hydra, now: d.now, ghListLimit: args.ghListLimit, prRefs: d.prRefs });
        },
        () => targetBoardFallbackSnapshot("collector-crashed"),
        degraded,
      );
      values.targetBoard = s;
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
        degraded,
      );
      values.targetScan = s;
    } else if (collector === TARGET_RISK_SURFACE_COLLECTOR) {
      const s: TargetRiskSurfaceSnapshot = await guarded(
        collector,
        io,
        () => collectTargetRiskSurface({ facts: () => getDeps().facts() }),
        () => ({ manifest: { ok: false, reason: "collector crashed" } }),
        degraded,
      );
      values.targetRiskSurface = s;
    }
  }
  return { values, degraded };
}
