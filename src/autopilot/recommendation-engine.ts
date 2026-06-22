/**
 * Autopilot recommendation engine — slice F of #667 (issue #674).
 *
 * Subscribes to `turn_end` events on the `hydra:autopilot:slot-events`
 * stream (slice A, #668), fires AT MOST one claude-haiku-4-5 call per
 * turn, gated on:
 *
 *   1. ≥30s since the last call for this run
 *   2. Material change since the last call — defined as one of:
 *        - new dispatch (dispatches counter advanced)
 *        - new permission-wait event observed in the window
 *        - new dispatch outcome (subagent_stop status changed)
 *        - autopilot status flip (running ⇄ idle)
 *
 * Emits 1-3 typed recommendations per call into the per-run hash. A hard
 * daily cost cap (`HYDRA_RECS_DAILY_CAP_USD`, default $1) stops the engine
 * for the rest of the UTC day once breached; on first breach, one
 * `oak_resting` state event is broadcast over WS.
 *
 * Designed for testability: every external touchpoint is in a `deps`
 * record so the unit tests can inject a fake clock, a fake LLM, a fake
 * Redis seam, and a fake event broadcaster.
 *
 * ## Module shape (issue #2317)
 *
 * This module is the single, deep composition point for the recs engine. It
 * was decomposed into five sibling files via successive extraction PRs (#1986
 * materiality, #2240 prompt, #2119 cap, #2024 consumer), which produced a
 * shallow pass-through: the engine re-exported its own materiality and prompt
 * grammar, so a reader scanning the engine body saw imports + re-exports
 * rather than the firing logic. #2317 folded the four PURE concerns back into
 * one module organised by concern SECTION rather than by file — the
 * materiality gate, the prompt grammar, the daily-cap ledger, and the engine's
 * own firing decision now live side by side here, so editing the firing chain
 * (threshold, cap, prompt-size budget) is a single-file change.
 *
 * The one sibling that stays a separate file is `recommendation-consumer.ts`:
 * it owns the process-level stream lifecycle (the XREADGROUP polling loop, the
 * consumer-group registration, the SIGTERM ACK/DELCONSUMER path, the
 * Redis-backed prompt readers) — the real Seam between the bus and this
 * engine's call surface. It imports the engine's interface from here.
 *
 * Section map (top → bottom):
 *   1. Public types — the prompt input, the recommendation shape, the deps record
 *   2. Materiality gate — the pure fire-decision logic (was recommendation-materiality.ts)
 *   3. Prompt grammar — the pure prompt builder + response parser (was recommendation-prompt.ts)
 *   4. Daily-cap ledger — the billing concern + oak_resting latch (was recommendation-cap.ts)
 *   5. Engine factory — `createRecommendationEngine` composing 2-4 with the Redis/LLM deps
 *   6. Production LLM client — the thin Anthropic Request Adapter wrapper
 */

import { RUN_TTL_SECONDS } from "./runs.ts";
import * as defaultRedis from "../redis/recommendations.ts";
import { anthropicMessages, isAnthropicFailure } from "../anthropic/request.ts";

// ---------------------------------------------------------------------------
// SECTION 1 — Public types
// ---------------------------------------------------------------------------

type RecSeverity = "info" | "warn" | "critical";

export interface Recommendation {
  id: string;
  severity: RecSeverity;
  message: string;
  evidence_id: string;
  run_id: string;
  created_at: string;
}

export interface TurnEndPayload {
  event: "turn_end";
  run_id: string;
  turn_n: number;
  dispatches: number;
  skipped: number;
  idle: number;
  tokens_after: number;
  ts_epoch: number;
}

export interface RecentTurn {
  turn_n: number;
  dispatches: number;
  skipped: number;
  idle: number;
  ts_epoch: number;
}

export interface SlotSnapshot {
  /** Map of slot label → {status, since_epoch}. */
  [slot: string]: { status: string; since_epoch?: number };
}

export interface SignalsSnapshot {
  /** Map of signal class → free-form payload from decide.py. */
  [signal: string]: unknown;
}

export interface PermissionWaitEvent {
  slot: string;
  subagent_type?: string;
  tool?: string;
  ts_epoch: number;
}

