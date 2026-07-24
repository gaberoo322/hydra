/**
 * Now-recommendations aggregator (issue #3570; extracted from
 * `src/api/now-recommendations.ts`).
 *
 * The Now-page recommendation write-path — "what should the operator act on
 * right now, and let them dismiss/mute it?" — composes recommendation
 * retrieval, severity-based muting, and dismissal tracking into three typed
 * result shapes the `/now/recommendations*` routes serialise.
 *
 * # Why a pure leaf
 *
 * Before #3570 this logic was inlined in the three `/now/recommendations*`
 * route handlers — each a hand-rolled `try/catch` with a per-route
 * `console.error` block, run-id resolution, Redis fan-out, and response-body
 * assembly. At 304 lines the route file was the structural outlier in the
 * Now-page router cluster (the sibling routes are thin adapters over pure
 * aggregators). This leaf re-homes the domain logic so the routes become thin
 * adapters over the shared `route-helpers.ts` never-throw isolation, and the
 * muting/dismissal policy gains a zero-IO test seam.
 *
 * # Design contract — same as autopilot-tick.ts
 *
 *   - Pure aggregator. Every external touchpoint arrives through injected
 *     reader/writer thunks in `deps`; the leaf never imports the Redis facade
 *     and never performs IO itself. Tests drive the full list/mute/dismiss
 *     logic with injected stubs — no HTTP layer needed.
 *   - The aggregators return discriminated result shapes; the route serialises
 *     them (mapping `run_missing` to a 404, otherwise 200). The routes wrap
 *     each aggregator call in the shared never-throw 500 isolation, so a thrown
 *     Redis error degrades to a logged 500 at exactly one seam.
 */

// ---------------------------------------------------------------------------
// Injectable deps surface
// ---------------------------------------------------------------------------

/**
 * Recommendations Redis facade — the read/write surface the aggregator drives.
 * Defaults (in the route) to the typed `src/redis/recommendations.ts`
 * accessor module; tests inject an in-memory stub.
 */
export interface RecommendationsReaderDeps {
  getAllRecommendations(runId: string): Promise<Record<string, string>>;
  getDismissedSet(runId: string): Promise<string[]>;
  getMutedClassesSet(runId: string): Promise<string[]>;
  dismissRecommendation(
    runId: string,
    recId: string,
    ttlSeconds: number,
  ): Promise<void>;
  muteSeverityClass(
    runId: string,
    severity: string,
    ttlSeconds: number,
  ): Promise<void>;
}

/** Reader returning the current run_id (most-recent run), for `?run_id=current`. */
export interface CurrentRunIdReader {
  (): Promise<string | null>;
}

/**
 * Resolved deps for one aggregator call. The route defaults `recsRedis`,
 * `readCurrentRunId`, and `now`, then hands the resolved surface in.
 */
export interface NowRecommendationsDeps {
  recsRedis: RecommendationsReaderDeps;
  readCurrentRunId: CurrentRunIdReader;
  now: () => Date;
  /** TTL (seconds) applied to dismissal/mute writes — the run's retention window. */
  ttlSeconds: number;
}

// ---------------------------------------------------------------------------
// Typed result shapes — the aggregator's contract with the route
// ---------------------------------------------------------------------------

/** Result of the active-recommendations read. Never signals a missing run — it
 *  degrades to an empty list with `run_id: null`. */
export interface ActiveRecommendationsResult {
  run_id: string | null;
  items: Array<Record<string, unknown>>;
  generatedAt: string;
}

/** Result of a dismissal. `run_missing` when `current` resolves to no run. */
export type DismissResult =
  | { kind: "run_missing" }
  | { kind: "ok"; run_id: string; rec_id: string; dismissed: true };

/** Result of a severity-class mute. `run_missing` when `current` resolves to no run. */
export type MuteResult =
  | { kind: "run_missing" }
  | { kind: "ok"; run_id: string; severity: string; muted: true };

// ---------------------------------------------------------------------------
// Pure helpers — the muting/dismissal policy, independently testable
// ---------------------------------------------------------------------------

/**
 * Resolve a logical `run_id` parameter into a concrete run id. `"current"`
 * is the canonical synonym for "the most recent run"; any other string is
 * treated as an explicit id and returned verbatim. Returns `null` when
 * `"current"` is requested but no run exists yet.
 */
