/**
 * page-item-format.ts — the shared dashboard page-item seam's pure half
 * (issue #822). One relative-time + clock formatter and ONE palette table,
 * lifted out of the 4+ list-page components that each re-derived them.
 *
 * "Pure" matters: every export here is referentially transparent so
 * test/page-item-format.test.mts can pin behaviour at this seam without a
 * React tree (the same pattern now-pixel/battle-card-state.ts already uses —
 * the dashboard ships no JSX test runner, so load-bearing logic lives in .ts
 * and is asserted from the orchestrator node:test suite).
 *
 * Behaviour-preservation contract (issue #822 invariants)
 * -------------------------------------------------------
 * Before this seam each component had its own time formatter:
 *   - ActiveDispatches.formatAge(startedAt)  -> "Ns" | "Nm" | "Nh Nm"   (seconds floor)
 *   - OperatorDecisionQueue.relativeAge(iso) -> "Nm" | "Nh" | "Nd"      (minutes floor, <48h cap)
 *   - RecentMerges.formatMergedAt(iso)       -> locale HH:MM (24h)      (zero-date guarded)
 *   - AlertsNow.formatTime(ts)               -> locale time string      (try/catch guarded)
 * These are intentionally DIFFERENT shapes, so the seam exposes each as a
 * named formatter rather than collapsing them. The output of each is
 * byte-identical to the component it replaced on representative data.
 *
 * The palette table is the single source of truth for the emerald/sky/amber/
 * red/violet/yellow ramp that was hand-copied across the list pages. Badge
 * Modules (Badges.jsx) read their class strings off this table; unknown keys
 * fall through to ZINC_DEFAULT (no throw, no blank chip — preserving each
 * component's prior `|| zinc` fallback).
 */

/** The shared zinc fallback chip — what every component used as `|| zinc`. */
export const ZINC_DEFAULT = "bg-zinc-700/60 text-zinc-300 border-zinc-600";

/**
 * Monotonic tier ladder (ADR-0015 / issue #737): T1 shallowest (emerald) →
 * T4 deepest = Verifier Core (red). Legacy `0` rows (pre-renumber merges)
 * map to the same deepest-tier red so historical chips render unchanged.
 */
export const TIER_PALETTE: Record<number, string> = {
  1: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  2: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  3: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  4: "bg-red-500/10 text-red-300 border-red-500/30",
  0: "bg-red-500/10 text-red-300 border-red-500/30",
};

/** Dispatch source chip palette (ActiveDispatches). */
export const SOURCE_PALETTE: Record<string, string> = {
  autopilot: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  operator: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  subagent: "bg-violet-500/10 text-violet-300 border-violet-500/30",
};

/** Severity chip palette (AlertsNow). */
export const SEVERITY_PALETTE: Record<string, string> = {
  critical: "bg-red-500/10 text-red-300 border-red-500/30",
  error: "bg-red-500/10 text-red-300 border-red-500/30",
  warning: "bg-yellow-500/10 text-yellow-300 border-yellow-500/30",
  info: "bg-sky-500/10 text-sky-300 border-sky-500/30",
};

/**
 * Operator-attention source palette + short label (OperatorDecisionQueue).
 * Note: the prior component's SOURCE_STYLE fell through to "" (empty class),
 * NOT to ZINC_DEFAULT — preserved here so unknown sources render exactly as
 * before. Callers pass `""` as the fallback for this map.
 */
export const DECISION_SOURCE_PALETTE: Record<string, string> = {
  "operator-decision-queue": "bg-violet-500/10 text-violet-300 border-violet-500/30",
  "ready-for-human": "bg-yellow-500/10 text-yellow-300 border-yellow-500/30",
  "needs-info": "bg-sky-500/10 text-sky-300 border-sky-500/30",
};

export const DECISION_SOURCE_LABEL: Record<string, string> = {
  "operator-decision-queue": "queue",
  "ready-for-human": "human",
  "needs-info": "info",
};

/**
 * Look up a palette class for `key`, falling through to `fallback`
 * (defaults to ZINC_DEFAULT). Centralises the `palette[key] || fallback`
 * idiom so unknown/absent keys never throw and never render a blank chip.
 */
export function paletteClass(
  palette: Record<string | number, string>,
  key: string | number | null | undefined,
  fallback: string = ZINC_DEFAULT,
): string {
  if (key === null || key === undefined) return fallback;
  return palette[key] || fallback;
}

