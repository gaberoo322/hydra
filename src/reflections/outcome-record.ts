/**
 * reflections/outcome-record.ts — the reap-side reflection WRITE wrapper.
 *
 * `recordReflectionOutcome` is the orchestrator-side entry point the reap path
 * calls (via `POST /api/autopilot/reflection-record`) when a dispatch
 * terminalises NON-MERGED, so the next attempt's per-anchor reflection pull is
 * non-empty (the #193 retry-correctness invariant, restored by #1119 Slice 1).
 *
 * It was extracted out of `src/autopilot/runs.ts` (the run/turn lifecycle WRITE
 * Module) into the reflections write domain (issue #3321, architecture-scan
 * deepening): the wrapper is a thin validated pass-through onto
 * `recordAnchorReflection` — a reflections-domain write — so it belongs next to
 * its delegate in `src/reflections/`, not in the run-lifecycle domain where a
 * reader browsing `startRun`/`endRun`/`recordTurn` would not look for it. This
 * is the 7th focused-sibling extraction out of `runs.ts` and honours the
 * no-back-compat-re-export precedent all six priors followed (#2125): the sole
 * caller (`src/api/autopilot-lifecycle.ts`) imports from HERE directly, and
 * `runs.ts` no longer re-exports the moved symbols nor carries the
 * cross-domain `reflections/per-anchor.ts` import edge.
 *
 * It stays a focused leaf rather than an addition to `per-anchor.ts` because the
 * wrapper drags autopilot-domain deps — `ReflectionRecordBody`
 * (autopilot/schemas.ts) and the run-result `Ok`/`Err`/`errRedis` leaf — that
 * the pure per-anchor episodic-store Module deliberately does not carry;
 * appending them there would inflate its clean Redis-primitive-only interface.
 *
 * Never throws — returns an Ok/Err result (the merge/grounding/verification
 * convention). The behaviour, result type, and never-throw contract are
 * preserved byte-for-byte from the pre-extraction `runs.ts` home; the Redis
 * Adapters seam is never bypassed — the write still reaches Redis ONLY through
 * `recordAnchorReflection` → `redis/reflections.ts`, never a raw client.
 */

import { recordAnchorReflection } from "./per-anchor.ts";
import { errRedis } from "../autopilot/run-result.ts";
import type { Ok, Err } from "../autopilot/run-result.ts";
import type { ReflectionRecordBody } from "../autopilot/schemas.ts";

export type RecordReflectionOutcomeResult = Ok<{
  anchorRef: string;
  outcome: string;
}> | Err;

/**
 * Re-wire a reflection PRODUCER onto the live path (issue #1119, Slice 1).
 *
 * `recordAnchorReflection` lost its only live caller when #710 deleted the
 * in-process planner, so the per-anchor reflection store went structurally
 * empty (`GET /api/reflections?anchor=` → `count:0`), and a retry of a
 * prior-failure anchor silently lost its own failure context (the #193
 * retry-correctness invariant). This wrapper is the orchestrator-side entry
 * point the reap path calls (via `POST /api/autopilot/reflection-record`) when
 * a dispatch terminalises NON-MERGED, so the next attempt's pull is non-empty.
 *
 * Never throws — returns an Ok/Err result (the merge/grounding/verification
 * convention); a reflection-write failure is learning, not correctness, and the
 * reap path swallows a non-2xx. A thin pass-through onto the producer's opts;
 * idempotency is the producer's capped per-anchor ring plus reap's
 * `reaped_task_ids` ledger keyed on `cycleId`.
 */
export async function recordReflectionOutcome(
  body: ReflectionRecordBody,
): Promise<RecordReflectionOutcomeResult> {
  try {
    const anchorRef = body.anchorRef.trim();
    const outcome = body.outcome.trim();
    if (!anchorRef) {
      return { ok: false, code: "invalid", detail: "anchorRef must be a non-empty string" };
    }
    if (!outcome) {
      return { ok: false, code: "invalid", detail: "outcome must be a non-empty string" };
    }
    const cycleId =
      typeof body.cycleId === "string" && body.cycleId.trim().length > 0
        ? body.cycleId.trim()
        : `reflection-${anchorRef}-${Date.now()}`;

    await recordAnchorReflection({
      cycleId,
      anchorRef,
      taskTitle: body.taskTitle ?? anchorRef,
      outcome,
      reason: body.reason,
      scopeFiles: body.scopeFiles,
    });

    return { ok: true, anchorRef, outcome };
  } catch (err: any) {
    // Never throw out of this path — reflection writes are best-effort
    // learning, not correctness. Surface the failure as an Err so the route
    // can answer 500 without crashing the reap-side POST.
    return errRedis(err);
  }
}
