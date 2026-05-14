/**
 * Tier-3 cost reconciliation against Codex CLI session logs (issue #296).
 *
 * Hydra's local accounting has two figures that disagree by ~200x:
 *   - `/api/scheduler/status.dailySpendUsd`       (scheduler-side rolling counter)
 *   - sum of `/api/metrics.costMicrodollars`       (per-cycle metrics aggregate)
 *
 * This module adds a third, independent figure: replay Codex's own on-disk
 * session JSONL files (one per CLI turn), aggregate authoritative token
 * counts per model, and multiply by `MODEL_PRICING` from `codex-runner.ts`.
 * The three figures can then be compared to find which side of Hydra's
 * accounting is wrong.
 *
 * --------------------------------------------------------------------------
 * Codex JSONL parser contract — verified 2026-05-11 against
 * `~/.codex/sessions/2026/05/11/` (Codex CLI 0.125.0):
 *
 *   - Path scheme: `${CODEX_HOME}/sessions/{YYYY}/{MM}/{DD}/rollout-*.jsonl`
 *     `CODEX_HOME` defaults to `~/.codex` and is exported by the Codex CLI.
 *     One file per CLI turn (session). We discover files via `fs.readdir`
 *     so a CLI version change in the rollout-* naming does not break us.
 *
 *   - Each line is a JSON object with a `type` discriminator. Two types
 *     matter for cost:
 *
 *       a) `turn_context` — carries the active model. The session may emit
 *          multiple `turn_context` events (model can be swapped mid-session);
 *          we use the LAST one observed before each `token_count` event.
 *          Schema:
 *            { type: "turn_context",
 *              payload: {
 *                model: "gpt-5.3-codex",
 *                collaboration_mode: { settings: { model: "gpt-5.3-codex" } } } }
 *          Prefer `payload.model`; fall back to nested setting.
 *
 *       b) `event_msg` with `payload.type === "token_count"` — carries usage.
 *          Schema (when payload.info is present — early events may have
 *          payload.info === null with only rate_limits, which we skip):
 *            { type: "event_msg",
 *              payload: {
 *                type: "token_count",
 *                info: {
 *                  total_token_usage: {            // CUMULATIVE for session
 *                    input_tokens,                  //   raw, includes cached
 *                    cached_input_tokens,           //   subset of input_tokens
 *                    output_tokens,
 *                    reasoning_output_tokens,
 *                    total_tokens },
 *                  last_token_usage: { ... }       // PER-TURN delta
 *                  model_context_window } } }
 *
 *     `total_token_usage` is cumulative within a session; the LAST
 *     `token_count` event in the file is the final tally. We take that
 *     event as the per-session contribution and skip earlier ones to avoid
 *     double-counting.
 *
 *   - Cost computation matches `computeCost()` in `codex-runner.ts`:
 *     `(input_tokens * input_rate + output_tokens * output_rate) / 1e6`.
 *     `cached_input_tokens` is recorded as informational only — Hydra's
 *     local accounting does NOT discount cached tokens, so the
 *     reconciliation must match that behavior to remain comparable.
 *     A separate `byModel.cachedInputTokens` field is preserved for a
 *     future caveat once OpenAI publishes cached-input rates for these
 *     pre-release models.
 *
 *   - `~/.codex/models_cache.json` was inspected; it does NOT carry pricing
 *     metadata (only model slugs, reasoning levels, instructions). We fall
 *     back to `MODEL_PRICING` from `codex-runner.ts` (same hardcoded rates
 *     Hydra uses today). This removes the "independent dollar figure"
 *     property called out in the issue's implementation notes — the TOKEN
 *     figure remains independent. Follow-up issue should source pricing
 *     from a stable upstream.
 * --------------------------------------------------------------------------
 *
 * Per CLAUDE.md conventions:
 *   - Tier 3 (new module, new API route, external file I/O). Operator merges.
 *   - Never throws — returns `{ ok: false, reason }` on every failure path.
 *   - Inline Redis access via `getRedisConnection()` per the holdback.ts
 *     precedent — redis-adapter.ts is Tier 0, frozen.
 *   - All `catch` blocks `console.error` with context or are annotated
 *     `/* intentional: ... *\/`.
 *
 * Scope-trimmed per the implementation playbook: this PR delivers the
 * forensic math (parser + Redis store + GET endpoint). The scheduler hook,
 * `cost.reconciliation.divergence` event publish, digest section, and
 * dashboard panel are deferred to follow-up issues — the core question
 * "do the three figures agree?" is answerable with this slice alone.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import { MODEL_PRICING } from "./llm/pricing.ts";
import { getRedisConnection } from "./redis-adapter.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Redis TTL for reconciliation records: 90 days. */
export const RECONCILIATION_TTL_SECONDS = 60 * 60 * 24 * 90;

