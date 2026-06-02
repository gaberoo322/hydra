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
 * Weekly Reset Anchor env (issue #856, ADR-0021):
 *   - HYDRA_USAGE_WEEKLY_RESET_ANCHOR  — an ISO-8601 instant marking ONE
 *     observed weekly-limit reset, operator-seeded from the interactive
 *     `/usage` view. Projected forward in 7-day multiples relative to `now`
 *     to derive the current fixed window's reset boundary, against which
 *     `tokensSinceReset` / `percentSinceReset` are summed. This is a
 *     FIXED-window metric (resets every 7d at the Anchor), DISTINCT from the
 *     rolling `tokensLast7d` trailing sum. The effective anchor auto-corrects
 *     ON READ: if a real rate-limit reset timestamp is observed in a
 *     transcript and is more recent than the env projection's current-window
 *     boundary, that observed reset becomes the effective boundary. When the
 *     env var is unset/unparseable, the since-reset fields are neutral
 *     (null/0) and nothing throws — mirroring the uncalibrated quota behaviour.
 *     The Module stays a PURE read-side projection: nothing is persisted.
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
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { getSubagentDispatch } from "../redis/dispatches.ts";

/**
 * Bucket key for sessions that have no `hydra:dispatches:subagent:{sessionId}`
 * registry entry (legacy transcripts, or an operator-launched session whose
 * prompt carried no hydra-dispatch sentinel). Tokens are still counted — they
 * bucket here — so `bySkillByModel` stays reconcilable to `byModel` and to the
 * per-skill counters in `src/redis/cost.ts`; nothing is dropped. (issue #693)
 */
export const UNATTRIBUTED_SKILL = "unattributed";

/**
 * Resolves a transcript's `sessionId` to the dispatching skill, or null when
 * the session has no registry entry. The default reads the subagent-dispatch
 * registry (`getSubagentDispatch`, a pure READ — the tracker keeps its
 * no-Redis-WRITE posture). Injectable so tests can pin the cross-tab without
 * standing up Redis. (issue #693)
 */
export type SkillResolver = (sessionId: string) => Promise<string | null>;

const defaultSkillResolver: SkillResolver = async (sessionId) => {
  try {
    const dispatch = await getSubagentDispatch(sessionId);
    return dispatch?.skill ?? null;
  } catch (err: any) {
    // A Redis hiccup must not take down the read-only usage scan; bucket the
    // session under `unattributed` (null) and keep totals closed. Logged so a
    // persistent registry outage is visible rather than silently swallowed.
    console.error(
      `[usage-tracker] skill resolution failed for session ${sessionId}: ${err?.message || err}`,
    );
    return null;
  }
};

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
   * Per-skill × per-model-family token breakdown over the 7d window. The outer
   * key is the dispatching skill resolved from the subagent-dispatch registry
   * (`getSubagentDispatch`); the inner key is the model family. Sessions with
   * no registry entry bucket under `skill = "unattributed"` (see
   * {@link UNATTRIBUTED_SKILL}) so totals stay reconcilable to `byModel`.
   *
   * Reconciliation invariant: for each family `f`,
   * `Σ_skill bySkillByModel[skill][f].total === byModel[f].total`. Only skills
   * that produced tokens in the window appear; each present skill carries all
   * four family keys (zero-valued where the skill produced none). Pure
   * read-side projection — NO new Redis writes. (issue #693)
   */
  bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>>;
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
  /**
   * Fixed-window token breakdown summed since the current **Weekly Reset
   * Anchor** boundary (the most recent `anchor + 7d*k <= now`, auto-corrected
   * to a more recent observed reset when one is seen in a transcript). Same
   * shape as `tokensLast7d` but a CALENDAR-window sum, not a trailing one —
   * it drops to ~0 right after each weekly reset. All-zero when the Anchor
   * env var is unset/unparseable. (issue #856, ADR-0021)
   */
  tokensSinceReset: TokenBreakdown;
  /**
   * % of the weekly quota consumed since the current Weekly Reset Anchor
   * boundary (`tokensSinceReset.total / weeklyQuota * 100`). 0 when the
   * Anchor is unset OR the weekly quota is uncalibrated. Distinct from the
   * rolling `percentLast7d`. (issue #856)
   */
  percentSinceReset: number;
  /**
   * ISO-8601 string of the EFFECTIVE current-window reset boundary the
   * since-reset metric is summed from, or `null` when the Anchor env var is
   * unset/unparseable. The effective boundary is the env projection's
   * `currentMs`, overridden by a more recent observed rate-limit reset when
   * one is present in the transcripts. (issue #856)
   */
  weeklyResetAnchor: string | null;
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

/**
 * The operator-seeded **Weekly Reset Anchor** as epoch-ms, or `null` when
 * `HYDRA_USAGE_WEEKLY_RESET_ANCHOR` is unset/empty/unparseable. A bad value
 * is treated as unset (returns null) rather than throwing — the since-reset
 * fields stay neutral, mirroring the uncalibrated-quota discipline. A
 * non-empty-but-unparseable value is logged (fail-loud) since it signals a
 * mis-configured env var the operator should fix.
 */
export function getWeeklyResetAnchorMs(): number | null {
  const raw = process.env.HYDRA_USAGE_WEEKLY_RESET_ANCHOR;
  if (raw === undefined || raw === "") return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    console.error(
      `[usage-tracker] HYDRA_USAGE_WEEKLY_RESET_ANCHOR is set but not a valid ISO-8601 instant (${JSON.stringify(
        raw,
      )}); treating Weekly Reset Anchor as unset`,
    );
    return null;
  }
  return parsed;
}

export interface ResetWindow {
  /**
   * Epoch-ms of the most recent anchor + 7d*k that is <= now — the start of
   * the current fixed weekly window.
   */
  currentMs: number;
  /** Epoch-ms of the next reset boundary (currentMs + 7d). */
  nextMs: number;
}

/**
 * Project a single seeded **Weekly Reset Anchor** forward (and backward) in
 * 7-day multiples to find the fixed window containing `nowMs`.
 *
 * Returns the most recent boundary `anchorMs + 7d*k <= nowMs` (`currentMs`)
 * and the next one (`nextMs = currentMs + 7d`). Works for anchors in the
 * past OR the future (`k` may be negative). Pure + total: no I/O, no env
 * reads, deterministic in its two args — so it's the unit-testable core of
 * the Anchor math.
 */
export function projectResetWindow(anchorMs: number, nowMs: number): ResetWindow {
  const k = Math.floor((nowMs - anchorMs) / WINDOW_7D_MS);
  const currentMs = anchorMs + k * WINDOW_7D_MS;
  return { currentMs, nextMs: currentMs + WINDOW_7D_MS };
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
  /**
   * Resolves a transcript's `sessionId` to its dispatching skill for the
   * `bySkillByModel` cross-tab. Defaults to the subagent-dispatch registry
   * read. Injected by tests to pin attribution without Redis. (issue #693)
   */
  resolveSkill?: SkillResolver;
} = {}): Promise<UsageSnapshot> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const overrideRoot = opts.projectsRoot !== undefined;
  const overrideResolver = opts.resolveSkill !== undefined;
  if (!opts.force && !overrideRoot && !overrideResolver && cache) {
    if (nowMs - cache.storedAt < CACHE_TTL_MS) {
      return cache.snapshot;
    }
  }

  const root = opts.projectsRoot ?? getProjectsRoot();
  const resolveSkill = opts.resolveSkill ?? defaultSkillResolver;
  const snapshot = await scanUsage(root, now, resolveSkill);

  if (!overrideRoot && !overrideResolver) {
    cache = { snapshot, storedAt: nowMs };
  }
  return snapshot;
}

