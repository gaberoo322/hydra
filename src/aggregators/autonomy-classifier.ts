/**
 * Autonomy classifier (issue #1868 — extracted from builder-health.ts).
 *
 * The pure classification logic behind the **Autonomy Rate** — the headline
 * Builder Health metric (CONTEXT.md: **Autonomy Rate**). Given a `GhPrView`
 * (the parsed shape of `gh pr view --json mergedBy,labels,reviews,commits`),
 * decide whether a dispatch's PR was merged autonomously, grounded in
 * ADR-0005's CLOSED operator-escalation list.
 *
 * This module owns ONLY the pure classification: its constants
 * (`INTERVENTION_LABELS`, `KNOWN_BOT_LOGINS`), its actor-bot classifier
 * (`isBotActor`), the `GhPrView` input type, and the `AutonomyDecision`
 * output type. It has no Redis access, no GitHub I/O, and no metric
 * computation — `computeAutonomyAndLatency` in builder-health.ts owns the
 * GitHub-read + metric-computation orchestration and imports `classifyAutonomy`
 * from here.
 *
 * Locality: a change to the definition of "autonomous" (a new intervention
 * label, a new bot login, a new review type) is a one-file edit here — the
 * file named after the concept — not a buried constant inside the aggregator.
 */

/** Minimal shape of `gh pr view --json mergedBy,labels,reviews,commits` output. */
export interface GhPrView {
  number?: number;
  mergedAt?: string | null;
  mergedBy?: { login?: string; is_bot?: boolean } | null;
  labels?: Array<{ name?: string }>;
  reviews?: Array<{ author?: { login?: string; is_bot?: boolean } | null }>;
  commits?: Array<{
    authors?: Array<{ login?: string; is_bot?: boolean }>;
    author?: { login?: string; is_bot?: boolean } | null;
  }>;
}

/** Per-dispatch autonomy verdict, surfaced in the scorecard breakdown. */
export interface AutonomyDecision {
  prNumber: number;
  autonomous: boolean;
  reason: string;
}

const INTERVENTION_LABELS = new Set(["operator-approved", "ready-for-human"]);
/** GitHub bot login suffix + the known auto-merge bot logins. */
const KNOWN_BOT_LOGINS = new Set(["github-actions[bot]", "web-flow"]);

/**
 * Pure helper — exported for tests. Classify a merged PR as autonomous or not.
 *
 * A dispatch is autonomous iff (grounded in ADR-0005's CLOSED escalation
 * list, CONTEXT.md: **Autonomy Rate**):
 *   1. its PR was merged by a bot (auto-merge), AND
 *   2. its labels never carried `operator-approved` or `ready-for-human`, AND
 *   3. no human authored a review, AND
 *   4. no human authored a commit on the branch.
 *
 * An automated rebase / bot squash-merge is NOT intervention. A human merge,
 * a human review, a human commit, or an escalation label is intervention.
 */
export function classifyAutonomy(view: GhPrView): { autonomous: boolean; reason: string } {
  // 1. Merged by a human?
  if (!isBotActor(view.mergedBy)) {
    return { autonomous: false, reason: "merged-by-human" };
  }
  // 2. Escalation label ever present?
  const labels = Array.isArray(view.labels) ? view.labels : [];
  for (const l of labels) {
    if (l && typeof l.name === "string" && INTERVENTION_LABELS.has(l.name)) {
      return { autonomous: false, reason: `escalation-label:${l.name}` };
    }
  }
  // 3. Human-authored review?
  const reviews = Array.isArray(view.reviews) ? view.reviews : [];
  for (const r of reviews) {
    if (r && r.author && !isBotActor(r.author)) {
      return { autonomous: false, reason: "human-review" };
    }
  }
  // 4. Human-authored commit?
  const commits = Array.isArray(view.commits) ? view.commits : [];
  for (const c of commits) {
    const authors = Array.isArray(c?.authors) && c.authors.length > 0
      ? c.authors
      : c?.author
        ? [c.author]
        : [];
    for (const a of authors) {
      if (a && !isBotActor(a)) {
        return { autonomous: false, reason: "human-commit" };
      }
    }
  }
  return { autonomous: true, reason: "autonomous" };
}

/** True iff the actor is a bot (is_bot flag or a known bot login). */
function isBotActor(actor: { login?: string; is_bot?: boolean } | null | undefined): boolean {
  if (!actor) return false;
  if (actor.is_bot === true) return true;
  const login = typeof actor.login === "string" ? actor.login : "";
  if (login.endsWith("[bot]")) return true;
  return KNOWN_BOT_LOGINS.has(login);
}
