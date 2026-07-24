/**
 * Design-concept Redis seam — typed accessors for the design-concept
 * persistence layer (issue #437) and its exempt-log audit trail (issue
 * #464). ADR-0009 closure follow-up.
 *
 * Surfaces:
 *   1. Per-anchor DC hash       — `hydra:design-concept:{anchorRef}`
 *   2. DC index ZSET            — `hydra:design-concept:index` (score = createdAt epoch ms)
 *   3. Exempt-log audit list    — `hydra:dc:exempt_log` (LPUSH-ed JSON entries)
 *   4. Daily snapshot HASH      — `hydra:dc:daily-snapshot` (issue #628; field=YYYY-MM-DD UTC, value=per-day production count since #736 — was index size)
 */

import { getRedisConnection } from "./connection.ts";

/**
 * Redis LIST holding `design-concept-exempt` audit entries. Newest-first
 * via LPUSH on write; LRANGE 0..limit-1 on read.
 */
const EXEMPT_LOG_KEY = "hydra:dc:exempt_log";

const DC_INDEX_KEY = "hydra:design-concept:index";

/**
 * Daily-snapshot HASH (issue #628; semantics revised in #736). Fields are
 * ISO date strings (YYYY-MM-DD, UTC); values are the per-day *production
 * count* — how many design concepts were CREATED that day
 * (`getDesignConceptProductionCountForDate`), NOT the `ZCARD` of the
 * currently-live index. The green-light criterion reads these values; the
 * production count is durable per day, so a quiet day no longer zeroes a
 * previously-earned green day (the #736 promotion-clock bug). The HASH is
 * opportunistically pruned to MAX_SNAPSHOT_DAYS entries on every write, so
 * it stays bounded.
 */
const DC_DAILY_SNAPSHOT_KEY = "hydra:dc:daily-snapshot";

/** How many days of snapshots we keep. 14d > 7d window, gives one
 *  retry-buffer if the snapshot tick is skipped on a given day. */
const MAX_SNAPSHOT_DAYS = 14;

function dcHashKey(anchorRef: string): string {
  return `hydra:design-concept:${anchorRef}`;
}

/**
 * Canonicalize an anchorRef to the `issue-<N>` form used end-to-end by the
 * autopilot signal path (issue #736). This is a *keying* concern, so it
 * lives in the persistence seam (ADR-0018): every accessor that uses
 * `anchorRef` in a key-shaped position normalizes the parameter at function
 * ENTRY, so the hash key suffix and the index ZSET member can never disagree.
 *
 * The wedge: the grill/writer sometimes persists under a bare issue number
 * (`"736"` → key `hydra:design-concept:736`), but every reader — the
 * autopilot's `orch_pending_grill_anchor` signal, `collect-state.sh`'s
 * `/api/design-concepts/issue-<N>` probe, the slot `anchor` field, and
 * candidate refs — uses the `issue-<N>` form. The mismatch orphaned the
 * artifact: `GET /api/design-concepts/736` → 200, `GET .../issue-736` → 404,
 * so `design_concept_orch` re-grilled forever and `dev_orch` was starved.
 *
 * Normalizing at the persistence seam (used by BOTH write and read) makes
 * the round-trip total: a bare `"736"` and the dispatched `"issue-736"`
 * resolve to the same canonical key `issue-736`, regardless of which form
 * the caller supplies. Non-issue refs (kanban titles, work-queue
 * descriptions, the `test:*` refs) are passed through unchanged.
 *
 * Rules:
 *   - `"736"` (pure digits)        → `"issue-736"`
 *   - `"#736"` (leading hash)      → `"issue-736"`
 *   - `"issue-736"` (already canon)→ `"issue-736"` (idempotent)
 *   - `"PR-4: foo"`, `"some title"`→ unchanged (not an issue number)
 */
