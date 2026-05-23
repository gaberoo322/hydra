# Stuckness detector retired; self-improvement floor is operator-curated

The automated **Stuckness** detector (`src/stuckness.ts`, `hydra:outcomes:history:*` time series, `hydra:outcomes:stuckness-fired:*` edge-trigger cache, the `outcomes.stuckness.fired` event, the `/api/outcomes/stuckness` route, and the stuckness-driven capacity-floor declaration) has been deleted. The 25% self-improvement share from ADR-0003 vision vector 1 remains policy but is enforced by `config/direction/priorities.md`, not by an automated trip wire.

## Why retire it

The detector was written for the in-process control loop that ADR-0006 removed. `recordOutcomeReadings()` — the only function that wrote to `hydra:outcomes:history:*` — had no production caller after the codex cut-over. Its docstring said it "must be safe to call from cycle.ts," but `cycle.ts` did not call it. As a result:

- The outcome-history time series was empty for every outcome.
- `getAllStuckness()` always returned `cyclesStuck: 0, fired: false`.
- The `/api/outcomes/stuckness` endpoint reported all-zero state regardless of what outcomes were actually doing.
- The stuckness-driven self-improvement capacity floor (`stucknessFloorDecl` in `src/anchor-selection/capacity-floors.ts`) read those zero rows and never fired — the 25% share described by ADR-0003 was already being enforced (or not) entirely through operator priority-setting.

Six months of dark code with no caller, no telemetry, and no behavioural impact is strong evidence the autopilot's dispatch model superseded the trip-wire mechanism. The honest fix is to delete the dead path and document the actual enforcement model.

## What changed

**Deleted:**
- `src/stuckness.ts`
- `src/anchor-selection/stuckness-routing.ts`
- `test/stuckness.test.mts`
- `test/anchor-selection-stuckness.test.mts`
- `stucknessFloorDecl` and the `selfImprovement` field of `CapacityFloorsConfig` in `src/anchor-selection/capacity-floors.ts`
- `STUCKNESS_COOLDOWN_PREFIX`, `STUCKNESS_COOLDOWN_TTL_SECONDS`, and `stucknessCooldownKey()` in `src/anchor-selection/constants.ts`
- `GET /api/outcomes/stuckness` route in `src/api/outcomes.ts`
- The `lastMovedAt` field in the outcomes API response (was always `null`)
- The `stuckness_threshold_cycles` field in the `Outcome` schema (`src/outcomes.ts` and `config/direction/outcomes.yaml`)
- The `*Stuckness:*` section of the digest (`src/digest.ts`)
- The `stuckness_won` value in the `ReframePassedReason` enum (`src/anchor-selection/reframe-starvation.ts`)
- The **Stuckness** glossary entry in `CONTEXT.md`

**Kept:**
- The capacity-floor dispatcher (`src/anchor-selection/capacity-floors.ts`) — the scaffolding stays so future floors with non-stuckness triggers can plug in cleanly.
- The reframe-queue floor (issue #377) — independent of stuckness, still serving.
- The `capacity-floor.ts` (singular) orchestrator-vs-target share metric — still useful as a Target Outcome readable through the file adapter; just no longer feeds a trip wire.
- ADR-0003 — terminal goal hierarchy unchanged; only the *mechanism* enforcing the 25% share changed. ADR-0003 has been amended to record that priorities now do the work stuckness used to do.

## Considered options

**Revive the recorder.** Wire `recordOutcomeReadings()` into the autopilot tick or `hydra-qa` post-merge. Rejected because reviving the detector means picking a cycle-id source (autopilot tick number? merge sha?), a tick cadence, and a backfill story for the empty ZSETs — non-trivial work to resurrect a feature whose absence apparently hasn't been missed in six months.

**Keep `stucknessFloorDecl` as a dead branch and remove only the detector.** Rejected as worst-of-both — the code would look alive but never fire, exactly the failure mode that produced this retirement in the first place.

**Replace the stuckness trigger with a cadence-based one** (e.g. "every Nth eligible cycle, pre-empt kanban with research"). Rejected because operator priority-setting already does this work; adding a second mechanism would mean two surfaces to tune and two ways to be wrong about the share.

## Future re-introduction

If a future need for an automated outcome-stagnation trip wire arises, the design should sit outside the in-process control loop entirely: a separate periodic job (Linux timer or autopilot class) that reads outcome snapshots, computes movement, and writes a Redis flag that the dispatch loop can consult — not a function that needs to be called from the cycle hot path. This ADR is not a ban on the *concept*; it's a retirement of the specific implementation that died with codex.
