/**
 * OTel span ledger — per-agent token totals from Claude Code's
 * `claude_code.llm_request` spans (issue #5177, epic #5171).
 *
 * SHADOW ONLY: nothing under `src/cost/` reads this accessor. The only
 * importers are `src/api/otel.ts` (write) and `scripts/cost/otel-ledger-compare.ts`
 * (read-only comparison against the transcript fold).
 *
 *   hydra:otel:spans:agent:{agentId}           hash: input, output, cacheRead,
 *       cacheCreation, requests, labelledRequests (ints); firstSeenMs,
 *       lastSeenMs (ints); parentAgentId (string). 7d TTL, refreshed on write.
 *   hydra:otel:spans:agent:{agentId}:requests  set of request ids already counted
 *       (exporter-retry idempotency). 7d TTL, refreshed on write.
 *   hydra:otel:spans:index                     ZSET agentId scored by lastSeenMs,
 *       trimmed to the newest {@link INDEX_MAX} on every write.
 *
 * No USD is ever read or stored (CONTEXT.md Quota Weight _Avoid_).
 */
import { getRedisConnection } from "./connection.ts";

const TTL_SECONDS = 7 * 24 * 60 * 60;
export const INDEX_MAX = 5000;

export function otelAgentKey(agentId: string): string {
  return `hydra:otel:spans:agent:${agentId}`;
}

export function otelAgentRequestsKey(agentId: string): string {
  return `hydra:otel:spans:agent:${agentId}:requests`;
}

export function otelIndexKey(): string {
  return "hydra:otel:spans:index";
}

export interface OtelRecordInput {
  agentId: string;
  parentAgentId: string | null;
  labelled: boolean;
  requestKey: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface OtelAgentTotals {
  agentId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  requests: number;
  labelledRequests: number;
  firstSeenMs: number;
  lastSeenMs: number;
  parentAgentId: string | null;
}

/**
 * Record one request. Returns `"deduped"` (and writes nothing further) when the
 * request key was already counted for this agent. Throws on a Redis failure —
 * the route's isolateAggregator logs and turns it into a 500.
 */
export async function recordOtelRequest(
  sample: OtelRecordInput,
  nowMs: number = Date.now(),
): Promise<"accepted" | "deduped"> {
  const r = getRedisConnection();
  const added = await r.sadd(otelAgentRequestsKey(sample.agentId), sample.requestKey);
  if (added !== 1) return "deduped";

  const key = otelAgentKey(sample.agentId);
  const pipe = r.pipeline();
  pipe.hincrby(key, "input", sample.input);
  pipe.hincrby(key, "output", sample.output);
  pipe.hincrby(key, "cacheRead", sample.cacheRead);
  pipe.hincrby(key, "cacheCreation", sample.cacheCreation);
  pipe.hincrby(key, "requests", 1);
  pipe.hincrby(key, "labelledRequests", sample.labelled ? 1 : 0);
  pipe.hsetnx(key, "firstSeenMs", String(nowMs));
  pipe.hset(key, "lastSeenMs", String(nowMs));
  if (sample.parentAgentId) pipe.hset(key, "parentAgentId", sample.parentAgentId);
  pipe.expire(key, TTL_SECONDS);
  pipe.expire(otelAgentRequestsKey(sample.agentId), TTL_SECONDS);
  pipe.zadd(otelIndexKey(), nowMs, sample.agentId);
  pipe.zremrangebyrank(otelIndexKey(), 0, -(INDEX_MAX + 1));
  pipe.expire(otelIndexKey(), TTL_SECONDS);
  await pipe.exec();
  return "accepted";
}

function int(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Pure projector for a raw hash; null when the hash is empty/expired. */
export function projectOtelRow(
  agentId: string,
  row: Record<string, string> | null,
): OtelAgentTotals | null {
  if (!row || Object.keys(row).length === 0) return null;
  return {
    agentId,
    input: int(row.input),
    output: int(row.output),
    cacheRead: int(row.cacheRead),
    cacheCreation: int(row.cacheCreation),
    requests: int(row.requests),
    labelledRequests: int(row.labelledRequests),
    firstSeenMs: int(row.firstSeenMs),
    lastSeenMs: int(row.lastSeenMs),
    parentAgentId: row.parentAgentId ? row.parentAgentId : null,
  };
}

export async function getOtelAgentTotals(agentId: string): Promise<OtelAgentTotals | null> {
  const r = getRedisConnection();
  return projectOtelRow(agentId, await r.hgetall(otelAgentKey(agentId)));
}

/** Agent ids in the index, newest first. */
export async function listOtelAgentIds(): Promise<string[]> {
  const r = getRedisConnection();
  const ids = await r.zrevrange(otelIndexKey(), 0, -1);
  return Array.isArray(ids) ? ids : [];
}
