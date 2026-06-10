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
 */

import { Router } from "express";

import {
  AutopilotBoardStateQuerySchema,
  type AutopilotBoardStateResponse,
} from "../schemas/autopilot-board.ts";
import {
  listOpenIssues,
  ISSUE_JSON_FIELDS,
  type IssueRow,
  type IssueReadResult,
} from "../github/issues.ts";

// ---------------------------------------------------------------------------
// The orchestrator board label vocabulary — one authoritative copy
// ---------------------------------------------------------------------------

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
} as const;

/**
 * Staleness windows (seconds) — preserved verbatim from `collect-state.sh`:
 * an `in-progress` issue untouched for 90 min, or a `blocked` issue untouched
 * for 12 h, is "stale" and listed by number so the autopilot can re-route it.
 */
export const STALE_IN_PROGRESS_SECONDS = 5400; // 90 min
export const STALE_BLOCKED_SECONDS = 43200; // 12 h

/** `--json` field set this projection needs — the canonical set plus `updatedAt`. */
const BOARD_ISSUE_FIELDS = `${ISSUE_JSON_FIELDS},updatedAt`;

// ---------------------------------------------------------------------------
// Pure derivation — exported for tests
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
 */
export function deriveBoardState(
  rows: readonly IssueRow[],
  nowMs: number,
): Omit<AutopilotBoardStateResponse, "degraded" | "generatedAt"> {
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
    if (labels.has(ORCH_BOARD_LABELS.ready_for_agent)) ready_for_agent++;
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
}

export function createAutopilotBoardRouter(deps: AutopilotBoardRouterDeps = {}) {
  const router = Router();
  const readOpenIssues = deps.readOpenIssues ?? defaultReadOpenIssues;
  const clock = deps.now ?? (() => Date.now());

  router.get("/autopilot/board-state", async (req, res) => {
    const parsed = AutopilotBoardStateQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

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
        counts = deriveBoardState(result.rows, nowMs);
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

function defaultReadOpenIssues(): Promise<IssueReadResult<IssueRow>> {
  return listOpenIssues({ fields: BOARD_ISSUE_FIELDS });
}
