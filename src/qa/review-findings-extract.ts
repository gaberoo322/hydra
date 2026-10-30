/**
 * Review-findings row model, comment parser, reconcile merge and zero-token
 * arm extractor (issue #5270, R1; ADR-0046 Decision 8). Everything here is
 * pure and never throws; the Redis seam is `src/redis/review-findings.ts` and
 * the GitHub harvest is `scripts/qa/review-findings-reconcile.ts`.
 *
 * Idempotency is by construction: `reviewFindingRowId` is the ONE id function,
 * used by both the route-time feeder (`rowsFromFold`) and the reconcile
 * harvester (`parseReviewFindingsComment`), so the same verdict comment yields
 * byte-identical ids whichever feeder saw it first.
 *
 * Location normalisation and the trailer grammar are imported
 * (`canonicalLocationKey`, `parseQaVerdictTrailers`), never re-implemented.
 * Nothing here changes a verdict.
 */

import { createHash } from "node:crypto";
import type {
  FindingRow,
  ReviewFindingRow,
  ReviewFindingSeverity,
  ReviewFindingSource,
  StoredReviewFindingRow,
} from "../redis/review-findings.ts";
import { canonicalLocationKey, QA_FINDINGS_HEADING, type FoldedFinding } from "./fold.ts";
import { parseQaVerdictTrailers } from "./verdict-trailer.ts";

export const FOLLOW_UPS_HEADING = "### Follow-ups (non-blocking)";
export const DEFAULT_WINDOW_DAYS = 30;
export const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const STD_RULE_RE = /STD-[A-Z0-9]+(?:-[A-Z0-9]+)*/;

