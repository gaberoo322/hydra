/**
 * oak-tab-state.ts — pure helpers for the OakTownCrier 3-tab panel.
 *
 * Slice B of the autopilot-observability epic (#669, parent #667). The
 * OakTownCrier was a single scrolling bubble column; this slice converts
 * it into a 3-mode tabbed panel:
 *
 *   1. Live feed         — preserves the existing wildcard WS bubble stream
 *   2. Turn journal      — one compact row per autopilot turn
 *   3. Recommendations   — placeholder; slice F (#674) lights this up
 *
 * The component-level logic (scroll, hover-pause, WS subscription) stays
 * in OakTownCrier.jsx. This file isolates the pure plumbing — tab id
 * constants, storage keys, and turn-row summarisation — so node:test can
 * pin the load-bearing behaviour without a DOM. Same testing seam as
 * `derive-sprite-state.ts` and `sprite-map.ts`.
 *
 * Sources for Turn journal rows:
 *   - Live `turn_start` / `turn_end` WS events (slice A — not yet landed
 *     as of #669; the component MUST still render historical fill-in).
 *   - `runs/current.turns[]` from `/api/autopilot/runs/current` — the
 *     authoritative historical record. The component polls this every
 *     ~10s (same cadence as HabitatGrid) so the journal is correct even
 *     if WS frames are missed entirely.
 *
 * Per-action `dispatch_decision` rationale: each turn's `actions[]` entry
 * already carries `slot`, `skill`, `reason`, and `outcome` — that's the
 * same payload the slice-A `dispatch_decision` WS frame is specified to
 * carry. So the row-expand detail panel works today off the polled
 * payload; when slice A lands, the WS frame just refreshes the same shape
 * sooner.
 */

import type { PipelineClass } from "./sprite-map.ts";

export const TAB_LIVE = "live" as const;
export const TAB_JOURNAL = "journal" as const;
export const TAB_RECS = "recs" as const;

export type OakTabId = typeof TAB_LIVE | typeof TAB_JOURNAL | typeof TAB_RECS;

export const OAK_TAB_IDS: readonly OakTabId[] = [TAB_LIVE, TAB_JOURNAL, TAB_RECS];

/** localStorage key for the operator's selected tab. Separate from the
 *  legacy "hydra:now-pixel:oak-collapsed" key so collapse-state and
 *  tab-state evolve independently. */
export const OAK_TAB_STORAGE_KEY = "hydra:now-pixel:oak-tab";

/** Default tab when nothing is stored (or stored value is invalid). */
export const DEFAULT_OAK_TAB: OakTabId = TAB_LIVE;

/**
 * Read a previously persisted tab id. Returns the default if storage is
 * unavailable (SSR, disabled storage) or holds an unknown value. Never
 * throws — operator-side storage hiccups must not break the panel.
 */
export function readStoredOakTab(storage: {
  getItem: (k: string) => string | null;
} | null | undefined): OakTabId {
  if (!storage) return DEFAULT_OAK_TAB;
  let raw: string | null = null;
  try {
    raw = storage.getItem(OAK_TAB_STORAGE_KEY);
  } catch {
    return DEFAULT_OAK_TAB;
  }
  return isOakTabId(raw) ? raw : DEFAULT_OAK_TAB;
}

/**
 * Persist the operator's tab choice. Silently no-ops on storage failure
 * (matches the legacy collapse-state persistence in OakTownCrier).
 */
export function writeStoredOakTab(
  storage: { setItem: (k: string, v: string) => void } | null | undefined,
  id: OakTabId,
): void {
  if (!storage) return;
  try {
    storage.setItem(OAK_TAB_STORAGE_KEY, id);
  } catch {
    /* intentional: storage may be disabled */
  }
}

export function isOakTabId(v: unknown): v is OakTabId {
  return v === TAB_LIVE || v === TAB_JOURNAL || v === TAB_RECS;
}

/**
 * Per-turn action shape, mirrored from
 * `/api/autopilot/runs/current.turns[].actions[]`. We type only the
 * fields the journal renderer needs — the upstream payload carries more.
 */
export interface TurnAction {
  type?: string;
  slot?: string | null;
  skill?: string | null;
  reason?: string | null;
  outcome?: unknown;
  prompt_args?: Record<string, unknown> | null;
  worktreeBranch?: string | null;
}

export interface TurnRecord {
  turn_n?: number | null;
  epoch?: number | null;
  actions?: TurnAction[] | null;
  reasons?: string[] | null;
  tokens_after?: number | null;
  idle_turns?: number | null;
}

export interface DispatchSummary {
  slot: string;
  skill: string | null;
  reason: string | null;
}

