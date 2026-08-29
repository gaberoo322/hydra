/**
 * Autopilot Redis ops: the GLM dev-drainer liveness heartbeat (issue #3754).
 *
 * ADR-0032 (as amended by #3753) makes the `hydra:glm:drainer:active`
 * heartbeat LOAD-BEARING: it gates whether the Opus `dev_orch` lane sees
 * `glm-eligible` issues. The drainer loop (#3689) writes the key each tick —
 * only while it is neither operator-paused nor daily-cap-exhausted — so the
 * key means "able to author". This accessor is the READ side that the
 * board-state projection (`src/autopilot/board-state.ts`) consults to decide
 * whether to subtract `glm-eligible` from the Opus authoring pool.
 *
 * **Fail-open toward work (issue #3754).** When the heartbeat is ABSENT,
 * UNREADABLE, or STALE beyond {@link GLM_DRAINER_HEARTBEAT_STALE_MS}, the
 * drainer is treated as NOT live and `glm-eligible` issues are NOT subtracted
 * — Opus sees the work again. This is the safe failure direction: a stale or
 * missing key un-gates the Opus lane rather than starving it. The chain the
 * fallback prevents is `glm-eligible` subtracted → `ready_for_agent` hits 0 →
 * the playbook stops setting `orch_work_available` → `decide.py`'s `dev_orch`
 * selector returns None — so a broadly-labelled board with a DOWN drainer
 * idles BOTH lanes with nothing alarming. Un-gating can never force spend:
 * the pace gate independently decides whether the autopilot run starts at
 * all, so this only stops hiding work from a run already authorised.
 *
 * Redis appears here ONLY as a non-enforcing heartbeat (ADR-0032 invariant 5).
 * Concurrency stays a flock lock owned by the drainer; this key enforces
 * nothing.
 *
 * The key string is intentionally inlined here rather than added to
 * `redis/keys.ts`: the ADR-0009 seam is satisfied by a builder that lives
 * anywhere under `src/redis/` (see the `hydra:dispatches:*` precedent inlined
 * in `src/redis/dispatches.ts`), and issue #3754 scopes edits to this file.
 *
 * **Write side (issue #3689).** `setGlmDrainerHeartbeat` below is the ONLY
 * writer the drainer loop (`scripts/glm/drainer-loop.sh`) is permitted to use
 * for this key, per the CLAUDE.md Redis-seam rule ("Redis access through
 * `src/redis/<domain>.ts` typed accessors — never a raw client"). The loop is
 * bash, so it reaches this function through a small generated Node driver
 * (`node --experimental-strip-types` importing this module directly) rather
 * than a raw `redis-cli SET` — see the loop script's header comment for the
 * exact invocation. Per the issue's 2026-07-27 AMENDMENTS, the CALLER decides
 * *whether* to write on a given tick (only when neither operator-paused nor
 * daily-cap-exhausted — heartbeat means "able to author", not "the process
 * ran"; a flock-blocked tick must still refresh it because a run already in
 * progress is positive liveness evidence). This function itself performs no
 * such gating — it is a pure typed write, mirroring the read side's
 * separation of concerns.
 */

import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";

/** Redis key for the GLM dev-drainer "able to author" heartbeat (ADR-0032). */
export const GLM_DRAINER_ACTIVE_KEY = "hydra:glm:drainer:active";

/**
 * A drainer heartbeat older than this is STALE: the drainer is presumed down
 * and the Opus lane is un-gated. 45 minutes = three missed 15-minute ticks
 * (ADR-0032 #3753 amendment). Deliberately NOT the repo's 90-minute work-item
 * staleness constant (`STALE_IN_PROGRESS_SECONDS`) — that measures a different
 * quantity (a work item's idle age, not a service's liveness), and a
 * service-liveness TTL is a small multiple of the tick interval it watches.
 */
export const GLM_DRAINER_HEARTBEAT_STALE_MS = 45 * 60 * 1000;

/**
 * TTL applied to the heartbeat key on write. Comfortably longer than
 * {@link GLM_DRAINER_HEARTBEAT_STALE_MS} (2x) so a drainer that stops forever
 * eventually lets its last heartbeat expire out of Redis, rather than an
 * ever-staler value sitting there indefinitely. This is memory hygiene only —
 * the staleness DECISION itself (`getGlmDrainerLiveness`) never depends on
 * Redis's own expiry, it computes age from the stored epoch-ms value, so a key
 * that has not yet hit this TTL but IS past the staleness window still reads
 * as `live: false`.
 */
