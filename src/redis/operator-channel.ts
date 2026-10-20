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

/** The production store the channel binds by default. */
export const redisOperatorChannelStore = {
  readDedup,
  writeDedup,
  incrSuppressed,
  delDedup,
  appendBrief,
  appendLog,
};
