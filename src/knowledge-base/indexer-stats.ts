/**
 * indexer-stats.ts — Learning-indexer error observability counters (issue #2835).
 *
 * Extracted from src/scheduler/heartbeat.ts (issue #2658 originally landed the
 * counters there). The counters measure the INDEXER's behaviour, and the
 * indexer (`src/knowledge-base/indexer.ts`) is their sole writer, so ownership
 * belongs to the knowledge-base subsystem — not the scheduler. This slots in
 * beside the existing `indexer-lifecycle.ts` sibling under the established
 * `indexer-*.ts` naming pattern.
 *
 * Moving the state here severs the cross-subsystem
 * `knowledge-base/indexer.ts -> scheduler/heartbeat.ts` import edge: the writer
 * edge becomes intra-subsystem (`indexer.ts -> indexer-stats.ts`), and the
 * observability heartbeat — a pan-system surfacer (ADR-0012) — instead reads
 * from the subsystem it observes (`heartbeat.ts -> indexer-stats.ts`). This
 * module imports nothing; it is a true dependency leaf both homes can point at.
 *
 * The OpenViking source/config indexer is a best-effort background subsystem: a
 * failed index leaves stale embeddings but never fails a cycle. Before #2658 an
 * exhausted index attempt (e.g. OV point-lock contention that survived the
 * bounded client-side backoff) only emitted a console.error nobody watched —
 * invisible UPSTREAM, so the autopilot could not gate dispatch on
 * semantic-indexing health.
 *
 * These two MONOTONIC in-process counters (reset on process restart, like the
 * #1968 skill-catalog state, not the Redis-persisted cycle counters) make that
 * visible on `GET /api/scheduler/status` via the heartbeat's status surface:
 *   - indexerErrors  — count of index attempts that EXHAUSTED their retry budget
 *                      (or hit a non-retryable failure) and gave up.
 *   - indexerRetries — count of individual transient retries performed (a load
 *                      signal; a spike here without indexerErrors means the
 *                      backoff is absorbing contention, which is the goal).
 */

// A SINGLE process-lifetime module-level singleton: monotonic, reset only on
// process restart, never Redis-persisted (matches the #2658 / #1968
// in-process-counter contract).
let indexerErrors = 0;
let indexerRetries = 0;

/**
 * Increment the monotonic indexer-error counter (issue #2658). Best-effort and
 * TOTAL: it can never throw into the indexer's hot path — a counter bump must
 * not be able to turn a best-effort index miss into a thrown exception. Called
 * once per index attempt that exhausted its retry budget or hit a non-retryable
 * failure.
 */
export function recordIndexerError(): void {
  indexerErrors++;
}

/**
 * Increment the monotonic indexer-retry counter (issue #2658). Best-effort and
 * total (see {@link recordIndexerError}). Called once per transient retry the
 * indexer's backoff loop performs, as a load signal.
 */
export function recordIndexerRetry(): void {
  indexerRetries++;
}

/**
 * Read the current indexer observability counters (issue #2658). Pure read —
 * never throws, never touches Redis or OV. Surfaced on
 * `GET /api/scheduler/status` via the heartbeat's `getStatus`.
 */
export function getIndexerErrorStats(): { indexerErrors: number; indexerRetries: number } {
  return { indexerErrors, indexerRetries };
}

/**
 * Reset the in-process indexer counters. Test-only — production counters are
 * monotonic for the process lifetime and reset naturally on restart.
 */
export function resetIndexerErrorStats(): void {
  indexerErrors = 0;
  indexerRetries = 0;
}