export const GLM_DRAINER_HEARTBEAT_TTL_SECONDS = Math.ceil(
  (GLM_DRAINER_HEARTBEAT_STALE_MS * 2) / 1000,
);

/** Why a liveness read resolved the way it did — machine-readable. */
export type GlmDrainerLivenessReason =
  | "fresh" // parseable heartbeat within the staleness window
  | "absent" // no key present (drainer never wrote, or key expired)
  | "unreadable" // value unparseable, or the Redis read itself threw
  | "stale"; // parseable heartbeat older than the staleness window

export interface GlmDrainerLiveness {
  /** True only when a parseable heartbeat fresher than the threshold is present. */
  live: boolean;
  /** Epoch-ms of the last heartbeat, when present and parseable; else null. */
  heartbeatMs: number | null;
  reason: GlmDrainerLivenessReason;
}

/**
 * Read the GLM dev-drainer liveness heartbeat and resolve it against the
 * staleness window. Never throws — a Redis failure or a corrupt value fails
 * SAFE to NOT-live (the fail-open-toward-work direction). `nowMs` is injected
 * so the fresh-vs-stale decision is deterministic under test.
 *
 * The stored value is the epoch-ms of the last heartbeat tick (the writer is
 * the drainer loop, #3689). Absent / unparseable / past-window values all
 * resolve to `live:false`, which is exactly the condition under which
 * `deriveBoardState` stops subtracting `glm-eligible`.
 */
export async function getGlmDrainerLiveness(
  nowMs: number = Date.now(),
): Promise<GlmDrainerLiveness> {
  let raw: string | null;
  try {
    const r = getRedisConnection();
    raw = await r.get(GLM_DRAINER_ACTIVE_KEY);
  } catch (err: any) {
    // Fail loud, fail safe: a Redis outage can never wedge the Opus lane off.
    // The accessor is the liveness oracle for the partition gate, so an
    // unreadable heartbeat MUST read as "drainer down" → work visible.
    logger.error(
      { err },
      "[autopilot/glm-drainer] heartbeat read threw — treating drainer as not live (fail-open, #3754)",
    );
    return { live: false, heartbeatMs: null, reason: "unreadable" };
  }

  if (raw === null || raw === "") {
    return { live: false, heartbeatMs: null, reason: "absent" };
  }

  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) {
    logger.error(
      { raw },
      "[autopilot/glm-drainer] unparseable heartbeat value — treating drainer as not live (fail-open, #3754)",
    );
    return { live: false, heartbeatMs: null, reason: "unreadable" };
  }

  const ageMs = nowMs - ms;
  if (!Number.isFinite(ageMs) || ageMs > GLM_DRAINER_HEARTBEAT_STALE_MS) {
    return { live: false, heartbeatMs: ms, reason: "stale" };
  }

  return { live: true, heartbeatMs: ms, reason: "fresh" };
}

/** Machine-readable failure code for a heartbeat write fault. */
export type SetGlmDrainerHeartbeatResult =
  | { ok: true }
  | { ok: false; code: "glm-heartbeat-write-failed"; message: string };

/**
 * Write the GLM dev-drainer "able to author" heartbeat (issue #3689).
 *
 * Stores the epoch-ms of this write as a plain string — the exact shape
 * {@link getGlmDrainerLiveness} parses via `Number(raw)`. Sets a TTL
 * ({@link GLM_DRAINER_HEARTBEAT_TTL_SECONDS}) as hygiene only; see that
 * constant's docstring for why the staleness decision does not depend on it.
 *
 * Never throws (never-throw-from-verification convention, CLAUDE.md): a Redis
 * failure returns a result object so the caller (the drainer loop, via its
 * generated Node driver) can log and continue the tick rather than crash it.
 * Fails loud — every failure is logged with context before the result is
 * returned.
 */
