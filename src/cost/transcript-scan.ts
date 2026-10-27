/**
 * src/cost/transcript-scan.ts — the **TranscriptScan** seam (issue #1971).
 *
 * Owns the transcript-walk I/O concern the Subscription Usage Tracker depends
 * on, lifted verbatim out of `usage-tracker.ts`'s former private `scanUsage()`:
 *
 *   1. The JSONL transcript walk — `transcriptScan()` reads the
 *      `~/.claude/projects` JSONL session transcripts, delegates the pure
 *      per-file parse + bucketing to `./transcript-fold.ts` (issue #4791), and
 *      accumulates the per-family / per-skill token breakdowns over the rolling
 *      5h / 24h / 7d windows plus the buffered since-reset entries. This module
 *      keeps the filesystem I/O (`readFile`, `stat`, `listTranscriptFiles`) and
 *      the parse-memo persistence.
 *
 *   2. The OAuth read wiring — `makeReadOAuth()` wires the cached meter read
 *      into a scan. The cache + backoff ladder themselves (`readOAuthCached()`,
 *      the `oauthCache` singleton) live in `./oauth-read-cache.ts` (issue
 *      #2923); this file only chooses cached vs bypass.
 *
 * Quota math and final `UsageSnapshot` assembly live in `./snapshot-assembly.ts`
 * (folds #2279, `assembleSnapshot` #2988) as behaviour-neutral functions over
 * the {@link ScanResult} record this module returns. `getUsage()` in
 * `usage-tracker.ts` coordinates the halves; the public surface
 * (`src/cost/index.ts`) is unchanged — {@link ScanResult} is an INTERNAL
 * boundary type, never exported from the barrel.
 *
 * Layer: L4 I/O source. For the import direction and the consumers of each
 * layer see the layer table in `src/cost/CONTEXT.md` (enforced by
 * `test/cost-layers.test.mts`) rather than a list restated here.
 *
 * Per-file parse memo (issue #3805): transcripts are append-only and
 * immutable once a session ends, so a file whose `(size, mtimeMs)` is
 * unchanged since the last scan cannot have gained usage lines. `transcriptScan()`
 * loads the durable `path -> parsed contribution` memo ONCE at the top of the
 * walk, replays a cache HIT through the SAME cutoff/bucketing logic a fresh
 * parse uses (never a second, independently-maintained copy — see
 * `foldFileContribution` below), and writes back changed/evicted entries in ONE
 * pipelined batch at the end. A memo miss, a structurally-corrupt entry, or a
 * Redis outage all degrade to a full parse of that one file — the memo is
 * never load-bearing for correctness, only for cost.
 */

