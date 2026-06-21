/**
 * Wiring-liveness chore (issue #2287, parent epic #2286).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`). It answers a
 * question the Outcome Holdback (`src/holdback.ts`) cannot: did a declared
 * critical entrypoint ever go live at all? The holdback watches a change that IS
 * live for regressions; this chore catches a change that NEVER went live — a
 * declared timer missing from the running systemd set, or one that has gone
 * stale past its freshness window.
 *
 * This slice implements the `timer` check type only. The chore:
 *   1. Loads + validates `config/direction/liveness.yaml` (hand-rolled YAML
 *      subset → zod `safeParse`; no YAML runtime dependency, ADR-0005).
 *   2. Reads the live `--user` timer set through the Host-Probe Adapter accessor
 *      `readUserTimers` (`systemctl --user list-timers --output=json`).
 *   3. Diffs declared vs live into three distinct verdicts — MISSING, STALE,
 *      NOT-YET-FIRED — and surfaces the actionable ones (missing/stale) as a
 *      diagnostic log line. An all-present / all-fresh run is silent.
 *
 * NEVER THROWS (CLAUDE.md fail-loud + host-probe never-throw conventions): every
 * failure mode — manifest read error, parse error, schema-validation error,
 * host-probe spawn/timeout/empty — is routed to a result object, never an
 * exception. Combined with `runChore`'s try/catch in the registry, there is no
 * path by which this chore can abort the housekeeping run.
 *
 * NOT-YET-FIRED is the false-positive guard: a timer that exists in the live set
 * but has never fired (`last: 0`, e.g. hydra-betting-nba-injuries before its
 * first 07:00 run) is classified NOT-YET-FIRED and is NEVER flagged STALE.
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
// YAML-subset parser (issue #2287)
//
// Follows the PATTERN of `src/outcomes-yaml.ts` (tiny no-dependency tokenizer +
// zod safeParse downstream) but is NOT a reuse of it — that parser's shape is
// hardcoded to a top-level `outcomes:` list, whereas the liveness manifest has a
// top-level `entries:` list with different item fields. The grammar supported is
// deliberately the minimum `liveness.yaml` documents:
//   - `#` comments (full-line and trailing) and blank lines
//   - top-level `entries:` introducing a list
//   - `- key: value` list-item-as-mapping
//   - subsequent `  key: value` lines belonging to the most recent list item
//   - scalar values: number, boolean, quoted string, bare string
// ---------------------------------------------------------------------------

/** A single scalar a manifest field can hold in this subset. */
type YamlScalar = string | number | boolean;

/** The parsed document shape before schema validation: a `entries:` list of maps. */
interface ParsedLivenessYaml {
  entries?: Array<Record<string, YamlScalar>>;
}

export interface LivenessParseResult {
  ok: boolean;
  value: ParsedLivenessYaml;
  errors: string[];
}

/**
 * Strip a trailing `# ...` comment, but only when the `#` is not inside a quoted
 * scalar. A small state machine tracks single/double quotes (so a `#` inside a
 * quoted description survives). Mirrors `outcomes-yaml.stripComment`.
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

/**
 * Coerce a raw scalar token into its typed value. Mirrors
 * `outcomes-yaml.parseScalar`: empty → "", true/false → boolean, quoted →
 * unquoted contents, integer/decimal → number, else the bare trimmed string.
 */
