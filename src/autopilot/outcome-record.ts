/**
 * Autopilot **dispatch-outcome record** write — the focused leaf that owns the
 * durable per-dispatch outcome record (issue #2942), extracted out of the
 * `cycle-close.ts` coordinator in issue #3323.
 *
 * The cycle-close coordinator (`recordCycle`) sequences three *lifecycle
 * accounting* writes per reap — the cycle hash + index, the lifetime scheduler
 * counters, and the per-cycle metrics hash — which answer "did this cycle
 * merge/fail/unaccount?" and feed the dashboard trend. The dispatch-outcome
 * record is a qualitatively different, *attribution instrumentation* concern:
 * it maps a cycle-record body onto a `DispatchOutcomeRecord` (a write-time join
 * of {run, turn, class, skill, outcome, tokens, duration}) and feeds the
 * autopilot class-stats scoreboard (`class-stats-math.ts`) and the
 * outcome-attribution estimator (`outcome-attribution/estimator.ts`) — a
 * completely different consumer graph, touching a Redis Adapter
 * (`redis/dispatch-outcomes.ts`) the three lifecycle writes never touch.
 *
 * This mirrors the `dispatch-pr-link.ts` extraction (issue #3205): the
 * dispatch-to-PR link is Builder-Health instrumentation, not run lifecycle, so
 * it was extracted into a focused sibling. Same structure here.
 *
 * The record write is ADDITIVE and BEST-EFFORT: a failure logs `console.error`
 * and never alters the caller's `CycleRecordResult` or blocks the reap path
 * (observability, not correctness). That "observability, not correctness"
 * isolation is the canonical signal this concern is intentionally decoupled from
 * cycle-close — and it is now an extraction boundary, not a comment.
 *
 * Errors are swallowed-and-logged (dark-tolerant), matching the
 * `merge/grounding/verification` never-throw convention in CLAUDE.md. The shared
 * `numberOrDefault` / `filesChangedCount` coercion helpers come DOWN from the
 * zero-I/O leaf `run-result.ts` (issue #3087 / #3323).
 */

import {
  type DispatchOutcomeRecord,
  type DispatchOutcomePatch,
  type DispatchOutcomeWriteResult,
} from "../redis/dispatch-outcomes.ts";
import type { CycleRecordBody } from "./schemas.ts";
// cycleId → {runIdPrefix, turn, className} parse + class-row join for the
// per-dispatch outcome record (issue #2942). Both PURE lookups live in the
// Taxonomy Module (issue #2920 precedent).
import { parseDispatchCycleId, classByName } from "../taxonomy/classes.ts";
// Shared zero-I/O coercion helpers (issue #3087 / #3323).
import { numberOrDefault, filesChangedCount } from "./run-result.ts";

/**
 * The durable per-dispatch outcome-record seam (issue #2942). `put` fires on
 * the FIRST cycle-record write, `upgrade` on the issue-2860 completed→merged
 * dedup/enrichment path — so exactly one record exists per cycleId and its
 * `outcome` stays in lockstep with the cycle-hash `status`. `readCycleTokens`
 * is the write-time token fallback (the per-cycle token hash in
 * `src/redis/cost.ts`) when the POST body carried no `tokens` figure.
 *
 * The record write is ADDITIVE and BEST-EFFORT: a failure logs
 * `console.error` and never alters `CycleRecordResult` or blocks the reap
 * path (observability, not correctness).
 */
export interface AutopilotDispatchOutcomesFacade {
  put(record: DispatchOutcomeRecord): Promise<DispatchOutcomeWriteResult>;
  upgrade(cycleId: string, patch: DispatchOutcomePatch): Promise<DispatchOutcomeWriteResult>;
  readCycleTokens(cycleId: string): Promise<string | null>;
}

/**
 * The narrow deps the dispatch-outcome leaf needs — the outcome-record facade
 * plus the shared epoch-MS clock. Deliberately NOT the full `CycleCloseDeps`
 * bag: the leaf's concern is attribution instrumentation, so it accepts only the
 * inputs that concern touches (issue #3323). The `CycleCloseDeps` interface is a
 * structural super-type, so the coordinator passes itself here directly.
 */
export interface OutcomeRecordDeps {
  dispatchOutcomes: AutopilotDispatchOutcomesFacade;
  /** Epoch-MS clock. Defaults to `Date.now` at the coordinator. */
  now: () => number;
}

/**
 * Resolve the per-dispatch token figure for the outcome record (issue #2942):
 * the POST body's `tokens` (reap's authoritative total) when present, else the
 * per-cycle token hash (`hydra:metrics:tokens:by-cycle:<id>`, the write-time
 * fallback), else a truthful `null` — never a fabricated 0. Reuses
 * `filesChangedCount` as the non-negative-integer-or-undefined coercion.
 */
