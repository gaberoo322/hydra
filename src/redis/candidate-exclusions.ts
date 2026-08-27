/**
 * Candidate Exclusion telemetry Redis seam (issue #3964, design decided on
 * wayfinder #3954).
 *
 * `scripts/autopilot/collect-state.sh` evaluates the four live Candidate
 * Exclusion predicates (target-scope #2701, in-flight-dev #3711, mechanical
 * #1230, trivial-anchor #1088) against every open `ready-for-agent`
 * orchestrator issue, every turn — and, before this issue, discarded every
 * verdict via `continue`. `decide.py` now re-emits one `candidate_exclusion`
 * observability event per (anchor, member) evaluation, riding
 * `hydra:autopilot:slot-events` alongside the other decide.py turn events
 * (identical mechanism to `cascade_routing_blocked`, #3284).
 *
 * Storage: a single `boundedJsonList` ring (ADR-0017 Category C), keyed
 * `(anchor, member)` and UPDATED rather than appended — an exclusion that
 * re-fires every ~15-min turn for weeks must stay ONE ledger row with a
 * rising `turns` counter, not an unbounded per-turn append log (the #3927
 * amplification pathology: 156 events collapsing to 59 distinct items,
 * 2.64x, from exactly this kind of re-fire loop). `boundedJsonList` itself
 * exposes only push/read/clear (no in-place update), so the upsert here is
 * a full read-modify-write of the ledger: read the ring, splice in the
 * merged record, clear, and re-push in order. This is the deliberate,
 * documented trade-off of reusing the shared primitive AS-IS (issue #3964
 * explicitly asks for `bounded-list.ts`, not a bespoke update-in-place
 * primitive) rather than extending it for a single caller — acceptable
 * because in practice the ring holds tens to low hundreds of distinct
 * (anchor, member) pairs (bounded by the live `ready-for-agent` count), far
 * under the 2000-entry cap sized for "months of history."
 *
 * The bridge (`src/autopilot/slot-events-bridge.ts`) is `$`-anchored and
 * explicitly lossy — it animates NEW events and may lag/skip on restart, so
 * this ring is a best-effort DURABILITY layer, not an exactly-once ledger.
 * It supports RATES (`rollupCandidateExclusions`'s `exclusionRate`), and
 * must never be read as a complete census of every evaluation that ever
 * happened.
 *
 * This file is the I/O seam ONLY: it reads/writes the bounded ring and
 * DELEGATES the numeric fold to the pure aggregator leaf
 * `src/aggregators/candidate-exclusions.ts`. The fold function and its
 * record/rollup types live in the aggregator and are imported here for
 * internal use, but NOT re-exported (callers must import the fold from the
 * aggregator directly — same convention as `cascade-telemetry.ts`).
 */

import { boundedJsonList } from "./bounded-list.ts";
import {
  rollupCandidateExclusions,
  type CandidateExclusionRecord,
  type CandidateExclusionRollup,
  type CandidateExclusionVerdict,
} from "../aggregators/candidate-exclusions.ts";

export type { CandidateExclusionRecord, CandidateExclusionRollup };

/**
 * Cap on retained candidate-exclusion ledger rows. With anchor+member-keyed
 * dedup the volume is DISTINCT (anchor, member) pairs, not turns — today's
 * live board (18 ready-for-agent issues x 4 members) is ~72 rows at most,
 * so 2000 is months of history. `CASCADE_TELEMETRY_MAX` is 500 for a rarer
 * event; this feed is denser, hence 4x. Env-overridable via
 * `HYDRA_CANDIDATE_EXCLUSIONS_MAX`, same pattern as the cascade ring.
 */