import { readFile, stat } from "node:fs/promises";
import { foreignPrefixesFor, isProvidersFailure, loadWorkerProvidersFromFile } from "../glm/providers.ts";
import { loadDrainerConfig } from "../glm/drainer-config.ts";
import type { Stats } from "node:fs";
import {
  projectsRoot,
  listTranscriptFiles,
  resolveTranscriptPath,
  isUuidShaped,
  sessionIdFromPath as transcriptSessionIdFromPath,
} from "../transcript-store.ts";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "../logger.ts";
import { readOAuthUsage } from "./oauth-usage.ts";
// Pure meter-shape leaf (ADR-0042 Decision 5, issue #4781): the result-arm type
// guard `isOAuthUsageOk` moved DOWN out of `oauth-usage.ts` so pure consumers
// (`snapshot-assembly.ts`) no longer edge up into the I/O shell; imported here
// from its canonical L1 home.
import { isOAuthUsageOk } from "./oauth-meter-shape.ts";
import type { ModelFamily } from "./token-math.ts";
// The pure per-file parse core + the two pure transcript-content helpers
// (ADR-0042 Decision 6, issue #4791). `firstUserMessageText` and
// `sumSessionTokens` are re-exported below at their old names.
import {
  parseTranscriptFile,
  firstUserMessageText,
  sumSessionTokens,
  createScanAccumulator,
  foldFileContribution,
  MODEL_FAMILIES,
  TRANSCRIPT_PARSE_VERSION,
} from "./transcript-fold.ts";
import type { ScanCutoffs } from "./transcript-fold.ts";
// The token-breakdown data-model primitives — the empty-breakdown constant, the
// per-family / per-dispatch-kind accumulator factories + mutation, and the pure
// skill / dispatch-kind classifiers — live in the focused pure leaf
// `./token-breakdown.ts` (issue #3513, extracted out of this I/O coordinator).
// This module still USES them internally (the scan accumulator) and re-exports
// the ones its existing importers reach by name at the bottom of the file.
import {
  INTERACTIVE_SKILL,
  deriveSkill,
  DISPATCH_KINDS,
  deriveDispatchKind,
  EMPTY_BREAKDOWN,
  emptyByModel,
  emptyByDispatchKind,
} from "./token-breakdown.ts";
import type { SkillResolver, DispatchKind } from "./token-breakdown.ts";
import { getWeeklyResetAnchorMs } from "./config.ts";
// The OAuth backoff/cache seam lives in its own focused leaf (issue #2923):
// the last-good cache, exponential-backoff gate, single-flight guard, and Redis
// persistence side-channel. `makeReadOAuth` below wires it; the test + external
// callers reach the primitives via the re-exports at the bottom of this module.
import {
  readOAuthCached,
  wireOAuthBackoffPersistence,
} from "./oauth-read-cache.ts";
// Type-vocabulary root (ADR-0042 Decision 5, issue #4781): the boundary TYPES
// this I/O seam produces/threads — `ScanResult` (formerly defined here),
// `CachedOAuthRead` (formerly re-exported from `./oauth-read-cache.ts`), and
// `OAuthUsageResult` (formerly from `./oauth-usage.ts`) — live in `./types.ts`
// so the pure folds reading them import DOWNWARD. Type-only, compile-erased.
import type { ScanResult, CachedOAuthRead, OAuthUsageResult } from "./types.ts";
// Per-file parse memo seam (issue #3805): the durable `path -> parsed
// contribution` Redis Hash. A focused sibling leaf, NOT folded into
// `../redis/usage-snapshots.ts` (see that file's header / the design-concept
// artifact for `issue-3805` for why — different access pattern/cardinality).
import {
  loadTranscriptParseMemo,
  writeTranscriptParseMemoBatch,
} from "../redis/transcript-parse-memo.ts";
import type { FileParseMemoEntry } from "../redis/transcript-parse-memo.ts";

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const WINDOW_5H_MS = 5 * MS_PER_HOUR;
const WINDOW_24H_MS = MS_PER_DAY;
const WINDOW_7D_MS = 7 * MS_PER_DAY;


// The residual-bucket key {@link INTERACTIVE_SKILL}, the pure skill classifier
// {@link deriveSkill} + its {@link SkillResolver} type, the {@link DISPATCH_KINDS}
// vocabulary tuple + {@link DispatchKind} type, the {@link deriveDispatchKind}
// projection, and the {@link emptyByDispatchKind} factory moved to the pure
// `./token-breakdown.ts` leaf (issue #3513). They are imported at the top of this
// file (the scan accumulator still uses them) and re-exported at the bottom so
// `index.ts` and the tests keep resolving them by name. The
// module-private `UNATTRIBUTED_SKILL` back-compat alias (issue #2402/#3083) went
// with them — it had no remaining reference here.

// `EMPTY_BREAKDOWN`, `emptyByModel`, and `addBreakdown` moved to the pure
// `./token-breakdown.ts` leaf (issue #3513); imported at the top of this file
// because the scan accumulator shares them. `EMPTY_BREAKDOWN` + `emptyByModel`
// are also re-exported at the bottom for back-compat importers (the tests and
// the `index.ts` barrel); `addBreakdown` is NOT re-exported (issue
// #3525 — those callers import it directly from `./token-breakdown.ts`).

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
// Per-session token recovery (issue #3250 — the cumulative_tokens producer)
// ---------------------------------------------------------------------------
//
// The autopilot's `cumulative_tokens` run field was permanently 0 because the
// only real token count on the primary reap path comes from the SubagentStop
// hook, which does not expose the subagent's usage (verified in
// on-subagent-stop.sh — it forwards event/slot/status/task_id/subagent_type/
// summary only). The authoritative per-dispatch count already exists inside the
// completed dispatch's JSONL transcript; this seam recovers it, keyed by the
// dispatch's sessionId (the same UUID the hook derives into `task_id` from
// `.session_id`). reap.py joins on it at completion time when the hook floor is
// 0, so the value that flows into `cumulative_tokens` becomes REAL, not 0.
//
// A zero return is the honest "usage-not-parsed / unknown" sentinel (invariant
// 3): a missing transcript, an empty shard, or a parse miss all sum to 0 —
// never a fabricated estimate. All I/O is best-effort and never throws
// (invariant 4): callers get 0 and continue.

