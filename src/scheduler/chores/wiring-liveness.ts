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
 * Two check types — one module each (issue #2456):
 *   - `timer`  (slice 1, #2287): diff declared systemd timers against the live
 *     `--user` timer set → MISSING, STALE, NOT-YET-FIRED, OK. This path lives in
 *     THIS file ({@link diffTimers}).
 *   - `output` (slice 2, #2288): read the trailing run-series for a declared
 *     source (an Orchestrator API path / metric) at a JSON path and flag
 *     BELOW-FLOOR when every value in the `minOverRuns.runs` window is at or
 *     below `minOverRuns.value`. A single value above the floor clears the alert
 *     — the check is stateless, so a recovered source never sticks a
 *     false-positive. This path lives in the focused sibling module
 *     `wiring-liveness-output.ts` ({@link evaluateOutputs}); `runWiringLiveness`
 *     here is the thin coordinator that fans out to both and merges results.
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

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  LivenessManifestSchema,
  type LivenessEntry,
  type LivenessManifest,
} from "../../schemas/liveness.ts";
import {
  readUserTimers,
  isProbeFailure,
  type TimerRecord,
  type ProbeResult,
} from "../../host-probe/probe.ts";
import { parseConfigYaml, type YamlValue } from "../../config-yaml.ts";
import {
  evaluateOutputs,
  defaultOutputReader,
  type OutputVerdict,
  type OutputSourceReader,
} from "./wiring-liveness-output.ts";

// The output-series check (slice 2, #2288) lives in its own focused module
// (`wiring-liveness-output.ts`, extracted by #2456 — one check type, one module).
// Only the two type names `test/wiring-liveness.test.mts` consumes through this
// module's surface (for its `runWiringLiveness` integration cases) are re-exported
// here; every other symbol is imported directly from the output module by its
// live consumers, so re-exporting it here would be dead surface (knip #2484).
export {
  type OutputSourceReader,
  type OutputSeriesResult,
} from "./wiring-liveness-output.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME || "", "hydra");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

/**
 * Default path to `config/direction/liveness.yaml`. Module-private — tests point
 * the loader at a fixture via the injected `loadManifest`/`manifestPath` deps.
 */
const DEFAULT_LIVENESS_FILE = join(CONFIG_PATH, "direction", "liveness.yaml");

/** Epoch-microseconds → milliseconds (systemd reports timer times in micros). */
const MICROS_PER_MS = 1000;

// ---------------------------------------------------------------------------
// YAML-subset parser (issue #2287 slice 1, extended for #2288 slice 2)
//
// The grammar (the quote-aware comment-stripping state machine, scalar coercion,
// and the parse loop) lives in the shared, domain-agnostic `src/config-yaml.ts`
// (consolidated by issue #2314 — it was previously a byte-identical private copy
// of the `src/outcomes-yaml.ts` primitives). `parseLivenessYaml` is now a thin
// typed wrapper that supplies the liveness top-level key (`entries`) and opts
// into the one-level nested-mapping extension (`nestedMappings:true`, for the
// slice-2 `minOverRuns:` block) the outcomes config does not use. The grammar
// edge cases (`#` inside quotes, scalar coercion) are exercised by
// `test/config-yaml.test.mts`; this file keeps wrapper-level round-trip coverage
// (incl. the nested `minOverRuns` case) in `test/wiring-liveness.test.mts`.
// ---------------------------------------------------------------------------

/** The parsed document shape before schema validation: an `entries:` list of maps. */
interface ParsedLivenessYaml {
  entries?: Array<Record<string, YamlValue>>;
}

export interface LivenessParseResult {
  ok: boolean;
  value: ParsedLivenessYaml;
  errors: string[];
}

/**
 * Parse the raw text of `liveness.yaml` into `{ ok, value, errors }`. A thin
 * wrapper over {@link parseConfigYaml} with the liveness top-level key
 * (`entries`) and the one-level nested-mapping extension enabled (so the
 * slice-2 `minOverRuns:` block parses to a nested `{ value, runs }` map). Never
 * throws — malformed lines accumulate in `errors` so the caller can report every
 * problem at once.
 */
export function parseLivenessYaml(raw: string): LivenessParseResult {
  const parsed = parseConfigYaml(raw, { topKey: "entries", nestedMappings: true });
  const value: ParsedLivenessYaml = {};
  if (parsed.value.entries !== undefined) value.entries = parsed.value.entries;
  return { ok: parsed.ok, value, errors: parsed.errors };
}

// ---------------------------------------------------------------------------
// Manifest loader
// ---------------------------------------------------------------------------

/** Discriminated load result — never throws, mirrors the host-probe convention. */
export type LoadManifestResult =
  | { ok: true; manifest: LivenessManifest }
  | { ok: false; reason: string };

/**
 * Type guard narrowing a {@link LoadManifestResult} to its failure arm.
 *
 * The orchestrator's `tsconfig.json` runs `strict: false` (no `strictNullChecks`),
 * so TypeScript cannot discriminate this union on the boolean `ok` field via a
 * plain `if (!result.ok)`. This guard gives callers reliable narrowing — mirroring
 * `isProbeFailure` in the Host-Probe Adapter.
 */
function isLoadFailure(
  result: LoadManifestResult,
): result is { ok: false; reason: string } {
  return result.ok === false;
}

/**
 * Load + validate the liveness manifest. Reads the file, parses the YAML subset,
 * then `safeParse`s through {@link LivenessManifestSchema}. Every failure mode
 * (missing file, parse error, schema-validation error) returns a typed `reason`
 * — never a throw.
 */
export async function loadLivenessManifest(
  filePath: string = DEFAULT_LIVENESS_FILE,
): Promise<LoadManifestResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: any) {
    return { ok: false, reason: `cannot read manifest ${filePath}: ${err?.message || err}` };
  }

  const parsed = parseLivenessYaml(raw);
  if (!parsed.ok) {
    return { ok: false, reason: `manifest parse errors: ${parsed.errors.join("; ")}` };
  }

  const validated = LivenessManifestSchema.safeParse(parsed.value);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
      .join("; ");
    return { ok: false, reason: `manifest schema validation failed: ${issues}` };
  }

  return { ok: true, manifest: validated.data };
}

