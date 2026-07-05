/**
 * Wiring-liveness TIMER-check seam (issue #2830; extracted from
 * `wiring-liveness.ts`, originally landed by #2287 slice 1; parent epic #2286).
 *
 * One check type, one module — the first (original) check family the
 * wiring-liveness chore fans out to, now a sibling of the output-series path
 * (`wiring-liveness-output.ts`, #2456) and the dark-outcome path
 * (`wiring-liveness-outcomes.ts`, #2753). Where the output check catches a live
 * source pinned at/below a floor, THIS check catches a declared systemd `timer`
 * entry that is MISSING from the live `--user` set, STALE past its window, or
 * NOT-YET-FIRED (present but never fired — the false-positive guard). It owns:
 * the liveness YAML-subset parser thin wrapper ({@link parseLivenessYaml}), the
 * manifest loader ({@link loadLivenessManifest}), and the pure timer-diff
 * evaluator ({@link diffTimers}) plus its result/verdict shapes.
 *
 * NOT-YET-FIRED is the timer false-positive guard: a timer that exists in the
 * live set but has never fired (`last: 0`, e.g. hydra-betting-nba-injuries before
 * its first 07:00 run) is classified NOT-YET-FIRED and is NEVER flagged STALE.
 *
 * NEVER THROWS (CLAUDE.md fail-loud + host-probe never-throw conventions): every
 * failure mode — manifest read error, parse error, schema-validation error — is
 * routed to a result object, never an exception, so the timer check can never
 * abort the housekeeping run.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  LivenessManifestSchema,
  type LivenessEntry,
  type LivenessManifest,
} from "../../schemas/liveness.ts";
import { type TimerRecord } from "../../host-probe/probe.ts";
import { parseConfigYaml, type YamlValue } from "../../config-yaml.ts";

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
export function isLoadFailure(
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

/**
 * The timer-check-only result returned by {@link diffTimers}. Contains only the
 * fields this leaf knows: the timer evaluation verdict, the missing/stale/notYetFired
 * summaries, and the per-entry verdicts array.
 *
 * This is the narrower type that replaces the old `WiringLivenessResult` return of
 * `diffTimers`. The aggregate chore result ({@link WiringLivenessResult}) now lives
 * in the coordinator (`wiring-liveness.ts`), which assembles all four check-family
 * results — timer, output, dark-outcomes, dark-alarm — into a single constructed
 * object (issue #2844: move aggregate type to coordinator).
 */
export interface TimerDiffResult {
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
  /** Every per-entry timer verdict, for diagnostics/tests. */
  verdicts: TimerVerdict[];
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
 * `output` type is evaluated separately by `evaluateOutputs`).
 */
export function diffTimers(
  entries: LivenessEntry[],
  live: TimerRecord[],
  nowMs: number = Date.now(),
): TimerDiffResult {
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
    verdicts,
  };
}