function parseScalar(raw: string): YamlScalar {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * Parse the raw text of `liveness.yaml` into `{ ok, value, errors }`. Never
 * throws — malformed lines accumulate in `errors` so the caller can report every
 * problem at once, exactly like the outcomes-yaml parser.
 */
export function parseLivenessYaml(raw: string): LivenessParseResult {
  const errors: string[] = [];
  const result: ParsedLivenessYaml = {};
  const lines = raw.split("\n");

  let currentTopKey: string | null = null;
  let currentList: Array<Record<string, YamlScalar>> | null = null;
  let currentItem: Record<string, YamlScalar> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const stripped = stripComment(rawLine);
    if (stripped.trim() === "") continue;

    const indent = stripped.length - stripped.replace(/^ */, "").length;
    const content = stripped.slice(indent);

    if (indent === 0) {
      const m = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!m) {
        errors.push(`line ${i + 1}: unrecognized top-level syntax: "${rawLine}"`);
        continue;
      }
      const key = m[1];
      const inline = m[2];
      currentTopKey = key;
      if (key === "entries") {
        currentList = [];
        result.entries = currentList;
        currentItem = null;
      } else {
        errors.push(`line ${i + 1}: unknown top-level key '${key}' (expected 'entries')`);
      }
      if (inline.trim() !== "") {
        errors.push(`line ${i + 1}: inline value not supported for top-level key '${key}'`);
      }
    } else {
      if (currentTopKey !== "entries" || !currentList) {
        errors.push(`line ${i + 1}: indented content without enclosing 'entries:' list`);
        continue;
      }

      const itemMatch = content.match(/^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (itemMatch) {
        currentItem = {};
        currentList.push(currentItem);
        currentItem[itemMatch[1]] = parseScalar(itemMatch[2]);
        continue;
      }

      const fieldMatch = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (fieldMatch) {
        if (!currentItem) {
          errors.push(`line ${i + 1}: field '${fieldMatch[1]}' has no enclosing list item`);
          continue;
        }
        currentItem[fieldMatch[1]] = parseScalar(fieldMatch[2]);
        continue;
      }

      errors.push(`line ${i + 1}: unrecognized indented syntax: "${rawLine}"`);
    }
  }

  return { ok: errors.length === 0, value: result, errors };
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
// Diff: declared vs live
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
  /** Every per-entry verdict, for diagnostics/tests. */
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
 * Only `type: "timer"` entries are evaluated in this slice; any other type is
 * skipped (forward-compatible with future check types).
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

  return { evaluated: true, missing, stale, notYetFired, verdicts };
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
  /** Injectable manifest loader so tests can point at a fixture. */
  loadManifest?: (filePath?: string) => Promise<LoadManifestResult>;
  /** Path to the manifest; defaults to {@link DEFAULT_LIVENESS_FILE}. */
  manifestPath?: string;
  /** Injectable clock for the stale boundary; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Run the wiring-liveness chore. Loads the manifest, reads the live timers, diffs
 * them, and logs a single diagnostic line when there is something actionable
 * (missing or stale). A clean run (manifest valid, timers read, nothing
 * missing/stale) is SILENT — mirroring work-queue-hygiene, which only logs when
 * there is something to report.
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
  const now = deps.now ?? Date.now;

  try {
    const loaded = await loadManifest(deps.manifestPath);
    if (isLoadFailure(loaded)) {
      console.error(`[Housekeeping] wiring-liveness: ${loaded.reason}`);
      return {
        evaluated: false,
        reason: loaded.reason,
        missing: [],
        stale: [],
        notYetFired: [],
        verdicts: [],
      };
    }

    const probe = await readTimers();
    if (isProbeFailure(probe)) {
      const reason = `host-probe failed (${probe.code})`;
      console.error(`[Housekeeping] wiring-liveness: ${reason}`);
      return {
        evaluated: false,
        reason,
        missing: [],
        stale: [],
        notYetFired: [],
        verdicts: [],
      };
    }

    const result = diffTimers(loaded.manifest.entries, probe.data, now());

    if (result.missing.length > 0 || result.stale.length > 0) {
      const parts: string[] = [];
      if (result.missing.length > 0) parts.push(`missing: ${result.missing.join(", ")}`);
      if (result.stale.length > 0) parts.push(`stale: ${result.stale.join(", ")}`);
      console.warn(`[Housekeeping] wiring-liveness flagged declared timers — ${parts.join("; ")}`);
    }

    return result;
  } catch (err: any) {
    // Defense in depth: nothing above should throw, but a never-throw chore must
    // never leak an exception even if a dep does. Fail loud, return a result.
    const reason = `unexpected error: ${err?.message || err}`;
    console.error(`[Housekeeping] wiring-liveness: ${reason}`);
    return {
      evaluated: false,
      reason,
      missing: [],
      stale: [],
      notYetFired: [],
      verdicts: [],
    };
  }
}