export async function resolveDispatchTokens(
  body: CycleRecordBody,
  cycleId: string,
  deps: OutcomeRecordDeps,
): Promise<number | null> {
  const fromBody = filesChangedCount(body.tokens);
  if (fromBody !== undefined) return fromBody;
  const raw = await deps.dispatchOutcomes.readCycleTokens(cycleId);
  const fromHash = filesChangedCount(raw ?? undefined);
  return fromHash !== undefined ? fromHash : null;
}

/**
 * First-write per-dispatch outcome record (issue #2942). Fires exactly once
 * per cycleId (the caller's first-write path — duplicate posts route through
 * `upgradeDispatchOutcomeRecord` instead). Additive + best-effort: any failure
 * logs and returns; it never alters the caller's `CycleRecordResult`.
 *
 * Dark-tolerant: an unparseable cycleId (bare-UUID qa relay ids) records null
 * run/turn/class attribution; an unknown class records a null skill; absent
 * tokens record null. A record is never dropped and never fabricated.
 */
export async function writeDispatchOutcomeRecord(
  body: CycleRecordBody,
  cycleId: string,
  status: string,
  deps: OutcomeRecordDeps,
): Promise<void> {
  try {
    const parsed = parseDispatchCycleId(cycleId);
    const classRow = parsed ? classByName(parsed.className) : undefined;
    const tokens = await resolveDispatchTokens(body, cycleId, deps);
    const durationMs = numberOrDefault(body.totalDurationMs, 0);
    // Cascade-routing escalation provenance (issue #3284): pass-through of the
    // three optional fields reap forwards ONLY on a cascade escalation
    // re-dispatch. Non-escalated dispatches omit them → truthful null (never a
    // fabricated 0/""). The escalationAttempt marker lets the cascade metrics
    // endpoint attribute THIS dispatch's actual tokens as the escalated-attempt
    // cost delta (design-concept invariant 7 — authoritative token plane, no
    // second estimator).
    const escalationAttempt = filesChangedCount(body.escalationAttempt) ?? null;
    const escalatedModel =
      typeof body.escalatedModel === "string" && body.escalatedModel.length > 0
        ? body.escalatedModel
        : null;
    const result = await deps.dispatchOutcomes.put({
      cycleId,
      runIdPrefix: parsed?.runIdPrefix ?? null,
      turn: parsed?.turn ?? null,
      className: parsed?.className ?? null,
      skill: classRow?.skill ?? null,
      outcome: status,
      tokens,
      durationMs: durationMs > 0 ? durationMs : null,
      escalationAttempt,
      escalatedModel,
      recordedAt: deps.now(),
    });
    if (result.ok === false) {
      console.error(
        `[cycle-close] dispatch-outcome record write failed for cycle=${cycleId}: ${result.error}`,
      );
    }
  } catch (err: any) {
    console.error(
      `[cycle-close] dispatch-outcome record write threw for cycle=${cycleId}: ${err?.message || String(err)}`,
    );
  }
}

/**
 * Keep the durable per-dispatch outcome record's `outcome` in lockstep with the
 * cycle-hash status upgrade (issue #2942/#2860). The caller fires this ONLY on
 * the completed→merged transition (a plain dedup/enrichment post leaves the
 * record untouched — exactly one record per cycleId, put on the first write,
 * upgraded in place here). Additive + best-effort: a failure logs and never
 * alters the returned `CycleRecordResult`.
 *
 * `enrichDurationMs` is the already-resolved (numeric, >0-or-0) span the caller
 * computed on the enrichment path; it is forwarded onto the patch only when
 * real (>0), matching the first-write duration contract.
 */
export async function upgradeDispatchOutcomeRecord(
  body: CycleRecordBody,
  cycleId: string,
  enrichDurationMs: number,
  deps: OutcomeRecordDeps,
): Promise<void> {
  try {
    const patch: DispatchOutcomePatch = { outcome: "merged" };
    const upgradeTokens = filesChangedCount(body.tokens);
    if (upgradeTokens !== undefined) patch.tokens = upgradeTokens;
    if (enrichDurationMs > 0) patch.durationMs = enrichDurationMs;
    // Issue #3284: carry a cascade-escalation marker onto the record if the
    // enriching (PR-aware) write is the first to know it. The first write
    // already persists these when reap forwarded them; this additive HSET only
    // fills a gap, never clobbers (a non-escalation enrichment omits both and
    // leaves the stored provenance untouched).
    const upgradeAttempt = filesChangedCount(body.escalationAttempt);
    if (upgradeAttempt !== undefined) patch.escalationAttempt = upgradeAttempt;
    if (typeof body.escalatedModel === "string" && body.escalatedModel.length > 0)
      patch.escalatedModel = body.escalatedModel;
    const upgradeResult = await deps.dispatchOutcomes.upgrade(cycleId, patch);
    if (upgradeResult.ok === false) {
      console.error(
        `[cycle-close] dispatch-outcome record upgrade failed for cycle=${cycleId}: ${upgradeResult.error}`,
      );
    }
  } catch (err: any) {
    console.error(
      `[cycle-close] dispatch-outcome record upgrade threw for cycle=${cycleId}: ${err?.message || String(err)}`,
    );
  }
}
