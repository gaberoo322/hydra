/**
 * Merge-watch Redis seam (issue #3415 — extracted from `src/redis/holdback.ts`).
 *
 * This leaf owns the durable state consumed exclusively by the **merge-watch
 * family** — the `#2623` merge-completion watcher chore
 * (`src/scheduler/chores/holdback-merge-watch.ts`), the arming reconciler
 * (`src/scheduler/chores/cycle-merge-reconcile.ts`), and the
 * `POST /holdback/pending` arm handler (`src/api/holdback.ts`). It bundles two
 * structurally-distinct-but-co-owned concerns:
 *
 *   1. The **pending-enroll registry + enrolled marker** — the durable list of
 *      PRs the autopilot has ARMED for auto-merge but that have not yet landed,
 *      plus a per-PR "already processed on landing" idempotence marker so the
 *      merge-coupled writes (enroll + cycle-record enrichment) fire at most once
 *      per PR even if a prior tick's cleanup `HDEL` failed and the entry is
 *      re-observed.
 *
 *   2. The **merge-watch health snapshot** — the per-tick health record the
 *      chore is the sole writer of, so a stalled watcher is diagnosable via the
 *      scheduler-status surface.
 *
 * These share NO callers with the regression-baseline + revert-counter concerns
 * that remain in `src/redis/holdback.ts` (the caller-set split is clean, verified
 * in #3415). Splitting the 500-line multi-concern file follows the
 * `run-lifecycle-state.ts` (#3106), `retro-dispatch-classifier.ts` (#3090), and
 * `recommendation-materiality.ts` (#3099) precedent of extracting a deep file
 * into focused leaves named for their concern; the merge-watch leaf maps 1:1 to
 * the chore that owns its write lifecycle.
 *
 * Per CLAUDE.md conventions: every accessor here is best-effort with respect to
 * the caller's flow — a Redis error is logged with the `[holdback]` prefix (the
 * shared log namespace is retained deliberately: these keys are still part of the
 * `hydra:holdback:*` family) and surfaces as a structured result or a fail-closed
 * default, never a thrown exception. All access goes through the ADR-0009 typed
 * accessor (`getRedisConnection`); no `new Redis()` / raw `redis/kv` here.
 */

import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";
import { HoldbackEnrolStateSchema, type HoldbackEnrolState } from "../schemas/holdback.ts";

export type { HoldbackEnrolState };

// ---------------------------------------------------------------------------
// Key builders (ADR-0009 — key shape lives in the seam).
// ---------------------------------------------------------------------------

/**
 * Pending-enroll registry (issue #2622). A single Redis HASH, one field per
 * `prNumber` (field = `String(prNumber)`), value = JSON `PendingEnrollEntry`.
 *
 * This is the durable record of PRs the autopilot has ARMED for auto-merge but
 * that have not yet landed+enrolled. It is deliberately a DIFFERENT key from the
 * per-commit baseline (`holdbackBaselineKey`, in `redis/holdback.ts`): a pending
 * entry exists BEFORE landing and is keyed by prNumber (no commit SHA yet); a
 * baseline exists AFTER landing and is keyed by commit SHA. Conflating "armed"
 * with "watched" would break the #2623 merge-completion watcher's semantics.
 *
 * A HASH (not a LIST) so upsert-by-prNumber is idempotent for free: `HSET` on
 * the same field overwrites in place, `HGETALL` lists all in one call, `HDEL`
 * removes one. Mirrors the `src/redis/autopilot-runs.ts` hash pattern.
 */
function holdbackPendingEnrollKey(): string {
  return "hydra:holdback:pending-enroll";
}

