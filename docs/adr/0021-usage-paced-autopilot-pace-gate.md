# Usage-paced 24/7 autopilot via an admission-control Pace Gate

Status: Proposed
Date: 2026-06-01
Deciders: Operator + Hydra (via `/grill-with-docs` session on continuous usage-paced operation)
Issue: TBD (usage-paced-autopilot epic)

## Context

The operator wants three things from `hydra-autopilot`:

1. **Run 24/7**, stopping only when subscription usage is exceeded.
2. **Resume automatically** when the usage limit resets.
3. **Pace consumption** so total weekly burn lands near 100% of quota by the end of the last day of the week — neither leaving quota unused nor exhausting it early.

The machinery to *observe* usage already exists and is live: the **Subscription Usage Tracker** (`src/cost/usage-tracker.ts`) reads the Claude Code JSONL transcripts and is calibrated (`HYDRA_USAGE_WEEKLY_QUOTA_TOKENS`, `HYDRA_USAGE_5H_QUOTA_TOKENS`). `decide.py` already gates on it via `/api/usage/eligibility` — hard-stopping on `emergencyStop` (5h ≥ 90%) and shedding ambient classes on `pacingState === "over"`. The plan (`team`/`default_claude_max_5x`) is confirmed in `~/.claude/.credentials.json`.

Three gaps separate that from the goal:

- **Coverage is discrete, not continuous.** Autopilot fires on timers (historically 10:00 and 22:00), each a finite ~8h token-budgeted **Autopilot Run** that ends on token budget / wall-clock / idle-drain. Between runs, and after a usage-blocked run idle-drains to termination, nothing relaunches it until the next timer.
- **Usage is not the binding stop condition.** A run stops for several reasons unrelated to usage; "stop only when usage is exceeded" is not what happens today.
- **Pacing is rate-projection, not a target curve.** `pacingState` asks "is my *current rate* sustainable for 7 days," not "am I above the *target burn line* for this point in the week." And it is computed against a **rolling 7-day window** — a trailing sum that never resets — whereas "100% by end of the last day of the week" presupposes a **fixed weekly reset boundary** to pace toward. Anthropic's real Max-5x weekly limit *does* reset on a fixed cadence; the tracker models nothing of it, and nothing on disk exposes the reset instant (`stats-cache.json` has only message counts; `policy-limits.json` is policy flags; the credentials `expiresAt` is OAuth-token expiry).

## Decision

**Autopilot becomes a "fill the unused weekly quota" process governed by a new admission-control supervisor — the Pace Gate — that paces *total* combined burn along a linear curve toward the real weekly reset, to a sub-100% ceiling, pausing fully when ahead of the curve or when the 5-hour cap trips.** Runs themselves stay finite and internally unchanged; continuity comes from relaunch, not from one immortal session.

Concretely:

- **D1 — Anchor to Anthropic's real weekly reset, not the rolling window.** Introduce the **Weekly Reset Anchor**: an operator-seeded reset instant (env, read once from the interactive `/usage` view) projected forward in 7-day multiples, then **auto-corrected** whenever a real rate-limit reset timestamp is observed in a transcript. The rolling 7-day window stays as a secondary signal; pacing targets the Anchor.

