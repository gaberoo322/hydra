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
    console.error(msg);
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
        console.error(
          `[holdback] pendingEnrollList: skipping malformed field ${field}: ${err?.message || String(err)}`,
        );
      }
    }
    entries.sort((a, b) => a.prNumber - b.prNumber);
    return { ok: true, entries };
  } catch (err: any) {
    const msg = `[holdback] pendingEnrollList failed: ${err?.message || String(err)}`;
    console.error(msg);
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
    console.error(`[holdback] pendingEnrollRemove failed for pr ${prNumber}: ${err?.message || String(err)}`);
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
    console.error(
      `[holdback] wasEnrolledMarked failed for pr ${prNumber}: ${err?.message || String(err)}`,
    );
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
    console.error(msg);
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
    console.error(`[holdback] setMergeWatchHealth failed: ${err?.message || String(err)}`);
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
    console.error(`[holdback] getMergeWatchHealth: unreadable health record: ${err?.message || String(err)}`);
    return null;
  }
}
