/**
 * Operator Channel delivery health (ADR-0045 Decision 8, issue #5048).
 *
 * "Make a silent channel noticeable": the one read-only summary the /health
 * page's Operator channel card renders — last page, last brief, and the 24h
 * failed / suppressed counts — folded from the three stores the channel
 * already keeps (the bounded delivery log, the per-dedupKey hashes and the
 * brief last-sent key). Nothing here writes.
 *
 * Two layers, same shape as the brief sources:
 *   - {@link summarizeDeliveryHealth} is PURE: log rows + dedup rows + the
 *     last-sent stamp + a clock in, a summary out. Unit-tested without Redis.
 *   - {@link readDeliveryHealth} binds the Redis accessors and is
 *     best-effort: every read runs under one timeout, and any failure yields
 *     `{available:false, reason}` with a logged error — never a throw, so the
 *     route answers 200 while Redis is down (the card renders UNKNOWN, never a
 *     confident "all delivered").
 *
 * What the 24h window counts (stated because the stores are asymmetric):
 *   - `failed`: delivery-log entries of ANY kind (page / reminder / recovered /
 *     brief) whose outcome is `failed`, stamped within the window.
 *   - `suppressed`: the sum of the `suppressed` counters of every CURRENTLY
 *     bad dedup state whose last send (`lastSentAt`) falls inside the window.
 *     Suppressions are deliberately not logged per event (a hot alarm would
 *     push real entries out of the bounded log — see listDedupStates), so the
 *     hash counter is the only record; it counts repeats absorbed since that
 *     key's last page or 6h reminder. A key that resolved (hash deleted)
 *     drops out of the sum — the figure is "repeats currently being held
 *     back", not a lifetime total.
 */

import { logger } from "../logger.ts";
import {
  redisDeliveryHealthReads,
  type DedupStateRow,
  type DeliveryLogEntry,
  type DeliveryOutcome,
} from "../redis/operator-channel.ts";

export const DELIVERY_HEALTH_WINDOW_HOURS = 24;
export const DELIVERY_HEALTH_WINDOW_MS = DELIVERY_HEALTH_WINDOW_HOURS * 60 * 60 * 1000;
/** Same bound the channel's own store calls fail open under. */
export const DELIVERY_HEALTH_READ_TIMEOUT_MS = 1500;

export interface LastPageSummary {
  /** ISO-8601 of the delivery attempt. */
  at: string;
  /** The log kind: a first page, a 6h reminder, or the recovered message. */
  kind: "page" | "reminder" | "recovered";
  dedupKey: string;
  title: string;
  outcome: DeliveryOutcome;
  status?: number;
}

export interface LastBriefSummary {
  at: string;
  outcome: DeliveryOutcome;
  status?: number;
}

export interface DeliveryHealthAvailable {
  available: true;
  generatedAt: string;
  lastPage: LastPageSummary | null;
  /** Newest `brief` delivery-log entry — delivered or not. */
  lastBrief: LastBriefSummary | null;
  /**
   * ISO-8601 of the last brief the transport DELIVERED (the Redis last-sent
   * key the scheduler and the watchdog's 26h alarm both read); null when no
   * brief was ever delivered.
   */
  lastBriefDeliveredAt: string | null;
  window: { hours: number; failed: number; suppressed: number };
}

export interface DeliveryHealthUnavailable {
  available: false;
  generatedAt: string;
  reason: string;
}

export type DeliveryHealth = DeliveryHealthAvailable | DeliveryHealthUnavailable;

export interface DeliveryHealthInputs {
  /** Newest-first, as readDeliveryLog returns it (order is not assumed). */
  log: DeliveryLogEntry[];
  dedupStates: DedupStateRow[];
  lastBriefSentAt: number | null;
  now: number;
}

const PAGE_LOG_KINDS = new Set<DeliveryLogEntry["kind"]>(["page", "reminder", "recovered"]);

function newest<T extends { at: number }>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) if (best === null || r.at > best.at) best = r;
  return best;
}

/** Pure fold of the three stores into the card's summary. */
export function summarizeDeliveryHealth(inputs: DeliveryHealthInputs): DeliveryHealthAvailable {
  const { log, dedupStates, lastBriefSentAt, now } = inputs;
  const windowStart = now - DELIVERY_HEALTH_WINDOW_MS;

  const page = newest(log.filter((e) => PAGE_LOG_KINDS.has(e.kind)));
  const brief = newest(log.filter((e) => e.kind === "brief"));

  const failed = log.filter((e) => e.outcome === "failed" && e.at >= windowStart).length;
  let suppressed = 0;
  for (const s of dedupStates) {
    if (s.lastSentAt >= windowStart) suppressed += s.suppressed;
  }

  return {
    available: true,
    generatedAt: new Date(now).toISOString(),
    lastPage: page
      ? {
          at: new Date(page.at).toISOString(),
          kind: page.kind as LastPageSummary["kind"],
          dedupKey: page.dedupKey,
          title: page.title,
          outcome: page.outcome,
          ...(page.status !== undefined ? { status: page.status } : {}),
        }
      : null,
    lastBrief: brief
      ? {
          at: new Date(brief.at).toISOString(),
          outcome: brief.outcome,
          ...(brief.status !== undefined ? { status: brief.status } : {}),
        }
      : null,
    lastBriefDeliveredAt: lastBriefSentAt === null ? null : new Date(lastBriefSentAt).toISOString(),
    window: { hours: DELIVERY_HEALTH_WINDOW_HOURS, failed, suppressed },
  };
}

/** The reads the summary needs; production binds `redisDeliveryHealthReads`. */
export interface DeliveryHealthReads {
  readDeliveryLog(): Promise<DeliveryLogEntry[]>;
  listDedupStates(): Promise<DedupStateRow[]>;
  getBriefLastSent(): Promise<number | null>;
}

export interface DeliveryHealthDeps {
  reads?: DeliveryHealthReads;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Best-effort read + fold. Resolves `{available:false, reason}` (with the
 * error logged) when any read throws or the whole fan-out exceeds the
 * timeout; never rejects.
 */
export async function readDeliveryHealth(deps: DeliveryHealthDeps = {}): Promise<DeliveryHealth> {
  const reads = deps.reads ?? redisDeliveryHealthReads;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DELIVERY_HEALTH_READ_TIMEOUT_MS;
  const generatedAt = new Date(now()).toISOString();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const fanOut = Promise.all([reads.readDeliveryLog(), reads.listDedupStates(), reads.getBriefLastSent()]);
    const raced = await Promise.race([fanOut, timeout]);
    if (raced === "timeout") {
      logger.error({ timeoutMs }, "[OperatorChannel] delivery-health reads timed out — reporting unavailable");
      // The abandoned fan-out must never surface as an unhandled rejection.
      fanOut.catch(() => undefined);
      return { available: false, generatedAt, reason: `redis-timeout-${timeoutMs}ms` };
    }
    const [log, dedupStates, lastBriefSentAt] = raced;
    return summarizeDeliveryHealth({ log, dedupStates, lastBriefSentAt, now: now() });
  } catch (err: any) {
    logger.error({ err }, "[OperatorChannel] delivery-health read failed — reporting unavailable");
    return { available: false, generatedAt, reason: `redis-read-failed: ${err?.message ?? String(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
