/**
 * Transcript Parse Memo — durable per-file JSONL-parse cache for the
 * TranscriptScan seam (issue #3805).
 *
 * `transcriptScan()` (`src/cost/transcript-scan.ts`) re-derived the rolling
 * 7-day usage aggregate from raw transcripts on every cold call — reading and
 * `JSON.parse`-ing every in-window file's bytes even though transcripts are
 * append-only and immutable once a session ends. Measured 2026-07-30: 1,875 MB
 * read + parsed per cold call, which caused `/api/usage/eligibility` to blow
 * the Pace Gate's 10s probe budget (>90s, zero bytes) and fail-safe 104
 * consecutive times over three days.
 *
 * This seam persists a `path -> parsed contribution` map to a single Redis
 * hash (`hydra:metrics:transcript-parse-memo`, field=absolute transcript path,
 * value=JSON-encoded {@link FileParseMemoEntry}) through the ADR-0009 typed
 * accessor, mirroring the existing `source-index.ts` single-hash dedup
 * precedent. The scan reads the WHOLE hash once at the top of a walk (one
 * round trip) and writes back changed/evicted entries via ONE pipelined batch
 * at the end (a second round trip) — never a per-file Redis call, so a
 * corpus-wide cold scan doesn't trade 47k file reads for 47k Redis round
 * trips.
 *
 * Deliberately its OWN focused leaf rather than folded into the issue's
 * originally-proposed `src/redis/usage-snapshots.ts`: that module owns a
 * ~4-5-entry-lifetime weekly aggregate blob (one key per ISO-week), a
 * different access pattern and cardinality from this O(files-in-corpus)
 * point-lookup cache. Mirrors the existing extraction precedent
 * (`oauth-read-cache.ts`, `token-breakdown.ts` were each split out of
 * `transcript-scan.ts` for the same reason).
 *
 * Deliberately domain-agnostic (structural types only, no import from
 * `src/cost/*`): the one-way import direction stays `src/cost/transcript-scan.ts`
 * imports FROM this seam, never the reverse (same posture as every other
 * `src/redis/*` accessor). Deep semantic validation of `family`/`skill`/
 * `dispatchKind` values against the Cost Module's live vocabulary is the
 * CALLER's job (transcript-scan.ts already owns `MODEL_FAMILIES` /
 * `DISPATCH_KINDS`); this module only checks the JSON shape is well-formed.
 *
 * A cache is never load-bearing for correctness: a miss, a corrupt entry, or a
 * Redis outage all degrade to an empty map / a no-op write, logged via
 * `logger.error` per the repo's fail-loud convention — never thrown. The
 * caller's fallback is to fully re-parse the file, exactly as if the memo
 * didn't exist.
 */

import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";

/** Single hash holding the whole `path -> parsed contribution` map. */
function transcriptParseMemoKey(): string {
  return "hydra:metrics:transcript-parse-memo";
}

/**
 * One usage-bearing transcript line's parsed contribution, structurally
 * mirroring `TokenBreakdown` (`src/cost/token-math.ts`) without importing it
 * (this seam stays domain-agnostic). `family` is only meaningful when
 * `foreign` is false; carried as a plain `string` here (not the `ModelFamily`
 * union) so this module has no compile-time dependency on the Cost Module's
 * vocabulary — the caller validates it against `MODEL_FAMILIES` on read.
 *
 * Lines whose timestamp fell OUTSIDE the 7-day window at parse time are never
 * stored — a window can only ever narrow toward "now" on a later read (the
 * scan's cutoffs only move forward), so an entry excluded once stays
 * permanently irrelevant. `tsMs`-ascending is not required by any reader
 * (each entry re-tested independently against the live cutoffs on replay).
 */
export interface MemoLineEntry {
  tsMs: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
  };
  foreign: boolean;
  family: string;
}

/**
 * The full persisted parse of one transcript file, keyed in the hash by its
 * absolute path. `size`+`mtimeMs` are the cache-validity pair (issue #3805
 * constraint: never key on `mtimeMs` alone — a same-millisecond append is
 * possible and would otherwise serve a stale, too-small total). `skill` /
 * `dispatchKind` are the session-level attribution `transcriptScan()` resolved
 * for this file AT WRITE TIME (an accepted narrow inconsistency: a later scan
 * that would resolve a different first-encountered shard for the same session
 * keeps using this file's original attribution on a memo hit — never affects
 * the `acc5h`/`acc7d`/`byModel*`/`tokens24h` totals the Pace Gate gates on,
 * only the `bySkillByModel`/`byDispatchKind` cross-tabs). `null` means the
 * file had no in-window Anthropic content to attribute (it may still carry
 * `entries` for foreign-provider lines).
 */
