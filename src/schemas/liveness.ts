/**
 * Schema for the declared wiring-liveness manifest `config/direction/liveness.yaml`
 * (issue #2287, parent epic #2286).
 *
 * The manifest is the git-tracked source-of-truth for what SHOULD be live: a list
 * of critical production entrypoints, each with a check `type`. It is the
 * complement to the Outcome Holdback (`src/holdback.ts`) — the holdback watches a
 * change that IS live for regressions; wiring-liveness catches a change that never
 * went live at all (a declared timer missing from the running set, or stale past
 * its window).
 *
 * Per the Schemas seam (CLAUDE.md / CONTEXT.md) this zod schema is the SINGLE
 * source of truth for both the parser and the inferred type. The manifest is
 * parsed by a hand-rolled YAML-subset parser (no `js-yaml`/`yaml` runtime
 * dependency — ADR-0005 operator-approved-deps-only) following the
 * `src/outcomes-yaml.ts` precedent; the parsed records then `safeParse` through
 * this schema, so a malformed manifest yields a typed validation error rather
 * than a throw.
 *
 * Slice 1 (#2287) implemented the `timer` check type (a declared systemd timer
 * present-and-fresh in the running set). Slice 2 (#2288, this change) adds the
 * `output` check type: the live-but-inert failure mode where code runs on
 * schedule but produces zero (or floor-pinned) output. The two entry shapes are a
 * discriminated union on `type`, so each consumer narrows on the discriminant and
 * a future slice extends the union additively without re-typing every reader.
 */
import { z } from "zod";

/**
 * Slice 1 (#2287): a declared systemd `timer` entry. `unit` is the systemd timer
 * unit name (e.g. `hydra-betting-nba-injuries.timer`); `maxStaleMinutes` is the
 * freshness window after which a present-but-not-recently-fired timer is flagged
 * STALE. A timer that has never fired yet (`last: 0`) is NOT-YET-FIRED, never
 * STALE — that guard lives in the chore, not the schema.
 */
const TimerEntrySchema = z.object({
  /** Check type discriminant. */
  type: z.literal("timer"),
  /** The systemd `--user` timer unit name, including the `.timer` suffix. */
  unit: z.string().min(1),
  /**
   * Freshness window in minutes. A timer present in the live set whose last fire
   * is older than this is flagged STALE. Must be a positive finite number.
   */
  maxStaleMinutes: z.number().positive().finite(),
  /** Optional human-readable note about why this entrypoint is critical. */
  description: z.string().optional(),
});

/**
 * Slice 2 (#2288): the floor for an {@link OutputEntrySchema} — the chore flags
 * when the observed output value stays AT OR BELOW `value` across the last `runs`
 * observations. `runs` is the trailing window length; `value` is the inclusive
 * floor. A single observation above the floor inside the window clears the alert
 * (no sticky false-positive — the check is stateless and re-evaluated each run).
 */
const MinOverRunsSchema = z.object({
  /** Inclusive floor. An observed value `<= value` counts as a floor hit. */
  value: z.number().finite(),
  /** Trailing-window length: how many recent runs must ALL be at/below the floor. */
  runs: z.number().int().positive().finite(),
});

/**
 * Slice 2 (#2288): a declared `output` entry for the live-but-inert failure mode
 * (code runs on schedule but produces zero output). `source` names a live source
 * (an Orchestrator API path such as `/api/scanner/latest`, or a metric name);
 * `jsonPath` is a dotted path into the source's response (e.g.
 * `funnelBreakdown.registryPairs`); `minOverRuns` is the `{ value, runs }` floor.
 * The chore reads the trailing run-series for the source via an injected reader
 * and flags BELOW-FLOOR when every value in the window is `<= value`.
 */
const OutputEntrySchema = z.object({
  /** Check type discriminant. */
  type: z.literal("output"),
  /** Live source identifier — an Orchestrator API path or a metric name. */
  source: z.string().min(1),
  /** Dotted JSON path into the source response (e.g. `funnelBreakdown.registryPairs`). */
  jsonPath: z.string().min(1),
  /** The `{ value, runs }` floor across the trailing run window. */
  minOverRuns: MinOverRunsSchema,
  /** Optional human-readable note about why this output is critical. */
  description: z.string().optional(),
});

/**
 * One declared entry in the liveness manifest — a discriminated union on `type`.
 * Slice 1 contributes `timer`; slice 2 contributes `output`.
 */
const LivenessEntrySchema = z.discriminatedUnion("type", [
  TimerEntrySchema,
  OutputEntrySchema,
]);

/** The whole manifest: a non-empty list of declared entries under `entries:`. */
export const LivenessManifestSchema = z.object({
  entries: z.array(LivenessEntrySchema),
});

export type LivenessEntry = z.infer<typeof LivenessEntrySchema>;
export type TimerEntry = z.infer<typeof TimerEntrySchema>;
export type OutputEntry = z.infer<typeof OutputEntrySchema>;
export type LivenessManifest = z.infer<typeof LivenessManifestSchema>;
