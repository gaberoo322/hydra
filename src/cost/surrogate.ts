/**
 * surrogate.ts — subscription-aware token counter (issue #394, #704).
 *
 * After PR-3 (issue #383, ADR-0006) deleted `codex-runner.ts`, the only
 * writer that populated `hydra:metrics:cost:daily:*` and the per-cycle
 * `costMicrodollars` field was gone. The orchestrator is still spending
 * Claude Code subscription tokens via autopilot subagents, so this module
 * keeps that token signal alive.
 *
 * # PR-2 cleanup (#704)
 *
 * The dollar-conversion machinery was stripped here. `HYDRA_TOKEN_USD_RATE`
 * was structurally pinned to $0 (the operator never opted in to a believable
 * rate) and there is no live dollar cap — dispatch throttling is decided
 * exclusively by the Subscription Usage Tracker (`./usage-tracker.ts`). With
 * the dollar output dead, the `tokensToUsd` / `getTokenUsdRate` helpers, the
 * `costUsd` / `ratePerMillion` / `source` / `legacyRecordSpendUsd` fields, the
 * legacy `hydra:scheduler:daily-spend` blob read, and `getCycleSubagentCostUsd`
 * were all removed. What remains is a pure token counter.
 *
 * This module is the bridge. It defines:
 *
 *   1. `recordSubagentTokens(skill, tokens, opts?)` — write hook for the
 *      autopilot post-reap path. Bumps a per-day total counter, a per-skill
 *      breakdown hash, and (optionally) a per-cycle hash. All expire after
 *      30 days (7 for per-cycle) so the dashboard shows a rolling window
 *      without unbounded Redis growth.
 *
 *   2. `getDailyTokenCounter(date?)` — read aggregator. Returns the per-day
 *      total token count + per-skill breakdown (tokens + percentage). The
 *      anomaly detector and tool-scout consume these raw token figures.
 *
 * Module is dependency-light: only typed accessors from `src/redis/cost.ts`.
 * No control-loop hooks, no event-bus writes — those happen at the call
 * site (autopilot reap → POST /api/metrics/tokens → recordSubagentTokens).
 */

import {
  getAutopilotDailyTokensRaw,
  getCycleTokensRaw,
  getSkillTokensAll,
  getSkillTokensRaw,
  incrTokensBatch,
  tokensAutopilotDailyKey,
  tokensBySkillDailyKey,
  tokensByCycleKey,
} from "../redis/cost.ts";

// Re-export the key helpers for tests that probe Redis directly with a
// raw client. The seam module owns the shapes; this file is the import
// surface the rest of src/ already uses.
export { tokensAutopilotDailyKey, tokensBySkillDailyKey, tokensByCycleKey };

/** 30 days — long enough for week-over-week reads, short enough to keep Redis tidy. */
const DAILY_KEY_TTL_SECONDS = 30 * 24 * 3600;

