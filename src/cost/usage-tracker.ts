/**
 * Subscription Usage Tracker — reads Claude Code's JSONL session transcripts
 * to compute rolling-window token consumption.
 *
 * Same data source the `/usage` slash command uses inside the CLI; we read
 * it ourselves so the orchestrator can pace autopilot dispatches against
 * the weekly subscription quota. The Claude Code harness has no
 * programmatic usage-introspection surface (no `claude --usage`, no
 * documented state file, no SDK call), so the transcripts on disk are
 * the only available signal. Hydra already depends on the
 * `~/.claude/projects/<project>/*.jsonl` layout for the watchdog and the
 * lesson-capture hook, so reading them here adds no new fragility.
 *
 * Scope today: pure reader + calibration. No Redis writes. No event bus.
 * No dispatch decisions — the scheduler/autopilot integration that
 * actually consumes `emergencyStop` / `pacingState` lands in a follow-up
 * PR. PR A ships the Module + `/api/usage` so the operator can sanity-
 * check the numbers against `/usage` and calibrate the env vars before
 * any behaviour changes.
 *
 * Calibration env:
 *   - HYDRA_USAGE_WEEKLY_QUOTA_TOKENS  — operator's eyeballed weekly cap
 *   - HYDRA_USAGE_5H_QUOTA_TOKENS      — operator's eyeballed 5-hour cap
 * When either is unset/zero, `calibrated` is false, percentages are 0,
 * pacingState stays "under", and emergencyStop stays false. Raw token
 * counts are always reported.
 *
 * Quota-weight env (issue #691):
 *   - HYDRA_QUOTA_WEIGHT_OPUS    — per-token multiplier for the opus family
 *   - HYDRA_QUOTA_WEIGHT_SONNET  — per-token multiplier for the sonnet family
 *   - HYDRA_QUOTA_WEIGHT_HAIKU   — per-token multiplier for the haiku family
 * These convert raw per-family token counts into a comparable
 * **Quota Weight** burn unit (`opus*w_opus + sonnet*w_sonnet +
 * haiku*w_haiku`; see CONTEXT.md). All-or-nothing, mirroring the existing
 * percentage gate: `quotaWeightLast5h`/`quotaWeightLast7d` are exactly 0
 * unless ALL THREE weights are set to positive values. `byModel` is always
 * populated regardless. Deliberately NOT a dollar figure — under the Claude
 * Code subscription the orchestrator pays no per-call charge.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_5H_MS = 5 * MS_PER_HOUR;
const WINDOW_24H_MS = MS_PER_DAY;
const WINDOW_7D_MS = 7 * MS_PER_DAY;
const CACHE_TTL_MS = 60_000;

export interface TokenBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

/**
 * Model families recognised by the per-model rollup. `unknown` is the
 * catch-all for any model string that doesn't match a known prefix
 * (synthetic messages, future model names, GPT carry-overs). Its
 * Quota-Weight contribution uses an implicit weight of 1.0 — there is
 * deliberately no `HYDRA_QUOTA_WEIGHT_UNKNOWN` env var because the
 * CONTEXT.md Quota-Weight formula is opus/sonnet/haiku only; an unknown
 * bucket above zero signals the family table needs a new prefix, which the
 * once-per-scan `console.warn` surfaces.
 */
export type ModelFamily = "opus" | "sonnet" | "haiku" | "unknown";

const MODEL_FAMILIES: readonly ModelFamily[] = ["opus", "sonnet", "haiku", "unknown"];

