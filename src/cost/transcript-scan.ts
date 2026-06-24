/**
 * src/cost/transcript-scan.ts — the **TranscriptScan** seam (issue #1971).
 *
 * Owns the two I/O concerns the Subscription Usage Tracker depends on, lifted
 * verbatim out of `usage-tracker.ts`'s former private `scanUsage()`:
 *
 *   1. The JSONL transcript walk — `transcriptScan()` reads the
 *      `~/.claude/projects` JSONL session transcripts, parses every usage line via
 *      `parseUsageLine` (pure leaf `./token-math.ts`), and accumulates the
 *      per-family / per-skill token breakdowns over the rolling 5h / 24h / 7d
 *      windows plus the buffered since-reset entries. This is filesystem I/O
 *      (`readFile`, `stat`, `listTranscriptFiles`).
 *
 *   2. The OAuth cached meter read — `readOAuthCached()` + the module-level
 *      `oauthCache` singleton decouple the OAuth read cadence (HTTP I/O) from
 *      the 60s transcript-scan cache and serve a last-good value through
 *      transient 429s (issue #1090). Its TTL policy is fully independent of the
 *      snapshot cache.
 *
 * The PURE quota-math (weighted burn numerators, estimate percents,
 * pacingState, OAuth rebase, drift detection, since-reset derivation, final
 * `UsageSnapshot` assembly) stays in `usage-tracker.ts` as a behaviour-neutral
 * function over the {@link ScanResult} record this module returns. `getUsage()`
 * coordinates the two halves; the public surface (`src/cost/index.ts`) is
 * unchanged — {@link ScanResult} is an INTERNAL boundary type, never exported
 * from the barrel.
 *
 * One-way import: this module imports FROM `./token-math.ts`, `./config.ts`,
 * `./oauth-usage.ts`, and `../transcript-store.ts`; `usage-tracker.ts` imports
 * the scan + OAuth-cache primitives FROM here.
 */

import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  projectsRoot,
  listTranscriptFiles,
  sessionIdFromPath as transcriptSessionIdFromPath,
} from "../transcript-store.ts";
import { readOAuthUsage, isOAuthUsageOk } from "./oauth-usage.ts";
import type { OAuthUsageResult, OAuthUsageData } from "./oauth-usage.ts";
import { modelToFamily, parseUsageLine, parseObservedResetMs } from "./token-math.ts";
import type { TokenBreakdown, ModelFamily } from "./token-math.ts";
import {
  getOAuthUsageTtlMs,
  getOAuthUsageMaxStaleMs,
  getWeeklyResetAnchorMs,
} from "./config.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_5H_MS = 5 * MS_PER_HOUR;
const WINDOW_24H_MS = MS_PER_DAY;
const WINDOW_7D_MS = 7 * MS_PER_DAY;

const MODEL_FAMILIES: readonly ModelFamily[] = ["opus", "sonnet", "haiku", "unknown"];

/**
 * Residual bucket key for sessions whose first user message carries NEITHER a
 * `hydra-dispatch` sentinel NOR a leading `/command-name` slash marker — i.e. a
 * plain interactive operator session (or a legacy transcript predating the
 * sentinel). Tokens are still counted — they bucket here — so `bySkillByModel`
 * stays reconcilable to `byModel` and to the per-skill counters in
 * `src/redis/cost.ts`; nothing is dropped. (issue #693, #2402)
 *
 * Renamed from the former `"unattributed"` value (issue #2402): in-transcript
 * derivation makes "no attribution signal" mean exactly "interactive", not
 * "registry empty". The exported NAME `UNATTRIBUTED_SKILL` is retained below as
 * a back-compat alias so `src/cost/index.ts` and existing tests keep resolving.
 */
export const INTERACTIVE_SKILL = "interactive";

/**
 * Back-compat alias for {@link INTERACTIVE_SKILL} (issue #2402). The pre-#2402
 * name for the residual bucket was `UNATTRIBUTED_SKILL` with the value
 * `"unattributed"`; the value is now `"interactive"`. Kept as an alias so the
 * `index.ts` barrel and existing `from "./usage-tracker.ts"` imports resolve
 * unchanged. New code should reference {@link INTERACTIVE_SKILL}.
 */
export const UNATTRIBUTED_SKILL = INTERACTIVE_SKILL;

