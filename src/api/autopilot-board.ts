/**
 * Autopilot board-state HTTP surface (issue #934).
 *
 *   GET /api/autopilot/board-state → AutopilotBoardStateResponse
 *
 * `scripts/autopilot/collect-state.sh` (Phase 1 of /hydra-autopilot) used to
 * issue a direct `gh issue list --repo gaberoo322/hydra --json
 * number,labels,updatedAt --jq '{needs_qa: …, ready_for_agent: …, …}'` call,
 * re-spelling the repo handle, the `--json` field set, AND the orchestrator
 * label vocabulary in bash. When any of those change behind the **GitHub
 * Issue/PR Read** seam (`src/github/issues.ts`, issue #908) the bash copy
 * silently keeps reading the old shape — the cross-boundary drift the seam
 * exists to prevent.
 *
 * This route serves the same board-count + stale-list projection *on top of*
 * the read seam: one `listOpenIssues` fetch, bucketed in-process by the label
 * vocabulary that now lives in exactly one place ({@link ORCH_BOARD_LABELS}).
 * `collect-state.sh` reads this one surface via `hydra raw GET
 * /autopilot/board-state` instead of fanning out its own `gh` call.
 *
 * The route is a thin adapter — like `autopilot-idle.ts`, the single external
 * read is an overridable `deps` reader so tests stub the issue fetch without a
 * live `gh`. The bucketing math is a pure exported function
 * ({@link deriveBoardState}) the tests pin directly.
 *
 * Never-throw contract (CLAUDE.md): an unreachable `gh` yields the all-zero
 * SAFE DEFAULT with `degraded: true` plus a logged `console.error`, NOT a 500.
 * The only non-200 is a 400 `schema-validation-failed` for a malformed query.
 * The `degraded` flag lets `collect-state.sh` fall back to its inline `gh`
 * call so a transient outage never wedges the autopilot turn.
 *
 * Scope (ADR-0031 Decision 3, issue #3434): an OPTIONAL `?scope=orch|target`
 * query param (default `orch`) selects which repo the same `deriveBoardState`
 * projects. `scope=target` injects the Target repo handle
 * (`getTargetGithubRepo()`) into BOTH `listOpenIssues` and the blocker
 * resolver; `deriveBoardState` and the degrade/never-throw contract are
 * identical for both scopes — no parallel Target board module is built (the
 * ideal seam count is one). The Target board-label VOCABULARY lives in one leaf
 * (`src/target-board-labels.ts`); this read keeps the orch six-count +
 * two-stale-list projection for both scopes (no Target-only count fields — a
 * deliberately deferred follow-on, since adding them would fork this function).
 */

import { Router } from "express";

import {
  AutopilotBoardStateQuerySchema,
  type AutopilotBoardStateResponse,
  type BoardStateScope,
} from "../schemas/autopilot-board.ts";
import {
  listOpenIssues,
  ISSUE_JSON_FIELDS,
  type IssueRow,
  type IssueReadResult,
} from "../github/issues.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import {
  deriveBoardState,
  resolveOpenBlockers,
} from "../autopilot/board-state.ts";

// ---------------------------------------------------------------------------
// The pure board-state projection (`deriveBoardState`) and its I/O companion
// (`resolveOpenBlockers`) live in the `src/autopilot/board-state.ts` leaf
// (issue #3505) — imported above. This router is a thin HTTP adapter that wires
// the projection onto the GitHub-Read seam: the bucketing math itself has no
// Express dependency, so it belongs in the `autopilot` domain, not here. A
// downstream multi-scope reader (`src/target-board-labels.ts`) imports the pure
// function directly from that leaf, never from this route file.
//
// The orchestrator board label vocabulary lives in the pure `src/board-labels.ts`
// leaf (issue #3484); the projection leaf is the sole consumer of it now.
// ---------------------------------------------------------------------------

/** `--json` field set this projection needs — the canonical set plus `updatedAt`. */
const BOARD_ISSUE_FIELDS = `${ISSUE_JSON_FIELDS},updatedAt`;

// ---------------------------------------------------------------------------
// The all-zero safe default (degraded read)
// ---------------------------------------------------------------------------

function emptyCounts(): Omit<
  AutopilotBoardStateResponse,
  "degraded" | "generatedAt"
