/**
 * budget-threshold-bridge.ts — emit `budget_threshold` events as the
 * autopilot's daily spend crosses configurable percentage tiers (issue #673).
 *
 * # What it does
 *
 * Periodically reads the legacy `hydra:scheduler:daily-spend` JSON blob
 * (kept around for back-compat — see CLAUDE.md "Daily spend tracking still
 * flows through `hydra:scheduler:daily-spend`"), computes the percentage
 * of the configured daily cap that's been spent, and on the FIRST crossing
 * of each tier (50%, 75%, 90% by default) within a UTC day, XADDs a
 * `budget_threshold` event onto `hydra:autopilot:slot-events`.
 *
 * The existing `slot-events-bridge.ts` consumer then re-broadcasts the
 * event over the WS channel under stream name `autopilot:slot-events`
 * (envelope `type: "slot-event"`, `payload.event: "budget_threshold"`) so
 * dashboard tiles like CoinBag can light up reactively without a round-
 * trip to the REST API.
 *
 * # Why publish onto the existing slot-events stream
 *
 * Slot-events is already the WS-broadcast surface for everything the
 * /now-pixel dashboard wants live (subagent_stop, slot_waiting_permission).
 * Funneling new event types through the same stream keeps the dashboard
 * subscriber model — `useWebSocket().subscribe("slot-event", ...)` —
 * unchanged and gives us the existing reconnect / WS fan-out for free.
 * The `payload.event` discriminator lets consumers pattern-match per
 * type. We do NOT add a sibling stream; that would require parallel
 * bridge plumbing and a second WS subscription path.
 *
 * # Idempotency
 *
 * Per acceptance criterion 2 (#673): "emits exactly one budget_threshold
 * event per (UTC day, threshold) pair". Implemented via a Redis SETNX with
 * TTL keyed on `hydra:autopilot:budget-threshold:<date>:<pct>` — see
 * `claimBudgetThresholdSeen` in `src/redis/scheduler.ts`. The 30h TTL is
 * deliberately longer than 24h so a sentinel that almost-expires near a UTC
 * boundary cannot be reclaimed prematurely.
 *
 * # Spend & cap sources
 *
 * - **Spend:** parsed from the legacy `hydra:scheduler:daily-spend` blob
 *   (`{ date, usd, updatedAt }`). When the blob's `date` field doesn't
 *   match today's UTC date OR the key is missing, we treat spend as $0
 *   (no crossings can fire). This matches the dashboard's CoinBag.
 * - **Cap:** read from `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD` (default 50.0).
 *   This is the same env var the autopilot bootstrap writes into
 *   `state.limits.daily_spend_cap_usd` so the bridge and the autopilot's
 *   own gate stay in sync. Cap <= 0 → bridge disabled (no events fire);
 *   the operator can opt out by exporting `HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD=0`.
 *
 * # Lifecycle
 *
 * `startBudgetThresholdBridge(eventBus, opts?)` returns a stop function.
 * The stop function clears the polling interval; in-flight Redis ops finish
 * naturally. `src/index.ts` calls it on SIGTERM as part of the graceful
 * shutdown sequence.
 *
 * # Failure handling
 *
 * Every poll iteration is wrapped — a single Redis hiccup logs and
 * continues; the bridge never throws into the parent. This matches the
 * pattern used by `slot-events-bridge.ts` (consume-loop swallow + restart-
 * with-backoff in `startConsumerWithRecovery`). Unlike slot-events-bridge,
 * this is a polling loop rather than a blocking XREADGROUP, so a thrown
 * exception would just terminate setInterval's callback — we still log
 * loudly so a recurring failure shows up in journalctl.
 */

import {
  getDailySpendRaw,
  claimBudgetThresholdSeen,
} from "../redis/scheduler.ts";
import { getRedisConnection } from "../redis/connection.ts";
import { todayDateString } from "../cost/surrogate.ts";

export const SLOT_EVENTS_STREAM = "hydra:autopilot:slot-events";

/** Default thresholds — 50/75/90 per #673 acceptance criteria. */
export const DEFAULT_THRESHOLDS = [50, 75, 90] as const;

/** 30 hours — longer than a UTC day so SETNX guard survives boundary jitter. */
export const BUDGET_THRESHOLD_TTL_SECONDS = 30 * 3600;

/** Default poll interval. The dashboard polls /now/cost-burn at 30s, so a 30s
 * threshold tick keeps the two paths in sync without doubling Redis load. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Match the slot-events stream's MAXLEN cap (see on-subagent-stop.sh). */
const STREAM_MAXLEN = 1000;

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Read the configured daily cap in USD. Returns 0 (disabled) for invalid /
 * unset values. Re-reads env on every call so a `systemctl restart` with a
 * new EnvironmentFile= picks up the new cap without code changes.
 */
export function getDailySpendCapUsd(): number {
  const raw = process.env.HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD;
  if (raw === undefined || raw === "") return 50.0;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Parse the legacy daily-spend blob and extract today's USD. The blob has
 * shape `{ date: "YYYY-MM-DD", usd: number, updatedAt: ISO }` — we treat a
 * stale `date` as $0 because the autopilot does its own per-day reset.
 */
export function parseDailySpendBlob(
  raw: string | null,
  today: string,
): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return 0;
    if (parsed.date !== today) return 0;
    const u = parseFloat(parsed.usd);
    if (!Number.isFinite(u) || u < 0) return 0;
    return u;
  } catch {
    /* intentional: legacy blob unparseable — treat as zero */
    return 0;
  }
}

