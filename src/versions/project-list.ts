/**
 * versions/project-list — the env-derived roster of repositories the
 * `GET /api/versions` read iterates (issue #3680, epic #3676 delta).
 *
 * WHAT THIS OWNS
 *   One shallow question: "which checkouts have a version stream, and where do
 *   they live on disk?" It answers with a typed array so the wire response is
 *   array-shaped (N-capable) without any policy leaking in — the tag reading,
 *   caching, note folding, and #4172's tagless-Target commit-identity read all
 *   live in the sibling `read-versions.ts`.
 *
 * SCOPE IS THE MACHINE IDENTITY
 *   Each row carries `scope: "orch" | "target"` — the canonical alphabet the
 *   rest of the system already speaks (`DesignConceptScope`, the `scope` column
 *   in `scripts/autopilot/classes.json`, `HYDRA_AUTOPILOT_SCOPE`). Consumers
 *   discriminate on `scope`, never on the human-facing `name`. That includes
 *   `read-versions.ts`: `scope` is what routes a TAGLESS entry to either the
 *   orch "no releases yet" empty state or the Target's commit identity (#4172).
 *
 * ADR-0002 IS NOT WEAKENED
 *   This is built ON TOP OF the existing single-string helpers — `HYDRA_ROOT`
 *   for the Orchestrator, `getTargetWorkspace()` / `getTargetName()` for the
 *   Target. `src/target-config.ts` is deliberately NOT generalised into an
 *   N-target registry: ADR-0002 pins one Target per Orchestrator. "N-capable"
 *   here means the WIRE SHAPE is an array, not that a second Target is
 *   configurable.
 *
 * Env is read at CALL time (not module load) so a test can point either root at
 * a fixture checkout without re-importing the module.
 */

import os from "node:os";
import path from "node:path";

import { getTargetName, getTargetWorkspace } from "../target-config.ts";

/**
 * The machine identity of a version stream. Mirrors the canonical scope
 * alphabet used by the design-concept store and the dispatch-class taxonomy.
 */
export type VersionProjectScope = "orch" | "target";

/** One repository with a version stream. */
export interface VersionProject {
  /** Human-facing label (the checkout's directory name / target slug). */
  readonly name: string;
  /** The machine discriminant consumers switch on. */
  readonly scope: VersionProjectScope;
  /** Absolute path to the git repo root that owns the tags. */
  readonly root: string;
}

/**
 * Absolute path to the Orchestrator checkout. Mirrors the `HYDRA_ROOT` read in
 * `src/health/deployed-sha.ts` / `deployed-version.ts`, but resolved per call so
 * it stays testable.
 */
export function orchestratorRoot(): string {
  const raw = process.env.HYDRA_ROOT;
  if (raw && raw.trim()) return raw.trim();
  return path.resolve(os.homedir(), "hydra");
}

/**
 * The roster the versions read iterates: the Orchestrator itself, then the one
 * configured Target. Pure env projection — no I/O, no git, never throws.
 */
export function listVersionProjects(): VersionProject[] {
  const root = orchestratorRoot();
  return [
    { name: path.basename(root), scope: "orch", root },
    { name: getTargetName(), scope: "target", root: getTargetWorkspace() },
  ];
}
