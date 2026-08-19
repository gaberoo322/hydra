/**
 * autopilot/board-state — the pure board-state bucketing projection (issue #3505).
 *
 * `deriveBoardState` is the side-effect-free projection of a list of open
 * {@link IssueRow}s (plus a `nowMs` clock and a pre-resolved open-blocker set)
 * into the board-state counts + stale lists. It has no HTTP surface, no Express
 * dependency, and no Redis dependency — its natural home is the `autopilot`
 * domain alongside the other pure board-facing projections, NOT the Express
 * route file that serves it.
 *
 * This leaf was extracted verbatim from `src/api/autopilot-board.ts` (issue
 * #934) so that:
 *
 *   1. the board-state bucketing policy (label vocabulary → counts, strict-
 *      blocker exclusion, staleness windows) concentrates in one named domain
 *      leaf — a change to the policy edits one file, not a file that also owns
 *      HTTP wiring; and
 *   2. `src/target-board-labels.ts` (and any future multi-scope board reader)
 *      can import `deriveBoardState` directly from its domain home without a
 *      route file in the import closure — making the "ideal seam count is one"
 *      invariant (ADR-0031 Decision 3) actually achievable.
 *
 * The route file (`src/api/autopilot-board.ts`) is now a thin HTTP adapter that
 * imports this projection. The function signature and behaviour are unchanged —
 * this is a relocation to the right depth (a deepening), not a rewrite.
 */

import type { AutopilotBoardStateResponse } from "../schemas/autopilot-board.ts";
import type { IssueRow } from "../github/issues.ts";
import {
  extractStrictBlockerRefs,
  fetchOpenBlockerNumbers,
} from "../github/blockers.ts";
import {
  ORCH_BOARD_LABELS,
  STALE_IN_PROGRESS_SECONDS,
  STALE_BLOCKED_SECONDS,
} from "../board-labels.ts";

// ---------------------------------------------------------------------------
// Pure derivation — exported for the route and tests
// ---------------------------------------------------------------------------

/**
 * Bucket a list of open {@link IssueRow}s into the board-state counts + stale
 * lists. Pure (no I/O, no `gh`); the route and tests pin it directly. `nowMs`
 * is injected so the staleness windows are deterministic under test.
 *
 * Staleness math mirrors the bash `(now - (.updatedAt | fromdateiso8601)) > N`:
 * a row with an unparseable/absent `updatedAt` is treated as NOT stale (the
 * conservative default — an empty `updatedAt` produces `NaN` age, which fails
 * the `> window` comparison, exactly as the bash `fromdateiso8601` miss did).
 *
 * **Dependency-aware `ready_for_agent` filter (issue #3059).** A
 * `ready-for-agent` issue whose body cites an OPEN strict blocker
 * (`blocked by #N` / `depends on #N`) is EXCLUDED from the `ready_for_agent`
 * count so `decide.py` (which consumes this filtered count) never dispatches
 * onto an unmerged blocker. Openness is resolved async by the endpoint and
 * injected here as `openBlockers` — keeping this function pure/sync and
 * golden-fixture testable. An empty set (the default) means no strict-blocker
 * filtering: every `ready-for-agent` issue counts, so callers that don't
 * pre-resolve blockers get the pre-#3059 behavior. The filter is ADDITIVE to
 * the manual `blocked` label — it never toggles that label.
 *
 * **GLM partition liveness gate (issue #3754, ADR-0032 as amended by #3753).**
 * The `glm-eligible` exclusion is CONDITIONAL on drainer liveness. When
 * `glmPartitionActive` is true (the drainer heartbeat is fresh), a
 * `glm-eligible` issue is excluded from `ready_for_agent` — the drainer owns
 * it on z.ai's independent quota, so counting it would dispatch a second
 * author. When `glmPartitionActive` is false (drainer absent / stale /
 * unreachable), `glm-eligible` issues are NOT excluded — Opus sees them again,
 * so a down drainer never starves the Opus `dev_orch` lane. The default
 * (`false`) is the fail-open-toward-work direction: a caller that does not
 * resolve liveness shows work rather than hiding it. Liveness is resolved
 * async by the endpoint (via the typed accessor in `src/redis/autopilot.ts`)
 * and injected here as a boolean — keeping this function pure/sync.
 */
