# ADR-0027: pino structured logger — machine-parseable log lines as the canonical logging seam

Status: Accepted
Date: 2026-07-13
Deciders: Operator (approved the runtime-dep addition via the `operator-approved` label on #3160) + Hydra (grill-with-docs design session, artifact hash `c44a9d78`)
Related: ADR-0005 (operator-approved runtime deps), #756 (typed error codes / `src/errors.ts`), #3160 (tool-scout: pino)

## Context

The orchestrator emits ~635 `console.log/error/warn` calls across ~168 source
files, every one a freeform text string. An agent querying `journalctl` output
today cannot reliably extract `cycleId`, `class`, `durationMs`, or a typed
`err.code` — it has to LLM-parse free text, and every new `console.log` widens
that grep surface. Typed error codes (`err.code`, #756) end up in Redis strings
or freeform `console.error` where they are invisible to an agent querying
service logs.

The **Observability Heartbeat** (`src/scheduler/heartbeat.ts`) already publishes
structured cycle telemetry onto the Redis event bus, but the process's own log
stream — the thing `journalctl` captures — remains unstructured. Closing that
gap makes agent *grep* into agent *query*: `journalctl | jq 'select(.cycleId=="run-abc")'`.

## Decision

**Adopt [pino](https://github.com/pinojs/pino) as the canonical structured
logger, behind a single deep-module seam `src/logger.ts`, and migrate
`console.*` call sites to it incrementally — one module per PR.**

1. **`src/logger.ts` is a deep module** that encapsulates all logging policy
   behind one narrow surface, so no call site repeats configuration:
   - **Destination `process.stderr`** — matches the current `console.error`
     behavior, so systemd/journalctl capture is unchanged and no log line is
     silently dropped.
   - **Level from `LOG_LEVEL`** env var, default `"info"`.
   - **pino's default `err` serializer** preserves the typed `err.code` (#756)
     as an addressable field, surfacing error codes in logs, not only Redis.
   - **Test determinism** — under `NODE_ENV=test` (or `HYDRA_LOG_DETERMINISTIC=1`)
     the non-reproducible `time` / `pid` / `hostname` fields are pinned so
     serialized JSON lines are stable to assert on.
   Callers import `logger` (or `childLogger({ cycleId, class })`); they never
   call `pino()` directly. `createLogger(destination)` is a test-only seam for
   asserting against a `pino.destination({ sync: true })`.

2. **Every emitted line is a single valid JSON object** (pino core guarantee) —
   no multi-line or partial-JSON output that would break `jq` / journalctl-query
   piping.

3. **Migration is additive and incremental.** Existing `console.*` calls remain
   valid until each module is converted; there is no flag-day cutover, and each
   file conversion is an independent, revertible one-file PR. This seam PR
   converts exactly **one** first module — `src/instrument.ts` (the Sentry
   status lines). `src/holdback.ts`, `src/scheduler/heartbeat.ts`, and the
   remaining ~635 call sites are follow-on sweep PRs, out of scope here to keep
   this PR reviewable.

4. **pino is a runtime dependency requiring operator approval (ADR-0005).**
   pino is a library, not a CLI — it cannot run via `npx`, so it must live in
   `package.json` `"dependencies"`. Per ADR-0005 the runtime-dep allowlist is a
   closed operator-approved set (previously `express`, `ioredis`, `ws`,
   `@sentry/node`, `zod`). The operator approved this addition via the
   `operator-approved` label on #3160. The enforced allowlist prose lives on the
   **CLAUDE.md coding-conventions line** plus `package.json` (ADR-0005 itself
   carries no dep list); this PR updates that CLAUDE.md line to add `pino` in the
   same PR as the `package.json` dependency, honoring the "never add a runtime
   dep without the paired approval-doc update" invariant.

5. **`lavamoat.allowScripts` stays `{}`.** pino has no `preinstall`/`install`/
   `postinstall` lifecycle script (verified via `npm view pino scripts` on
   pino@10.3.1 — the scripts shown are pino's own repo dev scripts, not install
   hooks), so no allow-scripts entry is needed. `.lavamoat/allow-scripts.js` is a
   phantom path: the allowlist is the `lavamoat.allowScripts` object in
   `package.json`. If a future pino version adds an install script, the
   allow-scripts CI job fails closed until the allowlist is updated.

## Alternatives considered

- **winston / bunyan** — pino is the throughput + ecosystem leader (~34M weekly
  downloads); its integer `level` and epoch-ms `time` are agent-filter-safe
  without LLM interpretation, which the alternatives do not guarantee.
- **`@sentry/node` for structured logs** — Sentry captures exceptions to a
  *remote* service; it is not an in-process structured stderr logger. The two
  coexist cleanly — Sentry stays for remote exception capture, pino is local
  structured logging.
- **OpenTelemetry logging** — heavier; `@opentelemetry/instrumentation-http`
  (transitive via Sentry) auto-instruments HTTP but provides no application-level
  structured logger API for console-style log calls.
- **Status-quo freeform `console.*`** — unstructured logs are a debt accumulator
  agents must LLM-parse; every new `console.log` widens the grep surface.
- **Big-bang cutover of all ~635 calls in one PR** — unreviewable and high blast
  radius; the designed path is one file per PR, each independently revertible.

## Consequences

- New code should prefer `logger.info({ …fields }, 'msg')` over `console.log`;
  `console.*` remains valid in unconverted modules during the migration.
- The runtime-dep allowlist grows to six entries. Future runtime deps still
  require operator approval + a paired CLAUDE.md allowlist update.
- Downstream sweep PRs convert modules one at a time; QA reviews each in
  isolation against the "one JSON object per line to stderr, `err.code`
  preserved" invariants.