/**
 * List a session's subagent transcript shards, if any. A resumed / delegating
 * session appends a second shard one level deeper
 * (`<projectDir>/<sessionId>/subagents/*.jsonl`, per the Transcript Store
 * layout). We sum those shards too so a multi-shard dispatch is counted whole.
 * Best-effort: any read error yields an empty list (no throw).
 */
async function listSessionSubagentShards(
  primaryPath: string,
  sessionId: string,
): Promise<string[]> {
  const shardDir = join(dirname(primaryPath), sessionId, "subagents");
  try {
    const entries = await readdir(shardDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => join(shardDir, e.name));
  } catch {
    /* intentional: no subagents/ dir is the common case — not an error */
    return [];
  }
}

/** Injectable I/O for {@link tokensForSession} so tests need no real filesystem. */
export interface TokensForSessionDeps {
  /** Resolve a sessionId to its primary transcript path (default: transcript-store). */
  resolvePath?: (sessionId: string) => Promise<string | null>;
  /** List a session's extra subagent shards (default: on-disk walk). */
  listShards?: (primaryPath: string, sessionId: string) => Promise<string[]>;
  /** Read a transcript file's UTF-8 content (default: node:fs readFile). */
  read?: (path: string) => Promise<string>;
}

/**
 * Recover the total tokens a completed dispatch spent, by scanning its
 * sessionId-named transcript shard(s) (issue #3250). The join key is the
 * dispatch's `sessionId` — the same UUID the SubagentStop hook derives into the
 * slot-events `task_id`. Returns the summed total over the primary transcript
 * plus any `subagents/*.jsonl` shards.
 *
 * Best-effort and total (invariants 3 + 4): a non-UUID id, an unresolvable
 * transcript, or any read error returns 0 — the honest "unknown" sentinel,
 * never a fabricated nonzero. Never throws.
 */