/**
 * True when `labels` carries `glm-eligible` AND the GLM dev-drainer partition
 * is LIVE (issue #3754, ADR-0032) — i.e. this issue is withheld from the
 * Claude `dev_orch` authoring pool because the drainer already owns it on
 * z.ai's independent quota.
 *
 * THE single predicate both call sites apply (issue #4153, the #3965 shape):
 * the COUNT path (`deriveBoardState` / `resolveOpenBlockers` below) and the
 * `hydra-dev` skill's SELECTION path (`docs/operator-playbooks/_fragments/
 * hydra-dev-parent-flow.md`, "1. Select issue"). Before #4153 the selection
 * path applied NO glm-eligible filter at all, so an unpinned `dev_orch`
 * dispatch could land on — and double-author — a GLM-drainer-owned issue even
 * though the count path had already excluded it from `ready_for_agent`.
 *
 * The selection path is bash/python (no TS bridge), so it necessarily MIRRORS
 * this predicate rather than importing it; `test/board-state.test.mts` pins
 * the mirror with a byte-identical drift guard over `GLM_DRAINER_ACTIVE_KEY` /
 * `GLM_DRAINER_HEARTBEAT_STALE_MS` (`src/redis/autopilot.ts`) and the
 * `glm-eligible` label literal — the same convention issue #3965 established
 * for the strict-blocker predicate mirrored into `collect-state.sh`.
 *
 * `glmPartitionActive=false` — the default, and the value ANY liveness-read
 * failure resolves to per `getGlmDrainerLiveness` — always returns `false`
 * here regardless of labels. That is the fail-open-toward-work direction
 * (#3754): a down/absent/stale drainer un-gates `glm-eligible` issues rather
 * than starving the Claude lane. Must not be inverted.
 */
export function isGlmWithheldFromClaude(
  labels: readonly string[],
  glmPartitionActive: boolean,
): boolean {
  return glmPartitionActive && labels.includes(ORCH_BOARD_LABELS.glm_eligible);
}

export function deriveBoardState(
  rows: readonly IssueRow[],
  nowMs: number,
  openBlockers: ReadonlySet<number> = new Set(),
  /**
   * Whether the GLM dev-drainer partition is LIVE (issue #3754). See the
   * header doc for the fail-open semantics. Default `false`.
   */
  glmPartitionActive = false,
): Omit<
  AutopilotBoardStateResponse,
  "degraded" | "generatedAt" | "sourcesOk"
> {
  let needs_qa = 0;
  let ready_for_agent = 0;
  let needs_triage = 0;
  let needs_research = 0;
  let in_progress = 0;
  let blocked = 0;
  const stale_in_progress: number[] = [];
  const stale_blocked: number[] = [];

  for (const row of rows) {
    const labels = new Set(row.labels);
    if (labels.has(ORCH_BOARD_LABELS.needs_qa)) needs_qa++;
    // Exclude `target-backlog` issues from the orch `ready_for_agent` count
    // (issue #2704): they are Target-scope routing, not orchestrator work, so
    // counting them mis-fires an orch-scope grill / dispatch on target code.
    // ALSO exclude an issue that declares an OPEN strict blocker (issue #3059):
    // `decide.py` consumes this count, so a dependency-blocked issue must not
    // inflate the dispatchable pool until its blocker closes.
    // ALSO exclude `glm-eligible` issues — but ONLY when the GLM dev-drainer
    // partition is LIVE (issue #3754, ADR-0032 as amended by #3753). When the
    // drainer is up, a `glm-eligible` issue is authored by it on z.ai's
    // independent quota, so counting it in the Opus `dev_orch` authoring pool
    // would dispatch a second author onto work the drainer already owns. When
    // the drainer is absent / stale / unreachable (`glmPartitionActive=false`),
    // the exclusion is LIFTED — Opus sees the work again, so a down drainer
    // never silently starves the Opus lane. `design_concept_orch` is
    // unaffected either way — it still designs every glm-eligible issue.
    if (
      labels.has(ORCH_BOARD_LABELS.ready_for_agent) &&
      !labels.has(ORCH_BOARD_LABELS.target_backlog) &&
      !isGlmWithheldFromClaude(row.labels, glmPartitionActive) &&
      !hasOpenStrictBlocker(row, openBlockers)
    )
      ready_for_agent++;
    if (labels.has(ORCH_BOARD_LABELS.needs_triage)) needs_triage++;
    if (labels.has(ORCH_BOARD_LABELS.needs_research)) needs_research++;

    const isInProgress = labels.has(ORCH_BOARD_LABELS.in_progress);
    const isBlocked = labels.has(ORCH_BOARD_LABELS.blocked);
    if (isInProgress) in_progress++;
    if (isBlocked) blocked++;

    const ageSeconds = issueAgeSeconds(row.updatedAt, nowMs);
    if (isInProgress && ageSeconds > STALE_IN_PROGRESS_SECONDS) {
      stale_in_progress.push(row.number);
    }
    if (isBlocked && ageSeconds > STALE_BLOCKED_SECONDS) {
      stale_blocked.push(row.number);
    }
  }

  return {
    needs_qa,
    ready_for_agent,
    needs_triage,
    needs_research,
    in_progress,
    blocked,
    stale_in_progress,
    stale_blocked,
  };
}

