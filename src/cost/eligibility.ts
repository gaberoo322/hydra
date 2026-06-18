/**
 * src/cost/eligibility.ts — the pure eligibility-projection fold of the
 * **Subscription Usage Tracker** (issue #1377).
 *
 * Split out of `usage-tracker.ts` so the autopilot-facing dispatch-gating
 * policy lives apart from the JSONL-scan + snapshot-build IO that produces a
 * {@link UsageSnapshot}. This module is a PURE fold over an already-built
 * snapshot: no IO, no Redis, no `Date.now()` (the only time it reads comes off
 * the snapshot's own `generatedAt`). It carries:
 *
 *   - the hard-stop allow gate ({@link projectEligibility}),
 *   - the two soft-throttle shed unions (the weekly-projection
 *     {@link PACING_SHEDDABLE_CLASSES} pacing shed and the graduated 5h
 *     {@link fiveHourThrottleShed}),
 *   - the **Pacing Curve** ahead/behind verdict ({@link projectPacingCurve}),
 *   - the route/collector-seam overlays for the operator pause flag and the
 *     session-limit hard-block ({@link overlayPauseEligibility} /
 *     {@link overlaySessionBlockEligibility}).
 *
 * Import direction is one-way w.r.t. the JSONL-scan machinery in spirit: this
 * module imports only the snapshot TYPES from `usage-tracker.ts` (type-only).
 * The one DELIBERATE value-import exception runs the other way — `usage-tracker.ts`
 * imports the PURE, IO-free hard-stop predicate {@link deriveHardStop} (and the
 * {@link EMERGENCY_STOP_PERCENT} threshold it folds over) from here, because the
 * threshold POLICY that says "≥90% OAuth utilization is a hard stop" belongs with
 * the dispatch-gating fold, not buried inline in the snapshot-assembly IO (issue
 * #2041). That value import is safe: `deriveHardStop` is a leaf scalar fold (no
 * IO, no `Date.now()`, no snapshot type), it is called from INSIDE the tracker's
 * assembly function (never at module-init), and it consumes nothing from
 * `usage-tracker.ts` — so the value+type edge between the two modules cannot
 * initialise a cycle. The JSONL walk, OAuth precedence, weekly Reset-Anchor math,
 * and quota-weight accounting still live in `usage-tracker.ts`; only the
 * two-line threshold fold (which scalar percentages clear the cap) moved here.
 * This fold ({@link projectEligibility} and friends) only READS the
 * already-computed snapshot. The Pacing-Ceiling env READER it consumes
 * ({@link getWeeklyPaceCeiling}) now lives in the pure-leaf `./config.ts`
 * (issue #1896) — importing a VALUE from that stateless, IO-free leaf does not
 * reintroduce the coupling the one-way rule guards against (config.ts pulls in
 * no scan/snapshot machinery and imports nothing back). Everything outside
 * `src/cost/` keeps importing via `src/cost/index.ts`, which re-exports every
 * symbol below at the same name — no external import line changes.
 */

import type { UsageSnapshot } from "./usage-tracker.ts";
// The **Pacing Ceiling** env reader moved to the pure-leaf config module
// (issue #1896); we keep the Pacing-Curve math here and read the ceiling
// fraction from there.
import { getWeeklyPaceCeiling } from "./config.ts";

/**
 * Length of the fixed weekly window in ms. Duplicated as a private const here
 * (a fixed literal, not policy) rather than cross-imported from
 * `usage-tracker.ts`, so the one-way import rule (this module imports only
 * TYPES from the tracker) is never broken for a single 7-day constant. The
 * tracker keeps its own copy for the trailing-7d cutoff + Reset-Anchor math.
 */
const WINDOW_7D_MS = 7 * 86_400_000;

/**
 * Hard-stop threshold (in % of quota) shared by the 5-hour `emergencyStop` and
 * the weekly `weeklyEmergencyStop` (issue #2041; relocated from
 * `usage-tracker.ts`). At or above this percentage the corresponding window is
 * considered exhausted enough to block ALL autopilot dispatch (via
 * {@link projectEligibility} → allow=false), leaving the ~10% headroom as
 * **Operator Reserve** for whatever the operator dispatches by hand. Both
 * windows share the one constant so the two caps stay symmetric — it is the
 * threshold half of the {@link deriveHardStop} predicate's interface.
 */
export const EMERGENCY_STOP_PERCENT = 90;

