/**
 * src/qa/shadow-fold.ts — the zero-token A-pair-only counterfactual fold, the
 * one-way top-up decision and the detector-gap log (ADR-0046 D5/D6, P2 #5264).
 *
 * Pure — no fs/network/Redis/child_process. It consumes the SAME per-reviewer
 * findings map and `spawnedReviewers` list the fold step already holds and
 * returns bookkeeping beside the gate: nothing here is an input to the live
 * verdict (that is computed by the unchanged fold step), and the result has no
 * top-level verdict field. Reuses `foldReviewFindings` on a subset of the map
 * rather than re-implementing severity gating.
 *
 * NAMED FOLLOW-UP (not wired here): calling `shadowFold` / `renderQaShadowLine`
 * from the fold phase + playbook shim, and asking pair reviewers for a door
 * call (the findings contract has no `door` field yet), are out of this
 * issue's scope list. Until they land, `two-way-pair: shadow` emits no live
 * shadow lines. P3 (#5265) extends the cohort readers to `parseQaShadowLines`.
 */

import { foldReviewFindings, reviewerGroup, MALFORMED_FINDING_ID } from "./fold.ts";
import type { FoldedFinding, FindingsFoldResult } from "./fold.ts";
import { maxDoor } from "./fanout.ts";
import type { ReversibilityRecord, ReviewerFanoutMode } from "./fanout.ts";
import { requiresOneWayDepth } from "./one-way-door.ts";
import type { OneWayDoorResult } from "./one-way-door.ts";

type Door = OneWayDoorResult["door"];
type Verdict = "PASS" | "FAIL";

export const QA_SHADOW_PREFIX = "QA-Shadow:";
export const QA_SHADOW_UNKNOWN_SHA = "unknown";

/** Reviewers added by the one-way top-up (the pair stays as `primary`). */
export const TOP_UP_REVIEWERS: readonly string[] = ["reviewer-B-standards", "reviewer-B-spec"];

export interface ShadowFoldInput {
  tier: number | null;
  /** Per-reviewer findings map, exactly what the fold step holds. */
  findings: unknown;
  spawnedReviewers: readonly string[];
  /** The live fan-out mode (`decision.mode`). */
  fanoutMode: ReviewerFanoutMode;
  /** `decision.reversibility`; absent/null when the caller did not supply it. */
  reversibility?: ReversibilityRecord | null;
  /** Each spawned reviewer's own door call, keyed by reviewer name. */
  reviewerDoors?: Record<string, Door | null | undefined> | null;
}

export interface PairMissRow {
  severity: FoldedFinding["severity"];
  axis: FoldedFinding["axis"];
  location: string;
  reviewers: string[];
}

export type Counterfactual =
  | { applicable: false; reason: string }
  | {
      applicable: true;
      measured: false;
      pairMissCount: null;
      reason: "reviewer-output-malformed";
      live: { reviewVerdict: Verdict };
    }
  | {
      applicable: true;
      measured: true;
      pairMissCount: number;
      pairMissRows: PairMissRow[];
      /** The A-only fold's verdict. */
      reviewVerdict: Verdict;
      live: { reviewVerdict: Verdict };
      /** live FAIL && counterfactual PASS — derived, not the primary metric. */
      verdictFlipped: boolean;
    };

export interface TopUp {
  required: boolean;
  mode?: "adversarial";
  addReviewers?: string[];
  reason: string;
}

export interface DetectorGap {
  reviewer: string;
  reviewerDoor: Door;
  detectorDoor: "two-way" | null;
}

export interface ShadowFoldResult {
  /** Logging copy of the live fold's verdict; never read by the gate. */
  live: { reviewVerdict: Verdict; mode: FindingsFoldResult["mode"] };
  counterfactual: Counterfactual;
  topUp: TopUp;
  detectorGaps: DetectorGap[];
}