/**
 * Age of an issue in seconds from its ISO `updatedAt` to `nowMs`. An absent or
 * unparseable timestamp yields `NaN` — which fails every `> window` comparison
 * in {@link deriveBoardState}, so a malformed row is conservatively NOT stale.
 */
function issueAgeSeconds(updatedAtIso: string | undefined, nowMs: number): number {
  if (!updatedAtIso) return NaN;
  const t = Date.parse(updatedAtIso);
  if (!Number.isFinite(t)) return NaN;
  return (nowMs - t) / 1000;
}

/**
 * True when the issue's body cites at least one STRICT blocker
 * (`blocked by #N` / `depends on #N`, via {@link extractStrictBlockerRefs})
 * whose number is in the injected `openBlockers` set. Self-references are
 * ignored (an issue can't block itself). Used to exclude a dependency-blocked
 * issue from the dispatchable `ready_for_agent` pool (issue #3059).
 */
function hasOpenStrictBlocker(
  row: IssueRow,
  openBlockers: ReadonlySet<number>,
): boolean {
  if (openBlockers.size === 0) return false;
  const refs = extractStrictBlockerRefs(row.body);
  for (const n of refs) {
    if (n !== row.number && openBlockers.has(n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// I/O companion — pre-resolve the open-blocker set (issue #3059)
// ---------------------------------------------------------------------------

/**
 * Pre-resolve the open-blocker set the endpoint injects into
 * {@link deriveBoardState}. Collects the union of STRICT blocker refs across
 * every `ready-for-agent` (non-`target-backlog`) row, then resolves their
 * open/closed state in ONE batched `gh` query via the shared blockers leaf.
 * Fail-safe: on lookup failure every referenced blocker is treated as OPEN
 * (the issue waits a tick) — the shared conservative default (issue #3059).
 * Returns an empty set when no candidate row declares a strict blocker (no
 * `gh` round-trip needed).
 */
export async function resolveOpenBlockers(
  rows: readonly IssueRow[],
  githubRepo?: string,
  /**
   * Whether the GLM dev-drainer partition is LIVE (issue #3754). Mirrors
   * `deriveBoardState`: a `glm-eligible` row is skipped (no `gh` blocker
   * round-trip) ONLY when the partition is active — because then it cannot
   * count toward `ready_for_agent`. When the partition is inactive the row
   * CAN count, so its strict blockers must be resolved like any other.
   * Default `false` (fail-open: resolve liberally, never starve on a skipped
   * resolve).
   */
  glmPartitionActive = false,
): Promise<Set<number>> {
  const referenced = new Set<number>();
  for (const row of rows) {
    const labels = new Set(row.labels);
    // Mirror `deriveBoardState`'s exclusions exactly: a row that cannot count
    // toward `ready_for_agent` never needs its blockers resolved. The
    // `glm-eligible` skip is liveness-conditional (issue #3754): when the
    // partition is inactive a `glm-eligible` row CAN count, so it is NOT
    // skipped here and its blockers resolve like any other ready-for-agent row.
    if (
      !labels.has(ORCH_BOARD_LABELS.ready_for_agent) ||
      labels.has(ORCH_BOARD_LABELS.target_backlog) ||
      isGlmWithheldFromClaude(row.labels, glmPartitionActive)
    )
      continue;
    for (const n of extractStrictBlockerRefs(row.body)) {
      if (n !== row.number) referenced.add(n);
    }
  }
  if (referenced.size === 0) return new Set();
  return fetchOpenBlockerNumbers([...referenced], { githubRepo });
}