/**
 * The two hard-stop booleans, derived as a PURE scalar fold (issue #2041).
 *
 * Extracted out of `usage-tracker.ts`'s snapshot-assembly function so the
 * threshold policy is independently testable: asserting "at 91% 5h OAuth usage
 * the 5h stop is true" no longer requires driving the full snapshot assembly
 * (ScanResult fixture, OAuth mock, quota-weight config, weekly-reset-anchor
 * math) just to reach the comparison. The fold is over already-computed
 * scalars — NOT a {@link UsageSnapshot} — because `usage-tracker.ts` computes
 * these stops DURING assembly, before a snapshot object exists.
 *
 * Behaviour is byte-for-byte the inline derivation it replaces:
 *   - `emergencyStop`       === (usageSource === "oauth" && percentLast5h ≥ 90)
 *   - `weeklyEmergencyStop` === (usageSource === "oauth" && percentLast7d ≥ 90)
 *
 * The `usageSource === "oauth"` guard preserves the #1124 fail-open invariant:
 * the transcript `estimate` (a ~half-of-real guess) NEVER triggers a stop, so a
 * prolonged OAuth outage cannot self-stop autopilot on a fabricated number.
 */
export function deriveHardStop(input: {
  percentLast5h: number;
  percentLast7d: number;
  usageSource: "oauth" | "estimate";
}): { emergencyStop: boolean; weeklyEmergencyStop: boolean } {
  const onOAuth = input.usageSource === "oauth";
  return {
    emergencyStop: onOAuth && input.percentLast5h >= EMERGENCY_STOP_PERCENT,
    weeklyEmergencyStop: onOAuth && input.percentLast7d >= EMERGENCY_STOP_PERCENT,
  };
}

/**
 * Tolerance band (in percentage points of weekly quota) around the **Pacing
 * Curve** target within which the burn is judged "on" the curve rather than
 * ahead/behind. ±2pp is small relative to the 0→92 ramp over a week, so it
 * suppresses paceState flicker right at the line without materially shifting
 * the ahead/behind verdict. (issue #857)
 */
export const PACE_STATE_TOLERANCE_PERCENT = 2;

/**
 * Position of total burn relative to the **Pacing Curve** target for this
 * instant in the week (issue #857, ADR-0021):
 *   - "behind" — sinceReset% < target% − tolerance (room to run; Pace Gate launches)
 *   - "on"     — within ±tolerance of target%, OR neutral (anchor unset/uncalibrated)
 *   - "ahead"  — sinceReset% > target% + tolerance (Pace Gate pauses, in #858)
 *
 * Neutral maps to "on": when the Anchor is unset or the quota is uncalibrated
 * there is no curve to be ahead/behind of, and "on" is the do-nothing verdict
 * the future Pace Gate (#858) treats as "no pacing reason to launch or pause"
 * — mirroring how `pacingState` defaults to the inert "under" when uncalibrated.
 * This field is ADDITIVE and does NOT yet gate dispatch (that is #858).
 */
type PaceState = "behind" | "on" | "ahead";

/**
 * Autopilot classes the orchestrator sheds when the **Subscription Usage
 * Tracker** projects we'll exceed the weekly quota at the current rate.
 *
 * Keep `dev_*`, `qa_*`, `research_*`, `design_concept_*`, and `health` —
 * those are the value-bearing and safety-critical paths. Drop the
 * board-hygiene + discovery + scout classes when pacing is over because
 * they're high-volume signal-driven dispatches that don't directly move
 * Target Outcomes. This list is policy, not measurement; if you change
 * it, also update the autopilot playbook table that documents class
 * eligibility.
 */
export const PACING_SHEDDABLE_CLASSES: readonly string[] = Object.freeze([
  "sweep_orch",
  "sweep_target",
  "discover_orch",
  "discover_target",
  "scout_orch",
]);

