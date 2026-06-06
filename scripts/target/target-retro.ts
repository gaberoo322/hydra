/**
 * scripts/target/target-retro.ts — Pure caps / dedup / routing logic for the
 * `/hydra-target-retro` skill (issue #1058, parent epic #1052 — "Selectively
 * converge the Target SDLC with the Orchestrator's build-quality machinery").
 *
 * Background: the Target (hydra-betting) executor today produces builds with no
 * cross-build learning loop. The Orchestrator solved its own version of this
 * with `/hydra-retro` (epic #917): a per-run retrospective that deep-reads the
 * flagged transcripts, synthesises recurring failure patterns, and routes them
 * — capped and deduped — into the learning surface. This module is the Target
 * analogue of that retro's pure core (`scripts/ci/hydra-retro-emit.ts`),
 * deliberately mirroring its caps/dedup/routing SHAPE while declining the
 * Orchestrator-only apparatus the epic does not mirror for the Target:
 *
 *   - **NO gated PR lane.** The Orchestrator retro's single prompt-fix PR rides
 *     the Modification-Tier machinery (recurrence + confidence gates → a Tier-1
 *     gated PR). The Target does not mirror the tier ladder (epic #1052), so a
 *     Target retro has no PR lane at all. Prompt-shaped findings are written
 *     DIRECTLY into the Target feedback files the planner/executor already read
 *     (the playbook performs that edit); code-shaped findings become Redis
 *     Target-backlog items.
 *   - **NO Verifier-Core / deep-QA remediation / operator-escalation.** A Target
 *     retro proposes; it never gates a merge.
 *
 * What survives synthesis is ROUTED + CAPPED here before the playbook emits:
 *
 *   - **`feedback` findings** — recurring prompt-shaped gotchas → an instruction
 *     the playbook appends to a Target planner/executor feedback file. Capped at
 *     {@link MAX_PROPOSALS_PER_RUN} alongside backlog findings (a single shared
 *     ≤2 proposal budget per run — see the cap note below).
 *   - **`backlog` findings** — code-needing findings → Redis Target-backlog
 *     items the playbook files via the backlog module. Same shared ≤2 budget.
 *   - Everything deduped against the seen-list, or over the shared cap → recorded
 *     as artifact-only notes (never silently dropped).
 *
 * Subagent **friction reports** are a first-class INPUT, not a parallel
 * mechanism (issue #1058 acceptance criterion): the skill folds the Target's
 * `frictionPatterns` into the same `RetroObservation` list it feeds here, so a
 * recurring friction cue and a transcript-derived gotcha compete for the same
 * capped proposal budget on the same kebab-case cue key.
 *
 * This module performs NO I/O — no fs, no network, no Redis, no `gh` — so it
 * unit-tests in milliseconds (see test/target-retro.test.mts). The skill
 * (docs/operator-playbooks/hydra-target-retro.md) does the deep-read +
 * synthesis, snapshots the seen-list, calls {@link planTargetRetro}, then
 * performs the feedback-file edit / backlog-item writes for the survivors.
 *
 * Mirrors the pure-helper shape of `scripts/ci/hydra-retro-emit.ts`.
 */

// ---------------------------------------------------------------------------
// Caps (epic #1052 / issue #1058 contract)
// ---------------------------------------------------------------------------

/**
 * Max proposals a single Target retro run may emit, summed across BOTH lanes
 * (feedback-file instructions + Redis backlog items). Issue #1058 caps the run
 * at "≤2 proposals/run" — deliberately a single shared budget, not ≤2-per-lane,
 * so a noisy run cannot emit 2 feedback edits AND 2 backlog items.
 */
export const MAX_PROPOSALS_PER_RUN = 2;

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Which lane a Target-retro finding is routed to — drives WHERE the playbook
 * writes it, not whether it is gated (the Target has no gate).
 *
 * - `feedback` — a prompt-shaped recurring gotcha. Written directly into a
 *   Target planner/executor feedback file (the surface they already read).
 * - `backlog` — a code-needing finding. Filed as a Redis Target-backlog item.
 */