/**
 * Fine-grained age, seconds-floored: "Ns" (<60s), "Nm" (<1h, rounded),
 * "Nh Nm" (>=1h). Replaces ActiveDispatches.formatAge. Accepts an ISO
 * string (or anything Date.parse understands); returns "" for missing or
 * unparseable input.
 *
 * `now` is injectable for deterministic tests; defaults to Date.now().
 */
export function formatAge(startedAt: string | null | undefined, now: number = Date.now()): string {
  if (!startedAt) return "";
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "";
  const ageSec = Math.max(0, Math.floor((now - startedMs) / 1000));
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m`;
  return `${Math.floor(ageSec / 3600)}h ${Math.round((ageSec % 3600) / 60)}m`;
}

/**
 * Coarse age, minutes-floored: "Nm" (<60m), "Nh" (<48h), "Nd" (>=48h).
 * Replaces OperatorDecisionQueue.relativeAge. Returns "" for missing,
 * unparseable, or future timestamps (negative delta).
 *
 * `now` is injectable for deterministic tests; defaults to Date.now().
 */
export function relativeAge(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Wall-clock HH:MM (locale, 24h two-digit). Replaces
 * RecentMerges.formatMergedAt. Guards the epoch-zero / NaN dates that the
 * merges feed can emit. Returns "" for missing or zero-date input.
 */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getTime() === 0) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Full locale time string. Replaces AlertsNow.formatTime. Returns "" for
 * missing input or anything `new Date(...)` chokes on.
 */
export function formatTimeOfDay(ts: string | number | null | undefined): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    /* intentional: malformed timestamp renders as empty, never throws into the row */
    return "";
  }
}

/**
 * The em-dash the dashboard renders for an absent/invalid timestamp — a
 * single visible placeholder so a missing time reads as "—", never as a
 * blank gap or a thrown row. Shared by the local-time helpers below so
 * every current and future timestamp site guards uniformly.
 */
export const EMPTY_TIMESTAMP = "—";

/**
 * Normalise the two timestamp shapes the API emits into epoch-milliseconds:
 *   - a `number` is Unix epoch **seconds** (PokedexModal's `e.ts`, and every
 *     Redis `Date.now()/1000` feed) → multiplied by 1000
 *   - a `string` is ISO-8601 UTC (AlertsNow's `alert.timestamp`, the merges
 *     feed) → parsed via Date.parse
 * Returns `null` for null/undefined/empty/unparseable/epoch-zero input so the
 * callers below can render EMPTY_TIMESTAMP instead of ever throwing or
 * printing an "Invalid Date" string.
 *
 * Interpreting a bare number as *seconds* (not millis) is the deliberate
 * contract: it matches the two now-pixel `formatTime` helpers this seam
 * subsumes, and the API sends epoch-seconds everywhere.
 */
export function toEpochMs(ts: string | number | null | undefined): number | null {
  if (ts === null || ts === undefined || ts === "") return null;
  const ms = typeof ts === "number" ? ts * 1000 : Date.parse(ts);
  if (!Number.isFinite(ms) || ms === 0) return null;
  return ms;
}

/**
 * Compact local date + time in the **browser's timezone** (e.g. "6/1, 8:00 AM"
 * in America/New_York for a 12:00Z instant). Accepts an ISO-8601-UTC string
 * or Unix-epoch-seconds (see toEpochMs). Returns EMPTY_TIMESTAMP for
 * missing/invalid input, never throws.
 *
 * `toLocaleString` with an explicit options bag (no explicit `timeZone`)
 * renders in the host's local zone by design — this is the single source of
 * truth that makes every migrated site local-by-default.
 */
export function formatDateTime(ts: string | number | null | undefined): string {
  const ms = toEpochMs(ts);
  if (ms === null) return EMPTY_TIMESTAMP;
  try {
    return new Date(ms).toLocaleString([], {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    /* intentional: never throw into a row; a locale/options edge renders as em-dash */
    return EMPTY_TIMESTAMP;
  }
}

/**
 * Full local date + time in the browser's timezone — the disambiguating form
 * carried in the hover `title` tooltip (weekday + year + seconds). Same input
 * contract as formatDateTime; returns "" (empty title) rather than an em-dash
 * for absent input, since an empty `title` attribute reads as "no tooltip"
 * while "—" would render a stray tooltip on hover.
 */
export function formatDateTimeFull(ts: string | number | null | undefined): string {
  const ms = toEpochMs(ts);
  if (ms === null) return "";
  try {
    return new Date(ms).toLocaleString([], {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    /* intentional: never throw; a locale/options edge yields no tooltip */
    return "";
  }
}

/**
 * The pure props a `<LocalTimestamp>` needs: the compact string the row shows
 * and the full string its hover `title` carries. Extracting this into the
 * pure seam lets node:test pin the timezone-conversion + guard behaviour
 * without a React tree (the same reason the formatters above live here).
 */
export interface LocalTimestampParts {
  /** Compact local date+time (formatDateTime) — what the cell renders. */
  compact: string;
  /** Full local date+time (formatDateTimeFull) — the hover-title tooltip. */
  title: string;
}

/** Build both display strings for one timestamp in a single call. */
export function localTimestampParts(ts: string | number | null | undefined): LocalTimestampParts {
  return { compact: formatDateTime(ts), title: formatDateTimeFull(ts) };
}

// ---------------------------------------------------------------------------
// Trust-contract status derivation (ADR-0034 §5, issue #4006)
// ---------------------------------------------------------------------------

/**
 * The trust-aware status enum a page-item payload resolves to (ADR-0034 §5).
 * Extends the original loading / error / empty / ready quartet with two states
 * the trust contract requires:
 *
 *   - `unknown` — the payload is not trustworthy enough to render a value
 *     (failed first load, an unproven lookup, or no parseable timestamp).
 *   - `stale`   — a payload is present but not current (a failed later poll
 *     with retained data, or a payload past its freshness budget).
 *
 * Lives in this pure seam (not inside the React hook) for the same reason the
 * formatters above do: the orchestrator's node:test suite can pin the priority
 * order without a React tree — and that order IS the trust contract.
 */
export type PageItemStatus =
  | "loading"
  | "error"
  | "unknown"
  | "stale"
  | "empty"
  | "ready";

/** A present, parseable timestamp — the precondition for trusting a payload's age. */
function isValidTimestamp(ts: unknown): boolean {
  if (ts === null || ts === undefined || ts === "") return false;
  return Number.isFinite(Date.parse(ts as string));
}

/**
 * True when `generatedAt` is older than the declared `freshnessMs` budget.
 * `now` is injectable for deterministic tests; defaults to `Date.now()`.
 */
function isStale(generatedAt: string, freshnessMs: number, now: number = Date.now()): boolean {
  const ms = Date.parse(generatedAt);
  if (!Number.isFinite(ms)) return false; // an unparseable timestamp is handled upstream as unknown
  return now - ms > freshnessMs;
}

/**
 * Derive the trust-aware status for a page-item payload — a small deterministic
 * priority sequence (highest-confidence demotion wins) read directly off ADR-
 * 0034 §5's four numbered rules, not an ambiguous reducer:
 *
 *   1. loading                              -> "loading"
 *   2. first-load failure (error, no data)  -> "unknown"   (nothing trustworthy)
 *   3. sourcesOk === false                  -> "unknown"   (lookup unproven)
 *   4. generatedAt missing/unparseable      -> "unknown"   (no trustworthy timestamp)
 *   5. failed refresh with retained data    -> "stale"     (last-known as context)
 *   6. generatedAt older than freshnessMs   -> "stale"     (aged past budget)
 *   7. items.length === 0                   -> "empty"     (asserted zero)
 *   8. otherwise                            -> "ready"
 *
 * Rule 3 fires only when the payload carries `sourcesOk` and it is exactly
 * `false` — endpoints that never assert (no field) are unaffected. Rule 6 fires
 * only when the caller declared a `freshnessMs > 0`. This ordering is what makes
 * the unasserted-empty regression hold: rule 3 runs BEFORE rule 7, so an
 * `items: []` + `sourcesOk: false` payload resolves to "unknown", never "empty".
 *
 * `now` is injectable for deterministic staleness tests; defaults to `Date.now()`.
 */
export function derivePageStatus(opts: {
  loading: boolean;
  error: string | null;
  data: any;
  items: any[];
  freshnessMs?: number;
  now?: number;
}): PageItemStatus {
  const { loading, error, data, items } = opts;
  const freshnessMs = opts.freshnessMs ?? 0;
  const now = opts.now ?? Date.now();
  if (loading) return "loading";
  if (error && !data) return "unknown";
  if (data && data.sourcesOk === false) return "unknown";
  if (data && !isValidTimestamp(data.generatedAt)) return "unknown";
  if (error && data) return "stale";
  if (freshnessMs > 0 && data && isStale(data.generatedAt, freshnessMs, now)) return "stale";
  if (items.length === 0) return "empty";
  return "ready";
}
