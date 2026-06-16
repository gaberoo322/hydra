/**
 * journal/read.ts — the typed accessor of the **Journal Adapter** seam
 * (issue #1958). Sibling to `src/host-probe/probe.ts` and `src/github/gh.ts`:
 * the only legitimate caller of the private spawn primitive in `exec.ts`,
 * exposing a typed, discriminated, never-throw `readJournalSlice` surface to the
 * rest of `src/` (the autopilot journal route).
 *
 * Owns three things `src/autopilot/log.ts`'s `readJournalSlice` used to inline:
 *   1. The argv hygiene: `sanitizeIso` (the strict ISO-8601 guard against a
 *      malformed Redis row reaching argv) and `computeUntilIso` (live-run window
 *      vs recorded `ended_epoch`).
 *   2. The unit resolution (`journalUnit`, env-overridable) — server-controlled,
 *      never request-body-derived.
 *   3. The map from the raw spawn result onto the discriminated slice result.
 *
 * Injectable deps (the `deps` pattern, `resolveDeps`)
 * --------------------------------------------------
 * `readJournalSlice` takes an optional `deps.runJournal` so tests can stub the
 * spawn without env mutation or cache-busted dynamic `import()` — matching the
 * standard `resolveDeps` shape used elsewhere (e.g. `getCandidateFeed`,
 * `getAutopilotHealth`). Production omits it and gets the real `runJournal`.
 *
 * Never throws (CLAUDE.md external-process boundary discipline).
 */

import {
  runJournal,
  journalUnit,
  classifyJournalFailure,
  type RawJournalResult,
  type JournalExecOptions,
} from "./exec.ts";

/**
 * Validate that a string looks like an ISO-8601 timestamp the kernel journal
 * will accept. Returns the original string when valid; null otherwise.
 * Intentionally strict — guards against a malformed Redis row being passed
 * straight into argv.
 */
export function sanitizeIso(s: string | undefined | null): string | null {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Compute the `--until` value for a journal query. For ended/killed runs with a
 * recorded `ended_epoch`, returns that as ISO. Otherwise returns the current
 * time (live run window).
 */
function computeUntilIso(row: Record<string, string>): string {
  const endedEpoch = Number(row.ended_epoch || "0");
  if (Number.isFinite(endedEpoch) && endedEpoch > 0) {
    return new Date(endedEpoch * 1000).toISOString();
  }
  return new Date().toISOString();
}

/**
 * The successful journal-slice payload. A `truncated`/`timedOut` run is still a
 * success arm — the captured partial text is returned for the UI panel, with the
 * flags surfaced so the route can set its `x-autopilot-journal-*` headers.
 */
interface JournalSlice {
  text: string;
  unit: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * The discriminated result of `readJournalSlice`. The failure arm carries a
 * machine-readable `code`:
 *   - `invalid-row` — the run hash had no parseable `started` timestamp, so
 *     argv would be malformed and the spawn never happens.
 *   - a `journal-*` code (from {@link classifyJournalFailure}) — the spawn
 *     itself failed (e.g. `journalctl` not installed). A merely truncated or
 *     timed-out run is NOT a failure: its partial text is returned on the
 *     success arm with the flags set (the UI panel renders it).
 */
export type JournalSliceResult =
  | { ok: true; data: JournalSlice }
  | { ok: false; code: "invalid-row" | ReturnType<typeof classifyJournalFailure> };

/** Injectable deps for `readJournalSlice` — the spawn primitive, stubbable in tests. */
export interface JournalReadDeps {
  runJournal: (
    unit: string,
    sinceIso: string,
    untilIso: string,
    opts?: JournalExecOptions,
  ) => Promise<RawJournalResult>;
}

/**
 * Type guard narrowing a `JournalSliceResult` to its failure arm.
 *
 * The orchestrator's `tsconfig.json` runs `strict: false` (no `strictNullChecks`),
 * so TypeScript cannot discriminate a union on a boolean `ok` field via plain
 * `if (!result.ok)` control-flow narrowing — the route would not see `.code`.
 * This guard gives callers reliable narrowing, mirroring `isProbeFailure` in the
 * Host-Probe Adapter and `isGhFailure` in the GitHub CLI Adapter.
 */
export function isJournalSliceFailure(
  result: JournalSliceResult,
): result is Extract<JournalSliceResult, { ok: false }> {
  return result.ok === false;
}

function resolveDeps(deps?: Partial<JournalReadDeps>): JournalReadDeps {
  return { runJournal: deps?.runJournal ?? runJournal };
}

/**
 * Read the journal slice for the run window described by `row`.
 *
 * Trusts this Module's argv hygiene (`sanitizeIso` + the server-controlled unit
 * and computed window). Request bodies are never used for journal args — the
 * route only supplies the Redis `row` it looked up by `runId`.
 *
 * Never throws: a malformed row returns `{ ok:false, code:"invalid-row" }`; a
 * spawn timeout/truncation returns `ok:true` with the flags set and whatever
 * text was captured (matching the old `runJournalctl` UI-panel contract).
 */
export async function readJournalSlice(
  args: { row: Record<string, string> },
  deps?: Partial<JournalReadDeps>,
): Promise<JournalSliceResult> {
  const since = sanitizeIso(args.row.started);
  if (!since) return { ok: false, code: "invalid-row" };
  const untilIso = computeUntilIso(args.row);
  const unit = journalUnit();
  const { runJournal: run } = resolveDeps(deps);
  const raw = await run(unit, since, untilIso);
  // A spawn failure (e.g. journalctl not installed) is a genuine failure arm —
  // there is no usable slice. Truncation/timeout are NOT failures: the captured
  // partial text + flags ride the success arm for the UI panel.
  if (raw.spawnError) {
    return { ok: false, code: classifyJournalFailure(raw) };
  }
  return {
    ok: true,
    data: {
      text: raw.text,
      unit,
      truncated: raw.truncated,
      timedOut: raw.timedOut,
    },
  };
}