/** 7 days — per-cycle hashes age out faster than the daily rollups. */
const CYCLE_KEY_TTL_SECONDS = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Today's date in YYYY-MM-DD (UTC). Matches the autopilot's date semantics. */
export function todayDateString(now: Date = new Date()): string {
  // Use UTC to match the autopilot's existing tracking semantics; the
  // operator-facing dashboard prefers a single canonical timezone.
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export interface RecordTokensResult {
  date: string;
  skill: string;
  tokens: number;
  dailyTotal: number;
  skillTotal: number;
  cycleTotal: number | null;
}

/**
 * Record a subagent's token spend.
 *
 * Increments three counters atomically (per-day total, per-day by-skill,
 * optional per-cycle) and re-stamps TTLs so the keys age out 30 days after
 * their LAST write — not 30 days after first creation.
 *
 * @param skill   the dispatched skill name (e.g. "hydra-dev")
 * @param tokens  total tokens consumed by the subagent (must be >= 0)
 * @param opts.date    override date string (defaults to today UTC)
 * @param opts.cycleId optional autopilot turn ID — when present, also
 *                     bumps the per-cycle hash so per-cycle token readers
 *                     can see post-cut spend.
 *
 * Idempotency: this function is NOT idempotent on its own. Idempotency is
 * the responsibility of the caller (autopilot reap.py uses task_id dedup
 * via reaped_task_ids before firing this).
 */
export async function recordSubagentTokens(
  skill: string,
  tokens: number,
  opts: { date?: string; cycleId?: string } = {},
): Promise<RecordTokensResult> {
  const date = opts.date || todayDateString();
  const cleanTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  const cleanSkill = (skill && skill.trim()) || "unknown";

  if (cleanTokens === 0) {
    // Nothing to write — return a synthetic snapshot so callers can still
    // log the no-op without a Redis round-trip.
    return {
      date,
      skill: cleanSkill,
      tokens: 0,
      dailyTotal: await readDailyTokens(date),
      skillTotal: await readSkillHashField(date, cleanSkill),
      cycleTotal: opts.cycleId ? await readCycleTokens(opts.cycleId) : null,
    };
  }

  const { dailyTotal, skillTotal, cycleTotal } = await incrTokensBatch({
    date,
    skill: cleanSkill,
    tokens: cleanTokens,
    cycleId: opts.cycleId,
    dailyTtlSeconds: DAILY_KEY_TTL_SECONDS,
    cycleTtlSeconds: CYCLE_KEY_TTL_SECONDS,
  });

  return {
    date,
    skill: cleanSkill,
    tokens: cleanTokens,
    dailyTotal,
    skillTotal,
    cycleTotal,
  };
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

async function readDailyTokens(date: string): Promise<number> {
  try {
    const raw = await getAutopilotDailyTokensRaw(date);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[cost-surrogate] readDailyTokens ${date} failed: ${err?.message || err}`);
    return 0;
  }
}

async function readSkillHashField(date: string, skill: string): Promise<number> {
  try {
    const v = await getSkillTokensRaw(date, skill);
    if (!v) return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[cost-surrogate] readSkillHashField ${date}/${skill} failed: ${err?.message || err}`);
    return 0;
  }
}

async function readCycleTokens(cycleId: string): Promise<number> {
  try {
    const v = await getCycleTokensRaw(cycleId);
    if (!v) return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[cost-surrogate] readCycleTokens ${cycleId} failed: ${err?.message || err}`);
    return 0;
  }
}

export interface DailyTokenCounter {
  date: string;
  /** Total subagent tokens for the date. */
  tokens: number;
  /** Per-skill breakdown: array sorted by tokens desc. */
  bySkill: Array<{ skill: string; tokens: number; pct: number }>;
}

/**
 * Read the daily token counter for the given date (defaults to today UTC).
 *
 * This is the central read endpoint used by `/api/metrics/cost` and the
 * dashboard cost tile. It synthesises the per-day total token counter and
 * the per-skill breakdown hash (this module's writers).
 *
 * Best-effort: each Redis sub-read is wrapped so a single hiccup yields
 * partial data rather than a thrown error.
 */
export async function getDailyTokenCounter(
  dateOverride?: string,
): Promise<DailyTokenCounter> {
  const date = dateOverride || todayDateString();

  const [tokens, bySkillRaw] = await Promise.all([
    readDailyTokens(date),
    safeSkillTokensAll(date),
  ]);

  const bySkillEntries: Array<{ skill: string; tokens: number; pct: number }> = [];
  if (bySkillRaw) {
    for (const [skill, raw] of Object.entries(bySkillRaw)) {
      const n = parseInt(String(raw), 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      bySkillEntries.push({
        skill,
        tokens: n,
        pct: tokens > 0 ? Math.round((n / tokens) * 10000) / 100 : 0,
      });
    }
    bySkillEntries.sort((a, b) => b.tokens - a.tokens);
  }

  return {
    date,
    tokens,
    bySkill: bySkillEntries,
  };
}

async function safeSkillTokensAll(date: string): Promise<Record<string, string> | null> {
  try {
    return await getSkillTokensAll(date);
  } catch (err: any) {
    console.error(`[cost-surrogate] getSkillTokensAll ${date} failed: ${err?.message || err}`);
    return null;
  }
}