/**
 * Resolves a transcript's FIRST user message text to the dispatching skill
 * (issue #2402). Derivation is pure and Redis-free: the precedence is
 * (1) `hydra-dispatch` sentinel `skill=` → (2) a leading `/command-name` slash
 * marker → (3) the literal residual bucket {@link INTERACTIVE_SKILL}. A TOTAL
 * function: always returns a non-empty string, so every contributing file
 * lands in exactly one bucket and the `Σ bySkillByModel === byModel`
 * reconciliation invariant holds.
 *
 * The argument is the first user message's text (or `null` when the transcript
 * has no readable first user message), which the scan already holds — no second
 * `readFile`, no Redis read. Injectable so tests can pin the cross-tab by
 * passing fixture text instead of standing up a registry. Replaces the former
 * `(sessionId)=>Promise<string|null>` registry-read resolver (issue #693) that
 * the dead SessionStart hook (issue #2401) left structurally empty.
 */
export type SkillResolver = (firstUserText: string | null) => string;

/**
 * The `hydra-dispatch` sentinel (issue #692): the hidden
 * `<!-- hydra-dispatch v1 ... skill={skill} ... -->` HTML comment prepended to
 * the FIRST user message of every Agent-tool dispatch. `skill=` is the
 * highest-precedence attribution signal. Anchored on the bare token, not the
 * full comment, so it matches whether the comment is the whole message or
 * embedded in a longer prompt body. (issue #2402)
 */
const SENTINEL_RE = /<!--\s*hydra-dispatch\s+v1\b[^>]*\bskill=([^\s>]+)/;

/**
 * The slash-command marker (issue #2402). Slash-command dispatches (the
 * autopilot's own `/hydra-autopilot`, an operator-invoked `/hydra-grill`, …)
 * record their first user message as `<command-name>/skill-name</command-name>`
 * (the leading `/` is optional in that tag), OR — for a raw typed slash command
 * — a leading `/skill-name`. Either form attributes to `skill-name`. The
 * `command-name` arm is checked first so a `<command-name>` wrapper is matched
 * even though it does not start the string. Supports the `plugin:skill`
 * namespaced form via the `:` in the character class.
 */
const COMMAND_NAME_RE = /<command-name>\s*\/?([a-z0-9][a-z0-9:_-]*)/i;
const LEADING_SLASH_RE = /^\s*\/([a-z0-9][a-z0-9:_-]*)/i;

/**
 * Derive the dispatching skill from a transcript's first user message text
 * (issue #2402). Total, deterministic, Redis-free — see {@link SkillResolver}
 * for the precedence contract. Exported for direct unit test.
 */
export function deriveSkill(firstUserText: string | null): string {
  if (firstUserText) {
    const sentinel = SENTINEL_RE.exec(firstUserText);
    if (sentinel) return sentinel[1]; // (1) hydra-dispatch sentinel skill=
    const cmd = COMMAND_NAME_RE.exec(firstUserText);
    if (cmd) return cmd[1]; // (2a) <command-name>/skill</command-name> marker
    const slash = LEADING_SLASH_RE.exec(firstUserText);
    if (slash) return slash[1]; // (2b) leading /skill slash marker
  }
  return INTERACTIVE_SKILL; // (3) residual
}

/**
 * Extract the text of a transcript's FIRST user message from its already-read
 * content (issue #2402) — the signal `deriveSkill` reads. Walks the JSONL lines
 * the scan already split, returns the text of the first `type:"user"` record
 * that is NOT a harness-injected meta line (`isMeta:true`, e.g. the
 * `<local-command-caveat>` banner or the skill-template echo), and whose content
 * is non-empty. `content` may be a plain string OR an array of content blocks
 * (the harness emits both shapes); text blocks are concatenated. Returns `null`
 * when no readable first user message exists. Cheap: stops at the first match.
 */
export function firstUserMessageText(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      /* intentional: a non-JSON line cannot be the first user message — skip it */
      continue;
    }
    if (obj?.type !== "user" || obj?.isMeta === true) continue;
    const content = obj?.message?.content;
    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((b: any) => (b && typeof b.text === "string" ? b.text : ""))
        .join(" ");
    } else {
      continue;
    }
    if (text.trim() === "") continue;
    return text;
  }
  return null;
}

export const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

export function emptyByModel(): Record<ModelFamily, TokenBreakdown> {
  return {
    opus: { ...EMPTY_BREAKDOWN },
    sonnet: { ...EMPTY_BREAKDOWN },
    haiku: { ...EMPTY_BREAKDOWN },
    unknown: { ...EMPTY_BREAKDOWN },
  };
}

export function addBreakdown(target: TokenBreakdown, src: TokenBreakdown): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheRead += src.cacheRead;
  target.cacheCreation += src.cacheCreation;
  target.total += src.total;
}