/**
 * Per-PR "already processed on landing" marker (issue #2623). One field per
 * `prNumber` in a single HASH, value = the landing commit SHA (informational).
 * Set the first time the merge-completion watcher sees a pending PR's merge land
 * and fires the enroll + cycle-record enrichment; consulted on every subsequent
 * tick so those two merge-coupled writes fire **at most once per PR** even if the
 * pending entry's `HDEL` failed and the entry is re-observed. Distinct from the
 * per-commit baseline (`enrollHoldback` is itself idempotent on the SHA) — this
 * marker also guards the cycle-record enrichment, which is idempotent on cycleId
 * but which we still only want to fire once from this path.
 */
function holdbackEnrolledMarkerKey(): string {
  return "hydra:holdback:enrolled-marker";
}

/**
 * Merge-completion watcher health (issue #2623). A single JSON blob — the chore
 * is the sole writer, the scheduler-status surface the sole reader — recording
 * the last run's pending-depth + wall-clock stamp so the mechanism is observable
 * rather than silent (mirrors the reconciler-health pattern, #2057).
 */
function holdbackMergeWatchHealthKey(): string {
  return "hydra:holdback:merge-watch:health";
}

/**
 * Enrol-state record (issue #4632 INV-5). One JSON value per merge commit
 * SHA — the durable, cross-writer "what happened to this merge's enrolment"
 * record consulted by the merge-event-enrol chore's dedup check, written by
 * that chore, by `holdback-merge-watch.ts`'s own landed path, and by the
 * manual `POST /holdback/enroll` route.
 */
function holdbackEnrolStateKey(commitSha: string): string {
  return `hydra:holdback:enrol-state:${commitSha}`;
}

/**
 * ZSET index over every enrol-state record, scored by `mergedAt` (epoch ms) —
 * or write time when `mergedAt` is unknown — so `GET /holdback/enrolments`
 * can list newest-first without an O(N) key scan. Trimmed on every write to
 * the same 30d horizon as the per-SHA record's TTL.
 */
function holdbackEnrolStateIndexKey(): string {
  return "hydra:holdback:enrol-state:index";
}

/**
 * Merge-event-enrol chore health (issue #4632 INV-9). Mirrors
 * {@link holdbackMergeWatchHealthKey} — the chore is the sole writer, the
 * scheduler-status / `GET /holdback/enrolments` surfaces the sole readers.
 */
