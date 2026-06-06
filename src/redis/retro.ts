/**
 * Retrospective Redis seam (epic #917). This module owns TWO disjoint slices
 * of retrospective state, merged here so a single `src/redis/retro.ts` is the
 * one typed accessor for everything the `/hydra-retro` skill reads and writes:
 *
 *   A. Cross-run seen-list + recurrence ledger (issue #919) — the dedup +
 *      recurrence gates that keep the emit conservative.
 *   B. Persisted per-run retrospective ARTIFACTS (issue #921, retro-4) — the
 *      durable, auditable record of what each retrospective concluded.
 *
 * NOTE (issue #1041): slice A below was deleted in #1007 as `knip`-dead and
 * restored here. `knip` could not see the only caller — the live
 * `/hydra-retro` skill playbook markdown
 * (`docs/operator-playbooks/hydra-retro.md` → synced to
 * `~/.claude/skills/hydra-retro/SKILL.md`), which imports and calls these
 * accessors from a `tsx` shim (SKILL.md steps 6/8). Deleting them broke
 * `retro_orch` at runtime (`getRetroSeen` threw). The slice-A symbols carry a
 * test-level reference in `test/retro-artifact.test.mts` so a future `knip`
 * sweep does not re-flag and re-delete them.
 *
 * ---------------------------------------------------------------------------
 * A. Seen-list + recurrence ledger (issue #919)
 * ---------------------------------------------------------------------------
 *
 * The `/hydra-retro` skill synthesises a per-run retrospective and emits a
 * tiered, capped set of improvement proposals (≤2 GitHub issues for code-level
 * gotchas, ≤1 gated PR for high-confidence + recurrence-gated prompt/doc
 * fixes, artifact-only notes below the bar). Two pieces of cross-run state keep
 * that emit conservative:
 *
 *   1. **Seen-list** (`hydra:retro:seen`) — a dedup ledger keyed by a stable,
 *      kebab-case `cue`. A cue present here was already turned into an
 *      issue/PR on a prior run, so a later run SKIPS it rather than re-filing
 *      the same gotcha. Mirrors `src/redis/scout.ts`'s tool seen-list.
 *
 *   2. **Recurrence counter** (`hydra:retro:recurrence`) — a per-cue integer
 *      incremented once per run a cue is OBSERVED. The prompt-shaped-fix gate
 *      (the single gated PR) only fires for cues seen ≥3× across runs/friction
 *      observations, the recurrence threshold the epic mandates. Counting is
 *      independent of emission so a cue can clear the gate even on a run where
 *      it wasn't itself emitted.
 *
 * Both key families are GLOBAL (not per-run) and NOT TTLed — a retrospective
 * gotcha recurs across runs, so per-run scoping or expiry would defeat the
 * dedup + recurrence gates. These two key families are registered in
 * `src/redis/keys.ts` (`redisKeys.retroSeen` / `redisKeys.retroRecurrence`).
 *
 * ---------------------------------------------------------------------------
 * B. Persisted retrospective artifacts (issue #921, retro-4)
 * ---------------------------------------------------------------------------
 *
 * The skill also owns the *durable record* of what each retrospective
 * concluded and acted on: one structured artifact per autopilot `run_id` —
 * findings, the issue/PR refs it produced, and the per-gotcha recurrence
 * count — so the operator can audit the retrospective history over time from
 * the dashboard (the Retro panel) and a read endpoint.
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
 * ---------------------------------------------------------------------------
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

import { redisKeys } from "./keys.ts";
import { hashGetAll, hashIncrBy, hashSetField } from "./kv.ts";
import { getRedisConnection } from "./connection.ts";

// ===========================================================================
// A. Seen-list + recurrence ledger (issue #919)
// ===========================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The emit lane a retrospective finding was routed to. */
export type RetroEmitKind = "issue" | "pr" | "artifact";

/**
 * One seen-list entry — the persisted record that a cue was already emitted on
 * a prior run, so it is never re-proposed. Redis stores this JSON-encoded as
 * the hash value (field = cue).
 */
export interface RetroSeenEntry {
  /** Stable kebab-case cue (the dedup key; matches the friction-store grammar). */
  cue: string;
  /** Which lane the finding was routed to when it was emitted. */
  decision: RetroEmitKind;
  /** Autopilot run that produced the emit. */
  runId: string;
  /** GitHub issue/PR number (or other locator) the emit produced, when known. */
  ref: string | null;
  /** ISO-8601 UTC timestamp the entry was written. */
  at: string;
}

// ---------------------------------------------------------------------------
// Seen-list (dedup ledger)
// ---------------------------------------------------------------------------

/**
 * Read the full seen-list as a `cue -> RetroSeenEntry` map. Corrupt (non-JSON)
 * values are skipped with a logged warning rather than throwing, so one bad
 * write can't blind the whole dedup gate. Returns `{}` when the ledger is
 * empty.
 */
export async function getRetroSeen(): Promise<Record<string, RetroSeenEntry>> {
  const raw = await hashGetAll(redisKeys.retroSeen());
  const out: Record<string, RetroSeenEntry> = {};
  for (const [cue, value] of Object.entries(raw)) {
    try {
      out[cue] = JSON.parse(value) as RetroSeenEntry;
    } catch (err) {
      console.error(
        `[retro] skipping corrupt seen-list entry for cue "${cue}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return out;
}

/**
 * Record that `cue` was emitted on this run, so future runs skip it. Idempotent
 * on the cue — re-recording overwrites the prior entry (last write wins, which
 * is the freshest emit locator). The caller supplies `at`; defaulting it here
 * would make the write non-deterministic for tests.
 */
export async function recordRetroSeen(entry: RetroSeenEntry): Promise<void> {
  await hashSetField(redisKeys.retroSeen(), entry.cue, JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Recurrence counter (gate input)
// ---------------------------------------------------------------------------

/**
 * Read the full recurrence ledger as a `cue -> count` map. Non-numeric values
 * coerce to 0 rather than NaN so the gate logic stays total. Returns `{}` when
 * empty.
 */
export async function getRetroRecurrence(): Promise<Record<string, number>> {
  const raw = await hashGetAll(redisKeys.retroRecurrence());
  const out: Record<string, number> = {};
  for (const [cue, value] of Object.entries(raw)) {
    const n = Number.parseInt(value, 10);
    out[cue] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

/**
 * Increment the recurrence count for `cue` by `delta` (default 1) and return
 * the new count. Called once per run a cue is observed — independent of whether
 * the cue is emitted — so the count reflects cross-run recurrence.
 */
export async function bumpRetroRecurrence(cue: string, delta = 1): Promise<number> {
  return hashIncrBy(redisKeys.retroRecurrence(), cue, delta);
}

// ===========================================================================
// B. Persisted retrospective artifacts (issue #921, retro-4)
// ===========================================================================

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
export interface RetroFinding {
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
export interface RetroEmittedRef {
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
