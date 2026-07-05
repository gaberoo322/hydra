/**
 * Wiring-liveness chore (issue #2287 slice 1, #2288 slice 2; parent epic #2286).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`). It answers a
 * question the Outcome Holdback (`src/holdback.ts`) cannot: did a declared
 * critical entrypoint ever go live at all — and once live, is it actually
 * producing output? The holdback watches a change that IS live for regressions;
 * this chore catches a change that NEVER went live (a declared timer missing from
 * the running systemd set, or stale past its window) AND the live-but-inert
 * failure mode (a source that runs on schedule but produces zero / floor-pinned
 * output).
 *
 * One check type, one module (issue #2456) — every check family lives in its own
 * focused sibling; `runWiringLiveness` here is the thin coordinator that fans out
 * to all of them and merges their results into a single {@link WiringLivenessResult}:
 *   - `timer`  (slice 1, #2287): diff declared systemd timers against the live
 *     `--user` timer set → MISSING, STALE, NOT-YET-FIRED, OK. This path lives in
 *     the focused sibling module `wiring-liveness-timer.ts` ({@link diffTimers},
 *     extracted by #2830 — the last check family to leave the coordinator).
 *   - `output` (slice 2, #2288): read the trailing run-series for a declared
 *     source (an Orchestrator API path / metric) at a JSON path and flag
 *     BELOW-FLOOR when every value in the `minOverRuns.runs` window is at or
 *     below `minOverRuns.value`. A single value above the floor clears the alert
 *     — the check is stateless, so a recovered source never sticks a
 *     false-positive. This path lives in the focused sibling module
 *     `wiring-liveness-output.ts` ({@link evaluateOutputs}).
 *
 * NEVER THROWS (CLAUDE.md fail-loud + host-probe never-throw conventions): every
 * failure mode — manifest read error, parse error, schema-validation error,
 * host-probe spawn/timeout/empty, output-source read error — is routed to a
 * result object, never an exception. Combined with `runChore`'s try/catch in the
 * registry, there is no path by which this chore can abort the housekeeping run.
 *
 * NOT-YET-FIRED is the timer false-positive guard: a timer that exists in the
 * live set but has never fired (`last: 0`, e.g. hydra-betting-nba-injuries before
 * its first 07:00 run) is classified NOT-YET-FIRED and is NEVER flagged STALE.
 */

import {
  readUserTimers,
  isProbeFailure,
  type TimerRecord,
  type ProbeResult,
} from "../../host-probe/probe.ts";
import {
  evaluateOutputs,
  productionOutputReader,
  type OutputSourceReader,
  type OutputVerdict,
} from "./wiring-liveness-output.ts";
import {
  evaluateDarkOutcomes,
  type OutcomeVerdict,
  type DarkOutcomesDeps,
} from "./wiring-liveness-outcomes.ts";
import {
  runDarkOutcomeAlarm,
  type DarkAlarmDeps,
  type DarkAlarmResult,
} from "./wiring-liveness-dark-alarm.ts";
// The timer-check family (slice 1, #2287) lives in its own focused sibling module
// (`wiring-liveness-timer.ts`, extracted by #2830 — one check type, one module).
// `runWiringLiveness` below imports the timer primitives from there: the manifest
// loader + failure guard, and the pure timer diff. `diffTimers` now returns the
// narrower `TimerDiffResult` (only timer-check fields). The coordinator assembles
// all four check-family results into the aggregate `WiringLivenessResult` defined
// and owned here (issue #2844 — moved from timer leaf to coordinator).
import {
  loadLivenessManifest,
  isLoadFailure,
  diffTimers,
  type LoadManifestResult,
  type TimerDiffResult,
} from "./wiring-liveness-timer.ts";
// OutputVerdict is already imported above via the wiring-liveness-output.ts import block.
// OutcomeVerdict is already imported above via the wiring-liveness-outcomes.ts import block.

// The two output-check type names `test/wiring-liveness.test.mts` consumes through
// this module's surface (for its `runWiringLiveness` integration cases) are
// re-exported here; every other symbol is imported directly from the output module
// by its live consumers, so re-exporting it here would be dead surface (knip #2484).
export {
  type OutputSourceReader,
  type OutputSeriesResult,
} from "./wiring-liveness-output.ts";

