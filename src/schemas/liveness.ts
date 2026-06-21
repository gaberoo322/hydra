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
 * This slice (#2287) implements the `timer` check type only. The `type` enum is
 * deliberately a single-member enum today so a future slice (a `service` or
 * `endpoint` check) extends it additively without re-typing every consumer.
 */
import { z } from "zod";

/**
 * One declared entry in the liveness manifest. `unit` is the systemd timer unit
 * name (e.g. `hydra-betting-nba-injuries.timer`); `maxStaleMinutes` is the
 * freshness window after which a present-but-not-recently-fired timer is flagged
 * STALE. A timer that has never fired yet (`last: 0`) is NOT-YET-FIRED, never
 * STALE — that guard lives in the chore, not the schema.
 */
export const LivenessEntrySchema = z.object({
  /** The systemd `--user` timer unit name, including the `.timer` suffix. */
  unit: z.string().min(1),
  /** Check type. Only `timer` is implemented in this slice (#2287). */
  type: z.enum(["timer"]),
  /**
   * Freshness window in minutes. A timer present in the live set whose last fire
   * is older than this is flagged STALE. Must be a positive finite number.
   */
  maxStaleMinutes: z.number().positive().finite(),
  /** Optional human-readable note about why this entrypoint is critical. */
  description: z.string().optional(),
});

/** The whole manifest: a non-empty list of declared entries under `entries:`. */
export const LivenessManifestSchema = z.object({
  entries: z.array(LivenessEntrySchema),
});

export type LivenessEntry = z.infer<typeof LivenessEntrySchema>;
export type LivenessManifest = z.infer<typeof LivenessManifestSchema>;
