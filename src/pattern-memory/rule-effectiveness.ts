/**
 * pattern-memory/rule-effectiveness.ts — Promoted-rule effectiveness +
 * auto-demotion lifecycle.
 *
 * Lifted out of `agent-memory.ts` (issue #900) as a sibling module, mirroring
 * the escalation split (#823). `agent-memory.ts` keeps the core Pattern Memory
 * store + promotion; this module owns the self-contained behavioural subsystem
 * that answers "after a pattern was promoted to a `config/feedback/to-{agent}.md`
 * file, is it actually working — and if not, auto-demote it."
 *
 * Everything that decision needs lives here: the tuning thresholds, the
 * effectiveness math, the post-promotion cooldown, the demotion side-effect on
 * the feedback file, and the bounded rule-action audit log. `learning.ts` calls
 * one entry point (`consolidatePromotedRuleEffectiveness`) from the daily
 * `consolidate()`; `api/learning.ts` calls `getIneffectivePromotedPatterns`
 * and `getRuleActionLog` for its diagnostic endpoints.
 *
 * Pure-for-test functions (`evaluatePromotedPatternEffectiveness`,
 * `qualifiesForRuleAction`, `applyDemotionToPattern`,
 * `isEffectivenessCooldownExpired`, `removePromotedRuleFromFeedback`) are now
 * internals of THIS module's Interface rather than part of `agent-memory.ts`'s
 * ~30-export public surface. They remain exported because the unit tests
 * exercise them directly, but the orchestration that wires them together
 * (`processPromotedPatternEffectiveness` → `consolidatePromotedRuleEffectiveness`)
 * is now co-located with them.
 *
 * Storage seam
 * ------------
 * The lifecycle reads/writes the SAME `hydra:memory:{agent}:patterns` JSON via
 * `agent-memory.ts`'s `loadPatterns`/`savePatterns` internal helpers (imported
 * here). No new Redis key, no format change — this is a code-locality refactor,
 * not a storage change. The Redis-key shape behind `src/redis/agent-memory.ts`
 * stays byte-compatible.
 */

import { appendRuleAction, readRecentRuleActions } from "../redis/agent-memory.ts";
import { loadPatterns, savePatterns, type MemoryPattern } from "./agent-memory.ts";
import {
  demotePromotedRuleFromFeedbackFile,
  removePromotedRuleBlock,
} from "./feedback-file.ts";

// Issue #940 — the demote-side feedback-file grammar (`removePromotedRuleBlock`
// + the side-effecting `demotePromotedRuleFromFeedbackFile`) is now owned by the
// `feedback-file.ts` Module, co-located with the matching append/render grammar
// it parses against (the writer/reader coupling is now structural, not a doc
// comment). `demotePromotedRuleFromFeedbackFile` is re-exported so the demotion
// caller below keeps a stable local name; `removePromotedRuleBlock` is
// re-exported under its historical name `removePromotedRuleFromFeedback` so the
// existing test import (test/promoted-rule-effectiveness.test.mts) keeps
// resolving against `rule-effectiveness.ts`.
export {
  demotePromotedRuleFromFeedbackFile,
  removePromotedRuleBlock as removePromotedRuleFromFeedback,
};

// ===========================================================================
// Types
// ===========================================================================

/**
 * Issue #289 — Promoted-but-ineffective pattern surfaced via
 * `getIneffectivePromotedPatterns()`. A promoted rule is "ineffective" when the
 * post-promotion firing rate (hits/day) is at least as high as the
 * pre-promotion rate. Promotion is supposed to durably change agent behavior;
 * a flat or rising rate means the rule text isn't actually preventing the
 * failure mode it describes.
 *
 * Issue #365 — `rateRatio: null` (the JSON serialization of `Infinity`) is
 * misleading in the API output. `rateRatioLabel` carries the human-readable
 * form ("infinite" when there's no pre-promotion baseline, otherwise the
 * numeric ratio formatted to two decimals). `reasonCode` distinguishes
 * relative-rate failures from absolute-rate failures so downstream consumers
 * (auto-demote, operator alerts) can act differently.
 */
