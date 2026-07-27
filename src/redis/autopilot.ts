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
 * Redis appears here ONLY as a non-enforcing, read-only heartbeat (ADR-0032
 * invariant 5). Concurrency stays a flock lock owned by the drainer; this key
 * enforces nothing.
 *
 * The key string is intentionally inlined here rather than added to
 * `redis/keys.ts`: the ADR-0009 seam is satisfied by a builder that lives
 * anywhere under `src/redis/` (see the `hydra:dispatches:*` precedent inlined
 * in `src/redis/dispatches.ts`), and issue #3754 scopes edits to this file.
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
