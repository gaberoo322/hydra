/**
 * Persisted per-run retrospective ARTIFACTS Redis seam (epic #917, issue #921,
 * retro-4).
 *
 * Split out of the former combined `src/redis/retro.ts` (issue #1914): that
 * file owned two disjoint state domains. This module owns ONLY slice B — the
 * durable, auditable record of what each retrospective concluded. The cross-run
 * seen-list + recurrence ledger slice now lives in `src/redis/retro-seen.ts`.
 *
 * The `/hydra-retro` skill owns the *durable record* of what each
 * retrospective concluded and acted on: one structured artifact per autopilot
 * `run_id` — findings, the issue/PR refs it produced, and the per-gotcha
 * recurrence count — so the operator can audit the retrospective history over
 * time from the dashboard (the Retro panel) and a read endpoint.
 *
 * Two Redis objects:
 *
 *   hydra:autopilot:retro:{run_id}   — string, the artifact JSON, 14d TTL
 *   hydra:autopilot:retro:index      — ZSET scored by generatedAt epoch (ms),
 *                                      member = run_id, 14d TTL refresh
 *
 * The 14-day TTL deliberately OUTLIVES the 7-day run-hash TTL
 * (`src/redis/autopilot-runs.ts`): the run lifecycle data expires after a week,
 * but the *conclusion* the retrospective drew from it is the durable,
 * auditable record and should linger longer. The index is a sorted set scored
 * by artifact-generation time so "recent retrospectives, newest-first" is a
 * single ZREVRANGE — the same shape `autopilot-runs.ts` uses for its run index.
 * The artifact key shapes are defined LOCALLY in this module (matching
 * `src/redis/recommendations.ts`) rather than in `src/redis/keys.ts`, so the
 * redis-seam-check passes without an out-of-scope edit to the shared key
 * registry.
 *
 * Per CLAUDE.md / ADR-0009, all Redis access from outside `src/redis/` MUST go
 * through a typed accessor here — never raw `redis/keys` / `redis/kv`, never
 * `new Redis()` directly.
 *
 * NEVER-THROW contract (CLAUDE.md merge/grounding/verification convention):
 * every accessor returns a result object or a sentinel (`null` / `[]`) and
 * logs `console.error` with context on failure — a Redis outage degrades the
 * Retro surface to "no data", it never throws into a caller. The persist path
 * returns a `{ ok }` result object so a failed write is legible to the skill
 * without aborting its run.
 */

import { getRedisConnection } from "./connection.ts";

/**
 * The narrow slice of the Redis connection these accessors use. Declaring it
 * lets a test inject an in-memory fake (the established DI shape across the
 * seam — see `recommendation-engine.ts`'s facade) so the accessors can be
 * exercised, including their never-throw contract, without a live Redis. The
 * default in every accessor is the live `getRedisConnection()`, so production
 * callers pass nothing.
 */