// ---------------------------------------------------------------------------
// Aggregate result type (issue #2844: moved here from wiring-liveness-timer.ts)
//
// `WiringLivenessResult` aggregates fields from all four check families: timer-diff
// (slice 1, #2287), output-series (slice 2, #2288), dark-outcomes (#2753), and
// dark-alarm (#2805). Its correct home is this coordinator — the module that
// assembles all four results. Previously it lived in `wiring-liveness-timer.ts`
// because it originated as the timer diff's return type, but as new check families
// added their fields incrementally, the aggregate outgrew its leaf home.
//
// `TimerDiffResult` (the narrower timer-only type) remains in `wiring-liveness-timer.ts`
// as the return type of `diffTimers`. The coordinator constructs `WiringLivenessResult`
// from all assembled check-family results — construction, not in-place mutation.
// ---------------------------------------------------------------------------

/** The chore's aggregate never-throwing result object. Owned by the coordinator. */
export interface WiringLivenessResult {
  /** True when the manifest loaded and the live timers were read. */
  evaluated: boolean;
  /** When `evaluated` is false, why (load/probe failure). */
  reason?: string;
  /** Declared timers absent from the live set. */
  missing: string[];
  /** Declared timers present but staler than their window. */
  stale: string[];
  /** Declared timers present but never-fired-yet (false-positive guard). */
  notYetFired: string[];
  /** Declared output sources pinned at/below their floor across the run window. */
  belowFloor: string[];
  /** Declared output sources whose live value could not be read this run. */
  unreadable: string[];
  /**
   * Declared `kind: leading` outcomes whose current reading is `null` — no data
   * (producer never wrote the metric, or the file went missing/unparseable).
   * Advisory (issue #2753): a dark leading outcome is silent holdback blindness.
   */
  darkOutcomes: string[];
  /**
   * Declared `kind: leading` outcomes with a finite reading whose file mtime is
   * OLDER than the grace window — a present-but-old value (a stalled producer),
   * distinct from a `null` (never-produced) DARK outcome. Invariant 3 (issue
   * #2753): STALE and DARK are separate verdicts, never conflated. Advisory only.
   */
  staleOutcomes: string[];
  /** Every per-entry timer verdict, for diagnostics/tests. */
  verdicts: TimerDiffResult["verdicts"];
  /** Every per-entry output verdict, for diagnostics/tests. */
  outputVerdicts: OutputVerdict[];
  /** Every per-outcome dark/live verdict, for diagnostics/tests (issue #2753). */
  outcomeVerdicts: OutcomeVerdict[];
  /**
   * Outcome-alarm result (issue #2805): which dark leading outcomes crossed the
   * 7-day sustained-dark threshold and got a fresh `needs-triage` issue filed
   * this tick, plus the per-outcome alarm actions (below-threshold / already-filed
   * / filed / file-failed). `undefined` when the alarm did not run (e.g. an
   * evaluation short-circuit). Advisory — a file failure never aborts the chore.
   */
  darkAlarm?: DarkAlarmResult;
}

// ---------------------------------------------------------------------------
// Chore runner
// ---------------------------------------------------------------------------

