/**
 * Cost & spend Redis seam — ADR-0009 closure follow-up.
 *
 * Owns two surfaces:
 *
 *   1. Subagent token spend surrogate (issue #394). Counters that the
 *      autopilot reap path writes via `recordSubagentTokens()` and that
 *      `/api/metrics/cost` reads via `getDailySpendSurrogate()`.
 *
 *   2. Daily cost-reconciliation snapshots (issue #460-ish). Per-date
 *      records of (Codex log USD vs scheduler USD vs metrics USD) so an
 *      operator can answer "do our three cost sources agree?".
 *
 * Key shapes live here (in the seam module) rather than in the callers,
 * per ADR-0009.
 */

import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Token-spend surrogate key shapes
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

// ---------------------------------------------------------------------------
// Token-spend surrogate accessors
// ---------------------------------------------------------------------------

/** Read the autopilot daily-total tokens INT string. Returns null when unset. */
export async function getAutopilotDailyTokensRaw(date: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(tokensAutopilotDailyKey(date));
}

/** Read a single skill's tokens for `date`. Returns null when unset. */
export async function getSkillTokensRaw(date: string, skill: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(tokensBySkillDailyKey(date), skill);
}

/** Read the full per-skill breakdown for `date` as a Redis hash. */
export async function getSkillTokensAll(date: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(tokensBySkillDailyKey(date));
}

/** Read a cycle's `tokens` field. Returns null when unset. */
export async function getCycleTokensRaw(cycleId: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.hget(tokensByCycleKey(cycleId), "tokens");
}

export interface IncrTokensBatchInput {
  date: string;
  skill: string;
  tokens: number;
  cycleId?: string;
  dailyTtlSeconds: number;
  cycleTtlSeconds: number;
}

export interface IncrTokensBatchResult {
  dailyTotal: number;
  skillTotal: number;
  cycleTotal: number | null;
}

/**
 * Pipelined token-spend write: bumps the per-day total, per-day per-skill
 * breakdown, and (optionally) the per-cycle hash in a single round-trip.
 * Returns the new totals for each counter. Best-effort by design — a Redis
 * outage yields zeros rather than throwing.
 */
export async function incrTokensBatch(input: IncrTokensBatchInput): Promise<IncrTokensBatchResult> {
  const { date, skill, tokens, cycleId, dailyTtlSeconds, cycleTtlSeconds } = input;
  const dailyKey = tokensAutopilotDailyKey(date);
  const bySkillKey = tokensBySkillDailyKey(date);
  const r = getRedisConnection();
  const pipe = r.pipeline();
  pipe.incrby(dailyKey, tokens);
  pipe.expire(dailyKey, dailyTtlSeconds);
  pipe.hincrby(bySkillKey, skill, tokens);
  pipe.expire(bySkillKey, dailyTtlSeconds);

  let cycleHashKey: string | null = null;
  if (cycleId) {
    cycleHashKey = tokensByCycleKey(cycleId);
    pipe.hincrby(cycleHashKey, "tokens", tokens);
    pipe.hset(cycleHashKey, "skill", skill);
    pipe.expire(cycleHashKey, cycleTtlSeconds);
  }

  const results = await pipe.exec();
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
  return { dailyTotal, skillTotal, cycleTotal };
}

// (Reconciliation accessors removed alongside `src/cost/reconciliation.ts`
// — the codex-JSONL replay they backed is dead post-ADR-0006. Residual
// `hydra:cost:reconciliation:*` keys self-expire at their 30-day TTL.)