function holdbackMergeEventHealthKey(): string {
  return "hydra:holdback:merge-event:health";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One entry in the pending-enroll registry (issue #2622): a PR the autopilot has
 * armed for auto-merge but that has not yet landed+enrolled. Keyed (in the hash)
 * by `prNumber`. `tier` is nullable to mirror the enroll schema's tier semantics
 * (a merge whose tier we cannot yet resolve is still recordable as "armed").
 */
export interface PendingEnrollEntry {
  prNumber: number;
  tier: number | null;
  cycleId: string;
  /**
   * Explicit dispatch-class anchorType (issue #2800) the arming caller knew
   * (`work-queue` / `qa-review` / ...). Optional — legacy entries persisted
   * before #2800 (and callers that omit it) leave it `undefined`. The #2623
   * merge-watch chore forwards it on the landing-time cycle-record enrichment so
   * that a first-write enrichment (reap never wrote a record for this cycleId —
   * the qa_orch relay case) still classifies explicitly instead of falling
   * through the bare-UUID cycleId to the `unclassified` sentinel.
   */
  anchorType?: string;
  /** Epoch ms the entry was registered. */
  registeredAt: number;
}

export type PendingEnrollAddResult =
  | { ok: true }
  | { ok: false; error: string };

export type PendingEnrollListResult =
  | { ok: true; entries: PendingEnrollEntry[] }
  | { ok: false; error: string };

/**
 * Last-run health snapshot for the merge-completion watcher chore (issue #2623).
 * Single JSON blob behind the seam (ADR-0017); the chore is the sole writer.
 */
export interface MergeWatchHealthRecord {
  /** ISO timestamp of the run that wrote this record. */
  ranAt: string;
  /** How many pending-enroll entries were in the registry at run start. */
  pendingDepth: number;
  /** How many landed PRs were enrolled+enriched this run. */
  landed: number;
  /** How many landed T1/unknown-tier PRs were dropped without enrolling. */
  droppedExempt: number;
  /** How many entries were left untouched (PR still open / no merge commit). */
  stillOpen: number;
  /**
   * How many entries were dropped because their PR was closed WITHOUT merging
   * (issue #4119) — terminal, can never land. Kept distinct from `stillOpen`
   * so that counter remains "PRs we are genuinely waiting on". (A record
   * persisted before #4119 lacks this field; the 2-day TTL ages those out.)
   */
  droppedClosed: number;
}

/**
 * Last-run health snapshot for the merge-event-enrol chore (issue #4632
 * INV-9). Single JSON blob behind the seam; the chore is the sole writer.
 */
export interface MergeEventHealthRecord {
  /** ISO timestamp of the run that wrote this record. */
  ranAt: string;
  /** How many closed PRs the `gh api pulls?state=closed` listing returned. */
  scanned: number;
  /** How many of those merged within the 48h lookback with a merge commit SHA. */
  candidates: number;
  /** How many candidates were newly enrolled this run. */
  enrolled: number;
  /** How many candidates classified T1 (exempt) this run. */
  exempt: number;
  /** How many candidates had no outcome-adapter data this run. */
  noSignal: number;
  /** How many candidates hit an attempt failure and are retrying. */
  retrying: number;
  /** How many candidates exhausted their attempts and are terminally failed. */
  failed: number;
  /** How many candidates were already in the pending-enroll registry. */
  skippedRegistered: number;
  /** How many candidates already had a terminal enrol-state row or a baseline. */
  skippedKnown: number;
  /** How many new candidates exceeded the per-tick classification limit. */
  deferred: number;
  /** Set only when the whole `gh api pulls` listing failed this run. */
  listError?: string;
}

// ---------------------------------------------------------------------------
// Pending-enroll registry accessors (issue #2622)
// ---------------------------------------------------------------------------

/**
 * Register (or upsert) a PR the autopilot has armed for auto-merge. Idempotent
 * on `prNumber`: a second call for the same prNumber overwrites the field in
 * place (single entry, updated), never appends a duplicate. Best-effort — a
 * Redis error is logged with the `[holdback]` prefix and returned as a
 * structured result, never thrown (this path only records intent; it never
 * arms, blocks, or performs a merge).
 */
export async function pendingEnrollAdd(entry: PendingEnrollEntry): Promise<PendingEnrollAddResult> {
  if (!Number.isInteger(entry.prNumber) || entry.prNumber <= 0) {
    return { ok: false, error: "pendingEnrollAdd: prNumber must be a positive integer" };
  }
  try {
    const r = getRedisConnection();
    await r.hset(holdbackPendingEnrollKey(), String(entry.prNumber), JSON.stringify(entry));
    return { ok: true };
  } catch (err: any) {
    const msg = `[holdback] pendingEnrollAdd failed for pr ${entry.prNumber}: ${err?.message || String(err)}`;
    logger.error({ prNumber: entry.prNumber, err }, "[holdback] pendingEnrollAdd failed");
    return { ok: false, error: msg };
  }
}

/**
 * List every armed-but-not-landed pending entry. Returns them sorted by
 * `prNumber` ascending for a stable read. A malformed hash field is skipped
 * (logged) rather than failing the whole list — one bad entry can never blind
 * the caller to the rest.
 */
export async function pendingEnrollList(): Promise<PendingEnrollListResult> {
  try {
    const r = getRedisConnection();
    const hash = await r.hgetall(holdbackPendingEnrollKey());
    const entries: PendingEnrollEntry[] = [];
    for (const [field, raw] of Object.entries(hash) as Array<[string, string]>) {
      try {
        entries.push(JSON.parse(raw) as PendingEnrollEntry);
      } catch (err: any) {
        logger.error(
          { field, err },
          "[holdback] pendingEnrollList: skipping malformed field",
        );
      }
    }
    entries.sort((a, b) => a.prNumber - b.prNumber);
    return { ok: true, entries };
  } catch (err: any) {
    const msg = `[holdback] pendingEnrollList failed: ${err?.message || String(err)}`;
    logger.error({ err }, "[holdback] pendingEnrollList failed");
    return { ok: false, error: msg };
  }
}

/**
 * Remove a pending entry once its PR has landed (or been abandoned). Best-effort
 * cleanup consumed by the #2623 merge-completion watcher — harmless if the field
 * is already gone.
 */
export async function pendingEnrollRemove(prNumber: number): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.hdel(holdbackPendingEnrollKey(), String(prNumber));
  } catch (err: any) {
    /* intentional: removing a landed pending entry is best-effort cleanup; a
       stale field is harmless and the #2623 watcher re-reconciles on its next
       pass. */
    logger.error({ prNumber, err }, "[holdback] pendingEnrollRemove failed");
  }
}

