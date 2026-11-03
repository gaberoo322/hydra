/**
 * Review-findings retro policy (issue #5271, R2; ADR-0046 Decision 8). The
 * pure half of `/hydra-retro --review`: which arms are DUE (Redis-only, no
 * GitHub read), what a review pass may EMIT (ladder + caps), which paths a
 * review PR may touch, and which `enforced-by: reviewer` rules are prunable.
 *
 * Arms and hot-spots come ONLY from `extractReviewFindingArms`
 * (review-findings-extract.ts); thresholds are never re-implemented here.
 * Everything here is pure and never throws.
 *
 * The ladder is check -> standard -> fence. The rung is encoded in the cue
 * (`review:<rung>:<slug>`), so `RetroSeenEntry` and src/redis/retro-seen.ts
 * are untouched and the seen-list dedups per rung.
 */

import type { ReviewFindingArm } from "./review-findings-extract.ts";
import { RETENTION_DAYS } from "./review-findings-extract.ts";
import { REVIEW_CUE } from "../retro-inputs.ts";
import type { RetroSeenEntry } from "../redis/retro-seen.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A slug whose newest emit is below `fence` re-trips only after this many days. */
export const REVIEW_RETRIP_MIN_DAYS = 7;
/** At most this many check-rung issues per review pass. */
export const REVIEW_ISSUE_CAP = 2;
/** At most this many PRs per review pass (standard and fence share the slot). */
export const REVIEW_PR_CAP = 1;

export const REVIEW_LADDER = ["check", "standard", "fence"] as const;
export type ReviewRung = (typeof REVIEW_LADDER)[number];

/** The only paths a review-mode PR may touch. */
export const REVIEW_PR_ALLOWED_PATHS: readonly string[] = ["CODING_STANDARDS.md", "CLAUDE.md"];