export type IneffectivePromotedPattern = {
  category: string;
  promotedAt: string;
  hitsAtPromotion: number;
  hitsSincePromotion: number;
  daysToPromotion: number;
  daysSincePromotion: number;
  preRate: number; // hits/day before promotion
  postRate: number; // hits/day after promotion
  rateRatio: number; // postRate / preRate (Infinity when preRate === 0)
  rateRatioLabel: string; // "infinite" or "N.NN" — usable in JSON output
  reasonCode: "rate-ratio" | "absolute-postrate" | "no-baseline";
  lastSeen: string;
};

export type RuleActionLogEntry = {
  /** ISO timestamp of the action. */
  ts: string;
  agent: "planner" | "executor" | "skeptic";
  category: string;
  action: "demoted" | "alerted" | "skipped-cooldown" | "skipped-disabled";
  reasonCode: IneffectivePromotedPattern["reasonCode"];
  /** Snapshot of the metric envelope at the time of action. */
  metrics: {
    hitsSincePromotion: number;
    daysSincePromotion: number;
    preRate: number;
    postRate: number;
    rateRatioLabel: string;
  };
  /** Set when `action === "demoted"` and the feedback-file rewrite succeeded. */
  feedbackFileRewritten?: boolean;
  /** Free-form note (e.g. "auto-demote disabled via HYDRA_RULE_AUTO_DEMOTE"). */
  note?: string;
};

// ===========================================================================
// Effectiveness-check tuning knobs (issue #365)
// ===========================================================================

/** A pattern is flagged when postRate >= preRate * this multiplier. */
export const RATE_RATIO_MULTIPLIER = 1.5;
/** Or when postRate exceeds this absolute threshold *and* the rule has had
 *  enough time on the floor (`ABSOLUTE_AGE_DAYS`). */
export const ABSOLUTE_POSTRATE_THRESHOLD = 5; // hits/day
export const ABSOLUTE_AGE_DAYS = 14;
/** Demotion cooldown — re-checks of the same pattern within this window are
 *  no-ops, preventing alert spam if the operator restarts the orchestrator. */
export const EFFECTIVENESS_CHECK_COOLDOWN_HOURS = 24;
/** Cap on the rule-action audit log to keep the Redis list bounded. */
export const RULE_ACTION_LOG_CAP = 200;
/** Minimum observation window after promotion before judging effectiveness. */
export const MIN_DAYS_POST_PROMOTION = 3;

// ===========================================================================
// Issue #289 — Ineffective promoted-pattern detection
// ===========================================================================

function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

/**
 * Pure helper — given a single pattern, decide whether it qualifies as
 * "promoted-but-ineffective". Exported for unit tests so we don't have to
 * round-trip through Redis.
 *
 * A pattern is ineffective when ALL of the following hold:
 *   1. `promoted === true` and `promotedAt` + `hitsAtPromotion` are present
 *      (legacy patterns promoted before this instrumentation are skipped).
 *   2. `daysSincePromotion >= MIN_DAYS_POST_PROMOTION` — we need a comparable
 *      window before judging.
 *   3. `postRate >= preRate` (or `preRate === 0`, in which case any
 *      post-promotion hits flag it).
 *
 * Returns the metric envelope when ineffective, otherwise null.
 */