- **D2 — Pace total combined burn, ceiling below 100%.** The **Pacing Curve** is a linear ramp from 0 at the Anchor to the **Pacing Ceiling** (default ~0.92, `HYDRA_USAGE_WEEKLY_PACE_CEILING`) at the next Anchor. It governs **total** burn across all transcripts (autopilot subagents *and* the operator's interactive sessions, which share one quota), so autopilot **yields** when the operator is active and fills the gaps when idle. The top ~8% is the **Operator Reserve** — guaranteed headroom autopilot never consumes for self-directed work, keeping the operator unlocked.

- **D3 — One-band throttle: pause when ahead, full throttle when behind.** Above the curve → don't launch; on/below → launch full-throttle. This produces a self-correcting sawtooth that hugs the line and lands near the ceiling at week's end. No shed-band, no partial throttle.

- **D4 — No bypass; pause means fully paused.** During a pacing pause nothing fires — incidents included — until the curve catches up or the Anchor passes. Relies on pauses being short (sawtooth) and on the Operator Reserve. The independent 5-hour `emergencyStop` is the only other thing that pauses the Gate, regardless of weekly position.

- **D5 — A relaunch supervisor delivers "24/7", not an immortal session.** The **Pace Gate** is a frequent timer (~15–20 min) running a small check: if an Autopilot Run is already live → skip; else consult eligibility + curve position; if eligible and on/behind → `systemctl --user start hydra-autopilot.service`; else skip. The Gate is the system's only *deliberate* dormancy ("stop only when usage exceeded") and its own resume mechanism ("restart when usage resets" — it relaunches the moment burn falls below the curve, the 5h window drains, or the Anchor passes). It reuses the existing watchdog, concurrent-run guard, and `Restart=on-failure` untouched. The legacy morning/evening autopilot timers are retired in favor of the Gate. Per [ADR-0012](./0012-autopilot-is-the-single-brain.md), the Gate governs **admission** (should a run start now?), never **what work to do** — that stays with `decide.py`.

### Implementation surface (consequences of the above, not new decisions)

- **Tracker:** add `tokensSinceReset` / `percentSinceReset` (a fixed-window sum against the Anchor, distinct from the rolling `percentLast7d`) plus the Anchor projection and auto-correct.
- **Eligibility:** extend `/api/usage/eligibility` with a curve verdict `{ paceState: behind|on|ahead, target%, sinceReset%, anchor }`.
- **Pace Gate:** new `scripts/autopilot/pace-gate.sh` + `hydra-pace-gate.timer`.
- **Per-run limits** (wall-clock, idle-drain, token budget) remain as hygiene caps, subordinate to the Gate, which is the real governor.
- **Workless-board backoff** (issue #2956, a later refinement): the Gate's admission check is usage-only, so when every class is on cooldown and no signals fire it still launches a run whose first `decide.py` turn is wait-only, terminating `cause=idle` in ~2 minutes with zero dispatches (~14% of runs). When a run ends `cause=idle` having dispatched nothing, `endRun` stamps a short temporal `worklessUntil` hint (Redis, self-clearing by TTL; default 45 min, `HYDRA_WORKLESS_BACKOFF_SEC`); the eligibility route surfaces it under `reasons.worklessUntil` and the Gate skips relaunch while it is future. Purely temporal — it stays inside the D5 boundary because it holds NO work-selection knowledge (that remains in `decide.py`) and, unlike `paused`/`sessionBlockedUntil`, it does NOT flip `allow`, so `decide.py` never drains an in-flight or operator session on it. Launcher-only advisory; self-heals if stale.

## Considered options

- **Rolling-window "hold at 100% steady-state"** (no fixed boundary). Rejected: there is no "end of the last day of the week" in a rolling window, so the operator's pacing goal is unrepresentable.
- **Fixed calendar week (e.g. Mon 00:00 local).** Rejected: if it drifts from Anthropic's real reset we either strand quota or get cut off early by the real limit.
- **Empirical-only reset discovery** (learn the reset from a 429 payload, no anchor). Rejected as the *primary* source: blind until we first brush the cap, and pacing-to-ceiling is exactly the plan that brushes it. Kept as the auto-correct mechanism layered on the operator anchor.
- **Literal 100% ceiling, no reserve.** Rejected: a late-week overshoot or a dense burst would lock out the operator's own interactive sessions (including `/hydra-review`) until reset.
- **Autopilot-only budget** (pace own dispatched tokens, ignore operator burn). Rejected: autopilot 92% + operator usage can together blow past the real cap — the surprise lockout pacing exists to prevent.
- **Two-band (shed-then-pause) or shed-only throttle.** Rejected by the operator in favor of the simpler one-band pause; shed-only also lets core classes creep past the curve since they never stop for pacing alone.
- **Critical-class bypass during a pacing pause.** Rejected: pauses are short and the strict "pause means paused" rule is simplest; the Operator Reserve plus the short sawtooth absorb the risk.
- **One immortal sleeping session** for 24/7. Rejected: fights cold-cache (5-min TTL), context bloat, idle-drain, and wedge detection — all built around discrete finite runs.
- **Just densify the timers** (e.g. hourly). Rejected: doesn't track usage, many cold starts, can't resume precisely on reset, and over/undershoots the curve.

## Consequences

- Autopilot's character changes from "scheduled batches" to "continuous background fill that yields to the operator." When the operator is heavy, autopilot is quiet; when idle, it runs to the curve.
- The burn pattern is a sawtooth, not smooth — expect bursts of activity separated by pacing pauses, especially early in the week when the target line is low.
- If the week is mostly idle until the last day, the Gate will run full-throttle to catch up, bounded by the 5-hour `emergencyStop` — so a deep backlog can't be fully drained in the final hours; quota may finish under the ceiling. That is acceptable (the 5h cap is the safety).
- A production incident occurring inside a pacing-pause window waits until the pause lifts. Accepted trade-off (D4); revisit if it bites.
- The Anchor is operator-maintained config. If Anthropic shifts the cadence and no 429 is observed to auto-correct it, pacing drifts until the operator re-reads `/usage`.
- The Subscription Usage Tracker remains a **pure read-side projection**; all new state (Anchor, curve target) is derived, and gating stays in the autopilot via `/api/usage/eligibility` — consistent with the Cost module's "accounting + projection only" boundary.

## Glossary delta

Added to [`CONTEXT.md`](../../CONTEXT.md): **Weekly Reset Anchor**, **Pacing Curve**, **Pacing Ceiling**, **Operator Reserve**, **Pace Gate**. The pre-existing **Subscription Usage Tracker** `pacingState` (rate-projection) is superseded as the pacing signal by the **Pacing Curve** (position-vs-target); the `pacingState` enum may remain as a secondary rolling-window indicator.

## Related

- [ADR-0012](./0012-autopilot-is-the-single-brain.md) — autopilot is the single decisional brain; the Pace Gate governs admission, not work.
- Subscription Usage Tracker / Cost module (`src/cost/`), `/api/usage`, `/api/usage/eligibility` — the observation and gating substrate this builds on.
- Subscription Usage Tracker calibration (issues #606/#608/#610/#611) and Quota Weight (#691).
