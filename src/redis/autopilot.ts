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
 * Durable GLM A/B assignment log (issue #4125, epic #4123).
 *
 * `glm-eligibility-sweep.ts` randomly assigns each issue entering the
 * GLM-eligible pool to one of two arms ("treatment" keeps today's
 * `glm-eligible` routing to the drainer; "control" applies `glm-ab-control`,
 * per #4124, and stays in the Opus `dev_orch` pool). The sweep's board-label
 * read is mutable and lossy — an operator or another chore can add/remove
 * labels later, and a closed issue's labels are not a reliable record of
 * what it was assigned at entry — so this per-issue key is the experiment's
 * durable source of truth, independent of label state.
 *
 * One key per issue (`${GLM_AB_ASSIGNMENT_KEY_PREFIX}<issue>`), storing the
 * JSON-serialised {@link GlmAbAssignmentRecord}. No TTL: unlike the drainer
 * heartbeat above, this is a durable analysis record, not a liveness signal —
 * it must outlive the issue's lifecycle so a downstream per-arm analysis
 * (siblings #4126 gamma, #4127 delta) can reconstruct arms without
 * re-deriving them from label history.
 */

/**
 * Redis key prefix for the durable GLM A/B assignment log. Exported (rather
 * than kept file-private, unlike {@link GLM_DRAINER_ACTIVE_KEY}'s inlining
 * precedent) so a downstream per-arm analysis can SCAN the keyspace using the
 * SAME prefix this module writes, instead of re-deriving the naming scheme.
 */
export const GLM_AB_ASSIGNMENT_KEY_PREFIX = "hydra:glm:ab-assignment:";

function glmAbAssignmentKey(issue: number): string {
  return `${GLM_AB_ASSIGNMENT_KEY_PREFIX}${issue}`;
}

/** Which arm of the GLM-vs-Opus A/B measurement an issue was assigned to. */
export type GlmAbArm = "treatment" | "control";

/** One durable assignment-log record, per the issue's pinned shape. */
export interface GlmAbAssignmentRecord {
  issue: number;
  arm: GlmAbArm;
  /** ISO8601 instant the assignment was made. */
  assignedAt: string;
  /** Identifier of the sweep invocation that made this assignment. */
  sweepRunId: string;
}

/** Why an assignment-log lookup resolved the way it did — machine-readable. */
export type GlmAbAssignmentLookupReason = "found" | "absent" | "unreadable";

export interface GlmAbAssignmentLookup {
  /**
   * True when the issue must NOT be coin-flipped this tick: either a record
   * already exists, OR the lookup could not be trusted. Fail-closed direction
   * (issue #4125): an unreadable/erroring lookup is treated as "already
   * assigned" so a flaky Redis read can never cause a double coin-flip — the
   * safe failure is under-labelling (retried next tick), never a re-flip.
   */
  alreadyAssigned: boolean;
  /** The parsed record, when one was found and parseable; else null. */
  record: GlmAbAssignmentRecord | null;
  reason: GlmAbAssignmentLookupReason;
}

/**
 * Look up one issue's durable A/B assignment-log record. Never throws — a
 * Redis failure or an unparseable value both fail closed to
 * `alreadyAssigned: true` (see {@link GlmAbAssignmentLookup}).
 */
export async function getGlmAbAssignment(
  issue: number,
): Promise<GlmAbAssignmentLookup> {
  let raw: string | null;
  try {
    const r = getRedisConnection();
    raw = await r.get(glmAbAssignmentKey(issue));
  } catch (err: any) {
    logger.error(
      { err, issue },
      "[autopilot/glm-ab] assignment-log read threw — treating as already-assigned (fail-closed, #4125)",
    );
    return { alreadyAssigned: true, record: null, reason: "unreadable" };
  }

  if (raw === null || raw === "") {
    return { alreadyAssigned: false, record: null, reason: "absent" };
  }

  try {
    const record = JSON.parse(raw) as GlmAbAssignmentRecord;
    return { alreadyAssigned: true, record, reason: "found" };
  } catch (err: any) {
    logger.error(
      { err, issue, raw },
      "[autopilot/glm-ab] unparseable assignment-log record — treating as already-assigned (fail-closed, #4125)",
    );
    return { alreadyAssigned: true, record: null, reason: "unreadable" };
  }
}

/** Machine-readable failure code for an assignment-log write fault. */
export type RecordGlmAbAssignmentResult =
  | { ok: true }
  | { ok: false; code: "glm-ab-assignment-write-failed"; message: string };

/**
 * Type guard narrowing a {@link RecordGlmAbAssignmentResult} to its failure
 * arm. The orchestrator's `tsconfig.json` runs `strict: false` (no
 * `strictNullChecks`), so a boolean `ok` does not narrow via plain
 * `if (!res.ok)` — mirrors {@link isIssueLabelWriteFailure}
 * (`src/github/issues.ts`) for the same reason.
 */
export function isGlmAbAssignmentWriteFailure(
  res: RecordGlmAbAssignmentResult,
): res is { ok: false; code: "glm-ab-assignment-write-failed"; message: string } {
  return res.ok === false;
}

/**
 * Durably record one issue's A/B assignment. Never throws (never-throw-from-
 * verification convention, CLAUDE.md): a Redis failure returns a result
 * object so the caller (the sweep) can fail closed — per the issue's
 * invariant, a failed log write must block the label write entirely for that
 * tick, so the row keeps lacking both a label and a log record and the next
 * tick's attempt is a first assignment, never a re-assignment.
 */
export async function recordGlmAbAssignment(
  record: GlmAbAssignmentRecord,
): Promise<RecordGlmAbAssignmentResult> {
  try {
    const r = getRedisConnection();
    await r.set(glmAbAssignmentKey(record.issue), JSON.stringify(record));
    return { ok: true };
  } catch (err: any) {
    logger.error(
      { err, issue: record.issue },
      "[autopilot/glm-ab] assignment-log write failed (#4125)",
    );
    return {
      ok: false,
      code: "glm-ab-assignment-write-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
