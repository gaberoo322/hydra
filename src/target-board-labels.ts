/**
 * target-board-labels — the Target board-label vocabulary, defined ONCE
 * (ADR-0031 Decision 4; issue #3434).
 *
 * ADR-0031 moves Target task tracking from Redis to GitHub Issues on the Target
 * repo (`gaberoo322/hydra-betting`). Board labels become the tracking schema:
 * the Target skills (`hydra-target-build`, `-sweep`, `-discover`, …) write state
 * via `gh issue create` / `gh issue edit` on the Target repo, mirroring how the
 * Orchestrator skills already write. The label vocabulary they mirror is the
 * Orchestrator board-label set PLUS the Target-specific labels that survive:
 *
 *   - `money-critical`  — the 2-level risk flag (docs/agents/triage-labels.md).
 *   - `reframe`         — replaces the retired Redis reframe-queue.
 *   - `wire-or-retire`  — the wiring-decision marker.
 *
 * This module is the SINGLE place that vocabulary is spelled (ADR-0031's
 * one-definition mandate). It reuses {@link ORCH_BOARD_LABELS} for the shared
 * board-state set — a label rename on the orch side flows here for free — and
 * adds only the three Target-specific literals on top.
 *
 * # Scope of this leaf (issue #3434)
 *
 * This is a pure *vocabulary* constant with no decisions of its own — a leaf,
 * exactly like `ORCH_BOARD_LABELS`. The Target-specific labels
 * (`money-critical`, `reframe`, `wire-or-retire`) are write-side routing /
 * qualifier vocabulary the downstream `gh`-direct Target skills mirror; they are
 * deliberately NOT added as read *count* fields to the board-state response.
 * The scope-parameterized board read reuses `deriveBoardState` BYTE-FOR-BYTE
 * unchanged (ADR-0031 Decision 3, "the ideal seam count is one"), which emits
 * exactly the orch six-count + two-stale-list projection for both scopes.
 * Surfacing the Target-specific labels as their own counts is a deliberately
 * deferred follow-on — doing it here would fork `deriveBoardState`, which the
 * ADR forbids. That projection now lives in the `src/autopilot/board-state.ts`
 * leaf (issue #3505), NOT the Express route file, so a future multi-scope reader
 * can import `deriveBoardState` from its domain home directly — the seam-count
 * invariant is achievable without a route file in the import closure.
 *
 * This module is leaf-level infrastructure: it imports only the single-source
 * orch vocabulary and defines constants — no I/O, no decisions.
 *
 * # Authoritative manifest + drift guard (issue #3720)
 *
 * This vocabulary is the SINGLE checked-in manifest of every label Hydra
 * writes to `gaberoo322/hydra-betting` (the Target repo), enforced by the
 * network-free drift guard `test/target-board-labels.test.mts`. That guard
 * exists because the bug #3720 fixed was a "contract asserted in prose but
 * never checked at runtime": the wire-or-retire producer filed through a
 * retired surface for weeks with no test catching it, and a category-error
 * label (`queued` — a retired Redis LANE name, not a label) silently
 * succeeded because nothing cross-checked the label literals Target-directed
 * code writes against a manifest. The guard checks CODE-vs-MANIFEST offline
 * (deterministic, no `gh api` — a live-labels check would flake red whenever
 * the running autopilot exhausts gh rate limits, the ambient-poison-pill
 * class). The MANIFEST-vs-LIVE-REPO direction is left to each producer's own
 * runtime failure path (which now reports degradation loudly, not exits 1 in
 * silence) — a deliberate, documented residual, not an oversight.
 *
 * Deliberately EXCLUDED (and pinned excluded by the drift guard):
 *   - `queued` — a retired Redis LANE name, NOT a label. Its only historic
 *     use was a category error in `hydra-target-sweep`'s remove-label loop
 *     (deleted in #3720); adding it here would whitewash that error.
 *   - `architecture-scan` — every reference is orch-scoped (the orch-only
 *     `hydra-architecture-scan` class); zero Target-directed writes.
 *   - `target-backlog` — an ORCH-side routing label (see below).
 */

import { ORCH_BOARD_LABELS } from "./board-labels.ts";

/**
 * The Target-specific labels that survive the Redis→GitHub-Issues migration
 * (ADR-0031 Decision 4). These are write-side routing / qualifier vocabulary the
 * Target skills stamp on the Target repo — NOT board-state buckets that gate
 * dispatch cadence (so they are absent from the board-state read projection).
 */
export const TARGET_SPECIFIC_LABELS = {
  /** The 2-level money-critical risk flag (docs/agents/triage-labels.md). */
  money_critical: "money-critical",
  /** Replaces the retired Redis reframe-queue (ADR-0031 Decision 4/5). */
  reframe: "reframe",
  /** The Target wiring-decision marker (ADR-0031 Decision 4). */
  wire_or_retire: "wire-or-retire",
} as const;

/**
 * The full Target board-label vocabulary: the Orchestrator board-label set (the
 * six board-state count labels reused from {@link ORCH_BOARD_LABELS} — never
 * re-spelled here — plus the `ready-for-human` / `needs-info` operator-queue
 * labels that the board-state count projection does not tally but the skills
 * still write) plus the three surviving Target-specific labels. This is the
 * single authoritative schema the `gh`-direct Target skills mirror (ADR-0031
 * Decision 4).
 *
 * NOTE: `target-backlog` is deliberately excluded — it is an ORCH-side routing
 * label that marks Target work sitting on the *Orchestrator* repo so the orch
 * dispatch pool skips it (issue #2704). On the Target's OWN repo no issue
 * carries it, so it is not part of the Target's board vocabulary.
 */
export const TARGET_BOARD_LABELS = {
  // The six board-state labels the count projection tallies — reused verbatim
  // from the single-source orch vocabulary so a rename flows here for free.
  needs_qa: ORCH_BOARD_LABELS.needs_qa,
  ready_for_agent: ORCH_BOARD_LABELS.ready_for_agent,
  needs_triage: ORCH_BOARD_LABELS.needs_triage,
  needs_research: ORCH_BOARD_LABELS.needs_research,
  in_progress: ORCH_BOARD_LABELS.in_progress,
  blocked: ORCH_BOARD_LABELS.blocked,
  // Operator-queue labels the Target skills write (not board-state counts).
  ready_for_human: "ready-for-human",
  needs_info: "needs-info",
  ...TARGET_SPECIFIC_LABELS,
  // Producer-stamped labels: written by the Target emit runners / skills to
  // the Target repo's ISSUES (the saturation/dedup count seams collect-state
  // reads). Kept here so the drift guard can cross-check the emit scripts'
  // `gh issue create --label <X>` literals against the manifest (#3720).
  /** Stamped by the demote emitter (scripts/ci/hydra-target-cleanup-emit.ts). */
  cleanup_scan: "cleanup-scan",
  /** Stamped by the Target design-QA emit runner (collect-state.sh:889). */
  design_qa: "design-qa",
  // PR-labels written to the Target repo (pull-request process labels, not
  // issue/board-state buckets — included for manifest completeness so a
  // future label write is caught by the guard either way).
  /** Marks a Target glossary/ADR-delta PR (docs/agents/domain.md WRITE contract). */
  ubiquitous_language: "ubiquitous-language",
  /** Opts a Target PR out of the changelog-fragment requirement. */
  skip_changelog: "skip-changelog",
} as const;