function oneLine(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** The first `STD-*` stable rule ID in a finding's text, or null. */
export function extractRule(finding: string): string | null {
  const m = STD_RULE_RE.exec(finding);
  return m ? m[0] : null;
}

/** The path half of `canonicalLocationKey(location)`; null for placeholders. */
export function fileOfLocation(location: string): string | null {
  const key = canonicalLocationKey(location);
  return key === null ? null : key.replace(/:\d+$/, "");
}

function hash12(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * The deterministic row id (the Redis hash field):
 * kind + pr + round + canonical location + rule + sha256(finding text)[0..12].
 */
export function reviewFindingRowId(row: ReviewFindingRow): string {
  let location: string | null = null;
  let rule: string | null = null;
  let text: string;
  if (row.kind === "finding") {
    location = canonicalLocationKey(row.location);
    rule = row.rule;
    text = row.finding;
  } else if (row.kind === "pair-miss") {
    text = `${row.severity}:${row.note ?? ""}`;
  } else {
    text = `${row.gapClass}:${row.note ?? ""}`;
  }
  const digest = hash12(oneLine(text).toLowerCase());
  return `${row.kind}:${row.pr}:${row.round}:${location ?? "none"}:${rule ?? "none"}:${digest}`;
}

/** Build a `finding` row; derives `file` and `rule` so no feeder can disagree. */
export function makeFindingRow(input: {
  pr: number;
  round: number;
  sha: string;
  at: string;
  source: ReviewFindingSource;
  severity: ReviewFindingSeverity;
  axis: "standards" | "spec";
  location: string;
  finding: string;
  reviewers: readonly string[];
}): FindingRow {
  const location = oneLine(input.location);
  const finding = oneLine(input.finding);
  return {
    kind: "finding",
    pr: input.pr,
    round: input.round,
    sha: input.sha,
    at: input.at,
    source: input.source,
    severity: input.severity,
    axis: input.axis,
    location,
    file: fileOfLocation(location),
    rule: extractRule(finding),
    finding,
    reviewers: [...input.reviewers],
  };
}

/**
 * The route-step call-site contract: map the fold's blocking findings and
 * follow-ups (every low is stored) to rows, attributed to the trailer's PR.
 */
export function rowsFromFold(
  fold: { blocking: readonly FoldedFinding[]; followUps: readonly FoldedFinding[] },
  trailer: { pr: number; round: number; sha: string },
  opts: { at: string; source?: ReviewFindingSource },
): StoredReviewFindingRow[] {
  const source = opts.source ?? "route";
  return [...fold.blocking, ...fold.followUps].map((f) => {
    const row = makeFindingRow({
      pr: trailer.pr,
      round: trailer.round,
      sha: trailer.sha,
      at: opts.at,
      source,
      severity: f.severity,
      axis: f.axis,
      location: f.location,
      finding: f.finding,
      reviewers: f.reviewers,
    });
    return { id: reviewFindingRowId(row), row };
  });
}

/** Split a markdown table line on unescaped pipes, unescaping `\|`. */
function splitTableCells(line: string): string[] {
  const cells = line.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * Parse one verdict comment (trailer + the `### Findings` and follow-up
 * tables) into `finding` rows. Rows are attributed ONLY to the trailer's
 * `pr=` (the #4729 rule); a body with no trailer yields none. `_No blocking
 * findings._` yields zero rows for that section. Never throws.
 */
export function parseReviewFindingsComment(
  body: string | null | undefined,
  opts: { at: string; source?: ReviewFindingSource },
): StoredReviewFindingRow[] {
  if (typeof body !== "string") return [];
  const trailer = parseQaVerdictTrailers(body)[0];
  if (!trailer) return [];
  const source = opts.source ?? "reconcile";
  const out: StoredReviewFindingRow[] = [];
  let inTable = false;
  for (const rawLine of body.split("\n")) {
    const trimmed = rawLine.replace(/\r$/, "").trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      inTable = trimmed === QA_FINDINGS_HEADING || trimmed === FOLLOW_UPS_HEADING;
      continue;
    }
    if (!inTable || !trimmed.startsWith("|")) continue;
    const cells = splitTableCells(trimmed);
    if (cells.length !== 6) continue;
    const [severity, axis, reviewers, location, finding] = cells as [string, string, string, string, string, string];
    if (severity !== "high" && severity !== "medium" && severity !== "low") continue;
    if (axis !== "standards" && axis !== "spec") continue;
    const row = makeFindingRow({
      pr: trailer.pr,
      round: trailer.round,
      sha: trailer.sha,
      at: opts.at,
      source,
      severity,
      axis,
      location,
      finding,
      reviewers: reviewers.split(",").map((r) => r.trim()).filter((r) => r !== ""),
    });
    out.push({ id: reviewFindingRowId(row), row });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconcile: a pure idempotent merge
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /** Harvested rows whose id is not yet stored (write these). */
  upserts: StoredReviewFindingRow[];
  /** Harvested rows already stored (route rows always win; same id = same row). */
  unchanged: number;
  /** Stored ids older than the retention window (HDEL these). */
  pruned: string[];
}

export function reconcileReviewFindings(
  existing: readonly StoredReviewFindingRow[],
  harvested: readonly StoredReviewFindingRow[],
  opts: { now: number; retentionDays?: number },
): ReconcileResult {
  const cutoff = opts.now - (opts.retentionDays ?? RETENTION_DAYS) * DAY_MS;
  const have = new Set(existing.map((e) => e.id));
  const seen = new Set<string>();
  const upserts: StoredReviewFindingRow[] = [];
  let unchanged = 0;
  for (const h of harvested) {
    if (have.has(h.id) || seen.has(h.id)) {
      unchanged++;
      continue;
    }
    seen.add(h.id);
    upserts.push(h);
  }
  const pruned = existing
    .filter((e) => {
      const at = Date.parse(e.row?.at);
      return Number.isFinite(at) && at < cutoff;
    })
    .map((e) => e.id);
  return { upserts, unchanged, pruned };
}

// ---------------------------------------------------------------------------
// Arms extractor
// ---------------------------------------------------------------------------

export type ReviewFindingArm =
  | { arm: "rule-cross-pr"; key: string; prs: number[] }
  | { arm: "file-cross-pr"; key: string; prs: number[] }
  | { arm: "rule-same-pr-rounds"; key: string; pr: number; rounds: number[] }
  | { arm: "file-same-pr-rounds"; key: string; pr: number; rounds: number[] }
  | { arm: "pair-miss"; prs: number[]; count: number }
  | { arm: "detector-gap"; key: string; prs: number[] };

export interface ReviewFindingHotSpot {
  file: string;
  count: number;
  rules: string[];
}

export interface ExtractReviewFindingArmsResult {
  arms: ReviewFindingArm[];
  hotSpots: ReviewFindingHotSpot[];
  warnings: string[];
}

function isValidRow(r: unknown): r is ReviewFindingRow {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  if (!Number.isInteger(o.pr) || !Number.isInteger(o.round)) return false;
  if (typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return false;
  const sev = o.severity === "high" || o.severity === "medium" || o.severity === "low";
  if (o.kind === "finding") {
    return (
      sev &&
      typeof o.finding === "string" &&
      (o.rule === null || typeof o.rule === "string") &&
      (o.file === null || typeof o.file === "string")
    );
  }
  if (o.kind === "pair-miss") return sev;
  if (o.kind === "detector-gap") return typeof o.gapClass === "string" && o.gapClass !== "";
  return false;
}

const sortedNums = (s: Iterable<number>): number[] => [...s].sort((a, b) => a - b);

function addTo<K, V>(m: Map<K, Set<V>>, k: K, v: V): void {
  const s = m.get(k);
  if (s) s.add(v);
  else m.set(k, new Set([v]));
}

type RoundsByPr = Map<string, Map<number, Set<number>>>;

function addRound(m: RoundsByPr, key: string, pr: number, round: number): void {
  let byPr = m.get(key);
  if (!byPr) m.set(key, (byPr = new Map()));
  addTo(byPr, pr, round);
}

/**
 * Fold rows into the retro arms. Cross-PR arms count DISTINCT PRs (30-day
 * window by `at`), the same-PR arms count DISTINCT rounds, the pair-miss arm
 * fires on any medium/high pair-miss row, the detector-gap arm on 2+ gaps
 * sharing a `gapClass` across distinct PRs. Malformed rows are skipped and
 * named in `warnings`.
 */
export function extractReviewFindingArms(
  rows: readonly unknown[],
  opts: { now: number; windowDays?: number },
): ExtractReviewFindingArmsResult {
  const cutoff = opts.now - (opts.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY_MS;
  const warnings: string[] = [];
  const ruleToPrs = new Map<string, Set<number>>();
  const fileToPrs = new Map<string, Set<number>>();
  const ruleRounds: RoundsByPr = new Map();
  const fileRounds: RoundsByPr = new Map();
  const pairMissPrs = new Set<number>();
  let pairMissCount = 0;
  const gapToPrs = new Map<string, Set<number>>();
  const lowDesign = new Map<string, { count: number; rules: Set<string> }>();

  rows.forEach((raw, i) => {
    if (!isValidRow(raw)) {
      warnings.push(`row ${i}: malformed, skipped`);
      return;
    }
    if (Date.parse(raw.at) < cutoff) return;
    if (raw.kind === "finding") {
      if (raw.rule) {
        addTo(ruleToPrs, raw.rule, raw.pr);
        addRound(ruleRounds, raw.rule, raw.pr, raw.round);
      }
      if (raw.file) {
        addTo(fileToPrs, raw.file, raw.pr);
        addRound(fileRounds, raw.file, raw.pr, raw.round);
        if (raw.severity === "low" && raw.rule?.startsWith("STD-DESIGN-")) {
          const hs = lowDesign.get(raw.file) ?? { count: 0, rules: new Set<string>() };
          hs.count++;
          hs.rules.add(raw.rule);
          lowDesign.set(raw.file, hs);
        }
      }
    } else if (raw.kind === "pair-miss") {
      if (raw.severity === "medium" || raw.severity === "high") {
        pairMissPrs.add(raw.pr);
        pairMissCount++;
      }
    } else {
      addTo(gapToPrs, raw.gapClass, raw.pr);
    }
  });

  const byKey = <T,>(m: Map<string, T>): Array<[string, T]> =>
    [...m].sort((a, b) => a[0].localeCompare(b[0]));
  const arms: ReviewFindingArm[] = [];
  for (const [key, prs] of byKey(ruleToPrs)) {
    if (prs.size >= 3) arms.push({ arm: "rule-cross-pr", key, prs: sortedNums(prs) });
  }
  for (const [key, prs] of byKey(fileToPrs)) {
    if (prs.size >= 3) arms.push({ arm: "file-cross-pr", key, prs: sortedNums(prs) });
  }
  const sameSides: Array<[RoundsByPr, "rule-same-pr-rounds" | "file-same-pr-rounds"]> = [
    [ruleRounds, "rule-same-pr-rounds"],
    [fileRounds, "file-same-pr-rounds"],
  ];
  for (const [m, arm] of sameSides) {
    for (const [key, byPr] of byKey(m)) {
      for (const [pr, rounds] of [...byPr].sort((a, b) => a[0] - b[0])) {
        if (rounds.size >= 3) arms.push({ arm, key, pr, rounds: sortedNums(rounds) });
      }
    }
  }
  if (pairMissCount > 0) arms.push({ arm: "pair-miss", prs: sortedNums(pairMissPrs), count: pairMissCount });
  for (const [key, prs] of byKey(gapToPrs)) {
    if (prs.size >= 2) arms.push({ arm: "detector-gap", key, prs: sortedNums(prs) });
  }
  const hotSpots: ReviewFindingHotSpot[] = byKey(lowDesign)
    .filter(([, v]) => v.count >= 3)
    .map(([file, v]) => ({ file, count: v.count, rules: [...v.rules].sort() }));
  return { arms, hotSpots, warnings };
}
