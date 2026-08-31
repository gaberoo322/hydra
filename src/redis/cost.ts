/**
 * Cost & spend Redis seam — ADR-0009 closure follow-up.
 *
 * Owns three surfaces (issue #4126: dispatch-cost-join is surface 3, below):
 *
 *   1. Subagent token spend surrogate (issue #394). Counters that the
 *      autopilot reap path writes via `recordSubagentTokens()` and that
 *      `/api/metrics/cost` reads via `getDailySpendSurrogate()`.
 *
 *   2. Daily cost-reconciliation snapshots (issue #460-ish). Per-date
 *      records of (Codex log USD vs scheduler USD vs metrics USD) so an
 *      operator can answer "do our three cost sources agree?".
 *
 *   3. Dispatch -> issue cost-join ledger (issue #4126, ADR-0032 epic #4123
 *      slice gamma). See the `DispatchCostJoinRecord` docstring below.
 *
 * Key shapes live here (in the seam module) rather than in the callers,
 * per ADR-0009.
 */

import { getRedisConnection } from "./connection.ts";
import { boundedJsonList } from "./bounded-list.ts";

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

// ---------------------------------------------------------------------------
// Dispatch -> issue cost-join ledger (issue #4126, ADR-0032 epic #4123 slice
// gamma — the prerequisite for the A/B primary endpoint)
// ---------------------------------------------------------------------------

/** Max join records retained per issue (bounded, newest-first). */
const DISPATCH_COST_JOIN_PER_ISSUE_MAX = 200;
/** Max unattributable join records retained (bounded, newest-first). */
const DISPATCH_COST_JOIN_UNATTRIBUTED_MAX = 500;
/** TTL (seconds) refreshed on every write — issue #4126 INV-8: this ledger is
 *  reconstructible accounting data, not a permanent record. */
