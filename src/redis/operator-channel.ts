/**
 * Operator Channel Redis accessor (ADR-0045, issue #5045).
 *
 * Edge-triggered dedup state (one hash per dedupKey, 7-day TTL refreshed on
 * every touch), the brief-item list and the delivery log. The channel treats
 * every call here as best-effort and fails OPEN when Redis is unreachable.
 */

import { getRedisConnection } from "./connection.ts";
import { boundedJsonList } from "./bounded-list.ts";

export const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;
export const BRIEF_ITEMS_KEY = "hydra:operator-channel:brief:items";
export const DELIVERY_LOG_KEY = "hydra:operator-channel:delivery-log";
export const LIST_MAX = 500;
export const dedupKeyFor = (dedupKey: string): string => `hydra:operator-channel:dedup:${dedupKey}`;

export interface DedupState {
  state: "bad";
  firstAt: number;
  lastSentAt: number;
  suppressed: number;
}

export type DeliveryOutcome = "sent-html" | "sent-plain" | "failed" | "skipped-no-credentials";

export interface DeliveryLogEntry {
  at: number;
  kind: "page" | "reminder" | "recovered" | "brief";
  dedupKey: string;
  title: string;
  outcome: DeliveryOutcome;
  status?: number;
}

const briefList = boundedJsonList<Record<string, unknown>>(BRIEF_ITEMS_KEY, LIST_MAX);
const logList = boundedJsonList<DeliveryLogEntry>(DELIVERY_LOG_KEY, LIST_MAX);

export async function readDedup(dedupKey: string): Promise<DedupState | null> {
  const h = await getRedisConnection().hgetall(dedupKeyFor(dedupKey));
  if (!h || h.state !== "bad") return null;
  return {
    state: "bad",
    firstAt: Number(h.firstAt),
    lastSentAt: Number(h.lastSentAt),
    suppressed: Number(h.suppressed) || 0,
  };
}

export async function writeDedup(dedupKey: string, s: DedupState): Promise<void> {
  const r = getRedisConnection();
  const k = dedupKeyFor(dedupKey);
  await r.hset(k, {
    state: s.state,
    firstAt: String(s.firstAt),
    lastSentAt: String(s.lastSentAt),
    suppressed: String(s.suppressed),
  });
  await r.expire(k, DEDUP_TTL_SECONDS);
}

export async function incrSuppressed(dedupKey: string): Promise<void> {
  const r = getRedisConnection();
  const k = dedupKeyFor(dedupKey);
  await r.hincrby(k, "suppressed", 1);
  await r.expire(k, DEDUP_TTL_SECONDS);
}

export async function delDedup(dedupKey: string): Promise<void> {
  await getRedisConnection().del(dedupKeyFor(dedupKey));
}

export async function appendBrief(item: Record<string, unknown>): Promise<void> {
  await briefList.push(item);
}

export async function appendLog(entry: DeliveryLogEntry): Promise<void> {
  await logList.push(entry);
}

export const readBriefItems = (limit: number = LIST_MAX) => briefList.read(limit);
export const readDeliveryLog = (limit: number = LIST_MAX) => logList.read(limit);

// ---------------------------------------------------------------------------
// Morning Brief timing state (ADR-0045 Decision 7, issue #5047)
// ---------------------------------------------------------------------------

/**
 * Epoch ms of the last Morning Brief the transport reported as delivered. The
 * brief's ONLY timing state: the scheduler never keeps an in-memory timer
 * value, so a restart can neither delay nor duplicate a brief.
 */
export const BRIEF_LAST_SENT_KEY = "hydra:operator-channel:brief:last-sent";

export async function getBriefLastSent(): Promise<number | null> {
  const raw = await getRedisConnection().get(BRIEF_LAST_SENT_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function setBriefLastSent(epochMs: number): Promise<void> {
  await getRedisConnection().set(BRIEF_LAST_SENT_KEY, String(epochMs));
}

/** One currently-bad dedup key as the Morning Brief's "Pages" section reports it. */
export interface DedupStateRow extends DedupState {
  dedupKey: string;
}

/**
 * Read-only SCAN over every `hydra:operator-channel:dedup:*` hash, returning the
 * keys in state `bad` with their suppressed counts (ADR-0045 Decision 4: the
 * suppressed counts appear in the brief). Suppressions are deliberately NOT
 * logged per event — a hot alarm repeating every minute would push real
 * entries out of the bounded delivery log — so the brief reads the hashes.
 * Never mutates. Same SCAN shape as `src/redis/agent-memory.ts`.
 */
export async function listDedupStates(): Promise<DedupStateRow[]> {
  const r = getRedisConnection();
  const prefix = dedupKeyFor("");
  const out: DedupStateRow[] = [];
  let cursor = "0";
  do {
    const [next, page] = await r.scan(cursor, "MATCH", `${prefix}*`, "COUNT", "200");
    cursor = next;
    for (const key of page) {
      const h = await r.hgetall(key);
      if (!h || h.state !== "bad") continue;
      out.push({
        dedupKey: key.slice(prefix.length),
        state: "bad",
        firstAt: Number(h.firstAt),
        lastSentAt: Number(h.lastSentAt),
        suppressed: Number(h.suppressed) || 0,
      });
    }
  } while (cursor !== "0");
  out.sort((a, b) => a.dedupKey.localeCompare(b.dedupKey));
  return out;
}

/** The persistence the Morning Brief scheduler binds by default (issue #5047). */
export const redisBriefStore = {
  getLastSent: getBriefLastSent,
  setLastSent: setBriefLastSent,
};

/**
 * The read-only trio the delivery-health summary folds (ADR-0045 Decision 8,
 * issue #5048): the whole bounded log, every currently-bad dedup hash and the
 * brief last-sent stamp. Nothing here mutates.
 */
export const redisDeliveryHealthReads = {
  readDeliveryLog: () => readDeliveryLog(),
  listDedupStates,
  getBriefLastSent,
};

/** The production store the channel binds by default. */
export const redisOperatorChannelStore = {
  readDedup,
  writeDedup,
  incrSuppressed,
  delDedup,
  appendBrief,
  appendLog,
};
