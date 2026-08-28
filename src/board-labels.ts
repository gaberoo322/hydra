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
  // `glm-eligible` is the ISSUE-side eligibility label for the GLM dev-drainer
  // worker lane (ADR-0032, issue #3687). An issue carries it when it is a
  // designed, shallow, in-fence `dev_orch` item the drainer may author. It
  // excludes the issue from the orch `ready_for_agent` count for exactly the
  // same reason `target-backlog` does: that count is the *Opus `dev_orch`
  // authoring* pool, and a glm-eligible issue is authored by the drainer on
  // z.ai's independent quota — counting it would drive a duplicate
  // orchestrator-scope dispatch onto work the drainer already owns.
  // `design_concept_orch` stays active on glm-eligible issues (the brain
  // designs, GLM authors — ADR-0032 Decision 1), so this is a `dev_orch`
  // authoring-count exclusion only.
  //
  // Its PR-side sibling `glm-authored` is deliberately NOT in this vocabulary:
  // ADR-0032 invariant 9 keeps the two label spaces distinct
  // (`glm-eligible` ↔ issues/`ready-for-agent`, `glm-authored` ↔
  // PRs/`active_dev_orch`), and this leaf is the *board-state* (issue) label
  // set. `glm-authored` is consumed by the `active_dev_orch` PR collector in
  // `scripts/autopilot/collect-state.sh`, which reads no TS vocabulary.
  glm_eligible: "glm-eligible",
  // `glm-withhold` is the sticky opt-out marker for the GLM dev-drainer worker
  // lane (ADR-0032, issue #3755). Where `glm-eligible` says "the drainer may
  // author this", `glm-withhold` says the OPPOSITE for one specific issue: "the
  // brain judges this single issue genuinely needs frontier capability — skip
  // it even though it looks glm-eligible." That is #3665's withhold clause (b),
  // "any single issue the brain judges genuinely needs frontier capability",
  // which a mechanical eligibility sweep cannot evaluate and so must read off a
  // label instead.
  //
  // It is STICKY for idempotency: hand-removing `glm-eligible` from an issue
  // does NOT withhold it, because the sweep re-adds the label on its next tick.
  // Only a separate marker the sweep reads and skips actually withholds — hence
  // a distinct `glm-withhold` label rather than the absence of `glm-eligible`.
  // It follows the `design-concept-exempt` naming shape (an `-exempt`/`-withhold`
  // opt-out alongside its opt-in sibling) already in the label vocabulary.
  //
  // This is NOT a safety boundary. `preflightBeforePr` in
  // `src/glm/drainer-runner.ts` already hard-blocks Verifier-Core and T4 on the
  // actual diff, which #3665 itself called the real fence. `glm-withhold` is an
  // efficiency and judgment hook that avoids spending a GLM run on an issue
  // known up front to need frontier capability. It is read (and skipped over)
  // by the eligibility sweep chore, NOT by this board-state projection — so,
  // unlike `glm-eligible`, it is not wired into the `ready_for_agent` exclusion
  // in `src/autopilot/board-state.ts` (that wiring is the sweep's follow-on,
  // out of scope of #3755).
  glm_withhold: "glm-withhold",
  // `glm-ab-control` (issue #4124, parent epic #4123) is a SIBLING of
  // `glm-withhold`, not a reuse of it: its ROUTING is deliberately identical
  // (skip the drainer, route to the Opus `dev_orch` lane) but its MEANING is
  // different. `glm-withhold` marks "the brain judges this single issue
  // genuinely needs frontier capability" (ADR-0032 withhold clause (b)) — a
  // population that is systematically harder than average. `glm-ab-control`
  // marks "a future randomiser (slice beta, out of scope here) assigned this
  // issue to the Claude control arm of a GLM-vs-Opus A/B measurement" — a
  // population that should be representative, not capability-fenced. Placing
  // A/B controls under `glm-withhold` would contaminate the control arm with
  // hard issues and bias the comparison in GLM's favour, and would collapse
  // two distinct reasons ("randomiser said so" vs "GLM can't do this") into
  // one indistinguishable signal. Hence a distinct label with the same
  // routing effect. This slice (alpha) wires the label + routing parity only
  // — no randomisation, no measurement.
  glm_ab_control: "glm-ab-control",
} as const;

/**
 * Staleness windows (seconds) — preserved verbatim from `collect-state.sh`:
 * an `in-progress` issue untouched for 90 min, or a `blocked` issue untouched
 * for 12 h, is "stale" and listed by number so the autopilot can re-route it.
 */
export const STALE_IN_PROGRESS_SECONDS = 5400; // 90 min
export const STALE_BLOCKED_SECONDS = 43200; // 12 h