/**
 * Graduated 5-hour-utilization throttle (issue #1087, builds on #1085).
 *
 * Between 0% and the 90% `emergencyStop` the pipeline fan-out used to run at
 * full throttle, sprinting to the 5h session wall and then slamming to a hard
 * stop. These two ordered tiers shed pipeline classes EARLIER — lowest pipeline
 * priority first — so the 5h window burns down gracefully. Keyed off the
 * AUTHORITATIVE OAuth `percentLast5h` (`usageSource:"oauth"`); inert on the
 * transcript `estimate` (the rough number must not throttle real work).
 *
 * Tier 1 (≥ T1, default 60%): the lowest-value pipeline classes — both research
 * classes plus the orch-self backfill / retro / cleanup signal classes. These
 * are spare-capacity self-improvement dispatches that don't move Target
 * Outcomes; shedding them first costs nothing in-flight.
 *
 * Tier 2 (≥ T2, default 75%): ADDITIONALLY the design-concept grill and the
 * single largest dev consumer (`dev_orch`, ~37% of measured 5h burn). `qa_*`
 * are NEVER shed — finishing work that's already burned tokens is cheaper than
 * abandoning it. `dev_target` is also kept so Target work can still land.
 *
 * Each tier UNIONS its predecessor (a T2-or-higher snapshot sheds the T1 set
 * too). Above 90% the existing `emergencyStop` blocks everything (allow=false),
 * which supersedes any shed list. This is policy, not measurement; if you change
 * a list, also update the autopilot playbook class-eligibility table.
 */
export const FIVE_HOUR_THROTTLE_T1_CLASSES: readonly string[] = Object.freeze([
  "research_orch",
  "research_target",
  "architecture_orch",
  "retro_orch",
  "cleanup_orch",
  "discover_orch",
]);

/**
 * Tier-2 classes shed IN ADDITION to {@link FIVE_HOUR_THROTTLE_T1_CLASSES} once
 * `percentLast5h` reaches T2. The grill + the single largest dev class; `qa_*`
 * and `dev_target` are deliberately excluded. See
 * {@link FIVE_HOUR_THROTTLE_T1_CLASSES} for the full rationale. (issue #1087)
 */
export const FIVE_HOUR_THROTTLE_T2_CLASSES: readonly string[] = Object.freeze([
  "design_concept_orch",
  "dev_orch",
]);

/** Default Tier-1 5h-utilization throttle threshold (fraction of quota). */
export const DEFAULT_FIVE_HOUR_THROTTLE_T1 = 0.6;
/** Default Tier-2 5h-utilization throttle threshold (fraction of quota). */
export const DEFAULT_FIVE_HOUR_THROTTLE_T2 = 0.75;

/**
 * Read a 5h-throttle threshold env var as a fraction in (0, 1). Unset/empty →
 * `fallback`. Set-but-invalid (non-finite, ≤0, or ≥1) → `fallback` with a
 * fail-loud `console.error`, mirroring {@link getWeeklyPaceCeiling}'s discipline
 * (a mis-configured env var is visible, never silently honoured). (issue #1087)
 */
