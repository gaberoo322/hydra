/**
 * Stuckness detector (issue #242, ADR-0003, ADR-0004 work-order step 2).
 *
 * Stuckness = cycles elapsed since any Target Outcome moved favorably and
 * stayed moved. Distinct from cycle failure — green cycles can be stuck.
 *
 * Reads outcomes declared via `loadOutcomes()` (#241), polls their current
 * values via the source adapters, and stores a per-outcome time series in
 * Redis as a sorted set keyed by cycle index. Computes whether each outcome
 * has exceeded its declared `stuckness_threshold_cycles` without a favorable
 * + sustained move (sustained = the favorable move was not reversed within
 * the next 2 cycle readings).
 *
 * This module ONLY surfaces the signal. Autopilot/scheduler consumption of
 * "stuckness fired ⇒ research instead of dev" is a separate downstream
 * issue per ADR-0003. The detector publishes `outcomes.stuckness.fired`
 * exactly once per not-stuck → stuck transition so consumers can subscribe
 * without polling.
 *
 * Per CLAUDE.md conventions:
 *   - Never throws out of `recordOutcomeReadings()` — every error path logs
 *     `[stuckness]` and returns. The cycle must never crash because outcome
 *     polling failed.
 *   - All Redis access goes through the shared connection accessor exported
 *     by redis-adapter.ts. Per the Untouchable Core list (ADR-0001), the
 *     adapter file itself is frozen, so we use `getRedisConnection()` and
 *     issue commands inline — same pattern other modules (digest, learning)
 *     already follow.
 */

import { loadOutcomes, getOutcomeValue, type Outcome } from "./outcomes.ts";
import { getRedisConnection } from "./redis-adapter.ts";
import { STREAMS } from "./event-bus.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HISTORY_MAX = 200;            // trim ZSET to last 200 readings per outcome
const SUSTAIN_WINDOW = 2;            // a favorable move must hold for 2 follow-up cycles
const FIRED_STATE_TTL_S = 60 * 60 * 24 * 30; // 30d — outcome stuck-state cache

/** Redis key generators — kept inline because `src/redis-keys.ts` is touchable
 *  but adding domain-specific keys for an experimental subsystem here keeps
 *  the diff scoped per ADR-0004 work-order. Future consolidation is fine. */