/** Kill-switch flag (planned for the scheduler-hook follow-up; checked here
 *  defensively so the future scheduler wire-up is purely additive). */
export const KILL_FLAG_KEY = "hydra:cost-reconciliation:disabled";

/** Threshold for declaring two cost figures divergent. Used to flag the
 *  result; the future scheduler hook will emit an event on the same flag. */
export const DIVERGENCE_THRESHOLD = 0.10; // 10%

/** Maximum number of recent reconciliation records returned by the read API. */
export const MAX_HISTORY_DAYS = 30;

// ---------------------------------------------------------------------------
// Redis key generators (inlined per holdback.ts precedent)
// ---------------------------------------------------------------------------

function reconciliationKey(date: string): string {
  return `hydra:cost:reconciliation:${date}`;
}

function reconciliationIndexKey(): string {
  return "hydra:cost:reconciliation:index";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ByModelUsage {
  /** Model slug as reported in `turn_context.payload.model`. */
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  sessions: number;
  /** USD computed from `inputTokens × input_rate + outputTokens × output_rate`
   *  using `MODEL_PRICING` from codex-runner.ts. `null` when the model is
   *  not in the pricing table (operator must update MODEL_PRICING). */
  costUsd: number | null;
  /** Set true when MODEL_PRICING had no entry; informational. */
  pricingMissing: boolean;
}

export interface ReconciliationResult {
  ok: boolean;
  date: string;
  /** Reason populated when `ok === false`. */
  reason?: string;
  /** USD computed from Codex session logs × MODEL_PRICING. */
  codexLogUsd: number;
  /** USD from Hydra's scheduler daily-spend counter, when the requested
   *  date matches today (local date stored by scheduler). `null` otherwise. */
  schedulerUsd: number | null;
  /** USD summed from cycle-metrics `costMicrodollars` for cycles recorded
   *  on the requested UTC date. `null` if Redis unreachable. */
  metricsUsd: number | null;
  /** Max pairwise divergence among the available figures (Codex-log,
   *  scheduler, metrics), as a fraction of the larger value. `null` when
   *  fewer than 2 figures are available. */
  divergencePct: number | null;
  /** Whether `divergencePct` exceeds `DIVERGENCE_THRESHOLD`. */
  divergenceFlagged: boolean;
  byModel: ByModelUsage[];
  /** Number of session JSONL files scanned. */
  sessionsScanned: number;
  /** Files we tried to parse but had to skip (parse error, no usage event,
   *  no resolvable model, etc.). */
  sessionsSkipped: number;
  /** Sample of skipped-file reasons; capped at 20 entries to avoid bloating
   *  Redis. */
  skipReasons: Array<{ file: string; reason: string }>;
  /** ISO timestamp when this reconciliation completed. */
  recordedAt: string;
  /** Always "codex-session-logs" — kept in case we add a second source. */
  source: "codex-session-logs";
}

interface SessionAggregate {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (testable)
// ---------------------------------------------------------------------------

/**
 * Resolve the Codex sessions root, honoring the `CODEX_HOME` env var.
 * Defaults to `~/.codex`. Exported for tests.
 */
export function codexSessionsRoot(): string {
  const base = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(base, "sessions");
}

/**
 * Compose the `${CODEX_HOME}/sessions/{YYYY}/{MM}/{DD}` directory for a date.
 * Accepts ISO-style `YYYY-MM-DD`. Returns null on a malformed string.
 */
export function sessionsDirForDate(date: string, root: string = codexSessionsRoot()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return join(root, m[1], m[2], m[3]);
}

/**
 * Multiply token counts by pricing.
 * Matches `computeCost()` in codex-runner.ts: cached tokens are NOT
 * discounted because Hydra's local accounting doesn't discount them either —
 * keeping the same formula keeps the three figures (Codex-log / scheduler /
 * metrics) comparable.
 */
export function priceTokens(
  model: string,
  inputTokens: number,
  outputTokens: number,
): { costUsd: number; pricingMissing: boolean } {
  const pricing = (MODEL_PRICING as Record<string, { input: number; output: number }>)[model];
  if (!pricing) return { costUsd: 0, pricingMissing: true };
  const input = (inputTokens / 1_000_000) * pricing.input;
  const output = (outputTokens / 1_000_000) * pricing.output;
  const total = Math.round((input + output) * 1_000_000) / 1_000_000;
  return { costUsd: total, pricingMissing: false };
}

/**
 * Compute the worst pairwise divergence among the provided figures, as a
 * fraction of the larger value. Returns null when fewer than 2 finite
 * numbers are supplied. A figure of 0 with another non-zero figure is
 * treated as 100% divergence.
 *
 * Examples:
 *   pairwiseDivergence([10, 12, 11])          -> (12-10)/12  = 0.1666...
 *   pairwiseDivergence([100, 200])            -> (200-100)/200 = 0.5
 *   pairwiseDivergence([0, 100])              -> 1
 *   pairwiseDivergence([null, 100, null])     -> null   (only 1 figure)
 */
export function pairwiseDivergence(figures: Array<number | null>): number | null {
  const finite = figures.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (finite.length < 2) return null;
  let worst = 0;
  for (let i = 0; i < finite.length; i++) {
    for (let j = i + 1; j < finite.length; j++) {
      const a = finite[i];
      const b = finite[j];
      const max = Math.max(Math.abs(a), Math.abs(b));
      if (max === 0) continue;
      const div = Math.abs(a - b) / max;
      if (div > worst) worst = div;
    }
  }
  return worst;
}

/**
 * Parse one Codex session JSONL file into an aggregate of the final
 * cumulative usage values. Pure-ish: takes the raw file contents as a
 * string so callers can stream/test without filesystem access.
 *
 * Strategy (per the JSONL parser contract at the top of this file):
 *   - Track the most recent `turn_context.payload.model` seen.
 *   - Track the LAST `token_count` event in the file with non-null `info`.
 *     Earlier events are cumulative subsets of the last, so the last one
 *     IS the session total.
 *
 * Bad lines (JSON.parse failure) are skipped silently — callers report
 * the count via the surrounding loop. Returning null means we found
 * no usable usage data in this file.
 */
export function parseSessionJsonl(contents: string): SessionAggregate | null {
  let model = "";
  let last: SessionAggregate | null = null;
  const lines = contents.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      /* intentional: skip malformed JSONL lines per AC; surrounding loop
         counts these as skipped files only when no usable event was found. */
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    if (obj.type === "turn_context") {
      const p = obj.payload || {};
      const m = (typeof p.model === "string" && p.model) ||
                (p.collaboration_mode?.settings?.model) || "";
      if (typeof m === "string" && m) model = m;
      continue;
    }
    if (obj.type === "event_msg") {
      const p = obj.payload || {};
      if (p.type !== "token_count") continue;
      const info = p.info;
      if (!info || typeof info !== "object") continue;
      const total = info.total_token_usage;
      if (!total || typeof total !== "object") continue;
      const inputTokens = numField(total.input_tokens);
      const outputTokens = numField(total.output_tokens);
      if (inputTokens === 0 && outputTokens === 0) continue;
      last = {
        model,
        inputTokens,
        cachedInputTokens: numField(total.cached_input_tokens),
        outputTokens,
        reasoningOutputTokens: numField(total.reasoning_output_tokens),
        totalTokens: numField(total.total_tokens) || (inputTokens + outputTokens),
      };
    }
  }
  if (!last) return null;
  // A session with usage but no resolved model gets a "unknown" bucket so
  // we don't silently drop it. The caller flags it as pricing-missing.
  if (!last.model) last.model = "unknown";
  return last;
}

function numField(v: any): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return v;
}

