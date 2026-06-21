/**
 * Recommendation-consumer Module (issue #2024) — the process-level stream
 * lifecycle for the autopilot recommendation engine.
 *
 * Lifted out of `src/autopilot/recommendation-engine.ts`, mirroring the
 * notification-consumer (#1376) and slot-events-bridge sibling consumers. The
 * engine module (`recommendation-engine.ts`) stays a pure function of injected
 * `EngineDeps` — it owns the LLM policy, the prompt schema, the
 * material-change gate, and the `HYDRA_RECS_DAILY_CAP_USD` cost accounting.
 * THIS Module owns only the infrastructure that wraps the engine: the
 * `hydra:autopilot:slot-events` XREADGROUP polling loop, the consumer-group
 * registration, the ACK path, the pid-scoped consumer descriptor for the
 * SIGTERM shutdown, the raw-stream-event parser, and the Redis-backed prompt
 * readers that wire the engine to live autopilot state.
 *
 * Cost-gate boundary (CONTEXT.md L203 / ADR-0005): no USD accounting lives
 * here. The consumer only constructs the cap enforcer (the daily-cap ledger
 * section of recommendation-engine.ts, issue #2119, folded back in #2317) and
 * WIRES its `oak_resting` fan-out to the WS registry; the daily cap, the spend
 * read/charge, and the once-per-day latch all live behind the enforcer. The
 * split moves wiring, not policy.
 *
 * Stream invariants preserved 1:1 from the pre-split engine:
 *   - consumer-group name `recs-engine` on stream `hydra:autopilot:slot-events`
 *   - start-id `$` (only-new-events): a regression to `0` would replay the
 *     entire slot-events stream on every restart
 *   - pid-scoped consumer name `recs-<pid>` (so `recsEngineConsumer()` still
 *     matches what `startRecommendationConsumer` registers — index.ts:205
 *     SIGTERM delConsumer depends on it)
 *   - x* stream ops route through the Event Bus (ADR-0017 Category B):
 *     `ensureConsumerGroup` for CREATE, `consume()` with
 *     `{count:16, blockMs:5000, reapStale:true}`
 */

import {
  createRecommendationEngine,
  createCapEnforcer,
  defaultLlmClient,
  type TurnEndPayload,
  type RecentTurn,
  type SlotSnapshot,
  type SignalsSnapshot,
  type PermissionWaitEvent,
} from "./recommendation-engine.ts";

// ---------------------------------------------------------------------------
// Stream consumer wiring — bound to the `hydra:autopilot:slot-events`
// stream that slice A (#668) emits `turn_end` events onto.
// ---------------------------------------------------------------------------

const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";
const RECS_CONSUMER_GROUP = "recs-engine";
const TURN_END_BROADCAST_STREAM = "autopilot:recs-pause";

/** Default consumer name for this process's recs-engine consumer (pid-scoped). */
function defaultRecsConsumerName(): string {
  return `recs-${process.pid}`;
}

/**
 * The `{stream, group, consumer}` descriptor for THIS process's recs-engine
 * consumer — so the SIGTERM shutdown path can best-effort DELCONSUMER its own
 * name on graceful exit (issue #1221). Mirrors the name
 * `startRecommendationConsumer` registers.
 */
export function recsEngineConsumer(): { stream: string; group: string; consumer: string } {
  return { stream: SLOT_EVENTS_STREAM, group: RECS_CONSUMER_GROUP, consumer: defaultRecsConsumerName() };
}

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
    opts?: { count?: number; blockMs?: number; reapStale?: boolean },
  ) => Promise<void>;
  ensureConsumerGroup: (
    stream: string,
    group: string,
    startId?: string,
  ) => Promise<void>;
  // The named WS broadcast surface (issue #1965): the recs engine fans its
  // `oak_resting` badge out through the registry rather than reaching the
  // bus's former private `_broadcastToClients` method. Optional so a
  // Redis-only test stub need not stand up a WS registry.
  wsRegistry?: { broadcast: (stream: string, event: unknown) => void };
}): Promise<void> {
  // Stream (x*) ops are ADR-0017 Category B — the Event Bus is the sanctioned
  // raw-connection owner. Route the consumer-group CREATE through
  // `ensureConsumerGroup` instead of a dynamically-imported raw connection
  // (issue #1121). The start-id MUST stay "$" (only-new-events): a regression to
  // "0" would replay the entire slot-events stream on every restart. The Event
  // Bus already swallows BUSYGROUP internally, so the manual try/catch is gone.
  await eventBus.ensureConsumerGroup(SLOT_EVENTS_STREAM, RECS_CONSUMER_GROUP, "$");

  // The billing ledger (issue #2119) — the cap amount, spend read/charge, and
  // the oak_resting latch live in the daily-cap ledger section of
  // recommendation-engine.ts (folded back in #2317). The consumer's only job is
  // to wire its `oak_resting` fan-out to the WS registry; the daily cap, the
  // per-Mtok rates, and `incrDailySpendUsd` all stay behind the enforcer. The
  // split moves wiring, not policy.
  const capEnforcer = createCapEnforcer({
    broadcastResting: (runId, spend, cap) => {
      try {
        eventBus.wsRegistry?.broadcast(TURN_END_BROADCAST_STREAM, {
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

  const engine = createRecommendationEngine({
    llm: defaultLlmClient(),
    readRecentTurns: defaultReadRecentTurns,
    readSlotSnapshot: defaultReadSlotSnapshot,
    readSignalsSnapshot: defaultReadSignalsSnapshot,
    readRecentPermissionWaits: defaultReadRecentPermissionWaits,
    capEnforcer,
  });

  const consumerName = defaultRecsConsumerName();
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
    // reapStale: this group is `$`-anchored advisory recs work, so dropping a
    // dead zombie consumer's PEL on restart is correct (#1221).
    { count: 16, blockMs: 5000, reapStale: true },
  );
}