export function normalizeAnchorRef(anchorRef: string): string {
  if (typeof anchorRef !== "string") return anchorRef;
  const trimmed = anchorRef.trim();
  if (trimmed === "") return trimmed;
  // Already canonical: `issue-<digits>` (case-insensitive on the prefix).
  if (/^issue-\d+$/i.test(trimmed)) {
    return `issue-${trimmed.slice(trimmed.indexOf("-") + 1)}`;
  }
  // Bare issue number, optionally prefixed with `#` or `issue #`.
  const m = trimmed.match(/^(?:issue\s*)?#?(\d+)$/i);
  if (m) {
    return `issue-${m[1]}`;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// DC hash + index accessors
// ---------------------------------------------------------------------------

/**
 * Overwrite the design-concept hash with serialized field/value pairs,
 * stamp the TTL, and add the anchorRef to the date-scored index.
 *
 * `fields` is a flat array of alternating field/value strings (the same
 * shape `redis.hset` accepts).
 */
export async function saveDesignConceptHash(
  anchorRef: string,
  createdAt: number,
  fields: string[],
  ttlSeconds: number,
): Promise<void> {
  const r = getRedisConnection();
  // Canonicalize once at the seam so the hash key AND the index member agree
  // (ADR-0018 / issue #736).
  const canonicalRef = normalizeAnchorRef(anchorRef);
  const key = dcHashKey(canonicalRef);
  await r.hset(key, ...fields);
  await r.expire(key, ttlSeconds);
  await r.zadd(DC_INDEX_KEY, createdAt, canonicalRef);
}

/** Read the full DC hash for `anchorRef`. Returns {} when absent. */
export async function getDesignConceptHash(anchorRef: string): Promise<Record<string, string>> {
  const r = getRedisConnection();
  return r.hgetall(dcHashKey(normalizeAnchorRef(anchorRef)));
}

/** Update a single field on the DC hash (used by approval). */
export async function setDesignConceptField(
  anchorRef: string,
  field: string,
  value: string,
): Promise<void> {
  const r = getRedisConnection();
  await r.hset(dcHashKey(normalizeAnchorRef(anchorRef)), field, value);
}

/** Read every anchorRef in the DC index, newest-first. */
export async function listAllDesignConceptRefs(): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(DC_INDEX_KEY, 0, -1);
}

/** Read the most recent `limit` anchorRefs in the DC index, newest-first. */
export async function listRecentDesignConceptRefs(limit: number): Promise<string[]> {
  const r = getRedisConnection();
  return r.zrevrange(DC_INDEX_KEY, 0, Math.max(0, limit - 1));
}

/**
 * Drop an anchorRef from the DC index (used by stale-entry prune).
 *
 * Normalizes the argument to the canonical member form (`issue-<N>`) before
 * `zrem`, mirroring how every write path canonicalizes at the seam
 * (ADR-0018 / #736). A caller that passes a bare/`#`-prefixed ref therefore
 * evicts the canonically-stored member.
 *
 * NOTE (issue #3236): this canonicalizing removal cannot evict a **legacy
 * non-canonical** member (a bare `"705"` written to the index *before* the
 * #736 normalization landed) — normalizing `705`→`issue-705` targets a member
 * that isn't in the index. The stale-index prune (`pruneDesignConceptIndex` in
 * `design-concept.ts`) handles that case directly via
 * `removeExactDesignConceptFromIndex` below, which removes the raw member it
 * read verbatim. Keep THIS accessor canonicalizing so anchor-shaped callers
 * (approval, targeted deletes) hit the same member their save/get paths use.
 */
export async function removeDesignConceptFromIndex(anchorRef: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(DC_INDEX_KEY, normalizeAnchorRef(anchorRef));
}

/**
 * Remove an index member VERBATIM — no normalization (issue #3236).
 *
 * The prune path in `design-concept.ts` reads raw members straight out of the
 * ZSET (`listAllDesignConceptRefs` → `zrevrange`); when it decides a member is
 * stale it must remove *exactly that member string*, otherwise a legacy
 * non-canonical member (bare `"705"` from before the #736 normalization) is
 * un-prunable — `removeDesignConceptFromIndex` would normalize it to
 * `issue-705` and silently miss, leaving the index to bloat unbounded (168
 * members against 86 live hashes was the observed state). This accessor exists
 * so what prune READ is exactly what prune REMOVES. `zrem` is a no-op on an
 * absent member.
 */
export async function removeExactDesignConceptFromIndex(member: string): Promise<void> {
  const r = getRedisConnection();
  await r.zrem(DC_INDEX_KEY, member);
}

/** Append an exempt-log entry (JSON-serialized) to the audit list. */
export async function appendExemptLogEntry(entryJson: string): Promise<void> {
  const r = getRedisConnection();
  await r.lpush(EXEMPT_LOG_KEY, entryJson);
}

/** Read the most recent `limit` exempt-log entries newest-first. */
export async function readRecentExemptLogEntries(limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const r = getRedisConnection();
  return r.lrange(EXEMPT_LOG_KEY, 0, limit - 1);
}

// ---------------------------------------------------------------------------
// Daily snapshot accessors (issue #628)
// ---------------------------------------------------------------------------

/**
 * Read the current size of the DC index — `ZCARD` of the (currently-live)
 * artifact index. Retained for the `indexSizeNow` field on the snapshots
 * endpoint (an at-a-glance "how many artifacts are alive right now"), but
 * NO LONGER the basis of the green-light streak — see
 * `getDesignConceptProductionCountForDate` (issue #736).
 */
export async function getDesignConceptIndexSize(): Promise<number> {
  const r = getRedisConnection();
  return r.zcard(DC_INDEX_KEY);
}

/**
 * Count how many design concepts were CREATED on `date` (YYYY-MM-DD, UTC)
 * — the per-day *production count* that replaces `zcard`-of-index as the
 * daily-snapshot value (issue #736).
 *
 * The index ZSET is scored by `createdAt` (epoch ms), so a day's
 * production is the number of members whose score lands in
 * `[startOfDay, endOfDay)`. We read the score range directly via
 * `ZCOUNT`, which is O(log N) and never has to enumerate members.
 *
 * Why this and not `zcard`: the old metric counted artifacts *currently
 * alive*, which decays with the 7-day TTL — a single quiet day drained
 * the index toward zero and reset the promotion streak even though work
 * had been produced. A production count is monotone for a given day:
 * once an artifact is created on day D it contributed to D's count, and
 * the snapshot HASH records that number permanently (independent of
 * whether the artifact has since TTL'd out of the index).
 *
 * Caveat: because the index entry itself is pruned at the 7-day TTL, this
 * count is only accurate when read within the artifact's lifetime — which
 * is exactly when the heartbeat samples it (same-day). The snapshot HASH
 * is the durable record after that.
 */
export async function getDesignConceptProductionCountForDate(
  date: string,
): Promise<number> {
  const r = getRedisConnection();
  // `date` is a UTC YYYY-MM-DD string. Compute the [start, end) epoch-ms
  // bounds for that day. `Date.parse("2026-05-30")` is interpreted as UTC
  // midnight, which is what we want.
  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) return 0;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  // ZCOUNT is inclusive on both ends; use the exclusive `(` prefix on the
  // upper bound so an artifact created at exactly the next midnight counts
  // toward the following day, not this one.
  const n = await r.zcount(DC_INDEX_KEY, startMs, `(${endMs}`);
  return typeof n === "number" ? n : Number(n) || 0;
}

/**
 * Write today's snapshot value into the daily-snapshot HASH and prune
 * fields older than MAX_SNAPSHOT_DAYS. Idempotent on `date` — a second
 * call within the same day just overwrites the field.
 */
export async function writeDailySnapshot(date: string, count: number): Promise<void> {
  const r = getRedisConnection();
  await r.hset(DC_DAILY_SNAPSHOT_KEY, date, String(count));
  // Opportunistic prune so the HASH stays bounded. Sort fields by date
  // (lexical sort works because YYYY-MM-DD is monotonic), then drop
  // anything beyond MAX_SNAPSHOT_DAYS days from the newest entry.
  const all = await r.hkeys(DC_DAILY_SNAPSHOT_KEY);
  if (all.length <= MAX_SNAPSHOT_DAYS) return;
  const sorted = all.slice().sort(); // ascending; oldest first
  const dropCount = sorted.length - MAX_SNAPSHOT_DAYS;
  const toDrop = sorted.slice(0, dropCount);
  if (toDrop.length > 0) {
    await r.hdel(DC_DAILY_SNAPSHOT_KEY, ...toDrop);
  }
}

/**
 * Read all daily-snapshot fields. Returns an array of `{date, count}`
 * tuples newest-first. Callers compute the consecutive-non-zero day
 * count from this list (≥7 → green-light Phase C per issue #628).
 */
export async function readDailySnapshots(): Promise<Array<{ date: string; count: number }>> {
  const r = getRedisConnection();
  const raw = await r.hgetall(DC_DAILY_SNAPSHOT_KEY);
  const entries = Object.entries(raw)
    .map(([date, value]) => ({ date, count: Number(value) || 0 }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries;
}