export interface EnginePromptInput {
  /** Last ≤3 turns for this run, newest first. */
  recent_turns: RecentTurn[];
  /** Current slot snapshot (one row per known slot). */
  slot_snapshot: SlotSnapshot;
  /** Current signals snapshot (decide.py state). */
  signals_snapshot: SignalsSnapshot;
  /** Recent permission-wait events (≤10, newest first). */
  recent_permission_waits: PermissionWaitEvent[];
  /** Current recs-engine daily spend in USD. */
  daily_spend_usd: number;
  /** The triggering turn — included verbatim so the prompt has it. */
  turn_end: TurnEndPayload;
}

/**
 * The LLM call abstraction. The engine doesn't know how the call is made;
 * the `defaultLlmClient` in this module is the production one (stdlib
 * `fetch` against the Anthropic Messages API), but tests inject a stub.
 *
 * Contract:
 *   - Returns 1-3 Recommendation objects on success.
 *   - Returns `null` when the operator hasn't configured an API key — the
 *     engine treats null as a no-op (silent skip, no spend, no failure).
 *   - Throws on transport errors; the engine catches and logs but does NOT
 *     pause the engine on a transient failure (only the daily cap pauses).
 *
 * The `cost_usd` return value lets the engine roll the call's USD spend
 * into the recs-engine daily tally. When the LLM client doesn't know the
 * cost (e.g. tests), it returns 0 and the engine simply doesn't charge.
 */
export interface LlmClient {
  generate(input: EnginePromptInput): Promise<LlmResult | null>;
}

export interface LlmResult {
  recommendations: Recommendation[];
  cost_usd: number;
  /** Raw prompt text — exposed so the prompt-size assertion in tests can fire. */
  prompt: string;
}

/**
 * The small Redis facade the engine state needs — pulled from defaultRedis but
 * overridable for tests.
 */
export interface RecsRedisFacade {
  getLastCallEpoch(runId: string): Promise<number | null>;
  setLastCallEpoch(runId: string, epoch: number, ttlSeconds: number): Promise<void>;
  getLastSignature(runId: string): Promise<string | null>;
  setLastSignature(runId: string, sig: string, ttlSeconds: number): Promise<void>;
  appendRecommendation(
    runId: string,
    recId: string,
    json: string,
    ttlSeconds: number,
  ): Promise<void>;
  getDailySpendUsd(date: string): Promise<number>;
  incrDailySpendUsd(date: string, usd: number): Promise<number>;
}