export async function setGlmDrainerHeartbeat(
  nowMs: number = Date.now(),
): Promise<SetGlmDrainerHeartbeatResult> {
  try {
    const r = getRedisConnection();
    await r.set(
      GLM_DRAINER_ACTIVE_KEY,
      String(nowMs),
      "EX",
      GLM_DRAINER_HEARTBEAT_TTL_SECONDS,
    );
    return { ok: true };
  } catch (err: any) {
    logger.error(
      { err },
      "[autopilot/glm-drainer] heartbeat write failed (#3689)",
    );
    return {
      ok: false,
      code: "glm-heartbeat-write-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * GLM A/B experiment: randomized arm assignment at eligibility-sweep entry,
 * with a durable assignment log (issue #4125, ADR-0032 slice beta; parent
 * epic #4123). The eligibility sweep
 * (`src/scheduler/chores/glm-eligibility-sweep.ts`) is the ONLY caller and
 * uses TWO independent guards before it will coin-flip a candidate row: (a)
 * the pre-existing label predicate (`isGlmEligibleCandidate`, unchanged from
 * #4124) and (b) a lookup against THIS module's durable log via
 * {@link getGlmAbAssignment}. Guard (b) closes the crash window between a
 * successful log write and a subsequently failed label write, where the
 * label predicate alone would let the row be coin-flipped a second time.
 *
 * Storage: one Redis STRING key per issue (`hydra:glm:ab:assignment:<issue>`),
 * value = the JSON-serialized {@link GlmAbAssignmentRecord}. No TTL — unlike
 * the drainer heartbeat above, this is a permanent research record, not a
 * liveness signal.
 *
 * Sequencing (load-bearing, issue #4125): the sweep calls
 * {@link getGlmAbAssignment} FIRST. Absent a record, it rolls an arm and
 * calls {@link recordGlmAbAssignment} — the log write — BEFORE writing
 * either label; the label write is gated on that write's success (fail
 * closed on the WRITE path). A record found already present (the crash
 * window: log succeeded, label didn't) is deliberately left UNTOUCHED that
 * tick rather than auto-repaired or re-rolled — the sweep never re-applies
 * the recorded arm's label on its own; that is accepted as a rare,
 * non-corrupting edge case rather than a repair loop this slice builds (see
 * the design-concept artifact's rejected alternatives). A LOOKUP that itself
 * fails to read (fail closed on the READ path) is treated the same as
 * "already assigned" — skip, never coin-flip — because the safe failure
 * direction is under-labelling, never a possible double coin flip.
 *
 * `recordGlmAbAssignment` still writes via `SET key value NX` as a
 * defense-in-depth guard against a concurrent sweep run racing the same
 * issue between the lookup and the write; that race is expected to be
 * exercised approximately never in production (a single sweep tick, one
 * candidate list) and, if it ever fires, degrades to exactly the same
 * accepted "leave it for next tick's lookup" edge case above — the write is
 * reported as failed (fail closed) rather than silently overwritten. (`SET
 * NX` over `HSETNX` deliberately: the whole-project `tsc` elaboration budget
 * that truncates ioredis's `RedisCommander` — see this file's sibling
 * `connection.ts` header — drops `hsetnx` but not the 3-arg `SET ... NX`
 * overload, so this stays inside issue #4125's file scope with no
 * `RedisCommands` re-declaration needed.)
 */

/** Redis key for one issue's durable GLM A/B assignment record (issue #4125). */
export function glmAbAssignmentKey(issue: number): string {
  return `hydra:glm:ab:assignment:${issue}`;
}

/** The two arms of the GLM-vs-Opus A/B experiment (issue #4125). */
export type GlmAbArm = "treatment" | "control";

/** One durable assignment record — the experiment's source of truth. */
export interface GlmAbAssignmentRecord {
  issue: number;
  arm: GlmAbArm;
  /** ISO8601 timestamp of the assignment. */
  assignedAt: string;
  /** Identifier of the eligibility-sweep run that made this assignment. */
  sweepRunId: string;
}

/**
 * Result of a LOOKUP (the read-path guard, issue #4125). `record: null` means
 * no assignment exists yet for this issue — safe to coin-flip. A non-null
 * `record` means the issue was already assigned on a prior tick (whether or
 * not its label write then succeeded) — never coin-flip again.
 */
export type GetGlmAbAssignmentResult =
  | { ok: true; record: GlmAbAssignmentRecord | null }
  | { ok: false; code: "glm-ab-assignment-read-failed"; message: string };

/**
 * Type-predicate guard for the failure arm of {@link GetGlmAbAssignmentResult}
 * (issue #4125). Mirrors `isIssueReadFailure` (`src/github/issues.ts`): this
 * repo's tsconfig runs with `strict: false` (no `strictNullChecks`), under
 * which plain `if (!res.ok)` does NOT reliably narrow a discriminated union
 * at call sites — an explicit `res is {...}` predicate is the established
 * workaround.
 */
export function isGlmAbAssignmentReadFailure(
  res: GetGlmAbAssignmentResult,
): res is { ok: false; code: "glm-ab-assignment-read-failed"; message: string } {
  return res.ok === false;
}

/**
 * Look up whether an issue already has a durable GLM A/B assignment (the
 * READ-path guard, issue #4125). Never throws — a Redis fault or an
 * unparseable stored value returns `ok:false` so the caller fails closed
 * (treats it as "already assigned", skips the coin flip) rather than risk a
 * double assignment.
 */
export async function getGlmAbAssignment(
  issue: number,
): Promise<GetGlmAbAssignmentResult> {
  const key = glmAbAssignmentKey(issue);
  try {
    const r = getRedisConnection();
    const raw = await r.get(key);
    if (raw === null) {
      return { ok: true, record: null };
    }
    try {
      const record = JSON.parse(raw) as GlmAbAssignmentRecord;
      return { ok: true, record };
    } catch (err: any) {
      logger.error(
        { err, issue, raw },
        "[autopilot/glm-ab] unparseable assignment record on lookup",
      );
      return {
        ok: false,
        code: "glm-ab-assignment-read-failed",
        message: "unparseable assignment record",
      };
    }
  } catch (err: any) {
    logger.error(
      { err, issue },
      "[autopilot/glm-ab] assignment log lookup failed (fail-closed, issue #4125)",
    );
    return {
      ok: false,
      code: "glm-ab-assignment-read-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Result of a WRITE (the write-path guard, issue #4125). */
export type RecordGlmAbAssignmentResult =
  | { ok: true }
  | { ok: false; code: "glm-ab-assignment-write-failed"; message: string };

/**
 * Type-predicate guard for the failure arm of {@link RecordGlmAbAssignmentResult}
 * (issue #4125). Mirrors `isIssueLabelWriteFailure` (`src/github/issues.ts`)
 * for the same `strict: false` narrowing reason documented on
 * {@link isGlmAbAssignmentReadFailure}.
 */
export function isGlmAbAssignmentWriteFailure(
  res: RecordGlmAbAssignmentResult,
): res is { ok: false; code: "glm-ab-assignment-write-failed"; message: string } {
  return res.ok === false;
}

/**
 * Durably record a GLM A/B arm assignment for one issue (the WRITE-path
 * guard, issue #4125). Callers are expected to have already confirmed via
 * {@link getGlmAbAssignment} that no record exists — this function still
 * writes via `SET key value NX` as defense-in-depth (see module docstring),
 * reporting the rare already-exists race as a failure rather than silently
 * overwriting. Never throws — a Redis fault returns a result object so the
 * caller can fail closed (apply NO label) rather than label an unlogged
 * assignment.
 */
export async function recordGlmAbAssignment(
  candidate: GlmAbAssignmentRecord,
): Promise<RecordGlmAbAssignmentResult> {
  const key = glmAbAssignmentKey(candidate.issue);
  try {
    const r = getRedisConnection();
    const planted = await r.set(key, JSON.stringify(candidate), "NX");
    if (planted === "OK") {
      return { ok: true };
    }
    // Defense-in-depth race (see module docstring): a record already exists
    // even though the caller's lookup found none moments earlier. Report as
    // a write failure so the sweep does not label this tick; the existing
    // record is picked up as a "found" lookup result on the NEXT tick and
    // left untouched there, per the accepted non-corrupting edge case.
    logger.error(
      { issue: candidate.issue },
      "[autopilot/glm-ab] SET NX found an existing record (race) — treating as a write failure this tick",
    );
    return {
      ok: false,
      code: "glm-ab-assignment-write-failed",
      message: "assignment record already exists (race)",
    };
  } catch (err: any) {
    logger.error(
      { err, issue: candidate.issue },
      "[autopilot/glm-ab] assignment log write failed (fail-closed, issue #4125)",
    );
    return {
      ok: false,
      code: "glm-ab-assignment-write-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