/**
 * Derive a transcript's sessionId from its file path. The SessionStart capture
 * hook (issue #692) registers the dispatch under exactly the `<sessionId>.jsonl`
 * filename stem, so the basename is the join key into the dispatch registry.
 * Resolving once per file (not per line) keeps attribution O(files). (issue #693)
 *
 * Re-exported from the **Transcript Store** Seam (`src/transcript-store.ts`,
 * issue #951) — the single owner of the `<sessionId>.jsonl` filename grammar —
 * kept on this surface for existing callers (`src/cost/index.ts`, tests).
 */
export const sessionIdFromPath = transcriptSessionIdFromPath;

// ---------------------------------------------------------------------------
// OAuth cached meter read (issue #1090)
// ---------------------------------------------------------------------------

/**
 * Last SUCCESSFUL OAuth meter read, cached independently of the snapshot cache
 * (issue #1090). `storedAt` is the epoch-ms of the successful GET. This is the
 * "last-good" value served while the meter is rate-limited (429) or otherwise
 * transiently failing, so the headline stays on ground truth rather than
 * flipping to the transcript estimate the moment the endpoint hiccups. Only a
 * SUCCESSFUL read is cached here — a failure never overwrites the last-good.
 */
interface OAuthCacheEntry {
  data: OAuthUsageData;
  storedAt: number;
}

let oauthCache: OAuthCacheEntry | null = null;

/**
 * Null the module-level OAuth last-good cache. `clearUsageCache()` in
 * `usage-tracker.ts` calls this so its single reset entry point continues to
 * null BOTH the snapshot cache AND the oauthCache, even though the latter now
 * lives here (issue #1971). Test isolation depends on this. (issue #1090)
 */
export function clearOAuthCache(): void {
  oauthCache = null;
}

/**
 * The OAuth read fed into one scan, after the independent-TTL + last-good cache
 * layer (issue #1090). Distinct from the raw {@link OAuthUsageResult}: it also
 * tells the scan whether the value it carries is a STALE last-good (`stale`)
 * and how old it is (`ageMs`), so the snapshot can surface those observability
 * fields. `result.ok === true` covers BOTH a fresh read AND a served-stale
 * last-good — in either case the headline rebases onto OAuth ground truth; only
 * `result.ok === false` falls through to the transcript estimate.
 */
export interface CachedOAuthRead {
  result: OAuthUsageResult;
  /** True when `result` is a last-good value served because a fresh read failed. */
  stale: boolean;
  /** Age in ms of the served OAuth value, or `null` when none was served (failure). */
  ageMs: number | null;
}

/**
 * Decouple the OAuth-read cadence from the 60s transcript-scan cadence and
 * serve a last-good value through transient meter failures (issue #1090).
 *
 * Lifecycle of the module-level `oauthCache` (a SUCCESSFUL read only):
 *   - cache fresh (age < TTL)        → serve cached, NO external GET (fresh oauth)
 *   - cache stale-but-servable       → attempt GET; on success refresh + serve fresh;
 *       (TTL ≤ age < TTL + maxStale)    on FAILURE serve the cached value as STALE oauth
 *   - cache absent OR too stale       → attempt GET; on failure pass the failure
 *       (age ≥ TTL + maxStale)          through (caller falls to the estimate)
 *
 * Only a SUCCESSFUL read overwrites the cache — a 429/timeout never evicts the
 * last-good. Pure of `Date.now()` (caller passes `nowMs`); the module cache is
 * the only side effect, mirroring the snapshot `cache`.
 */
async function readOAuthCached(
  readUsage: () => Promise<OAuthUsageResult>,
  nowMs: number,
): Promise<CachedOAuthRead> {
  const ttlMs = getOAuthUsageTtlMs();

  // Fresh cache hit: serve without an external GET. This is the cadence
  // decoupling — within the TTL the snapshot scan reuses the cached OAuth value
  // instead of GETting on every 60s refresh.
  if (oauthCache !== null && nowMs - oauthCache.storedAt < ttlMs) {
    return {
      result: { ok: true, data: oauthCache.data },
      stale: false,
      ageMs: nowMs - oauthCache.storedAt,
    };
  }

  // TTL expired (or no cache): attempt a fresh read.
  const result = await readUsage();
  if (isOAuthUsageOk(result)) {
    oauthCache = { data: result.data, storedAt: nowMs };
    return { result, stale: false, ageMs: 0 };
  }

  // Read failed. Serve the last-good value (now stale) instead of flipping to
  // the estimate — UNLESS it is older than TTL + maxStale, in which case it is
  // too stale to trust and we let the failure fall through to the estimate.
  if (oauthCache !== null) {
    const ageMs = nowMs - oauthCache.storedAt;
    if (ageMs < ttlMs + getOAuthUsageMaxStaleMs()) {
      return { result: { ok: true, data: oauthCache.data }, stale: true, ageMs };
    }
    // Too stale: evict so a future success starts a clean age clock, and fall
    // through to the failure (estimate). Logged so a sustained outage is visible.
    console.error(
      `[usage-tracker] OAuth last-good value is too stale (age ${ageMs}ms ≥ ` +
        `TTL+maxStale); falling through to the transcript estimate (last read: ${result.code})`,
    );
    oauthCache = null;
  }
  return { result, stale: false, ageMs: null };
}

