/**
 * status-verdict-state.ts — the /now hero's composite status verdict (issue
 * #891, now-console-4, parent #887; extracted from console-state.ts by #4382).
 *
 * Owns exactly one concern: folding the slice-1 lifecycle, the slice-3
 * stuck-signals, the slice-2 idle-diagnostics, and the operator pause flag
 * (issue #988/#989) into the single RUNNING / IDLE / STUCK / CRASHED / PAUSED
 * verdict that anchors the Console hero. Pure and DOM-free so it is
 * unit-tested in the orchestrator suite
 * (`test/now-console-status-verdict-state.test.mts`) — the dashboard ships no
 * JSX test runner and deliberately will not adopt one (issue #3706: no
 * required CI job runs inside `dashboard/`, so a JSX suite could never block
 * a regression).
 *
 * Consumers reach this through the `console-state.ts` barrel; import the leaf
 * directly when only the verdict is needed.
 */

export const VERDICT_RUNNING = "RUNNING" as const;
export const VERDICT_IDLE = "IDLE" as const;
export const VERDICT_STUCK = "STUCK" as const;
export const VERDICT_CRASHED = "CRASHED" as const;
export const VERDICT_PAUSED = "PAUSED" as const;

type ConsoleVerdict =
  | typeof VERDICT_RUNNING
  | typeof VERDICT_IDLE
  | typeof VERDICT_STUCK
  | typeof VERDICT_CRASHED
  | typeof VERDICT_PAUSED;

/** Slice-1 lifecycle states (mirrors `AutopilotLifecycleStateSchema`). */
type LifecycleState = "running" | "idle" | "ended" | "crashed";

export interface LifecycleLike {
  state?: LifecycleState | string | null;
  runId?: string | null;
  termReason?: string | null;
  endedEpoch?: number | null;
}

type SignalSeverity = "info" | "warn" | "critical";

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

/**
 * Operator-only autopilot pause flag (issue #988 backend, #989 UI). Mirrors
 * the `AutopilotPauseState` returned by `GET /api/autopilot/paused`:
 * `{ paused: boolean, since?: number }`.
 */
export interface PausedLike {
  paused?: boolean | null;
  since?: number | null;
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
 *   0. PAUSED   — the operator-only pause flag is set (issue #989). Operator
 *      intent is the headline, so PAUSED outranks EVERYTHING — including a
 *      live/draining run, a crash, or a stuck signal. Because there is no
 *      auto-resume (#988), a forgotten pause silently halts all autopilot
 *      work; the paused state must be the loudest thing on the page. While
 *      a run is still draining (lifecycle still reports state="running"),
 *      the fact reads "PAUSED — draining…"; once quiet it settles to
 *      "PAUSED.".
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
  paused?: PausedLike | null;
}): VerdictResult {
  const lifecycle = input.lifecycle ?? {};
  const ranked = rankStuckSignals(input.signals);
  const topActionable =
    ranked.find(
      (s) =>
        String(s?.severity) === "critical" || String(s?.severity) === "warn",
    ) ?? null;
  const state = String(lifecycle.state ?? "idle");

  // PAUSED outranks all other verdicts — operator intent is the headline.
  if (input.paused?.paused === true) {
    const draining = state === "running";
    return {
      verdict: VERDICT_PAUSED,
      fact: draining
        ? "PAUSED — draining… (in-flight subagents finishing their atomic unit)."
        : "PAUSED. Autopilot will not start new work until resumed.",
      signal: null,
    };
  }

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