/** lowercase, non-[a-z0-9] runs -> `-`, trimmed of leading/trailing `-`. */
export function slugify(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The pure, deterministic slug for an extractor arm (INV-3). */
export function armSlug(arm: ReviewFindingArm): string {
  switch (arm.arm) {
    case "rule-cross-pr":
      return `rule-cross-pr-${slugify(arm.key)}`;
    case "file-cross-pr":
      return `file-cross-pr-${slugify(arm.key)}`;
    case "rule-same-pr-rounds":
      return `rule-same-pr-rounds-${slugify(arm.key)}`;
    case "file-same-pr-rounds":
      return `file-same-pr-rounds-${slugify(arm.key)}`;
    case "pair-miss":
      return "pair-miss";
    case "detector-gap":
      return `detector-gap-${slugify(arm.key)}`;
  }
}

export function hotSpotSlug(file: string): string {
  return `hot-spot-${slugify(file)}`;
}

export function cohortTripSlug(baselineGeneratedAt: string): string {
  return `cohort-trip-${slugify(baselineGeneratedAt)}`;
}

export function reviewCue(rung: ReviewRung | "mechanical", slug: string): string {
  return `review:${rung}:${slug}`;
}

export function isReviewCue(cue: string): boolean {
  return REVIEW_CUE.test(cue);
}

/** The highest ladder-rung seen entry for `slug`, or null. */
function highestSeen(
  slug: string,
  seen: Readonly<Record<string, RetroSeenEntry>>,
): { rung: ReviewRung; entry: RetroSeenEntry } | null {
  for (let i = REVIEW_LADDER.length - 1; i >= 0; i--) {
    const rung = REVIEW_LADDER[i] as ReviewRung;
    const entry = seen[reviewCue(rung, slug)];
    if (entry) return { rung, entry };
  }
  return null;
}

export interface ReviewRetroCandidate {
  slug: string;
  /** The rung the next emit for this slug would land on. */
  nextRung: ReviewRung;
  arm: ReviewFindingArm;
}

/**
 * Redis-only dispatch decision (INV-1, INV-4). A slug is due iff it has no
 * seen entry at any rung, OR its highest-rung entry is below `fence` and at
 * least REVIEW_RETRIP_MIN_DAYS old. Closure of the prior emit is NOT visible
 * here (it needs gh); `planReviewEmit` re-checks it.
 */
export function deriveReviewRetroDue(
  arms: readonly ReviewFindingArm[],
  seen: Readonly<Record<string, RetroSeenEntry>>,
  now: number,
): { due: boolean; candidates: ReviewRetroCandidate[] } {
  const candidates: ReviewRetroCandidate[] = [];
  const done = new Set<string>();
  for (const arm of arms) {
    const slug = armSlug(arm);
    if (done.has(slug)) continue;
    done.add(slug);
    const top = highestSeen(slug, seen);
    if (top === null) {
      candidates.push({ slug, nextRung: "check", arm });
      continue;
    }
    const idx = REVIEW_LADDER.indexOf(top.rung);
    if (idx >= REVIEW_LADDER.length - 1) continue;
    const at = Date.parse(top.entry.at);
    if (!Number.isFinite(at)) continue;
    if (now - at >= REVIEW_RETRIP_MIN_DAYS * DAY_MS) {
      candidates.push({ slug, nextRung: REVIEW_LADDER[idx + 1] as ReviewRung, arm });
    }
  }
  return { due: candidates.length > 0, candidates };
}

export interface PlannedReviewEmit {
  cue: string;
  slug: string;
  rung: ReviewRung;
  arm: ReviewFindingArm;
}

export type ReviewSkipReason =
  | "ladder-exhausted"
  | "prior-emit-open"
  | "review-issue-cap-reached"
  | "review-pr-cap-reached";

export interface ReviewEmitPlan {
  /** Check-rung issues (label `needs-triage`), at most REVIEW_ISSUE_CAP. */
  issues: PlannedReviewEmit[];
  /** The single standard- or fence-rung PR, or null. */
  pr: PlannedReviewEmit | null;
  skipped: Array<{ slug: string; reason: ReviewSkipReason }>;
}

/**
 * Decide what a review pass emits (INV-4, INV-5). `closedRefs` is the set of
 * seen-entry `ref`s the skill found CLOSED via gh (issue closed / PR
 * merged-or-closed). A re-trip lands exactly one rung up, only when the arm
 * still fires and the prior emit is closed. Arm order is the extractor's.
 */
export function planReviewEmit(
  arms: readonly ReviewFindingArm[],
  seen: Readonly<Record<string, RetroSeenEntry>>,
  closedRefs: ReadonlySet<string>,
): ReviewEmitPlan {
  const plan: ReviewEmitPlan = { issues: [], pr: null, skipped: [] };
  const done = new Set<string>();
  for (const arm of arms) {
    const slug = armSlug(arm);
    if (done.has(slug)) continue;
    done.add(slug);
    const top = highestSeen(slug, seen);
    let rung: ReviewRung;
    if (top === null) {
      rung = "check";
    } else {
      const idx = REVIEW_LADDER.indexOf(top.rung);
      if (idx >= REVIEW_LADDER.length - 1) {
        plan.skipped.push({ slug, reason: "ladder-exhausted" });
        continue;
      }
      const ref = top.entry.ref;
      if (ref === null || !closedRefs.has(ref)) {
        plan.skipped.push({ slug, reason: "prior-emit-open" });
        continue;
      }
      rung = REVIEW_LADDER[idx + 1] as ReviewRung;
    }
    const item: PlannedReviewEmit = { cue: reviewCue(rung, slug), slug, rung, arm };
    if (rung === "check") {
      if (plan.issues.length < REVIEW_ISSUE_CAP) plan.issues.push(item);
      else plan.skipped.push({ slug, reason: "review-issue-cap-reached" });
    } else if (plan.pr === null) {
      plan.pr = item;
    } else {
      plan.skipped.push({ slug, reason: "review-pr-cap-reached" });
    }
  }
  return plan;
}

/**
 * The cohort-trip mechanical emit (outside the 2-issue cap): one issue per
 * distinct tripped baseline, never a double-file for the same trip.
 */
export function planCohortTripIssue(
  baselineGeneratedAt: string | null,
  seen: Readonly<Record<string, RetroSeenEntry>>,
): { cue: string; slug: string } | null {
  if (baselineGeneratedAt === null || slugify(baselineGeneratedAt) === "") return null;
  const slug = cohortTripSlug(baselineGeneratedAt);
  const cue = reviewCue("mechanical", slug);
  return seen[cue] ? null : { cue, slug };
}

/**
 * INV-6: a review PR may touch only CODING_STANDARDS.md and CLAUDE.md (and
 * must touch something). Never the QA playbook, fold, verdict code or rollout
 * config.
 */
export function isReviewPrDiffAllowed(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((p) => REVIEW_PR_ALLOWED_PATHS.includes(p));
}

/**
 * INV-9: `enforced-by: reviewer` rule IDs that no stored `finding` row cites
 * within the retention window. The caller supplies only reviewer-enforced IDs
 * (check-path rules are never prune candidates) and drops candidates younger
 * than 90 days via git history.
 */
export function pruneCandidates(
  ruleIds: readonly string[],
  rows: readonly unknown[],
  now: number,
): string[] {
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const cited = new Set<string>();
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (r.kind !== "finding" || typeof r.rule !== "string") continue;
    const at = typeof r.at === "string" ? Date.parse(r.at) : NaN;
    if (!Number.isFinite(at) || at < cutoff) continue;
    cited.add(r.rule);
  }
  return [...new Set(ruleIds)].filter((id) => !cited.has(id)).sort();
}