/** External touchpoints of the wiring-liveness chore. */
export interface WiringLivenessDeps {
  /**
   * Injectable live-timer reader (the Host-Probe Adapter accessor). Tests pass a
   * fake so no real `systemctl` is spawned. Defaults to the real
   * `readUserTimers` from the host-probe seam.
   */
  readTimers?: () => Promise<ProbeResult<TimerRecord[]>>;
  /**
   * Injectable output-source reader (slice 2). Tests pass a deterministic fake so
   * below-floor / at-floor / recovered cases are reproducible. When omitted, the
   * chore uses the live {@link productionOutputReader} (issue #2578) — it fetches
   * each declared source from the Target via `HYDRA_BETTING_URL`, accumulates the
   * per-source run-series in a bounded Redis list, and returns the trailing window
   * for `evaluateOutputs`. A failed read is UNREADABLE (informational, never an
   * alarm), so a transient Target outage does not false-flag a below-floor output.
   */
  readOutput?: OutputSourceReader;
  /**
   * Injectable dark-outcome check deps (issue #2753). Tests pass a fake outcomes
   * loader + value reader so dark vs live leading-outcome cases are reproducible
   * without a real `config/direction/outcomes.yaml` or metric files. When omitted,
   * the check uses the real outcomes loader + `getOutcomeValue` seam — it reads
   * every declared `kind: leading` outcome and flags DARK when its reading is
   * `null` (no data ever produced / file missing/unparseable).
   */
  darkOutcomes?: DarkOutcomesDeps;
  /**
   * Injectable dark-outcome ALARM deps (issue #2805). Tests pass a fake clock +
   * threshold + gh filer + Redis streak accessors so the "file only after 7 days
   * continuously dark, idempotent, clears on recovery" policy is reproducible
   * without a real gh spawn or Redis. When omitted, the alarm uses the real gh
   * CLI Adapter + the wiring-liveness-dark-outcomes Redis seam. The alarm is
   * advisory — a file failure is logged, never thrown, never aborts the chore.
   */
  darkAlarm?: DarkAlarmDeps;
  /** Injectable manifest loader so tests can point at a fixture. */
  loadManifest?: (filePath?: string) => Promise<LoadManifestResult>;
  /**
   * Path to the manifest; defaults to `DEFAULT_LIVENESS_FILE`
   * (`config/direction/liveness.yaml`, owned by `wiring-liveness-timer.ts`).
   */
  manifestPath?: string;
  /** Injectable clock for the stale boundary; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run the wiring-liveness chore. Loads the manifest, reads the live timers, diffs
 * them, evaluates declared output sources, and logs a single diagnostic line when
 * there is something actionable (missing/stale timers or below-floor outputs). A
 * clean run (manifest valid, timers read, nothing flagged) is SILENT — mirroring
 * work-queue-hygiene, which only logs when there is something to report.
 *
 * Never throws — a load failure, an empty/failed host-probe, or any other error
 * is caught and routed to a `{ evaluated: false, reason }` result with a logged
 * diagnostic. The registry's `runChore` would also catch a throw, but the
 * never-throw contract is honored here directly so the result object is always
 * meaningful to a direct caller (a future health surface).
 */
export async function runWiringLiveness(
  deps: WiringLivenessDeps = {},
): Promise<WiringLivenessResult> {
  const loadManifest = deps.loadManifest ?? loadLivenessManifest;
  const readTimers = deps.readTimers ?? readUserTimers;
  const readOutput = deps.readOutput ?? productionOutputReader();
  const now = deps.now ?? Date.now;

  try {
    const loaded = await loadManifest(deps.manifestPath);
    if (isLoadFailure(loaded)) {
      console.error(`[Housekeeping] wiring-liveness: ${loaded.reason}`);
      return emptyResult({ evaluated: false, reason: loaded.reason });
    }

    const probe = await readTimers();
    if (isProbeFailure(probe)) {
      const reason = `host-probe failed (${probe.code})`;
      console.error(`[Housekeeping] wiring-liveness: ${reason}`);
      return emptyResult({ evaluated: false, reason });
    }

    // Evaluate all four check families independently, then CONSTRUCT the
    // aggregate result (issue #2844: construction, not in-place mutation).
    const timerResult = diffTimers(loaded.manifest.entries, probe.data, now());

    const outputs = await evaluateOutputs(loaded.manifest.entries, readOutput);

    // Issue #2753: dark leading-outcome check. Reads every declared
    // `kind: leading` outcome from `config/direction/outcomes.yaml` and flags
    // DARK when its current reading is null (no data ever produced / file
    // missing). Advisory only — a dark leading outcome is silent holdback
    // blindness (every baseline carries `value: null`), never a merge gate. Its
    // data plane (outcomes loader) is fully independent of the timer/output
    // checks, so a failure there routes to an empty evaluation without touching
    // the timer verdicts.
    const outcomes = await evaluateDarkOutcomes(deps.darkOutcomes ?? {});

    // Issue #2805: the dark-outcome ALARM. #2753 makes a dark leading outcome
    // VISIBLE per-tick; this turns a SUSTAINED (>=7-day) dark streak into a filed
    // `needs-triage` issue, deduped per streak and cleared on recovery. Fed the
    // dark-arm verdicts (with producerHint + query for the issue body) and the
    // set of outcomes that read LIVE this tick (so their streak/marker clears —
    // stateless recovery). Never throws: a gh/Redis failure inside the alarm
    // folds to a per-outcome `file-failed` action, so the alarm can no more abort
    // the chore than the detection can.
    const darkVerdicts = outcomes.outcomeVerdicts.filter(
      (v): v is Extract<OutcomeVerdict, { status: "dark" }> => v.status === "dark",
    );
    const liveOrRecoveredNames = outcomes.outcomeVerdicts
      .filter((v) => v.status === "live")
      .map((v) => v.name);
    const darkAlarm = await runDarkOutcomeAlarm(
      darkVerdicts,
      liveOrRecoveredNames,
      deps.darkAlarm ?? {},
    );

    // Construct the aggregate result from all four check-family results.
    // All invariants are true at construction time — no partially-assembled object
    // exists at the type level before this point (issue #2844).
    const result: WiringLivenessResult = {
      evaluated: timerResult.evaluated,
      reason: timerResult.reason,
      missing: timerResult.missing,
      stale: timerResult.stale,
      notYetFired: timerResult.notYetFired,
      verdicts: timerResult.verdicts,
      belowFloor: outputs.belowFloor,
      unreadable: outputs.unreadable,
      outputVerdicts: outputs.outputVerdicts,
      darkOutcomes: outcomes.darkOutcomes,
      staleOutcomes: outcomes.staleOutcomes,
      outcomeVerdicts: outcomes.outcomeVerdicts,
      darkAlarm,
    };

    if (
      result.missing.length > 0 ||
      result.stale.length > 0 ||
      result.belowFloor.length > 0 ||
      result.darkOutcomes.length > 0 ||
      result.staleOutcomes.length > 0
    ) {
      const parts: string[] = [];
      if (result.missing.length > 0) parts.push(`missing timers: ${result.missing.join(", ")}`);
      if (result.stale.length > 0) parts.push(`stale timers: ${result.stale.join(", ")}`);
      if (result.belowFloor.length > 0) {
        parts.push(`below-floor outputs: ${result.belowFloor.join(", ")}`);
      }
      if (result.darkOutcomes.length > 0) {
        // Include the producer hint for each dark outcome so the operator can
        // diagnose WHICH producer is dark, not just that a null exists.
        const darkDetail = result.outcomeVerdicts
          .map((v) => (v.status === "dark" ? `${v.name} (${v.producerHint})` : ""))
          .filter((s) => s.length > 0)
          .join("; ");
        parts.push(`dark leading outcomes: ${darkDetail}`);
      }
      if (result.staleOutcomes.length > 0) {
        // STALE (present-but-old) is distinct from DARK — surface it separately
        // with the producer hint so the operator knows the producer stalled
        // rather than never having written at all (Invariant 3, issue #2753).
        const staleDetail = result.outcomeVerdicts
          .map((v) => (v.status === "stale" ? `${v.name} (${v.producerHint})` : ""))
          .filter((s) => s.length > 0)
          .join("; ");
        parts.push(`stale leading outcomes: ${staleDetail}`);
      }
      console.warn(
        `[Housekeeping] wiring-liveness flagged declared entrypoints — ${parts.join("; ")}`,
      );
    }

    return result;
  } catch (err: any) {
    // Defense in depth: nothing above should throw, but a never-throw chore must
    // never leak an exception even if a dep does. Fail loud, return a result.
    const reason = `unexpected error: ${err?.message || err}`;
    console.error(`[Housekeeping] wiring-liveness: ${reason}`);
    return emptyResult({ evaluated: false, reason });
  }
}

/** Build a zeroed result with the given header fields (avoids repeating empties). */
function emptyResult(header: {
  evaluated: boolean;
  reason?: string;
}): WiringLivenessResult {
  return {
    evaluated: header.evaluated,
    reason: header.reason,
    missing: [],
    stale: [],
    notYetFired: [],
    belowFloor: [],
    unreadable: [],
    darkOutcomes: [],
    staleOutcomes: [],
    verdicts: [],
    outputVerdicts: [],
    outcomeVerdicts: [],
  };
}
