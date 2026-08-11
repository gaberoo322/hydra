/**
 * Pace-gate launch-flow telemetry Redis seam (issue #3845, epic #3844).
 *
 * `scripts/autopilot/pace-gate.sh` decides, on every ~15-min tick, whether to
 * launch `hydra-autopilot.service` right now. Before this issue that verdict
 * was ephemeral — visible only in the systemd journal for the tick that
 * produced it, with no durable, structured record a later reader (a chore, a
 * dashboard, a retro) could join against. #3844's failure class is exactly
 * this: a launcher-side signal that only ever surfaces as a log line is
 * "green-everything-no-alarm" the moment nobody is tailing the journal.
 *
 * `hydra:autopilot:pace-gate:last-tick` (HASH, no TTL — see below) is the
 * durable record of the MOST RECENT tick's outcome:
 *
 *   - `reason`     — the exit reason. Rooted in the 15-exit / 4-class table
 *                     from map #3807's #3809 resolution (Decision 2), plus the
 *                     `meter-unavailable` reason #3845 adds (see below):
 *                     `already-running-service` | `already-running-pid` |
 *                     `curl-missing` | `jq-missing` | `eligibility-unreachable`
 *                     | `eligibility-unparseable` | `allow-invalid` | `paused`
 *                     | `session-blocked` | `emergency-stop` |
 *                     `weekly-emergency-stop` | `meter-unavailable` |
 *                     `allow-false` | `pace-ahead` | `workless-backoff` |
 *                     `eligible-launch` | `eligible-exec`.
 *   - `class`      — the coarse class the reason buckets into:
 *                     `already-running` | `fail-safe` | `deliberate-skip` |
 *                     `launch`. `meter-unavailable` is classed `fail-safe`
 *                     (its CHARACTER is "defective" per #3809's resolution
 *                     addendum — the usage meter cannot be read — even
 *                     though the verdict itself WAS readable, so it isn't in
 *                     the literal fail-safe exit list either); this is the
 *                     classification choice made in #3845, not a re-run of
 *                     #3809's own decision.
 *   - `at`         — epoch-ms the tick recorded the outcome at.
 *   - `latency_ms` — the eligibility probe's round-trip time in milliseconds
 *                     (curl `%{time_total}`, converted — no extra HTTP
 *                     request issued to measure it), or absent when the tick
 *                     never reached the probe (e.g. an already-running skip)
 *                     or the probe itself never completed (e.g.
 *                     `eligibility-unreachable`).
 *
 * The actual HSET happens from bash (`pace-gate.sh`), via the same
 * docker-exec redis-cli pattern `scripts/autopilot/hooks/on-subagent-stop.sh`
 * uses (HYDRA_REDIS_HOST defaulting to `docker`, `-h $HOST` fallback for
 * tests) — a shell script talking to a typed TS accessor is not a thing, so
 * the write path is necessarily bash. This module exists so that (a) the key
 * NAME has exactly one TypeScript definition, cross-checked against the
 * shell literal by `test/launch-flow-key-contract.test.mts` (a rename on
 * either side alone now fails a test instead of silently going
 * green-everything-no-alarm — the launcher writes an orphan key while a
 * detector reads an empty one), and (b) any future in-process reader (a
 * chore, an API route) has a typed read instead of a raw `hgetall` string
 * literal.
 *
 * **No TTL.** Unlike most per-run telemetry in this repo (dispatch outcomes,
 * cycle metrics, …) this key is NOT time-bounded — it always reflects the
 * LAST tick, overwritten wholesale on every tick (a bare HSET, not an
 * append). Stateless recovery: there is nothing to expire because there is
 * nothing to accumulate — the key mirrors `wiring-liveness-dark-outcomes.ts`'s
 * "always reflects current state" contract, not the TTLed-record contract.
 *
 * All Redis access goes through this accessor (ADR-0009 / Redis-seam rule;
 * `scripts/ci/redis-seam-check.ts`).
 */

import { getRedisConnection } from "./connection.ts";

/**
 * The single source of truth for the pace-gate last-tick hash key.
 * `scripts/autopilot/pace-gate.sh` writes this SAME literal string via
 * redis-cli HSET; `test/launch-flow-key-contract.test.mts` asserts the two
 * never drift apart.
 */
export const PACE_GATE_LAST_TICK_KEY = "hydra:autopilot:pace-gate:last-tick";

/** Typed shape of the `hydra:autopilot:pace-gate:last-tick` hash fields. */
export interface PaceGateLastTick {
  reason: string | null;
  class: string | null;
  at: number | null;
  latencyMs: number | null;
}

/**
 * Read the most recent pace-gate tick record. Returns a struct of `null`
 * fields (never throws) when the key is absent (no tick has ever recorded
 * yet, e.g. a fresh Redis) or a numeric field fails to parse — the read side
 * is dark-tolerant, matching every other best-effort accessor in this repo:
 * a missing/corrupt telemetry record must never crash a caller.
 */
export async function getPaceGateLastTick(): Promise<PaceGateLastTick> {
  const r = getRedisConnection();
  const fields = await r.hgetall(PACE_GATE_LAST_TICK_KEY);
  if (!fields || Object.keys(fields).length === 0) {
    return { reason: null, class: null, at: null, latencyMs: null };
  }
  const at = Number(fields.at);
  const latencyMs = Number(fields.latency_ms);
  return {
    reason: fields.reason ?? null,
    class: fields.class ?? null,
    at: Number.isFinite(at) ? at : null,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
  };
}
