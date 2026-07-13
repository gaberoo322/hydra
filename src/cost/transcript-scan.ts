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
  resolveTranscriptPath,
  isUuidShaped,
  sessionIdFromPath as transcriptSessionIdFromPath,
} from "../transcript-store.ts";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readOAuthUsage, isOAuthUsageOk } from "./oauth-usage.ts";
import type { OAuthUsageResult } from "./oauth-usage.ts";
import { modelToFamily, parseUsageLine, parseObservedResetMs } from "./token-math.ts";
import type { TokenBreakdown, ModelFamily } from "./token-math.ts";
import { getWeeklyResetAnchorMs } from "./config.ts";
// The OAuth backoff/cache seam lives in its own focused leaf (issue #2923):
// the last-good cache, exponential-backoff gate, single-flight guard, and Redis
// persistence side-channel. `makeReadOAuth` below wires it; the test + external
// callers reach the primitives via the re-exports at the bottom of this module.
import {
  readOAuthCached,
  wireOAuthBackoffPersistence,
} from "./oauth-read-cache.ts";
import type { CachedOAuthRead } from "./oauth-read-cache.ts";

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
 * "registry empty".
 */
export const INTERACTIVE_SKILL = "interactive";

/**
 * @deprecated Module-private back-compat alias for {@link INTERACTIVE_SKILL}
 * (issue #2402, export demoted #3083). The pre-#2402 name for the residual
 * bucket was `UNATTRIBUTED_SKILL` with the value `"unattributed"`; the value is
 * now `"interactive"`. New code should reference {@link INTERACTIVE_SKILL}; this
 * alias is no longer re-exported.
 */
