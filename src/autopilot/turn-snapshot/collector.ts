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
  /** The snapshot field (or input read) that degraded, e.g. `prList`, `glmRed`. */
  readonly field: string;
  /** A short machine-greppable reason, e.g. `empty-payload`, `unparseable`. */
  readonly reason: string;
}

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
