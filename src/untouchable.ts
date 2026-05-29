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

  // (`src/redis-adapter.ts` was previously listed here as the canonical
  // Redis seam. It was retired in the ADR-0009 closure — the typed
  // accessors in `src/redis/<domain>.ts` are now the contract, and the
  // legacy shim is deleted. No single file funnels Redis access anymore.)

  // Cost guardrails — the **Cost** Module. The dollar-based per-cycle
  // and daily-spend caps were retired (codex-era circuit breakers,
  // ADR-0006), but the Subscription Usage Tracker (`usage-tracker.ts`)
  // is now the quota guardrail — same role, real Anthropic-quota
  // signal. Whole Module is Tier 0 (mirrors the `src/redis/` pattern);
  // the directory-prefix matcher already handles `src/cost/`.
  "src/cost/",

  // CI/CD scripts and workflows — the deploy path and the gate that
  // gates the gate.
  "scripts/deploy.sh",
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",

  // CLI wrapper for the tier classifier. Bypassing the wrapper bypasses
  // the gate, so it's Tier 0 itself.
  "scripts/tier-classify.ts",

  // Watchdogs — the live recovery mechanism. ADR-0001 names the watchdog as
  // Untouchable Core, but the in-repo source scripts were ABSENT from this
  // list, so the tier-gate never actually guarded edits to them (the
  // ADR-0001-vs-CI gap closed in issue #705). The consolidated
  // `hydra-watchdog.sh` is the deploy artifact; the two legacy source
  // scripts are kept for the regression test + transitional deploy. All
  // three are Tier 0.
  "scripts/hydra-watchdog.sh",
  "scripts/hydra-orchestrator-watchdog.sh",
  "scripts/hydra-autopilot-watchdog.sh",

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
 * Out-of-repo paths (e.g. `~/.local/bin/hydra-watchdog.sh`) are documented
 * in `docs/reference.md` rather than listed here, since `gh pr diff` will
 * never surface them. The in-repo source scripts ARE listed above (issue
 * #705) so the tier-gate guards the source of truth.
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