const UNATTRIBUTED_SKILL = INTERACTIVE_SKILL;

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
 * The three mutually-exclusive **dispatch kinds** (issue #2403). A PROJECTION
 * over WHICH branch of the {@link deriveSkill} precedence chain fired for a
 * session's first user message — NOT an independent re-derivation:
 *
 *   - `autopilot-dispatched` — the `hydra-dispatch` sentinel matched (a
 *     background Agent-tool dispatch; `runId` is structurally present iff the
 *     sentinel matched, so the sentinel branch IS this kind).
 *   - `operator-invoked` — a `<command-name>/skill</command-name>` marker or a
 *     leading `/skill` slash matched (the operator typed/ran a slash command).
 *   - `interactive` — neither matched (a plain interactive operator session, or
 *     a legacy transcript predating the sentinel). The SAME residual the
 *     `bySkillByModel` cross-tab buckets under {@link INTERACTIVE_SKILL}.
 *
 * The order of this tuple is the precedence order; it is also the canonical
 * render/iteration order for the dashboard kind split.
 */
export const DISPATCH_KINDS = [
  "autopilot-dispatched",
  "operator-invoked",
  "interactive",
] as const;
export type DispatchKind = (typeof DISPATCH_KINDS)[number];

/**
 * Resolves a transcript's first user message text to its **dispatch kind**
 * (issue #2403). Total, deterministic, Redis-free — partitions over the SAME
 * precedence chain as {@link deriveSkill} (sentinel → command/slash marker →
 * residual), so every contributing file lands in exactly one kind and the
 * `Σ_kind byDispatchKind[kind][f].total === byModel[f].total` invariant holds.
 *
 * Pure projection: no second `readFile`, no `runId` re-parse — the precedence
 * branch already IS the kind. Exported for direct unit test.
 */
export function deriveDispatchKind(firstUserText: string | null): DispatchKind {
  if (firstUserText) {
    if (SENTINEL_RE.test(firstUserText)) return "autopilot-dispatched"; // (1) sentinel
    if (COMMAND_NAME_RE.test(firstUserText)) return "operator-invoked"; // (2a) <command-name>
    if (LEADING_SLASH_RE.test(firstUserText)) return "operator-invoked"; // (2b) leading /slash
  }
  return "interactive"; // (3) residual
}

/** Empty per-kind × per-family accumulator, all three kinds zero-valued. */
export function emptyByDispatchKind(): Record<DispatchKind, Record<ModelFamily, TokenBreakdown>> {
  return {
    "autopilot-dispatched": emptyByModel(),
    "operator-invoked": emptyByModel(),
    interactive: emptyByModel(),
  };
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
 * Sum the total tokens across every usage-bearing line of ONE session's
 * transcript content. Pure and Redis-free — reuses `parseUsageLine` (the same
 * authoritative parser the windowed scan uses), so the per-dispatch count is
 * reconcilable with the per-skill/per-family cross-tabs. Non-JSON lines, lines
 * with no usage block, and zero-usage lines all contribute nothing. Unlike the
 * rolling-window scan this applies NO time cutoff: a completed dispatch's whole
 * transcript is its usage, regardless of when it started. Exported for direct
 * unit test. Total: always returns a non-negative integer.
 */
export function sumSessionTokens(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    const parsed = parseUsageLine(line);
    if (parsed === null || parsed === "skip") continue;
    total += parsed.tokens.total;
  }
  return total;
}

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
    console.error(`[transcript-scan] tokensForSession resolve failed for ${id}:`, err);
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
      console.error(`[transcript-scan] tokensForSession read failed for ${file}:`, err);
      continue;
    }
    total += sumSessionTokens(content.split("\n"));
  }
  return total;
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
  /**
   * Per-dispatch-kind × per-family 7d cross-tab (the `byDispatchKind` snapshot
   * field, issue #2403). A SECOND partition over the SAME per-file tokens as
   * `bySkillByModel`, keyed by {@link DispatchKind} instead of skill. Always
   * carries all three kind keys (zero-valued where a kind produced none), so
   * `Σ_kind byDispatchKind[kind][f].total === byModel[f].total` per family.
   */
  byDispatchKind: Record<DispatchKind, Record<ModelFamily, TokenBreakdown>>;
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
  // Per-dispatch-kind × per-family 7d accumulator (issue #2403). A parallel
  // partition over the SAME per-file tokens as `bySkillByModel`, pre-seeded
  // with all three kind buckets so the snapshot always carries the full split.
  const byDispatchKind = emptyByDispatchKind();
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
  // Per-session dispatch-kind memo (issue #2403). Resolved from the SAME
  // first-user-message text as the skill, in lockstep, so the kind partition
  // is exact and O(files). The kind always uses the canonical
  // `deriveDispatchKind` (it is a projection over WHICH precedence branch
  // fired) — independent of any test-injected `resolveSkill`.
  const kindCache = new Map<string, DispatchKind>();

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
      let kind = kindCache.get(sessionId);
      if (skill === undefined || kind === undefined) {
        // Resolve BOTH from the same first-user-message text (one extraction).
        const firstText = firstUserMessageText(lines);
        skill = resolveSkill(firstText);
        kind = deriveDispatchKind(firstText);
        skillCache.set(sessionId, skill);
        kindCache.set(sessionId, kind);
      }
      const row = (bySkillByModel[skill] ??= emptyByModel());
      const kindRow = byDispatchKind[kind];
      for (const f of MODEL_FAMILIES) {
        addBreakdown(row[f], fileByFamily7d[f]);
        addBreakdown(kindRow[f], fileByFamily7d[f]);
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

  const oauth = await oauthPromise;

  return {
    acc5h,
    acc7d,
    byModel5h,
    byModel7d,
    byModel24h,
    bySkillByModel,
    byDispatchKind,
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
        };
      }
    : () => readOAuthCached(opts.readUsage, opts.nowMs);
}

/** Re-export the production defaults the coordinator wires in. */
export { projectsRoot, readOAuthUsage };

// Re-export the OAuth backoff/cache seam surface from its new focused leaf
// (issue #2923) at the SAME names this module used to own, so existing importers
// of `./transcript-scan.ts` — `usage-tracker.ts` and `test/usage-tracker.test.mts`
// — keep resolving unchanged. The canonical owner is now `./oauth-read-cache.ts`;
// new code should import directly from there.
export {
  setOAuthBackoffPersistence,
  oauthBackoffDelayMs,
} from "./oauth-read-cache.ts";
export type { OAuthBackoffPersistence } from "./oauth-read-cache.ts";
// `CachedOAuthRead` is already imported as a type above for `makeReadOAuth`'s
// signature; re-export that local binding rather than re-fetching it.
export type { CachedOAuthRead };
