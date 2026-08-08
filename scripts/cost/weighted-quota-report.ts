#!/usr/bin/env -S npx tsx
/**
 * scripts/cost/weighted-quota-report.ts — ranked weekly-quota culprit report
 * (issue #3825).
 *
 * Answers "what is burning the weekly subscription quota?" by ranking every
 * consumer (dispatch-kind AND skill) by WEIGHTED quota burn over the
 * since-reset window, with cache-write broken out as its own column. The
 * pre-#3825 ranking surfaces all ranked by RAW token count, and raw token count
 * is not proportional to quota cost: cache reads are 85% of volume but ~25% of
 * cost, while cache writes are 14% of volume but 57–68% of cost. Ranking by raw
 * tokens put the cheapest category in charge of the ordering, so the culprit
 * lists were — in practice — ranked by cache-read volume.
 *
 * The data was already collected correctly (`bySkillByModel` /
 * `byDispatchKind` carry all four categories per family); the defect was the
 * fold. This script applies the list-price category weights (cache read 0.1x /
 * cache write 1.25x 5m-TTL / output 5.0x / input 1.0x) and family weights
 * (opus 5 / sonnet 3 / haiku 1 by per-MTok input price) via the SAME
 * `weightedQuotaBurnByCategory` fold the live `weightedQuotaBurn` uses (one
 * weighting definition, per CONTEXT.md), so the ranking reflects real burn.
 *
 * Output contract (issue #3825 acceptance criteria):
 *   1. Ranked report over the since-reset window, ordered by weighted burn,
 *      cache-write visible as its own term. (AC1)
 *   2. Ranked shares + an explicit `interactive` unattributed residual sum to
 *      the real measured weighted burn (the denominator is the FULL total, so
 *      the shares are honest, never a partial slice). (AC2 / ask #5)
 *   3. Validation: the weighted total normalised against the configured weekly
 *      quota is compared to the meter's `percentLast7d`, stated with numbers,
 *      over ≥3 weighted samples spanning the window. If it does not track, the
 *      report SAYS SO and the weights are NOT presented as calibrated. (AC3)
 *   4. A written statement of which weights were used, where they came from,
 *      and that they are a list-price proxy for an opaque meter. (AC4)
 *
 * IMPORTANT CAVEAT (AC3 / the issue's "caveat on the weights"): the OAuth meter
 * is OPAQUE about its unit — `/api/oauth/usage` returns `utilization` only, with
 * the dollar fields null. We CANNOT prove the weekly window meters tokens at API
 * list-price ratios. List price is the best available proxy and is what the
 * existing knobs were designed for, but it is a HYPOTHESIS, so the report
 * validates it against the meter and reports the correlation rather than
 * asserting it. Historical `percentLast7d` is NOT persisted today (the weekly
 * snapshot stores raw per-skill totals only), so the meter correlation is
 * asserted at the single current point; the ≥3 reconstructed samples span the
 * window on the WEIGHTED axis. See the validation section of the emitted report.
 *
 * The LIVE estimate/pacing fold (`weightedQuotaBurn` in `snapshot-assembly.ts`)
 * is deliberately UNCHANGED by this issue: it stays identity-by-default so a
 * deploy changes no gating behaviour until the operator calibrates. The
 * list-price weights live in their OWN `HYDRA_USAGE_BURN_WEIGHT_*` /
 * `HYDRA_USAGE_BURN_FAMILY_*` namespace (see `src/cost/config.ts`) so the
 * report's calibration never leaks into the live gate.
 *
 * Usage:
 *   npx tsx scripts/cost/weighted-quota-report.ts            # text report
 *   npx tsx scripts/cost/weighted-quota-report.ts --json     # machine-readable
 *   npx tsx scripts/cost/weighted-quota-report.ts --root /path/to/projects
 *   npx tsx scripts/cost/weighted-quota-report.ts --samples 6 --tolerance 2
 *
 * Pure ranking/validation/formatting helpers are EXPORTED (and unit-tested in
 * test/weighted-quota-report.test.mts); the filesystem + OAuth I/O lives in the
 * `main()` entry point below.
 */