function counterfactualFor(input: ShadowFoldInput, live: FindingsFoldResult): Counterfactual {
  const rec = input.reversibility;
  if (!rec) return { applicable: false, reason: "reversibility-record-absent" };
  if (rec.twoWayPair === "off") return { applicable: false, reason: "two-way-pair-off" };
  if (rec.twoWayPair === "on") return { applicable: false, reason: "two-way-pair-on" };
  if (!rec.pairEligible) return { applicable: false, reason: "pair-not-eligible" };
  if (rec.reductionApplied) return { applicable: false, reason: "pair-reduction-applied" };
  if (input.fanoutMode !== "adversarial") return { applicable: false, reason: "live-mode-not-adversarial" };
  if (!input.spawnedReviewers.some((r) => reviewerGroup(r) === "A")) {
    return { applicable: false, reason: "no-a-reviewer" };
  }
  if (live.mode !== "severity-gated") return { applicable: false, reason: "tier-not-severity-gated" };

  const rows = [...live.blocking, ...live.followUps];
  if (rows.some((r) => r.finding.startsWith(MALFORMED_FINDING_ID))) {
    return {
      applicable: true,
      measured: false,
      pairMissCount: null,
      reason: "reviewer-output-malformed",
      live: { reviewVerdict: live.reviewVerdict },
    };
  }

  // The unchanged fold, re-run on the A-group subset of the map (INV-4).
  const map = input.findings as Record<string, unknown>;
  const aMap: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) {
    if (reviewerGroup(k) === "A") aMap[k] = v;
  }
  const aOnly = foldReviewFindings({
    tier: input.tier,
    findings: aMap,
    spawnedReviewers: input.spawnedReviewers.filter((r) => reviewerGroup(r) === "A"),
  });
  const misses = live.blocking.filter((r) => !r.reviewerGroups.includes("A"));
  return {
    applicable: true,
    measured: true,
    pairMissCount: misses.length,
    pairMissRows: misses.map((r) => ({
      severity: r.severity,
      axis: r.axis,
      location: r.location,
      reviewers: [...r.reviewers],
    })),
    reviewVerdict: aOnly.reviewVerdict,
    live: { reviewVerdict: live.reviewVerdict },
    verdictFlipped: live.reviewVerdict === "FAIL" && aOnly.reviewVerdict === "PASS",
  };
}

function topUpFor(input: ShadowFoldInput, reviewerDoor: Door | null): TopUp {
  if (input.fanoutMode === "adversarial") return { required: false, reason: "already-adversarial" };
  if (input.fanoutMode === "single") return { required: false, reason: "single-mode" };
  if (!input.reviewerDoors || Object.keys(input.reviewerDoors).length === 0) {
    return { required: false, reason: "reviewerDoors-absent" };
  }
  if (reviewerDoor === null || !requiresOneWayDepth({ door: reviewerDoor })) {
    return { required: false, reason: "no-reviewer-call" };
  }
  if (!input.reversibility?.reductionApplied) return { required: false, reason: "pair-not-reduced" };
  return {
    required: true,
    mode: "adversarial",
    addReviewers: [...TOP_UP_REVIEWERS],
    reason: `reviewer one-way call (${reviewerDoor}) on a live pair — add reviewer B in the same round`,
  };
}

/** Pure; never mutates its inputs; repeated calls are deep-equal. */
export function shadowFold(input: ShadowFoldInput): ShadowFoldResult {
  const live = foldReviewFindings({
    tier: input.tier,
    findings: input.findings,
    spawnedReviewers: input.spawnedReviewers,
  });
  const doors = input.reviewerDoors ?? {};
  const reviewerDoor = maxDoor(...Object.values(doors));
  const detectorDoor = input.reversibility?.door ?? null;
  const detectorGaps: DetectorGap[] = [];
  if (detectorDoor === null || detectorDoor === "two-way") {
    const gapDetectorDoor: DetectorGap["detectorDoor"] = detectorDoor === "two-way" ? "two-way" : null;
    for (const [reviewer, door] of Object.entries(doors)) {
      if (door && requiresOneWayDepth({ door })) {
        detectorGaps.push({ reviewer, reviewerDoor: door, detectorDoor: gapDetectorDoor });
      }
    }
  }
  return {
    live: { reviewVerdict: live.reviewVerdict, mode: live.mode },
    counterfactual: counterfactualFor(input, live),
    topUp: topUpFor(input, reviewerDoor),
    detectorGaps,
  };
}

