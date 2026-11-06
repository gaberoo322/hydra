/**
 * Lifecycle-journal Redis seam (ADR-0047 Decision 5, issue #5310).
 *
 * Two things, both keyed by `<repo>#<n>`:
 *   - the JOURNAL: an append-only per-issue LIST of lifecycle entries
 *     (`hydra:lifecycle:journal:<repo>#<n>`). Appends are `RPUSH` +
 *     `LTRIM -500 -1` and nothing else; there is no LSET / LREM / DEL here.
 *     No TTL while the issue is open; `EXPIRE 180d` on close; `PERSIST` on
 *     reopen.
 *   - the DISPATCH CLAIM: `hydra:lifecycle:claim:<repo>#<n>`, taken with one
 *     `SET NX` and NO TTL (reap / release / the stale arm close it).
 *
 * Not the CONTEXT.md "Journal Adapter" (journalctl) — a distinct concept.
 * Modelled on `attribution-ledger.ts`; the key builders stay local to the
 * seam (they are intentionally not in `keys.ts`). Every function is
 * best-effort and returns a result object, never throws (STD-VERIFY-NEVER-THROW).
 */
import { getRedisConnection } from "./connection.ts";
import { logger } from "../logger.ts";

export const LIFECYCLE_JOURNAL_MAX_ENTRIES = 500;
export const DEFAULT_JOURNAL_CLOSE_TTL_SECONDS = 180 * 24 * 60 * 60; // 15552000

/** Close-retention TTL; overridable like `ATTRIBUTION_LEDGER_TTL_SECONDS`. */
export function journalCloseTtlSeconds(): number {
  const raw = process.env.LIFECYCLE_JOURNAL_TTL_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_JOURNAL_CLOSE_TTL_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_JOURNAL_CLOSE_TTL_SECONDS;
}

export type JournalKind = "transition" | "refused" | "claim-opened" | "claim-closed" | "external";
export type JournalSource = "cli" | "operator-route" | "external" | "workflow";

export interface LifecycleJournalEntry {
  v: 1;
  ts: number;
  kind: JournalKind;
  from: string | null;
  to: string | null;
  source: JournalSource;
  actor: string;
  evidence: Record<string, string>;
  reason: string | null;
  rationale: string | null;
  result: string;
  written: boolean;
}

export interface DispatchClaim {
  dispatchId: string;
  class: string;
  run: string;
  artifactHash: string | null;
  openedAt: number;
}

export function lifecycleJournalKey(repo: string, issue: number): string {
  return `hydra:lifecycle:journal:${repo}#${issue}`;
}

export function lifecycleClaimKey(repo: string, issue: number): string {
  return `hydra:lifecycle:claim:${repo}#${issue}`;
}

export type JournalWriteResult = { ok: true } | { ok: false; error: string };

function fail(op: string, err: unknown): { ok: false; error: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `[lifecycle-journal] ${op} failed: ${message}` };
}

/**
 * Append one entry: `RPUSH` then `LTRIM -500 -1`. With `indexHoldExit` the
 * hold-exit index write (`ZADD` + trim) joins the SAME `MULTI`, so an
 * unsanctioned exit can never be journaled without being indexed (#5313).
 */
export async function appendLifecycleEntry(
  repo: string,
  issue: number,
  entry: LifecycleJournalEntry,
  indexHoldExit = false,
): Promise<JournalWriteResult> {
  try {
    const r = getRedisConnection();
    const key = lifecycleJournalKey(repo, issue);
    if (!indexHoldExit) {
      await r.rpush(key, JSON.stringify(entry));
      await r.ltrim(key, -LIFECYCLE_JOURNAL_MAX_ENTRIES, -1);
      return { ok: true };
    }
    const idxKey = holdExitIndexKey(repo);
    const results = await r
      .multi()
      .rpush(key, JSON.stringify(entry))
      .ltrim(key, -LIFECYCLE_JOURNAL_MAX_ENTRIES, -1)
      .zadd(idxKey, entry.ts, JSON.stringify(holdExitRecord(issue, entry)))
      .zremrangebyscore(idxKey, "-inf", entry.ts - HOLD_EXIT_RETENTION_MS)
      .exec();
    const failed = results?.find(([err]) => err !== null);
    if (results === null || failed) {
      return fail("appendLifecycleEntry", failed?.[0] ?? new Error("MULTI aborted"));
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] appendLifecycleEntry failed");
    return fail("appendLifecycleEntry", err);
  }
}

// ---------------------------------------------------------------------------
// Hold-exit index (ADR-0047 Decision 3, issue #5313)
// ---------------------------------------------------------------------------