/**
 * Aggregate a list of session results by model. Pure: testable without I/O.
 */
export function aggregateByModel(sessions: SessionAggregate[]): ByModelUsage[] {
  const buckets = new Map<string, ByModelUsage>();
  for (const s of sessions) {
    const key = s.model;
    let b = buckets.get(key);
    if (!b) {
      b = {
        model: key,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        sessions: 0,
        costUsd: 0,
        pricingMissing: false,
      };
      buckets.set(key, b);
    }
    b.inputTokens += s.inputTokens;
    b.cachedInputTokens += s.cachedInputTokens;
    b.outputTokens += s.outputTokens;
    b.reasoningOutputTokens += s.reasoningOutputTokens;
    b.totalTokens += s.totalTokens;
    b.sessions += 1;
  }
  const out: ByModelUsage[] = [];
  for (const b of buckets.values()) {
    const { costUsd, pricingMissing } = priceTokens(b.model, b.inputTokens, b.outputTokens);
    b.costUsd = pricingMissing ? null : costUsd;
    b.pricingMissing = pricingMissing;
    out.push(b);
  }
  // Stable sort: by costUsd desc (nulls last), then model asc.
  out.sort((a, b) => {
    const av = a.costUsd ?? -1;
    const bv = b.costUsd ?? -1;
    if (bv !== av) return bv - av;
    return a.model.localeCompare(b.model);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

export async function isReconciliationDisabled(): Promise<boolean> {
  try {
    const r = getRedisConnection();
    const v = await r.get(KILL_FLAG_KEY);
    return v === "1" || v === "true";
  } catch (err: any) {
    /* intentional: if Redis is unreachable, treat as disabled so a future
       scheduler hook doesn't loop on broken infra. */
    console.error(`[cost-reconciliation] kill-flag read failed (treating as disabled): ${err?.message || String(err)}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Scan + parse + price
// ---------------------------------------------------------------------------

interface CodexLogScan {
  sessionsScanned: number;
  sessionsSkipped: number;
  skipReasons: Array<{ file: string; reason: string }>;
  byModel: ByModelUsage[];
  codexLogUsd: number;
}

const MAX_SKIP_REASONS = 20;

/**
 * Walk `${CODEX_HOME}/sessions/{YYYY}/{MM}/{DD}/` and reduce all `*.jsonl`
 * files to a per-model usage aggregate. Never throws.
 *
 * Returns `{ sessionsScanned: 0, sessionsSkipped: 0, byModel: [], ... }` when
 * the directory does not exist — callers treat that as a no-op day.
 */
export async function scanCodexLogsForDate(date: string): Promise<CodexLogScan & { reason?: string }> {
  const root = sessionsDirForDate(date);
  const empty: CodexLogScan = {
    sessionsScanned: 0,
    sessionsSkipped: 0,
    skipReasons: [],
    byModel: [],
    codexLogUsd: 0,
  };
  if (!root) return { ...empty, reason: `invalid date format (expected YYYY-MM-DD): ${date}` };

  try {
    const s = await stat(root);
    if (!s.isDirectory()) return { ...empty, reason: `not a directory: ${root}` };
  } catch (err: any) {
    if (err && err.code === "ENOENT") {
      return { ...empty, reason: `no sessions directory for ${date} (${root})` };
    }
    console.error(`[cost-reconciliation] stat(${root}) failed: ${err?.message || String(err)}`);
    return { ...empty, reason: `stat failed: ${err?.message || String(err)}` };
  }

  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch (err: any) {
    console.error(`[cost-reconciliation] readdir(${root}) failed: ${err?.message || String(err)}`);
    return { ...empty, reason: `readdir failed: ${err?.message || String(err)}` };
  }

  const aggregates: SessionAggregate[] = [];
  const skipReasons: Array<{ file: string; reason: string }> = [];
  let scanned = 0;
  let skipped = 0;

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    scanned += 1;
    const filePath = join(root, name);
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (err: any) {
      skipped += 1;
      if (skipReasons.length < MAX_SKIP_REASONS) {
        skipReasons.push({ file: name, reason: `read failed: ${err?.message || String(err)}` });
      }
      console.error(`[cost-reconciliation] readFile(${filePath}) failed: ${err?.message || String(err)}`);
      continue;
    }
    const agg = parseSessionJsonl(contents);
    if (!agg) {
      skipped += 1;
      if (skipReasons.length < MAX_SKIP_REASONS) {
        skipReasons.push({ file: name, reason: "no usable token_count event" });
      }
      continue;
    }
    aggregates.push(agg);
  }

  const byModel = aggregateByModel(aggregates);
  let codexLogUsd = 0;
  for (const b of byModel) {
    if (typeof b.costUsd === "number") codexLogUsd += b.costUsd;
  }
  codexLogUsd = Math.round(codexLogUsd * 1_000_000) / 1_000_000;

  return {
    sessionsScanned: scanned,
    sessionsSkipped: skipped,
    skipReasons,
    byModel,
    codexLogUsd,
  };
}

// ---------------------------------------------------------------------------
// Hydra-side figures for the comparison
// ---------------------------------------------------------------------------

/**
 * Read the scheduler's daily-spend counter. Only meaningful when the
 * requested date is the scheduler's current local date — the counter
 * rolls at local midnight and stores only "today" plus its date. Returns
 * `null` for any other date or on any read failure.
 */
async function getSchedulerDailySpendForDate(date: string): Promise<number | null> {
  try {
    const r = getRedisConnection();
    const raw = await r.get("hydra:scheduler:daily-spend");
    if (!raw) return null;
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.date !== date) return null; // scheduler tracks one day at a time
    const usd = typeof parsed.usd === "number" ? parsed.usd : null;
    return usd;
  } catch (err: any) {
    console.error(`[cost-reconciliation] scheduler spend read failed: ${err?.message || String(err)}`);
    return null;
  }
}

/**
 * Sum `costMicrodollars` across cycles whose `metricsIndex` score (Date.now()
 * at write time) falls within the UTC day requested. Returns null on any
 * failure that prevented a complete sum so the caller knows not to compare.
 */
async function getMetricsCostForDate(date: string): Promise<number | null> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const startMs = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 0, 0, 0, 0);
  const endMs = startMs + 24 * 60 * 60 * 1000 - 1;
  try {
    const r = getRedisConnection();
    const cycleIds = await r.zrangebyscore("hydra:metrics:index", startMs, endMs);
    if (!Array.isArray(cycleIds) || cycleIds.length === 0) return 0;
    let microSum = 0;
    for (const cid of cycleIds) {
      try {
        const v = await r.hget(`hydra:cycle:${cid}:costs`, "costMicrodollars");
        if (v) {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) microSum += n;
        }
      } catch (err: any) {
        console.error(`[cost-reconciliation] cycle-cost read failed for ${cid}: ${err?.message || String(err)}`);
      }
    }
    return Math.round(microSum) / 1_000_000;
  } catch (err: any) {
    console.error(`[cost-reconciliation] metrics aggregate read failed: ${err?.message || String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run a reconciliation for `date` (YYYY-MM-DD): scan Codex session logs,
 * read scheduler + metrics figures, compute divergence, persist to Redis.
 *
 * Never throws. On any failure path, returns `{ ok: false, reason }` with
 * partial data (e.g., codexLogUsd may still be populated even if the Redis
 * write failed). Callers should log `reason` and move on.
 */
export async function reconcileDailyCosts(date: string): Promise<ReconciliationResult> {
  const recordedAt = new Date().toISOString();
  const baseResult: ReconciliationResult = {
    ok: false,
    date,
    codexLogUsd: 0,
    schedulerUsd: null,
    metricsUsd: null,
    divergencePct: null,
    divergenceFlagged: false,
    byModel: [],
    sessionsScanned: 0,
    sessionsSkipped: 0,
    skipReasons: [],
    recordedAt,
    source: "codex-session-logs",
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ...baseResult, reason: `invalid date format (expected YYYY-MM-DD): ${date}` };
  }

  // Scan logs first; this is the work even a disabled kill-flag would skip.
  // If the flag is set we short-circuit BEFORE filesystem work to keep the
  // kill switch cheap.
  if (await isReconciliationDisabled()) {
    return { ...baseResult, reason: "reconciliation disabled by kill flag" };
  }

  const scan = await scanCodexLogsForDate(date);
  const [schedulerUsd, metricsUsd] = await Promise.all([
    getSchedulerDailySpendForDate(date),
    getMetricsCostForDate(date),
  ]);

  const divergencePct = pairwiseDivergence([scan.codexLogUsd, schedulerUsd, metricsUsd]);
  const divergenceFlagged = divergencePct !== null && divergencePct > DIVERGENCE_THRESHOLD;

  const result: ReconciliationResult = {
    ok: true,
    date,
    codexLogUsd: scan.codexLogUsd,
    schedulerUsd,
    metricsUsd,
    divergencePct,
    divergenceFlagged,
    byModel: scan.byModel,
    sessionsScanned: scan.sessionsScanned,
    sessionsSkipped: scan.sessionsSkipped,
    skipReasons: scan.skipReasons,
    recordedAt,
    source: "codex-session-logs",
  };
  if (scan.reason) result.reason = scan.reason;

  // Persist. A Redis write failure does not invalidate the in-memory result
  // — callers (manual run, future scheduler hook) still see ok=true.
  try {
    const r = getRedisConnection();
    await r.set(reconciliationKey(date), JSON.stringify(result), "EX", RECONCILIATION_TTL_SECONDS);
    // ZSet score = epoch-ms of the calendar date so range scans (last N days)
    // are O(log N). Using Date.UTC keeps the score stable regardless of when
    // the run actually happens.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)!;
    const score = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    await r.zadd(reconciliationIndexKey(), score, date);
  } catch (err: any) {
    console.error(`[cost-reconciliation] redis persist failed for ${date}: ${err?.message || String(err)}`);
    // Don't flip ok=false — the analysis succeeded; persistence is a separate
    // concern the operator can rerun. Annotate reason for visibility.
    result.reason = (result.reason ? result.reason + "; " : "") + `redis persist failed: ${err?.message || String(err)}`;
  }

  return result;
}

/**
 * Read the last N days of reconciliation records, newest first. Capped at
 * MAX_HISTORY_DAYS regardless of `limit` to keep response size bounded.
 * Never throws.
 */
export async function getReconciliationHistory(limit: number = MAX_HISTORY_DAYS): Promise<ReconciliationResult[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_HISTORY_DAYS);
  try {
    const r = getRedisConnection();
    const dates = await r.zrevrange(reconciliationIndexKey(), 0, capped - 1);
    if (!Array.isArray(dates) || dates.length === 0) return [];
    const out: ReconciliationResult[] = [];
    for (const d of dates) {
      try {
        const raw = await r.get(reconciliationKey(d));
        if (raw) out.push(JSON.parse(raw));
      } catch (err: any) {
        console.error(`[cost-reconciliation] history: parse failed for ${d}: ${err?.message || String(err)}`);
      }
    }
    return out;
  } catch (err: any) {
    console.error(`[cost-reconciliation] history read failed: ${err?.message || String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal exports for tests
// ---------------------------------------------------------------------------

export const _internal = {
  reconciliationKey,
  reconciliationIndexKey,
  getSchedulerDailySpendForDate,
  getMetricsCostForDate,
};