export function evaluatePromotedPatternEffectiveness(
  p: MemoryPattern,
  now: Date = new Date(),
): IneffectivePromotedPattern | null {
  if (!p.promoted || !p.promotedAt || typeof p.hitsAtPromotion !== "number") return null;

  const firstSeen = new Date(p.firstSeen + "T00:00:00Z");
  const promotedAt = new Date(p.promotedAt + "T00:00:00Z");
  const nowUtc = new Date(now.toISOString().split("T")[0] + "T00:00:00Z");

  const dayMs = 1000 * 60 * 60 * 24;
  const daysToPromotion = Math.max(1, Math.round((promotedAt.getTime() - firstSeen.getTime()) / dayMs));
  const daysSincePromotion = Math.max(0, Math.round((nowUtc.getTime() - promotedAt.getTime()) / dayMs));

  if (daysSincePromotion < MIN_DAYS_POST_PROMOTION) return null;

  const hitsSincePromotion = Math.max(0, p.hitCount - p.hitsAtPromotion);
  const preRate = p.hitsAtPromotion / daysToPromotion;
  const postRate = hitsSincePromotion / Math.max(1, daysSincePromotion);
  const rateRatio = preRate === 0 ? (hitsSincePromotion > 0 ? Infinity : 0) : postRate / preRate;

  // The pattern qualifies as "ineffective" if any of:
  //   1. There is no pre-promotion baseline (preRate === 0, the backfill case)
  //      AND the rule has continued firing post-promotion.
  //   2. The post-promotion rate is at least as high as the pre-promotion rate
  //      (i.e. promotion did nothing or made things worse).
  // Note: the action layer (`processPromotedPatternEffectiveness`) applies a
  // stricter `RATE_RATIO_MULTIPLIER` before auto-demoting, but the diagnostic
  // endpoint surfaces anything that's not strictly improving.
  const ineffective = preRate === 0 ? hitsSincePromotion > 0 : postRate >= preRate;
  if (!ineffective) return null;

  const reasonCode: IneffectivePromotedPattern["reasonCode"] =
    preRate === 0
      ? "no-baseline"
      : postRate >= preRate * RATE_RATIO_MULTIPLIER
        ? "rate-ratio"
        : postRate >= ABSOLUTE_POSTRATE_THRESHOLD && daysSincePromotion >= ABSOLUTE_AGE_DAYS
          ? "absolute-postrate"
          : "rate-ratio";

  const rateRatioLabel = Number.isFinite(rateRatio)
    ? round2(rateRatio).toFixed(2)
    : "infinite";

  return {
    category: p.category,
    promotedAt: p.promotedAt,
    hitsAtPromotion: p.hitsAtPromotion,
    hitsSincePromotion,
    daysToPromotion,
    daysSincePromotion,
    preRate: round2(preRate),
    postRate: round2(postRate),
    rateRatio: Number.isFinite(rateRatio) ? round2(rateRatio) : rateRatio,
    rateRatioLabel,
    reasonCode,
    lastSeen: p.lastSeen,
  };
}

/**
 * Issue #365 — decide whether the effectiveness check should ACT on a
 * pattern (auto-demote or alert), distinct from "should this surface in the
 * diagnostic endpoint." The action threshold is intentionally stricter than
 * the surface threshold so we never demote a rule that's merely flat.
 *
 * Returns the reason code when the pattern qualifies for action, null
 * otherwise. The reason is propagated to the rule-action log and any
 * auto-created `needs-info` issue.
 */
export function qualifiesForRuleAction(
  ev: IneffectivePromotedPattern,
): "rate-ratio" | "absolute-postrate" | "no-baseline" | null {
  // 1. Strong relative-rate failure: postRate is at least RATE_RATIO_MULTIPLIER
  //    times preRate. Doesn't apply when preRate is 0 (no baseline).
  if (ev.preRate > 0 && ev.postRate >= ev.preRate * RATE_RATIO_MULTIPLIER) {
    return "rate-ratio";
  }
  // 2. Absolute high firing rate after a long enough observation window —
  //    even without a baseline, 5+ hits/day for two weeks is conclusive.
  if (
    ev.postRate >= ABSOLUTE_POSTRATE_THRESHOLD &&
    ev.daysSincePromotion >= ABSOLUTE_AGE_DAYS
  ) {
    return ev.preRate === 0 ? "no-baseline" : "absolute-postrate";
  }
  return null;
}

/**
 * Return all patterns for `agentName` whose post-promotion firing rate is
 * at least as high as their pre-promotion rate. Used by the
 * `/api/learning/ineffective-rules` endpoint and surfaced in cycle reports.
 */
export async function getIneffectivePromotedPatterns(
  agentName: string,
  now: Date = new Date(),
): Promise<IneffectivePromotedPattern[]> {
  const patterns = await loadPatterns(agentName);
  const flagged: IneffectivePromotedPattern[] = [];
  for (const p of patterns) {
    const ev = evaluatePromotedPatternEffectiveness(p, now);
    if (ev) flagged.push(ev);
  }
  // Worst offenders first (highest post-promotion rate, then highest absolute hits-since)
  flagged.sort((a, b) => b.postRate - a.postRate || b.hitsSincePromotion - a.hitsSincePromotion);
  return flagged;
}

// ===========================================================================
// Issue #365 — Auto-demote / alert action on ineffective promoted rules
// ===========================================================================