// ---------------------------------------------------------------------------
// Diff: declared vs live (timer check, slice 1)
// ---------------------------------------------------------------------------

/** Per-entry verdict from diffing a declared timer against the live set. */
type TimerVerdict =
  | { unit: string; status: "ok"; lastFiredMsAgo: number }
  | { unit: string; status: "missing" }
  | { unit: string; status: "not-yet-fired" }
  | { unit: string; status: "stale"; lastFiredMsAgo: number; maxStaleMinutes: number };

/** The chore's never-throwing result object. */
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
  /** Every per-entry timer verdict, for diagnostics/tests. */
  verdicts: TimerVerdict[];
  /** Every per-entry output verdict, for diagnostics/tests. */
  outputVerdicts: OutputVerdict[];
}

/**
 * Pure diff of declared `timer` entries against the live timer set. Exported so
 * the verdict logic is unit-tested without I/O. `nowMs` is injectable so the
 * stale boundary is deterministic in tests.
 *
 * Verdicts (the three distinct cases the design concept pins):
 *   - MISSING        — declared unit absent from the live set.
 *   - NOT-YET-FIRED  — present but `last` is absent/0 (never fired). The
 *                      false-positive guard: this is NEVER flagged stale.
 *   - STALE          — present, has fired, and `now - last > maxStaleMinutes`.
 *   - OK             — present and fresh.
 *
 * Only `type: "timer"` entries are evaluated here; other types are skipped (the
 * `output` type is evaluated separately by {@link evaluateOutputs}).
 */
export function diffTimers(
  entries: LivenessEntry[],
  live: TimerRecord[],
  nowMs: number = Date.now(),
): WiringLivenessResult {
  const byUnit = new Map<string, TimerRecord>();
  for (const rec of live) byUnit.set(rec.unit, rec);

  const verdicts: TimerVerdict[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  const notYetFired: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "timer") continue;
    const rec = byUnit.get(entry.unit);
    if (!rec) {
      verdicts.push({ unit: entry.unit, status: "missing" });
      missing.push(entry.unit);
      continue;
    }
    // `last` is epoch microseconds; 0 (or any non-positive) means never fired.
    if (!rec.last || rec.last <= 0) {
      verdicts.push({ unit: entry.unit, status: "not-yet-fired" });
      notYetFired.push(entry.unit);
      continue;
    }
    const lastFiredMsAgo = nowMs - rec.last / MICROS_PER_MS;
    if (lastFiredMsAgo > entry.maxStaleMinutes * 60_000) {
      verdicts.push({
        unit: entry.unit,
        status: "stale",
        lastFiredMsAgo,
        maxStaleMinutes: entry.maxStaleMinutes,
      });
      stale.push(entry.unit);
      continue;
    }
    verdicts.push({ unit: entry.unit, status: "ok", lastFiredMsAgo });
  }

  return {
    evaluated: true,
    missing,
    stale,
    notYetFired,
    belowFloor: [],
    unreadable: [],
    verdicts,
    outputVerdicts: [],
  };
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
   * chore uses {@link defaultOutputReader} — a no-op that marks every output
   * source UNREADABLE (no live network reader is wired yet; a follow-up supplies
   * it). UNREADABLE is informational, not an alert, so the scheduled chore stays
   * silent for outputs until a real reader is injected.
   */
  readOutput?: OutputSourceReader;
  /** Injectable manifest loader so tests can point at a fixture. */
  loadManifest?: (filePath?: string) => Promise<LoadManifestResult>;
  /** Path to the manifest; defaults to {@link DEFAULT_LIVENESS_FILE}. */
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
  const readOutput = deps.readOutput ?? defaultOutputReader;
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

    const result = diffTimers(loaded.manifest.entries, probe.data, now());

    const outputs = await evaluateOutputs(loaded.manifest.entries, readOutput);
    result.belowFloor = outputs.belowFloor;
    result.unreadable = outputs.unreadable;
    result.outputVerdicts = outputs.outputVerdicts;

    if (result.missing.length > 0 || result.stale.length > 0 || result.belowFloor.length > 0) {
      const parts: string[] = [];
      if (result.missing.length > 0) parts.push(`missing timers: ${result.missing.join(", ")}`);
      if (result.stale.length > 0) parts.push(`stale timers: ${result.stale.join(", ")}`);
      if (result.belowFloor.length > 0) {
        parts.push(`below-floor outputs: ${result.belowFloor.join(", ")}`);
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
    verdicts: [],
    outputVerdicts: [],
  };
}