export type TargetRetroLane = "feedback" | "backlog";

/**
 * Where a friction/transcript observation came from — purely informational
 * provenance the artifact records; routing does NOT depend on it (a friction
 * cue and a transcript cue compete identically once synthesised).
 */
export type RetroObservationSource = "transcript" | "friction";

/**
 * One synthesised, post-adversarial-self-check Target-retro observation handed
 * to the planner. The skill is responsible for the deep-read + synthesis +
 * adversarial drop BEFORE building these; the planner only routes, caps, and
 * dedups what survives. Subagent friction reports arrive here too, folded into
 * the same list with `source: "friction"`.
 */
export interface RetroObservation {
  /**
   * Stable kebab-case cue — the dedup key. MUST match the friction-store cue
   * grammar so a transcript-derived gotcha and its friction-pattern twin line
   * up on the same key and dedup correctly. Free text is a bug.
   */
  cue: string;
  /** Which lane the proposed fix is routed to. */
  lane: TargetRetroLane;
  /** One-line human title for the feedback instruction / backlog item. */
  title: string;
  /** Provenance — `transcript` or `friction`. Recorded, not routed on. */
  source: RetroObservationSource;
}

/**
 * The cross-run dedup ledger, snapshotted by the skill from the Redis seam
 * before planning. Passed in (not read) so the planner stays pure and
 * deterministic.
 */