function getFiveHourThrottleThreshold(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    console.error(
      `[usage-tracker] ${envVar} is set but not a finite fraction in (0, 1) (${JSON.stringify(
        raw,
      )}); falling back to default ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * The graduated 5h-utilization shed set for a snapshot (issue #1087), as a
 * PURE function (env-only + snapshot; no `Date.now()`, no IO). Returns the
 * classes to shed given the authoritative OAuth `percentLast5h`:
 *   - `usageSource !== "oauth"` (estimate/uncalibrated) → `[]` (inert).
 *   - `percentLast5h >= T2*100` → T1 ∪ T2.
 *   - `percentLast5h >= T1*100` → T1.
 *   - below T1 → `[]`.
 * T1/T2 read from `HYDRA_USAGE_5H_THROTTLE_T1` / `_T2` (fractions). When a
 * mis-set T2 < T1, the higher of the two governs the T2 cut so the ordering
 * invariant (T2 ⊇ T1 only above T1) never inverts.
 */
export function fiveHourThrottleShed(snapshot: UsageSnapshot): readonly string[] {
  // Only the AUTHORITATIVE OAuth meter throttles real work; the transcript
  // estimate is too rough to gate on (and is 0 when uncalibrated).
  if (snapshot.usageSource !== "oauth") return [];
  const t1 = getFiveHourThrottleThreshold(
    "HYDRA_USAGE_5H_THROTTLE_T1",
    DEFAULT_FIVE_HOUR_THROTTLE_T1,
  );
  const t2 = getFiveHourThrottleThreshold(
    "HYDRA_USAGE_5H_THROTTLE_T2",
    DEFAULT_FIVE_HOUR_THROTTLE_T2,
  );
  const pct = snapshot.percentLast5h;
  // Defensive ordering: T2 must not cut below T1. If an operator mis-sets
  // T2 < T1, treat the larger as the T2 boundary (the T1 set still sheds at T1).
  const t2Pct = Math.max(t1, t2) * 100;
  const t1Pct = t1 * 100;
  if (pct >= t2Pct) {
    return Object.freeze([
      ...FIVE_HOUR_THROTTLE_T1_CLASSES,
      ...FIVE_HOUR_THROTTLE_T2_CLASSES,
    ]);
  }
  if (pct >= t1Pct) return FIVE_HOUR_THROTTLE_T1_CLASSES;
  return [];
}

export interface UsageEligibility {
  /**
   * False when the tracker reports `emergencyStop` (5h consumption at
   * or above 90% of calibrated quota). The autopilot turn MUST NOT
   * dispatch anything when `allow` is false — every dispatch class is
   * blocked, not just sheddable ones, because we're about to hit the
   * Anthropic 5h session cap and want to leave headroom for whatever
   * the operator dispatches manually.
   */
  allow: boolean;
  /**
   * Classes the autopilot turn must skip. Empty unless pacingState is
   * "over", in which case it carries `PACING_SHEDDABLE_CLASSES`. Has no
   * meaning when `allow` is false (every class is blocked).
   */
  shed: readonly string[];
  reasons: {
    emergencyStop: boolean;
    /**
     * True when the weekly hard-stop is the reason `allow` is false: ≥90% of
     * the weekly quota burned since the current Weekly Reset Anchor boundary
     * (`UsageSnapshot.weeklyEmergencyStop`). Independent of `emergencyStop`;
     * either one forces `allow=false` and blocks every dispatch class.
     */
    weeklyEmergencyStop: boolean;
    pacingShed: boolean;
    /**
     * True when the graduated 5h-utilization throttle (issue #1087) contributed
     * classes to {@link UsageEligibility.shed} — i.e. the authoritative OAuth
     * `percentLast5h` reached at least the Tier-1 threshold. Independent of
     * {@link pacingShed} (the weekly-projection shed); either or both can be
     * true, and `shed` is their union. False on the transcript estimate / below
     * Tier 1.
     */
    fiveHourThrottleShed: boolean;
    calibrated: boolean;
    /**
     * Operator-only **Autopilot pause** flag (issue #988). When true, the
     * autopilot is paused: the launcher (pace-gate.sh) skips spawning a run
     * and the brain (decide.py) drains (no new dispatches). It forces
     * `allow=false` like `emergencyStop`, but is an INDEPENDENT, durable,
     * operator-held flag — not a quota signal. Defaults to `false`; the value
     * is overlaid at the route/collector seam (NOT inside the pure
     * `projectEligibility`) by {@link overlayPauseEligibility}.
     */
    paused: boolean;
    /**
     * Session-limit hard-block reset instant (issue #1089). ISO-8601 of the
     * moment the Claude Code rolling SESSION window resets, recorded when the
     * autopilot last exited with `You've hit your session limit · resets <t>`.
     * `null` when no future block is recorded. The OAuth 5h meter
     * (`emergencyStop`) can read below 90% while the session is hard-blocked,
     * so this is the authoritative "the next run cannot make a single turn"
     * signal: while it is a FUTURE instant, `allow` is forced `false` so the
     * launcher (pace-gate.sh) skips relaunch into an exhausted quota. Overlaid
     * at the route/collector seam by {@link overlaySessionBlockEligibility}
     * (NOT inside the pure `projectEligibility`), mirroring the pause flag.
     */
    sessionBlockedUntil: string | null;
  };
  /**
   * Position of total burn relative to the **Pacing Curve** for this instant
   * in the week (issue #857, ADR-0021). ADDITIVE — does NOT yet affect `allow`
   * or `shed`; the Pace Gate that acts on it lands in #858. "on" when the
   * Anchor is unset or the quota is uncalibrated (no curve to compare against).
   */
  paceState: PaceState;
  /**
   * The **Pacing Curve** target: the % of weekly quota burn that *should* have
   * accumulated by `usage.generatedAt` — a linear ramp from 0 at the current
   * Weekly Reset Anchor boundary to `ceiling*100` at the next boundary. 0
   * (neutral) when the Anchor is unset. (issue #857)
   */
  targetPercent: number;
  /**
   * Actual % of weekly quota consumed since the current Weekly Reset Anchor
   * boundary — `usage.percentSinceReset`, surfaced here so a caller comparing
   * it against `targetPercent` needn't reach back into the snapshot. (issue #857)
   */
  sinceResetPercent: number;
  /**
   * ISO-8601 of the effective current-window Weekly Reset Anchor boundary
   * (`usage.weeklyResetAnchor`), or `null` when the Anchor env var is
   * unset/unparseable. (issue #857)
   */
  anchor: string | null;
  usage: UsageSnapshot;
}