const CANDIDATE_EXCLUSIONS_MAX = (() => {
  const raw = Number(process.env.HYDRA_CANDIDATE_EXCLUSIONS_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000;
})();

/** The single capped-list key holding the candidate-exclusions ring. */
function candidateExclusionsKey(): string {
  return "hydra:autopilot:candidate-exclusions:ledger";
}

/** The shared bounded-JSON-list handle for the ring (ADR-0017 Category C). */
function candidateExclusionsLedger() {
  return boundedJsonList<CandidateExclusionRecord>(candidateExclusionsKey(), CANDIDATE_EXCLUSIONS_MAX);
}

/** Stable dedup key for a ledger row — never derived from anything but (anchor, member). */
function recordKey(anchor: string, member: string): string {
  return `${anchor}::${member}`;
}

/** Coerce a stringly-typed numeric field to an int, defaulting to `dflt`. */
function intOr(raw: unknown, dflt: number): number {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

/**
 * One (anchor, member) evaluation as decide.py's `candidate_exclusion` event
 * carries it — the pre-upsert shape, before `first_seen_ts`/`turns` are
 * resolved against the existing ledger row (if any).
 */
export interface CandidateExclusionEvaluation {
  anchor: string;
  member: string;
  verdict: CandidateExclusionVerdict;
  evidence: string;
  runId: string;
  turnN: number;
  /** Epoch seconds this evaluation happened. */
  ts: number;
}

/**
 * Translate a raw slot-events `candidate_exclusion` event (string
 * field/value payload) into a `CandidateExclusionEvaluation`, or `null` when
 * the event is not one. PURE — exported for the bridge + tests. Mirrors
 * `cascadeRecordFromEvent`.
 */
export function candidateExclusionEvaluationFromEvent(
  fields: Record<string, unknown> | null | undefined,
): CandidateExclusionEvaluation | null {
  if (!fields || typeof fields !== "object") return null;
  const event = String((fields as any).event ?? "");
  if (event !== "candidate_exclusion") return null;
  const verdictRaw = String((fields as any).verdict ?? "");
  const verdict: CandidateExclusionVerdict = verdictRaw === "excluded" ? "excluded" : "survived";
  const anchor = String((fields as any).anchor ?? "");
  const member = String((fields as any).member ?? "");
  if (!anchor || !member) return null;
  return {
    anchor,
    member,
    verdict,
    evidence: String((fields as any).evidence ?? ""),
    runId: String((fields as any).run_id ?? ""),
    turnN: intOr((fields as any).turn_n, 0),
    ts: intOr((fields as any).ts_epoch, 0),
  };
}

/**
 * Upsert one (anchor, member) evaluation into the durable ring: update the
 * existing row (bumping `turns`, `last_seen_ts`, `verdict`/`evidence` to the
 * latest, and moving it to the front as the most-recently-touched entry) or
 * insert a new one. Best-effort: the caller (slot-events bridge) wraps this
 * so a Redis error never breaks the animation broadcast it rides.
 *
 * Reuses ONLY `boundedJsonList`'s existing push/read/clear surface (issue
 * #3964's explicit ask) — see the module docstring for the accepted
 * read-modify-write trade-off.
 */
export async function recordCandidateExclusion(ev: CandidateExclusionEvaluation): Promise<void> {
  const ledger = candidateExclusionsLedger();
  const existing = await ledger.read();
  const key = recordKey(ev.anchor, ev.member);

  let priorTurns = 0;
  let firstSeenTs = ev.ts;
  const rest: CandidateExclusionRecord[] = [];
  for (const rec of existing) {
    if (!rec || typeof rec !== "object") continue;
    if (recordKey(rec.anchor, rec.member) === key) {
      priorTurns = typeof rec.turns === "number" && Number.isFinite(rec.turns) ? rec.turns : 0;
      firstSeenTs =
        typeof rec.first_seen_ts === "number" && Number.isFinite(rec.first_seen_ts)
          ? rec.first_seen_ts
          : ev.ts;
      continue; // drop the stale row — the merged version is re-inserted at the front below.
    }
    rest.push(rec);
  }

  const merged: CandidateExclusionRecord = {
    anchor: ev.anchor,
    member: ev.member,
    verdict: ev.verdict,
    evidence: ev.evidence,
    first_seen_ts: firstSeenTs,
    last_seen_ts: ev.ts,
    turns: priorTurns + 1,
    run_id: ev.runId,
    turn_n: ev.turnN,
  };

  const capped = [merged, ...rest].slice(0, CANDIDATE_EXCLUSIONS_MAX);
  await ledger.clear();
  // push() = lpush (prepends). Push oldest-to-newest so the LAST push (the
  // just-merged/inserted record) ends up at the head, matching the ring's
  // documented newest-first convention.
  for (const rec of capped.slice().reverse()) {
    await ledger.push(rec);
  }
}

/**
 * Read the full ledger (up to `limit`, default the whole ring) and fold it
 * into the per-member rollup. Never throws for a corrupt entry — the
 * bounded-list read skips unparseable rows.
 */
export async function getCandidateExclusionTelemetry(
  limit: number = CANDIDATE_EXCLUSIONS_MAX,
): Promise<CandidateExclusionRollup> {
  const records = await candidateExclusionsLedger().read(Math.max(1, Math.floor(limit)));
  return rollupCandidateExclusions(records);
}

/** Delete the entire candidate-exclusions ring (test cleanup). */
export async function clearCandidateExclusionTelemetry(): Promise<void> {
  await candidateExclusionsLedger().clear();
}
