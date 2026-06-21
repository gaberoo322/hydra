/**
 * Agent-memory Redis ops (pattern persistence).
 * Extracted from redis-adapter.ts (issue #269).
 *
 * Note: this is the low-level Redis adapter for agent-memory. The higher-level
 * learning logic lives in src/learning/agent-memory.ts.
 */

import { redisKeys } from "./keys.ts";
import { getRedisConnection } from "./connection.ts";

/**
 * Fetch memory patterns string for a given agent.
 */
export async function getMemoryPatterns(agent: string): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(redisKeys.memoryPatterns(agent));
}

/**
 * Issue #512 — pattern namespace selector. `"memory"` is the historical
 * planner/executor/skeptic pattern set keyed under
 * `hydra:memory:{agent}:patterns`. `"friction"` is the soft-friction set
 * keyed under `hydra:friction:{skill}:patterns`. The two share schema +
 * promotion math but live in distinct Redis keys so they can be queried,
 * pruned, and observed independently.
 */
export type PatternNamespace = "memory" | "friction";

function patternsKey(namespace: PatternNamespace, name: string): string {
  return namespace === "friction"
    ? redisKeys.frictionPatterns(name)
    : redisKeys.memoryPatterns(name);
}

/**
 * Load raw patterns JSON for an agent (or skill, when `namespace="friction"`).
 */
export async function loadPatternsRaw(
  agent: string,
  namespace: PatternNamespace = "memory",
): Promise<string | null> {
  const r = getRedisConnection();
  return r.get(patternsKey(namespace, agent));
}

/**
 * Save patterns JSON for an agent (or skill, when `namespace="friction"`).
 */
export async function savePatternsRaw(
  agent: string,
  json: string,
  namespace: PatternNamespace = "memory",
): Promise<void> {
  const r = getRedisConnection();
  await r.set(patternsKey(namespace, agent), json);
}

/**
 * One `{name, raw}` tuple as scanned off a `hydra:{memory|friction}:*:patterns`
 * key: `name` is the agent/skill segment between the namespace prefix and the
 * `:patterns` suffix; `raw` is the unparsed stored JSON string (or null when
 * the key vanished between SCAN and GET). Callers own the JSON parse + shape
 * narrowing — this seam returns the raw read only (ADR-0009: the key shapes and
 * the cursor walk live here, the validation lives at the caller).
 */
export interface PatternGroupRaw {
  name: string;
  raw: string | null;
}

/**
 * Scan every `hydra:{namespace}:*:patterns` key (memory or friction) and GET
 * each value, returning one `{name, raw}` tuple per key. The cursor walk + the
 * `hydra:{namespace}:` → name strip live here so the dashboard aggregators
 * (lessons-explorer, friction-source) don't hand-roll the SCAN-and-GET loop
 * against a dynamically-imported raw connection (issue #1121). Per-key JSON
 * parse + array narrowing stay with each caller.
 */
export async function scanPatternGroupsRaw(
  namespace: PatternNamespace = "memory",
): Promise<PatternGroupRaw[]> {
  const r = getRedisConnection();
  const matchPrefix = namespace === "friction" ? "hydra:friction:" : "hydra:memory:";
  const match = `${matchPrefix}*:patterns`;
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, page] = await r.scan(cursor, "MATCH", match, "COUNT", "200");
    cursor = next;
    keys.push(...page);
  } while (cursor !== "0");

  const out: PatternGroupRaw[] = [];
  for (const key of keys) {
    const name = (
      key.startsWith(matchPrefix) ? key.slice(matchPrefix.length) : key
    ).replace(/:patterns$/, "");
    const raw = await r.get(key);
    out.push({ name, raw });
  }
  return out;
}

/**
 * Check if patterns key exists for an agent.
 */
async function patternsExist(agent: string): Promise<boolean> {
  const r = getRedisConnection();
  const val = await r.exists(redisKeys.memoryPatterns(agent));
  return val === 1;
}

// ---------------------------------------------------------------------------
// Rule-action audit log (pattern-memory housekeeping)
// ---------------------------------------------------------------------------

const RULE_ACTION_LOG_KEY = "hydra:learning:rule-actions";

/** Append a serialized rule-action entry to the audit log and trim to `cap`. */
export async function appendRuleAction(entryJson: string, cap: number): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(RULE_ACTION_LOG_KEY, entryJson);
  await r.ltrim(RULE_ACTION_LOG_KEY, 0, cap - 1);
}

/** Read the most recent `limit` rule-action entries. */
export async function readRecentRuleActions(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const r = getRedisConnection();
  return r.lrange(RULE_ACTION_LOG_KEY, 0, limit - 1);
}