export interface UsageSnapshot {
  tokensLast5h: TokenBreakdown;
  tokensLast7d: TokenBreakdown;
  /** Raw token total over the last 24h. Drives `projectedWeeklyPercent`. */
  tokensLast24h: number;
  /** % of 5h quota consumed; 0 when uncalibrated. */
  percentLast5h: number;
  /** % of weekly quota consumed; 0 when uncalibrated. */
  percentLast7d: number;
  /**
   * If we continued at the last-24h rate for a full 7 days, what % of
   * weekly quota would that be? 0 when uncalibrated.
   */
  projectedWeeklyPercent: number;
  /**
   * "over" when projectedWeeklyPercent > 100 (shed non-essential classes
   * in the autopilot integration that follows this PR). "on" at 80-100%
   * (informational; no action). "under" otherwise, including all
   * uncalibrated runs.
   */
  pacingState: "under" | "on" | "over";
  /**
   * True only when calibrated AND percentLast5h >= 90. Future PR wires
   * this to skip the autopilot tick entirely.
   */
  emergencyStop: boolean;
  /** True only when both quota env vars are set to positive values. */
  calibrated: boolean;
  /**
   * Per-model-family token breakdown over the 7d window. ALWAYS populated
   * with all four family keys (opus/sonnet/haiku/unknown), zero-valued when
   * a family produced no tokens — independent of calibration. (issue #691)
   */
  byModel: Record<ModelFamily, TokenBreakdown>;
  /**
   * Quota-Weight burn over the 5h window: `Σ family.total * weight(family)`
   * (opus/sonnet/haiku from env, unknown implicit 1.0). Exactly 0 unless ALL
   * THREE HYDRA_QUOTA_WEIGHT_* env vars are set to positive values, mirroring
   * the all-or-nothing percentage gate. (issue #691)
   */
  quotaWeightLast5h: number;
  /** Quota-Weight burn over the 7d window; same gate as `quotaWeightLast5h`. */
  quotaWeightLast7d: number;
  /** True only when all three HYDRA_QUOTA_WEIGHT_* env vars are positive. */
  quotaWeightCalibrated: boolean;
  weeklyQuotaTokens: number;
  fiveHourQuotaTokens: number;
  filesScanned: number;
  filesSkippedByMtime: number;
  linesParsed: number;
  linesWithUsage: number;
  parseErrors: number;
  /** ISO timestamp anchor used to compute the rolling windows. */
  generatedAt: string;
  /**
   * Cache-hit ratio over the 5h window, in the closed interval [0, 1].
   * Formula: cacheRead / (cacheRead + cacheCreation + input). Output
   * tokens are excluded (not cache-eligible); cacheCreation is in the
   * denominator on purpose so the ratio honestly accounts for the cost
   * of warming the cache. Returns 0 when the denominator is 0 (no
   * division by zero) — the same uncalibrated-returns-0 discipline the
   * rest of the tracker follows. Higher is better; a falling ratio means
   * the next window's tokens get more expensive.
   */
  cacheHitRatioLast5h: number;
  /** Cache-hit ratio over the 7d window. Same formula/invariants as `cacheHitRatioLast5h`. */
  cacheHitRatioLast7d: number;
}

const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

interface CacheEntry {
  snapshot: UsageSnapshot;
  storedAt: number;
}

let cache: CacheEntry | null = null;

export function getWeeklyQuotaTokens(): number {
  return parseQuotaEnv(process.env.HYDRA_USAGE_WEEKLY_QUOTA_TOKENS);
}

export function getFiveHourQuotaTokens(): number {
  return parseQuotaEnv(process.env.HYDRA_USAGE_5H_QUOTA_TOKENS);
}

function parseQuotaEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

export function getQuotaWeightOpus(): number {
  return parseQuotaEnv(process.env.HYDRA_QUOTA_WEIGHT_OPUS);
}

export function getQuotaWeightSonnet(): number {
  return parseQuotaEnv(process.env.HYDRA_QUOTA_WEIGHT_SONNET);
}

export function getQuotaWeightHaiku(): number {
  return parseQuotaEnv(process.env.HYDRA_QUOTA_WEIGHT_HAIKU);
}

/**
 * Classify a model string into a Quota-Weight family by prefix.
 *
 * Pure prefix matcher: `claude-opus*` → opus, `claude-sonnet*` → sonnet,
 * `claude-haiku*` → haiku, anything else → unknown. This is intentionally a
 * NEW classifier and NOT `modelToTier` from `attribution.ts` — that function
 * returns legacy tier labels (frontier/codex/mini) keyed on GPT model names
 * and would bucket every real `claude-opus-4-7` string into `unknown`. The
 * no-duplication intent is honoured by keeping this the ONE canonical family
 * classifier. (issue #691)
 */
export function modelToFamily(model: string | null | undefined): ModelFamily {
  const l = String(model ?? "").toLowerCase();
  if (l.startsWith("claude-opus")) return "opus";
  if (l.startsWith("claude-sonnet")) return "sonnet";
  if (l.startsWith("claude-haiku")) return "haiku";
  return "unknown";
}

