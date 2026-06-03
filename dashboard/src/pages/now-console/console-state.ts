/**
 * console-state.ts — pure plumbing for the /now Console view (issue #891,
 * now-console-4, parent #887).
 *
 * The Console is the lifecycle-accurate, quota-aware, stuck-signal-aware
 * replacement for the dead $0 cost framing on /now. This module owns the
 * three load-bearing derivations so they can be unit-tested in the
 * orchestrator suite (`test/now-console-state.test.mts`) the same way
 * `now-pixel/oak-tab-state.ts` is — the dashboard ships no JSX test runner
 * (see `dashboard/test/recommendations-tab.test.jsx`), so all real test
 * coverage lives in the pure `.ts` here.
 *
 *   1. View-mode persistence (Console default ↔ Habitat pixel), deep-linked
 *      via `?view=` and persisted to localStorage.
 *   2. The composite status verdict (RUNNING / IDLE / STUCK / CRASHED) that
 *      anchors the hero, resolved from the slice-1 lifecycle, slice-3
 *      stuck-signals, and the slice-2 idle-diagnostics block.
 *   3. The weekly-pace classification (ahead / on / behind) and a couple of
 *      small formatters the panels share.
 */

// ---------------------------------------------------------------------------
// 1. View mode (Console ↔ Habitat) — deep-link + localStorage round-trip
// ---------------------------------------------------------------------------

export const VIEW_CONSOLE = "console" as const;
export const VIEW_HABITAT = "habitat" as const;

export type NowViewMode = typeof VIEW_CONSOLE | typeof VIEW_HABITAT;

export const NOW_VIEW_IDS: readonly NowViewMode[] = [VIEW_CONSOLE, VIEW_HABITAT];

/** The Console is the default surface (acceptance criterion #1). */
export const DEFAULT_NOW_VIEW: NowViewMode = VIEW_CONSOLE;

export const NOW_VIEW_STORAGE_KEY = "hydra:now:view-mode";

/** The query-param key used to deep-link the view choice (`/now?view=habitat`). */
export const NOW_VIEW_QUERY_KEY = "view";

export function isNowViewMode(v: unknown): v is NowViewMode {
  return v === VIEW_CONSOLE || v === VIEW_HABITAT;
}

/**
 * Resolve the active view mode from (in precedence order) an explicit
 * deep-link query value, then a previously-persisted localStorage value,
 * then the default. The deep-link wins so a shared `/now?view=habitat` URL
 * always lands on the intended surface regardless of the viewer's stored
 * preference.
 *
 * Pure: callers pass the raw query value and a storage shim so this is
 * testable without a DOM.
 */
export function resolveNowView(
  queryValue: string | null | undefined,
  storage: { getItem(k: string): string | null } | null | undefined,
): NowViewMode {
  if (isNowViewMode(queryValue)) return queryValue;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(NOW_VIEW_STORAGE_KEY) ?? null;
  } catch {
    // localStorage can throw (privacy mode / disabled) — degrade to default.
    stored = null;
  }
  if (isNowViewMode(stored)) return stored;
  return DEFAULT_NOW_VIEW;
}

/** Persist the chosen view; swallow storage failures (best-effort UX). */
export function writeStoredNowView(
  storage: { setItem(k: string, v: string): void } | null | undefined,
  view: NowViewMode,
): void {
  try {
    storage?.setItem(NOW_VIEW_STORAGE_KEY, view);
  } catch {
    // Non-fatal: a persisted preference is a convenience, not a contract.
  }
}

// ---------------------------------------------------------------------------
// 2. Composite status verdict (the hero)
// ---------------------------------------------------------------------------

export const VERDICT_RUNNING = "RUNNING" as const;
export const VERDICT_IDLE = "IDLE" as const;
export const VERDICT_STUCK = "STUCK" as const;
export const VERDICT_CRASHED = "CRASHED" as const;

export type ConsoleVerdict =
  | typeof VERDICT_RUNNING
  | typeof VERDICT_IDLE
  | typeof VERDICT_STUCK
  | typeof VERDICT_CRASHED;

/** Slice-1 lifecycle states (mirrors `AutopilotLifecycleStateSchema`). */
export type LifecycleState = "running" | "idle" | "ended" | "crashed";

export interface LifecycleLike {
  state?: LifecycleState | string | null;
  runId?: string | null;
  termReason?: string | null;
  endedEpoch?: number | null;
}

export type SignalSeverity = "info" | "warn" | "critical";

export interface StuckSignalLike {
  type?: string;
  severity?: SignalSeverity | string;
  summary?: string;
  evidence?: Record<string, unknown>;
}

export interface IdleDiagnosticsLike {
  isEligible?: boolean | null;
  blockedBy?: string | null;
  pace?: { state?: string | null } | null;
}

export interface VerdictResult {
  verdict: ConsoleVerdict;
  /** The single most relevant supporting fact for the resolved state. */
  fact: string;
  /** The driving stuck signal when verdict === STUCK, else null. */
  signal: StuckSignalLike | null;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 3,
  warn: 2,
  info: 1,
};

/**
 * Rank stuck signals so the hero (and the StuckSignals panel) agree on the
 * single top signal: highest severity first, original order as the tie-break
 * (the aggregator already emits them best-first).
 */