export async function resolveRunId(
  rawRunId: string,
  readCurrentRunId: CurrentRunIdReader,
): Promise<string | null> {
  if (rawRunId === "current") return readCurrentRunId();
  return rawRunId;
}

/**
 * Pure filter — the muting/dismissal policy. Given the raw rec hash
 * (id → JSON) and the dismissed/muted sets, returns the active recs
 * newest-first. Drops:
 *  - any rec whose id is in the dismissed set
 *  - any rec whose severity is in the muted set
 *  - any rec whose JSON fails to parse (logged once per call)
 *
 * Sorting is newest-first on `created_at`. Ties break on id so the order
 * is deterministic in tests.
 */
export function filterActiveRecommendations(input: {
  rawHash: Record<string, string>;
  dismissed: string[];
  muted: string[];
}): Array<Record<string, unknown>> {
  const dismissed = new Set(input.dismissed);
  const muted = new Set(input.muted);
  const out: Array<Record<string, unknown>> = [];

  for (const [id, json] of Object.entries(input.rawHash)) {
    if (dismissed.has(id)) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      console.error(`[now/recommendations] dropping unparseable rec id=${id}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const severity = typeof parsed.severity === "string" ? parsed.severity : "";
    if (severity && muted.has(severity)) continue;
    out.push(parsed);
  }

  out.sort((a, b) => {
    const ta = Date.parse(String(a.created_at ?? "")) || 0;
    const tb = Date.parse(String(b.created_at ?? "")) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });

  return out;
}

// ---------------------------------------------------------------------------
// Aggregator entrypoints — the three domain operations
// ---------------------------------------------------------------------------

/**
 * Read the active (non-dismissed, non-muted-class) recommendations for a run.
 *
 * `rawRunId === "current"` resolves to the most-recent run; a missing current
 * run degrades to `{ run_id: null, items: [] }` (never a 404 on the read path).
 * Fans the three Redis reads out under `Promise.all`, then applies the
 * {@link filterActiveRecommendations} muting/dismissal policy.
 */
export async function getActiveRecommendations(
  rawRunId: string,
  deps: NowRecommendationsDeps,
): Promise<ActiveRecommendationsResult> {
  const runId = await resolveRunId(rawRunId, deps.readCurrentRunId);
  if (!runId) {
    return { run_id: null, items: [], generatedAt: deps.now().toISOString() };
  }

  const [rawHash, dismissed, muted] = await Promise.all([
    deps.recsRedis.getAllRecommendations(runId),
    deps.recsRedis.getDismissedSet(runId),
    deps.recsRedis.getMutedClassesSet(runId),
  ]);

  const items = filterActiveRecommendations({ rawHash, dismissed, muted });
  return { run_id: runId, items, generatedAt: deps.now().toISOString() };
}

/**
 * Dismiss a single recommendation for a run. Resolves `rawRunId`, then records
 * the dismissal through the injected writer. Returns `run_missing` when
 * `"current"` resolves to no run (the route maps that to a 404).
 */
export async function dismissRecommendationForRun(
  rawRunId: string,
  recId: string,
  deps: NowRecommendationsDeps,
): Promise<DismissResult> {
  const runId = await resolveRunId(rawRunId, deps.readCurrentRunId);
  if (!runId) return { kind: "run_missing" };
  await deps.recsRedis.dismissRecommendation(runId, recId, deps.ttlSeconds);
  return { kind: "ok", run_id: runId, rec_id: recId, dismissed: true };
}

/**
 * Mute a severity class for a run. Resolves `rawRunId`, then records the mute
 * through the injected writer. Returns `run_missing` when `"current"` resolves
 * to no run (the route maps that to a 404).
 */
export async function muteSeverityClassForRun(
  rawRunId: string,
  severity: string,
  deps: NowRecommendationsDeps,
): Promise<MuteResult> {
  const runId = await resolveRunId(rawRunId, deps.readCurrentRunId);
  if (!runId) return { kind: "run_missing" };
  await deps.recsRedis.muteSeverityClass(runId, severity, deps.ttlSeconds);
  return { kind: "ok", run_id: runId, severity, muted: true };
}
