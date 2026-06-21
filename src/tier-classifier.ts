/**
 * Modification Tier classifier (ADR-0004 / ADR-0015 work-order step 3).
 *
 * Classifies a set of changed files into one of four tiers on the
 * monotonic ladder T1 (shallowest) → T4 (deepest). Tiers ascend with
 * blast radius, so the deepest tier (T4) carries the most verification.
 * The tier controls merge policy:
 *   - T1: Auto-merge, no holdback. Prompt-shaped changes
 *     (`config/agents/`, `config/feedback/`). Shallowest blast radius.
 *   - T2: Auto-merge with outcome holdback. Skills, anchor weights,
 *     additive verification rules, dashboard.
 *   - T3: Operator review default. Everything else in `src/`, plus the
 *     former-Tier-0 infra paths demoted by ADR-0015 (`src/grounding.ts`,
 *     `src/cost/`, the watchdog scripts, `scripts/deploy.sh`).
 *   - T4: Verifier Core. The 5 self-referential files that define the
 *     verification machinery. Operator-approved label required; the
 *     `tier-gate` CI job blocks the PR otherwise.
 *
 * Multi-file PRs use the highest matching tier (MAX of per-file tiers).
 * Under the monotonic numbering T4 is the natural MAX, so the Verifier
 * Core "wins" any mixed PR without a special short-circuit — the same
 * verdict the old non-monotonic Tier-0 short-circuit produced.
 *
 * The matcher is deliberately simple — exact paths or directory
 * prefixes — so the classification result is auditable at a glance.
 *
 * Inputs include deleted files: `gh pr diff --name-only` lists deletions
 * and they touch the path just as much as additions/edits.
 *
 * Renumbering note (ADR-0015 / issue #737): tiers were renumbered from
 * the non-monotonic 0–3 to the monotonic 1–4 ladder, behavior-preserving:
 * old Tier-0 → T4, old Tier-1 → T1, old Tier-2 → T2, old Tier-3 → T3.
 * The merge verdict for any tier→policy mapping is identical; only the
 * integer label of the deepest tier moved (0 → 4) and the Verifier Core
 * membership shrank to its 5 self-referential files.
 */

import { matchVerifierCore } from "./untouchable.ts";

// `Tier` is the local 1|2|3|4 union the classifier operates on. It is
// intentionally NOT exported — callers import `classifyChange` /
// `ClassifyResult` instead, and the canonical tier-policy type lives in
// `tier-policy.ts`. (Cleanup #2252: the prior `export` was unused.)
type Tier = 1 | 2 | 3 | 4;

export interface ClassifyResult {
  tier: Tier;
  reason: string;
  /** Per-file classification, useful for the CI step summary. */
  perFile?: { path: string; tier: Tier; matched: string | null }[];
}

/** T1: prompt-shaped, blast radius = one agent invocation. Shallowest. */
const TIER_1_PREFIXES: readonly string[] = Object.freeze([
  "config/agents/",
  "config/feedback/",
]);

/**
 * T2: auto-merge with outcome holdback. Skills, anchor weight tuning,
 * additive verification rules, dashboard.
 *
 * Initial T2 file list intentionally minimal; document how to extend
 * it in `docs/reference.md`. Removing rules from verification is NOT
 * T2 — those land as T3 by default.
 */
const TIER_2_PREFIXES: readonly string[] = Object.freeze([
  ".claude/skills/",
  "dashboard/",
]);
const TIER_2_FILES: readonly string[] = Object.freeze([
  // Anchor weight tuning. Logic changes here are still risky, but the
  // ADR explicitly puts them in the holdback tier.
  "src/anchor-selection.ts",
]);

function classifyOne(path: string): { tier: Tier; matched: string | null } {
  if (!path) return { tier: 3, matched: null };
  const normalized = path.replace(/^\.\//, "");

  // T4 (Verifier Core) — the deepest tier.
  const t4 = matchVerifierCore(normalized);
  if (t4) return { tier: 4, matched: t4 };

  for (const prefix of TIER_1_PREFIXES) {
    if (normalized.startsWith(prefix)) return { tier: 1, matched: prefix };
  }

  for (const prefix of TIER_2_PREFIXES) {
    if (normalized.startsWith(prefix)) return { tier: 2, matched: prefix };
  }
  for (const file of TIER_2_FILES) {
    if (normalized === file) return { tier: 2, matched: file };
  }

  return { tier: 3, matched: null };
}

/**
 * Classify a list of changed files. Returns the highest tier across all
 * inputs (MAX), with a short reason describing what triggered it.
 *
 * Monotonic convention (ADR-0015): higher tier number = deeper blast
 * radius = more verification. T4 (Verifier Core) is the deepest, so a PR
 * touching any T4 path classifies as T4 regardless of what else is in it
 * — the plain MAX yields the same verdict the old Tier-0 short-circuit
 * produced. A PR mixing T1 prompts with T3 `src/` changes classifies as
 * T3 (the deeper file dominates).
 */
export function classifyChange(filesChanged: string[]): ClassifyResult {
  const files = (filesChanged || []).filter(f => typeof f === "string" && f.length > 0);
  if (files.length === 0) {
    return { tier: 3, reason: "no files provided (default to operator review)", perFile: [] };
  }

  const perFile = files.map(p => {
    const c = classifyOne(p);
    return { path: p, tier: c.tier, matched: c.matched };
  });

  // Monotonic MAX — the deepest tier (largest number) wins. T4 (Verifier
  // Core) is the natural maximum, so this single rule subsumes the old
  // Tier-0 short-circuit with identical results.
  let highest: Tier = 1;
  for (const f of perFile) {
    if (f.tier > highest) highest = f.tier;
  }

  if (highest === 4) {
    const tier4 = perFile.filter(f => f.tier === 4);
    const matched = tier4.map(f => f.matched || f.path).join(", ");
    return {
      tier: 4,
      reason: `Verifier Core path(s) modified: ${matched}`,
      perFile,
    };
  }
  if (highest === 1) {
    return {
      tier: 1,
      reason: `prompt-shaped change (${perFile.map(f => f.path).join(", ")})`,
      perFile,
    };
  }
  if (highest === 2) {
    const tier2Paths = perFile.filter(f => f.tier === 2).map(f => f.path);
    return {
      tier: 2,
      reason: `outcome-holdback change (${tier2Paths.join(", ")})`,
      perFile,
    };
  }
  // T3 — find a representative path to mention.
  const tier3Paths = perFile.filter(f => f.tier === 3).map(f => f.path);
  return {
    tier: 3,
    reason: `operator-review change (${tier3Paths.slice(0, 3).join(", ")}${tier3Paths.length > 3 ? `, +${tier3Paths.length - 3} more` : ""})`,
    perFile,
  };
}

/**
 * Re-export of the Verifier Core path list. `test/tier-classifier.test.mts`
 * imports it from here to assert the classifier and the path list agree.
 * (`isVerifierCore` was also re-exported here but every caller imports it
 * directly from `./untouchable.ts`, so it was dropped as dead — cleanup #2252.)
 */
export { VERIFIER_CORE_PATHS } from "./untouchable.ts";
