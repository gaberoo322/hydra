/**
 * target-config — single source of truth for the orchestrator's Target Project paths.
 *
 * Per ADR-0002 ("one target per orchestrator instance"), one orchestrator process
 * builds exactly one target. The operator switches targets by editing two env vars
 * and restarting the service:
 *
 *   - HYDRA_PROJECT_WORKSPACE — absolute path to the target workspace
 *   - HYDRA_TARGET_NAME       — short slug (drives systemd unit + worktree prefix)
 *
 * Multi-target abstractions are explicitly out of scope; every helper here returns
 * a single string. See `docs/reference.md` ("ADR-0002 target swap") for the full
 * env-var contract and `docs/adr/0002-single-target-per-orchestrator-instance.md`
 * for the architectural rationale.
 *
 * This module is leaf-level: it imports only from `node:` and must not import from
 * anywhere in `src/`. It memoizes the deprecation warnings so each one fires at
 * most once per process.
 */

import path from "node:path";
import os from "node:os";

const DEFAULT_TARGET_NAME = "hydra-betting";

// Module-level memoization for one-time warnings. Booleans (not Map) per ADR-0002
// guidance — keep this leaf module deliberately minimal.
let warned = { name: false, workspace: false, legacy: false };

/**
 * Returns the target name slug (e.g. `hydra-betting`).
 *
 * Reads `HYDRA_TARGET_NAME`. Empty string is treated as unset. Falls back to
 * `"hydra-betting"` with a one-time `console.warn` so deployments without the
 * env var keep running while the operator migrates.
 */
export function getTargetName(): string {
  const raw = process.env.HYDRA_TARGET_NAME;
  if (raw && raw.trim()) return raw.trim();
  if (!warned.name) {
    warned.name = true;
    console.warn(
      `[target-config] HYDRA_TARGET_NAME is unset; falling back to "${DEFAULT_TARGET_NAME}". Set HYDRA_TARGET_NAME explicitly (ADR-0002).`,
    );
  }
  return DEFAULT_TARGET_NAME;
}

/**
 * Returns the absolute path to the target project workspace.
 *
 * Resolution order:
 *   1. `HYDRA_PROJECT_WORKSPACE` (canonical)
 *   2. `HYDRA_WORKSPACE` (legacy alias — emits one-time deprecation warning; removed in #259)
 *   3. `<homedir>/<getTargetName()>` (soft fallback with one-time warning)
 *
 * Empty string env values are treated as unset.
 */
export function getTargetWorkspace(): string {
  const canonical = process.env.HYDRA_PROJECT_WORKSPACE;
  if (canonical && canonical.trim()) return canonical.trim();

  const legacy = process.env.HYDRA_WORKSPACE;
  if (legacy && legacy.trim()) {
    if (!warned.legacy) {
      warned.legacy = true;
      console.warn(
        `[target-config] HYDRA_WORKSPACE is deprecated; rename to HYDRA_PROJECT_WORKSPACE. The legacy alias will be removed in #259.`,
      );
    }
    return legacy.trim();
  }

  if (!warned.workspace) {
    warned.workspace = true;
    console.warn(
      `[target-config] HYDRA_PROJECT_WORKSPACE is unset; falling back to "<homedir>/<targetName>". Set HYDRA_PROJECT_WORKSPACE explicitly (ADR-0002).`,
    );
  }
  return path.resolve(os.homedir(), getTargetName());
}

/**
 * Returns the systemd unit name for the target project's web service,
 * e.g. `hydra-betting-web.service`. Derived from `getTargetName()`.
 */
export function getTargetServiceName(): string {
  return `${getTargetName()}-web.service`;
}

/**
 * Returns the directory-name prefix for per-cycle git worktrees,
 * e.g. `hydra-betting-worktree`. Derived from `getTargetName()`.
 */
export function getTargetWorktreePrefix(): string {
  return `${getTargetName()}-worktree`;
}

/**
 * Test-only: reset the one-time warning flags so each test can assert
 * warning behavior in isolation. Not for production use.
 */
export function __resetForTests(): void {
  warned = { name: false, workspace: false, legacy: false };
}
