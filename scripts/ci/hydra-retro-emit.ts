/**
 * scripts/ci/hydra-retro-emit.ts — Pure caps / dedup / recurrence-gate logic
 * for the `/hydra-retro` skill (issue #919, epic #917).
 *
 * Background: `/hydra-retro` consumes the run-tree retro bundle (issue #918),
 * deep-reads only the flagged transcripts, synthesises findings, and runs an
 * adversarial self-check that drops speculative or duplicate findings. What
 * survives must then be ROUTED and CAPPED before anything is emitted:
 *
 *   - Recurring CODE-level gotchas → GitHub issues (cap ≤2 per run).
 *   - High-confidence, recurrence-gated (seen ≥3× across runs / friction
 *     observations) PROMPT-shaped fixes (skill lessons, CLAUDE.md / CONTEXT.md
 *     gotcha notes) → a single gated PR (cap ≤1 per run).
 *   - Everything below the bar → artifact-only notes (no issue, no PR).
 *
 * And nothing already proposed may be re-proposed — findings dedup against a
 * persisted seen-list (`src/redis/retro.ts`) keyed by a stable kebab-case
 * `cue`, on top of the live open + 7-day-closed GitHub scan the skill runs.
 *
 * This module is the PURE, TESTABLE core of that routing. It takes the
 * already-synthesised findings plus a SNAPSHOT of the dedup/recurrence ledgers
 * (read by the skill via the Redis seam) and returns a deterministic emit plan:
 * which findings become issues, which becomes the gated PR, which are
 * artifact-only, and which were dropped (and why). It performs NO I/O — no fs,
 * no network, no Redis, no `gh` — so it unit-tests in milliseconds. The skill
 * (docs/operator-playbooks/hydra-retro.md) calls {@link planEmit}, then shells
 * out to `gh` / git only for the entries in `plan.issues` / `plan.pr`.
 *
 * Mirrors the pure-helper shape of `scripts/ci/hydra-prd-render.ts`.
 */

// ---------------------------------------------------------------------------
// Caps + gate constants (epic #917 contract)
// ---------------------------------------------------------------------------

/** Max GitHub issues a single retro run may file (code-level gotchas). */
export const MAX_ISSUES_PER_RUN = 2;
/** Max gated PRs a single retro run may open (prompt/doc fixes). */
export const MAX_PRS_PER_RUN = 1;
/**
 * A prompt-shaped fix is only auto-PR'd once its cue has recurred at least this
 * many times across runs / friction observations.
 */
export const RECURRENCE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** What kind of fix a finding proposes — drives which cap/gate applies. */
export type FindingKind = "code" | "prompt";

/**
 * One synthesised, post-adversarial-self-check finding handed to the planner.
 * The skill is responsible for the synthesis + adversarial drop BEFORE building
 * these; the planner only routes + caps + dedups what survives.
 */
export interface RetroFinding {
  /**
   * Stable kebab-case cue — the dedup + recurrence key. MUST match the friction
   * store's cue grammar so a retrospective gotcha and its friction-pattern
   * twin line up on the same key. Free text is a bug.
   */
  cue: string;
  /** Whether the proposed fix is a code change or a prompt/doc change. */
  kind: FindingKind;
  /** One-line human title for the issue / PR / note. */
  title: string;
  /**
   * Confidence the finding is real and actionable, 0..1. The prompt-fix gate
   * additionally requires `confidence >= PROMPT_FIX_MIN_CONFIDENCE`.
   */
  confidence: number;
}

/** Confidence floor a prompt-shaped fix must clear to be auto-PR-eligible. */
export const PROMPT_FIX_MIN_CONFIDENCE = 0.8;

/**
 * The cross-run ledgers, snapshotted by the skill from the Redis seam
 * (`src/redis/retro.ts`) before planning. Passed in (not read) so the planner
 * stays pure and deterministic.
 */