> {
  return {
    needs_qa: 0,
    ready_for_agent: 0,
    needs_triage: 0,
    needs_research: 0,
    in_progress: 0,
    blocked: 0,
    stale_in_progress: [],
    stale_blocked: [],
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/** Reader for the open-issue list. Defaults to the GitHub-Read seam. */
interface OpenIssuesReader {
  (): Promise<IssueReadResult<IssueRow>>;
}

export interface AutopilotBoardRouterDeps {
  /**
   * Reader for the whole open board, through the GitHub-Read seam. Defaults to
   * `listOpenIssues` with the `updatedAt`-augmented field set. A failure arm
   * (or a REJECTED promise) degrades to the all-zero `degraded: true` body —
   * never a 500.
   */
  readOpenIssues?: OpenIssuesReader;
  /** Clock — defaults to `() => Date.now()`. Injected so staleness is testable. */
  now?: () => number;
  /**
   * Pre-resolve the OPEN strict-blocker set for the ready-for-agent rows
   * (issue #3059). Defaults to {@link resolveOpenBlockers}, which batches one
   * `gh` open/closed lookup through the shared blockers leaf. Injected so the
   * dependency-aware filter is testable without a live `gh` — a resolver that
   * throws or rejects degrades the WHOLE board to `degraded:true` (never a
   * 500), same as a failed `readOpenIssues`.
   */
  resolveOpenBlockers?: (
    rows: readonly IssueRow[],
  ) => Promise<Set<number>>;
}

export function createAutopilotBoardRouter(deps: AutopilotBoardRouterDeps = {}) {
  const router = Router();
  const clock = deps.now ?? (() => Date.now());

  router.get("/autopilot/board-state", async (req, res) => {
    const parsed = AutopilotBoardStateQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    // ADR-0031 Decision 3: `scope=target` injects the Target repo handle into
    // BOTH the open-issue read and the blocker resolver; `scope=orch` (the
    // default) preserves today's behavior by injecting no override (the read
    // seam resolves the Orchestrator's own repo). `deriveBoardState` is reused
    // byte-for-byte unchanged for both scopes. Injected deps (test stubs) win
    // over the scope-selected defaults so the pure filter stays testable.
    const scope: BoardStateScope = parsed.data.scope;
    const repoOverride = scope === "target" ? getTargetGithubRepo() : undefined;
    const readOpenIssues =
      deps.readOpenIssues ?? (() => defaultReadOpenIssues(repoOverride));
    const resolveBlockers =
      deps.resolveOpenBlockers ??
      ((rows: readonly IssueRow[]) => resolveOpenBlockers(rows, repoOverride));

    const nowMs = clock();
    let counts = emptyCounts();
    let degraded = false;

    try {
      const result = await readOpenIssues();
      if (result.ok === false) {
        degraded = true;
        console.error(
          `[autopilot/board-state] gh issue list failed (${result.code}) — degraded all-zero board`,
        );
      } else {
        // Pre-resolve the OPEN strict-blocker set (async) and inject it into
        // the pure bucketer so the dependency-aware ready_for_agent filter
        // (issue #3059) stays golden-fixture testable.
        const openBlockers = await resolveBlockers(result.rows);
        counts = deriveBoardState(result.rows, nowMs, openBlockers);
      }
    } catch (err: any) {
      // Belt-and-braces: the seam never throws, but honour the never-throw
      // contract here too — a thrown read degrades, it does not 500.
      degraded = true;
      console.error(
        `[autopilot/board-state] open-issue read threw despite never-throw seam: ${err?.message || err}`,
      );
    }

    const body: AutopilotBoardStateResponse = {
      ...counts,
      degraded,
      generatedAt: new Date(nowMs).toISOString(),
    };
    return res.json(body);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Default wiring
// ---------------------------------------------------------------------------

/**
 * Default open-issue reader through the GitHub-Read seam. `repo` is the
 * scope-selected handle: `undefined` for `scope=orch` (the seam resolves the
 * Orchestrator's own repo, preserving today's behavior) or the Target repo for
 * `scope=target` (ADR-0031 Decision 3). Uses the REST-backed `gh issue list`
 * path (ADR-0031 Decision 6 — never GraphQL for the money-critical Target
 * hot path).
 */
function defaultReadOpenIssues(
  repo?: string,
): Promise<IssueReadResult<IssueRow>> {
  return listOpenIssues({ fields: BOARD_ISSUE_FIELDS, repo });
}
