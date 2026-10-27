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
// One atomic unit (Lua runs single-threaded): dedupe check, every write, and the
// dedupe marker LAST. A failing command (WRONGTYPE) aborts before the marker is
// added, so an exporter retry is counted instead of reported "deduped" while its
// tokens were lost (QA round 1, #5251).
const RECORD_LUA = `
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then return 0 end
local ttl = tonumber(ARGV[8])
redis.call('HINCRBY', KEYS[1], 'input', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'output', ARGV[3])
redis.call('HINCRBY', KEYS[1], 'cacheRead', ARGV[4])
redis.call('HINCRBY', KEYS[1], 'cacheCreation', ARGV[5])
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'labelledRequests', ARGV[6])
redis.call('HSETNX', KEYS[1], 'firstSeenMs', ARGV[7])
redis.call('HSET', KEYS[1], 'lastSeenMs', ARGV[7])
if ARGV[10] ~= '' then redis.call('HSET', KEYS[1], 'parentAgentId', ARGV[10]) end
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('ZADD', KEYS[2], ARGV[7], ARGV[11])
redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -(tonumber(ARGV[9]) + 1))
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('EXPIRE', KEYS[3], ttl)
return 1
`;

export async function recordOtelRequest(
  sample: OtelRecordInput,
  nowMs: number = Date.now(),
): Promise<"accepted" | "deduped"> {
  const r = getRedisConnection();
  const added = await r.eval(
    RECORD_LUA,
    3,
    otelAgentKey(sample.agentId),
    otelIndexKey(),
    otelAgentRequestsKey(sample.agentId),
    sample.requestKey,
    String(sample.input),
    String(sample.output),
    String(sample.cacheRead),
    String(sample.cacheCreation),
    sample.labelled ? "1" : "0",
    String(nowMs),
    String(TTL_SECONDS),
    String(INDEX_MAX),
    sample.parentAgentId ?? "",
    sample.agentId,
  );
  return Number(added) === 1 ? "accepted" : "deduped";
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
