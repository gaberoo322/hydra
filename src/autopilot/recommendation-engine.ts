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
 * ## Module shape (issue #2317, #2867, #3099)
 *
 * This module is the deep composition point for the recs engine. It was
 * decomposed into five sibling files via successive extraction PRs (#1986
 * materiality, #2240 prompt, #2119 cap, #2024 consumer), which produced a
 * shallow pass-through; #2317 folded the four PURE concerns back into one
 * module organised by concern SECTION rather than by file. #2867 then
 * RE-EXTRACTED the prompt-grammar concern to a focused leaf
 * (`recommendation-prompt.ts`) because that concern has an independent caller
 * shape — a promptfoo A/B eval (`evals/`) imports `buildPrompt` directly, and
 * dragging in the cap ledger and the Anthropic Request Adapter at module-load
 * time is friction a scorer should not pay. #3099 then RE-EXTRACTED the
 * materiality gate to its own focused leaf (`recommendation-materiality.ts`):
 * it is the highest-consequence concern (a false negative silently skips a call
 * that should have fired, and it short-circuits on the sole sanctioned real-USD
 * cap), so a pure leaf gives its policy an independent, narrow test surface that
 * loads neither the Anthropic adapter nor Redis. #3499 then RE-EXTRACTED the
 * daily-cap ledger to its own focused leaf (`recommendation-cap.ts`): the cap's
 * mutable-ledger state (its behavior under reset / time-advance / date-rollover)
 * has a separate test-surface identity that the engine-factory coupling
 * obscured, so a pure leaf lets a cap test import zero Anthropic/prompt/engine
 * surface. The engine re-exports its symbols so the consumer + test surface is
 * byte-identical.
 *
 * The engine imports the prompt grammar (types + `buildPrompt` +
 * `parseLlmResponse` + `PROMPT_SIZE_BUDGET_BYTES`) from the prompt leaf and the
 * materiality gate (`shouldFire` + the signature helpers) from the materiality
 * leaf, the daily-cap ledger (`createCapEnforcer` + its types) from the cap leaf
 * (#3499), and RE-EXPORTS the types + functions it needs, so the `EngineDeps` /
 * `LlmResult` surface `recommendation-consumer.ts` consumes stays byte-identical
 * — no interface change is visible to the consumer.
 *
 * The one sibling that stays a separate stream-lifecycle file is
 * `recommendation-consumer.ts`: it owns the process-level stream lifecycle (the
 * XREADGROUP polling loop, the consumer-group registration, the SIGTERM
 * ACK/DELCONSUMER path, the Redis-backed prompt readers) — the real Seam
 * between the bus and this engine's call surface. It imports the engine's
 * interface from here.
 *
 * Section map (top → bottom):
 *   1. Prompt-grammar re-exports — the types + prompt builder/parser from the
 *      `recommendation-prompt.ts` leaf (#2867), re-exported to keep the
 *      consumer-facing surface stable.
 *   2. Materiality-gate re-exports — the pure fire-decision logic from the
 *      `recommendation-materiality.ts` leaf (#3099), re-exported to keep the
 *      consumer-facing + test surface stable.
 *   4. Daily-cap ledger re-exports — the billing concern + oak_resting latch
 *      from the `recommendation-cap.ts` leaf (#3499), re-exported to keep the
 *      consumer-facing + test surface stable.
 *   5. Engine factory — `createRecommendationEngine` composing 2+4 + the prompt leaf with the Redis/LLM deps
 *   6. Production LLM client — the thin Anthropic Request Adapter wrapper
 */

import { RUN_TTL_SECONDS } from "./sweep-reader.ts";
import * as defaultRedis from "../redis/recommendations.ts";
import { anthropicMessages, isAnthropicFailure } from "../anthropic/request.ts";
import {
  buildPrompt,
  parseLlmResponse,
  MAX_RECS_PER_CALL,
  type Recommendation,
  type TurnEndPayload,
  type RecentTurn,
  type SlotSnapshot,
  type SignalsSnapshot,
  type PermissionWaitEvent,
  type EnginePromptInput,
} from "./recommendation-prompt.ts";
import {
  MIN_CALL_INTERVAL_SECONDS,
  computeMaterialChangeSignature,
  summariseSlotStatus,
  shouldFire,
} from "./recommendation-materiality.ts";
import { createCapEnforcer, type CapEnforcer } from "./recommendation-cap.ts";

// ---------------------------------------------------------------------------
// SECTION 1 — Prompt-grammar re-exports (leaf: recommendation-prompt.ts, #2867)
//
// The prompt-grammar concern (the prompt builder, the response parser, the
// prompt-size budget, and the input/output types they operate over) lives in
// the `recommendation-prompt.ts` leaf so a promptfoo scorer can import
// `buildPrompt` without the engine's Redis/Anthropic transitive deps loading.
// We re-export the types + functions the consumer + tests already import from
// here so their surface is unchanged.
// ---------------------------------------------------------------------------

export {
  buildPrompt,
  type TurnEndPayload,
  type RecentTurn,
  type SlotSnapshot,
  type SignalsSnapshot,
  type PermissionWaitEvent,
} from "./recommendation-prompt.ts";

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
// SECTION 2 — Materiality-gate re-exports (leaf: recommendation-materiality.ts, #3099)
//
// The pure, deterministic fire-decision logic — `shouldFire`,
// `computeMaterialChangeSignature`, `summariseSlotStatus`,
// and `MIN_CALL_INTERVAL_SECONDS` — lives in the `recommendation-materiality.ts`
// leaf (#3099) so a test of this highest-consequence gate can import it without
// pulling in the Anthropic Request Adapter, the Redis seam, or the prompt
// builder at module-load time — the exact over-coupling #2867 extracted the
// prompt-grammar concern to fix. We re-export the symbols the consumer + tests
// already import from here so their surface is byte-identical.
//
// The gate is the deepest concern: a false negative here ("nothing changed")
// silently skips a call that should have fired, and the daily-spend cap it
// short-circuits on is the sole sanctioned real-USD surface (CONTEXT.md L203 /
// ADR-0005). The cap > interval > no-change ordering stays the SINGLE authority
// of `shouldFire()` in the leaf.
// ---------------------------------------------------------------------------

export {
  MIN_CALL_INTERVAL_SECONDS,
  computeMaterialChangeSignature,
  summariseSlotStatus,
  shouldFire,
} from "./recommendation-materiality.ts";

// ---------------------------------------------------------------------------
// SECTION 4 — Daily-cap ledger re-exports (leaf: recommendation-cap.ts, #3499)
//
// The recs-engine's **billing concern** — the single sanctioned real-USD
// surface on the orchestrator (CONTEXT.md L203 / ADR-0005:
// `recommendation-engine.ts` bills outside the subscription via the direct
// Anthropic API, so `HYDRA_RECS_DAILY_CAP_USD` is a live cost gate) — lives in
// the `recommendation-cap.ts` leaf (#3499). It owns the cap amount, the
// spend read/charge, the UTC date stamper, and the once-per-UTC-day
// `oak_resting` broadcast latch, with NO Anthropic/prompt/engine imports, so a
// cap test can import it in isolation. We re-export the symbols the consumer +
// tests already import from here so their surface is byte-identical.
//
// The load-bearing money-safety boundary is UNCHANGED by the extraction:
//   - the cap > interval > no-change ordering stays the SINGLE authority of
//     `shouldFire()` in SECTION 2. The ledger FEEDS `daily_spend_usd` +
//     `daily_cap_usd` into that decision; it never re-implements the `>=`
//     comparison or reorders the skip reasons. One short-circuit point means a
//     capped day can never fire a paid LLM call.
//   - the micro-USD INT rounding (USD*1e6 + INCRBY integer-safety) stays
//     entirely inside the Redis accessor (`src/redis/recommendations.ts`).
//
// The four cost invariants are preserved 1:1 (see the leaf's header):
//   1. READ-BEFORE-FIRE     2. CHARGE-AFTER-SUCCESS-ONLY
//   3. MICRO-USD INT confined to the Redis accessor
//   4. BROADCAST-ONCE-PER-UTC-DAY (the pauseDayState latch + rollover reset).
// ---------------------------------------------------------------------------

export {
  DEFAULT_DAILY_CAP_USD,
  envDailyCap,
  utcDateStamp,
  createCapEnforcer,
  type CapRedisFacade,
  type CapEnforcerDeps,
  type CapEnforcer,
} from "./recommendation-cap.ts";

// ---------------------------------------------------------------------------
// SECTION 5 — Engine factory
//
// `createRecommendationEngine` composes the materiality gate (SECTION 2), the
// prompt grammar (the `recommendation-prompt.ts` leaf, #2867) and the cap
// ledger (SECTION 4) with the injected Redis/LLM deps. The returned object
// has a single hot path,
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