import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
// Cost barrel (issue #3825 public surface): the ranked report's weight readers
// + the general four-category fold + the weighted-token unit. Imported through
// the barrel so the report consumes the SAME weighting definition as the live
// fold (CONTEXT.md single-definition-of-Quota-Weight), not a re-derived formula.
import {
  weightedQuotaBurnByCategory,
  weightedTokens,
  getBurnCategoryWeights,
  getBurnFamilyWeights,
  getWeeklyResetAnchorMs,
  getWeeklyQuotaTokens,
} from "../../src/cost/index.ts";
// Pure math leaf (token-math.ts): the parser, family classifier, foreign-
// provider guard, reset-window projection, and the shared family primitives.
// These are NOT on the cost barrel (only `weightedTokens` + `weightedQuotaBurn*`
// are), so the report imports them from the canonical leaf directly — the same
// deep import `test/usage-tracker.test.mts` and `transcript-scan.ts` use.
import {
  parseUsageLine,
  parseObservedResetMs,
  projectResetWindow,
  modelToFamily,
  isForeignProviderModel,
  MODEL_FAMILIES,
  familyWeight,
} from "../../src/cost/token-math.ts";
import type { TokenBreakdown, ModelFamily, CategoryWeights } from "../../src/cost/token-math.ts";
// Token-breakdown data-model leaf (token-breakdown.ts): the skill / dispatch-
// kind classifiers + accumulator primitives. Imported from the canonical owner
// (per the transcript-scan.ts note: "new code should import directly from
// [token-breakdown.ts]") so the report's attribution matches the live
// `bySkillByModel` / `byDispatchKind` cross-tabs EXACTLY (same precedence
// chain: sentinel → slash marker → interactive residual).
import {
  INTERACTIVE_SKILL,
  deriveSkill,
  deriveDispatchKind,
  EMPTY_BREAKDOWN,
  emptyByModel,
  emptyByDispatchKind,
  addBreakdown,
} from "../../src/cost/token-breakdown.ts";
import type { DispatchKind } from "../../src/cost/token-breakdown.ts";
// TranscriptScan seam: the first-user-message extractor + sessionId-from-path
// (attribution signal + memo key), reused verbatim so a session attributes to
// the same skill/kind here as in the live scan.
import { firstUserMessageText, sessionIdFromPath } from "../../src/cost/transcript-scan.ts";
// Transcript Store seam: the projects root + the JSONL file list (same walk the
// live scan uses, so the report sees the same files).
import { listTranscriptFiles, projectsRoot } from "../../src/transcript-store.ts";
// OAuth meter: the authoritative `percentLast7d` for the validation comparison.
import { readOAuthUsage, isOAuthUsageOk } from "../../src/cost/oauth-usage.ts";
import { logger } from "../../src/logger.ts";

const MS_PER_DAY = 86_400_000;
const WINDOW_7D_MS = 7 * MS_PER_DAY;
/** Default number of weighted samples spanning the window for the validation curve (AC3: ≥3). */
const DEFAULT_SAMPLE_COUNT = 4;
/** Default tracking tolerance: weighted% within [meter/tol, meter*tol] counts as "tracks". */
const DEFAULT_TOLERANCE = 2;

// ---------------------------------------------------------------------------
// PURE ranking / validation / formatting helpers (exported for unit test)
// ---------------------------------------------------------------------------

/** Per-family weighted contribution for one consumer row. */
export interface WeightedFamilyRow {
  family: ModelFamily;
  weighted: number;
  rawTotal: number;
  breakdown: TokenBreakdown;
}

/** One ranked consumer (dispatch-kind or skill) in the report. */
export interface ConsumerRow {
  consumer: string;
  /** Weighted quota burn (Σ_family familyWeight × weightedTokens), the sort key. */
  weighted: number;
  /** Raw token total (Σ_family .total), shown alongside so the weighting's effect is visible. */
  rawTotal: number;
  /** This consumer's weighted burn as a % of the FULL total weighted burn. */
  sharePct: number;
  /** This consumer's raw tokens as a % of the FULL total raw tokens. */
  rawSharePct: number;
  /** Category totals summed across families (cacheCreation IS the cache-write column). */
  categories: TokenBreakdown;
  families: WeightedFamilyRow[];
  /** True for the `interactive` residual (the unattributed bucket, ask #5). */
  isResidual: boolean;
}

/** A ranked-consumer table plus its honest totals (the share denominator). */
export interface RankResult {
  rows: ConsumerRow[];
  totalWeighted: number;
  totalRaw: number;
}

/**
 * Rank consumers by weighted quota burn. The denominator for every share is the
 * FULL total weighted burn (every consumer, INCLUDING the `interactive`
 * residual), so the ranked shares plus the explicit residual sum to 100% of the
 * real measured burn — never a partial slice (AC2 / ask #5). Pure: takes the
 * cross-tab + the two weighting axes, returns the sorted rows + totals.
 */
