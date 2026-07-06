/**
 * Attribution open-window Redis seam (issue #2632; split out of the former
 * mixed-concern `attribution.ts` in issue #2916).
 *
 * Owns ONLY the per-metric OPEN-window state: a single Redis HASH, one field per
 * window id, value = JSON {@link AttributionWindow}. This is the OPEN/CLOSE phase
 * state machine of the three-phase attribution model (subscribe.ts). It is NOT
 * part of the append-only ledger (`attribution-ledger.ts`) and it is NOT the
 * reverted-merge registry (`attribution-reverted.ts`) — the three state spaces
 * are orthogonal and each lives in its own module.
 *
 * The window hash deliberately carries NO TTL: open windows are transient and
 * self-draining (a closed window is `hdel`'d from here after its observation
 * rows land in the ledger), so the hash stays small without a reaper. Do not add
 * an expire here — that would be the #2632 durability regression.
 *
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`) — no `new Redis()`, no `redis/kv` import
 * outside `src/redis/`. Per CLAUDE.md conventions every function is best-effort:
 * a Redis error is logged with the `[attribution]` prefix and surfaces as a
 * structured result (or a silent no-op for cleanup), never a thrown exception.
 */

import { getRedisConnection } from "./connection.ts";

// ---------------------------------------------------------------------------
// Key builder (ADR-0009 — key shape lives in the seam).
// ---------------------------------------------------------------------------

/**
 * Open-window state hash (issue #2632). One field per window id, value = JSON
 * {@link AttributionWindow}. A HASH (not a LIST) so an open window is upsertable
 * / removable by id and survives a housekeeping-process restart — the same
 * durability rationale as the pending-enroll registry. This is the ONLY key the
 * window state machine reads/writes; it is NOT part of the append-only ledger
 * (windows are transient — closed windows are DELETED from here after their
 * observation rows land in the ledger).
 */
function attributionWindowsKey(): string {
  return "hydra:attribution:windows";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One OPEN per-metric attribution window persisted in Redis so it survives a
 * housekeeping-process restart (issue #2632). Opened when a merge lands, closed
 * when its own `closesAt` elapses. The window carries the BASELINE snapshot
 * captured at open time (mirrors `enrollHoldback`'s per-merge baseline) plus the
 * producer-class merge counts / scope / tier / merge-identity for the closed
 * window's observation rows. One window per LIVE leading metric so each metric
 * closes on its own duration (fast metric ≠ slow metric).
 */
export interface AttributionWindow {
  /** Stable id: `<metric>:<sourceCommitSha|prNumber>` (upsert key in the hash). */
  id: string;
  /** Leading-outcome name this window watches. */
  metric: string;
  /** Baseline value of `metric` captured at window open (null = dark at open). */
  baselineValue: number | null;
  /** Epoch ms the window opened. */
  openedAt: number;
  /** Epoch ms the window closes (open + this metric's configured duration). */
  closesAt: number;
  /** Producer-class → merge count over the window (`{}` = empty window). */
  classCounts: Record<string, number>;
  /** Scope tag of the window's activity. */
  scopeTouched: string;
  /** Representative tier of the window's merges, or null. */
  tier: number | null;
  /** PR numbers whose landing opened this window (for later voiding). */
  sourcePrNumbers: number[];
  /** Representative landing commit SHA, if known. */
  sourceCommitSha: string | null;
}

export type OpenWindowResult = { ok: true } | { ok: false; error: string };
export type ListWindowsResult =
  | { ok: true; windows: AttributionWindow[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Open (or upsert) a window, keyed by `window.id`. Idempotent on id: a second
 * open for the same metric+merge overwrites in place, never duplicates. Best-
 * effort — returns a structured result, never throws.
 */
export async function openWindow(window: AttributionWindow): Promise<OpenWindowResult> {
  if (!window.id) return { ok: false, error: "openWindow: id is required" };
  try {
    const r = getRedisConnection();
    await r.hset(attributionWindowsKey(), window.id, JSON.stringify(window));
    return { ok: true };
  } catch (err: any) {
    const msg = `[attribution] openWindow failed for ${window.id}: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * List every open window, sorted by `closesAt` ascending for a stable read. A
 * malformed field is skipped (logged) rather than sinking the whole read. Best-
 * effort — returns a structured result, never throws.
 */
export async function listOpenWindows(): Promise<ListWindowsResult> {
  try {
    const r = getRedisConnection();
    const hash = await r.hgetall(attributionWindowsKey());
    const windows: AttributionWindow[] = [];
    for (const [field, raw] of Object.entries(hash) as Array<[string, string]>) {
      try {
        windows.push(JSON.parse(raw) as AttributionWindow);
      } catch (err: any) {
        console.error(
          `[attribution] listOpenWindows: skipping malformed field ${field}: ${err?.message || String(err)}`,
        );
      }
    }
    windows.sort((a, b) => a.closesAt - b.closesAt);
    return { ok: true, windows };
  } catch (err: any) {
    const msg = `[attribution] listOpenWindows failed: ${err?.message || String(err)}`;
    console.error(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Remove a window once it has closed (its observation rows have landed in the
 * ledger). Best-effort cleanup — a stale field is harmless (a later close is a
 * no-op) and TTL-free because the hash is small and self-draining.
 */
export async function closeWindow(id: string): Promise<void> {
  try {
    const r = getRedisConnection();
    await r.hdel(attributionWindowsKey(), id);
  } catch (err: any) {
    /* intentional: removing a closed window is best-effort cleanup; a stale
       field just gets re-closed as a no-op on the next tick. */
    console.error(`[attribution] closeWindow failed for ${id}: ${err?.message || String(err)}`);
  }
}

/** Test-only: clear the open-window state. */
export async function _resetWindows(): Promise<void> {
  const r = getRedisConnection();
  await r.del(attributionWindowsKey());
}
