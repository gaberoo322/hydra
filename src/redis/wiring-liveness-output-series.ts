/**
 * Wiring-liveness output-series Redis seam (issue #2578; epic #2286 slice 2
 * production-wiring follow-up to #2288).
 *
 * The wiring-liveness OUTPUT check (`src/scheduler/chores/wiring-liveness-output.ts`)
 * evaluates a declared `output` entry against a TRAILING run-series: it flags
 * BELOW-FLOOR only when every value across the last `runs` observations is at or
 * below the floor. But the live source for the declared seed entry
 * (`/api/scanner/latest @ funnelBreakdown.registryPairs`, on the Target) returns
 * ONE snapshot per read, not a history. The production reader therefore
 * accumulates the per-source series itself: each hourly chore tick it appends the
 * one fresh observation here, then reads back the trailing window.
 *
 * This module is the typed accessor for that accumulation (ADR-0009 — Redis
 * access from outside `src/redis/` goes through a typed accessor here, never a
 * raw `new Redis()` / `redis/keys` / `redis/kv` import). It is a thin domain
 * wrapper over the shared {@link boundedJsonList} primitive (ADR-0017 Category C):
 * one bounded list per `source`+`jsonPath`, newest-first, trimmed to a small cap.
 *
 * Mechanics only — it stores and returns plain numbers. The floor / window /
 * young-source verdict policy stays in the pure `evaluateOutputs`; this accessor
 * never re-implements it. A failed source read appends NOTHING (the caller's
 * concern) so a Target outage can never fabricate a zero observation that would
 * later read back as a floor hit.
 */

import { boundedJsonList } from "./bounded-list.ts";

/**
 * Hard cap on the stored series length per source. The largest declared
 * `minOverRuns.runs` is 3 (the scanner-funnel seed); a cap of 16 keeps several
 * windows of headroom so `slice(-runs)` always has the full trailing window even
 * with a few interleaved corrupt/skipped entries, while staying tiny (this is a
 * soft observability signal, not a durable log).
 */
const SERIES_MAX_LEN = 16;

/**
 * Build the bounded list key for one output source. The key namespace is owned
 * here (the `boundedJsonList` primitive takes a caller-supplied key — ADR-0017).
 * Keyed by `source` AND `jsonPath` so two declared entries reading different
 * paths off the same source accumulate independent series.
 *
 * `source` is an API path (e.g. `/api/scanner/latest`) which contains slashes;
 * those are harmless inside a Redis key but we keep the raw value so the key is
 * legible in `redis-cli KEYS hydra:wiring-liveness:output-series:*`.
 */
function seriesKey(source: string, jsonPath: string): string {
  return `hydra:wiring-liveness:output-series:${source}:${jsonPath}`;
}

/**
 * Append one fresh numeric observation for `source`@`jsonPath` to its bounded
 * series (newest-first, trimmed to {@link SERIES_MAX_LEN}). Called once per
 * successful chore tick. Never called on a failed read — an unreadable source
 * appends nothing, so the trailing window only ever advances on real data.
 */
export async function appendOutputObservation(
  source: string,
  jsonPath: string,
  value: number,
): Promise<void> {
  await boundedJsonList<number>(seriesKey(source, jsonPath), SERIES_MAX_LEN).push(value);
}

/**
 * Read the accumulated series for `source`@`jsonPath`, returned MOST-RECENT-LAST
 * (the order `evaluateOutputs` expects, so its `slice(-runs)` takes the freshest
 * window). The bounded list stores newest-first; this reverses to oldest-first.
 *
 * Tolerant of corrupt entries (the `boundedJsonList` read skips unparseable
 * members) and of non-numeric members (filtered here — domain validation belongs
 * at the call site per ADR-0017). Returns `[]` for an unseen source.
 */
export async function readOutputSeries(
  source: string,
  jsonPath: string,
): Promise<number[]> {
  const newestFirst = await boundedJsonList<number>(
    seriesKey(source, jsonPath),
    SERIES_MAX_LEN,
  ).read();
  const numeric = newestFirst.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  // Stored newest-first; evaluateOutputs wants most-recent-LAST.
  return numeric.reverse();
}