/**
 * Derive a transcript's sessionId from its file path. The Claude Code layout
 * names each transcript `<sessionId>.jsonl`, and the SessionStart capture hook
 * (issue #692) registers the dispatch under exactly that `session_id`, so the
 * filename basename is the join key into the dispatch registry. Resolving once
 * per file (not per line) keeps attribution O(files), honouring the design
 * invariant. (issue #693)
 */
export function sessionIdFromPath(filePath: string): string {
  return basename(filePath, ".jsonl");
}

async function scanUsage(
  root: string,
  now: Date,
  resolveSkill: SkillResolver,
): Promise<UsageSnapshot> {
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
  // Per-skill × per-family 7d accumulator (the `bySkillByModel` snapshot
  // field). Skills are added lazily as transcripts resolve to them.
  const bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>> = {};
  let tokens24h = 0;

  // Weekly Reset Anchor (issue #856). The since-reset boundary can be moved
  // FORWARD by an observed rate-limit reset, which we only learn mid-scan — so
  // buffer the in-7d-window (tsMs, tokens) entries and sum them once the
  // effective boundary is known. The set buffered is exactly the lines already
  // iterated for the rolling 7d window, bounded by the 7d cutoff. Only buffered
  // when the env Anchor is set, so the unset case adds zero overhead/memory.
  const anchorEnvMs = getWeeklyResetAnchorMs();
  const sinceResetEntries: { tsMs: number; tokens: TokenBreakdown }[] = [];
  let mostRecentObservedResetMs: number | null = null;

  // Dedup unknown-model warnings to AT MOST one per scan (never per-line).
  const unknownModelsSeen = new Set<string>();
  // Memoise sessionId → skill within a scan so a session with many transcript
  // shards resolves once, not once-per-shard. (Distinct files usually carry
  // distinct sessionIds, but a resumed session can append a new shard.)
  const skillCache = new Map<string, string | null>();

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

    // Accumulate this file's in-window 7d tokens per family locally, then fold
    // into the global per-family AND per-skill tables once the file is parsed.
    // Resolving the skill per FILE (not per line) keeps attribution O(files).
    const fileByFamily7d = emptyByModel();
    let fileHadInWindow7d = false;

    const lines = content.split("\n");
    for (const line of lines) {
      // Fast reject: most lines are JSON objects; skip blanks instantly.
      if (!line || line[0] !== "{") continue;
      linesParsed++;

      // Observed rate-limit reset (issue #856). A reset notice has no usage
      // block (so parseUsageLine would "skip" it), so probe it FIRST and only
      // when an env Anchor exists — that's the only mode that consumes the
      // observed reset. Track the most recent one; the effective boundary is
      // resolved post-scan.
      if (anchorEnvMs !== null) {
        const observed = parseObservedResetMs(line);
        if (observed !== null && (mostRecentObservedResetMs === null || observed > mostRecentObservedResetMs)) {
          mostRecentObservedResetMs = observed;
        }
      }

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

      fileHadInWindow7d = true;
      addBreakdown(acc7d, parsed.tokens);
      addBreakdown(byModel7d[family], parsed.tokens);
      addBreakdown(fileByFamily7d[family], parsed.tokens);
      if (tsMs >= cutoff24h) tokens24h += parsed.tokens.total;
      if (tsMs >= cutoff5h) {
        addBreakdown(acc5h, parsed.tokens);
        addBreakdown(byModel5h[family], parsed.tokens);
      }
      // Buffer for the fixed since-reset window (issue #856). Only when an env
      // Anchor is set — keeps the unset path zero-overhead.
      if (anchorEnvMs !== null) {
        sinceResetEntries.push({ tsMs, tokens: parsed.tokens });
      }
    }

    // Bucket this file's 7d tokens into the per-skill cross-tab. Skip files
    // with no in-window tokens so we don't conjure empty skill rows. Exactly
    // one skill resolution per contributing file (memoised by sessionId).
    if (fileHadInWindow7d) {
      const sessionId = sessionIdFromPath(file);
      let skill = skillCache.get(sessionId);
      if (skill === undefined) {
        skill = await resolveSkill(sessionId);
        skillCache.set(sessionId, skill);
      }
      const bucket = skill ?? UNATTRIBUTED_SKILL;
      const row = (bySkillByModel[bucket] ??= emptyByModel());
      for (const f of MODEL_FAMILIES) addBreakdown(row[f], fileByFamily7d[f]);
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

  // Weekly Reset Anchor / since-reset fixed window (issue #856, ADR-0021).
  // Pure read-side projection: the effective boundary is derived ON READ from
  // the env projection, overridden by a more recent observed reset. Nothing
  // is persisted. Neutral (null/0/all-zero) when the env Anchor is unset.
  let tokensSinceReset: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  let percentSinceReset = 0;
  let weeklyResetAnchor: string | null = null;
  if (anchorEnvMs !== null) {
    const envWindow = projectResetWindow(anchorEnvMs, nowMs);
    let effectiveBoundaryMs = envWindow.currentMs;
    // Auto-correct: an observed reset that is more recent than the env
    // projection (but not in the future relative to now) is the real boundary.
    if (
      mostRecentObservedResetMs !== null &&
      mostRecentObservedResetMs > effectiveBoundaryMs &&
      mostRecentObservedResetMs <= nowMs
    ) {
      console.warn(
        `[usage-tracker] Weekly Reset Anchor auto-corrected: observed reset ` +
          `${new Date(mostRecentObservedResetMs).toISOString()} overrides env projection ` +
          `${new Date(effectiveBoundaryMs).toISOString()} (env anchor ` +
          `${new Date(anchorEnvMs).toISOString()})`,
      );
      effectiveBoundaryMs = mostRecentObservedResetMs;
    }
    for (const e of sinceResetEntries) {
      if (e.tsMs >= effectiveBoundaryMs) addBreakdown(tokensSinceReset, e.tokens);
    }
    percentSinceReset = calibrated ? (tokensSinceReset.total / weeklyQuota) * 100 : 0;
    weeklyResetAnchor = new Date(effectiveBoundaryMs).toISOString();
  }

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
    bySkillByModel,
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
    tokensSinceReset,
    percentSinceReset,
    weeklyResetAnchor,
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
 * Extract an observed weekly/rate-limit RESET instant (epoch-ms) from one
 * JSONL line, or `null` when the line carries no reset signal.
 *
 * Claude Code has no documented schema for this, so we probe the field names
 * an Anthropic rate-limit payload realistically surfaces, in priority order:
 *
 *   1. `obj.message.usage.resets_at` / `reset_at` — usage block reset hint.
 *   2. `obj.message.rate_limit.resets_at` / a `rate_limit_*` error block.
 *   3. A top-level `obj.resetsAt` / `obj.reset_at` / `obj.usageLimitResetTime`
 *      that some harness builds attach to a limit-notice line.
 *
 * Each candidate is accepted only if it parses to a finite instant (ISO-8601
 * string OR epoch-seconds/ms number). This is intentionally permissive on
 * shape and strict on parse: an unrecognised line is simply `null`, never a
 * throw, so the scan never breaks on transcript-format drift. Exported so the
 * auto-correct rule is unit-testable without the filesystem. (issue #856)
 */
export function parseObservedResetMs(line: string): number | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const candidates: unknown[] = [
    obj?.message?.usage?.resets_at,
    obj?.message?.usage?.reset_at,
    obj?.message?.rate_limit?.resets_at,
    obj?.message?.rate_limit?.reset_at,
    obj?.message?.error?.rate_limit?.resets_at,
    obj?.rate_limit?.resets_at,
    obj?.resetsAt,
    obj?.reset_at,
    obj?.usageLimitResetTime,
  ];
  for (const c of candidates) {
    const ms = coerceInstantMs(c);
    if (ms !== null) return ms;
  }
  return null;
}

/**
 * Coerce a candidate reset value to epoch-ms. Accepts an ISO-8601 string or a
 * numeric epoch (seconds if < 1e12, else milliseconds). Returns null on
 * anything non-finite or non-positive. Pure helper for {@link parseObservedResetMs}.
 */
function coerceInstantMs(value: unknown): number | null {
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Heuristic: a 2026 epoch in seconds is ~1.7e9; in ms it is ~1.7e12.
    return value < 1e12 ? value * 1000 : value;
  }
  return null;
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