export const HOLD_EXIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function holdExitIndexKey(repo: string): string {
  return `hydra:lifecycle:hold-exits:${repo}`;
}

export interface HoldExitRecord {
  issue: number;
  ts: number;
  from: string | null;
  to: string | null;
  source: JournalSource;
  actor: string;
}

function holdExitRecord(issue: number, entry: LifecycleJournalEntry): HoldExitRecord {
  return {
    issue,
    ts: entry.ts,
    from: entry.from,
    to: entry.to,
    source: entry.source,
    actor: entry.actor,
  };
}

/**
 * Index one unsanctioned human-hold exit: `ZADD` (score = entry ts) and drop
 * members older than 30d. The journal LIST itself stays RPUSH+LTRIM only.
 */
export async function recordHoldExit(
  repo: string,
  issue: number,
  entry: LifecycleJournalEntry,
): Promise<JournalWriteResult> {
  try {
    const r = getRedisConnection();
    const key = holdExitIndexKey(repo);
    await r.zadd(key, entry.ts, JSON.stringify(holdExitRecord(issue, entry)));
    await r.zremrangebyscore(key, "-inf", entry.ts - HOLD_EXIT_RETENTION_MS);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] recordHoldExit failed");
    return fail("recordHoldExit", err);
  }
}

export type ListHoldExitsResult =
  | { ok: true; exits: HoldExitRecord[] }
  | { ok: false; error: string };

/** Hold exits with `ts >= sinceMs`, oldest first; malformed members are skipped (logged). */
export async function listHoldExits(repo: string, sinceMs: number): Promise<ListHoldExitsResult> {
  try {
    const raw: string[] = await getRedisConnection().zrangebyscore(holdExitIndexKey(repo), sinceMs, "+inf");
    const exits: HoldExitRecord[] = [];
    for (const row of raw) {
      try {
        exits.push(JSON.parse(row) as HoldExitRecord);
      } catch (parseErr) {
        logger.error({ err: parseErr }, "[lifecycle-journal] skipping malformed hold-exit member");
      }
    }
    return { ok: true, exits };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] listHoldExits failed");
    return fail("listHoldExits", err);
  }
}

export type ReadJournalResult =
  | { ok: true; entries: LifecycleJournalEntry[] }
  | { ok: false; error: string };

/** Read the full journal in append order; malformed rows are skipped (logged). */
export async function readLifecycleJournal(repo: string, issue: number): Promise<ReadJournalResult> {
  try {
    const r = getRedisConnection();
    const raw: string[] = await r.lrange(lifecycleJournalKey(repo, issue), 0, -1);
    const entries: LifecycleJournalEntry[] = [];
    for (const row of raw) {
      try {
        entries.push(JSON.parse(row) as LifecycleJournalEntry);
      } catch (parseErr) {
        logger.error({ err: parseErr }, "[lifecycle-journal] skipping malformed journal row");
      }
    }
    return { ok: true, entries };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] readLifecycleJournal failed");
    return fail("readLifecycleJournal", err);
  }
}

/** Issue closed: start the 180d retention clock. */
export async function expireJournalOnClose(repo: string, issue: number): Promise<JournalWriteResult> {
  try {
    await getRedisConnection().expire(lifecycleJournalKey(repo, issue), journalCloseTtlSeconds());
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] expireJournalOnClose failed");
    return fail("expireJournalOnClose", err);
  }
}

/** Issue reopened: drop the retention clock (used by the #5316 reconcile path). */
export async function persistJournal(repo: string, issue: number): Promise<JournalWriteResult> {
  try {
    // PERSIST via eval: connection.ts's RedisClient type does not declare persist().
    await getRedisConnection().eval("return redis.call('PERSIST', KEYS[1])", 1, lifecycleJournalKey(repo, issue));
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] persistJournal failed");
    return fail("persistJournal", err);
  }
}

export type OpenClaimResult =
  | { ok: true; claim: DispatchClaim }
  | { ok: false; code: "claim-held"; existing: DispatchClaim | null }
  | { ok: false; code: "redis-failed"; error: string };

/**
 * Atomic `SET key value [EX ttl] NX`. A second open returns `claim-held`. No TTL
 * unless `ttlSeconds` is a positive integer: dispatcher- and worker-opened claims
 * pass one so a crash between claim and release can never strand an issue.
 */
