/**
 * surrogate.ts — subscription-aware spend surrogate (issue #394).
 *
 * After PR-3 (issue #383, ADR-0006) deleted `codex-runner.ts`, the only
 * writer that populated `hydra:metrics:cost:daily:*` and the per-cycle
 * `costMicrodollars` field was gone. The daily-spend cap, the cost
 * dashboard, and the per-cycle cost-cap all started reading zeros — but
 * the orchestrator is still spending Claude Code subscription tokens
 * via autopilot subagents.
 *
 * This module is the bridge. It defines:
 *
 *   1. `recordSubagentTokens(skill, tokens, date?)` — write hook for the
 *      autopilot post-reap path. Bumps a per-day total counter and a
 *      per-skill breakdown hash. Both expire after 30 days so the dashboard
 *      shows a rolling window without unbounded Redis growth.
 *
 *   2. `tokensToUsd(tokens, rate?)` — pure conversion using a USD-per-
 *      million-tokens rate from `HYDRA_TOKEN_USD_RATE`. **The default is 0**:
 *      the operator must opt in to a number they actually believe. A wrong
 *      default would be worse than no number because the cost-cap circuit
 *      breaker would then trip based on imaginary spend.
 *
 *   3. `getDailySpendSurrogate(date?)` — read aggregator. Returns the
 *      per-day total + per-skill breakdown + computed USD figures + a
 *      `source` discriminator so dashboards can label data correctly:
 *
 *        - `"autopilot-surrogate"` when only subagent tokens contributed
 *        - `"codex-recorded"` when only the legacy recordSpend reader has
 *          data (kept for the back-compat case of mixed Redis state)
 *        - `"mixed"` when both have data
 *        - `"none"` when neither has data
 *
 *   4. `getCycleSubagentCostUsd(cycleId)` — surrogate cost for a single
 *      cycle (autopilot turn ID). Reads the per-cycle hash field populated
 *      by `recordSubagentTokens(..., cycleId)`. Used by the per-cycle
 *      cost-cap path to make the cap aware of post-cut spend.
 *
 * Module is dependency-light: only `redis/kv.ts` primitives + redis-keys.
 * No control-loop hooks, no event-bus writes — those happen at the call
 * site (autopilot reap → POST /api/metrics/tokens → recordSubagentTokens).
 */

import {
  getString,
  hashGetAll,
} from "../redis/kv.ts";
import { hashGet } from "../redis/utility.ts";
import { getRedisConnection } from "../redis/connection.ts";

// ---------------------------------------------------------------------------
// Key shapes
// ---------------------------------------------------------------------------

/** Daily-total tokens key. INT string. */
export function tokensAutopilotDailyKey(date: string): string {
  return `hydra:metrics:tokens:autopilot:daily:${date}`;
}

/** Daily by-skill breakdown hash key. Fields are skill names, values INT strings. */
export function tokensBySkillDailyKey(date: string): string {
  return `hydra:metrics:tokens:by-skill:daily:${date}`;
}

/** Per-cycle subagent token hash key. Fields: tokens, skill. */
export function tokensByCycleKey(cycleId: string): string {
  return `hydra:metrics:tokens:by-cycle:${cycleId}`;
}

/** 30 days — long enough for week-over-week reads, short enough to keep Redis tidy. */
const DAILY_KEY_TTL_SECONDS = 30 * 24 * 3600;

/** 7 days — per-cycle hashes age out faster than the daily rollups. */
const CYCLE_KEY_TTL_SECONDS = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * USD per million tokens. Operator-configurable via `HYDRA_TOKEN_USD_RATE`.
 *
 * **Default 0** — the operator must opt in to a rate they actually believe.
 * Returning 0 means the dashboard shows tokens but $0; the cost-cap reader
 * sees $0 and never trips on surrogate-only data. That is the intentional
 * fail-safe: a wrong default rate would cause spurious cap trips OR mask
 * real overspend, both of which are worse than honest-zero.
 *
 * Re-reads env on every call so config-reload (e.g. `systemctl restart`
 * with a new EnvironmentFile=) takes effect without code changes.
 */
