/**
 * recommendations-tab-state.ts — the pure folds behind Oak's Recs tab.
 *
 * Issue #3706. `RecommendationsTab.jsx` used to hand-roll its own fetch layer
 * plus four inline total functions: the severity→hex map, the response
 * normaliser, and the two optimistic-removal filters that run before their
 * POSTs. Those move here and are pinned by
 * `test/now-pixel-recommendations-tab-state.test.mts` in the REQUIRED `test`
 * job.
 *
 * The hand-rolled fetch layer is gone rather than tested: it hardcoded the
 * `/api` prefix and therefore ignored `import.meta.env.VITE_API_BASE`, which
 * the shared `apiFetch`/`useApi` hook honours. Every path below is relative to
 * that base, so the component routes through the same hook its siblings
 * (HabitatGrid, NowPixel) already use — which also deletes the untested
 * `setInterval` / `clearInterval` teardown dance outright.
 *
 * `dashboard/` is a separately deployed Vite build with its own tsconfig and
 * package-lock, so the recommendation shape is re-declared here rather than
 * imported from `src/`. Plain functions, interfaces and const objects only —
 * the root `npm test` runs `node --experimental-strip-types`, which erases
 * types but cannot emit fields.
 */

/** Poll cadence for the active-recommendations list, in milliseconds. */
export const RECS_POLL_MS = 5000;

/** Server-side alias for "whatever run is live right now". */
export const RUN_ID_PARAM = "current";

/**
 * One recommendation as served by `/api/now/recommendations`. Only the fields
 * the tab renders or keys on are typed.
 */
export interface Recommendation {
  id: string;
  severity: string;
  message?: string;
}

export interface RecsSnapshot {
  items: Recommendation[];
  runId: string | null;
}

/** Severity → left-border hex. Tailwind palette names kept in the comments. */
export const SEVERITY_COLORS = {
  critical: "#f87171", // rose-400
  warn: "#fbbf24", // amber-400
  info: "#7dd3fc", // sky-300
} as const;

/** Unknown/absent severities render as `info`. */
export const DEFAULT_SEVERITY_COLOR = SEVERITY_COLORS.info;

export function severityColor(severity: unknown): string {
  switch (severity) {
    case "critical":
      return SEVERITY_COLORS.critical;
    case "warn":
      return SEVERITY_COLORS.warn;
    default:
      return DEFAULT_SEVERITY_COLOR;
  }
}

/**
 * Path for the active-recommendations poll, relative to the API base that
 * `apiFetch` prepends. Module-level constant so it is referentially stable
 * across renders — `useApi` keys its effect on the path.
 */
export const RECS_PATH = `/now/recommendations?run_id=${encodeURIComponent(RUN_ID_PARAM)}`;

/** Path for the per-rec dismiss POST, relative to the API base. */
export function dismissPath(recId: string): string {
  return `/now/recommendations/${encodeURIComponent(recId)}/dismiss`;
}

/** Path for the mute-a-severity-class POST, relative to the API base. */
export const MUTE_CLASS_PATH = "/now/recommendations/mute-class";

export function dismissBody(runId: string | null | undefined): {
  run_id: string;
} {
  return { run_id: runId ?? RUN_ID_PARAM };
}

export function muteClassBody(
  runId: string | null | undefined,
  severity: string,
): { run_id: string; severity: string } {
  return { run_id: runId ?? RUN_ID_PARAM, severity };
}

/**
 * Normalise the poll response into a snapshot. A missing/short-circuited body
 * (the first render, before the first fetch resolves) yields an empty list
 * rather than throwing, so the caller needs no loading branch of its own.
 */
export function normaliseRecsResponse(body: unknown): RecsSnapshot {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    items: Array.isArray(b.items) ? (b.items as Recommendation[]) : [],
    runId: typeof b.run_id === "string" ? b.run_id : null,
  };
}

/**
 * Rows the operator has acted on but whose POST the next poll has not yet
 * reflected. Held as an overlay over the server list rather than as a mutated
 * copy of it, so the poll stays the single source of truth and no effect has
 * to mirror server state into local state.
 *
 * The overlay is **scoped to the run it was applied in** — `runId` is part of
 * the value, and every operation below compares against the run currently on
 * screen. This is load-bearing, not bookkeeping: dismiss and mute are
 * themselves run-scoped server-side (`dismissRecommendationForRun` /
 * `muteSeverityClassForRun`), and the Recs tab is conditionally rendered
 * rather than remounted per run. Without the run key, an operator who muted
 * "warn" once and left the tab open would have every LATER run's "warn" rows
 * silently filtered out — no error, no empty-state, just missing
 * recommendations. Keying the overlay makes it expire with its run at the
 * point of use, so no reset effect is needed.
 */
export interface PendingRemovals {
  /** Run these removals belong to; `null` is the pristine overlay. */
  runId: string | null;
  ids: readonly string[];
  severities: readonly string[];
}

export const NO_PENDING_REMOVALS: PendingRemovals = {
  runId: null,
  ids: [],
  severities: [],
};

/** True when the overlay was applied during the run currently on screen. */
function appliesTo(pending: PendingRemovals, runId: string | null | undefined): boolean {
  return pending.runId !== null && pending.runId === runId;
}

export function withDismissedId(
  pending: PendingRemovals,
  runId: string | null | undefined,
  id: string,
): PendingRemovals {
  const current = runId ?? null;
  // A new run starts a fresh overlay rather than accumulating across runs.
  if (pending.runId !== current) {
    return { runId: current, ids: [id], severities: [] };
  }
  if (pending.ids.includes(id)) return pending;
  return { runId: current, ids: [...pending.ids, id], severities: pending.severities };
}

export function withMutedSeverity(
  pending: PendingRemovals,
  runId: string | null | undefined,
  severity: string,
): PendingRemovals {
  const current = runId ?? null;
  if (pending.runId !== current) {
    return { runId: current, ids: [], severities: [severity] };
  }
  if (pending.severities.includes(severity)) return pending;
  return {
    runId: current,
    ids: pending.ids,
    severities: [...pending.severities, severity],
  };
}

/**
 * Hide every row the operator dismissed by id or muted by severity class —
 * but only while the overlay's run is still the one being displayed. An
 * overlay from a finished run filters nothing.
 */
export function applyPendingRemovals(
  items: readonly Recommendation[] | null | undefined,
  pending: PendingRemovals,
  runId: string | null | undefined,
): Recommendation[] {
  if (!Array.isArray(items)) return [];
  if (!appliesTo(pending, runId)) return [...items];
  return items.filter(
    (r) => !pending.ids.includes(r?.id) && !pending.severities.includes(r?.severity),
  );
}

/** Header label for the current run: a short hash, or "no run" before one starts. */
export function runLabel(runId: string | null | undefined): string {
  return typeof runId === "string" && runId.length > 0
    ? `run ${runId.slice(0, 8)}`
    : "no run";
}