export interface EngineDeps {
  redis?: RecsRedisFacade;
  llm: LlmClient;
  /** Reader for the last ≤3 turns for the run, newest first. */
  readRecentTurns: (runId: string, limit: number) => Promise<RecentTurn[]>;
  /** Reader for the current slot snapshot. */
  readSlotSnapshot: (runId: string) => Promise<SlotSnapshot>;
  /** Reader for the current signals snapshot. */
  readSignalsSnapshot: (runId: string) => Promise<SignalsSnapshot>;
  /** Reader for recent permission-wait events. */
  readRecentPermissionWaits: (runId: string, limit: number) => Promise<PermissionWaitEvent[]>;
  /**
   * The billing ledger (issue #2119, folded back here in #2317) — owns the
   * daily cost cap, the spend read/charge, and the once-per-UTC-day
   * `oak_resting` broadcast latch. Defaulted (like `redis`) so the engine
   * builds a production enforcer from its env/clock when none is injected; the
   * consumer wires the WS broadcaster in. The cap-vs-interval ordering stays in
   * `shouldFire`, NOT here — this enforcer only FEEDS daily_spend_usd +
   * daily_cap_usd into that decision.
   */
  capEnforcer?: CapEnforcer;
  /** Clock — defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// SECTION 2 — Materiality gate (was recommendation-materiality.ts, issue #1986)
//
// The pure, deterministic decision logic that gates whether the recs engine
// fires a (daily-capped) LLM call this turn. This is the deepest concern: a
// false negative here ("nothing changed") silently skips a call that should
// have fired, and the daily-spend cap it short-circuits on is the sole
// sanctioned real-USD surface (CONTEXT.md L203 / ADR-0005).
//
// Everything in this section is pure: no I/O, no state mutation, no
// import-time side effects. Identical input yields byte-identical output,
// independent of slot key order.
//
// The gate has two halves:
//   1. A material-change *signature* — `computeMaterialChangeSignature` +
//      `summariseSlotStatus` — a stable string over the state that changes
//      between material-change triggers (new dispatch, new permission-wait,
//      new outcome, autopilot status flip).
//   2. The *fire decision* — `shouldFire` — which orders cap > interval >
//      no-change > proceed so the cap always short-circuits first.
// ---------------------------------------------------------------------------

/** Minimum seconds between LLM calls for a given run. */
export const MIN_CALL_INTERVAL_SECONDS = 30;

/**
 * Derive a deterministic material-change signature from the engine inputs.
 * The signature MUST be a function only of state that changes between
 * material-change triggers (new dispatch, new permission-wait, new outcome,
 * autopilot status flip). When the signature matches the last-call
 * signature, the engine skips this turn even if the 30s window has passed.
 *
 * Format: a short delimited string. We avoid JSON.stringify to keep the
 * comparison cheap and stable under key-order drift.
 */
export function computeMaterialChangeSignature(input: {
  dispatches: number;
  permission_waits: PermissionWaitEvent[];
  slot_status_summary: string;
  autopilot_running: boolean;
}): string {
  const permParts = input.permission_waits
    .slice(0, 5)
    .map((e) => `${e.slot}@${e.ts_epoch}`)
    .join(",");
  return [
    `d=${input.dispatches}`,
    `r=${input.autopilot_running ? "1" : "0"}`,
    `s=${input.slot_status_summary}`,
    `p=${permParts}`,
  ].join("|");
}

/**
 * Reduce a slot snapshot to a compact stable string for the signature
 * computation. Slots are sorted by name so the output is deterministic
 * regardless of iteration order.
 */
export function summariseSlotStatus(snapshot: SlotSnapshot): string {
  const entries = Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([slot, info]) => `${slot}:${info?.status ?? "?"}`).join(",");
}

/**
 * Decision: should the engine fire this turn? Pure function — exported for
 * tests. Returns one of:
 *
 *   { proceed: true }                                                — fire
 *   { proceed: false, skip_reason: "cap" }                          — daily cap reached
 *   { proceed: false, skip_reason: "interval" }                     — too soon
 *   { proceed: false, skip_reason: "no-change" }                    — no material change
 *
 * The order matters: "cap" beats "interval" beats "no-change" so the
 * caller can surface the most specific reason. The cap MUST short-circuit
 * first so a capped day never fires an LLM call.
 */
export type ShouldFireDecision =
  | { proceed: true }
  | { proceed: false; skip_reason: "cap" | "interval" | "no-change" };

export function shouldFire(input: {
  now_epoch: number;
  last_call_epoch: number | null;
  current_signature: string;
  last_signature: string | null;
  daily_spend_usd: number;
  daily_cap_usd: number;
}): ShouldFireDecision {
  if (input.daily_spend_usd >= input.daily_cap_usd) {
    return { proceed: false, skip_reason: "cap" };
  }
  if (input.last_call_epoch !== null) {
    const since = input.now_epoch - input.last_call_epoch;
    if (since < MIN_CALL_INTERVAL_SECONDS) {
      return { proceed: false, skip_reason: "interval" };
    }
  }
  if (input.last_signature !== null && input.last_signature === input.current_signature) {
    return { proceed: false, skip_reason: "no-change" };
  }
  return { proceed: true };
}

// ---------------------------------------------------------------------------
// SECTION 3 — Prompt grammar (was recommendation-prompt.ts, issue #2240)
//
// The two pure, side-effect-free halves of the recs engine's grammar: the
// prompt builder (`buildPrompt`) and the response parser (`parseLlmResponse`).
//
// Everything in this section is pure: no Redis, no network, no clock, no
// import-time side effects. `buildPrompt` is a total function of an
// `EnginePromptInput` literal; `parseLlmResponse` is a total function of a raw
// completion string plus the engine-derived stamping context. That lets a
// future promptfoo A/B eval (CONTEXT.md / `evals/`) import `buildPrompt`
// directly.
// ---------------------------------------------------------------------------