// ---------------------------------------------------------------------------
// Transcript JSONL walk (issue #1971 — lifted from the former scanUsage())
// ---------------------------------------------------------------------------

/**
 * The raw accumulation produced by the JSONL walk + OAuth read — the INTERNAL
 * boundary between the I/O phase (this module) and the pure snapshot-assembly
 * phase (`usage-tracker.ts`). NEVER added to the public `src/cost/index.ts`
 * surface (issue #1971). It carries everything the pure assembler reads; the
 * `now`/cutoffs and env weights are recomputed caller-side.
 */
export interface ScanResult {
  /** Flat 5h / 7d window token totals (the `tokensLast5h` / `tokensLast7d` fields). */
  acc5h: TokenBreakdown;
  acc7d: TokenBreakdown;
  /** Per-family 5h / 7d / 24h accumulators feeding the weighted burn numerators. */
  byModel5h: Record<ModelFamily, TokenBreakdown>;
  byModel7d: Record<ModelFamily, TokenBreakdown>;
  byModel24h: Record<ModelFamily, TokenBreakdown>;
  /** Per-skill × per-family 7d cross-tab (the `bySkillByModel` snapshot field). */
  bySkillByModel: Record<string, Record<ModelFamily, TokenBreakdown>>;
  /** Raw .total over the 24h window (the unchanged `tokensLast24h` field). */
  tokens24h: number;
  /** The OAuth read result (fresh / served-stale / failed), already resolved. */
  oauth: CachedOAuthRead;
  /** Most recent observed rate-limit reset seen in transcripts, or null. (#856) */
  mostRecentObservedResetMs: number | null;
  /** Buffered in-7d-window entries the since-reset math sums post-scan. (#856) */
  sinceResetEntries: { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[];
  // Diagnostic counters surfaced verbatim on the snapshot.
  filesScanned: number;
  filesSkippedByMtime: number;
  linesParsed: number;
  linesWithUsage: number;
  parseErrors: number;
}

/**
 * Walk the JSONL transcripts under `root`, fire the OAuth meter read
 * concurrently, and return the raw {@link ScanResult} accumulation — WITHOUT
 * computing any quota percentages (that pure math lives in `usage-tracker.ts`).
 *
 * The injectables mirror what the former private `scanUsage()` accepted:
 *   - `root`         the projects root to walk (a fixture dir in tests)
 *   - `now`          the anchor instant for the rolling-window cutoffs
 *   - `resolveSkill` first-user-message text → skill for the `bySkillByModel`
 *                    cross-tab (issue #2402; Redis-free, in-transcript)
 *   - `readOAuth`    the OAuth read closure (cached or bypass-injected by caller)
 *
 * OAuth concurrency (issue #1090): `readOAuth()` is fired at the top and only
 * AWAITED after the file walk completes, so the external GET (when one is made)
 * adds no serial latency to the JSONL scan. Never throws.
 */
export async function transcriptScan(
  root: string,
  now: Date,
  resolveSkill: SkillResolver,
  readOAuth: () => Promise<CachedOAuthRead>,
): Promise<ScanResult> {
  const nowMs = now.getTime();
  const cutoff7d = nowMs - WINDOW_7D_MS;
  const cutoff24h = nowMs - WINDOW_24H_MS;
  const cutoff5h = nowMs - WINDOW_5H_MS;

  // Authoritative OAuth meter read (issue #1083), through the independent-TTL +
  // last-good cache layer (issue #1090). Fired CONCURRENTLY with the transcript
  // file scan below so the external GET (when one is even made — see
  // `readOAuthCached`) adds no serial latency to the scan. Awaited after the
  // file walk; the caller's pure assembler rebases the headline onto it. Never
  // throws.
  const oauthPromise = readOAuth();

  const acc5h: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  const acc7d: TokenBreakdown = { ...EMPTY_BREAKDOWN };
  // Per-family 5h/7d accumulators. `byModel` (the snapshot field) reports the
  // 7d window; the 5h split is internal, used only for the 5h Quota Weight.
  const byModel5h = emptyByModel();
  const byModel7d = emptyByModel();
  // Per-family 24h accumulator. The scalar `tokens24h` (raw .total) is kept for
  // the unchanged `tokensLast24h` snapshot field; this per-family split feeds
  // the WEIGHTED `projectedWeeklyPercent` numerator so the projection composes
  // both weighting axes exactly like the 7d path. (issue #873)
  const byModel24h = emptyByModel();
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
  const sinceResetEntries: { tsMs: number; tokens: TokenBreakdown; family: ModelFamily }[] = [];
  let mostRecentObservedResetMs: number | null = null;

  // Dedup unknown-model warnings to AT MOST one per scan (never per-line).
  const unknownModelsSeen = new Set<string>();
  // Memoise sessionId → skill within a scan so a session with many transcript
  // shards resolves once, not once-per-shard (issue #693; preserved #2402).
  // (Distinct files usually carry distinct sessionIds, but a resumed session
  // can append a new shard.) The signal is now the first user message text
  // (issue #2402): the FIRST shard of a session carries the dispatch sentinel /
  // slash marker, so resolving once per session — keyed by sessionId — keeps
  // attribution O(files) AND attributes a multi-shard session uniformly.
  const skillCache = new Map<string, string>();

  let filesScanned = 0;
  let filesSkippedByMtime = 0;
  let linesParsed = 0;
  let linesWithUsage = 0;
  let parseErrors = 0;

  const files = await listTranscriptFiles(root);
  for (const file of files) {
    let st: Stats;
    try {
      st = await stat(file);
    } catch {
      /* intentional: file deleted/rotated between listing and stat — skip it */
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
      if (tsMs >= cutoff24h) {
        tokens24h += parsed.tokens.total;
        addBreakdown(byModel24h[family], parsed.tokens);
      }
      if (tsMs >= cutoff5h) {
        addBreakdown(acc5h, parsed.tokens);
        addBreakdown(byModel5h[family], parsed.tokens);
      }
      // Buffer for the fixed since-reset window (issue #856). Only when an env
      // Anchor is set — keeps the unset path zero-overhead.
      if (anchorEnvMs !== null) {
        sinceResetEntries.push({ tsMs, tokens: parsed.tokens, family });
      }
    }

    // Bucket this file's 7d tokens into the per-skill cross-tab. Skip files
    // with no in-window tokens so we don't conjure empty skill rows. Exactly
    // one skill resolution per contributing SESSION (memoised by sessionId) —
    // the resolver derives the skill from the first user message text the walk
    // already read (issue #2402), so attribution stays O(files) and Redis-free.
    if (fileHadInWindow7d) {
      const sessionId = sessionIdFromPath(file);
      let skill = skillCache.get(sessionId);
      if (skill === undefined) {
        skill = resolveSkill(firstUserMessageText(lines));
        skillCache.set(sessionId, skill);
      }
      const row = (bySkillByModel[skill] ??= emptyByModel());
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

  const oauth = await oauthPromise;

  return {
    acc5h,
    acc7d,
    byModel5h,
    byModel7d,
    byModel24h,
    bySkillByModel,
    tokens24h,
    oauth,
    mostRecentObservedResetMs,
    sinceResetEntries,
    filesScanned,
    filesSkippedByMtime,
    linesParsed,
    linesWithUsage,
    parseErrors,
  };
}

/**
 * Build the production-default OAuth-read closure for one scan (issue #1090,
 * #1083). On the pure production path (no injected reader, no fixture root) the
 * read goes through the independent-TTL `oauthCache` so it is decoupled from the
 * snapshot scan and serves a last-good value through transient 429s. When tests
 * inject a reader or point at a fixture root, the module cache is BYPASSED so
 * each call exercises the injected reader deterministically (preserving the
 * #1083 test contract) — unless `useOAuthCache` is explicitly set true, which
 * the #1090 tests use to drive the cache with a pinned reader.
 *
 * Kept here (with the cache it gates) so `usage-tracker.ts` stays the pure
 * coordinator/assembler; it passes the already-resolved defaults in.
 */
export function makeReadOAuth(opts: {
  readUsage: () => Promise<OAuthUsageResult>;
  nowMs: number;
  bypassOAuthCache: boolean;
}): () => Promise<CachedOAuthRead> {
  return opts.bypassOAuthCache
    ? async () => {
        const result = await opts.readUsage();
        return { result, stale: false, ageMs: isOAuthUsageOk(result) ? 0 : null };
      }
    : () => readOAuthCached(opts.readUsage, opts.nowMs);
}

/** Re-export the production defaults the coordinator wires in. */
export { projectsRoot, readOAuthUsage };
