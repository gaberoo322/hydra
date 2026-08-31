/**
 * candidate-exclusions.ts — pure aggregator leaf for Candidate Exclusion
 * telemetry (issue #3964, design decided on wayfinder #3954).
 *
 * `scripts/autopilot/collect-state.sh` evaluates four pre-dispatch filters
 * against every open `ready-for-agent` orchestrator issue, every turn:
 *
 *   - `target-scope-exclusion`    (issue #2701/#2704) — a `target-backlog`-
 *     labelled issue is Target-scope, never an orch grill/dev anchor.
 *   - `in-flight-dev-exclusion`   (issue #3711) — dev work already merged/
 *     in-flight for the anchor (an open PR referencing it, or the
 *     `in-progress` label).
 *   - `mechanical-exclusion`      (issue #1230) — a `cleanup-scan`-labelled
 *     or `track:`-title-prefixed anchor needs no design concept.
 *   - `trivial-anchor-exclusion`  (issue #1088) — an explicit
 *     `Expected tier: T1` body stamp (absent the `needs-design-concept`
 *     opt-in) is provably trivial.
 *
 * Before this issue these verdicts were computed and thrown away
 * (`continue`) — a refused candidate left no trace, so neither the refusal
 * COUNT nor its correctness was knowable. `decide.py` now re-emits one
 * `candidate_exclusion` event per (anchor, member) evaluation (mirroring
 * `cascade_routing_blocked`); the slot-events bridge persists each into a
 * durable, anchor+member-KEYED bounded ring (`src/redis/
 * candidate-exclusions.ts`) — updated, not appended, so an anchor excluded
 * every turn for weeks is ONE ledger row with a rising `turns` counter, not
 * an unbounded append log (the #3927 amplification pathology).
 *
 * This file is the PURE fold only — it consumes already-read
 * `CandidateExclusionRecord`s (the anchor+member-deduped ledger snapshot)
 * and produces the per-member `{considered, excluded, survived,
 * exclusionRate}` + evidence-breakdown rollup the metrics surface reads. No
 * Redis. Extracted as its own leaf, same split as `cascade-routing.ts` ←
 * `cascade-telemetry.ts`.
 */

/** Verdict of one (anchor, member) evaluation. */
export type CandidateExclusionVerdict = "excluded" | "survived";

/**
 * One anchor-keyed (anchor, member) ledger record — the `boundedJsonList`
 * entry shape persisted by `src/redis/candidate-exclusions.ts`. Fields
 * mirror the shape decided on wayfinder #3954 verbatim.
 */
export interface CandidateExclusionRecord {
  /** `issue-<N>` — never a bare number (matches the `orch_*_anchor` convention). */
  anchor: string;
  /** `<member>-exclusion`. */
  member: string;
  verdict: CandidateExclusionVerdict;
  /**
   * `pr-body-ref | pr-branch-name | in-progress-label | cleanup-scan-label |
   * track-title-prefix | expected-tier-t1 | target-backlog-label`, or `""`
   * for a `survived` verdict (there is no exclusion reason to report).
   */
  evidence: string;
  /** Epoch seconds this (anchor, member) pair was first observed. */
  first_seen_ts: number;
  /** Epoch seconds of the most recent evaluation (this upsert). */
  last_seen_ts: number;
  /** Re-fire count — the amplification factor kept explicit (issue #3927). */
  turns: number;
  run_id: string;
  turn_n: number;
}

/** Rollup for one member: how often it fires, against what denominator. */
interface CandidateExclusionMemberRollup {
  /** Distinct (anchor, member) records currently on the ledger for this member. */
  considered: number;
  excluded: number;
  survived: number;
  /** `excluded / considered`, rounded to 3dp. 0 when `considered` is 0 (never NaN). */
  exclusionRate: number;
  /** Excluded-count broken down by `evidence` tag (e.g. `pr-body-ref` vs `pr-branch-name`). */
  byEvidence: Record<string, number>;
}

/** Aggregate rollup over the full candidate-exclusion ledger. */
export interface CandidateExclusionRollup {
  /** Records folded (the ledger snapshot size actually read). */
  sampleSize: number;
  /** Per-member breakdown, keyed by the `member` string on each record. */
  byMember: Record<string, CandidateExclusionMemberRollup>;
}

/** An empty per-member bucket — the honest "no records yet" default. */
function emptyMemberRollup(): CandidateExclusionMemberRollup {
  return { considered: 0, excluded: 0, survived: 0, exclusionRate: 0, byEvidence: {} };
}

/**
 * Fold a list of anchor-keyed candidate-exclusion ledger records into a
 * per-member rollup. PURE — no Redis. Rates are 0 (never NaN) when their
 * denominator is 0. A record with an unrecognised `verdict` is skipped (the
 * ledger is tolerant-read from Redis; a corrupt/partial entry must not
 * crash the fold — same defensive stance as `rollupCascadeTelemetry`).
 */
export function rollupCandidateExclusions(
  records: readonly CandidateExclusionRecord[],
): CandidateExclusionRollup {
  const byMember: Record<string, CandidateExclusionMemberRollup> = {};

  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.verdict !== "excluded" && rec.verdict !== "survived") continue;
    const member = String(rec.member || "unknown");
    const bucket = byMember[member] ?? (byMember[member] = emptyMemberRollup());
    bucket.considered += 1;
    if (rec.verdict === "excluded") {
      bucket.excluded += 1;
      const evidence = String(rec.evidence || "unknown");
      bucket.byEvidence[evidence] = (bucket.byEvidence[evidence] ?? 0) + 1;
    } else {
      bucket.survived += 1;
    }
  }

  for (const bucket of Object.values(byMember)) {
    bucket.exclusionRate =
      bucket.considered > 0 ? Math.round((bucket.excluded / bucket.considered) * 1000) / 1000 : 0;
  }

  return { sampleSize: records.length, byMember };
}