/**
 * Prompt-size budget in bytes. The "small prompt" AC is that the engine
 * never has to truncate at the call site — `buildPrompt` is bounded by
 * construction (turn/wait/slot/signal clipping), so any reasonable input
 * produces a prompt at or under this budget. Tests assert it.
 */
export const PROMPT_SIZE_BUDGET_BYTES = 4 * 1024;

/** Hard ceiling on recommendations stamped per LLM call. */
const MAX_RECS_PER_CALL = 3;

/**
 * Build the prompt text that the LLM receives. The whole point of the
 * "small prompt" AC is that the engine never has to truncate at the
 * call site — the prompt is bounded by construction. We:
 *
 *   - keep at most 3 recent turns (older context is in past recs)
 *   - keep at most 5 recent permission-waits (older waits resolved or are stale)
 *   - keep the slot snapshot to one line per slot
 *   - emit signals as `key=value` lines with values clipped to 80 chars
 *
 * Tests assert that any reasonable input produces a prompt ≤ 4KB.
 */
export function buildPrompt(input: EnginePromptInput): string {
  const lines: string[] = [];
  lines.push(
    "You are Oak, the autopilot observability assistant. Given the latest" +
      " autopilot turn-end snapshot, emit 1-3 short recommendations for the" +
      " operator. Each recommendation MUST be a single English sentence.",
  );
  lines.push("");
  lines.push(`# Turn ${input.turn_end.turn_n} (run ${input.turn_end.run_id})`);
  lines.push(
    `dispatches=${input.turn_end.dispatches} skipped=${input.turn_end.skipped}` +
      ` idle=${input.turn_end.idle} tokens=${input.turn_end.tokens_after}` +
      ` daily_spend_usd=${input.daily_spend_usd.toFixed(4)}`,
  );

  lines.push("");
  lines.push("# Recent turns (newest first)");
  for (const t of input.recent_turns.slice(0, 3)) {
    lines.push(
      `- turn_n=${t.turn_n} dispatches=${t.dispatches} skipped=${t.skipped}` +
        ` idle=${t.idle} ts_epoch=${t.ts_epoch}`,
    );
  }

  lines.push("");
  lines.push("# Slot snapshot");
  const slotEntries = Object.entries(input.slot_snapshot).slice(0, 12);
  for (const [slot, info] of slotEntries) {
    const since = info?.since_epoch ? ` since=${info.since_epoch}` : "";
    lines.push(`- ${slot}: ${info?.status ?? "?"}${since}`);
  }

  lines.push("");
  lines.push("# Signals");
  const signalEntries = Object.entries(input.signals_snapshot).slice(0, 12);
  for (const [k, v] of signalEntries) {
    const valStr = typeof v === "string" ? v : JSON.stringify(v);
    const clipped = valStr.length > 80 ? `${valStr.slice(0, 77)}...` : valStr;
    lines.push(`- ${k}=${clipped}`);
  }

  lines.push("");
  lines.push("# Recent permission-waits");
  for (const e of input.recent_permission_waits.slice(0, 5)) {
    const tool = e.tool ? ` tool=${e.tool}` : "";
    lines.push(`- ${e.slot} at ${e.ts_epoch}${tool}`);
  }

  lines.push("");
  lines.push(
    "Respond with a single JSON object: {\"recommendations\":[{\"severity\":" +
      "\"info|warn|critical\", \"message\":\"...\"} ...]}." +
      " Emit 1-3 recommendations. Keep each message under 140 characters.",
  );

  return lines.join("\n");
}

/**
 * Parse the LLM's JSON response into typed Recommendations. The LLM is
 * told to return `{recommendations: [...]}`; we extract that array, take
 * the first 3, and stamp ids/timestamps/evidence_id from the engine's
 * authoritative context. A malformed response yields an empty array (the
 * engine still charges the spend for the call — that's a defect on the
 * model side, not ours).
 *
 * `evidenceId` is the engine-derived evidence handle — typically the
 * turn_n of the triggering turn so the UI can link back to the journal row.
 */
