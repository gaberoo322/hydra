/**
 * Structured logger — the single pino policy seam for the orchestrator.
 *
 * This is a DEEP module (ADR-0027): it encapsulates all logging policy —
 * level selection, destination, error serialization, and test determinism —
 * behind one narrow surface so no call site repeats the config. Callers write
 * `logger.info({ cycleId, class: 'dev_orch' }, 'cycle merged')`; every emitted
 * line is a single valid JSON object on `process.stderr`, machine-parseable by
 * `journalctl | jq` without LLM interpretation.
 *
 * Policy encapsulated here (do NOT re-derive at call sites):
 *   - Destination: `process.stderr` — matches the current `console.error`
 *     behavior so systemd/journalctl capture is unchanged and no line is
 *     silently dropped.
 *   - Level: `LOG_LEVEL` env var, default `"info"`.
 *   - Error serializer: pino's default `err` serializer preserves the typed
 *     `err.code` (src/errors.ts, #756) as an addressable field, so error codes
 *     surface in logs — not only in Redis strings.
 *   - Determinism: under NODE_ENV=test (or HYDRA_LOG_DETERMINISTIC=1) the
 *     `time` and `pid`/`hostname` fields are pinned so serialized JSON lines
 *     are stable to assert on.
 *
 * Migration is additive and incremental (ADR-0027): existing `console.*` calls
 * remain valid until each module is converted; there is no flag-day cutover and
 * each file conversion is an independent one-file PR.
 */

import pino from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";

/**
 * Deterministic mode pins non-reproducible fields (`time`, `pid`, `hostname`)
 * so tests can assert on the exact serialized JSON. Enabled automatically under
 * the test runner, or explicitly via `HYDRA_LOG_DETERMINISTIC=1`.
 */
function isDeterministic(): boolean {
  return process.env.NODE_ENV === "test" || process.env.HYDRA_LOG_DETERMINISTIC === "1";
}

/**
 * Build the pino options honoring the encapsulated policy. Exported for tests
 * that construct a logger against a `sync` destination — never call `pino()`
 * directly from a call site; import `logger` instead.
 */
export function loggerOptions(): LoggerOptions {
  const options: LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
  };
  if (isDeterministic()) {
    // Pin the non-reproducible fields. `timestamp` returns the exact JSON
    // fragment pino splices in, so `,"time":0` yields `"time":0`.
    options.timestamp = () => `,"time":0`;
    options.base = { pid: 0, hostname: "test" };
  }
  return options;
}

/**
 * Construct a logger against an explicit destination. Test-only seam: pass a
 * `pino.destination({ sync: true })` (or any writable) to capture serialized
 * lines deterministically. Production code imports the `logger` singleton.
 *
 * The return type is the default `Logger` (no custom levels), which keeps the
 * `Logger<CustomLevels, UseOnlyCustomLevels>` generics at their defaults and
 * avoids the `Logger<never, boolean>`-not-assignable mismatch that surfaces
 * when the generic is over-narrowed.
 */
export function createLogger(destination?: DestinationStream): Logger {
  return pino(loggerOptions(), destination ?? process.stderr);
}

/**
 * The process-wide structured logger. Writes one JSON object per line to
 * `process.stderr`.
 */
export const logger: Logger = createLogger();
