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
  readonly reason: DegradeReason;
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
  /** A decoded payload is not the object shape the fold needs. */
  SHAPE: "shape",
  /** `/usage` carries no `bySkillByModel`. */
  NO_BY_SKILL_BY_MODEL: "no-bySkillByModel",
  /** The decoded class taxonomy is not an object. */
  TAXONOMY_SHAPE: "taxonomy-shape",
  /** The realm-share denominator is zero / non-finite. */
  ZERO_DENOMINATOR: "zero-denominator",
  /** The computed realm share is outside [0, 1]. */
  SHARE_OUT_OF_RANGE: "share-out-of-range",
  /** `/usage` carries no `orchestrator` block. */
  NO_ORCHESTRATOR: "no-orchestrator",
  /** The `orchestrator` block lacks `share` / `window`. */
  ORCHESTRATOR_SHAPE: "orchestrator-shape",
  /** The realm share is not a number. */
  SHARE_NOT_NUMERIC: "share-not-numeric",
  /** The emergency-brake non-merge count is neither a number nor a boolean. */
  NONMERGES_NOT_NUMERIC: "nonmerges-not-numeric",
  /** The first recommendation is not an object. */
  FIRST_NOT_A_DICT: "first-not-a-dict",
  /** The first recommendation's action cannot be sliced. */
  ACTION_NOT_SLICEABLE: "action-not-sliceable",
  /** The `systemctl --failed` read failed. */
  SYSTEMCTL_FAILED: "systemctl-failed",
  /** A host file could not be read. */
  UNREADABLE: "unreadable",
  /** The hydra service answered with an empty body. */
  EMPTY_BODY: "empty-body",
  /** The hydra service answered with an HTML page, not JSON. */
  HTML_BODY: "html-body",
  /** A numeric count read is not an integer. */
  NON_INTEGER_COUNT: "non-integer-count",
  /** The skipped-because-Redis-is-down arm of a Redis-dependent read. */
  SKIPPED_REDIS_UNREACHABLE: "skipped-redis-unreachable",
  /** The workflow-runs payload is not JSON. */
  RUNS_UNPARSEABLE: "runs-unparseable",
  /** A `jq`-equivalent fold errored on a payload that parsed. */
  JQ_ERROR: "jq-error",
  /** The board read failed. */
  BOARD_READ_FAILED: "board-read-failed",
  /** The WIP read failed. */
  WIP_READ_FAILED: "wip-read-failed",
  /** The needs-dev-resume read failed. */
  RESUME_READ_FAILED: "resume-read-failed",
  /** The `pr-refs.py` predicate helper could not be imported. */
  PR_REFS_UNAVAILABLE: "pr-refs-unavailable",
  /** The Target facts carry no `manifest`. */
  NO_MANIFEST_FIELD: "no-manifest-field",
  /** The service board response lacks the expected count keys. */
  SERVICE_RESPONSE_MISSING_KEYS: "service-response-missing-keys",
  /** The service board endpoint reported itself degraded. */
  ENDPOINT_DEGRADED: "endpoint-degraded",
  /** The service answered but flagged itself degraded / incomplete. */
  DEGRADED_OR_INCOMPLETE_BODY: "degraded-or-incomplete-body",
  /** A decoded value is not iterable. */
  NOT_ITERABLE: "not-iterable",
  /** A verdict recheck that was not evaluated this turn. */
  NOT_EVALUATED: "not-evaluated",
  /** The PR re-poll reducer failed. */
  REDUCER_FAILED: "reducer-failed",
  /** The pr-refs predicate is unavailable. */
  PREDICATE_UNAVAILABLE: "predicate-unavailable",
  /** The PR list could not be read. */
  PR_LIST_UNREADABLE: "pr-list-unreadable",
  /** The required-contexts input could not be read. */
  REQUIRED_CONTEXTS_UNREADABLE: "required-contexts-unreadable",
  /** The host adapter is not wired. */
  HOST_UNAVAILABLE: "host-unavailable",
  /** A field expected to be an issue number is not. */
  NOT_AN_ISSUE_NUMBER: "not-an-issue-number",
  /** A passthrough body did not parse. */
  UNPARSEABLE_BODY: "unparseable-body",
  /** A field expected to be numeric is not. */
  NOT_NUMERIC: "not-numeric",
  /** A malformed snapshot entry was dropped. */
  MALFORMED_ENTRY_DROPPED: "malformed-entry-dropped",
  /** The durable dev-resume classifier lacked one of its inputs. */
  DEV_RESUME_INPUT_UNAVAILABLE: "dev-resume-input-unavailable",
  /** The open-PR page filled to its limit, so the list may be truncated. */
  PR_PAGE_SATURATED: "pr-page-saturated",
  /** The collector was not selected by `--collectors`, so its snapshot is the fallback. */
  NOT_REQUESTED: "not-requested",
  /** The PR-list read failed (no-PR resume pick). */
  PR_LIST_READ_FAILED: "pr-list-read-failed",
} as const;

/** Dynamic detail appended to a degradation: an error message, an HTTP status, an interpolated cause. */
export type DegradeDetail = string & { readonly __degradeDetail: true };

/**
 * Mark a runtime-built reason (a thrown error's message, `http-503`, a
 * `${code}: ${cause}` pair) as a degradation reason. The only way a string
 * that is not a {@link DEGRADE} code becomes a {@link DegradeReason}, so a bare
 * literal cannot slip in at a call site.
 */
export const degradeDetail = (text: string): DegradeDetail => text as DegradeDetail;

/** A declared {@link DEGRADE} code, or a {@link degradeDetail}-marked runtime string. */
export type DegradeReason = (typeof DEGRADE)[keyof typeof DEGRADE] | DegradeDetail;

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
export type Classified<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: DegradeReason };