export function getTokenUsdRate(): number {
  const raw = process.env.HYDRA_TOKEN_USD_RATE;
  if (raw === undefined || raw === "") return 0;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Convert tokens to USD via the per-million rate.
 *
 * Pure. Tolerates non-finite / negative input by clamping to zero — these
 * inputs are not expected from a well-behaved autopilot but a single
 * bad Redis read shouldn't poison the entire surrogate.
 */
export function tokensToUsd(tokens: number, ratePerMillion?: number): number {
  const t = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  const r = ratePerMillion !== undefined ? ratePerMillion : getTokenUsdRate();
  if (!Number.isFinite(r) || r <= 0) return 0;
  return (t / 1_000_000) * r;
}

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
 *                     bumps the per-cycle hash so the per-cycle cost-cap
 *                     can read post-cut spend.
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
      dailyTotal: await readIntKey(tokensAutopilotDailyKey(date)),
      skillTotal: await readSkillHashField(date, cleanSkill),
      cycleTotal: opts.cycleId ? await readCycleTokens(opts.cycleId) : null,
    };
  }

  const dailyKey = tokensAutopilotDailyKey(date);
  const bySkillKey = tokensBySkillDailyKey(date);

  // INCRBY the daily total — pipeline doesn't return a value the same way
  // hashIncrBy does, so use the raw connection. Single round-trip pipeline
  // keeps this cheap.
  const r = getRedisConnection();
  const pipe = r.pipeline();
  pipe.incrby(dailyKey, cleanTokens);
  pipe.expire(dailyKey, DAILY_KEY_TTL_SECONDS);
  pipe.hincrby(bySkillKey, cleanSkill, cleanTokens);
  pipe.expire(bySkillKey, DAILY_KEY_TTL_SECONDS);

  let cycleHashKey: string | null = null;
  if (opts.cycleId) {
    cycleHashKey = tokensByCycleKey(opts.cycleId);
    pipe.hincrby(cycleHashKey, "tokens", cleanTokens);
    pipe.hset(cycleHashKey, "skill", cleanSkill);
    pipe.expire(cycleHashKey, CYCLE_KEY_TTL_SECONDS);
  }

  const results = await pipe.exec();
  // pipeline().exec() returns [[err, val], ...]; pluck the integer return
  // values we care about. Failure on any single op is logged but doesn't
  // throw — the surrogate is best-effort by design.
  let dailyTotal = 0;
  let skillTotal = 0;
  let cycleTotal: number | null = null;
  if (Array.isArray(results)) {
    const [dailyRes, , skillRes, , cycleRes] = results;
    if (Array.isArray(dailyRes) && dailyRes[0] == null && typeof dailyRes[1] === "number") {
      dailyTotal = dailyRes[1];
    }
    if (Array.isArray(skillRes) && skillRes[0] == null && typeof skillRes[1] === "number") {
      skillTotal = skillRes[1];
    }
    if (cycleHashKey && Array.isArray(cycleRes) && cycleRes[0] == null && typeof cycleRes[1] === "number") {
      cycleTotal = cycleRes[1];
    }
  }

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