export interface RetroLedgers {
  /** Cues already emitted on a prior run — dedup hard-skips these. */
  seenCues: Set<string>;
  /** `cue -> cross-run recurrence count` (the prompt-fix gate input). */
  recurrence: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

/** Why a finding did not become an issue/PR. */
export type DropReason =
  | "duplicate-seen-list" // cue already emitted on a prior run
  | "issue-cap-reached" // ≤2 issues already planned this run
  | "pr-cap-reached" // the single PR slot is taken
  | "below-recurrence-gate" // prompt fix, but cue recurred < threshold
  | "below-confidence-gate" // prompt fix below the confidence floor
  | "artifact-only"; // routed to an artifact note rather than dropped

/** A finding that survived routing and will be emitted. */
export interface PlannedEmit {
  cue: string;
  title: string;
  /** The lane this finding was routed to. */
  lane: "issue" | "pr";
}

/** A finding that was NOT emitted, with the routing reason. */
export interface SkippedFinding {
  cue: string;
  title: string;
  reason: DropReason;
}

/** The deterministic emit plan {@link planEmit} returns. */
export interface EmitPlan {
  /** Code gotchas to file as GitHub issues (length ≤ MAX_ISSUES_PER_RUN). */
  issues: PlannedEmit[];
  /** The single gated PR to open, or `null` when none qualified. */
  pr: PlannedEmit | null;
  /**
   * Findings recorded as artifact-only notes (below the emit bar but not a
   * dedup skip) — the skill writes these into the persisted retro artifact.
   */
  artifactOnly: SkippedFinding[];
  /** Findings dropped before emit (dedup, cap, or gate), with the reason. */
  skipped: SkippedFinding[];
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

/**
 * Route, cap, dedup, and recurrence-gate the surviving findings into a
 * deterministic emit plan. Pure — no I/O.
 *
 * Routing rules (epic #917):
 *
 *   1. **Dedup first.** A finding whose cue is in `ledgers.seenCues` is
 *      hard-skipped (`duplicate-seen-list`) regardless of kind — it was emitted
 *      on a prior run and must never be re-proposed.
 *   2. **Code findings → issues**, in input order, until `MAX_ISSUES_PER_RUN`
 *      is reached; the overflow is `artifact-only` (a code gotcha below the cap
 *      is still worth recording, just not filing).
 *   3. **Prompt findings → the single gated PR**, but ONLY when both gates
 *      pass: confidence ≥ `PROMPT_FIX_MIN_CONFIDENCE` AND the cue's recurrence
 *      count ≥ `RECURRENCE_THRESHOLD`. The first qualifier in input order takes
 *      the one PR slot; later qualifiers are `pr-cap-reached`. A prompt finding
 *      that fails a gate is recorded `below-recurrence-gate` /
 *      `below-confidence-gate` (artifact-worthy, not emitted).
 *
 * Within each kind, input order is the tie-break, so the plan is deterministic
 * for a given finding list + ledger snapshot.
 */
export function planEmit(
  findings: RetroFinding[],
  ledgers: RetroLedgers,
): EmitPlan {
  const issues: PlannedEmit[] = [];
  let pr: PlannedEmit | null = null;
  const artifactOnly: SkippedFinding[] = [];
  const skipped: SkippedFinding[] = [];

  for (const f of findings) {
    // 1. Dedup — a previously-emitted cue is never re-proposed.
    if (ledgers.seenCues.has(f.cue)) {
      skipped.push({ cue: f.cue, title: f.title, reason: "duplicate-seen-list" });
      continue;
    }

    if (f.kind === "code") {
      if (issues.length < MAX_ISSUES_PER_RUN) {
        issues.push({ cue: f.cue, title: f.title, lane: "issue" });
      } else {
        // Over the issue cap — record as an artifact note, don't drop silently.
        artifactOnly.push({ cue: f.cue, title: f.title, reason: "issue-cap-reached" });
      }
      continue;
    }

    // f.kind === "prompt" — the gated-PR lane.
    if (f.confidence < PROMPT_FIX_MIN_CONFIDENCE) {
      artifactOnly.push({ cue: f.cue, title: f.title, reason: "below-confidence-gate" });
      continue;
    }
    const recurrence = ledgers.recurrence[f.cue] ?? 0;
    if (recurrence < RECURRENCE_THRESHOLD) {
      artifactOnly.push({ cue: f.cue, title: f.title, reason: "below-recurrence-gate" });
      continue;
    }
    if (pr === null) {
      pr = { cue: f.cue, title: f.title, lane: "pr" };
    } else {
      // The single PR slot is taken — a second qualifying prompt fix waits.
      artifactOnly.push({ cue: f.cue, title: f.title, reason: "pr-cap-reached" });
    }
  }

  return { issues, pr, artifactOnly, skipped };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** One problem found while validating a finding for the planner. */
export interface FindingValidationError {
  index: number;
  field: string;
  reason: string;
}

const KEBAB_CUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate the finding list the skill hands to {@link planEmit}. A non-empty
 * return is a hard stop (the skill emits nothing). Guards the cue grammar (so
 * the dedup/recurrence keys line up with the friction store), confidence range,
 * kind, and a non-empty title. Pure.
 */
export function validateFindings(findings: RetroFinding[]): FindingValidationError[] {
  const errors: FindingValidationError[] = [];
  if (!Array.isArray(findings)) {
    return [{ index: -1, field: "findings", reason: "findings must be an array" }];
  }
  findings.forEach((f, index) => {
    if (!f || typeof f !== "object") {
      errors.push({ index, field: "finding", reason: "finding must be an object" });
      return;
    }
    if (typeof f.cue !== "string" || !KEBAB_CUE.test(f.cue)) {
      errors.push({
        index,
        field: "cue",
        reason: "cue must be a non-empty kebab-case string (matches the friction-store grammar)",
      });
    }
    if (f.kind !== "code" && f.kind !== "prompt") {
      errors.push({ index, field: "kind", reason: 'kind must be "code" or "prompt"' });
    }
    if (typeof f.title !== "string" || !f.title.trim()) {
      errors.push({ index, field: "title", reason: "title is required" });
    }
    if (typeof f.confidence !== "number" || !Number.isFinite(f.confidence) || f.confidence < 0 || f.confidence > 1) {
      errors.push({ index, field: "confidence", reason: "confidence must be a number in [0, 1]" });
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

/**
 * Parse the CLI-style args `/hydra-retro` receives. Recognised forms:
 *
 *   <run_id>           → positional run id; omitted ⇒ latest completed run
 *   --audit | --dry-run → print the plan, do NOT create issues / PRs
 *   --apply            → opt-in to actually emitting (the only mutating path)
 *
 * `--audit` (dry-run) is the DEFAULT for safety: `parseArgs("")` returns
 * `{ apply: false }`. The skill's only file-mutation path is the gated PR, and
 * it is gated behind `apply === true`.
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
  // Omit `runId` entirely when absent so the shape matches `{ apply }` exactly
  // (a `runId: undefined` key would break a strict deepEqual against
  // `{ apply: false }`).
  return runId === undefined ? { apply } : { apply, runId };
}
