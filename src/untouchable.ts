/**
 * Untouchable Core — operator-only paths (ADR-0001 / ADR-0004 Tier 0).
 *
 * Any PR touching one of these paths must carry the `operator-approved`
 * GitHub label. The `tier-gate` CI job in `.github/workflows/ci.yml`
 * enforces this; merging without the label requires admin override
 * (which only the operator can do).
 *
 * Matching rules (deliberately dumb and auditable — no globs):
 *   - Exact match: `path === entry`
 *   - Directory prefix: `path === entry + "/<...>"` when `entry` ends in `/`
 *
 * Adding/removing entries from `UNTOUCHABLE_PATHS` is itself a Tier-0
 * change (this file is in the list), so any modification requires
 * operator approval.
 *
 * Source: ADR-0001 (Untouchable Core) + ADR-0004 (work-order step 3).
 */

/** Canonical Tier-0 path list. Order is illustrative; matching is exact/prefix. */
export const UNTOUCHABLE_PATHS: readonly string[] = Object.freeze([
  // Inputs to the merge gate — grounding stays read-only.
  // (gate.ts / verification.ts / post-merge.ts / control-loop.ts were
  // removed in PR-3 (issue #383) along with the entire in-process codex
  // control loop. CI quality gates (#382) now own scope/mutation
  // enforcement; the merge gate moved out-of-process to PR review +
  // branch protection.)
  "src/grounding.ts",

  // State contract — the adapter every Redis access funnels through.
  "src/redis-adapter.ts",

  // Cost guardrails — the $50/day cap referenced in operator vision.
  "src/cost-cap.ts",

  // CI/CD scripts and workflows — the deploy path and the gate that
  // gates the gate.
  "scripts/deploy.sh",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",

  // CLI wrapper for the tier classifier. Bypassing the wrapper bypasses
  // the gate, so it's Tier 0 itself.
  "scripts/tier-classify.ts",

  // The Untouchable Core list and its classifier — the protected-paths
  // list itself is operator-only per ADR-0001.
  "src/untouchable.ts",
  "src/tier-classifier.ts",
]);

/**
 * Returns true if `path` is in the Untouchable Core.
 *
 * Path matching is intentionally simple:
 *   1. Normalize leading "./" away.
 *   2. Exact match against any entry.
 *   3. If an entry ends with "/", prefix match (treat entry as a directory).
 *
 * Out-of-repo paths (e.g. `~/.local/bin/hydra-orchestrator-watchdog.sh`)
 * are documented in `docs/reference.md` rather than listed here, since
 * `gh pr diff` will never surface them.
 */
export function isUntouchable(path: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/^\.\//, "");
  for (const entry of UNTOUCHABLE_PATHS) {
    if (entry.endsWith("/")) {
      if (normalized === entry.slice(0, -1) || normalized.startsWith(entry)) {
        return true;
      }
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}

/** First matched entry, for diagnostic messages. Returns null if not Tier 0. */
export function matchUntouchable(path: string): string | null {
  if (!path) return null;
  const normalized = path.replace(/^\.\//, "");
  for (const entry of UNTOUCHABLE_PATHS) {
    if (entry.endsWith("/")) {
      if (normalized === entry.slice(0, -1) || normalized.startsWith(entry)) {
        return entry;
      }
    } else if (normalized === entry) {
      return entry;
    }
  }
  return null;
}