export function rankConsumers(
  byConsumer: Record<string, Record<ModelFamily, TokenBreakdown>>,
  category: CategoryWeights,
  familyWeights: { opus: number; sonnet: number; haiku: number },
  residualConsumer: string,
): RankResult {
  const consumers = Object.keys(byConsumer);
  let totalWeighted = 0;
  let totalRaw = 0;
  const rows: ConsumerRow[] = consumers.map((consumer) => {
    const fam = byConsumer[consumer] ?? emptyByModel();
    const families: WeightedFamilyRow[] = MODEL_FAMILIES.map((f) => {
      const b = fam[f] ?? EMPTY_BREAKDOWN;
      return {
        family: f,
        breakdown: b,
        rawTotal: b.total,
        weighted: familyWeight(f, familyWeights) * weightedTokens(b, category),
      };
    });
    const weighted = families.reduce((s, r) => s + r.weighted, 0);
    const rawTotal = families.reduce((s, r) => s + r.rawTotal, 0);
    const categories: TokenBreakdown = { ...EMPTY_BREAKDOWN };
    for (const r of families) addBreakdown(categories, r.breakdown);
    totalWeighted += weighted;
    totalRaw += rawTotal;
    return {
      consumer,
      weighted,
      rawTotal,
      sharePct: 0,
      rawSharePct: 0,
      categories,
      families,
      isResidual: consumer === residualConsumer,
    };
  });
  for (const r of rows) {
    r.sharePct = totalWeighted > 0 ? (r.weighted / totalWeighted) * 100 : 0;
    r.rawSharePct = totalRaw > 0 ? (r.rawTotal / totalRaw) * 100 : 0;
  }
  // Descending by weighted burn; the residual sinks to its earned rank (NOT
  // pinned last) so the ranking is honest — if `interactive` is the #1 burner,
  // the report says so. It stays flagged isResidual for labelling.
  rows.sort((a, b) => b.weighted - a.weighted);
  return { rows, totalWeighted, totalRaw };
}

/** One point on the reconstructed weighted-burn-since-reset curve (validation). */
export interface CurveSample {
  atMs: number;
  weightedBurn: number;
  /** weightedBurn / weeklyQuota × 100, or null when the quota is unconfigured. */
  percentOfQuota: number | null;
}

/**
 * `count` timestamps spanning `[boundaryMs, nowMs]` at even fractions
 * (1/count, 2/count, …, 1.0). The last sample is exactly `nowMs`. Returns just
 * `[nowMs]` when the span is non-positive. Pure.
 */
export function sampleTimestamps(boundaryMs: number, nowMs: number, count = DEFAULT_SAMPLE_COUNT): number[] {
  const n = Math.max(1, Math.floor(count));
  const span = nowMs - boundaryMs;
  if (span <= 0) return [nowMs];
  const out: number[] = [];
  for (let k = 1; k <= n; k++) out.push(boundaryMs + Math.round((span * k) / n));
  return out;
}

/**
 * Reconstruct the weighted-burn-since-reset curve at each sample timestamp. For
 * each sample `t`, accumulates every entry with `tsMs <= t` into a per-family
 * table and folds it through {@link weightedQuotaBurnByCategory}. Sweeps the
 * entries once in ascending time order, so this is O(entries + samples) after
 * the sort. Pure. (AC3 — the ≥3 weighted samples spanning the window.)
 */
