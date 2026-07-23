/**
 * Autopilot lifecycle **result-type primitives** — the zero-I/O leaf that names
 * "what does a lifecycle operation's result look like?" at the lowest
 * abstraction level in the autopilot domain (issue #3087).
 *
 * These five symbols (`Ok<T>` / `Err` / `errRedis` / `numberOrDefault` /
 * `filesChangedCount`) were the single source of truth on the WRITE-lifecycle
 * Module `runs.ts` (the first four; `filesChangedCount` was a private helper on
 * the `cycle-close.ts` write coordinator and moved DOWN here in issue #3323 when
 * the dispatch-outcome extraction gave it a second importer). That kept them
 * out of an import cycle, but produced an import-direction inversion: the
 * pure-read `run-reads.ts` and the sibling write module `cycle-close.ts` had a
 * production import edge INTO the write module `runs.ts` purely to reach the
 * shared types — a read module depending on a write module.
 *
 * The correct shape is that BOTH the read and write modules import DOWN from
 * this lower-abstraction leaf, rather than the read module importing sideways
 * from the write module. This mirrors the `run-reads.ts` (issue #1183) and
 * `cycle-close.ts` (issue #2768) extractions, each of which correctly separated
 * concerns but left the shared type primitives in the wrong place.
 *
 * `runs.ts` imports the helpers and types it needs from here directly; the
 * back-compat re-exports it once carried were dropped (the value helpers in issue
 * #3144, the `Ok` / `Err` types in issue #3149) once no caller imported them from
 * `runs.ts`, so every caller now imports from this leaf. This leaf has NO Redis
 * dependency, no async I/O, and no module-level side effects — it imports nothing
 * from the autopilot domain.
 *
 * Result-object shape (the contract every lifecycle writer/reader returns):
 *
 *     type Result<T> =
 *       | { ok: true } & T
 *       | { ok: false; code: ErrorCode; detail?: string }
 *
 * ErrorCode is one of:
 *   - "duplicate"   — idempotent no-op (same run/turn/cycle already recorded)
 *   - "not-found"   — operating on a run/turn that doesn't exist
 *   - "invalid"     — caller-supplied data failed semantic validation
 *                     (route layer translates to HTTP 400; schema-level
 *                     errors are caught upstream by zod)
 *   - "redis"       — Redis error; `detail` carries the message
 *
 * `ErrorCode` itself stays module-internal here — it feeds the `Ok`/`Err` shapes
 * but has no external importer (cleanup-scan #2788 rationale, preserved).
 */

import { logger } from "../logger.ts";

type ErrorCode = "duplicate" | "not-found" | "invalid" | "redis";

export type Ok<T> = { ok: true; code?: undefined; detail?: undefined } & T;
export type Err = { ok: false; code: ErrorCode; detail?: string };

/**
 * Wrap a caught error as a `redis`-coded `Err`, logging the detail. The shared
 * fail-loud helper for the run/turn writers, the cycle-close coordinator, and
 * the read orchestrators — never throws.
 */
export function errRedis(err: any): Err {
  const detail = err?.message || String(err);
  logger.error({ err }, "[autopilot] redis error");
  return { ok: false, code: "redis", detail };
}

/**
 * Numeric coercion shared by the run/turn writers AND the sibling
 * `cycle-close.ts` (issue #2768). Zero-I/O: returns `v` when it is a finite
 * number or a parseable non-empty numeric string, else `fallback`.
 */
export function numberOrDefault(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Coerce a body value (number | numeric-string | absent) into a non-negative
 * integer COUNT, or `undefined` when the field is absent/garbage (issue #2063).
 * Zero-I/O, shared by the `cycle-close.ts` metrics path AND the extracted
 * `outcome-record.ts` dispatch-outcome leaf (issue #3323).
 *
 * Returning `undefined` — never 0 — for an absent field is what preserves the
 * "unknown / never-written" vs "measured zero" distinction the metrics
 * observability alerts need: an absent field is stripped from the metrics object
 * and never written, while an explicit 0 records a truthful zero. Negative /
 * non-finite inputs clamp to `undefined` (treated as unknown) so a malformed
 * positional can never write a nonsense count.
 */
export function filesChangedCount(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) return undefined;
    return Math.floor(v);
  }
  if (typeof v === "string") {
    if (v.length === 0) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.floor(n);
  }
  return undefined;
}
