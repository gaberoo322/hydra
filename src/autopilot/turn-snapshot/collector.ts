/**
 * turn-snapshot/collector.ts — the shape every Turn Snapshot collector
 * returns (ADR-0043 Decision 1).
 *
 * A collector is `(deps) => Promise<CollectorOutcome<T>>`: it reads through
 * injected adapters (the `TurnSnapshotGithub` port, the hydra HTTP client)
 * and NEVER throws. Degradation is explicit — a `DegradedMarker` names the
 * field that could not be read and why — never a silent default; the `kv`
 * renderer is the one place that turns a degraded field back into today's
 * fallback line (Decision 4). `notes` are the diagnostic lines the CLI writes
 * to stderr, verbatim, in emission order.
 */

/** One field a collector could not read or classify, and why. */
export interface DegradedMarker {
  /** The snapshot field (or input read) that degraded, e.g. `prList`, `redResume`. */
  readonly field: string;
  /** A short machine-greppable reason, e.g. `empty-payload`, `unparseable`. */
  readonly reason: string;
}

/**
 * The degradation reason codes more than one collector emits, declared once so
 * a code is spelled in one place (kebab-case throughout). A collector imports
 * `DEGRADE` instead of writing the literal; one-off, collector-private codes
 * may stay local to their collector.
 */
export const DEGRADE = {
  /** A payload that parsed but whose shape the fold cannot read (non-list board, `labels: null`, ...). */
  MALFORMED_PAYLOAD: "malformed-payload",
  /** A list-shaped read that returned something else (was the free-text `not a list`). */
  NOT_A_LIST: "not-a-list",
  /** The read produced an empty body. */
  EMPTY_PAYLOAD: "empty-payload",
  /** The read produced a body that is not valid JSON. */
  UNPARSEABLE: "unparseable",
  /** The `gh` read itself failed (transport / non-zero exit). */
  GH_READ_FAILED: "gh-read-failed",
  /** A generic read failure with no more specific code. */
  READ_FAILED: "read-failed",
  /** The workflow-runs read failed. */
  RUNS_READ_FAILED: "runs-read-failed",
  /** The counts fallback read failed. */
  FALLBACK_READ_FAILED: "fallback-read-failed",
  /** A collector threw and the runner contained it. */
  COLLECTOR_CRASHED: "collector-crashed",
  /** Every read a collector depends on failed. */
  ALL_READS_FAILED: "all-reads-failed",
  /** The blocker search failed, so every issue is treated as open-blocked. */
  FAIL_SAFE_ALL_OPEN: "fail-safe-all-open",
} as const;

/** One of the {@link DEGRADE} reason codes. */
export type DegradeReason = (typeof DEGRADE)[keyof typeof DEGRADE];

/** What a collector hands back: typed values, explicit degradation, stderr notes. */
export interface CollectorOutcome<T> {
  /** The collector's CLI name (`--collectors <name>`). */
  readonly collector: string;
  readonly value: T;
  readonly degraded: readonly DegradedMarker[];
  readonly notes: readonly string[];
}

/**
 * A classification that either produced a value or was withheld on purpose
 * (fail-closed / fail-open). `ok: false` is a degraded field; the renderer
 * maps it to the field's fallback line.
 */
export type Classified<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