async function readIntKey(key: string): Promise<number> {
  try {
    const raw = await getString(key);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[cost-surrogate] readIntKey ${key} failed: ${err?.message || err}`);
    return 0;
  }
}

async function readSkillHashField(date: string, skill: string): Promise<number> {
  try {
    const v = await hashGet(tokensBySkillDailyKey(date), skill);
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
    const v = await hashGet(tokensByCycleKey(cycleId), "tokens");
    if (!v) return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch (err: any) {
    console.error(`[cost-surrogate] readCycleTokens ${cycleId} failed: ${err?.message || err}`);
    return 0;
  }
}

export interface DailySpendSurrogate {
  date: string;
  /** Total subagent tokens for the date. */
  tokens: number;
  /** Per-skill breakdown: array sorted by tokens desc. */
  bySkill: Array<{ skill: string; tokens: number; pct: number; costUsd: number }>;
  /** Configured USD-per-million rate at read time (0 if unconfigured). */
  ratePerMillion: number;
  /** Computed total USD (tokens × rate). 0 when rate is 0. */
  costUsd: number;
  /** Which writer(s) contributed data — for dashboard labeling. */
  source: "autopilot-surrogate" | "codex-recorded" | "mixed" | "none";
  /** Legacy recordSpend reader value (kept for back-compat audit; may be 0
   *  in current deployments since codex-runner is gone but a forgotten
   *  scheduler.recordSpend research-cost path still writes to it). */
  legacyRecordSpendUsd: number;
}

/**
 * Read the daily surrogate spend for the given date (defaults to today UTC).
 *
 * This is the central read endpoint used by `/api/metrics/cost` and the
 * dashboard `CostWidget`. It synthesises three pieces:
 *
 *   1. The per-day total token counter and per-skill breakdown hash
 *      (this module's writers).
 *   2. The legacy `hydra:scheduler:daily-spend` value (a JSON blob written
 *      by `scheduler.ts:recordSpend()`, currently fed only by research
 *      loop spend — kept around for cross-checking and to support the
 *      "mixed" source label.)
 *   3. The configured `HYDRA_TOKEN_USD_RATE` so the conversion math is
 *      reproducible by callers without re-reading env.
 *
 * Best-effort: each Redis sub-read is wrapped so a single hiccup yields
 * partial data with `source` reflecting only what could be loaded.
 */
export async function getDailySpendSurrogate(
  dateOverride?: string,
): Promise<DailySpendSurrogate> {
  const date = dateOverride || todayDateString();
  const ratePerMillion = getTokenUsdRate();

  const [tokens, bySkillRaw, legacyJson] = await Promise.all([
    readIntKey(tokensAutopilotDailyKey(date)),
    safeHashGetAll(tokensBySkillDailyKey(date)),
    getString("hydra:scheduler:daily-spend").catch(() => null),
  ]);

  // Parse legacy recordSpend payload. Shape: { date, usd, updatedAt }.
  let legacyUsd = 0;
  if (legacyJson) {
    try {
      const parsed = JSON.parse(legacyJson);
      if (parsed && typeof parsed === "object" && parsed.date === date) {
        const u = parseFloat(parsed.usd);
        if (Number.isFinite(u) && u >= 0) legacyUsd = u;
      }
    } catch { /* intentional: legacy blob unparseable — treat as zero */ }
  }

  const costUsd = tokensToUsd(tokens, ratePerMillion);

  const bySkillEntries: Array<{ skill: string; tokens: number; pct: number; costUsd: number }> = [];
  if (bySkillRaw) {
    for (const [skill, raw] of Object.entries(bySkillRaw)) {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      bySkillEntries.push({
        skill,
        tokens: n,
        pct: tokens > 0 ? Math.round((n / tokens) * 10000) / 100 : 0,
        costUsd: tokensToUsd(n, ratePerMillion),
      });
    }
    bySkillEntries.sort((a, b) => b.tokens - a.tokens);
  }

  const hasSurrogate = tokens > 0;
  const hasLegacy = legacyUsd > 0;
  let source: DailySpendSurrogate["source"];
  if (hasSurrogate && hasLegacy) source = "mixed";
  else if (hasSurrogate) source = "autopilot-surrogate";
  else if (hasLegacy) source = "codex-recorded";
  else source = "none";

  return {
    date,
    tokens,
    bySkill: bySkillEntries,
    ratePerMillion,
    costUsd: Math.round(costUsd * 10000) / 10000,
    source,
    legacyRecordSpendUsd: Math.round(legacyUsd * 10000) / 10000,
  };
}

async function safeHashGetAll(key: string): Promise<Record<string, string> | null> {
  try {
    return await hashGetAll(key);
  } catch (err: any) {
    console.error(`[cost-surrogate] hashGetAll ${key} failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Per-cycle surrogate cost in USD. Returns 0 when no tokens recorded for the
 * cycle or no rate configured.
 *
 * Used by `cost/cap.ts:getCycleCostWithSurrogateUsd()` so the per-cycle cap
 * can include post-cut subagent spend without breaking the legacy codex
 * `getCycleCostMicrodollars()` reader.
 */
export async function getCycleSubagentCostUsd(cycleId: string): Promise<{
  tokens: number;
  costUsd: number;
  ratePerMillion: number;
}> {
  if (!cycleId) return { tokens: 0, costUsd: 0, ratePerMillion: getTokenUsdRate() };
  const tokens = await readCycleTokens(cycleId);
  const ratePerMillion = getTokenUsdRate();
  const costUsd = tokensToUsd(tokens, ratePerMillion);
  return {
    tokens,
    ratePerMillion,
    costUsd: Math.round(costUsd * 10000) / 10000,
  };
}