// ---------------------------------------------------------------------------
// QA-Shadow: line — sibling of the QA-Verdict: trailer (never matches its regex)
// ---------------------------------------------------------------------------

function normaliseSha(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().toLowerCase().slice(0, 12);
  return /^[0-9a-f]{7,12}$/.test(s) ? s : QA_SHADOW_UNKNOWN_SHA;
}

export function renderQaShadowLine(input: {
  pr: number | null;
  sha: string | null | undefined;
  result: ShadowFoldResult;
}): string {
  const { result } = input;
  const cf = result.counterfactual;
  const pr = Number.isInteger(input.pr) && (input.pr as number) >= 1 ? String(input.pr) : "unknown";
  const pairMiss = !cf.applicable ? "n/a" : cf.measured ? String(cf.pairMissCount) : "unmeasured";
  const cfVerdict = cf.applicable && cf.measured ? cf.reviewVerdict : "n/a";
  return (
    `${QA_SHADOW_PREFIX} pr=${pr} sha=${normaliseSha(input.sha)} pair_miss=${pairMiss} ` +
    `counterfactual=${cfVerdict} live=${result.live.reviewVerdict} ` +
    `top_up=${result.topUp.required ? 1 : 0} detector_gaps=${result.detectorGaps.length}`
  );
}

export interface ParsedQaShadowLine {
  pr: number | null;
  sha: string | null;
  pairMiss: number | "unmeasured" | "n/a" | null;
  counterfactual: Verdict | "n/a" | null;
  live: Verdict | null;
  topUp: 0 | 1 | null;
  detectorGaps: number | null;
}

const QA_SHADOW_LINE_RE = /^QA-Shadow:([^\r\n]*)\r?$/gm;

function field(rest: string, key: string): string | undefined {
  return new RegExp(`(?:^|[ \\t])${key}=(\\S*)`).exec(rest)?.[1];
}

function intField(rest: string, key: string): number | null {
  const v = field(rest, key);
  return v !== undefined && /^\d+$/.test(v) ? Number.parseInt(v, 10) : null;
}

/** Lenient per-key parse of every `QA-Shadow:` line in a body, in order. */
export function parseQaShadowLines(body: string | null | undefined): ParsedQaShadowLine[] {
  if (typeof body !== "string" || !body.includes(QA_SHADOW_PREFIX)) return [];
  const out: ParsedQaShadowLine[] = [];
  for (const m of body.matchAll(QA_SHADOW_LINE_RE)) {
    const rest = m[1] as string;
    const pr = intField(rest, "pr");
    const pm = field(rest, "pair_miss");
    const cf = field(rest, "counterfactual");
    const lv = field(rest, "live");
    const tu = intField(rest, "top_up");
    out.push({
      pr: pr !== null && pr >= 1 ? pr : null,
      sha: field(rest, "sha") ?? null,
      pairMiss:
        pm === "unmeasured" || pm === "n/a" ? pm : pm !== undefined && /^\d+$/.test(pm) ? Number.parseInt(pm, 10) : null,
      counterfactual: cf === "PASS" || cf === "FAIL" || cf === "n/a" ? cf : null,
      live: lv === "PASS" || lv === "FAIL" ? lv : null,
      topUp: tu === 0 || tu === 1 ? tu : null,
      detectorGaps: intField(rest, "detector_gaps"),
    });
  }
  return out;
}