export interface TurnRowSummary {
  /** Stable id for keying React lists (turn_n preferred, epoch fallback). */
  id: string;
  turn_n: number | null;
  epoch: number | null;
  dispatchedClasses: string[];
  /** Per-action rationale, expanded when the row is opened. */
  dispatchDetails: DispatchSummary[];
  skippedCount: number;
  /** Token delta vs previous turn, in absolute tokens. null when unknown. */
  tokensDelta: number | null;
  /** Pre-baked one-line summary string ("dispatched 2, skipped 4 (cooldown), tokens +12.3k"). */
  summary: string;
}

/**
 * Reduce a `runs/current.turns[]` array into compact row summaries,
 * newest first. The input order from the orchestrator is already
 * newest-first today but we re-sort defensively because the server
 * contract isn't a guarantee we want to load-bear.
 *
 * The "skipped" count is action.type === "skip" if/when the orchestrator
 * emits those; today's payload only contains dispatched actions so the
 * count will be 0 until slice A widens the payload. The renderer hides
 * the skipped clause when 0.
 */
export function summariseTurns(
  turns: TurnRecord[] | null | undefined,
): TurnRowSummary[] {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  // Defensive newest-first sort: prefer turn_n, fall back to epoch.
  const sorted = [...turns].sort((a, b) => {
    const ta = typeof a?.turn_n === "number" ? a.turn_n : -1;
    const tb = typeof b?.turn_n === "number" ? b.turn_n : -1;
    if (ta !== tb) return tb - ta;
    const ea = typeof a?.epoch === "number" ? a.epoch : 0;
    const eb = typeof b?.epoch === "number" ? b.epoch : 0;
    return eb - ea;
  });

  // Token delta needs the next-newer turn (i.e. the previous turn in
  // chronological order). Because sorted is newest-first, the delta for
  // index i comes from the difference against index i+1.
  const rows: TurnRowSummary[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i] ?? {};
    const actions = Array.isArray(t.actions) ? t.actions : [];
    const dispatchActions = actions.filter(
      (a) => a?.type === "dispatch" && typeof a?.slot === "string" && a.slot,
    );
    const skipActions = actions.filter(
      (a) => a?.type === "skip" || a?.type === "skipped",
    );
    const classes = dispatchActions.map((a) => String(a.slot));
    const details: DispatchSummary[] = dispatchActions.map((a) => ({
      slot: String(a.slot),
      skill: typeof a?.skill === "string" ? a.skill : null,
      reason: typeof a?.reason === "string" ? a.reason : null,
    }));

    let tokensDelta: number | null = null;
    const myTokens = typeof t.tokens_after === "number" ? t.tokens_after : null;
    const prev = sorted[i + 1];
    const prevTokens =
      prev && typeof prev.tokens_after === "number" ? prev.tokens_after : null;
    if (myTokens != null && prevTokens != null) {
      tokensDelta = myTokens - prevTokens;
    } else if (myTokens != null && i === sorted.length - 1) {
      // First-ever turn: delta IS the cumulative tokens after that turn.
      tokensDelta = myTokens;
    }

    const id =
      typeof t.turn_n === "number"
        ? `turn-${t.turn_n}`
        : typeof t.epoch === "number"
          ? `epoch-${t.epoch}`
          : `idx-${i}`;

    rows.push({
      id,
      turn_n: typeof t.turn_n === "number" ? t.turn_n : null,
      epoch: typeof t.epoch === "number" ? t.epoch : null,
      dispatchedClasses: classes,
      dispatchDetails: details,
      skippedCount: skipActions.length,
      tokensDelta,
      summary: buildSummaryLine(
        classes.length,
        skipActions.length,
        tokensDelta,
      ),
    });
  }
  return rows;
}

export function buildSummaryLine(
  dispatched: number,
  skipped: number,
  tokensDelta: number | null,
): string {
  const parts: string[] = [];
  parts.push(`dispatched ${dispatched}`);
  if (skipped > 0) parts.push(`skipped ${skipped}`);
  if (typeof tokensDelta === "number" && Number.isFinite(tokensDelta)) {
    parts.push(`tokens ${formatTokenDelta(tokensDelta)}`);
  }
  return parts.join(", ");
}

export function formatTokenDelta(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${abs}`;
}

/**
 * Format an epoch (seconds) as a short relative time string for the row
 * header: "12s ago", "4m ago", "2h ago". `nowSec` is injected so tests
 * are deterministic.
 */
export function formatRelativeTime(
  epochSec: number | null | undefined,
  nowSec: number,
): string {
  if (typeof epochSec !== "number" || !Number.isFinite(epochSec) || epochSec <= 0) {
    return "";
  }
  const diff = Math.max(0, Math.floor(nowSec - epochSec));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** All pipeline classes that can carry a sprite-icon in a turn row.
 *  Re-exported here so tests don't need to import sprite-map.ts twice. */
export type ClassWithSprite = PipelineClass | string;
