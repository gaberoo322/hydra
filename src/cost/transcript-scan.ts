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
  getOAuthUsageBackoffBaseMs,
  getOAuthUsageBackoffMaxMs,
  getWeeklyResetAnchorMs,
} from "./config.ts";
import {
  readOAuthBackoff,
  writeOAuthBackoff,
  clearOAuthBackoff,
} from "../redis/oauth-backoff.ts";
import type { PersistedOAuthBackoff } from "../redis/oauth-backoff.ts";

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
 * Exponential-backoff state for the OAuth meter GET (issue #2619). Before this,
 * every post-TTL scan UNCONDITIONALLY re-attempted the external GET, so a
 * sustained 429 produced ~1–2 GETs/min (~90–100 failed reads/hour) that kept
 * hammering an already rate-limited endpoint. Now a failed GET records the
 * failure count and a `nextAttemptMs` gate; while `now < nextAttemptMs` the
 * external GET is SKIPPED (the last-good stale value is served if still within
 * TTL+maxStale, else the estimate) — so the re-probe cadence backs off
 * exponentially (`base * 2^(failures-1)`, capped) instead of firing per-scan.
 * A SUCCESSFUL read resets this to the zero-value, restoring the healthy fixed
 * TTL cadence immediately. `null` means "no active backoff" (healthy or never
 * failed). Only a SUCCESSFUL read clears it; failures grow it. Nulled by
 * {@link clearOAuthCache} for test isolation.
 */
interface OAuthBackoffState {
  /** Consecutive failed-GET count since the last success (>= 1 while active). */
  failures: number;
  /** Epoch-ms before which no external GET is attempted (the backoff gate). */
  nextAttemptMs: number;
}

let oauthBackoff: OAuthBackoffState | null = null;

/**
 * Backoff-state persistence side-channel (issue #2840). The exponential-backoff
 * gate above is process-in-memory only, so every `systemctl restart` (deploy,
 * crash-recovery, cooldown) wiped it — a sustained 429 wave that had backed off
 * to the ceiling was RESET to consecutive-failure #1 on the next boot, which
 * immediately re-GET the still-rate-limited endpoint and re-armed from 30s (the
 * recurrence #2840 reports despite the #2669 single-flight fix). This adapter
 * HYDRATES the in-memory gate from Redis on the first cached-path read after a
 * process start and MIRRORS every change (arm/advance/clear) back, so a restart
 * RESUMES the ladder. It is a pure side-channel: the cadence decision stays
 * driven by the in-memory `oauthBackoff`; this only seeds it at boot and writes
 * through.
 *
 * ONLY the PURE PRODUCTION cached path persists (invariant 5): the deterministic
 * `bypassOAuthCache` / injected-reader test path is untouched by persistence. So
 * the default adapter is a NO-OP; `getUsage`/`makeReadOAuth` install the real
 * {@link ../redis/oauth-backoff.ts} seam only when no reader/root is injected.
 * Tests that want to assert persistence explicitly inject a fake store via
 * {@link setOAuthBackoffPersistence}.
 */
export interface OAuthBackoffPersistence {
  read: () => Promise<PersistedOAuthBackoff | null>;
  write: (state: PersistedOAuthBackoff) => Promise<void>;
  clear: () => Promise<void>;
}

/** The live {@link ../redis/oauth-backoff.ts} seam — installed on the pure production path. */
const REDIS_OAUTH_BACKOFF_PERSISTENCE: OAuthBackoffPersistence = {
  read: readOAuthBackoff,
  write: writeOAuthBackoff,
  clear: clearOAuthBackoff,
};

/**
 * The no-op persistence adapter — the DEFAULT. Keeps the injected-reader /
 * fixture-root test path Redis-free (invariant 5): hydrate reads nothing, writes
 * and clears are no-ops. The pre-existing #1090/#1124/#2832 tests drive the
 * `useOAuthCache:true` cached path with an injected reader and MUST NOT touch
 * Redis; this default guarantees that unless a test opts in.
 */
const NOOP_OAUTH_BACKOFF_PERSISTENCE: OAuthBackoffPersistence = {
  read: async () => null,
  write: async () => {},
  clear: async () => {},
};

let oauthBackoffPersistence: OAuthBackoffPersistence = NOOP_OAUTH_BACKOFF_PERSISTENCE;

/**
 * True once the in-memory gate has been seeded from the persistence side-channel
 * for THIS process (issue #2840). Hydrate runs at most once per process (reset
 * by {@link clearOAuthCache} for test isolation); after that the in-memory gate
 * is authoritative and every mutation writes through. A hydrate FAILURE still
 * flips this true (fail-open: we tried once, degrade to in-memory-only), so a
 * Redis outage costs exactly one best-effort read, never a per-scan retry.
 */
let oauthBackoffHydrated = false;

/**
 * Install the backoff-persistence side-channel (issue #2840). Called by
 * `getUsage()` with {@link REDIS_OAUTH_BACKOFF_PERSISTENCE} ONLY on the pure
 * production path, so the injected-reader / fixture-root test path stays on the
 * default no-op adapter (invariant 5). Tests may inject a fake store to assert
 * hydrate-on-start / write-on-change without a live Redis; passing nothing
 * restores the no-op default. Always resets the per-process hydrate flag so the
 * next cached-path read re-seeds from the (possibly newly-installed) store —
 * mirroring a fresh process boot.
 */
export function setOAuthBackoffPersistence(store?: OAuthBackoffPersistence): void {
  installOAuthBackoffPersistence(store ?? NOOP_OAUTH_BACKOFF_PERSISTENCE);
}

/**
 * Install a persistence adapter, re-arming the per-process hydrate ONLY when the
 * adapter reference actually changes (issue #2840). `getUsage()` calls this every
 * scan with the same production-seam reference, so hydrate stays a genuine
 * once-per-process seed rather than re-firing every 60s — while a test swapping
 * in a fresh fake store (a distinct reference) correctly re-hydrates.
 */
function installOAuthBackoffPersistence(store: OAuthBackoffPersistence): void {
  if (store === oauthBackoffPersistence) return;
  oauthBackoffPersistence = store;
  oauthBackoffHydrated = false;
}

/**
 * Hydrate the in-memory backoff gate from the persistence side-channel, ONCE per
 * process (issue #2840). No-op after the first call (or after a `clearOAuthCache`
 * reset). Fails OPEN: any read error degrades to no persisted state (the
 * pre-#2840 fresh-start behaviour) and still marks hydrated so we never retry
 * per-scan. Clamps a persisted `nextAttemptMs` to the CURRENT backoff MAX
 * ceiling (`nowMs + maxMs`) so a stale/hostile stored value can never park the
 * meter longer than a freshly-armed max-backoff would — persistence resumes the
 * ladder, it never EXTENDS the staleness ceiling. Only seeds when the in-memory
 * gate is still null (never overwrites an already-armed live gate) AND the
 * persisted gate is still in the future (a resumed gate whose window already
 * elapsed is dropped so the next scan re-probes immediately).
 */
async function hydrateOAuthBackoff(nowMs: number): Promise<void> {
  if (oauthBackoffHydrated) return;
  oauthBackoffHydrated = true; // fail-open: one attempt, then in-memory-only
  let persisted: PersistedOAuthBackoff | null;
  try {
    persisted = await oauthBackoffPersistence.read();
  } catch (err: any) {
    // Defence-in-depth: the seam already never throws, but a test double might.
    console.error(`[usage-tracker] OAuth backoff hydrate failed (in-memory-only): ${err?.message || err}`);
    return;
  }
  if (persisted === null) return;
  if (oauthBackoff !== null) return; // a live gate already armed this process — don't clobber it
  const maxMs = getOAuthUsageBackoffMaxMs();
  // Clamp the resumed gate so persistence can never extend the staleness ceiling
  // past a freshly-armed max backoff.
  const clampedNext = Math.min(persisted.nextAttemptMs, nowMs + maxMs);
  if (clampedNext <= nowMs) {
    // The persisted window has already elapsed — the next scan should re-probe
    // now, not resume a spent gate. Drop it (and clear the stale key).
    void oauthBackoffPersistence.clear();
    return;
  }
  oauthBackoff = { failures: persisted.failures, nextAttemptMs: clampedNext };
  console.error(
    `[usage-tracker] OAuth backoff resumed from persistence: failure #${persisted.failures}, ` +
      `next GET in ${clampedNext - nowMs}ms (restart did not reset the ladder — issue #2840)`,
  );
}

/**
 * Single-flight guard for the OAuth meter GET (issue #2666). Before this, two
 * scans arriving in the same instant past TTL expiry EACH fired their own GET
 * (journalctl 2026-07-02 shows every 429 as a same-second duplicate pair) —
 * burning two rate-limit bucket slots per TTL expiry and double-arming the
 * backoff (instantly advancing it to consecutive-failure #2). Now the first
 * post-TTL caller launches the read and stores its promise here; concurrent
 * callers AWAIT AND SHARE that in-flight outcome instead of launching a second
 * GET. Semantically safe: both scans would have received the same meter value
 * anyway, and ageMs skew is bounded by the GET duration (≤5s timeout). Applies
 * ONLY to the production cached path (`readOAuthCached`) — the
 * `bypassOAuthCache` test path keeps the #1083 deterministic fresh-each-call
 * contract. Nulled by {@link clearOAuthCache} for test isolation.
 */
let oauthInFlight: Promise<CachedOAuthRead> | null = null;

/**
 * Null the module-level OAuth last-good cache AND the backoff state (issue
 * #2619) AND the single-flight in-flight promise (issue #2666).
 * `clearUsageCache()` in `usage-tracker.ts` calls this so its single
 * reset entry point continues to null the snapshot cache, the oauthCache, and
 * the backoff clock, even though the latter two now live here (issue #1971).
 * Test isolation depends on this. (issue #1090, #2619, #2666)
 */
export function clearOAuthCache(): void {
  oauthCache = null;
  oauthBackoff = null;
  oauthInFlight = null;
  // Re-arm the per-process hydrate so the next cached-path read re-seeds the
  // gate from the persistence side-channel (issue #2840). Test isolation relies
  // on this: each test that drives the cached path re-hydrates from its own
  // injected store rather than inheriting a prior test's seeded gate.
  oauthBackoffHydrated = false;
}

/**
 * Compute the exponential-backoff delay for the Nth consecutive failure (issue
 * #2619): `base * 2^(failures-1)`, clamped to `maxMs`. Pure so the curve is
 * unit-testable. `failures` is >= 1 (the count AFTER incrementing for the
 * current failure). Exported for direct unit test.
 */
export function oauthBackoffDelayMs(failures: number, baseMs: number, maxMs: number): number {
  // 2^(failures-1), guarded so a huge failure count can't overflow into Infinity
  // before the min-clamp (a healthy system never gets near this, but fail-safe).
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  const delay = baseMs * 2 ** exponent;
  return Math.min(delay, maxMs);
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
  /**
   * The LAST-KNOWN successful OAuth meter value at the time of this read (issue
   * #2832 AC3), or `null` when the module has never seen a successful read (cold
   * cache) OR the injected bypass path is in use. Populated on EVERY cached-path
   * branch — fresh, served-stale, backoff-suppressed, and estimate-fallback —
   * INCLUDING the too-stale case where the cache is about to be evicted from the
   * HEADLINE (the value is captured BEFORE eviction). Distinct from what backs
   * the headline: on the estimate-fallback path `result.ok === false` (the
   * headline is the estimate) yet `lastKnownOAuth` can still carry the last real
   * meter reading, which is exactly the baseline the AC3 divergence detector
   * compares the fail-open estimate against. Carries the whole
   * {@link OAuthUsageData} (both windows) so the detector can compare against the
   * 7d utilization. A pure observability channel — nothing gates on it.
   */
  lastKnownOAuth: OAuthUsageData | null;
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
 *
 * Exponential backoff (issue #2619): once the TTL has expired, the external GET
 * is NO LONGER attempted on every scan. A failed GET arms the module-level
 * {@link oauthBackoff} gate; while `nowMs` is inside that gate the GET is
 * SKIPPED entirely (the last-good stale value is served if still trustworthy,
 * else the caller falls to the estimate), so a rate-limited endpoint is
 * re-probed on an exponential-backoff cadence (`base * 2^(failures-1)`, capped)
 * rather than being hammered ~1–2×/min. A SUCCESSFUL read clears the gate,
 * restoring the healthy fixed-TTL cadence immediately.
 *
 * Single-flight (issue #2666): concurrent post-TTL callers no longer each fire
 * a GET — the first launches {@link attemptOAuthRead} and parks its promise in
 * {@link oauthInFlight}; the rest await and share that outcome. Retry-After
 * honor (issue #2666): a rate-limited (429) failure whose parsed `retryAfterMs`
 * exceeds the exponential delay LENGTHENS the backoff gate to the server hint —
 * the hint can never shorten the exponential curve.
 */
async function readOAuthCached(
  readUsage: () => Promise<OAuthUsageResult>,
  nowMs: number,
): Promise<CachedOAuthRead> {
  const ttlMs = getOAuthUsageTtlMs();

  // Seed the in-memory backoff gate from the persistence side-channel on the
  // first cached-path read of this process (issue #2840). No-op after the first
  // call; fails open to in-memory-only on any error. Done BEFORE the backoff-gate
  // check below so a restart mid-outage RESUMES the ladder (does not reset it).
  await hydrateOAuthBackoff(nowMs);

  // Fresh cache hit: serve without an external GET. This is the cadence
  // decoupling — within the TTL the snapshot scan reuses the cached OAuth value
  // instead of GETting on every 60s refresh.
  if (oauthCache !== null && nowMs - oauthCache.storedAt < ttlMs) {
    return {
      result: { ok: true, data: oauthCache.data },
      stale: false,
      ageMs: nowMs - oauthCache.storedAt,
      lastKnownOAuth: oauthCache.data,
    };
  }

  // Backoff gate (issue #2619): the TTL has expired, but a recent failure has
  // us in an exponential-backoff window — SKIP the external GET rather than
  // hammer the rate-limited endpoint. Serve the last-good stale value if it is
  // still within TTL+maxStale; otherwise the synthetic failure below falls the
  // caller through to the estimate. This is the fix for the ~90–100 failed
  // reads/hour steady state: no GET is spent while backing off.
  if (oauthBackoff !== null && nowMs < oauthBackoff.nextAttemptMs) {
    // Capture the last-known real meter value for the AC3 divergence detector
    // (issue #2832) BEFORE any headline decision — it is the baseline the
    // fail-open estimate is compared against, independent of whether it is
    // fresh-enough to still back the headline.
    const lastKnownOAuth = oauthCache !== null ? oauthCache.data : null;
    if (oauthCache !== null) {
      const ageMs = nowMs - oauthCache.storedAt;
      if (ageMs < ttlMs + getOAuthUsageMaxStaleMs()) {
        return { result: { ok: true, data: oauthCache.data }, stale: true, ageMs, lastKnownOAuth };
      }
    }
    // No trustworthy last-good to serve as the HEADLINE: report the
    // backoff-suppressed state as a failure so the caller falls to the estimate
    // (never a silent 0). No GET was made — the whole point of the gate. The
    // last-known value (if any) still rides out on `lastKnownOAuth` for the
    // divergence detector even though it no longer backs the headline.
    return {
      result: { ok: false, code: "oauth-usage-non-2xx" },
      stale: false,
      ageMs: null,
      lastKnownOAuth,
    };
  }

  // Single-flight guard (issue #2666): a GET is already in flight — await and
  // share its outcome instead of launching a duplicate. This kills the
  // same-second duplicate 429 pairs (two bucket slots burned + backoff
  // double-armed) observed in journalctl 2026-07-02.
  if (oauthInFlight !== null) {
    return oauthInFlight;
  }

  const attempt = attemptOAuthRead(readUsage, nowMs, ttlMs);
  oauthInFlight = attempt;
  try {
    return await attempt;
  } finally {
    oauthInFlight = null;
  }
}

/**
 * The post-TTL, post-gate OAuth read attempt — the GET plus the
 * success/failure cache + backoff bookkeeping (lifted verbatim from
 * `readOAuthCached` for the issue #2666 single-flight wrapper; exactly one
 * invocation of this function is in flight process-wide on the production
 * cached path). Never throws — `readUsage` returns result objects.
 */
async function attemptOAuthRead(
  readUsage: () => Promise<OAuthUsageResult>,
  nowMs: number,
  ttlMs: number,
): Promise<CachedOAuthRead> {
  const result = await readUsage();
  if (isOAuthUsageOk(result)) {
    // Success — refresh the cache AND reset the backoff clock so the next reads
    // resume the healthy fixed-TTL cadence immediately (issue #2619 recovery).
    oauthCache = { data: result.data, storedAt: nowMs };
    if (oauthBackoff !== null) {
      console.error(
        `[usage-tracker] OAuth meter recovered after ${oauthBackoff.failures} ` +
          `consecutive failure(s); backoff cleared, resuming fixed-TTL cadence`,
      );
      oauthBackoff = null;
      // Clear the persisted gate too (issue #2840) so a restart right after
      // recovery does not resume a now-obsolete ladder. Fire-and-forget,
      // fail-open — the seam never throws and a stale key self-expires at TTL.
      void oauthBackoffPersistence.clear();
    }
    // A fresh success IS the last-known value.
    return { result, stale: false, ageMs: 0, lastKnownOAuth: result.data };
  }

  // Read failed. Arm/advance the exponential-backoff gate so subsequent scans
  // do NOT re-GET until the delay elapses (issue #2619). Each consecutive
  // failure doubles the delay up to the ceiling; a later success resets it.
  // Retry-After honor (issue #2666): a rate-limited (429) failure may carry the
  // server's parsed hint — it can only LENGTHEN the delay past the exponential
  // curve, never shorten it, so a lying `retry-after: 0` cannot restore
  // hammering. The hint is already clamped to the maxStale ceiling adapter-side.
  const failures = (oauthBackoff?.failures ?? 0) + 1;
  const exponentialMs = oauthBackoffDelayMs(
    failures,
    getOAuthUsageBackoffBaseMs(),
    getOAuthUsageBackoffMaxMs(),
  );
  const retryAfterMs = result.retryAfterMs;
  const delayMs = Math.max(retryAfterMs ?? 0, exponentialMs);
  oauthBackoff = { failures, nextAttemptMs: nowMs + delayMs };
  // Mirror the armed/advanced gate to the persistence side-channel (issue #2840)
  // so a restart while inside this window RESUMES the ladder instead of resetting
  // it to failure #1. Fire-and-forget, fail-open — the seam never throws.
  void oauthBackoffPersistence.write({ failures, nextAttemptMs: oauthBackoff.nextAttemptMs });
  console.error(
    `[usage-tracker] OAuth meter read failed (${result.code}); backing off ` +
      `${delayMs}ms before next GET (consecutive failure #${failures})` +
      (retryAfterMs !== undefined && retryAfterMs > exponentialMs
        ? ` — server Retry-After ${retryAfterMs}ms lengthened the ${exponentialMs}ms exponential delay`
        : ""),
  );

  // Capture the last-known real meter value for the AC3 divergence detector
  // (issue #2832) BEFORE any eviction below — it is the baseline the fail-open
  // estimate is compared against, so it must survive even the too-stale eviction
  // that drops the value from the HEADLINE.
  const lastKnownOAuth = oauthCache !== null ? oauthCache.data : null;

  // Serve the last-good value (now stale) instead of flipping to the estimate —
  // UNLESS it is older than TTL + maxStale, in which case it is too stale to
  // trust and we let the failure fall through to the estimate.
  if (oauthCache !== null) {
    const ageMs = nowMs - oauthCache.storedAt;
    if (ageMs < ttlMs + getOAuthUsageMaxStaleMs()) {
      return { result: { ok: true, data: oauthCache.data }, stale: true, ageMs, lastKnownOAuth };
    }
    // Too stale: evict so a future success starts a clean age clock, and fall
    // through to the failure (estimate). Logged so a sustained outage is visible.
    console.error(
      `[usage-tracker] OAuth last-good value is too stale (age ${ageMs}ms ≥ ` +
        `TTL+maxStale); falling through to the transcript estimate (last read: ${result.code})`,
    );
    oauthCache = null;
  }
  return { result, stale: false, ageMs: null, lastKnownOAuth };
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
  // cached-path test that would then hydrate from real Redis (invariant 5).
  if (opts.persistBackoff) {
    installOAuthBackoffPersistence(REDIS_OAUTH_BACKOFF_PERSISTENCE);
  } else if (oauthBackoffPersistence === REDIS_OAUTH_BACKOFF_PERSISTENCE) {
    installOAuthBackoffPersistence(NOOP_OAUTH_BACKOFF_PERSISTENCE);
  }
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
