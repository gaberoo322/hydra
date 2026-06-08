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
 */

import { RUN_TTL_SECONDS } from "./runs.ts";
import * as defaultRedis from "../redis/recommendations.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecSeverity = "info" | "warn" | "critical";

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

/** Constants */
export const MIN_CALL_INTERVAL_SECONDS = 30;
export const DEFAULT_DAILY_CAP_USD = 1.0;
export const PROMPT_SIZE_BUDGET_BYTES = 4 * 1024;
export const MAX_RECS_PER_CALL = 3;

// ---------------------------------------------------------------------------
// Engine state — small Redis facade pulled from defaultRedis but overridable
// for tests.
// ---------------------------------------------------------------------------

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
  /** Broadcaster for the one-shot `oak_resting` WS event. */
  broadcastResting?: (runId: string, daily_spend_usd: number, cap_usd: number) => void;
  /** Clock — defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
  /** Date stamper — defaults to UTC YYYY-MM-DD. */
  today?: () => string;
  /** Daily cap in USD — defaults to env or 1.0. */
  dailyCapUsd?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

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
 * caller can surface the most specific reason.
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
// Engine API — invoked from the turn_end stream consumer
// ---------------------------------------------------------------------------

export type OnTurnEndResult =
  | { fired: true; recs: Recommendation[]; cost_usd: number }
  | { fired: false; reason: "cap" | "interval" | "no-change" | "no-llm" | "llm-error" }
  | { fired: false; reason: "cap"; pause_emitted: boolean };

export interface RecommendationEngine {
  onTurnEnd(payload: TurnEndPayload): Promise<OnTurnEndResult>;
  getDailyCapUsd(): number;
}

/**
 * Construct the engine. The returned object has a single hot path,
 * `onTurnEnd`, which is wired up by the consumer in `src/index.ts` to the
 * `hydra:autopilot:slot-events` stream.
 */
export function createRecommendationEngine(deps: EngineDeps): RecommendationEngine {
  const redis = deps.redis ?? (defaultRedis as RecsRedisFacade);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const today = deps.today ?? (() => utcDateStamp(new Date(now() * 1000)));
  const dailyCapUsd = Number.isFinite(deps.dailyCapUsd as number)
    ? (deps.dailyCapUsd as number)
    : envDailyCap();

  // Tracks whether we've already broadcast the `oak_resting` pause event
  // for this UTC day. Reset on date rollover.
  const pauseDayState = { date: "", emitted: false };

  function maybeEmitResting(spendUsd: number): boolean {
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
  }

  return {
    getDailyCapUsd: () => dailyCapUsd,

    async onTurnEnd(payload: TurnEndPayload): Promise<OnTurnEndResult> {
      const runId = payload.run_id;
      if (!runId) return { fired: false, reason: "no-change" };

      const date = today();
      const dailySpend = await redis.getDailySpendUsd(date);

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
        daily_cap_usd: dailyCapUsd,
      });

      if (decision.proceed === false) {
        if (decision.skip_reason === "cap") {
          const emitted = maybeEmitResting(dailySpend);
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
      if (llmResult.cost_usd > 0) {
        await redis.incrDailySpendUsd(date, llmResult.cost_usd);
      }
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
// Production LLM client — stdlib fetch against the Anthropic Messages API
// ---------------------------------------------------------------------------

const HAIKU_MODEL = "claude-haiku-4-5";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Per-million-token cost estimates for the engine's accounting. */
const HAIKU_INPUT_PER_MTOK_USD = 1.0;
const HAIKU_OUTPUT_PER_MTOK_USD = 5.0;

/**
 * Build the production LLM client. When `ANTHROPIC_API_KEY` is not set in
 * the environment, every call returns `null` so the engine becomes inert
 * — the operator opts in by setting the key. The HTTP request uses stdlib
 * `fetch` (Node >= 18) to keep us inside the operator-approved dep set
 * (no `@anthropic-ai/sdk` import — see ADR-0005).
 *
 * The `runId`/`turn_n` from the prompt input is stamped into the parsed
 * recommendations.
 */
export function defaultLlmClient(opts: {
  fetchImpl?: typeof fetch;
  apiKey?: string;
} = {}): LlmClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    async generate(input: EnginePromptInput): Promise<LlmResult | null> {
      if (!apiKey) return null;
      if (!fetchImpl) {
        console.error("[recs-engine] no fetch available; engine inert");
        return null;
      }

      const prompt = buildPrompt(input);
      const body = JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      let res: Response;
      try {
        res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body,
        });
      } catch (err: any) {
        console.error(
          `[recs-engine] Anthropic fetch threw: ${err?.message || err}`,
        );
        return null;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        console.error(
          `[recs-engine] Anthropic non-2xx ${res.status}: ${detail.slice(0, 200)}`,
        );
        return null;
      }

      let payload: any;
      try {
        payload = await res.json();
      } catch (err: any) {
        console.error(`[recs-engine] Anthropic JSON parse: ${err?.message || err}`);
        return null;
      }

      const text = extractFirstTextBlock(payload);
      const usageInput = Number(payload?.usage?.input_tokens || 0);
      const usageOutput = Number(payload?.usage?.output_tokens || 0);
      const costUsd =
        (usageInput / 1_000_000) * HAIKU_INPUT_PER_MTOK_USD +
        (usageOutput / 1_000_000) * HAIKU_OUTPUT_PER_MTOK_USD;

      const nowEpoch = Math.floor(Date.now() / 1000);
      const recs = parseLlmResponse({
        rawJsonText: text,
        runId: input.turn_end.run_id,
        evidenceId: `turn:${input.turn_end.turn_n}`,
        nowIso: new Date(nowEpoch * 1000).toISOString(),
        turnN: input.turn_end.turn_n,
      });

      return { recommendations: recs, cost_usd: costUsd, prompt };
    },
  };
}