/**
 * Compute the **Pacing Curve** target percent and the burn's position relative
 * to it, derived purely from the snapshot (no `Date.now()` — `now` comes from
 * `snapshot.generatedAt`, keeping this a pure function of the snapshot).
 *
 * The curve is a linear ramp from 0 at the current Weekly Reset Anchor boundary
 * to `ceiling*100` at the next boundary (7 days later):
 *   `fraction   = clamp01((now - currentMs) / WINDOW_7D_MS)`
 *   `targetPct  = ceiling * 100 * fraction`
 * where `currentMs` is parsed from `snapshot.weeklyResetAnchor`.
 *
 * When the Anchor is unset (`weeklyResetAnchor === null`) — or its ISO is
 * unparseable — there is no curve: `targetPercent` is 0 and `paceState` is the
 * neutral "on". Otherwise paceState compares `percentSinceReset` to the target
 * within ±{@link PACE_STATE_TOLERANCE_PERCENT} percentage points. (issue #857)
 */
function projectPacingCurve(
  snapshot: UsageSnapshot,
  ceiling: number,
): { paceState: PaceState; targetPercent: number; sinceResetPercent: number } {
  const sinceResetPercent = snapshot.percentSinceReset;
  const anchorIso = snapshot.weeklyResetAnchor;

  if (anchorIso === null) {
    // No Weekly Reset Anchor → no curve to be ahead/behind of. Neutral.
    return { paceState: "on", targetPercent: 0, sinceResetPercent };
  }
  const currentMs = Date.parse(anchorIso);
  const nowMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(currentMs) || !Number.isFinite(nowMs)) {
    // Defensive: a malformed timestamp on a snapshot we own. Stay neutral
    // rather than projecting a NaN curve. Logged so the bad value is visible.
    console.error(
      `[usage-tracker] projectPacingCurve got an unparseable timestamp ` +
        `(weeklyResetAnchor=${JSON.stringify(anchorIso)}, generatedAt=${JSON.stringify(
          snapshot.generatedAt,
        )}); treating Pacing Curve as neutral`,
    );
    return { paceState: "on", targetPercent: 0, sinceResetPercent };
  }

  const fraction = Math.min(1, Math.max(0, (nowMs - currentMs) / WINDOW_7D_MS));
  const targetPercent = ceiling * 100 * fraction;

  let paceState: PaceState = "on";
  if (sinceResetPercent > targetPercent + PACE_STATE_TOLERANCE_PERCENT) {
    paceState = "ahead";
  } else if (sinceResetPercent < targetPercent - PACE_STATE_TOLERANCE_PERCENT) {
    paceState = "behind";
  }
  return { paceState, targetPercent, sinceResetPercent };
}

/**
 * Pure projection from a snapshot to an autopilot-facing eligibility
 * verdict. Surfaces three independent facts:
 *   - `allow` (the hard-stop signal)
 *   - `shed` (the soft-throttle list)
 *   - `reasons` (so callers can log *why* without re-deriving)
 *
 * Uncalibrated snapshots always return `{ allow: true, shed: [] }` —
 * the tracker stays out of the way until the operator's env-var
 * calibration confirms it's reading real ground truth.
 */