export interface TargetRetroLedger {
  /** Cues already emitted on a prior run — dedup hard-skips these. */
  seenCues: Set<string>;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** Why an observation did not become a proposal. */
export type TargetDropReason =
  | "duplicate-seen-list" // cue already emitted on a prior run
  | "proposal-cap-reached"; // the shared ≤2 proposal budget is spent

/** An observation that survived routing and will be emitted. */
export interface PlannedTargetProposal {
  cue: string;
  title: string;
  /** The lane this proposal was routed to. */
  lane: TargetRetroLane;
  /** Provenance carried through for the artifact. */
  source: RetroObservationSource;
}

/** An observation that was NOT emitted, with the routing reason. */
export interface SkippedTargetObservation {
  cue: string;
  title: string;
  lane: TargetRetroLane;
  reason: TargetDropReason;
}

/** The deterministic emit plan {@link planTargetRetro} returns. */
export interface TargetRetroPlan {
  /**
   * Prompt-shaped proposals to write into a Target feedback file. The playbook
   * appends each as an instruction the planner/executor will read next run.
   */
  feedback: PlannedTargetProposal[];
  /** Code-needing proposals to file as Redis Target-backlog items. */
  backlog: PlannedTargetProposal[];
  /**
   * Observations recorded as artifact-only notes (over the shared cap but not a
   * dedup skip) — the skill writes these into the persisted retro artifact.
   */
  artifactOnly: SkippedTargetObservation[];
  /** Observations dropped before emit (dedup), with the reason. */
  skipped: SkippedTargetObservation[];
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

/**
 * Route, dedup, and cap the surviving observations into a deterministic emit
 * plan. Pure — no I/O.
 *
 * Routing rules (issue #1058):
 *
 *   1. **Dedup first.** An observation whose cue is in `ledger.seenCues` is
 *      hard-skipped (`duplicate-seen-list`) regardless of lane — it was emitted
 *      on a prior run and must never be re-proposed.
 *   2. **Shared proposal budget.** Surviving observations fill a SINGLE
 *      `MAX_PROPOSALS_PER_RUN` budget in input order, routed to their declared
 *      lane (`feedback` or `backlog`). Once the shared budget is spent, every
 *      further observation is `proposal-cap-reached` (artifact-only — a finding
 *      below the cap is still worth recording, just not emitting).
 *
 * Input order is the tie-break across lanes, so the plan is deterministic for a
 * given observation list + ledger snapshot. A `friction`-sourced observation
 * and a `transcript`-sourced one compete identically — provenance is recorded,
 * never prioritised.
 */
export function planTargetRetro(
  observations: RetroObservation[],
  ledger: TargetRetroLedger,
): TargetRetroPlan {
  const feedback: PlannedTargetProposal[] = [];
  const backlog: PlannedTargetProposal[] = [];
  const artifactOnly: SkippedTargetObservation[] = [];
  const skipped: SkippedTargetObservation[] = [];

  let emitted = 0;

  for (const o of observations) {
    // 1. Dedup — a previously-emitted cue is never re-proposed.
    if (ledger.seenCues.has(o.cue)) {
      skipped.push({ cue: o.cue, title: o.title, lane: o.lane, reason: "duplicate-seen-list" });
      continue;
    }

    // 2. Shared ≤2 proposal budget across BOTH lanes.
    if (emitted >= MAX_PROPOSALS_PER_RUN) {
      artifactOnly.push({ cue: o.cue, title: o.title, lane: o.lane, reason: "proposal-cap-reached" });
      continue;
    }

    const proposal: PlannedTargetProposal = {
      cue: o.cue,
      title: o.title,
      lane: o.lane,
      source: o.source,
    };
    if (o.lane === "feedback") {
      feedback.push(proposal);
    } else {
      backlog.push(proposal);
    }
    emitted += 1;
  }

  return { feedback, backlog, artifactOnly, skipped };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One problem found while validating an observation for the planner. */
export interface ObservationValidationError {
  index: number;
  field: string;
  reason: string;
}

const KEBAB_CUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate the observation list the skill hands to {@link planTargetRetro}. A
 * non-empty return is a hard stop (the skill emits nothing). Guards the cue
 * grammar (so the dedup keys line up with the friction store), the lane,
 * the source, and a non-empty title. Pure.
 */
export function validateObservations(
  observations: RetroObservation[],
): ObservationValidationError[] {
  const errors: ObservationValidationError[] = [];
  if (!Array.isArray(observations)) {
    return [{ index: -1, field: "observations", reason: "observations must be an array" }];
  }
  observations.forEach((o, index) => {
    if (!o || typeof o !== "object") {
      errors.push({ index, field: "observation", reason: "observation must be an object" });
      return;
    }
    if (typeof o.cue !== "string" || !KEBAB_CUE.test(o.cue)) {
      errors.push({
        index,
        field: "cue",
        reason: "cue must be a non-empty kebab-case string (matches the friction-store grammar)",
      });
    }
    if (o.lane !== "feedback" && o.lane !== "backlog") {
      errors.push({ index, field: "lane", reason: 'lane must be "feedback" or "backlog"' });
    }
    if (o.source !== "transcript" && o.source !== "friction") {
      errors.push({ index, field: "source", reason: 'source must be "transcript" or "friction"' });
    }
    if (typeof o.title !== "string" || !o.title.trim()) {
      errors.push({ index, field: "title", reason: "title is required" });
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

/**
 * Parse the CLI-style args `/hydra-target-retro` receives. Recognised forms:
 *
 *   <run_id>            → positional run id; omitted ⇒ latest completed run
 *   --audit | --dry-run → print the plan, do NOT edit feedback files / file items
 *   --apply             → opt-in to actually emitting (the only mutating path)
 *
 * `--audit` (dry-run) is the DEFAULT for safety: `parseArgs("")` returns
 * `{ apply: false }`, matching the Orchestrator retro's default. The skill's
 * only mutation paths (feedback-file edits + backlog-item writes) are gated
 * behind `apply === true`.
 */
export function parseArgs(args: string | null | undefined): {
  apply: boolean;
  runId?: string;
} {
  if (!args) return { apply: false };
  const tokens = args
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  let apply = false;
  let runId: string | undefined;
  for (const t of tokens) {
    if (t === "--apply") {
      apply = true;
      continue;
    }
    if (t === "--audit" || t === "--dry-run") {
      apply = false;
      continue;
    }
    if (t.startsWith("--")) {
      // Unknown flag — ignore rather than misparse it as a run id.
      continue;
    }
    // First positional token is the run id.
    if (runId === undefined) runId = t;
  }
  // Omit `runId` entirely when absent so the shape matches `{ apply }` exactly.
  return runId === undefined ? { apply } : { apply, runId };
}