/** Quota-Weight for a family. opus/sonnet/haiku from env; unknown is 1.0. */
function familyWeight(
  family: ModelFamily,
  weights: { opus: number; sonnet: number; haiku: number },
): number {
  switch (family) {
    case "opus":
      return weights.opus;
    case "sonnet":
      return weights.sonnet;
    case "haiku":
      return weights.haiku;
    case "unknown":
      // Implicit 1.0 — no HYDRA_QUOTA_WEIGHT_UNKNOWN env var exists; the
      // formula is three-family. Drift here is surfaced by the
      // once-per-scan console.warn, not absorbed by a tunable.
      return 1;
  }
}

function emptyByModel(): Record<ModelFamily, TokenBreakdown> {
  return {
    opus: { ...EMPTY_BREAKDOWN },
    sonnet: { ...EMPTY_BREAKDOWN },
    haiku: { ...EMPTY_BREAKDOWN },
    unknown: { ...EMPTY_BREAKDOWN },
  };
}

function getProjectsRoot(): string {
  return process.env.HYDRA_CLAUDE_PROJECTS_ROOT || join(homedir(), ".claude", "projects");
}

export function clearUsageCache(): void {
  cache = null;
}

/**
 * Returns a snapshot of token consumption over the 5h, 24h, and 7d
 * rolling windows by scanning Claude Code's JSONL transcripts.
 *
 * Memoized for 60s in-process. The autopilot tick, the dashboard
 * refresh, and the `/api/scheduler/status` endpoint may each call
 * `getUsage()` within the same breath; the cache bounds the cost.
 * Pass `force: true` to bypass; pass `projectsRoot` to point at a
 * fixture directory (bypasses cache automatically).
 */
export async function getUsage(opts: {
  now?: Date;
  force?: boolean;
  projectsRoot?: string;
} = {}): Promise<UsageSnapshot> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const overrideRoot = opts.projectsRoot !== undefined;
  if (!opts.force && !overrideRoot && cache) {
    if (nowMs - cache.storedAt < CACHE_TTL_MS) {
      return cache.snapshot;
    }
  }

  const root = opts.projectsRoot ?? getProjectsRoot();
  const snapshot = await scanUsage(root, now);

  if (!overrideRoot) {
    cache = { snapshot, storedAt: nowMs };
  }
  return snapshot;
}