/** Test-only: clear the entire pending-enroll registry. */
export async function _resetPendingEnroll(): Promise<void> {
  const r = getRedisConnection();
  await r.del(holdbackPendingEnrollKey());
}

// ---------------------------------------------------------------------------
// Merge-completion watcher: per-PR enrolled marker (issue #2623)
// ---------------------------------------------------------------------------

/**
 * True when this PR's landing has ALREADY been processed (enroll + cycle-record
 * enrichment fired) by the merge-completion watcher. Consulted before firing the
 * merge-coupled writes so they happen at most once per PR — even if a prior
 * tick's `pendingEnrollRemove` failed and the entry is re-observed. On a Redis
 * error returns `true` (fail closed: never double-enroll on a blip; the pending
 * entry is left in place so a healthy later tick can re-check and drop it).
 */
export async function wasEnrolledMarked(prNumber: number): Promise<boolean> {
  try {
    const r = getRedisConnection();
    const v = await r.hget(holdbackEnrolledMarkerKey(), String(prNumber));
    return v != null;
  } catch (err: any) {
    logger.error({ prNumber, err }, "[holdback] wasEnrolledMarked failed");
    return true;
  }
}

/**
 * Record that this PR's landing has been processed (enroll + enrichment fired),
 * so a re-observed entry never re-fires them. Value is the landing commit SHA
 * (informational). Best-effort — a write failure is logged and returned as a
 * structured result, never thrown; the caller only removes the pending entry
 * once the mark succeeded, so a failed mark leaves the entry to retry next tick.
 */
export async function markEnrolled(
  prNumber: number,
  commitSha: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const r = getRedisConnection();
    await r.hset(holdbackEnrolledMarkerKey(), String(prNumber), commitSha);
    return { ok: true };
  } catch (err: any) {
    const msg = `[holdback] markEnrolled failed for pr ${prNumber}: ${err?.message || String(err)}`;
    logger.error({ prNumber, err }, "[holdback] markEnrolled failed");
    return { ok: false, error: msg };
  }
}

/** Test-only: clear the entire enrolled-marker hash. */
export async function _resetEnrolledMarker(): Promise<void> {
  const r = getRedisConnection();
  await r.del(holdbackEnrolledMarkerKey());
}

// ---------------------------------------------------------------------------
// Merge-completion watcher: observability health (issue #2623)
// ---------------------------------------------------------------------------

/** TTL on the health record — 2 days, longer than the hourly run cadence so a
 * present record is always the genuine last run, but short enough that a
 * long-stopped scheduler's record ages out (mirrors reconciler-health, #2057). */
const MERGE_WATCH_HEALTH_TTL_SEC = 2 * 24 * 60 * 60;

/**
 * Persist the merge-completion watcher's last-run health snapshot (best-effort;
 * the chore already logs, so a write failure here must never abort it).
 */
