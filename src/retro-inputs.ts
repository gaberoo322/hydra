/**
 * retro-inputs.ts — the ONE shared leaf holding the pure CLI-arg parser and
 * cue-grammar regex common to the two retro emit planners (issue #4535).
 *
 * Consumers:
 *   - scripts/ci/hydra-retro-emit.ts — the `/hydra-retro` (Orchestrator)
 *     skill's pure routing core (epic #917).
 *   - scripts/target/target-retro.ts — the `/hydra-target-retro` (Target)
 *     skill's pure routing core (epic #1052).
 *
 * Before #4535 each planner hand-duplicated these two primitives
 * byte-for-byte (the parseArgs doc-comments differed only in a trailing
 * skill-specific clause), so a CLI-contract change (a new flag) or a
 * cue-grammar change had to be made twice in lockstep. This leaf is the
 * domain-neutral seam both planners import, so a fix lands once — the same
 * shape as src/mutation-gate-inputs.ts for the ci/target mutation-gate pair
 * (issue #4489/#4346).
 *
 * The leaf lives under src/ deliberately (mirrors #4346 INV-10): the PR's own
 * mutation gate mutates only src/**\/*.ts, so placing the shared parser and
 * grammar here puts them under the kill-rate floor.
 *
 * DELIBERATELY NOT HERE: validateFindings / validateObservations. The two
 * planners' validators genuinely differ in the fields they check (findings:
 * kind/confidence; observations: lane/source) — that is divergence, not
 * drift — so each planner keeps its own validator next to its own input
 * shape, importing KEBAB_CUE from here for the shared cue-grammar check.
 *
 * Everything here is pure — no env, no filesystem, no git, no Redis, no
 * network. Its one test suite (the shared parseArgs + KEBAB_CUE cases for
 * BOTH retro skills) lives in test/hydra-retro-emit.test.mts, imported
 * directly from this leaf (issue #4535's design-concept: no separate
 * per-leaf test file).
 */

// ---------------------------------------------------------------------------
// Cue grammar
// ---------------------------------------------------------------------------

/**
 * The friction-store cue grammar: one or more `-`-separated segments, each a
 * non-empty run of `[a-z0-9]`. A retro cue MUST match this so the dedup /
 * recurrence keys line up with the friction-pattern store's keys — a
 * retrospective gotcha and its friction twin have to meet on the same key.
 * Free text is a bug (each planner's validator enforces this).
 */
export const KEBAB_CUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

/** What {@link parseArgs} returns — the shared `/hydra*-retro` arg shape. */
export interface RetroArgs {
  /** Whether the run may mutate anything (issues / PRs / feedback edits). */
  apply: boolean;
  /** The positional run id; omitted entirely when absent (⇒ latest run). */
  runId?: string;
}

/**
 * Parse the CLI-style args the retro skills receive. Recognised forms:
 *
 *   <run_id>            → positional run id; omitted ⇒ latest completed run
 *   --audit | --dry-run → print the plan, do NOT emit anything
 *   --apply             → opt-in to actually emitting (the only mutating path)
 *
 * `--audit` (dry-run) is the DEFAULT for safety: `parseArgs("")` returns
 * `{ apply: false }` — a missing/empty arg string can never opt a retro run
 * into mutation. The calling skill's mutation paths (issues / the gated PR /
 * feedback-file edits / backlog writes) are all gated behind
 * `apply === true`.
 *
 * Unknown `--flags` are ignored rather than misparsed as a run id; of the
 * positional tokens only the first is the run id. Pure — test it by passing
 * arbitrary strings (test/hydra-retro-emit.test.mts).
 */
export function parseArgs(args: string | null | undefined): RetroArgs {
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
