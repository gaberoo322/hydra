/**
 * board-labels — the orchestrator board-label vocabulary + staleness windows,
 * defined ONCE as a pure cross-cutting leaf (issue #3484).
 *
 * This module holds the orchestrator's triage/dispatch label literals
 * ({@link ORCH_BOARD_LABELS}) and the two board-staleness windows
 * ({@link STALE_IN_PROGRESS_SECONDS} / {@link STALE_BLOCKED_SECONDS}). It is a
 * pure DATA leaf — no I/O, no Express, no decisions — so any consumer (the
 * `src/api/autopilot-board.ts` HTTP router, the `src/target-board-labels.ts`
 * vocabulary leaf, or a test) imports the constant WITHOUT dragging in the HTTP
 * layer.
 *
 * # Why a standalone leaf (issue #3484)
 *
 * These constants previously lived inside `src/api/autopilot-board.ts`, an HTTP
 * router module that imports Express and owns a `Router` instance. That forced
 * the pure `src/target-board-labels.ts` vocabulary leaf to import
 * `ORCH_BOARD_LABELS` *upward* from an HTTP controller — the only backward
 * group-boundary import in the codebase. A pure constant should flow from a leaf
 * to its consumers, not from a controller to a leaf. This leaf restores that
 * direction: the vocabulary lives at leaf depth (mirroring other cross-cutting
 * pure leaves like `src/settled-fold.ts`), and both the router and the Target
 * vocabulary leaf depend on it downward.
 */

/**
 * The triage/dispatch label literals the autopilot board projection counts.
 * Each maps a response field to the GitHub label name it counts. This is the
 * SINGLE place the bash `--jq` bucketing used to re-spell; a label rename is
 * now a one-line edit here, not a parallel edit in `collect-state.sh`.
 *
 * NOTE: this is the orchestrator's triage vocabulary (see
 * `docs/agents/triage-labels.md`), distinct from the Dispatch-Class Taxonomy
 * Module's provenance vocabulary (`PROVENANCE_LABELS` in
 * `src/taxonomy/classes.ts`) which buckets issues by *which filing pipeline
 * produced them*, not by *board state*.
 */
export const ORCH_BOARD_LABELS = {
  needs_qa: "needs-qa",
  ready_for_agent: "ready-for-agent",
  needs_triage: "needs-triage",
  needs_research: "needs-research",
  in_progress: "in-progress",
  blocked: "blocked",
  // `target-backlog` is the routing label for Target work (code in
  // hydra-betting), NOT an orchestrator board state. It excludes an issue from
  // the orch `ready_for_agent` count so a Target-scope issue that also carries
  // `ready-for-agent` (e.g. #2701) is not counted as orch-pipeline work and
  // does not drive an orchestrator-scope grill / dispatch (issue #2704).
  target_backlog: "target-backlog",
} as const;

/**
 * Staleness windows (seconds) — preserved verbatim from `collect-state.sh`:
 * an `in-progress` issue untouched for 90 min, or a `blocked` issue untouched
 * for 12 h, is "stale" and listed by number so the autopilot can re-route it.
 */
export const STALE_IN_PROGRESS_SECONDS = 5400; // 90 min
export const STALE_BLOCKED_SECONDS = 43200; // 12 h