export async function setMergeWatchHealth(record: MergeWatchHealthRecord): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.set(
      holdbackMergeWatchHealthKey(),
      JSON.stringify(record),
      "EX",
      MERGE_WATCH_HEALTH_TTL_SEC,
    );
  } catch (err: any) {
    /* intentional: health persistence is observability, not correctness — a
       write failure is logged and swallowed so the watcher's own work stands. */
    logger.error({ err }, "[holdback] setMergeWatchHealth failed");
  }
}

/** Read the merge-completion watcher's last-run health snapshot, or `null` if
 * none/expired or the stored value is unparseable. */
export async function getMergeWatchHealth(): Promise<MergeWatchHealthRecord | null> {
  try {
    const r = getRedisConnection();
    const raw = await r.get(holdbackMergeWatchHealthKey());
    if (!raw) return null;
    return JSON.parse(raw) as MergeWatchHealthRecord;
  } catch (err: any) {
    logger.error({ err }, "[holdback] getMergeWatchHealth: unreadable health record");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Enrol-state record (issue #4632, ADR-0034 §8/§9)
// ---------------------------------------------------------------------------

/** TTL on an enrol-state record + its index entry — 30 days (issue #4632 INV-5). */
const ENROL_STATE_TTL_SEC = 30 * 24 * 60 * 60;

export type EnrolStateWriteResult = { ok: true } | { ok: false; error: string };

/**
 * Upsert one enrol-state record, keyed on `record.commitSha` (issue #4632
 * INV-5). Sets the per-SHA JSON value with the 30d TTL, upserts the SHA into
 * the `mergedAt`-scored ZSET index (falling back to write-time when
 * `mergedAt` is absent), and trims the index to the same 30d horizon so it
 * never grows unbounded. Best-effort — a Redis error is logged with the
 * `[holdback]` prefix and returned as a structured result, never thrown.
 */
export async function recordEnrolState(record: HoldbackEnrolState): Promise<EnrolStateWriteResult> {
  if (!record.commitSha) {
    return { ok: false, error: "recordEnrolState: commitSha is required" };
  }
  try {
    const r = getRedisConnection();
    const key = holdbackEnrolStateKey(record.commitSha);
    await r.set(key, JSON.stringify(record), "EX", ENROL_STATE_TTL_SEC);
    const parsedMergedAt = record.mergedAt ? Date.parse(record.mergedAt) : NaN;
    const score = Number.isFinite(parsedMergedAt) ? parsedMergedAt : Date.now();
    const indexKey = holdbackEnrolStateIndexKey();
    await r.zadd(indexKey, score, record.commitSha);
    await r.zremrangebyscore(indexKey, "-inf", Date.now() - ENROL_STATE_TTL_SEC * 1000);
    return { ok: true };
  } catch (err: any) {
    const msg = `[holdback] recordEnrolState failed for ${record.commitSha}: ${err?.message || String(err)}`;
    logger.error({ commitSha: record.commitSha, err }, "[holdback] recordEnrolState failed");
    return { ok: false, error: msg };
  }
}

export type EnrolStateReadResult =
  | { ok: true; state: HoldbackEnrolState | null }
  | { ok: false; error: string };

/**
 * Read one commit's enrol-state record, or `{ state: null }` when none exists
 * or the stored value fails `HoldbackEnrolStateSchema.safeParse` (logged as a
 * malformed row rather than surfaced as a read failure — mirrors
 * `pendingEnrollList`'s per-field skip posture). Never throws.
 */
export async function getEnrolState(commitSha: string): Promise<EnrolStateReadResult> {
  try {
    const r = getRedisConnection();
    const raw = await r.get(holdbackEnrolStateKey(commitSha));
    if (raw == null) return { ok: true, state: null };
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err: any) {
      logger.error({ commitSha, err }, "[holdback] getEnrolState: malformed JSON");
      return { ok: true, state: null };
    }
    const parsed = HoldbackEnrolStateSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.error(
        { commitSha, issues: parsed.error.issues },
        "[holdback] getEnrolState: record failed schema validation",
      );
      return { ok: true, state: null };
    }
    return { ok: true, state: parsed.data };
  } catch (err: any) {
    const msg = `[holdback] getEnrolState failed for ${commitSha}: ${err?.message || String(err)}`;
    logger.error({ commitSha, err }, "[holdback] getEnrolState failed");
    return { ok: false, error: msg };
  }
}

export type EnrolStateListResult =
  | { ok: true; states: HoldbackEnrolState[] }
  | { ok: false; error: string };

/**
 * List enrol-state records newest-`mergedAt`-first, optionally filtered to one
 * `state`, capped at `limit` (default 50). Reads the ZSET index for candidate
 * SHAs (over-fetching to leave room for the state filter, bounded so a large
 * index can't make one read unbounded), then `MGET`s + `safeParse`s each
 * record — an unparseable row is skipped and logged rather than failing the
 * whole list. Never throws.
 */
export async function listEnrolStates(
  opts: { state?: HoldbackEnrolState["state"]; limit?: number } = {},
): Promise<EnrolStateListResult> {
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  try {
    const r = getRedisConnection();
    const fetchCount = Math.min(Math.max(limit * 4, limit), 800);
    const shas = await r.zrevrange(holdbackEnrolStateIndexKey(), 0, fetchCount - 1);
    if (shas.length === 0) return { ok: true, states: [] };
    const raws = await r.mget(...shas.map((sha) => holdbackEnrolStateKey(sha)));
    const states: HoldbackEnrolState[] = [];
    for (const raw of raws) {
      if (raw == null) continue;
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = HoldbackEnrolStateSchema.safeParse(parsedJson);
      if (!parsed.success) {
        logger.error(
          { issues: parsed.error.issues },
          "[holdback] listEnrolStates: skipping unparseable row",
        );
        continue;
      }
      if (opts.state && parsed.data.state !== opts.state) continue;
      states.push(parsed.data);
      if (states.length >= limit) break;
    }
    return { ok: true, states };
  } catch (err: any) {
    const msg = `[holdback] listEnrolStates failed: ${err?.message || String(err)}`;
    logger.error({ err }, "[holdback] listEnrolStates failed");
    return { ok: false, error: msg };
  }
}

/** Test-only: clear every enrol-state record + the index. */
export async function _resetEnrolState(): Promise<void> {
  const r = getRedisConnection();
  const keys = await r.keys("hydra:holdback:enrol-state:*");
  if (keys.length > 0) await r.del(...keys);
}

/**
 * Persist the merge-event-enrol chore's last-run health snapshot (issue #4632
 * INV-9). Best-effort — the chore already logs, so a write failure here must
 * never abort it.
 */
export async function setMergeEventHealth(record: MergeEventHealthRecord): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.set(
      holdbackMergeEventHealthKey(),
      JSON.stringify(record),
      "EX",
      MERGE_WATCH_HEALTH_TTL_SEC,
    );
  } catch (err: any) {
    /* intentional: health persistence is observability, not correctness — a
       write failure is logged and swallowed so the chore's own work stands. */
    logger.error({ err }, "[holdback] setMergeEventHealth failed");
  }
}

/** Read the merge-event-enrol chore's last-run health snapshot, or `null` if
 * none/expired or the stored value is unparseable. */
export async function getMergeEventHealth(): Promise<MergeEventHealthRecord | null> {
  try {
    const r = getRedisConnection();
    const raw = await r.get(holdbackMergeEventHealthKey());
    if (!raw) return null;
    return JSON.parse(raw) as MergeEventHealthRecord;
  } catch (err: any) {
    logger.error({ err }, "[holdback] getMergeEventHealth: unreadable health record");
    return null;
  }
}

/** Test-only: clear the merge-event-enrol chore's health snapshot. */
export async function _resetMergeEventHealth(): Promise<void> {
  const r = getRedisConnection();
  await r.del(holdbackMergeEventHealthKey());
}
