/**
 * Modification Tier classifier (ADR-0004 work-order step 3).
 *
 * Classifies a set of changed files into one of four tiers. The tier
 * controls merge policy:
 *   - Tier 0: Untouchable Core. Operator-approved label required; the
 *     `tier-gate` CI job blocks the PR otherwise.
 *   - Tier 1: Auto-merge, no holdback. Prompt-shaped changes
 *     (`config/agents/`, `config/feedback/`).
 *   - Tier 2: Auto-merge with outcome holdback. Skills, anchor weights,
 *     additive verification rules, dashboard. Implementation of the
 *     holdback watcher is a follow-up issue (work-order step 4).
 *   - Tier 3: Operator review. Everything else.
 *
 * Multi-file PRs use the highest matching tier (max of per-file tiers,
 * with Tier 0 short-circuiting).
 *
 * The matcher is deliberately simple — exact paths or directory
 * prefixes — so the classification result is auditable at a glance.
 *
 * Inputs include deleted files: `gh pr diff --name-only` lists deletions
 * and they touch the path just as much as additions/edits.
 */

import { matchUntouchable } from "./untouchable.ts";

export type Tier = 0 | 1 | 2 | 3;

export interface ClassifyResult {
  tier: Tier;
  reason: string;
  /** Per-file classification, useful for the CI step summary. */
  perFile?: { path: string; tier: Tier; matched: string | null }[];
}

/** Tier 1: prompt-shaped, blast radius = one agent invocation. */
const TIER_1_PREFIXES: readonly string[] = Object.freeze([
  "config/agents/",
  "config/feedback/",
]);

/**
 * Tier 2: auto-merge with outcome holdback. Skills, anchor weight tuning,
 * additive verification rules, dashboard.
 *
 * Initial Tier-2 file list intentionally minimal; document how to extend
 * it in `docs/reference.md`. Removing rules from verification is NOT
 * Tier 2 — those land as Tier 3 by default.
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

  // Tier 0 short-circuit.
  const t0 = matchUntouchable(normalized);
  if (t0) return { tier: 0, matched: t0 };

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
 * inputs, with a short reason describing what triggered it.
 *
 * Convention: lower tier number = higher restriction. So we take MIN.
 *   - Tier 0 (untouchable) wins over Tier 3.
 *   - Mixed Tier-1 and Tier-3 PR is Tier 3 (the riskier file dominates).
 *
 * Wait — ADR-0004 says the highest-blast-radius tier should win. Tier 0
 * is the most restricted, Tier 3 is the most reviewed. We want the
 * **most restrictive merge policy** to apply, which is the LOWEST tier
 * for protection (0) but the HIGHEST review burden for risk (3).
 *
 * Resolution: use Tier 0 short-circuit, then take MAX. A PR mixing
 * Tier-1 prompts with Tier-3 src/ changes goes through operator review
 * (Tier 3). A PR touching anything Tier 0 always blocks regardless of
 * what else is in it.
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

  // Tier 0 short-circuit — protected-paths trumps everything.
  const tier0 = perFile.filter(f => f.tier === 0);
  if (tier0.length > 0) {
    const matched = tier0.map(f => f.matched || f.path).join(", ");
    return {
      tier: 0,
      reason: `Untouchable Core path(s) modified: ${matched}`,
      perFile,
    };
  }

  // Otherwise take the highest tier number (most operator scrutiny).
  let highest: Tier = 1;
  for (const f of perFile) {
    if (f.tier > highest) highest = f.tier;
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
  // Tier 3 — find a representative path to mention.
  const tier3Paths = perFile.filter(f => f.tier === 3).map(f => f.path);
  return {
    tier: 3,
    reason: `operator-review change (${tier3Paths.slice(0, 3).join(", ")}${tier3Paths.length > 3 ? `, +${tier3Paths.length - 3} more` : ""})`,
    perFile,
  };
}

/** Re-exports for convenience — callers usually need both. */
export { isUntouchable, UNTOUCHABLE_PATHS } from "./untouchable.ts";