export async function openDispatchClaim(
  repo: string,
  issue: number,
  claim: DispatchClaim,
  ttlSeconds?: number,
): Promise<OpenClaimResult> {
  try {
    const r = getRedisConnection();
    const key = lifecycleClaimKey(repo, issue);
    const set =
      ttlSeconds !== undefined && Number.isInteger(ttlSeconds) && ttlSeconds > 0
        ? await r.set(key, JSON.stringify(claim), "EX", ttlSeconds, "NX")
        : await r.set(key, JSON.stringify(claim), "NX");
    if (set === "OK") return { ok: true, claim };
    const existingRaw = await r.get(key);
    return { ok: false, code: "claim-held", existing: parseClaim(existingRaw) };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] openDispatchClaim failed");
    const f = fail("openDispatchClaim", err);
    return { ok: false, code: "redis-failed", error: f.error };
  }
}

export type CloseClaimResult =
  | { ok: true; prior: DispatchClaim | null }
  | { ok: false; error: string };

/** Error string returned when `expectedDispatchId` does not own the stored claim. */
export const CLAIM_OWNER_MISMATCH = "claim-owner-mismatch";

/**
 * Atomic compare-and-delete: GET + DEL in one script. The claim is deleted only
 * when its `dispatchId` equals ARGV[1]; otherwise `{0, raw}` (an empty ARGV[1]
 * never matches, so there is no unowned delete).
 */
const CLOSE_CLAIM_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {1, ''} end
local ok, claim = pcall(cjson.decode, raw)
if ARGV[1] == '' or not ok or type(claim) ~= 'table' or claim['dispatchId'] ~= ARGV[1] then return {0, raw} end
redis.call('DEL', KEYS[1])
return {1, raw}
`;

/**
 * Atomically read and delete the claim owned by `expectedDispatchId` (REQUIRED,
 * INV-11). Returns the prior claim, or null when none. A claim owned by another
 * dispatch is left in place and `{ ok:false, error: CLAIM_OWNER_MISMATCH }` is
 * returned.
 */
export async function closeDispatchClaim(
  repo: string,
  issue: number,
  expectedDispatchId: string,
): Promise<CloseClaimResult> {
  try {
    const r = getRedisConnection();
    const key = lifecycleClaimKey(repo, issue);
    const res = (await r.eval(CLOSE_CLAIM_LUA, 1, key, expectedDispatchId)) as [number, string];
    if (res[0] === 0) return { ok: false, error: CLAIM_OWNER_MISMATCH };
    const prior = parseClaim(res[1] === "" ? null : res[1]);
    return { ok: true, prior };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] closeDispatchClaim failed");
    return fail("closeDispatchClaim", err);
  }
}

export type ReadClaimResult =
  | { ok: true; claim: DispatchClaim | null }
  | { ok: false; error: string };

/** Read (never modify) the held dispatch claim, or `claim: null` when none. */
export async function readDispatchClaim(repo: string, issue: number): Promise<ReadClaimResult> {
  try {
    const raw = await getRedisConnection().get(lifecycleClaimKey(repo, issue));
    return { ok: true, claim: parseClaim(raw) };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] readDispatchClaim failed");
    return fail("readDispatchClaim", err);
  }
}

function parseClaim(raw: string | null): DispatchClaim | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as DispatchClaim;
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] malformed claim value");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reconcile report (ADR-0047 D5, issue #5316)
// ---------------------------------------------------------------------------

export function lifecycleReconcileKey(repo: string): string {
  return `hydra:lifecycle:reconcile:${repo}`;
}

/** Persist the latest reconcile report: a hash holding the JSON and its epoch-ms `ts`. */
export async function writeReconcileReport(
  repo: string,
  report: object,
  ts: number,
): Promise<JournalWriteResult> {
  try {
    await getRedisConnection().hset(lifecycleReconcileKey(repo), "json", JSON.stringify(report), "ts", String(ts));
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] writeReconcileReport failed");
    return fail("writeReconcileReport", err);
  }
}

export type ReadReconcileReportResult =
  | { ok: true; report: Record<string, unknown> | null; ts: number | null }
  | { ok: false; error: string };

/** Read the latest persisted reconcile report; `report: null` when none was ever written. */
export async function readReconcileReport(repo: string): Promise<ReadReconcileReportResult> {
  try {
    const hash = await getRedisConnection().hgetall(lifecycleReconcileKey(repo));
    if (!hash || typeof hash.json !== "string") return { ok: true, report: null, ts: null };
    const ts = Number(hash.ts);
    const parsed: unknown = JSON.parse(hash.json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: true, report: null, ts: null };
    }
    return { ok: true, report: parsed as Record<string, unknown>, ts: Number.isFinite(ts) ? ts : null };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] readReconcileReport failed");
    return fail("readReconcileReport", err);
  }
}