export function parseLlmResponse(input: {
  rawJsonText: string;
  runId: string;
  evidenceId: string;
  nowIso: string;
  turnN: number;
}): Recommendation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawJsonText);
  } catch {
    /* intentional: malformed JSON returns empty recommendations */
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const recs = (parsed as any).recommendations;
  if (!Array.isArray(recs)) return [];

  const out: Recommendation[] = [];
  for (let i = 0; i < recs.length && out.length < MAX_RECS_PER_CALL; i++) {
    const raw = recs[i];
    if (!raw || typeof raw !== "object") continue;
    const severity = String(raw.severity ?? "info");
    if (severity !== "info" && severity !== "warn" && severity !== "critical") {
      continue;
    }
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    if (!message) continue;
    // Stable id: run + turn + index — retries collapse cleanly.
    const id = `${input.runId}:${input.turnN}:${i}`;
    out.push({
      id,
      severity,
      message: message.slice(0, 200),
      evidence_id: input.evidenceId,
      run_id: input.runId,
      created_at: input.nowIso,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SECTION 4 — Daily-cap ledger (was recommendation-cap.ts, issue #2119)
//
// The recs-engine's **billing concern** — the single sanctioned real-USD
// surface on the orchestrator (CONTEXT.md L203 / ADR-0005:
// `recommendation-engine.ts` bills outside the subscription via the direct
// Anthropic API, so `HYDRA_RECS_DAILY_CAP_USD` is a live cost gate).
//
// What lives here:
//   - DEFAULT_DAILY_CAP_USD + envDailyCap() — the ONE home for
//     HYDRA_RECS_DAILY_CAP_USD resolution.
//   - the UTC date stamper (utcDateStamp / today()).
//   - the spend READ (getDailySpendUsd) + post-success CHARGE
//     (incrDailySpendUsd) calls.
//   - the once-per-UTC-day `oak_resting` broadcast latch (maybeEmitResting),
//     with date-rollover reset.
//   - getDailyCapUsd().
//
// What deliberately does NOT live here (load-bearing money-safety boundary):
//   - the cap > interval > no-change ordering. That stays the SINGLE authority
//     of `shouldFire()` in SECTION 2. This ledger FEEDS `daily_spend_usd` +
//     `daily_cap_usd` into that decision; it never re-implements the `>=`
//     comparison or reorders the skip reasons. One short-circuit point means a
//     capped day can never fire a paid LLM call.
//   - the micro-USD INT rounding (USD*1e6 + INCRBY integer-safety) stays
//     entirely inside the Redis accessor (`src/redis/recommendations.ts`); no
//     float math crosses this seam.
//
// The four cost invariants are preserved 1:1:
//   1. READ-BEFORE-FIRE — daily spend is read before shouldFire, which
//      short-circuits on cap before any paid call.
//   2. CHARGE-AFTER-SUCCESS-ONLY — chargeIfPositive() fires only when
//      cost_usd > 0, after a successful LLM call.
//   3. MICRO-USD INT confined to the Redis accessor (this ledger only passes a
//      USD float through to it).
//   4. BROADCAST-ONCE-PER-UTC-DAY — the pauseDayState latch + rollover reset.
// ---------------------------------------------------------------------------

/** Default daily cost cap in USD when HYDRA_RECS_DAILY_CAP_USD is unset/invalid. */
export const DEFAULT_DAILY_CAP_USD = 1.0;

/**
 * Resolve the recs-engine daily cap from `HYDRA_RECS_DAILY_CAP_USD`. This is
 * the ONLY home for that env resolution — the engine delegates to it so the
 * cap amount has a single source of truth (CONTEXT.md L203 / ADR-0005).
 */
export function envDailyCap(): number {
  const raw = process.env.HYDRA_RECS_DAILY_CAP_USD;
  if (!raw) return DEFAULT_DAILY_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_CAP_USD;
  return n;
}

/** UTC `YYYY-MM-DD` stamp — the per-day bucket key for the spend ledger. */
export function utcDateStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The narrow Redis surface the cap ledger needs — the micro-USD INT spend
 * accessors. The integer-safety (USD*1e6 rounding + INCRBY) stays inside
 * `src/redis/recommendations.ts`; this ledger only passes USD floats through.
 */
export interface CapRedisFacade {
  getDailySpendUsd(date: string): Promise<number>;
  incrDailySpendUsd(date: string, usd: number): Promise<number>;
}

export interface CapEnforcerDeps {
  /** Spend ledger accessor — defaults to the production Redis seam. */
  redis?: CapRedisFacade;
  /** Broadcaster for the one-shot `oak_resting` WS event. */
  broadcastResting?: (runId: string, daily_spend_usd: number, cap_usd: number) => void;
  /** Clock — defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
  /** Date stamper — defaults to UTC YYYY-MM-DD. */
  today?: () => string;
  /** Daily cap in USD — defaults to env or DEFAULT_DAILY_CAP_USD. */
  dailyCapUsd?: number;
}

/**
 * The constructed cap-enforcer. It owns the billing ledger but NOT the fire
 * decision — `readDailySpend()` + `getDailyCapUsd()` feed the engine's
 * `shouldFire()` call; the enforcer never decides whether to proceed.
 */
export interface CapEnforcer {
  /** The resolved daily cap in USD. */
  getDailyCapUsd(): number;
  /** Current UTC date stamp — the spend-ledger bucket key. */
  today(): string;
  /** Read the recs-engine daily spend in USD for the given date. */
  readDailySpend(date: string): Promise<number>;
  /**
   * Charge a successful call's USD cost into the daily tally — a no-op when
   * `costUsd <= 0` (CHARGE-AFTER-SUCCESS-ONLY invariant: only paid calls
   * charge). The caller invokes this only after a successful LLM call.
   */
  chargeIfPositive(date: string, costUsd: number): Promise<void>;
  /**
   * Emit the one-shot `oak_resting` WS broadcast for the current UTC day.
   * Returns `true` if it broadcast this call, `false` if already emitted
   * today. Resets on date rollover (BROADCAST-ONCE-PER-UTC-DAY invariant).
   */
  maybeEmitResting(spendUsd: number): boolean;
}

/**
 * Construct the cap enforcer. Mirrors `createRecommendationEngine`'s deps
 * defaulting (redis/now/today/cap all overridable for tests).
 */
export function createCapEnforcer(deps: CapEnforcerDeps = {}): CapEnforcer {
  const redis = deps.redis ?? (defaultRedis as CapRedisFacade);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const today = deps.today ?? (() => utcDateStamp(new Date(now() * 1000)));
  const dailyCapUsd = Number.isFinite(deps.dailyCapUsd as number)
    ? (deps.dailyCapUsd as number)
    : envDailyCap();

  // Tracks whether we've already broadcast the `oak_resting` pause event
  // for this UTC day. Reset on date rollover.
  const pauseDayState = { date: "", emitted: false };

  return {
    getDailyCapUsd: () => dailyCapUsd,

    today,

    async readDailySpend(date: string): Promise<number> {
      return redis.getDailySpendUsd(date);
    },

    async chargeIfPositive(date: string, costUsd: number): Promise<void> {
      if (costUsd > 0) {
        await redis.incrDailySpendUsd(date, costUsd);
      }
    },

    maybeEmitResting(spendUsd: number): boolean {
      const date = today();
      if (pauseDayState.date !== date) {
        pauseDayState.date = date;
        pauseDayState.emitted = false;
      }
      if (pauseDayState.emitted) return false;
      pauseDayState.emitted = true;
      try {
        deps.broadcastResting?.("__system__", spendUsd, dailyCapUsd);
      } catch (err: any) {
        console.error(
          `[recs-engine] oak_resting broadcaster threw: ${err?.message || err}`,
        );
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// SECTION 5 — Engine factory
//
// `createRecommendationEngine` composes the materiality gate (SECTION 2), the
// prompt grammar (SECTION 3) and the cap ledger (SECTION 4) with the
// injected Redis/LLM deps. The returned object has a single hot path,
// `onTurnEnd`, which `recommendation-consumer.ts` wires to the
// `hydra:autopilot:slot-events` stream.
// ---------------------------------------------------------------------------

type OnTurnEndResult =
  | { fired: true; recs: Recommendation[]; cost_usd: number }
  | { fired: false; reason: "cap" | "interval" | "no-change" | "no-llm" | "llm-error" }
  | { fired: false; reason: "cap"; pause_emitted: boolean };

export interface RecommendationEngine {
  onTurnEnd(payload: TurnEndPayload): Promise<OnTurnEndResult>;
  getDailyCapUsd(): number;
}

/**
 * Construct the engine. The returned object has a single hot path,
 * `onTurnEnd`, which is wired up by the consumer in
 * `recommendation-consumer.ts` to the `hydra:autopilot:slot-events` stream.
 */
export function createRecommendationEngine(deps: EngineDeps): RecommendationEngine {
  const redis = deps.redis ?? (defaultRedis as RecsRedisFacade);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // The billing ledger (SECTION 4). Default-construct a production enforcer
  // from the engine's clock when none is injected — mirrors the `redis`
  // default. The enforcer owns the cap amount, the spend read/charge, and the
  // oak_resting latch; the engine just feeds its outputs into `shouldFire`.
  const cap = deps.capEnforcer ?? createCapEnforcer({ now });

  return {
    getDailyCapUsd: () => cap.getDailyCapUsd(),

    async onTurnEnd(payload: TurnEndPayload): Promise<OnTurnEndResult> {
      const runId = payload.run_id;
      if (!runId) return { fired: false, reason: "no-change" };

      const date = cap.today();
      const dailySpend = await cap.readDailySpend(date);

      // Build the candidate inputs in parallel — none of these mutate state.
      const [recentTurns, slotSnap, signalsSnap, perms, lastCall, lastSig] =
        await Promise.all([
          deps.readRecentTurns(runId, 3),
          deps.readSlotSnapshot(runId),
          deps.readSignalsSnapshot(runId),
          deps.readRecentPermissionWaits(runId, 10),
          redis.getLastCallEpoch(runId),
          redis.getLastSignature(runId),
        ]);

      // Material-change signature uses snapshot state, not the prompt body.
      const signature = computeMaterialChangeSignature({
        dispatches: payload.dispatches,
        permission_waits: perms,
        slot_status_summary: summariseSlotStatus(slotSnap),
        autopilot_running:
          payload.idle === 0 || payload.dispatches > 0 || payload.skipped > 0,
      });

      const decision = shouldFire({
        now_epoch: now(),
        last_call_epoch: lastCall,
        current_signature: signature,
        last_signature: lastSig,
        daily_spend_usd: dailySpend,
        daily_cap_usd: cap.getDailyCapUsd(),
      });

      if (decision.proceed === false) {
        if (decision.skip_reason === "cap") {
          const emitted = cap.maybeEmitResting(dailySpend);
          return { fired: false, reason: "cap", pause_emitted: emitted };
        }
        return { fired: false, reason: decision.skip_reason };
      }

      const promptInput: EnginePromptInput = {
        recent_turns: recentTurns,
        slot_snapshot: slotSnap,
        signals_snapshot: signalsSnap,
        recent_permission_waits: perms,
        daily_spend_usd: dailySpend,
        turn_end: payload,
      };

      let llmResult: LlmResult | null;
      try {
        llmResult = await deps.llm.generate(promptInput);
      } catch (err: any) {
        console.error(
          `[recs-engine] LLM threw for run=${runId} turn=${payload.turn_n}:` +
            ` ${err?.message || err}`,
        );
        return { fired: false, reason: "llm-error" };
      }

      if (!llmResult) {
        // No API key / feature off — leave state untouched so the next
        // material change still triggers when the operator wires the key.
        return { fired: false, reason: "no-llm" };
      }

      // Charge the spend and stamp engine state BEFORE we acknowledge the
      // recommendations — if Redis is wedged after this point, the missed
      // write is recoverable (the engine will simply re-fire next turn,
      // and idempotent rec ids collapse duplicate writes on the hash).
      await cap.chargeIfPositive(date, llmResult.cost_usd);
      const callEpoch = now();
      await redis.setLastCallEpoch(runId, callEpoch, RUN_TTL_SECONDS);
      await redis.setLastSignature(runId, signature, RUN_TTL_SECONDS);

      const recs = llmResult.recommendations.slice(0, MAX_RECS_PER_CALL);
      const nowIso = new Date(callEpoch * 1000).toISOString();
      for (const r of recs) {
        const stamped: Recommendation = {
          ...r,
          run_id: runId,
          created_at: r.created_at || nowIso,
        };
        const json = JSON.stringify(stamped);
        await redis.appendRecommendation(runId, stamped.id, json, RUN_TTL_SECONDS);
      }

      return { fired: true, recs, cost_usd: llmResult.cost_usd };
    },
  };
}

// ---------------------------------------------------------------------------
// SECTION 6 — Production LLM client (thin Anthropic Request Adapter wrapper)
// ---------------------------------------------------------------------------

const HAIKU_MODEL = "claude-haiku-4-5";

/** Per-million-token cost estimates for the engine's accounting. */
const HAIKU_INPUT_PER_MTOK_USD = 1.0;
const HAIKU_OUTPUT_PER_MTOK_USD = 5.0;

/**
 * Build the production LLM client. This is a THIN wrapper over the
 * **Anthropic Request Adapter** (`src/anthropic/request.ts`, issue #1959): the
 * URL, `anthropic-version` header, `ANTHROPIC_API_KEY` resolution, the
 * `AbortSignal.timeout()` discipline, non-2xx / malformed-JSON / network
 * classification, token-usage extraction, and the per-call USD cost derivation
 * all live behind the adapter primitive. The engine's only job here is to build
 * the prompt, call the adapter, and map its discriminated `AnthropicResult` onto
 * the engine's `LlmResult`.
 *
 * Failure contract preserved 1:1 from the old inline client: when no
 * `ANTHROPIC_API_KEY` is set the adapter returns `anthropic-no-api-key`, which
 * we map to `null` (the engine treats null as an inert no-op). Every other
 * adapter failure code also maps to `null` — a transient transport/non-2xx
 * failure must not pause the engine (only the daily cap pauses it).
 *
 * Staying off `@anthropic-ai/sdk` (ADR-0005) is now the adapter's invariant; the
 * engine no longer constructs a raw `fetch` at all.
 *
 * Exported so the recommendation-consumer Module — which owns the stream
 * lifecycle — can wire this production client into the engine it constructs.
 * The cost-gate accounting stays engine-side; this client only derives a
 * per-call USD figure the engine then charges.
 */
export function defaultLlmClient(opts: {
  fetchImpl?: typeof fetch;
  apiKey?: string;
} = {}): LlmClient {
  return {
    async generate(input: EnginePromptInput): Promise<LlmResult | null> {
      const prompt = buildPrompt(input);

      const result = await anthropicMessages(
        {
          model: HAIKU_MODEL,
          max_tokens: 512,
          messages: [{ role: "user", content: prompt }],
        },
        {
          apiKey: opts.apiKey,
          fetchImpl: opts.fetchImpl,
          costRates: {
            input_per_mtok_usd: HAIKU_INPUT_PER_MTOK_USD,
            output_per_mtok_usd: HAIKU_OUTPUT_PER_MTOK_USD,
          },
        },
      );

      if (isAnthropicFailure(result)) {
        // anthropic-no-api-key → engine stays inert (operator hasn't opted in).
        // Any other code (non-2xx / malformed-json / timeout / network-error)
        // is a transient boundary failure: log already happened in the adapter;
        // map to null so the engine skips this turn without pausing.
        return null;
      }

      const nowEpoch = Math.floor(Date.now() / 1000);
      const recs = parseLlmResponse({
        rawJsonText: result.text,
        runId: input.turn_end.run_id,
        evidenceId: `turn:${input.turn_end.turn_n}`,
        nowIso: new Date(nowEpoch * 1000).toISOString(),
        turnN: input.turn_end.turn_n,
      });

      return { recommendations: recs, cost_usd: result.cost_usd, prompt };
    },
  };
}