function historyKey(name: string): string {
  return `hydra:outcomes:history:${name}`;
}
function firedStateKey(name: string): string {
  return `hydra:outcomes:stuckness-fired:${name}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutcomeHistoryEntry {
  /** Cycle index (sorted-set score) — monotonically increasing per outcome. */
  cycleIndex: number;
  /** Numeric outcome reading at that cycle. */
  value: number;
  /** Cycle identifier (control-loop cycleId) that produced the reading. */
  cycleId: string;
  /** ISO timestamp when the reading was recorded. */
  ts: string;
}

export interface StucknessResult {
  name: string;
  /** Number of cycles since the last sustained favorable move. */
  cyclesStuck: number;
  /** True iff `cyclesStuck >= outcome.stuckness_threshold_cycles`. */
  fired: boolean;
  /** Configured threshold (echoed for caller convenience). */
  threshold: number;
  /** Cycle id of the last sustained favorable move, or null if none yet. */
  lastFavorableCycleId: string | null;
  /** Outcome kind — needed by anchor-selection to prefer leading over terminal
   *  per ADR-0003 vision vector 1 (#253). Undefined for unknown-outcome paths
   *  where we synthesize a baseline result without a config entry. */
  kind?: "leading" | "terminal";
}

// ---------------------------------------------------------------------------
// History helpers (pure-ish — take Redis client for testability)
// ---------------------------------------------------------------------------

/**
 * Append a reading to the per-outcome time series. The cycle index is the
 * sorted-set score (ZADD), the JSON-encoded entry is the member. Bounded
 * to `HISTORY_MAX` newest entries via ZREMRANGEBYRANK.
 *
 * Exported for unit testing. Callers in production should use
 * `recordOutcomeReadings()` which handles the loadOutcomes + polling flow.
 */
export async function pushOutcomeReading(
  redis: any,
  name: string,
  entry: OutcomeHistoryEntry,
): Promise<void> {
  const key = historyKey(name);
  await redis.zadd(key, entry.cycleIndex, JSON.stringify(entry));
  // Keep newest HISTORY_MAX (ZREMRANGEBYRANK takes a [start, stop] of ranks
  // from oldest to newest; -1 = newest. To keep the last N we remove the
  // bottom of the rank list when length exceeds N.)
  await redis.zremrangebyrank(key, 0, -HISTORY_MAX - 1);
}

/**
 * Fetch the most recent `n` readings for an outcome in chronological order
 * (oldest → newest). Returns `[]` when the key does not exist or no entry
 * parses — the detector treats missing history as `cyclesStuck: 0`.
 */
export async function getOutcomeHistory(
  redis: any,
  name: string,
  n = HISTORY_MAX,
): Promise<OutcomeHistoryEntry[]> {
  const key = historyKey(name);
  // ZRANGE with WITHSCORES — newest at the top; reverse for chronological order
  // We use the rank-based form (0..-1) and then slice. Bounded by HISTORY_MAX
  // already so this is at most 200 entries.
  const raw: string[] = await redis.zrange(key, 0, -1);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const entries: OutcomeHistoryEntry[] = [];
  for (const r of raw) {
    try {
      const parsed = JSON.parse(r);
      if (
        parsed &&
        typeof parsed.cycleIndex === "number" &&
        typeof parsed.value === "number" &&
        typeof parsed.cycleId === "string"
      ) {
        entries.push(parsed as OutcomeHistoryEntry);
      }
    } catch {
      /* intentional: skip corrupted entries; history is best-effort, not load-bearing */
    }
  }
  // Ensure chronological order (sorted-set already returns ascending by score
  // but be defensive — duplicates or out-of-order writes shouldn't crash).
  entries.sort((a, b) => a.cycleIndex - b.cycleIndex);
  return entries.slice(-n);
}

// ---------------------------------------------------------------------------
// Core stuckness computation — pure on history array
// ---------------------------------------------------------------------------

/**
 * Decide whether a transition from `prev` to `curr` is "favorable" for the
 * outcome's declared direction, accounting for `noise_epsilon`. The epsilon
 * is treated as the minimum absolute change required to count as movement
 * (so a 0.0001 jitter on a 0-to-1 ratio outcome with epsilon=0.01 does NOT
 * count as a favorable move).
 */
export function isFavorableMove(
  prev: number,
  curr: number,
  direction: "up" | "down",
  noiseEpsilon: number,
): boolean {
  const delta = curr - prev;
  const eps = Number.isFinite(noiseEpsilon) ? Math.abs(noiseEpsilon) : 0;
  if (Math.abs(delta) <= eps) return false;
  if (direction === "up") return delta > 0;
  return delta < 0;
}

/**
 * Decide whether a favorable move from `history[i-1]` to `history[i]`
 * sustained — i.e. did NOT reverse direction within the next `SUSTAIN_WINDOW`
 * cycle readings. The move is considered sustained if every reading in
 * `history.slice(i+1, i+1+SUSTAIN_WINDOW)` remains at-or-better than
 * `history[i-1].value` (i.e. didn't slip back across the prior baseline).
 *
 * If there are fewer than SUSTAIN_WINDOW follow-up readings, we conservatively
 * report unsustained — the detector waits for evidence rather than firing on
 * a transient blip.
 */
export function isSustained(
  history: OutcomeHistoryEntry[],
  movedAt: number,
  direction: "up" | "down",
): boolean {
  if (movedAt < 1 || movedAt >= history.length) return false;
  const baseline = history[movedAt - 1].value;
  const followups = history.slice(movedAt + 1, movedAt + 1 + SUSTAIN_WINDOW);
  if (followups.length < SUSTAIN_WINDOW) return false;
  // "Sustained" = follow-up values stay on the favorable side of the baseline.
  for (const f of followups) {
    if (direction === "up" && f.value <= baseline) return false;
    if (direction === "down" && f.value >= baseline) return false;
  }
  return true;
}

/**
 * Pure computation given an outcome definition and its full history.
 * Separated so unit tests don't need Redis.
 *
 * Algorithm:
 *   1. Walk history newest → oldest, find the most recent index `i` (with
 *      `i >= 1`) where the move from `history[i-1]` to `history[i]` was
 *      favorable AND sustained.
 *   2. `cyclesStuck` = number of readings AFTER that sustained move (the
 *      tail of stagnation). If no such move ever happened, `cyclesStuck`
 *      is the full history length.
 *   3. `fired` iff `cyclesStuck >= outcome.stuckness_threshold_cycles`.
 *
 * Missing/short history (< 2 readings) returns `cyclesStuck: 0` — we can't
 * possibly know the outcome is stuck without at least one comparison.
 */
export function computeStucknessFromHistory(
  outcome: Outcome,
  history: OutcomeHistoryEntry[],
): StucknessResult {
  const baseResult: StucknessResult = {
    name: outcome.name,
    cyclesStuck: 0,
    fired: false,
    threshold: outcome.stuckness_threshold_cycles,
    lastFavorableCycleId: null,
    kind: outcome.kind,
  };

  if (history.length < 2) {
    return baseResult;
  }

  // Walk newest → oldest looking for a sustained favorable move.
  // The most recent reading is at history[history.length - 1].
  let lastFavorableAt: number | null = null;
  for (let i = history.length - 1; i >= 1; i--) {
    const prev = history[i - 1].value;
    const curr = history[i].value;
    if (!isFavorableMove(prev, curr, outcome.direction, outcome.noise_epsilon)) continue;
    if (isSustained(history, i, outcome.direction)) {
      lastFavorableAt = i;
      break;
    }
  }

  const cyclesStuck = lastFavorableAt === null
    ? history.length
    : history.length - 1 - lastFavorableAt;

  return {
    name: outcome.name,
    cyclesStuck,
    fired: cyclesStuck >= outcome.stuckness_threshold_cycles,
    threshold: outcome.stuckness_threshold_cycles,
    lastFavorableCycleId: lastFavorableAt !== null
      ? history[lastFavorableAt].cycleId
      : null,
    kind: outcome.kind,
  };
}

// ---------------------------------------------------------------------------
// Public API — wraps Redis I/O + outcomes config loading
// ---------------------------------------------------------------------------

/**
 * Compute stuckness for a single named outcome by name. Returns a baseline
 * result (cyclesStuck: 0, fired: false) when the outcome is unknown or has
 * no history yet — never throws.
 */
export async function computeStuckness(name: string): Promise<StucknessResult> {
  try {
    const result = await loadOutcomes();
    if (result.ok === false) {
      console.error(`[stuckness] loadOutcomes failed: ${result.errors.join("; ")}`);
      return { name, cyclesStuck: 0, fired: false, threshold: 0, lastFavorableCycleId: null };
    }
    const outcome = result.outcomes.find((o) => o.name === name);
    if (!outcome) {
      return { name, cyclesStuck: 0, fired: false, threshold: 0, lastFavorableCycleId: null };
    }
    const redis = getRedisConnection();
    const history = await getOutcomeHistory(redis, name);
    return computeStucknessFromHistory(outcome, history);
  } catch (err: any) {
    console.error(`[stuckness] computeStuckness('${name}') failed: ${err?.message || String(err)}`);
    return { name, cyclesStuck: 0, fired: false, threshold: 0, lastFavorableCycleId: null };
  }
}

/** Compute stuckness for every declared outcome. Never throws. */
export async function getAllStuckness(): Promise<StucknessResult[]> {
  try {
    const result = await loadOutcomes();
    if (result.ok === false) {
      console.error(`[stuckness] getAllStuckness: loadOutcomes failed: ${result.errors.join("; ")}`);
      return [];
    }
    const outcomes = result.outcomes;
    const redis = getRedisConnection();
    const rows: StucknessResult[] = [];
    for (const o of outcomes) {
      try {
        const history = await getOutcomeHistory(redis, o.name);
        rows.push(computeStucknessFromHistory(o, history));
      } catch (err: any) {
        console.error(`[stuckness] history fetch failed for '${o.name}': ${err?.message || String(err)}`);
        rows.push({
          name: o.name,
          cyclesStuck: 0,
          fired: false,
          threshold: o.stuckness_threshold_cycles,
          lastFavorableCycleId: null,
          kind: o.kind,
        });
      }
    }
    return rows;
  } catch (err: any) {
    console.error(`[stuckness] getAllStuckness failed: ${err?.message || String(err)}`);
    return [];
  }
}

/**
 * Record the current value of every declared outcome for this cycle, then
 * compute stuckness and emit `outcomes.stuckness.fired` once per outcome
 * that transitioned from not-stuck to stuck.
 *
 * Per ADR-0004 / CLAUDE.md: this function NEVER throws. Errors are logged
 * and swallowed so a Redis hiccup or unreachable adapter cannot crash the
 * cycle. Outcome polling that returns null (adapter unreachable / no data)
 * is also non-fatal — the entry is simply skipped, not synthesized as a
 * regression.
 *
 * @param cycleId  Control-loop cycleId for this reading.
 * @param eventBus Optional event bus; when provided, transitions emit on
 *                 STREAMS.NOTIFICATIONS so digest + dashboard see them.
 *                 Tests can omit it.
 */
export async function recordOutcomeReadings(
  cycleId: string,
  eventBus?: { publish: (stream: string, event: any) => Promise<any> } | null,
): Promise<void> {
  try {
    if (typeof cycleId !== "string" || cycleId.length === 0) {
      console.error(`[stuckness] recordOutcomeReadings: invalid cycleId (got ${typeof cycleId})`);
      return;
    }

    const result = await loadOutcomes();
    if (result.ok === false) {
      console.error(`[stuckness] recordOutcomeReadings: loadOutcomes failed: ${result.errors.join("; ")}`);
      return;
    }
    const outcomes = result.outcomes;
    if (outcomes.length === 0) {
      // No outcomes declared — nothing to track. Don't log; this is the
      // expected state on day one and would otherwise spam every cycle.
      return;
    }

    const redis = getRedisConnection();
    const ts = new Date().toISOString();

    for (const outcome of outcomes) {
      let reading: { value: number; ts: string } | null = null;
      try {
        reading = await getOutcomeValue(outcome);
      } catch (err: any) {
        /* intentional: getOutcomeValue already swallows internally and logs,
           but defend against future adapter regressions so the loop continues. */
        console.error(`[stuckness] getOutcomeValue('${outcome.name}') threw: ${err?.message || String(err)}`);
        reading = null;
      }
      if (!reading || !Number.isFinite(reading.value)) {
        // No data this cycle — skip rather than synthesize. Per #241 the
        // null path is the documented "unreachable / not yet adapted"
        // contract; counting it as a regression would falsely fire stuckness.
        continue;
      }

      // Determine next cycle index: existing max + 1 (or 0 for the first reading).
      let nextIndex = 0;
      try {
        const last = await redis.zrange(historyKey(outcome.name), -1, -1, "WITHSCORES");
        if (Array.isArray(last) && last.length >= 2) {
          const score = Number(last[1]);
          if (Number.isFinite(score)) nextIndex = score + 1;
        }
      } catch (err: any) {
        console.error(`[stuckness] failed to fetch tail index for '${outcome.name}': ${err?.message || String(err)}`);
      }

      const entry: OutcomeHistoryEntry = {
        cycleIndex: nextIndex,
        value: reading.value,
        cycleId,
        ts,
      };
      try {
        await pushOutcomeReading(redis, outcome.name, entry);
      } catch (err: any) {
        console.error(`[stuckness] pushOutcomeReading('${outcome.name}') failed: ${err?.message || String(err)}`);
        continue;
      }

      // Compute stuckness for this outcome with the fresh entry included.
      let stuckness: StucknessResult;
      try {
        const history = await getOutcomeHistory(redis, outcome.name);
        stuckness = computeStucknessFromHistory(outcome, history);
      } catch (err: any) {
        console.error(`[stuckness] computeStucknessFromHistory('${outcome.name}') failed: ${err?.message || String(err)}`);
        continue;
      }

      // Edge-trigger: fire event only on not-stuck → stuck transition.
      // The fired-state cache key holds "1" while the outcome is stuck;
      // we delete it on recovery so the next transition fires again.
      let wasStuck = false;
      try {
        const cached = await redis.get(firedStateKey(outcome.name));
        wasStuck = cached === "1";
      } catch (err: any) {
        console.error(`[stuckness] failed to read fired-state for '${outcome.name}': ${err?.message || String(err)}`);
      }

      if (stuckness.fired && !wasStuck) {
        try {
          await redis.set(firedStateKey(outcome.name), "1", "EX", FIRED_STATE_TTL_S);
        } catch (err: any) {
          console.error(`[stuckness] failed to set fired-state for '${outcome.name}': ${err?.message || String(err)}`);
        }
        if (eventBus) {
          try {
            await eventBus.publish(STREAMS.NOTIFICATIONS, {
              type: "outcomes.stuckness.fired",
              source: "stuckness",
              correlationId: cycleId,
              payload: {
                outcome: stuckness.name,
                cyclesStuck: stuckness.cyclesStuck,
                threshold: stuckness.threshold,
                kind: outcome.kind,
                direction: outcome.direction,
                lastFavorableCycleId: stuckness.lastFavorableCycleId,
              },
            });
          } catch (err: any) {
            console.error(`[stuckness] failed to publish stuckness.fired for '${outcome.name}': ${err?.message || String(err)}`);
          }
        }
        console.log(`[stuckness] FIRED: ${outcome.name} stuck for ${stuckness.cyclesStuck} cycles (threshold: ${stuckness.threshold})`);
      } else if (!stuckness.fired && wasStuck) {
        try {
          await redis.del(firedStateKey(outcome.name));
          console.log(`[stuckness] cleared: ${outcome.name} no longer stuck (cyclesStuck: ${stuckness.cyclesStuck})`);
        } catch (err: any) {
          console.error(`[stuckness] failed to clear fired-state for '${outcome.name}': ${err?.message || String(err)}`);
        }
      }
    }
  } catch (err: any) {
    /* Top-level safety net — must never throw out of recordOutcomeReadings. */
    console.error(`[stuckness] recordOutcomeReadings top-level: ${err?.message || String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Internal exports for tests
// ---------------------------------------------------------------------------

export const _internal = {
  historyKey,
  firedStateKey,
  HISTORY_MAX,
  SUSTAIN_WINDOW,
};