// Issue #940 — the demote-side feedback-file grammar (the pure
// `removePromotedRuleBlock` transform, re-exported here under its historical
// name `removePromotedRuleFromFeedback`, and the side-effecting
// `demotePromotedRuleFromFeedbackFile` wrapper) moved verbatim into the
// `feedback-file.ts` Module and is re-exported at the top of this file. The
// auto-demote orchestration below calls the re-exported wrapper.

/**
 * Append a rule-action audit entry to the bounded Redis list. Tail entries
 * past `RULE_ACTION_LOG_CAP` are trimmed away. Best-effort: log + swallow
 * errors so a Redis blip can't break the daily consolidation pass.
 */
export async function recordRuleAction(entry: RuleActionLogEntry): Promise<void> {
  try {
    await appendRuleAction(JSON.stringify(entry), RULE_ACTION_LOG_CAP);
  } catch (err: any) {
    console.error(`[Learning] recordRuleAction failed: ${err.message}`);
  }
}

/** Fetch the rule-action audit log (newest first), up to `limit` entries. */
export async function getRuleActionLog(limit = 50): Promise<RuleActionLogEntry[]> {
  try {
    const raw = await readRecentRuleActions(limit);
    const out: RuleActionLogEntry[] = [];
    for (const r of raw) {
      try {
        out.push(JSON.parse(r));
      } catch { /* intentional: skip unparseable log entries */ }
    }
    return out;
  } catch (err: any) {
    console.error(`[Learning] getRuleActionLog failed: ${err.message}`);
    return [];
  }
}

/**
 * Pure helper — given a pattern's `lastEffectivenessCheckAt` and a reference
 * time, decide whether the cooldown has expired. Exported for tests.
 */
export function isEffectivenessCooldownExpired(
  lastCheckIso: string | undefined,
  now: Date = new Date(),
  cooldownHours: number = EFFECTIVENESS_CHECK_COOLDOWN_HOURS,
): boolean {
  if (!lastCheckIso) return true;
  const last = Date.parse(lastCheckIso);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= cooldownHours * 60 * 60 * 1000;
}

/** True when `HYDRA_RULE_AUTO_DEMOTE` is not explicitly set to "false". */
export function isAutoDemoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.HYDRA_RULE_AUTO_DEMOTE;
  if (raw == null) return true;
  return raw.trim().toLowerCase() !== "false" && raw.trim() !== "0";
}

/**
 * Pure helper — given a single pattern that has already been classified
 * ineffective + action-worthy, mutate it in place to reflect a demotion.
 * Caller is responsible for the feedback-file rewrite + audit log.
 */
export function applyDemotionToPattern(p: MemoryPattern, todayIso: string): void {
  p.promoted = false;
  // Preserve a breadcrumb of the prior promotion for diagnostics.
  // Note: hitsAtPromotion/promotedAt are cleared so the same pattern won't
  // re-fire the effectiveness check on the very next cycle if hits keep
  // climbing. If hitCount later reaches PROMOTION_THRESHOLD again, the
  // standard sweep will re-promote with fresh metadata.
  p.promotedAt = undefined;
  p.hitsAtPromotion = undefined;
  p.demoted = true;
  p.demotedAt = todayIso.split("T")[0];
  p.demotedReason = "ineffective";
}

/**
 * Run the effectiveness check across all promoted patterns for a single
 * agent. For each pattern that `qualifiesForRuleAction()` flags:
 *   - if auto-demote is enabled, demote the pattern (Redis) + remove from
 *     the feedback file + record `action: "demoted"`.
 *   - if auto-demote is disabled, record `action: "alerted"` only.
 *   - if the same pattern was already checked within the cooldown window,
 *     record `action: "skipped-cooldown"` and move on.
 *
 * The `lastEffectivenessCheckAt` stamp is always updated, even when no
 * action was taken, so cooldown applies uniformly.
 *
 * Returns the list of actions taken (excluding skips) — useful for the
 * scheduler to log a one-line summary.
 */