export interface FileParseMemoEntry {
  size: number;
  mtimeMs: number;
  entries: MemoLineEntry[];
  skill: string | null;
  dispatchKind: string | null;
  observedResetMs: number | null;
  linesParsed: number;
  linesWithUsage: number;
  parseErrors: number;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidTokenBreakdown(v: unknown): v is MemoLineEntry["tokens"] {
  if (!isPlainRecord(v)) return false;
  return (
    typeof v.input === "number" &&
    typeof v.output === "number" &&
    typeof v.cacheRead === "number" &&
    typeof v.cacheCreation === "number" &&
    typeof v.total === "number"
  );
}

function isValidMemoLineEntry(v: unknown): v is MemoLineEntry {
  if (!isPlainRecord(v)) return false;
  return (
    typeof v.tsMs === "number" &&
    typeof v.foreign === "boolean" &&
    typeof v.family === "string" &&
    isValidTokenBreakdown(v.tokens)
  );
}

/**
 * Structural validation ONLY (JSON shape, not domain vocabulary) — a corrupt
 * or foreign-shaped value degrades to a clean miss, mirroring
 * `readWeeklyUsageSnapshot`'s corrupt-value discipline in `usage-snapshots.ts`.
 */
function parseMemoEntry(raw: string): FileParseMemoEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(v)) return null;
  if (typeof v.size !== "number" || typeof v.mtimeMs !== "number") return null;
  if (!Array.isArray(v.entries) || !v.entries.every(isValidMemoLineEntry)) return null;
  if (v.skill !== null && typeof v.skill !== "string") return null;
  if (v.dispatchKind !== null && typeof v.dispatchKind !== "string") return null;
  if (v.observedResetMs !== null && typeof v.observedResetMs !== "number") return null;
  if (
    typeof v.linesParsed !== "number" ||
    typeof v.linesWithUsage !== "number" ||
    typeof v.parseErrors !== "number"
  ) {
    return null;
  }
  return v as unknown as FileParseMemoEntry;
}

/**
 * Load the full persisted `path -> FileParseMemoEntry` map in ONE round trip.
 * A structurally-corrupt field is skipped individually (logged, non-fatal) —
 * the caller sees that path as a clean miss and falls back to a full parse of
 * just that file. Returns an empty map on a miss (never-persisted) OR on any
 * Redis error, so a persistence outage degrades to the pre-memo behaviour
 * (every file re-parsed), never a crash.
 */
export async function loadTranscriptParseMemo(): Promise<Map<string, FileParseMemoEntry>> {
  const out = new Map<string, FileParseMemoEntry>();
  try {
    const r = getRedisConnection();
    const raw: Record<string, string> = await r.hgetall(transcriptParseMemoKey());
    for (const [path, json] of Object.entries(raw ?? {})) {
      const entry = parseMemoEntry(json);
      if (entry !== null) {
        out.set(path, entry);
      } else {
        logger.error({ path }, "[transcript-parse-memo] dropping structurally-corrupt entry");
      }
    }
    return out;
  } catch (err: any) {
    logger.error({ err }, "[transcript-parse-memo] load failed; scanning cold");
    return new Map();
  }
}

/**
 * Write back changed/new entries and evict aged-out ones in ONE pipelined
 * round trip. Best-effort: a write failure only costs the NEXT scan a
 * redundant re-parse of whatever didn't persist — the just-computed
 * `ScanResult` this batch is trying to cache is already correct and already
 * returned to the caller, so a write failure here never invalidates anything
 * already handed back. No-op when both maps are empty (the common warm-scan
 * case where nothing changed).
 */
export async function writeTranscriptParseMemoBatch(
  upserts: ReadonlyMap<string, FileParseMemoEntry>,
  deletes: readonly string[],
): Promise<void> {
  if (upserts.size === 0 && deletes.length === 0) return;
  try {
    const r = getRedisConnection();
    const key = transcriptParseMemoKey();
    const pipeline = r.pipeline();
    for (const [path, entry] of upserts) {
      pipeline.hset(key, path, JSON.stringify(entry));
    }
    if (deletes.length > 0) {
      pipeline.hdel(key, ...deletes);
    }
    await pipeline.exec();
  } catch (err: any) {
    logger.error(
      { upserts: upserts.size, deletes: deletes.length, err },
      "[transcript-parse-memo] batch write failed",
    );
  }
}

/**
 * Count the persisted entries (diagnostics / tests — issue #3805). Best-effort:
 * returns 0 on any Redis error.
 */
export async function countTranscriptParseMemoEntries(): Promise<number> {
  try {
    const r = getRedisConnection();
    const n = await r.hlen(transcriptParseMemoKey());
    return typeof n === "number" ? n : 0;
  } catch (err: any) {
    logger.error({ err }, "[transcript-parse-memo] count failed");
    return 0;
  }
}