async function scanUsage(root: string, now: Date): Promise<UsageSnapshot> {
  const nowMs = now.getTime();
  const cutoff7d = nowMs - WINDOW_7D_MS;
  const cutoff24h = nowMs - WINDOW_24H_MS;
  const cutoff5h = nowMs - WINDOW_5H_MS;

  const weeklyQuota = getWeeklyQuotaTokens();
  const fiveHourQuota = getFiveHourQuotaTokens();
  const calibrated = weeklyQuota > 0 && fiveHourQuota > 0;

  const weights = {
    opus: getQuotaWeightOpus(),
    sonnet: getQuotaWeightSonnet(),
    haiku: getQuotaWeightHaiku(),
  };
  const quotaWeightCalibrated = weights.opus > 0 && weights.sonnet > 0 && weights.haiku > 0;

  const acc5h: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  const acc7d: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  // Per-family 5h/7d accumulators. `byModel` (the snapshot field) reports the
  // 7d window; the 5h split is internal, used only for the 5h Quota Weight.
  const byModel5h = emptyByModel();
  const byModel7d = emptyByModel();
  let tokens24h = 0;

  // Dedup unknown-model warnings to AT MOST one per scan (never per-line).
  const unknownModelsSeen = new Set<string>();

  let filesScanned = 0;
  let filesSkippedByMtime = 0;
  let linesParsed = 0;
  let linesWithUsage = 0;
  let parseErrors = 0;

  const files = await listJsonlFiles(root);
  for (const file of files) {
    let st: Stats;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    // mtime is the last append; if the file hasn't been touched in 7
    // days, none of its lines can fall inside the window.
    if (st.mtimeMs < cutoff7d) {
      filesSkippedByMtime++;
      continue;
    }
    filesScanned++;

    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch (err: any) {
      console.error(`[usage-tracker] read failed for ${file}: ${err?.message || err}`);
      continue;
    }

    const lines = content.split("\n");
    for (const line of lines) {
      // Fast reject: most lines are JSON objects; skip blanks instantly.
      if (!line || line[0] !== "{") continue;
      linesParsed++;
      const parsed = parseUsageLine(line);
      if (parsed === null) {
        parseErrors++;
        continue;
      }
      if (parsed === "skip") continue;
      linesWithUsage++;

      const tsMs = parsed.tsMs;
      if (tsMs < cutoff7d) continue;

      const family = modelToFamily(parsed.model);
      if (family === "unknown" && !unknownModelsSeen.has(parsed.model)) {
        unknownModelsSeen.add(parsed.model);
      }

      addBreakdown(acc7d, parsed.tokens);
      addBreakdown(byModel7d[family], parsed.tokens);
      if (tsMs >= cutoff24h) tokens24h += parsed.tokens.total;
      if (tsMs >= cutoff5h) {
        addBreakdown(acc5h, parsed.tokens);
        addBreakdown(byModel5h[family], parsed.tokens);
      }
    }
  }

  if (unknownModelsSeen.size > 0) {
    // Once per scan, not per line. An above-zero unknown bucket means the
    // family prefix table (modelToFamily) needs a new entry.
    console.warn(
      `[usage-tracker] ${unknownModelsSeen.size} unrecognised model string(s) bucketed to 'unknown' (implicit quota-weight 1.0): ${[
        ...unknownModelsSeen,
      ]
        .map((m) => (m === "" ? "<missing>" : m))
        .join(", ")}`,
    );
  }

  const percentLast5h = calibrated ? (acc5h.total / fiveHourQuota) * 100 : 0;
  const percentLast7d = calibrated ? (acc7d.total / weeklyQuota) * 100 : 0;
  const projectedWeeklyPercent = calibrated ? ((tokens24h * 7) / weeklyQuota) * 100 : 0;

  let pacingState: "under" | "on" | "over" = "under";
  if (calibrated) {
    if (projectedWeeklyPercent > 100) pacingState = "over";
    else if (projectedWeeklyPercent >= 80) pacingState = "on";
  }
  const emergencyStop = calibrated && percentLast5h >= 90;

  const weightedTotal = (acc: Record<ModelFamily, TokenBreakdown>): number =>
    MODEL_FAMILIES.reduce((sum, f) => sum + acc[f].total * familyWeight(f, weights), 0);
  const quotaWeightLast5h = quotaWeightCalibrated ? weightedTotal(byModel5h) : 0;
  const quotaWeightLast7d = quotaWeightCalibrated ? weightedTotal(byModel7d) : 0;

  return {
    tokensLast5h: acc5h,
    tokensLast7d: acc7d,
    tokensLast24h: tokens24h,
    percentLast5h,
    percentLast7d,
    projectedWeeklyPercent,
    pacingState,
    emergencyStop,
    calibrated,
    byModel: byModel7d,
    quotaWeightLast5h,
    quotaWeightLast7d,
    quotaWeightCalibrated,
    weeklyQuotaTokens: weeklyQuota,
    fiveHourQuotaTokens: fiveHourQuota,
    filesScanned,
    filesSkippedByMtime,
    linesParsed,
    linesWithUsage,
    parseErrors,
    generatedAt: now.toISOString(),
    cacheHitRatioLast5h: cacheHitRatio(acc5h),
    cacheHitRatioLast7d: cacheHitRatio(acc7d),
  };
}

export interface ParsedUsageLine {
  tsMs: number;
  tokens: TokenBreakdown;
  /**
   * Raw `message.model` string verbatim (or "" when absent). The scan loop
   * runs it through `modelToFamily()` to bucket `byModel`; surfacing the raw
   * string keeps the parser pure and lets tests pin classification
   * independently. (issue #691)
   */
  model: string;
}

/**
 * Parse one JSONL line. Three outcomes:
 *   - `null`     — malformed JSON; caller counts as parseError.
 *   - `"skip"`   — valid JSON but no usage block, no timestamp, or zero
 *                  tokens. The common case: most lines are user messages,
 *                  snapshots, tool results, etc.
 *   - object     — contributes to the rolling windows.
 *
 * Exported so tests can pin the parsing rules without round-tripping
 * through the filesystem.
 */
export function parseUsageLine(line: string): ParsedUsageLine | "skip" | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = obj?.timestamp;
  if (typeof ts !== "string") return "skip";
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) return "skip";

  const usage = obj?.message?.usage;
  if (!usage || typeof usage !== "object") return "skip";

  const input = Number(usage.input_tokens) || 0;
  const output = Number(usage.output_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
  const total = input + output + cacheRead + cacheCreation;
  if (total === 0) return "skip";

  const model = typeof obj?.message?.model === "string" ? obj.message.model : "";

  return {
    tsMs,
    tokens: { input, output, cacheRead, cacheCreation, total },
    model,
  };
}

