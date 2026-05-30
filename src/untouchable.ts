/**
 * Verifier Core — the self-referential paths that classify as T4, the
 * deepest Modification Tier (ADR-0001 / ADR-0004 / ADR-0015).
 *
 * The Verifier Core is the set of files that define and enforce the
 * verification machinery itself: the CI workflows, the deploy workflow,
 * the tier classifier, the tier-classify CLI wrapper, and this
 * protected-paths list. A change to one of these alters how every other
 * change is verified, so it carries the most verification depth (T4) and,
 * under the current gate, still requires the `operator-approved` GitHub
 * label. The `tier-gate` CI job in `.github/workflows/ci.yml` enforces
 * this; merging without the label requires admin override (operator-only).
 *
 * Renumbering note (ADR-0015 / issue #737): the tiers were renumbered to
 * the monotonic ladder T1 (shallowest) → T4 (deepest). The Verifier Core
 * is the deepest tier (T4), replacing the former non-monotonic "Tier 0".
 * The term "Untouchable Core" was retired in favour of "Verifier Core".
 * The membership shrank from 11 entries to the 5 self-referential files;
 * the six former members (`src/grounding.ts`, `src/cost/`, the three
 * watchdog scripts, `scripts/deploy.sh`) now classify as T3.
 *
 * Matching rules (deliberately dumb and auditable — no globs):
 *   - Exact match: `path === entry`
 *   - Directory prefix: `path === entry + "/<...>"` when `entry` ends in `/`
 *
 * Adding/removing entries from `VERIFIER_CORE_PATHS` is itself a T4
 * change (this file is in the list), so any modification requires
 * operator approval.
 *
 * Source: ADR-0001 (gate extraction) + ADR-0004 (tiers) + ADR-0015
 * (verification depth; T1–T4 monotonic ladder; Verifier Core rename).
 */

/**
 * Canonical Verifier Core path list — the 5 self-referential files that
 * classify as T4 (the deepest tier). Order is illustrative; matching is
 * exact/prefix.
 */
export const VERIFIER_CORE_PATHS: readonly string[] = Object.freeze([
  // CI/CD workflows — the gate that gates the gate, and the deploy
  // workflow it triggers.
  ".github/workflows/ci.yml",
  ".github/workflows/deploy.yml",

  // CLI wrapper for the tier classifier. Bypassing the wrapper bypasses
  // the gate, so it's part of the Verifier Core itself.
  "scripts/tier-classify.ts",

  // The protected-paths list and its classifier — the verification
  // machinery that protects itself. Self-referential by design (the fix
  // from issue #243): the classifier must classify itself as the deepest
  // tier so it can't be edited without operator review.
  "src/tier-classifier.ts",
  "src/untouchable.ts",
]);

/**
 * Returns true if `path` is in the Verifier Core (the T4 deepest tier).
 *
 * Path matching is intentionally simple:
 *   1. Normalize leading "./" away.
 *   2. Exact match against any entry.
 *   3. If an entry ends with "/", prefix match (treat entry as a directory).
 *
 * The six former-Tier-0 paths (`src/grounding.ts`, `src/cost/`, the three
 * watchdog scripts, `scripts/deploy.sh`) are no longer in the Verifier
 * Core — they classify as T3 (operator review default) per ADR-0015.
 */
export function isVerifierCore(path: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/^\.\//, "");
  for (const entry of VERIFIER_CORE_PATHS) {
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

/** First matched entry, for diagnostic messages. Returns null if not T4. */
export function matchVerifierCore(path: string): string | null {
  if (!path) return null;
  const normalized = path.replace(/^\.\//, "");
  for (const entry of VERIFIER_CORE_PATHS) {
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