export async function tokensForSession(
  sessionId: string,
  deps: TokensForSessionDeps = {},
): Promise<number> {
  const id = (sessionId ?? "").trim();
  if (!id || !isUuidShaped(id)) return 0;
  const resolvePath =
    deps.resolvePath ?? ((sid: string) => resolveTranscriptPath(sid, undefined));
  const listShards = deps.listShards ?? listSessionSubagentShards;
  const read = deps.read ?? ((p: string) => readFile(p, "utf-8"));

  let primary: string | null;
  try {
    primary = await resolvePath(id);
  } catch (err) {
    logger.error({ id, err }, "[transcript-scan] tokensForSession resolve failed");
    return 0;
  }
  if (!primary) return 0;

  const files = [primary, ...(await listShards(primary, id))];
  let total = 0;
  for (const file of files) {
    let content: string;
    try {
      content = await read(file);
    } catch (err) {
      // A shard that vanished between listing and read is non-fatal — log and
      // keep summing the rest (fail-loud-then-proceed).
      logger.error({ file, err }, "[transcript-scan] tokensForSession read failed");
      continue;
    }
    total += sumSessionTokens(content.split("\n"));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Transcript JSONL walk (issue #1971 — lifted from the former scanUsage())
// ---------------------------------------------------------------------------

// The `ScanResult` boundary interface moved to the type-vocabulary root
// `./types.ts` (ADR-0042 Decision 5, issue #4781): `snapshot-assembly.ts` (L3,
// pure) reads slices of it, and importing it from this L4 I/O seam was an
// upward edge. Imported at the top of this file for `transcriptScan()`'s
// return type and re-exported at the bottom so
// `test/snapshot-assembly.test.mts` and every other existing importer keep
// resolving it at the old `./transcript-scan.ts` path unchanged.

/**
 * Injectable persistence for the per-file parse memo (issue #3805). Defaults
 * to the real `../redis/transcript-parse-memo.ts` accessors; tests inject a
 * rejecting/pre-seeded stand-in to drive the miss/corrupt/outage degrade
 * paths deterministically without hand-writing raw Redis fields.
 */
export interface TranscriptParseMemoIo {
  load?: () => Promise<Map<string, FileParseMemoEntry>>;
  write?: (
    upserts: ReadonlyMap<string, FileParseMemoEntry>,
    deletes: readonly string[],
  ) => Promise<void>;
}

/**
 * The foreign-provider model prefixes, derived from the configured GLM worker
 * providers (issue #4841 INV-11) — read once per scan at this I/O edge. An
 * unreadable/invalid list degrades to `undefined` (the pure default `glm-`),
 * logged loudly: metering must never throw over a drainer config fault.
 */
function loadForeignPrefixes(): readonly string[] | undefined {
  const loaded = loadWorkerProvidersFromFile(
    loadDrainerConfig(process.env).providersFile ?? "",
  );
  if (isProvidersFailure(loaded)) {
    console.error(
      `[transcript-scan] worker-provider list invalid — using the default foreign-model prefixes: ${loaded.issues.join("; ")}`,
    );
    return undefined;
  }
  return foreignPrefixesFor(loaded.providers);
}

/**
 * Walk the JSONL transcripts under `root`, fire the OAuth meter read
 * concurrently, and return the raw {@link ScanResult} accumulation — WITHOUT
 * computing any quota percentages (that pure math lives in `snapshot-assembly.ts`).
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
 *
 *   - `memoIo`       injectable per-file parse-memo persistence (issue #3805).
 *                    Defaults to the real Redis-backed accessors; tests inject
 *                    a rejecting/pre-seeded stand-in to drive the miss/corrupt/
 *                    outage degrade paths deterministically.
 */
export async function transcriptScan(
  root: string,
  now: Date,
  resolveSkill: SkillResolver,
  readOAuth: () => Promise<CachedOAuthRead>,
  memoIo: TranscriptParseMemoIo = {},
): Promise<ScanResult> {
  const nowMs = now.getTime();
  const cutoff7d = nowMs - WINDOW_7D_MS;
  const cutoff24h = nowMs - WINDOW_24H_MS;
  const cutoff5h = nowMs - WINDOW_5H_MS;
  const foreignPrefixes = loadForeignPrefixes();
  const foreignKey = [...(foreignPrefixes ?? [])].sort().join(",");
  const loadMemo = memoIo.load ?? loadTranscriptParseMemo;
  const writeMemo = memoIo.write ?? writeTranscriptParseMemoBatch;

  // Authoritative OAuth meter read (issue #1083), through the independent-TTL +
  // last-good cache layer (issue #1090). Fired CONCURRENTLY with the transcript
  // file scan below so the external GET (when one is even made — see
  // `readOAuthCached`) adds no serial latency to the scan. Awaited after the
  // file walk; the caller's pure assembler rebases the headline onto it. Never
  // throws.
  const oauthPromise = readOAuth();

  // The scan accumulators (acc5h/acc7d, per-family windows, skill/kind
  // cross-tabs, foreign7d, since-reset buffer, line counters) live in one
  // record mutated ONLY by `foldFileContribution` (issue #4792, ADR-0042
  // Decision 6). The Weekly Reset Anchor (issue #856) gates the since-reset
  // buffer and the observed-reset advance inside the fold.
  const acc = createScanAccumulator();
  const cutoffs: ScanCutoffs = { cutoff7d, cutoff24h, cutoff5h };
  const anchorEnvMs = getWeeklyResetAnchorMs();

  // Dedup unknown-model warnings to AT MOST one per scan (never per-line).
  const unknownModelsSeen = new Set<string>();
  // Foreign-provider (non-Anthropic-quota) accumulation, issue #3769. Kept
  // entirely OUTSIDE the Anthropic windows/families: this is a different meter.
  const foreignModelsSeen = new Set<string>();
  // Memoise sessionId → skill within a scan so a session with many transcript
  // shards resolves once, not once-per-shard (issue #693; preserved #2402).
  // (Distinct files usually carry distinct sessionIds, but a resumed session
  // can append a new shard.) The signal is now the first user message text
  // (issue #2402): the FIRST shard of a session carries the dispatch sentinel /
  // slash marker, so resolving once per session — keyed by sessionId — keeps
  // attribution O(files) AND attributes a multi-shard session uniformly.
  const skillCache = new Map<string, string>();
  // Per-session dispatch-kind memo (issue #2403). Resolved from the SAME
  // first-user-message text as the skill, in lockstep, so the kind partition
  // is exact and O(files). The kind always uses the canonical
  // `deriveDispatchKind` (it is a projection over WHICH precedence branch
  // fired) — independent of any test-injected `resolveSkill`.
  const kindCache = new Map<string, DispatchKind>();

  let filesScanned = 0;
  let filesSkippedByMtime = 0;
  let filesServedFromMemo = 0;

  // Per-file parse memo (issue #3805). Loaded ONCE, up front, in a single
  // round trip — never throws: a load failure degrades to an empty map, which
  // is indistinguishable from "nothing memoized yet" to every file below.
  let memoMap: Map<string, FileParseMemoEntry>;
  try {
    memoMap = await loadMemo();
  } catch (err: any) {
    logger.error({ err }, "[transcript-scan] transcript-parse-memo load failed; scanning cold");
    memoMap = new Map();
  }
  const memoUpserts = new Map<string, FileParseMemoEntry>();
  const memoDeletes: string[] = [];

  const isKnownFamily = (f: string): f is ModelFamily =>
    (MODEL_FAMILIES as readonly string[]).includes(f);
  const isKnownDispatchKind = (k: string): k is DispatchKind =>
    (DISPATCH_KINDS as readonly string[]).includes(k);
  /**
   * Deep, domain-vocabulary validation of a cached memo entry (issue #3805).
   * `loadTranscriptParseMemo()` already checked the JSON SHAPE; this checks
   * every `family`/`dispatchKind` string is one this build's vocabulary
   * actually recognises. A entry written by a future/older build with a
   * vocabulary this build doesn't recognise degrades to a clean miss — the
   * file is re-parsed and the entry is overwritten, self-healing the memo.
   */
  const isMemoEntryUsable = (entry: FileParseMemoEntry): boolean => {
    // An entry from an older parser (issue #5141) is re-parsed, never replayed.
    if (entry.parseVersion !== TRANSCRIPT_PARSE_VERSION) return false;
    // Foreign flags depend on the configured prefix set (issue #4841): an entry
    // parsed under a different set is re-parsed, never replayed.
    if (entry.foreignKey !== foreignKey) return false;
    if (entry.dispatchKind !== null && !isKnownDispatchKind(entry.dispatchKind)) return false;
    for (const e of entry.entries) {
      if (!e.foreign && !isKnownFamily(e.family)) return false;
    }
    return true;
  };

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
    // days, none of its lines can fall inside the window. Piggyback the
    // memo eviction here (issue #3805): the walk already stat()s every file
    // including aged-out ones, so this is the natural place to drop its
    // memo entry (if any) — no separate sweep job needed. Bounds the memo to
    // the corpus's active in-window footprint.
    if (st.mtimeMs < cutoff7d) {
      filesSkippedByMtime++;
      if (memoMap.has(file)) {
        memoMap.delete(file);
        memoDeletes.push(file);
      }
      continue;
    }
    filesScanned++;

    // Memo hit (issue #3805): unchanged (size, mtimeMs) means the file cannot
    // have gained usage lines since it was last parsed — replay its cached
    // per-line contribution through the SAME `foldFileContribution` the fresh path
    // uses, with NO read + NO JSON.parse of this file's bytes.
    const cached = memoMap.get(file);
    if (
      cached !== undefined &&
      cached.size === st.size &&
      cached.mtimeMs === st.mtimeMs &&
      isMemoEntryUsable(cached)
    ) {
      filesServedFromMemo++;
      // Replay through the SAME `foldFileContribution` the fresh path uses.
      // Log-only model-name placeholders stay here: they never enter the
      // accumulator (issue #4792).
      for (const e of cached.entries) {
        if (e.foreign) foreignModelsSeen.add("<memoized-foreign>");
        else if (e.family === "unknown") unknownModelsSeen.add("<memoized-unknown>");
      }
      foldFileContribution(acc, cached, cutoffs, anchorEnvMs);
      // Attribution symmetry (issue #4792, folded in from #4778): a fresh parse
      // of this shard would have resolved + cached the session's skill/kind
      // (iff it had an in-7d non-foreign line under the CURRENT cutoff), so a
      // LATER fresh shard of the same session attributes uniformly. Seed the
      // cache in lockstep on replay under that same condition; the first
      // shard's resolution wins, exactly as on the fresh path.
      if (
        cached.skill !== null &&
        cached.dispatchKind !== null &&
        isKnownDispatchKind(cached.dispatchKind) &&
        cached.entries.some((e) => !e.foreign && e.tsMs >= cutoff7d)
      ) {
        const sid = sessionIdFromPath(file);
        if (!skillCache.has(sid) || !kindCache.has(sid)) {
          skillCache.set(sid, cached.skill);
          kindCache.set(sid, cached.dispatchKind);
        }
      }
      continue;
    }

    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch (err: any) {
      logger.error({ file, err }, "[transcript-scan] transcript read failed");
      continue;
    }

    // The pure parse core (ADR-0042 Decision 6, issue #4791) turns the file's
    // content into its memoizable contribution. Skill/dispatch-kind attribution
    // is injected as a callback so the session-keyed cache and
    // `sessionIdFromPath` stay in this I/O shell. Exactly one resolution per
    // contributing SESSION (memoised by sessionId) -- the resolver derives the
    // skill from the first user message text the walk already read (issue
    // #2402), so attribution stays O(files) and Redis-free. The core invokes the
    // callback only when the file had in-7d Anthropic tokens, so files with none
    // never conjure empty skill rows.
    const { entry, unknownModels, foreignModels } = parseTranscriptFile(
      content,
      cutoff7d,
      (lines) => {
        const sessionId = sessionIdFromPath(file);
        let skill = skillCache.get(sessionId);
        let kind = kindCache.get(sessionId);
        if (skill === undefined || kind === undefined) {
          // Resolve BOTH from the same first-user-message text (one extraction).
          const firstText = firstUserMessageText(lines);
          skill = resolveSkill(firstText);
          kind = deriveDispatchKind(firstText);
          skillCache.set(sessionId, skill);
          kindCache.set(sessionId, kind);
        }
        return { skill, dispatchKind: kind };
      },
      { foreignPrefixes },
    );
    for (const m of foreignModels) foreignModelsSeen.add(m);
    for (const m of unknownModels) unknownModelsSeen.add(m);

    // Fold through the SAME `foldFileContribution` the memo-hit path uses.
    foldFileContribution(acc, entry, cutoffs, anchorEnvMs);

    memoUpserts.set(file, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      ...entry,
      foreignKey,
    });
  }

  // Persist changed/evicted memo entries in ONE pipelined batch (issue
  // #3805). Best-effort: a write failure only costs the NEXT scan a redundant
  // re-parse of whatever didn't persist — the `ScanResult` already computed
  // above is correct regardless and is returned either way.
  try {
    await writeMemo(memoUpserts, memoDeletes);
  } catch (err: any) {
    logger.error(
      { upserts: memoUpserts.size, deletes: memoDeletes.length, err },
      "[transcript-scan] transcript-parse-memo write failed",
    );
  }

  if (foreignModelsSeen.size > 0) {
    // NOT a warning: this is the designed path, not drift. Foreign-provider
    // tokens are excluded from the Anthropic quota aggregates on purpose
    // (issue #3769) — logged so the exclusion is observable rather than silent.
    logger.info(
      {
        models: [...foreignModelsSeen],
        tokens: acc.foreign7d.total,
      },
      "[transcript-scan] foreign-provider tokens excluded from Anthropic quota aggregates (issue #3769)",
    );
  }

  if (unknownModelsSeen.size > 0) {
    // Once per scan, not per line. An above-zero unknown bucket means the
    // family prefix table (modelToFamily) needs a new entry.
    logger.warn(
      {
        count: unknownModelsSeen.size,
        models: [...unknownModelsSeen].map((m) => (m === "" ? "<missing>" : m)),
      },
      "[transcript-scan] unrecognised model string(s) bucketed to 'unknown' (implicit quota-weight 1.0)",
    );
  }

  const oauth = await oauthPromise;

  return {
    acc5h: acc.acc5h,
    acc7d: acc.acc7d,
    byModel5h: acc.byModel5h,
    byModel7d: acc.byModel7d,
    byModel24h: acc.byModel24h,
    bySkillByModel: acc.bySkillByModel,
    bySkillByModel24h: acc.bySkillByModel24h,
    byDispatchKind: acc.byDispatchKind,
    tokens24h: acc.tokens24h,
    foreign7d: acc.foreign7d,
    oauth,
    mostRecentObservedResetMs: acc.mostRecentObservedResetMs,
    sinceResetEntries: acc.sinceResetEntries,
    filesScanned,
    filesSkippedByMtime,
    linesParsed: acc.linesParsed,
    linesWithUsage: acc.linesWithUsage,
    parseErrors: acc.parseErrors,
    filesServedFromMemo,
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
 * Kept here (the cache itself lives in `oauth-read-cache.ts`, #2923) so
 * `usage-tracker.ts` stays the I/O coordinator; it passes the already-resolved
 * defaults in.
 */
export function makeReadOAuth(opts: {
  readUsage: () => Promise<OAuthUsageResult>;
  nowMs: number;
  bypassOAuthCache: boolean;
  /**
   * Install the live Redis backoff-persistence side-channel (issue #2840). True
   * ONLY on the pure production path (no injected reader, no fixture root); false
   * on the deterministic test path, which stays on the no-op default (invariant
   * 5) unless a test explicitly injected a fake store via
   * {@link setOAuthBackoffPersistence}. `getUsage` computes this.
   */
  persistBackoff?: boolean;
}): () => Promise<CachedOAuthRead> {
  // Pure production path: wire the Redis persistence seam so the backoff ladder
  // survives a restart. The deterministic test path installs the no-op adapter
  // instead — UNLESS a test explicitly injected a fake store (a non-Redis, non-
  // no-op reference), which we must not clobber. This also prevents a pure-
  // production `getUsage()` in one test from LEAKING the Redis seam into a later
  // cached-path test that would then hydrate from real Redis (invariant 5). The
  // full decision now lives in the OAuth backoff/cache seam (issue #2923).
  wireOAuthBackoffPersistence(opts.persistBackoff ?? false);
  return opts.bypassOAuthCache
    ? async () => {
        const result = await opts.readUsage();
        // The bypass path has NO module cache, so a fresh success is the only
        // "last-known" value and a failure carries none (issue #2832). This keeps
        // the #1083 deterministic fresh-each-call contract: the divergence
        // detector sees a baseline only on a successful bypass read, never a
        // phantom cached one.
        return {
          result,
          stale: false,
          ageMs: isOAuthUsageOk(result) ? 0 : null,
          lastKnownOAuth: isOAuthUsageOk(result) ? result.data : null,
          // The bypass path has no backoff ladder at all (issue #3821) — each
          // call is an independent deterministic read, so there is no
          // consecutive-failure count to carry. Always 0.
          consecutiveFailures: 0,
        };
      }
    : () => readOAuthCached(opts.readUsage, opts.nowMs);
}

/** Re-export the production defaults the coordinator wires in. */
export { projectsRoot, readOAuthUsage };

// Re-export the token-breakdown data-model primitives from their new focused
// pure leaf (issue #3513) at the SAME names this module used to own, so existing
// importers of `./transcript-scan.ts` (see `src/cost/CONTEXT.md`)
// keep resolving unchanged. The canonical owner
// is now `./token-breakdown.ts`; new code (and `snapshot-assembly.ts`) should
// import directly from there.
export {
  INTERACTIVE_SKILL,
  deriveSkill,
  DISPATCH_KINDS,
  EMPTY_BREAKDOWN,
  emptyByModel,
  emptyByDispatchKind,
};
export type { SkillResolver };
// Pure transcript-content helpers -- canonical home is `./transcript-fold.ts`.
export { firstUserMessageText, sumSessionTokens };
// The parse-memo version this scan's usability gate replays (issue #5141).
export { TRANSCRIPT_PARSE_VERSION };

// Re-export the OAuth backoff/cache seam surface from its new focused leaf
// (issue #2923) at the SAME names this module used to own, so existing importers
// of `./transcript-scan.ts` (see `src/cost/CONTEXT.md`)
// keep resolving unchanged. The canonical owner is now `./oauth-read-cache.ts`;
// new code should import directly from there.
export {
  setOAuthBackoffPersistence,
  oauthBackoffDelayMs,
} from "./oauth-read-cache.ts";
export type { OAuthBackoffPersistence } from "./oauth-read-cache.ts";
// `CachedOAuthRead` and `ScanResult` are already imported as types above (from
// the `./types.ts` vocabulary root, #4781) — `makeReadOAuth`'s signature and
// `transcriptScan()`'s return type use them; re-export those local bindings
// rather than re-fetching them, so `test/usage-tracker.test.mts` (which aliases
// `CachedOAuthRead` off THIS path) and `test/snapshot-assembly.test.mts` (which
// imports `ScanResult` off THIS path) keep resolving unchanged.
export type { CachedOAuthRead, ScanResult };
