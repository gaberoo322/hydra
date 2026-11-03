/**
 * GET /api/qa/review-retro (issue #5271, R2; ADR-0046 Decision 8).
 *
 * The Redis-only review-findings retro signal. Computes
 * `{due, candidates, arms, hotSpots, warnings}` from the review-findings rows
 * and the retro seen-list and NOTHING else - no gh, no file reads, no model
 * call. The Turn Snapshot reads `due` as `review_retro_due`; the
 * architecture-scan skill reads `hotSpots` as pre-ranked candidates (a
 * stateless projection - no Redis key, no writer).
 */

import { Router } from "express";

import { deriveReviewRetroDue, type ReviewRetroCandidate } from "../qa/review-retro.ts";
import {
  extractReviewFindingArms,
  type ExtractReviewFindingArmsResult,
} from "../qa/review-findings-extract.ts";
import { readReviewFindingRows } from "../redis/review-findings.ts";
import { getRetroSeen, type RetroSeenEntry } from "../redis/retro-seen.ts";
import { isolateAggregator } from "./route-helpers.ts";

export interface ReviewRetroRouterDeps {
  readRows?: () => Promise<unknown[]>;
  readSeen?: () => Promise<Record<string, RetroSeenEntry>>;
  now?: () => number;
}

export interface ReviewRetroSnapshot extends ExtractReviewFindingArmsResult {
  due: boolean;
  candidates: ReviewRetroCandidate[];
}

export async function computeReviewRetro(deps: ReviewRetroRouterDeps = {}): Promise<ReviewRetroSnapshot> {
  const now = (deps.now ?? Date.now)();
  const readRows = deps.readRows ?? (async () => (await readReviewFindingRows()).map((r) => r.row));
  const rows = await readRows();
  const seen = await (deps.readSeen ?? getRetroSeen)();
  const extracted = extractReviewFindingArms(rows, { now });
  const { due, candidates } = deriveReviewRetroDue(extracted.arms, seen, now);
  return { due, candidates, ...extracted };
}

export function createReviewRetroRouter(deps: ReviewRetroRouterDeps = {}) {
  const router = Router();
  router.get("/qa/review-retro", (_req, res) =>
    isolateAggregator(res, "qa/review-retro", () => computeReviewRetro(deps)),
  );
  return router;
}