export function computeWeightedCurve(
  entries: readonly { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[],
  sampleAtMs: readonly number[],
  category: CategoryWeights,
  familyWeights: { opus: number; sonnet: number; haiku: number },
  weeklyQuota: number,
): CurveSample[] {
  const sorted = [...entries].sort((a, b) => a.tsMs - b.tsMs);
  const samples = [...sampleAtMs].sort((a, b) => a - b);
  const acc = emptyByModel();
  const out: CurveSample[] = [];
  let i = 0;
  for (const at of samples) {
    while (i < sorted.length && sorted[i].tsMs <= at) {
      addBreakdown(acc[sorted[i].family], sorted[i].tokens);
      i++;
    }
    const weightedBurn = weightedQuotaBurnByCategory(acc, category, familyWeights);
    out.push({
      atMs: at,
      weightedBurn,
      percentOfQuota: weeklyQuota > 0 ? (weightedBurn / weeklyQuota) * 100 : null,
    });
  }
  return out;
}

/** The validation verdict comparing the weighted total to the meter. */
export interface ValidationResult {
  boundaryMs: number | null;
  /** How the window was derived: `since-reset` (anchor set), `rolling-7d` (anchor unset, degraded), or `none`. */
  windowMode: "since-reset" | "rolling-7d" | "none";
  weeklyQuota: number;
  quotaConfigured: boolean;
  /** The meter's live `percentLast7d` (sevenDay.utilization), or null if unavailable. */
  meterPercent: number | null;
  meterAvailable: boolean;
  /** The weighted-since-reset total as a % of the weekly quota, or null if the quota is unconfigured. */
  weightedPercentNow: number | null;
  /** weightedPercentNow / meterPercent (>1 = weights run hot, <1 = run cool), or null if either is missing. */
  ratio: number | null;
  /** Within `tolerance` of the meter in BOTH directions? null when undecided (quota/meter missing). */
  tracks: boolean | null;
  tolerance: number;
  samples: CurveSample[];
  note: string;
}

/**
 * Decide whether the weighted % tracks the meter % within `tolerance` in both
 * directions (ratio in `[1/tolerance, tolerance]`). Returns `null` verdicts when
 * either input is missing — the report then states it cannot validate rather
 * than asserting a pass. Pure.
 */
export function decideTracking(
  weightedPct: number | null,
  meterPct: number | null,
  tolerance: number,
): { ratio: number | null; tracks: boolean | null } {
  if (weightedPct === null || meterPct === null || meterPct <= 0 || !Number.isFinite(tolerance) || tolerance <= 0) {
    return { ratio: null, tracks: null };
  }
  const ratio = weightedPct / meterPct;
  return { ratio, tracks: ratio >= 1 / tolerance && ratio <= tolerance };
}

/**
 * Build the structured report from the per-consumer cross-tabs + validation
 * inputs. Pure: every I/O result (cross-tabs, meter read) enters as an argument,
 * so the formatting + the validation verdict are unit-testable without a
 * filesystem or network. (AC1, AC2, AC3, AC4 — the data the text/JSON emitters
 * render.)
 */
export function buildReport(input: {
  generatedAt: string;
  nowMs: number;
  boundaryMs: number | null;
  windowMode: "since-reset" | "rolling-7d" | "none";
  category: CategoryWeights;
  familyWeights: { opus: number; sonnet: number; haiku: number };
  weeklyQuota: number;
  byDispatchKind: Record<DispatchKind, Record<ModelFamily, TokenBreakdown>>;
  bySkill: Record<string, Record<ModelFamily, TokenBreakdown>>;
  curveEntries: readonly { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[];
  meterPercent: number | null;
  sampleCount: number;
  tolerance: number;
  excluded: { foreignTokens: number; unknownFamilyTokens: number };
}): {
  generatedAt: string;
  nowMs: number;
  boundaryMs: number | null;
  boundaryIso: string | null;
  windowMode: "since-reset" | "rolling-7d" | "none";
  category: CategoryWeights;
  familyWeights: { opus: number; sonnet: number; haiku: number };
  weeklyQuota: number;
  byDispatchKind: RankResult;
  bySkill: RankResult;
  totals: { weightedBurn: number; rawTokens: number; weightedPercentOfQuota: number | null };
  meter: { percentLast7d: number | null; available: boolean };
  excluded: { foreignTokens: number; unknownFamilyTokens: number };
  validation: ValidationResult;
} {
  const {
    generatedAt,
    nowMs,
    boundaryMs,
    windowMode,
    category,
    familyWeights,
    weeklyQuota,
    byDispatchKind,
    bySkill,
    curveEntries,
    meterPercent,
    sampleCount,
    tolerance,
    excluded,
  } = input;

  const byDispatchKindRank = rankConsumers(byDispatchKind, category, familyWeights, "interactive");
  const bySkillRank = rankConsumers(bySkill, category, familyWeights, INTERACTIVE_SKILL);
  // The headline total rides on the dispatch-kind partition (it covers every
  // token exactly once: Σ_kind === byModel). The skill partition sums to the
  // same total (it is a second partition over the same tokens).
  const totalWeighted = byDispatchKindRank.totalWeighted;
  const totalRaw = byDispatchKindRank.totalRaw;

  const samples =
    boundaryMs !== null
      ? computeWeightedCurve(
          curveEntries,
          sampleTimestamps(boundaryMs, nowMs, sampleCount),
          category,
          familyWeights,
          weeklyQuota,
        )
      : [];
  const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
  const weightedPercentNow =
    weeklyQuota > 0 && lastSample !== null && lastSample.percentOfQuota !== null
      ? lastSample.percentOfQuota
      : null;
  const { ratio, tracks } = decideTracking(weightedPercentNow, meterPercent, tolerance);

  const quotaConfigured = weeklyQuota > 0;
  let note: string;
  if (windowMode !== "since-reset") {
    note =
      "Weekly Reset Anchor (HYDRA_USAGE_WEEKLY_RESET_ANCHOR) is unset: the window is rolling-7d, NOT the meter's fixed since-reset boundary, " +
      "so it CANNOT line up with percentLast7d and the meter comparison is withheld. Set the anchor to validate (issue #3825 AC4).";
  } else if (!quotaConfigured) {
    note =
      "HYDRA_USAGE_WEEKLY_QUOTA_TOKENS is unset: the weighted total cannot be normalised to a %, so it cannot be compared to the meter. " +
      "Configure the weekly quota to validate (issue #3825 AC3).";
  } else if (meterPercent === null) {
    note =
      "The OAuth meter was unavailable (no credentials / network / parse failure): the weighted % is reported but the meter comparison is withheld. " +
      "Re-run with the meter reachable to validate (issue #3825 AC3).";
  } else if (tracks === null) {
    note = "Tracking verdict undecided (zero/negative meter percent).";
  } else if (tracks) {
    note = `The weighted total tracks the meter within ${tolerance}x in both directions — the list-price weights are CONSISTENT with the meter at this point.`;
  } else {
    note =
      `The weighted total does NOT track the meter within ${tolerance}x — the list-price weights are NOT presented as calibrated. ` +
      `Re-derive the category/family weights from a fresh meter reading, or widen --tolerance only if the gap is understood (issue #3825 AC3).`;
  }

  const validation: ValidationResult = {
    boundaryMs,
    windowMode,
    weeklyQuota,
    quotaConfigured,
    meterPercent,
    meterAvailable: meterPercent !== null,
    weightedPercentNow,
    ratio,
    tracks,
    tolerance,
    samples,
    note,
  };

  return {
    generatedAt,
    nowMs,
    boundaryMs,
    boundaryIso: boundaryMs !== null ? new Date(boundaryMs).toISOString() : null,
    windowMode,
    category,
    familyWeights,
    weeklyQuota,
    byDispatchKind: byDispatchKindRank,
    bySkill: bySkillRank,
    totals: {
      weightedBurn: totalWeighted,
      rawTokens: totalRaw,
      weightedPercentOfQuota: weightedPercentNow,
    },
    meter: { percentLast7d: meterPercent, available: meterPercent !== null },
    excluded,
    validation,
  };
}

// ---------------------------------------------------------------------------
// Text + JSON emitters
// ---------------------------------------------------------------------------

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function fmtNum(n: number, dp = 1): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtPct(n: number): string {
  return n.toFixed(2);
}
function pad(s: string, width: number, align: "left" | "right" = "right"): string {
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}

/** Render a ranked-consumer table with the cache-write column visible (AC1). */
function renderRankTable(title: string, rank: RankResult): string[] {
  const lines: string[] = [];
  lines.push(`== ${title} (ranked by weighted burn) ==`);
  if (rank.rows.length === 0) {
    lines.push("  (no in-window tokens)");
    return lines;
  }
  const header =
    pad("rank", 4) +
    pad("consumer", 26, "left") +
    pad("weighted", 16) +
    pad("share%", 8) +
    pad("rawShare%", 9) +
    pad("input", 14) +
    pad("output", 14) +
    pad("cacheRead", 16) +
    pad("cacheWrite", 16) +
    pad("rawTotal", 16);
  lines.push("  " + header);
  rank.rows.forEach((r, idx) => {
    const label = (r.isResidual ? `${r.consumer} (residual)` : r.consumer).slice(0, 26);
    const row =
      pad(String(idx + 1), 4) +
      pad(label, 26, "left") +
      pad(fmtInt(r.weighted), 16) +
      pad(fmtPct(r.sharePct), 8) +
      pad(fmtPct(r.rawSharePct), 9) +
      pad(fmtInt(r.categories.input), 14) +
      pad(fmtInt(r.categories.output), 14) +
      pad(fmtInt(r.categories.cacheRead), 16) +
      pad(fmtInt(r.categories.cacheCreation), 16) +
      pad(fmtInt(r.rawTotal), 16);
    lines.push("  " + row);
  });
  lines.push(
    `  ${pad("TOTAL", 30, "left")}${pad(fmtInt(rank.totalWeighted), 16)}${pad("100.00", 8)}${pad("", 9)}` +
      `${pad("", 14)}${pad("", 14)}${pad("", 16)}${pad("", 16)}${pad(fmtInt(rank.totalRaw), 16)}`,
  );
  return lines;
}

/** Render the validation section with numbers + the calibration caveat (AC3/AC4). */
function renderValidation(v: ValidationResult, category: CategoryWeights, familyWeights: { opus: number; sonnet: number; haiku: number }): string[] {
  const lines: string[] = [];
  lines.push("== Validation (weighted total vs meter percentLast7d) ==");
  lines.push(`  weights used: input×${fmtNum(category.input, 2)} output×${fmtNum(category.output, 2)} cacheRead×${fmtNum(category.cacheRead, 2)} cacheWrite×${fmtNum(category.cacheCreation, 2)} | family opus×${fmtNum(familyWeights.opus, 2)} sonnet×${fmtNum(familyWeights.sonnet, 2)} haiku×${fmtNum(familyWeights.haiku, 2)}`);
  lines.push("  these are a LIST-PRICE PROXY for an OAuth meter whose unit is opaque (the dollar fields are null) — a hypothesis, not an assumption.");
  lines.push(`  window: ${v.windowMode}; boundary: ${v.boundaryMs !== null ? new Date(v.boundaryMs).toISOString() : "n/a"}`);
  lines.push(`  weekly quota: ${v.quotaConfigured ? fmtInt(v.weeklyQuota) + " tokens" : "UNCONFIGURED (HYDRA_USAGE_WEEKLY_QUOTA_TOKENS unset)"}`);
  lines.push(`  weighted % of quota (now): ${v.weightedPercentNow !== null ? fmtPct(v.weightedPercentNow) + "%" : "n/a"}`);
  lines.push(`  meter percentLast7d:       ${v.meterPercent !== null ? fmtPct(v.meterPercent) + "%" : "unavailable"}`);
  lines.push(`  ratio (weighted / meter):  ${v.ratio !== null ? fmtNum(v.ratio, 3) + "x  (tolerance " + v.tolerance + "x)" : "n/a"}`);
  const verdict =
    v.tracks === null ? "UNDECIDED (quota or meter missing)" : v.tracks ? "TRACKS (weights consistent with meter)" : "DOES NOT TRACK (weights NOT calibrated)";
  lines.push(`  verdict: ${verdict}`);
  if (v.samples.length > 0) {
    lines.push("  weighted curve (≥3 samples spanning the window):");
    for (const s of v.samples) {
      lines.push(`    ${new Date(s.atMs).toISOString()}  weighted=${fmtInt(s.weightedBurn)}  ${s.percentOfQuota !== null ? fmtPct(s.percentOfQuota) + "% of quota" : "(quota unset)"}`);
    }
    lines.push("  NOTE: historical percentLast7d is not persisted (the weekly snapshot stores raw per-skill totals only); the meter correlation is the single current point above, the ≥3 samples span the window on the WEIGHTED axis. Re-run across the window (or persist meter history) for a multi-point meter correlation.");
  }
  lines.push(`  ${v.note}`);
  return lines;
}

/**
 * Render the full text report. Pure over the structured report object. Exported
 * so the formatter is unit-testable.
 */
export function renderTextReport(r: ReturnType<typeof buildReport>): string {
  const lines: string[] = [];
  lines.push(`Weighted Quota Burn Report — generated ${r.generatedAt}`);
  lines.push(`Window: ${r.windowMode} from ${r.boundaryIso ?? "n/a"} to ${new Date(r.nowMs).toISOString()}`);
  lines.push("");
  lines.push(`Total measured weighted burn: ${fmtInt(r.totals.weightedBurn)}   (raw tokens: ${fmtInt(r.totals.rawTokens)})`);
  lines.push(`Weighted % of weekly quota: ${r.totals.weightedPercentOfQuota !== null ? fmtPct(r.totals.weightedPercentOfQuota) + "%" : "n/a (quota unset)"}   |   meter percentLast7d: ${r.meter.available ? fmtPct(r.meter.percentLast7d!) + "%" : "unavailable"}`);
  lines.push("");
  lines.push(...renderRankTable("By dispatch kind", r.byDispatchKind));
  lines.push("");
  lines.push(...renderRankTable("By skill", r.bySkill));
  lines.push("");
  lines.push(...renderValidation(r.validation, r.category, r.familyWeights));
  lines.push("");
  lines.push("== Excluded / out-of-band ==");
  lines.push(`  foreign-provider tokens (separate quota, issue #3769): ${fmtInt(r.excluded.foreignTokens)}`);
  lines.push(`  unknown-family tokens (unrecognised model, implicit weight 1.0): ${fmtInt(r.excluded.unknownFamilyTokens)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Filesystem walk — the since-reset transcript scan (I/O)
// ---------------------------------------------------------------------------

interface SinceResetEntry {
  tsMs: number;
  tokens: TokenBreakdown;
  family: ModelFamily;
  skill: string;
  kind: DispatchKind;
}

interface SinceResetScan {
  entries: SinceResetEntry[];
  foreign: TokenBreakdown;
  mostRecentObservedResetMs: number | null;
  filesScanned: number;
  filesSkippedByMtime: number;
  parseErrors: number;
  unknownFamilyTokens: number;
}

/**
 * Walk the JSONL transcripts under `root` and buffer every in-window usage line
 * (with its resolved skill + dispatch-kind + family) for the since-reset window
 * starting at `envBoundaryMs`. Mirrors `transcriptScan` (same file walk, same
 * per-session skill/kind resolution via `firstUserMessageText`, same foreign-
 * provider exclusion) but buffers per-line entries instead of accumulating into
 * fixed cross-tabs — the effective boundary can move FORWARD mid-scan (an
 * observed reset more recent than the env projection), so accumulation happens
 * post-walk in `main()` once the boundary is known. Best-effort: never throws
 * (per-file read failures log + skip).
 */
async function scanSinceReset(root: string, envBoundaryMs: number): Promise<SinceResetScan> {
  const entries: SinceResetEntry[] = [];
  const foreign: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  let mostRecentObservedResetMs: number | null = null;
  let filesScanned = 0;
  let filesSkippedByMtime = 0;
  let parseErrors = 0;
  let unknownFamilyTokens = 0;

  const skillCache = new Map<string, string>();
  const kindCache = new Map<string, DispatchKind>();

  const files = await listTranscriptFiles(root);
  for (const file of files) {
    let st: Stats;
    try {
      st = await stat(file);
    } catch {
      /* intentional: file deleted/rotated between listing and stat — skip it */
      continue;
    }
    // If the file's last append predates the boundary, none of its lines can be
    // in-window. (envBoundaryMs is within the last 7d, so this also bounds the
    // walk to the weekly window.)
    if (st.mtimeMs < envBoundaryMs) {
      filesSkippedByMtime++;
      continue;
    }
    filesScanned++;

    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch (err: any) {
      logger.error({ file, err }, "[weighted-quota-report] transcript read failed");
      continue;
    }

    const lines = content.split("\n");
    // Resolve skill + dispatch-kind ONCE per session (memoised by sessionId) —
    // the same O(files) attribution the live scan uses.
    const sessionId = sessionIdFromPath(file);
    let skill = skillCache.get(sessionId);
    let kind = kindCache.get(sessionId);
    if (skill === undefined || kind === undefined) {
      const firstText = firstUserMessageText(lines);
      skill = deriveSkill(firstText);
      kind = deriveDispatchKind(firstText);
      skillCache.set(sessionId, skill);
      kindCache.set(sessionId, kind);
    }

    for (const line of lines) {
      if (!line || line[0] !== "{") continue;
      // Observed rate-limit reset — probed on every JSON line (the boundary can
      // move forward), exactly like the live scan.
      const observed = parseObservedResetMs(line);
      if (observed !== null && (mostRecentObservedResetMs === null || observed > mostRecentObservedResetMs)) {
        mostRecentObservedResetMs = observed;
      }

      const parsed = parseUsageLine(line);
      if (parsed === null) {
        parseErrors++;
        continue;
      }
      if (parsed === "skip") continue;
      if (parsed.tsMs < envBoundaryMs) continue;

      // Foreign-provider tokens (issue #3769) are on a SEPARATE quota — exclude
      // them from the Anthropic ranking, count them on their own axis.
      if (isForeignProviderModel(parsed.model)) {
        addBreakdown(foreign, parsed.tokens);
        continue;
      }

      const family = modelToFamily(parsed.model);
      if (family === "unknown") unknownFamilyTokens += parsed.tokens.total;
      entries.push({ tsMs: parsed.tsMs, tokens: parsed.tokens, family, skill: skill!, kind: kind! });
    }
  }

  return { entries, foreign, mostRecentObservedResetMs, filesScanned, filesSkippedByMtime, parseErrors, unknownFamilyTokens };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

interface CliOpts {
  json: boolean;
  root: string | null;
  sampleCount: number;
  tolerance: number;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { json: false, root: null, sampleCount: DEFAULT_SAMPLE_COUNT, tolerance: DEFAULT_TOLERANCE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--root") opts.root = argv[++i] ?? null;
    else if (a === "--samples") opts.sampleCount = Number(argv[++i]) || DEFAULT_SAMPLE_COUNT;
    else if (a === "--tolerance") opts.tolerance = Number(argv[++i]) || DEFAULT_TOLERANCE;
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "usage: npx tsx scripts/cost/weighted-quota-report.ts [--json] [--root DIR] [--samples N] [--tolerance X]\n",
      );
      process.exit(0);
    }
  }
  return opts;
}

async function readMeterPercent(): Promise<number | null> {
  try {
    const result = await readOAuthUsage();
    if (isOAuthUsageOk(result)) return result.data.sevenDay.utilization;
    return null;
  } catch (err: any) {
    logger.error({ err }, "[weighted-quota-report] OAuth meter read failed; validation will withhold the meter comparison");
    return null;
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  const nowMs = now.getTime();

  const category = getBurnCategoryWeights();
  const familyWeights = getBurnFamilyWeights();
  const weeklyQuota = getWeeklyQuotaTokens();
  const anchorEnvMs = getWeeklyResetAnchorMs();

  // Window: since-reset when the anchor is set (AC4); degrade to rolling-7d
  // with a loud note when it is not (the meter comparison is then withheld).
  let windowMode: "since-reset" | "rolling-7d" | "none" = "since-reset";
  let envBoundaryMs: number;
  if (anchorEnvMs !== null) {
    envBoundaryMs = projectResetWindow(anchorEnvMs, nowMs).currentMs;
  } else {
    windowMode = "rolling-7d";
    envBoundaryMs = nowMs - WINDOW_7D_MS;
  }

  const root = opts.root ?? projectsRoot();
  const scan = await scanSinceReset(root, envBoundaryMs);

  // Resolve the effective boundary: an observed reset more recent than the env
  // projection (and not in the future) overrides it — mirroring the live
  // `deriveSinceReset` auto-correct so the report's window matches `percentSinceReset`.
  let effectiveBoundaryMs = envBoundaryMs;
  if (
    scan.mostRecentObservedResetMs !== null &&
    scan.mostRecentObservedResetMs > effectiveBoundaryMs &&
    scan.mostRecentObservedResetMs <= nowMs
  ) {
    effectiveBoundaryMs = scan.mostRecentObservedResetMs;
  }
  const boundaryMs = windowMode === "since-reset" ? effectiveBoundaryMs : envBoundaryMs;

  // Post-walk accumulation into the per-consumer cross-tabs (only entries inside
  // the EFFECTIVE window). Per-skill + per-dispatch-kind are two partitions over
  // the same tokens, matching the live cross-tabs.
  const bySkill: Record<string, Record<ModelFamily, TokenBreakdown>> = {};
  const byDispatchKind = emptyByDispatchKind();
  const curveEntries: { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[] = [];
  for (const e of scan.entries) {
    if (e.tsMs < effectiveBoundaryMs) continue;
    const skillRow = (bySkill[e.skill] ??= emptyByModel());
    addBreakdown(skillRow[e.family], e.tokens);
    addBreakdown(byDispatchKind[e.kind][e.family], e.tokens);
    curveEntries.push({ tsMs: e.tsMs, tokens: e.tokens, family: e.family });
  }

  const meterPercent = windowMode === "since-reset" ? await readMeterPercent() : null;

  const report = buildReport({
    generatedAt: now.toISOString(),
    nowMs,
    boundaryMs,
    windowMode,
    category,
    familyWeights,
    weeklyQuota,
    byDispatchKind,
    bySkill,
    curveEntries,
    meterPercent,
    sampleCount: opts.sampleCount,
    tolerance: opts.tolerance,
    excluded: { foreignTokens: scan.foreign.total, unknownFamilyTokens: scan.unknownFamilyTokens },
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderTextReport(report) + "\n");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