export function rankStuckSignals(
  signals: readonly StuckSignalLike[] | null | undefined,
): StuckSignalLike[] {
  if (!Array.isArray(signals)) return [];
  return signals
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = SEVERITY_RANK[String(a.s?.severity)] ?? 0;
      const rb = SEVERITY_RANK[String(b.s?.severity)] ?? 0;
      if (ra !== rb) return rb - ra;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

/**
 * Resolve the composite verdict. Precedence:
 *
 *   1. CRASHED  — lifecycle.state === "crashed" (a crash is the most urgent
 *      truth; the operator needs to know the session died abnormally).
 *   2. STUCK    — there is at least one warn/critical stuck signal. A stuck
 *      signal outranks a bare RUNNING/IDLE because a looping-without-progress
 *      autopilot still reports state="running" (the #890 unproductive-loop
 *      case) — surfacing RUNNING there would hide the very problem the
 *      Console exists to make legible.
 *   3. RUNNING  — lifecycle.state === "running" and not stuck.
 *   4. IDLE     — everything else (idle / ended cleanly), with the pace-gate
 *      block reason as the supporting fact when present.
 */
export function resolveVerdict(input: {
  lifecycle?: LifecycleLike | null;
  signals?: readonly StuckSignalLike[] | null;
  idle?: IdleDiagnosticsLike | null;
}): VerdictResult {
  const lifecycle = input.lifecycle ?? {};
  const ranked = rankStuckSignals(input.signals);
  const topActionable =
    ranked.find(
      (s) =>
        String(s?.severity) === "critical" || String(s?.severity) === "warn",
    ) ?? null;
  const state = String(lifecycle.state ?? "idle");

  if (state === "crashed") {
    const reason =
      typeof lifecycle.termReason === "string" && lifecycle.termReason
        ? lifecycle.termReason
        : "unknown";
    return {
      verdict: VERDICT_CRASHED,
      fact: `Last session terminated abnormally (${reason}).`,
      signal: null,
    };
  }

  if (topActionable) {
    return {
      verdict: VERDICT_STUCK,
      fact:
        typeof topActionable.summary === "string" && topActionable.summary
          ? topActionable.summary
          : `Stuck signal: ${String(topActionable.type ?? "unknown")}.`,
      signal: topActionable,
    };
  }

  if (state === "running") {
    return {
      verdict: VERDICT_RUNNING,
      fact: lifecycle.runId
        ? `Autopilot session ${shortId(lifecycle.runId)} is live.`
        : "Autopilot session is live.",
      signal: null,
    };
  }

  // IDLE (idle / ended cleanly). Prefer the pace-gate block reason from the
  // idle-diagnostics slice as the supporting fact — that is exactly the
  // "why isn't it running right now" question slice 2 answers.
  const idle = input.idle ?? {};
  let fact = "Autopilot is idle.";
  if (idle.isEligible === false && typeof idle.blockedBy === "string" && idle.blockedBy) {
    fact = `Idle — pace gate blocked by: ${idle.blockedBy}.`;
  } else if (state === "ended") {
    fact = "Last session ended cleanly; waiting for the next pace-gate window.";
  }
  return { verdict: VERDICT_IDLE, fact, signal: null };
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

// ---------------------------------------------------------------------------
// 3. Weekly pace + small shared formatters
// ---------------------------------------------------------------------------

export type PaceVerdict = "ahead" | "on" | "behind";

/**
 * Classify weekly pace from sinceReset% vs target%. "on" within a tolerance
 * band (default ±2 absolute percentage points) so the gauge does not flicker
 * ahead/behind on noise. Below target − tol → behind (burning slower than the
 * even-pace line, i.e. headroom to spare); above target + tol → ahead.
 */
export function classifyPace(
  sinceResetPercent: number | null | undefined,
  targetPercent: number | null | undefined,
  tolerance = 2,
): PaceVerdict {
  if (sinceResetPercent == null || targetPercent == null) return "on";
  const s = Number(sinceResetPercent);
  const t = Number(targetPercent);
  if (!Number.isFinite(s) || !Number.isFinite(t)) return "on";
  if (s > t + tolerance) return "ahead";
  if (s < t - tolerance) return "behind";
  return "on";
}

/** Compact percent (one decimal, clamped to [0,∞) display). */
export function formatPercent(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(1)}%`;
}

/** Human token count: 1.2M / 814K / 512. */
export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(Math.round(v));
}

/** Cache-hit ratio (0..1) → percent string. */
export function formatRatio(n: number | null | undefined): string {
  if (n == null) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Flatten the `bySkillByModel` usage tree into ranked rows for the
 * attribution table: one row per (skill, model) with a non-zero total,
 * sorted by total descending. The eligibility endpoint nests
 * `{ skill: { model: { total, ... } } }`.
 */
export interface AttributionRow {
  skill: string;
  model: string;
  total: number;
}

export function flattenAttribution(
  bySkillByModel:
    | Record<string, Record<string, { total?: number } | null | undefined>>
    | null
    | undefined,
): AttributionRow[] {
  if (!bySkillByModel || typeof bySkillByModel !== "object") return [];
  const rows: AttributionRow[] = [];
  for (const [skill, byModel] of Object.entries(bySkillByModel)) {
    if (!byModel || typeof byModel !== "object") continue;
    for (const [model, usage] of Object.entries(byModel)) {
      const total = Number(usage?.total ?? 0);
      if (Number.isFinite(total) && total > 0) {
        rows.push({ skill, model, total });
      }
    }
  }
  return rows.sort((a, b) => b.total - a.total);
}