function extractFirstTextBlock(payload: any): string {
  if (!payload || !Array.isArray(payload.content)) return "";
  for (const block of payload.content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function utcDateStamp(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function envDailyCap(): number {
  const raw = process.env.HYDRA_RECS_DAILY_CAP_USD;
  if (!raw) return DEFAULT_DAILY_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DAILY_CAP_USD;
  return n;
}

// ---------------------------------------------------------------------------
// Stream consumer wiring — bound to the `hydra:autopilot:slot-events`
// stream that slice A (#668) emits `turn_end` events onto.
// ---------------------------------------------------------------------------

const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";
const RECS_CONSUMER_GROUP = "recs-engine";
const TURN_END_BROADCAST_STREAM = "autopilot:recs-pause";

/**
 * Parse a raw stream event (Redis XADD field/value pairs) into a typed
 * `TurnEndPayload`. Returns `null` when the event isn't a `turn_end` or
 * the required fields are missing. Stringly-typed defensively — every
 * field on a slot-events stream entry is a string per the bridge contract.
 */
export function parseTurnEndStreamEvent(raw: any): TurnEndPayload | null {
  if (!raw || typeof raw !== "object") return null;
  // Slice 4 (#646) bridge wraps real fields under `.payload` when the
  // upstream stamps a JSON payload, but the Python turn_end emitter
  // writes flat field/value pairs — match both shapes.
  const flat = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
  if (flat.event !== "turn_end") return null;
  const runId = typeof flat.run_id === "string" ? flat.run_id : "";
  if (!runId) return null;
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    event: "turn_end",
    run_id: runId,
    turn_n: num(flat.turn_n, 0),
    dispatches: num(flat.dispatches, 0),
    skipped: num(flat.skipped, 0),
    idle: num(flat.idle, 0),
    tokens_after: num(flat.tokens_after, 0),
    ts_epoch: num(flat.ts_epoch, Math.floor(Date.now() / 1000)),
  };
}

/**
 * Default Redis-backed readers for the engine's prompt inputs. Each
 * reader degrades to an empty value on failure — the engine treats a
 * partial input as still-fireable so a transient Redis hiccup doesn't
 * suppress every recommendation.
 *
 * The slot + signals + permission-wait shapes here mirror what slice A's
 * `decide.py` writes to the autopilot run hash and the slot-events
 * stream. We keep the readers tolerant of missing fields so the engine
 * can ship before every observability surface is fully populated.
 */
async function defaultReadRecentTurns(
  runId: string,
  limit: number,
): Promise<RecentTurn[]> {
  try {
    const { listAutopilotRunTurnsDesc } = await import("../redis/autopilot-runs.ts");
    const raw = await listAutopilotRunTurnsDesc(runId, limit);
    const out: RecentTurn[] = [];
    for (const member of raw) {
      try {
        const parsed = JSON.parse(member);
        if (!parsed || typeof parsed !== "object") continue;
        out.push({
          turn_n: Number(parsed.turn_n || 0),
          dispatches: Array.isArray(parsed.actions)
            ? parsed.actions.filter((a: any) => a && a.type === "dispatch").length
            : 0,
          skipped: 0,
          idle: Number(parsed.idle_turns || 0),
          ts_epoch: Number(parsed.epoch || 0),
        });
      } catch {
        /* intentional: skip unparseable turn member, next reader call retries */
      }
    }
    return out;
  } catch (err: any) {
    console.error(`[recs-engine] readRecentTurns: ${err?.message || err}`);
    return [];
  }
}

async function defaultReadSlotSnapshot(_runId: string): Promise<SlotSnapshot> {
  // Slot snapshot lives on the autopilot run hash under a JSON-encoded
  // field today (#668 will canonicalise it). Start empty — the engine's
  // prompt builder tolerates an empty snapshot — and grow the shape once
  // slice A lands.
  return {};
}

async function defaultReadSignalsSnapshot(_runId: string): Promise<SignalsSnapshot> {
  // Same story as the slot snapshot — slice A populates the canonical
  // shape; we accept emptiness until then.
  return {};
}

async function defaultReadRecentPermissionWaits(
  _runId: string,
  _limit: number,
): Promise<PermissionWaitEvent[]> {
  // Permission-wait events live on the slot-events stream; a dedicated
  // reader is a follow-up. Returning empty keeps the engine functional
  // and the prompt small.
  return [];
}

/**
 * Wire up the production engine consumer. Reads from
 * `hydra:autopilot:slot-events` (the same stream the existing
 * slot-events-bridge consumes from — different consumer group so the
 * cursors are independent), filters for `event === "turn_end"`, and
 * dispatches into `engine.onTurnEnd`.
 *
 * The engine emits an `oak_resting` WS event on the first daily-cap hit
 * each UTC day — broadcast under stream `autopilot:recs-pause` so the
 * dashboard can render an unobtrusive "Oak is resting" badge without
 * having to subscribe to the recs hash directly.
 */
export async function startRecommendationConsumer(eventBus: {
  consume: (
    stream: string,
    group: string,
    consumerName: string,
    handler: (event: any) => Promise<void>,
    opts?: { count?: number; blockMs?: number },
  ) => Promise<void>;
  ensureConsumerGroup: (
    stream: string,
    group: string,
    startId?: string,
  ) => Promise<void>;
  _broadcastToClients?: (stream: string, event: unknown) => void;
}): Promise<void> {
  // Stream (x*) ops are ADR-0017 Category B — the Event Bus is the sanctioned
  // raw-connection owner. Route the consumer-group CREATE through
  // `ensureConsumerGroup` instead of a dynamically-imported raw connection
  // (issue #1121). The start-id MUST stay "$" (only-new-events): a regression to
  // "0" would replay the entire slot-events stream on every restart. The Event
  // Bus already swallows BUSYGROUP internally, so the manual try/catch is gone.
  await eventBus.ensureConsumerGroup(SLOT_EVENTS_STREAM, RECS_CONSUMER_GROUP, "$");

  const engine = createRecommendationEngine({
    llm: defaultLlmClient(),
    readRecentTurns: defaultReadRecentTurns,
    readSlotSnapshot: defaultReadSlotSnapshot,
    readSignalsSnapshot: defaultReadSignalsSnapshot,
    readRecentPermissionWaits: defaultReadRecentPermissionWaits,
    broadcastResting: (runId, spend, cap) => {
      try {
        eventBus._broadcastToClients?.(TURN_END_BROADCAST_STREAM, {
          type: "oak_resting",
          timestamp: new Date().toISOString(),
          payload: {
            run_id: runId,
            daily_spend_usd: spend,
            daily_cap_usd: cap,
          },
        });
      } catch (err: any) {
        console.error(
          `[recs-engine] broadcastResting threw: ${err?.message || err}`,
        );
      }
    },
  });

  const consumerName = `recs-${process.pid}`;
  console.log(
    `[recs-engine] consuming ${SLOT_EVENTS_STREAM} group=${RECS_CONSUMER_GROUP}` +
      ` consumer=${consumerName} cap_usd=${engine.getDailyCapUsd()}`,
  );

  await eventBus.consume(
    SLOT_EVENTS_STREAM,
    RECS_CONSUMER_GROUP,
    consumerName,
    async (event: any) => {
      const turnEnd = parseTurnEndStreamEvent(event);
      if (!turnEnd) return;
      try {
        await engine.onTurnEnd(turnEnd);
      } catch (err: any) {
        console.error(
          `[recs-engine] onTurnEnd threw for run=${turnEnd.run_id}` +
            ` turn=${turnEnd.turn_n}: ${err?.message || err}`,
        );
      }
    },
    { count: 16, blockMs: 5000 },
  );
}