const DISPATCH_COST_JOIN_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * One durable dispatch -> issue cost-join record. Written once per completed
 * dispatch at reap time (`scripts/autopilot/reap.py`'s `run_completion`,
 * alongside the existing `_fire_token_record` per-cycle write) via
 * `POST /api/usage/dispatch-cost` (`src/api/usage.ts`).
 *
 * Closes the gap #4126 documents: `/api/usage/by-issue` / `/api/cost/by-issue`
 * / `/api/dispatch/attribution` all 404'd, so Anthropic weighted-quota tokens
 * could not be joined back to the issue a dispatch worked on. This record IS
 * that join key — issue + class + dispatch kind + a token figure, keyed by
 * when reap observed the completion.
 *
 * `dispatchTokensEstimate` is honestly named (issue #4126's first open
 * question — "name the field honestly if it is a bounded estimate"): it is
 * `total_tokens` as reap already computes it for the completing dispatch's
 * OWN session — its SubagentStop-hook count, or, on the #3250 recovery path,
 * the transcript-scan-recovered replacement for a zero hook floor. That is
 * the dispatch's own session usage, NEVER a time-sliced share of a wider
 * window (the answer to the question: own-session usage, not a slice). It is
 * itself NOT model-family Quota-Weighted — see `weightedQuotaTokensEstimate`
 * below for the derived figure that is.
 *
 * `weightedQuotaTokensEstimate` (issue #4126 INV-2) IS the quota-weighted
 * figure: `POST /api/usage/dispatch-cost` (`src/api/usage.ts`) splits
 * `dispatchTokensEstimate` across model families using the `skill`'s 7-day
 * `UsageSnapshot.bySkillByModel` mix (from the already-memoized `getUsage()`
 * snapshot) via `projectWeightedQuotaTokensEstimate`
 * (`src/cost/cost-attribution.ts`), then applies the calibrated per-family
 * Quota-Weight — the SAME `getQuotaWeightOpus/Sonnet/Haiku` +
 * `familyWeight` machinery `getRollingCostByClass` already uses. When the
 * skill has no 7-day mix yet (cold start) or the env weights are not all
 * calibrated, it degrades to `dispatchTokensEstimate` (identity, weight
 * 1.0) rather than fabricating a split from nothing. `quotaWeightCalibrated`
 * carries the SAME all-three-env-vars-positive gate `getRollingCostByClass`
 * computes, so a reader never mistakes an uncalibrated identity pass-through
 * for a precise per-dispatch measurement.
 *
 * `issue` is `null` for a completion reap could not resolve to an anchor
 * issue (a signal class with no anchor, or a pipeline dispatch whose anchor
 * deposit was never written) — recorded into the UNATTRIBUTED ledger
 * (`getUnattributedDispatchCostJoin`) rather than silently dropped, so the
 * read surface can publish an honest residual (issue #4126's third open
 * question) instead of undercounting.
 *
 * `dispatchKind` mirrors `src/cost/token-breakdown.ts`'s `DispatchKind`
 * vocabulary as a plain string (this module deliberately does not import that
 * Cost-module pure leaf — it stays a Redis-seam file). In practice every
 * record reap produces carries `"autopilot-dispatched"`: `run_completion`
 * only ever fires for a dispatch `decide.py` itself launched, so it can never
 * observe an `operator-invoked` or `interactive` session — those come from
 * the transcript-scan side of the Cost module, not the reap side. The field
 * is still carried (not hardcoded away here) so a future non-reap producer
 * can join into the SAME ledger without a shape change.
 *
 * This is how issue #4126's second open question resolves without any
 * special-casing: a GLM-arm issue's initial coding dispatch runs outside this
 * ledger (the GLM drainer isn't reap.py), but that issue's later
 * Anthropic-side `qa_orch` / `sweep_orch` completions DO run through
 * `run_completion` like any other class, so they append their own record
 * under the SAME issue number — the by-issue read surface sums across every
 * class that touched an issue, so a GLM-arm issue's real relief-reducing
 * Anthropic cost is visible rather than reading as free.
 */
export interface DispatchCostJoinRecord {
  /** Anchor issue number, or `null` when reap could not resolve one. */
  issue: number | null;
  /** Dispatch class, e.g. `dev_orch` / `qa_orch` / `sweep_orch` (the raw
   *  Dispatch-Class Taxonomy name — NOT the coarser `CostClass` bucket). */
  class: string;
  /** See docstring above — almost always `"autopilot-dispatched"`. */
  dispatchKind: string;
  /** See docstring above — a bounded estimate, not a quota-weighted figure. */
  dispatchTokensEstimate: number;
  /** The `bySkillByModel` cross-tab key reap resolved for this dispatch (e.g.
   *  `hydra-dev`), or `null` when reap did not supply one. Consumed by
   *  `POST /api/usage/dispatch-cost` to compute `weightedQuotaTokensEstimate`
   *  — carried on the record too so a later reader can see which skill's mix
   *  produced it. */
  skill: string | null;
  /** See docstring above — the family-split, Quota-Weight-applied estimate.
   *  Equal to `dispatchTokensEstimate` (identity) when `quotaWeightCalibrated`
   *  is false or no 7-day mix was available for `skill`. */
  weightedQuotaTokensEstimate: number;
  /** True only when all three `HYDRA_QUOTA_WEIGHT_*` env vars are positive —
   *  the SAME calibration gate `getRollingCostByClass` uses. False means
   *  `weightedQuotaTokensEstimate` is an uncalibrated identity pass-through,
   *  not a real per-family weighting. */
  quotaWeightCalibrated: boolean;
  /** ISO8601 timestamp the recording route stamped (not reap's clock). */
  reapedAt: string;
}

function dispatchCostJoinByIssueKey(issue: number): string {
  return `hydra:cost:dispatch-join:by-issue:${issue}`;
}

function dispatchCostJoinIssueIndexKey(): string {
  return "hydra:cost:dispatch-join:issue-index";
}

function dispatchCostJoinUnattributedKey(): string {
  return "hydra:cost:dispatch-join:unattributed";
}

export type RecordDispatchCostJoinResult =
  | { ok: true; attributed: boolean }
  | { ok: false; error: string };

/**
 * Type-predicate guard for the failure arm of {@link RecordDispatchCostJoinResult}
 * (issue #4126). Mirrors `isGlmAbAssignmentWriteFailure` (`src/redis/autopilot.ts`):
 * this repo's tsconfig runs with `strict: false` (no `strictNullChecks`), under
 * which plain `if (!res.ok)` does NOT reliably narrow a discriminated union at
 * call sites — an explicit `res is {...}` predicate is the established
 * workaround.
 */
export function isDispatchCostJoinWriteFailure(
  res: RecordDispatchCostJoinResult,
): res is { ok: false; error: string } {
  return res.ok === false;
}

/**
 * Durably record one dispatch -> issue cost-join row (issue #4126). Best-
 * effort: a Redis fault is caught and returned as a structured failure,
 * never thrown — this is an accounting write, not a merge/verification gate
 * (CLAUDE.md: never throw from merge/grounding/verification; this generalizes
 * the same posture to accounting writes on the reap hot path).
 *
 * `record.issue` present (positive int) -> appended to that issue's bounded
 * ledger AND the issue is added to the issue-index SET (so a reader can
 * enumerate every issue with recorded cost without a Redis KEYS scan).
 * `record.issue` null -> appended to the UNATTRIBUTED ledger instead, so an
 * unattributable dispatch is reported as an explicit residual rather than
 * dropped.
 */
export async function recordDispatchCostJoin(
  record: DispatchCostJoinRecord,
): Promise<RecordDispatchCostJoinResult> {
  try {
    const r = getRedisConnection();
    if (record.issue !== null && Number.isInteger(record.issue) && record.issue > 0) {
      const key = dispatchCostJoinByIssueKey(record.issue);
      await boundedJsonList<DispatchCostJoinRecord>(key, DISPATCH_COST_JOIN_PER_ISSUE_MAX).push(record);
      // INV-8: refreshed (not one-time) TTL — every write pushes the expiry
      // forward another 30 days, so an issue with recurring dispatches never
      // silently expires mid-ledger.
      await r.expire(key, DISPATCH_COST_JOIN_TTL_SECONDS);
      await r.sadd(dispatchCostJoinIssueIndexKey(), String(record.issue));
      return { ok: true, attributed: true };
    }
    const unattributedKey = dispatchCostJoinUnattributedKey();
    await boundedJsonList<DispatchCostJoinRecord>(unattributedKey, DISPATCH_COST_JOIN_UNATTRIBUTED_MAX).push({
      ...record,
      issue: null,
    });
    await r.expire(unattributedKey, DISPATCH_COST_JOIN_TTL_SECONDS);
    return { ok: true, attributed: false };
  } catch (err: any) {
    return {
      ok: false,
      error: `[cost] recordDispatchCostJoin failed: ${err?.message || String(err)}`,
    };
  }
}

/** Read every recorded issue number with a cost-join ledger (issue #4126). */
export async function listDispatchCostJoinIssues(): Promise<number[]> {
  const r = getRedisConnection();
  const raw = await r.smembers(dispatchCostJoinIssueIndexKey());
  return raw
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

/** Read one issue's recorded cost-join ledger, newest-first (issue #4126). */
export async function getDispatchCostJoinForIssue(
  issue: number,
  limit?: number,
): Promise<DispatchCostJoinRecord[]> {
  return boundedJsonList<DispatchCostJoinRecord>(
    dispatchCostJoinByIssueKey(issue),
    DISPATCH_COST_JOIN_PER_ISSUE_MAX,
  ).read(limit);
}

/**
 * Read the unattributable-dispatch residual ledger, newest-first (issue
 * #4126) — the honest "we could not join this dispatch to an issue" record,
 * never silently dropped.
 */
export async function getUnattributedDispatchCostJoin(
  limit?: number,
): Promise<DispatchCostJoinRecord[]> {
  return boundedJsonList<DispatchCostJoinRecord>(
    dispatchCostJoinUnattributedKey(),
    DISPATCH_COST_JOIN_UNATTRIBUTED_MAX,
  ).read(limit);
}
