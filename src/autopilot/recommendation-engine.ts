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
import { anthropicMessages, isAnthropicFailure } from "../anthropic/request.ts";
import {
  MIN_CALL_INTERVAL_SECONDS,
  computeMaterialChangeSignature,
  summariseSlotStatus,
  shouldFire,
} from "./recommendation-materiality.ts";
import {
  createCapEnforcer,
  type CapEnforcer,
} from "./recommendation-cap.ts";
import {
  buildPrompt,
  parseLlmResponse,
  PROMPT_SIZE_BUDGET_BYTES,
  MAX_RECS_PER_CALL,
} from "./recommendation-prompt.ts";

// Back-compat re-export (issue #1986): the materiality gate moved to its own
// Module, but existing import paths (tests + any caller) keep resolving these
// symbols from the engine. The engine itself imports them above and delegates.
export {
  MIN_CALL_INTERVAL_SECONDS,
  computeMaterialChangeSignature,
  summariseSlotStatus,
  shouldFire,
};

// Back-compat re-export (issue #2240): the pure prompt grammar — the prompt
// builder, the response parser, and their size/count constants — moved to
// `./recommendation-prompt.ts`. The engine imports them above (the factory and
// `defaultLlmClient` call them) and re-exports here so existing import paths
// (tests + any caller) keep resolving these symbols from the engine.
export { buildPrompt, parseLlmResponse, PROMPT_SIZE_BUDGET_BYTES };

// ---------------------------------------------------------------------------
// Public types
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

// Prompt-size budget and per-call rec ceiling now live in
// `./recommendation-prompt.ts` (issue #2240); imported + re-exported above.

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
  /**
   * The billing ledger (issue #2119) — owns the daily cost cap, the spend
   * read/charge, and the once-per-UTC-day `oak_resting` broadcast latch.
   * Defaulted (like `redis`) so the engine builds a production enforcer from
   * its env/clock when none is injected; the consumer wires the WS broadcaster
   * in. The cap-vs-interval ordering stays in `shouldFire`, NOT here — this
   * enforcer only FEEDS daily_spend_usd + daily_cap_usd into that decision.
   */
  capEnforcer?: CapEnforcer;
  /** Clock — defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Pure helpers
//
// Note: the prompt grammar (buildPrompt, parseLlmResponse,
// PROMPT_SIZE_BUDGET_BYTES, MAX_RECS_PER_CALL) now lives in
// ./recommendation-prompt.ts and is imported + re-exported at the top of this
// file for back-compat (issue #2240). The materiality gate
// (computeMaterialChangeSignature, summariseSlotStatus, shouldFire,
// MIN_CALL_INTERVAL_SECONDS) likewise lives in ./recommendation-materiality.ts
// (issue #1986). The engine factory below composes these pure functions with
// the Redis/LLM/cap deps.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Engine API — invoked from the turn_end stream consumer
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
 * `onTurnEnd`, which is wired up by the consumer in `src/index.ts` to the
 * `hydra:autopilot:slot-events` stream.
 */
export function createRecommendationEngine(deps: EngineDeps): RecommendationEngine {
  const redis = deps.redis ?? (defaultRedis as RecsRedisFacade);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  // The billing ledger (issue #2119). Default-construct a production enforcer
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
// Production LLM client — thin wrapper over the Anthropic Request Adapter
// ---------------------------------------------------------------------------

const HAIKU_MODEL = "claude-haiku-4-5";

/** Per-million-token cost estimates for the engine's accounting. */
const HAIKU_INPUT_PER_MTOK_USD = 1.0;
const HAIKU_OUTPUT_PER_MTOK_USD = 5.0;

/**
 * Build the production LLM client. This is now a THIN wrapper over the
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
 * Exported (issue #2024) so the recommendation-consumer Module — which now owns
 * the stream lifecycle — can wire this production client into the engine it
 * constructs. The cost-gate accounting stays engine-side; this client only
 * derives a per-call USD figure the engine then charges.
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

// ---------------------------------------------------------------------------
// Stream consumer lifecycle — extracted to its own Seam (issue #2024).
//
// The XREADGROUP polling loop, consumer-group registration, ACK path, the
// pid-scoped consumer descriptor, the raw-stream-event parser, and the
// Redis-backed prompt readers now live in `./recommendation-consumer.ts`,
// mirroring the notification-consumer (#1376) / slot-events-bridge siblings.
// This file stays a pure function of injected `EngineDeps` — it owns the LLM
// policy, the prompt schema, and the material-change gate, and DELEGATES the
// cost-gate accounting (HYDRA_RECS_DAILY_CAP_USD) to the injected
// `capEnforcer` (recommendation-cap.ts, issue #2119) — with NO Redis-stream
// imports.
//
// `recsEngineConsumer` / `parseTurnEndStreamEvent` / `startRecommendationConsumer`
// are imported directly from `./recommendation-consumer.ts` at every call site
// (src/index.ts, src/notification-consumer.ts, the consumer's own test), so the
// back-compat re-export they once had here is dead and was removed (issue #2048).
// `defaultLlmClient` is exported above so the consumer can wire it into the
// engine it constructs.
// ---------------------------------------------------------------------------
