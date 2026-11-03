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

/** Append one entry: `RPUSH` then `LTRIM -500 -1`. Nothing else. */
export async function appendLifecycleEntry(
  repo: string,
  issue: number,
  entry: LifecycleJournalEntry,
): Promise<JournalWriteResult> {
  try {
    const r = getRedisConnection();
    const key = lifecycleJournalKey(repo, issue);
    await r.rpush(key, JSON.stringify(entry));
    await r.ltrim(key, -LIFECYCLE_JOURNAL_MAX_ENTRIES, -1);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] appendLifecycleEntry failed");
    return fail("appendLifecycleEntry", err);
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

/** Atomic `SET key value NX`, no TTL. A second open returns `claim-held`. */
export async function openDispatchClaim(
  repo: string,
  issue: number,
  claim: DispatchClaim,
): Promise<OpenClaimResult> {
  try {
    const r = getRedisConnection();
    const key = lifecycleClaimKey(repo, issue);
    const set = await r.set(key, JSON.stringify(claim), "NX");
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
 * Atomic compare-and-delete: GET + DEL in one script. With a non-empty ARGV[1]
 * the claim is deleted only when its `dispatchId` matches; otherwise `{0, raw}`.
 */
const CLOSE_CLAIM_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {1, ''} end
if ARGV[1] ~= '' then
  local ok, claim = pcall(cjson.decode, raw)
  if not ok or type(claim) ~= 'table' or claim['dispatchId'] ~= ARGV[1] then return {0, raw} end
end
redis.call('DEL', KEYS[1])
return {1, raw}
`;

/**
 * Atomically read and delete the claim. Returns the prior claim, or null when
 * none. With `expectedDispatchId`, a claim owned by another dispatch is left in
 * place and `{ ok:false, error: CLAIM_OWNER_MISMATCH }` is returned.
 */
export async function closeDispatchClaim(
  repo: string,
  issue: number,
  expectedDispatchId?: string,
): Promise<CloseClaimResult> {
  try {
    const r = getRedisConnection();
    const key = lifecycleClaimKey(repo, issue);
    const res = (await r.eval(CLOSE_CLAIM_LUA, 1, key, expectedDispatchId ?? "")) as [number, string];
    if (res[0] === 0) return { ok: false, error: CLAIM_OWNER_MISMATCH };
    const prior = parseClaim(res[1] === "" ? null : res[1]);
    return { ok: true, prior };
  } catch (err) {
    logger.error({ err }, "[lifecycle-journal] closeDispatchClaim failed");
    return fail("closeDispatchClaim", err);
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