export async function processPromotedPatternEffectiveness(
  agentName: "planner" | "executor" | "skeptic",
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuleActionLogEntry[]> {
  const patterns = await loadPatterns(agentName);
  if (patterns.length === 0) return [];

  const nowIso = now.toISOString();
  const today = nowIso.split("T")[0];
  const autoDemote = isAutoDemoteEnabled(env);
  const actions: RuleActionLogEntry[] = [];
  let changed = false;

  for (const p of patterns) {
    if (!p.promoted) continue;
    const ev = evaluatePromotedPatternEffectiveness(p, now);
    if (!ev) continue;
    const reasonCode = qualifiesForRuleAction(ev);
    if (!reasonCode) continue;

    // Cooldown — skip if checked recently.
    if (!isEffectivenessCooldownExpired(p.lastEffectivenessCheckAt, now)) {
      const entry: RuleActionLogEntry = {
        ts: nowIso,
        agent: agentName,
        category: p.category,
        action: "skipped-cooldown",
        reasonCode,
        metrics: {
          hitsSincePromotion: ev.hitsSincePromotion,
          daysSincePromotion: ev.daysSincePromotion,
          preRate: ev.preRate,
          postRate: ev.postRate,
          rateRatioLabel: ev.rateRatioLabel,
        },
      };
      await recordRuleAction(entry);
      continue;
    }

    // Stamp the check time regardless of action so we honour cooldown next pass.
    p.lastEffectivenessCheckAt = nowIso;

    if (!autoDemote) {
      const entry: RuleActionLogEntry = {
        ts: nowIso,
        agent: agentName,
        category: p.category,
        action: "skipped-disabled",
        reasonCode,
        metrics: {
          hitsSincePromotion: ev.hitsSincePromotion,
          daysSincePromotion: ev.daysSincePromotion,
          preRate: ev.preRate,
          postRate: ev.postRate,
          rateRatioLabel: ev.rateRatioLabel,
        },
        note: "auto-demote disabled via HYDRA_RULE_AUTO_DEMOTE=false",
      };
      actions.push(entry);
      await recordRuleAction(entry);
      changed = true;
      continue;
    }

    // Auto-demote path.
    applyDemotionToPattern(p, today);
    let feedbackFileRewritten = false;
    try {
      feedbackFileRewritten = await demotePromotedRuleFromFeedbackFile(agentName, p.category);
    } catch (err: any) {
      console.error(`[Learning] demote feedback rewrite failed for ${agentName}/${p.category}: ${err.message}`);
    }
    const entry: RuleActionLogEntry = {
      ts: nowIso,
      agent: agentName,
      category: p.category,
      action: "demoted",
      reasonCode,
      metrics: {
        hitsSincePromotion: ev.hitsSincePromotion,
        daysSincePromotion: ev.daysSincePromotion,
        preRate: ev.preRate,
        postRate: ev.postRate,
        rateRatioLabel: ev.rateRatioLabel,
      },
      feedbackFileRewritten,
    };
    actions.push(entry);
    await recordRuleAction(entry);
    changed = true;
    console.log(
      `[Learning] Auto-demoted ${agentName}/${p.category} — ` +
        `${ev.hitsSincePromotion} hits over ${ev.daysSincePromotion}d ` +
        `(postRate=${ev.postRate}/day, preRate=${ev.preRate}/day, reason=${reasonCode})`,
    );
  }

  if (changed) {
    await savePatterns(agentName, patterns);
  }
  return actions;
}

/**
 * Entry point invoked from `consolidate()` once per day. Runs the
 * effectiveness check across planner/executor/skeptic. Always returns
 * cleanly — Redis or feedback-file errors are logged but never thrown.
 */
export async function consolidatePromotedRuleEffectiveness(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuleActionLogEntry[]> {
  const all: RuleActionLogEntry[] = [];
  for (const agent of ["planner", "executor", "skeptic"] as const) {
    try {
      const taken = await processPromotedPatternEffectiveness(agent, now, env);
      all.push(...taken);
    } catch (err: any) {
      console.error(`[Learning] consolidatePromotedRuleEffectiveness(${agent}) failed: ${err.message}`);
    }
  }
  if (all.length > 0) {
    const demoted = all.filter(a => a.action === "demoted").length;
    const alerted = all.filter(a => a.action === "skipped-disabled").length;
    console.log(
      `[Learning] Rule-effectiveness pass: ${demoted} demoted, ${alerted} alerted (auto-demote disabled)`,
    );
  }
  return all;
}