/**
 * Compute which (ascending) thresholds have been crossed given the current
 * spend and cap. Returns the thresholds in ascending order so the caller
 * fires events in a stable sequence (50 before 75 before 90).
 *
 * Pure — no Redis, no time, no I/O. Easy to unit-test.
 */
export function computeCrossedThresholds(
  spendUsd: number,
  capUsd: number,
  thresholds: readonly number[] = DEFAULT_THRESHOLDS,
): number[] {
  if (!Number.isFinite(spendUsd) || spendUsd <= 0) return [];
  if (!Number.isFinite(capUsd) || capUsd <= 0) return [];
  const pct = (spendUsd / capUsd) * 100;
  const out: number[] = [];
  for (const t of [...thresholds].sort((a, b) => a - b)) {
    if (pct >= t) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bridge entrypoint
// ---------------------------------------------------------------------------

export interface BudgetThresholdBridgeOpts {
  /** Override poll interval (ms). Defaults to 30s. Tests pass tiny values. */
  pollIntervalMs?: number;
  /** Override thresholds. Defaults to [50, 75, 90]. */
  thresholds?: readonly number[];
  /** Override the today-date function — tests pin a synthetic date. */
  now?: () => Date;
  /**
   * Single-shot mode for tests. When true, runs exactly one tick and
   * returns; otherwise spins up setInterval and returns a stop fn.
   */
  oneShot?: boolean;
}

export interface BudgetThresholdBridge {
  /** Stop the polling loop. Idempotent. */
  stop(): void;
}

/**
 * Start the budget-threshold bridge. The bridge polls on an interval and
 * emits at most one `budget_threshold` event per (UTC day, threshold) pair
 * onto the slot-events stream.
 *
 * Returns a `BudgetThresholdBridge` with a `stop()` method. The bridge
 * survives Redis disconnects (each tick is independently wrapped). The
 * caller is responsible for calling `stop()` on graceful shutdown.
 */
export async function startBudgetThresholdBridge(
  opts: BudgetThresholdBridgeOpts = {},
): Promise<BudgetThresholdBridge> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const nowFn = opts.now ?? (() => new Date());

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const today = todayDateString(nowFn());
      const cap = getDailySpendCapUsd();
      if (cap <= 0) return; // Bridge disabled.

      const raw = await getDailySpendRaw();
      const spend = parseDailySpendBlob(raw, today);
      if (spend <= 0) return;

      const crossed = computeCrossedThresholds(spend, cap, thresholds);
      if (crossed.length === 0) return;

      for (const threshold of crossed) {
        const claimed = await claimBudgetThresholdSeen(
          today,
          threshold,
          BUDGET_THRESHOLD_TTL_SECONDS,
        );
        if (!claimed) continue;
        await emitBudgetThresholdEvent({
          threshold,
          spendUsd: spend,
          capUsd: cap,
          date: today,
        });
      }
    } catch (err: any) {
      console.error(
        `[budget-threshold-bridge] tick failed: ${err?.message || err}`,
      );
    }
  }

  if (opts.oneShot) {
    await tick();
    return {
      stop() {
        stopped = true;
      },
    };
  }

  console.log(
    `[budget-threshold-bridge] starting (interval=${pollIntervalMs}ms thresholds=${thresholds.join(",")} cap=${getDailySpendCapUsd()})`,
  );

  timer = setInterval(() => {
    void tick();
  }, pollIntervalMs);

  // Fire one tick immediately on startup so a service restart inside an
  // already-over-threshold day re-emits as the SETNX permits (it usually
  // won't, which is the correct idempotent behaviour).
  void tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      console.log("[budget-threshold-bridge] stopped");
    },
  };
}

// ---------------------------------------------------------------------------
// Stream emission
// ---------------------------------------------------------------------------

interface BudgetThresholdEventInput {
  threshold: number;
  spendUsd: number;
  capUsd: number;
  date: string;
}

/**
 * XADD a `budget_threshold` event onto the slot-events stream. The flat
 * field-value layout matches the convention `on-subagent-stop.sh` already
 * uses — `event` is the discriminator and consumers (slot-events-bridge,
 * dashboard subscribers) pattern-match on it.
 *
 * Exported for tests so the field shape is pinned independently of the
 * Redis round-trip.
 */
export async function emitBudgetThresholdEvent(
  input: BudgetThresholdEventInput,
): Promise<string> {
  const r = getRedisConnection();
  const pctSpent = (input.spendUsd / input.capUsd) * 100;
  // Stable, parseable wire shape: every field is a string.
  const fields = [
    "event", "budget_threshold",
    "threshold", String(input.threshold),
    "date", input.date,
    "spend_usd", input.spendUsd.toFixed(4),
    "cap_usd", input.capUsd.toFixed(4),
    "pct_spent", pctSpent.toFixed(2),
    "ts_epoch", String(Math.floor(Date.now() / 1000)),
  ];
  return r.xadd(
    SLOT_EVENTS_STREAM,
    "MAXLEN", "~", String(STREAM_MAXLEN),
    "*",
    ...fields,
  );
}
