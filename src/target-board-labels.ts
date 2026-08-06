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
 * adds the Target-specific literals on top.
 *
 * # Authoritative manifest (issue #3720)
 *
 * This module was revived from a dead declaration (zero importers exercising
 * it as a manifest, zero drift guard) into the actual contract every
 * Target-directed label write is checked against. `test/target-board-labels.test.mts`
 * is the network-free drift guard (a static cross-check of label literals in
 * Target-directed code/playbooks against this manifest — NOT a live
 * `gh api .../labels` call, which would be rate-limit-fragile while autopilot
 * is running). Add a label here BEFORE a producer starts writing it.
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
 */

import { ORCH_BOARD_LABELS } from "./board-labels.ts";

/**
 * The Target-specific labels that survive the Redis→GitHub-Issues migration
 * (ADR-0031 Decision 4). These are write-side routing / qualifier vocabulary the
 * Target skills stamp on the Target repo — NOT board-state buckets that gate
 * dispatch cadence (so they are absent from the board-state read projection).
 *
 * Four entries below (`cleanup_scan`, `design_qa`, `ubiquitous_language`,
 * `skip_changelog`) were added by issue #3720's audit — real producers/
 * consumers write and read them on `gaberoo322/hydra-betting` today, but they
 * were missing from this manifest (the exact "prose asserted, never checked"
 * gap the issue names). Two OTHER labels the issue's own mitigation created on
 * the live Target repo are deliberately EXCLUDED: `queued` is a category
 * error (the retired Redis LANE name of that name was mistaken for a label in
 * one `gh api -X DELETE .../labels/queued` call, now removed —
 * docs/operator-playbooks/hydra-target-sweep.md), and `architecture-scan` has
 * zero Target-directed references (every real reference is orch-scoped).
 */
export const TARGET_SPECIFIC_LABELS = {
  /** The 2-level money-critical risk flag (docs/agents/triage-labels.md). */
  money_critical: "money-critical",
  /** Replaces the retired Redis reframe-queue (ADR-0031 Decision 4/5). */
  reframe: "reframe",
  /** The Target wiring-decision marker (ADR-0031 Decision 4). */
  wire_or_retire: "wire-or-retire",
  /**
   * The mechanical demote-sweep marker (`scripts/ci/hydra-target-cleanup-emit.ts`,
   * `hydra-target-cleanup`'s step 2) — the saturation/dedup count seam for the
   * demote-only phase, mirroring `wire_or_retire` for its judgment phase.
   */
  cleanup_scan: "cleanup-scan",
  /** The `/hydra-design-qa` judgment-arm marker (docs/operator-playbooks/hydra-design-qa.md). */
  design_qa: "design-qa",
  /**
   * Marks a sibling glossary/ADR-only PR split out of a Target code PR (Target
   * CLAUDE.md / docs/agents/domain.md WRITE protocol, mirrored from the orch
   * convention — docs/operator-playbooks/hydra-target-build.md step 6.5).
   */
  ubiquitous_language: "ubiquitous-language",
  /**
   * Opt-out for the per-PR changelog-fragment convention on a genuinely
   * user-invisible Target change (docs/operator-playbooks/hydra-target-build.md
   * step 6.7). Graceful no-op until the Target repo adopts `.changelog/`.
   */
  skip_changelog: "skip-changelog",
} as const;

/**
 * The full Target board-label vocabulary: the Orchestrator board-label set (the
 * six board-state count labels reused from {@link ORCH_BOARD_LABELS} — never
 * re-spelled here — plus the `ready-for-human` / `needs-info` operator-queue
 * labels that the board-state count projection does not tally but the skills
 * still write) plus the surviving Target-specific labels in
 * {@link TARGET_SPECIFIC_LABELS}. This is the single authoritative schema the
 * `gh`-direct Target skills mirror (ADR-0031 Decision 4).
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
} as const;