export interface RetroRedisLike {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Key shapes — exported so tests can assert against them by name
// ---------------------------------------------------------------------------

/** The per-run artifact key — `hydra:autopilot:retro:{run_id}`. */
export function retroArtifactKey(runId: string): string {
  return `hydra:autopilot:retro:${runId}`;
}

/** The artifact index ZSET key — scored by generatedAt epoch (ms), newest-first. */
export function retroArtifactsIndexKey(): string {
  return "hydra:autopilot:retro:index";
}

/** Artifacts live 14 days — deliberately longer than the 7d run-hash TTL. */
export const RETRO_ARTIFACT_TTL_SECONDS = 14 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Artifact shape
// ---------------------------------------------------------------------------

/** One synthesised finding the retrospective drew from the run. */
interface RetroFinding {
  /** Stable kebab-case cue naming the gotcha (matches friction-memory cues). */
  cue: string;
  /** One-line human-readable summary of what the retrospective concluded. */
  summary: string;
  /** How many times this gotcha has recurred across runs (the gate input). */
  recurrence: number;
  /**
   * What the retrospective did with this finding: an emitted issue, a gated
   * PR, or `artifact-only` when it was below the emit bar. Free-form but
   * conventionally one of `issue` / `pr` / `artifact-only`.
   */
  disposition: string;
}

/** A GitHub ref (issue or PR) the retrospective produced from the run. */
interface RetroEmittedRef {
  /** `"issue"` or `"pr"`. */
  kind: "issue" | "pr";
  /** The GitHub number, e.g. 921. */
  number: number;
  /** Optional title/summary for display. */
  title?: string;
}

/**
 * The durable retrospective artifact for one autopilot run. Persisted by the
 * `/hydra-retro` skill at the end of its synthesis, read by the dashboard
 * Retro panel and the read endpoint.
 */
export interface RetroArtifact {
  /** The autopilot run this retrospective analysed. */
  run_id: string;
  /** ISO timestamp the artifact was generated (also the index score source). */
  generatedAt: string;
  /** The synthesised findings, with their per-gotcha recurrence counts. */
  findings: RetroFinding[];
  /** Issue/PR refs the retrospective emitted (≤2 issues + ≤1 PR per #917). */
  emitted: RetroEmittedRef[];
  /**
   * Optional one-line summary of the run's outcome (e.g. term_reason +
   * merged/failed tallies) so the panel can show context without re-joining
   * the run record (which may have expired before the artifact does).
   */
  summary?: string;
}

// ---------------------------------------------------------------------------
// Result objects (never-throw)
// ---------------------------------------------------------------------------

/** Outcome of a persist attempt — `{ ok }` so a failed write is legible. */
export type PersistRetroResult =
  | { ok: true }
  | { ok: false; code: "redis-error"; detail: string };

function toDetail(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

/**
 * Persist (or overwrite) the retrospective artifact for `artifact.run_id` and
 * index it by its generatedAt epoch so `listRecentRetroArtifacts` can return
 * it newest-first. Both the artifact string and the index entry are stamped
 * with the 14d TTL on every write, so re-running a retrospective for the same
 * run refreshes the clock rather than orphaning a stale copy.
 *
 * NEVER throws — a Redis failure is logged and returned as
 * `{ ok: false, code: "redis-error" }`.
 */
export async function persistRetroArtifact(
  artifact: RetroArtifact,
  conn?: RetroRedisLike,
): Promise<PersistRetroResult> {
  try {
    const r: RetroRedisLike = conn ?? getRedisConnection();
    const key = retroArtifactKey(artifact.run_id);
    const indexKey = retroArtifactsIndexKey();
    const score = Date.parse(artifact.generatedAt);
    // A malformed generatedAt can never address a sortable index slot; fall
    // back to "now" so the artifact is still discoverable rather than dropped.
    const indexScore = Number.isFinite(score) ? score : Date.now();

    await r.set(key, JSON.stringify(artifact), "EX", RETRO_ARTIFACT_TTL_SECONDS);
    await r.zadd(indexKey, indexScore, artifact.run_id);
    await r.expire(indexKey, RETRO_ARTIFACT_TTL_SECONDS);
    return { ok: true };
  } catch (err) {
    const detail = toDetail(err);
    console.error(
      `[retro] persistRetroArtifact failed for run ${artifact.run_id}: ${detail}`,
    );
    return { ok: false, code: "redis-error", detail };
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read a single artifact by run_id. Returns `null` when the artifact is
 * absent, expired, or unreadable (the value failed to parse) — a missing
 * artifact is a normal empty state, not an error.
 */
export async function getRetroArtifact(
  runId: string,
  conn?: RetroRedisLike,
): Promise<RetroArtifact | null> {
  try {
    const r: RetroRedisLike = conn ?? getRedisConnection();
    const raw = await r.get(retroArtifactKey(runId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RetroArtifact;
    return parsed;
  } catch (err) {
    console.error(`[retro] getRetroArtifact failed for run ${runId}: ${toDetail(err)}`);
    return null;
  }
}

/**
 * List the most recent retrospective artifacts, newest-first, up to `limit`.
 *
 * Reads the index ZSET (ZREVRANGE) then fetches each artifact. An index entry
 * whose artifact has expired or fails to parse is skipped (the index TTL and
 * artifact TTL match, but a manual TTL change or a corrupt write could leave a
 * dangling member) — the surviving artifacts are still returned. Returns `[]`
 * on a non-positive limit or any Redis failure (logged), honouring the
 * never-throw contract.
 */
export async function listRecentRetroArtifacts(
  limit: number,
  conn?: RetroRedisLike,
): Promise<RetroArtifact[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  try {
    const r: RetroRedisLike = conn ?? getRedisConnection();
    const ids = await r.zrevrange(retroArtifactsIndexKey(), 0, limit - 1);
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const out: RetroArtifact[] = [];
    for (const id of ids) {
      const artifact = await getRetroArtifact(id, r);
      if (artifact) out.push(artifact);
    }
    return out;
  } catch (err) {
    console.error(`[retro] listRecentRetroArtifacts failed: ${toDetail(err)}`);
    return [];
  }
}