export function projectEligibility(snapshot: UsageSnapshot): UsageEligibility {
  // EITHER hard-stop (5h OR weekly) blocks every dispatch class. Both ride the
  // same allow=false drain path the operator pause uses.
  const allow = !snapshot.emergencyStop && !snapshot.weeklyEmergencyStop;
  const pacingShed = snapshot.pacingState === "over";
  // Two independent soft-throttles COMPOSE into the shed list (issue #1087):
  //   - the weekly-projection pacing shed (existing, `pacingState === "over"`)
  //   - the graduated 5h-utilization throttle (keyed off OAuth `percentLast5h`)
  // Union + de-dupe so a class shed by either path appears exactly once.
  const throttleShed = fiveHourThrottleShed(snapshot);
  const fiveHourThrottleShed_ = throttleShed.length > 0;
  const shed =
    pacingShed || fiveHourThrottleShed_
      ? Object.freeze([
          ...new Set([
            ...(pacingShed ? PACING_SHEDDABLE_CLASSES : []),
            ...throttleShed,
          ]),
        ])
      : [];
  // Pacing Curve verdict (issue #857). ADDITIVE — does NOT touch allow/shed;
  // the Pace Gate that acts on paceState lands in #858. Reads the ceiling from
  // env here so callers (incl. the HTTP route) get the live verdict.
  const { paceState, targetPercent, sinceResetPercent } = projectPacingCurve(
    snapshot,
    getWeeklyPaceCeiling(),
  );
  return {
    allow,
    shed,
    reasons: {
      emergencyStop: snapshot.emergencyStop,
      weeklyEmergencyStop: snapshot.weeklyEmergencyStop,
      pacingShed,
      fiveHourThrottleShed: fiveHourThrottleShed_,
      calibrated: snapshot.calibrated,
      // Default not-paused. The pause flag is a Redis read that does NOT
      // belong inside this pure projection — it is overlaid at the
      // route/collector seam via overlayPauseEligibility().
      paused: false,
      // Default no session block. Like `paused`, the recorded block-until is a
      // Redis read overlaid at the route/collector seam via
      // overlaySessionBlockEligibility() — not inside this pure projection.
      sessionBlockedUntil: null,
    },
    paceState,
    targetPercent,
    sinceResetPercent,
    anchor: snapshot.weeklyResetAnchor,
    usage: snapshot,
  };
}

/**
 * Overlay the operator-only **Autopilot pause** flag (issue #988) onto an
 * eligibility projection, at the caller/route seam.
 *
 * `projectEligibility` is a PURE function of its snapshot (no IO, no
 * `Date.now()`) — exactly as the emergency-brake is read at the
 * collector/health seam and never folded into the projection. The pause flag
 * is a Redis read, so the read happens in the caller (the
 * `/api/usage/eligibility` route, `autopilot-idle`, `collect-state.sh` via the
 * route) and the boolean is overlaid here, preserving the documented purity
 * contract while satisfying AC#3/AC#7 ("eligibility surfaces paused").
 *
 * When `paused` is true this returns a new eligibility object with
 * `allow=false` and `reasons.paused=true`, so EVERY dispatch class is blocked
 * for the turn (the same hard-stop path `emergencyStop` rides) — the autopilot
 * drains. When `paused` is false the input is returned UNCHANGED (no spurious
 * mutation): pause never *enables* anything a quota stop disabled. Pure: no IO,
 * no mutation of the input object.
 */
export function overlayPauseEligibility(
  eligibility: UsageEligibility,
  paused: boolean,
): UsageEligibility {
  if (!paused) return eligibility;
  return {
    ...eligibility,
    allow: false,
    reasons: { ...eligibility.reasons, paused: true },
  };
}

/**
 * Overlay the session-limit hard-block (issue #1089) onto an eligibility
 * projection, at the caller/route seam.
 *
 * The autopilot exits `code=1` the instant the Claude Code rolling SESSION
 * window is exhausted (`You've hit your session limit · resets <t>`). The
 * pace-gate then relaunches into the still-exhausted quota — dying instantly,
 * repeatedly — because the OAuth 5h meter (`emergencyStop`) reads below 90%
 * even while the session is hard-blocked. This overlay closes that skew: while
 * `blockedUntilMs` is a FUTURE instant relative to `nowMs`, it forces
 * `allow=false` (the same drain path `emergencyStop`/pause ride) so the
 * launcher skips relaunch, AND surfaces the ISO instant under
 * `reasons.sessionBlockedUntil` so the gate is a pure read of the snapshot.
 *
 * `blockedUntilMs` is a Redis read (durable across the process exit), kept OUT
 * of the pure `projectEligibility` exactly like the pause flag. `nowMs` is
 * injected so the future-vs-past comparison stays deterministic/testable. A
 * `null` block, or a block whose instant is already in the past, returns the
 * input UNCHANGED — the block self-clears the moment the reset passes, so a
 * stale block can never wedge autopilot off. Pure: no IO, no mutation.
 */
export function overlaySessionBlockEligibility(
  eligibility: UsageEligibility,
  blockedUntilMs: number | null,
  nowMs: number,
): UsageEligibility {
  if (blockedUntilMs === null || !Number.isFinite(blockedUntilMs) || blockedUntilMs <= nowMs) {
    return eligibility;
  }
  return {
    ...eligibility,
    allow: false,
    reasons: {
      ...eligibility.reasons,
      sessionBlockedUntil: new Date(blockedUntilMs).toISOString(),
    },
  };
}