/**
 * Cache-hit ratio for one accumulated window.
 *
 * `cacheRead / (cacheRead + cacheCreation + input)` — output tokens are
 * NOT cache-eligible so they never enter the denominator; cacheCreation
 * IS in the denominator so cache-warming cost is counted honestly.
 * Returns 0 when the denominator is 0 (zero-total guard — no NaN, no
 * division by zero). The result is always in the closed interval [0, 1].
 *
 * Exported so tests can pin the formula without round-tripping through
 * the filesystem.
 */
export function cacheHitRatio(b: TokenBreakdown): number {
  const denominator = b.cacheRead + b.cacheCreation + b.input;
  if (denominator === 0) return 0;
  return b.cacheRead / denominator;
}

function addBreakdown(target: TokenBreakdown, src: TokenBreakdown): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheCreation += src.cacheCreation;
  target.total += src.total;
}

/**
 * Walk the projects tree and return every `.jsonl` file. Two levels
 * deep is enough for today's Claude Code layout
 * (`<root>/<projectDir>/*.jsonl` and
 * `<root>/<projectDir>/<sessionId>/subagents/*.jsonl`), but we walk
 * arbitrarily deep so the format can evolve without us caring.
 */
async function listJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(root, out);
  return out;
}

/**
 * Autopilot classes the orchestrator sheds when the **Subscription Usage
 * Tracker** projects we'll exceed the weekly quota at the current rate.
 *
 * Keep `dev_*`, `qa_*`, `research_*`, `design_concept_*`, and `health` —
 * those are the value-bearing and safety-critical paths. Drop the
 * board-hygiene + discovery + scout classes when pacing is over because
 * they're high-volume signal-driven dispatches that don't directly move
 * Target Outcomes. This list is policy, not measurement; if you change
 * it, also update the autopilot playbook table that documents class
 * eligibility.
 */
export const PACING_SHEDDABLE_CLASSES: readonly string[] = Object.freeze([
  "sweep_orch",
  "sweep_target",
  "discover_orch",
  "discover_target",
  "scout_orch",
]);

export interface UsageEligibility {
  /**
   * False when the tracker reports `emergencyStop` (5h consumption at
   * or above 90% of calibrated quota). The autopilot turn MUST NOT
   * dispatch anything when `allow` is false — every dispatch class is
   * blocked, not just sheddable ones, because we're about to hit the
   * Anthropic 5h session cap and want to leave headroom for whatever
   * the operator dispatches manually.
   */
  allow: boolean;
  /**
   * Classes the autopilot turn must skip. Empty unless pacingState is
   * "over", in which case it carries `PACING_SHEDDABLE_CLASSES`. Has no
   * meaning when `allow` is false (every class is blocked).
   */
  shed: readonly string[];
  reasons: {
    emergencyStop: boolean;
    pacingShed: boolean;
    calibrated: boolean;
  };
  usage: UsageSnapshot;
}

/**
 * Pure projection from a snapshot to an autopilot-facing eligibility
 * verdict. Surfaces three independent facts:
 *   - `allow` (the hard-stop signal)
 *   - `shed` (the soft-throttle list)
 *   - `reasons` (so callers can log *why* without re-deriving)
 *
 * Uncalibrated snapshots always return `{ allow: true, shed: [] }` —
 * the tracker stays out of the way until the operator's env-var
 * calibration confirms it's reading real ground truth.
 */
export function projectEligibility(snapshot: UsageSnapshot): UsageEligibility {
  const allow = !snapshot.emergencyStop;
  const pacingShed = snapshot.pacingState === "over";
  const shed = pacingShed ? PACING_SHEDDABLE_CLASSES : [];
  return {
    allow,
    shed,
    reasons: {
      emergencyStop: snapshot.emergencyStop,
      pacingShed,
      calibrated: snapshot.calibrated,
    },
    usage: snapshot,
  };
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Missing or unreadable dir is silently skipped — the homedir
    // layout is operator-controlled and we don't want a missing
    // `~/.claude/projects` to take the orchestrator down on first
    // boot.
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}
