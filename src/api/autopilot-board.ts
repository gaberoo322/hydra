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
 * SAFE DEFAULT with `degraded: true` plus a logged `logger.error`, NOT a 500.
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
  PromoteActionBodySchema,
  RelabelActionBodySchema,
  IssueRefBodySchema,
  type AutopilotBoardStateResponse,
  type BoardStateScope,
  type BoardActionResult,
  type ReadyQueueRow,
} from "../schemas/autopilot-board.ts";
import {
  listOpenIssues,
  addIssueLabel,
  ISSUE_JSON_FIELDS,
  type IssueRow,
  type IssueReadResult,
} from "../github/issues.ts";
import {
  removeIssueLabel,
  closeIssue,
  reopenIssue,
  viewIssueRow,
} from "../github/issue-actions.ts";
import { extractStrictBlockerRefs } from "../github/blockers.ts";
import { ORCH_BOARD_LABELS } from "../board-labels.ts";
import { extractScopeFromBody } from "../scope-section.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import {
  deriveBoardState,
  resolveOpenBlockers,
} from "../autopilot/board-state.ts";
import { getGlmDrainerLiveness } from "../redis/autopilot.ts";
import { isolateAggregator } from "./route-helpers.ts";
import { logger } from "../logger.ts";

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
  /**
   * Resolve whether the GLM dev-drainer partition is LIVE for this turn
   * (issue #3754) — i.e. whether `glm-eligible` issues should be subtracted
   * from `ready_for_agent`. Defaults to the typed heartbeat accessor in
   * `src/redis/autopilot.ts` (`getGlmDrainerLiveness(nowMs).live`). Injected
   * so the partition gate is testable without a live Redis; a reader that
   * throws degrades to partition-inactive (fail-open toward work — see the
   * never-throw catch in the handler).
   */
  glmDrainerLiveness?: (nowMs: number) => Promise<boolean>;
  /**
   * Single-issue read for the action routes' guards + post-write verification
   * (issue #4010). Defaults to the issue-actions leaf's `viewIssueRow`
   * (`gh issue view --json`, parsed through the seam). Injected so the action
   * tests never spawn a real `gh`.
   */
  viewIssue?: (issueNumber: number) => Promise<IssueRow | null>;
  /** Label-add write for promote/relabel. Defaults to `issues.ts`'s addIssueLabel. */
  addLabel?: typeof addIssueLabel;
  /** Label-remove write for promote/relabel. Defaults to the issue-actions leaf. */
  removeLabel?: typeof removeIssueLabel;
  /** Close write. Defaults to the issue-actions leaf. */
  closeIssue?: typeof closeIssue;
  /** Reopen write. Defaults to the issue-actions leaf. */
  reopenIssue?: typeof reopenIssue;
}

// ---------------------------------------------------------------------------
// Ready-queue projection (issue #4010, INV-1) — pure, exported for tests
// ---------------------------------------------------------------------------

/**
 * Project the ready-for-agent QUEUE rows: every row carrying the label, each
 * annotated with WHY it does not count toward `deriveBoardState`'s
 * `ready_for_agent` dispatch pool when it doesn't (`excluded`), so the /work
 * page answers "what is queued, and why is THAT next" instead of a bare count.
 *
 * The exclusion reasons mirror `deriveBoardState`'s filter arms exactly (same
 * parser, same label vocabulary, same liveness conditioning) — reason priority
 * is the filter's condition order: `target-backlog`, then
 * `glm-eligible-drainer-live`, then `blocked-by-open-issue`. A drift-guard
 * test asserts the structural invariant this mirroring promises:
 * `rows.filter(r => r.excluded === null).length === deriveBoardState(...).ready_for_agent`.
 *
 * Pure: rows + pre-resolved open-blocker set + liveness flag in, rows out.
 */
export function deriveReadyQueue(
  rows: readonly IssueRow[],
  openBlockers: ReadonlySet<number>,
  glmPartitionActive: boolean,
): ReadyQueueRow[] {
  const queue: ReadyQueueRow[] = [];
  for (const row of rows) {
    const labels = new Set(row.labels);
    if (!labels.has(ORCH_BOARD_LABELS.ready_for_agent)) continue;
    const blockedBy = extractStrictBlockerRefs(row.body).filter(
      (n) => n !== row.number && openBlockers.has(n),
    );
    let excluded: ReadyQueueRow["excluded"] = null;
    if (labels.has(ORCH_BOARD_LABELS.target_backlog)) {
      excluded = "target-backlog";
    } else if (glmPartitionActive && labels.has(ORCH_BOARD_LABELS.glm_eligible)) {
      excluded = "glm-eligible-drainer-live";
    } else if (blockedBy.length > 0) {
      excluded = "blocked-by-open-issue";
    }
    queue.push({
      number: row.number,
      title: row.title,
      url: row.url,
      updatedAt: row.updatedAt ?? "",
      excluded,
      blockedBy: excluded === "blocked-by-open-issue" ? blockedBy : [],
    });
  }
  queue.sort((a, b) => a.number - b.number);
  return queue;
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
    const glmLiveness =
      deps.glmDrainerLiveness ??
      ((nowMs: number) => getGlmDrainerLiveness(nowMs).then((l) => l.live));

    const nowMs = clock();
    let counts = emptyCounts();
    let degraded = false;
    let readyQueue: ReadyQueueRow[] = [];

    try {
      const result = await readOpenIssues();
      if (result.ok === false) {
        degraded = true;
        // Not a 500: the degraded all-zero board (with degraded:true) IS the
        // never-throw SAFE DEFAULT collect-state.sh parses, so the
        // isolateAggregator seam does not apply. ADR-0027 eighth sweep: the log
        // adopts the pino `err`-field seam.
        logger.error(
          { code: result.code },
          "[autopilot/board-state] gh issue list failed — degraded all-zero board",
        );
      } else {
        // Resolve GLM drainer liveness (issue #3754): it gates BOTH the
        // `glm-eligible` subtraction in `deriveBoardState` AND the matching
        // skip in the blocker resolver. The accessor never throws; this inner
        // try is belt-and-braces for an injected stub and the fail-open
        // contract — any read failure → partition inactive → `glm-eligible`
        // issues stay visible to Opus rather than being hidden by default.
        let glmPartitionActive = false;
        try {
          glmPartitionActive = await glmLiveness(nowMs);
        } catch (err: any) {
          logger.error(
            { err },
            "[autopilot/board-state] glm drainer liveness read threw — partition inactive (fail-open, #3754)",
          );
          glmPartitionActive = false;
        }
        const resolveBlockers =
          deps.resolveOpenBlockers ??
          ((rows: readonly IssueRow[]) =>
            resolveOpenBlockers(rows, repoOverride, glmPartitionActive));
        // Pre-resolve the OPEN strict-blocker set (async) and inject it into
        // the pure bucketer so the dependency-aware ready_for_agent filter
        // (issue #3059) stays golden-fixture testable.
        const openBlockers = await resolveBlockers(result.rows);
        counts = deriveBoardState(
          result.rows,
          nowMs,
          openBlockers,
          glmPartitionActive,
        );
        readyQueue = deriveReadyQueue(
          result.rows,
          openBlockers,
          glmPartitionActive,
        );
      }
    } catch (err: any) {
      // Belt-and-braces: the seam never throws, but honour the never-throw
      // contract here too — a thrown read degrades, it does not 500.
      degraded = true;
      logger.error(
        { err },
        "[autopilot/board-state] open-issue read threw despite never-throw seam",
      );
    }

    const body: AutopilotBoardStateResponse = {
      ...counts,
      degraded,
      generatedAt: new Date(nowMs).toISOString(),
      // ADR-0034 §5 (issue #4010, INV-2/INV-3): the additive trust spelling
      // `usePageItems` reads — `sourcesOk === false` demotes the whole panel
      // to UNKNOWN so a degraded all-zero board never renders as a confident
      // zero. `degraded` itself stays byte-identical for collect-state.sh.
      sourcesOk: !degraded,
      // INV-1: the ready-for-agent queue rows (why-not annotations included),
      // empty on a degraded read (nothing to assert).
      ready_queue: readyQueue,
    };
    return res.json(body);
  });

  // -------------------------------------------------------------------------
  // Issue-lifecycle action routes (issue #4010, ADR-0034 §7) — the /work page's
  // write surface. Policy lives HERE, server-side (never re-derived client-
  // side): promote is confirm-first + double-refused; relabel/close/reopen are
  // immediate-tier; every action re-reads the issue's actual post-write state
  // before reporting success (INV-6 — no unverified success). All writes ride
  // `gh issue` subcommands through the seams above (INV-7). Handled refusals
  // are 200 `{ok:false, reason}` — the dashboard surfaces the specific reason;
  // only a malformed body 400s and only an impossible throw 500s.
  // -------------------------------------------------------------------------

  const viewIssue = deps.viewIssue ?? ((n: number) => viewIssueRow(n));
  const addLabel = deps.addLabel ?? addIssueLabel;
  const removeLabel = deps.removeLabel ?? removeIssueLabel;
  const doClose = deps.closeIssue ?? closeIssue;
  const doReopen = deps.reopenIssue ?? reopenIssue;

  /** The same blocker resolver the GET uses — deps-injectable, orch scope. */
  const resolveBlockersForAction = deps.resolveOpenBlockers ?? resolveOpenBlockers;

  /** Run a write primitive; fold a failure into the uniform refusal result. */
  async function runWrite(
    action: BoardActionResult["action"],
    issue: number,
    what: string,
    write: () => Promise<{ ok: true } | { ok: false; code: string; stderr: string }>,
  ): Promise<BoardActionResult | null> {
    const res = await write();
    if (res.ok === true) return null;
    // The failure arm — `code`/`stderr` only exist there.
    const code = res.code;
    const stderr = res.stderr;
    logger.error(
      { action, issue, code, stderr: stderr.slice(0, 300) },
      "[autopilot/board-state] issue action write failed",
    );
    return {
      ok: false,
      action,
      issue,
      reason: "write-failed",
      detail: `${what} failed (${code}): ${stderr.slice(0, 200)}`,
    };
  }

  /** Re-read the issue and verify the predicate holds — or refuse (INV-6). */
  async function verifyPostWrite(
    action: BoardActionResult["action"],
    issue: number,
    holds: (post: IssueRow) => boolean,
  ): Promise<{ post: IssueRow } | BoardActionResult> {
    const post = await viewIssue(issue);
    if (!post) {
      return {
        ok: false,
        action,
        issue,
        reason: "verify-failed",
        detail: "post-write re-read failed — the write may or may not have landed; re-check the issue",
      };
    }
    if (!holds(post)) {
      return {
        ok: false,
        action,
        issue,
        reason: "verify-failed",
        detail: `post-write state disagrees (labels: ${post.labels.join(", ") || "none"}; state: ${post.state})`,
      };
    }
    return { post };
  }

  function verifiedFrom(post: IssueRow) {
    return {
      number: post.number,
      state: post.state,
      labels: post.labels,
      url: post.url,
    };
  }

  // POST /autopilot/board-state/promote — confirm-first, double-refused.
  router.post("/autopilot/board-state/promote", async (req, res) => {
    const parsed = PromoteActionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { issue, confirm } = parsed.data;
    return isolateAggregator(res, "autopilot/board-state/promote", async () => {
      // ADR-0034 §7: promote is "confirm first" — ready-for-agent is a
      // dispatch trigger in disguise. The server re-checks the client's
      // explicit confirm step; it is never trusted alone.
      if (!confirm) {
        return {
          ok: false,
          action: "promote",
          issue,
          reason: "confirm-required",
          detail: "promote to ready-for-agent arms a dispatch — pass confirm:true after an explicit confirm step",
        };
      }

      const pre = await viewIssue(issue);
      if (!pre) {
        return {
          ok: false,
          action: "promote",
          issue,
          reason: "issue-read-failed",
          detail: `could not read issue #${issue} (absent, or gh unreachable)`,
        };
      }

      // Refusal 1 — blocked issue (INV-5): reuse the SAME open-strict-blocker
      // resolver the board count filters through (`resolveOpenBlockers`,
      // issue #3059). The target row typically does not carry the
      // ready-for-agent label yet (that is what promote adds), so the label is
      // synthesized onto the row passed in — asking the count path's own
      // resolver "would THIS row's blockers gate it" rather than re-deriving
      // blockedness a second way.
      const refs = extractStrictBlockerRefs(pre.body).filter(
        (n) => n !== issue,
      );
      if (refs.length > 0) {
        const openBlockers = await resolveBlockersForAction([
          { ...pre, labels: [...pre.labels, ORCH_BOARD_LABELS.ready_for_agent] },
        ]);
        const open = refs.filter((n) => openBlockers.has(n));
        if (open.length > 0) {
          return {
            ok: false,
            action: "promote",
            issue,
            reason: "blocked-by-open-issue",
            detail: `open strict blocker(s): ${open.map((n) => `#${n}`).join(", ")}`,
          };
        }
      }

      // Refusal 2 — missing "## Files in scope" section (INV-5): without it,
      // the issue-label-validation workflow reverts ready-for-agent a moment
      // later. Reuses the CI scope gate's own parser (extractScopeFromBody,
      // relocated to src/scope-section.ts) — never a re-implemented regex.
      if (extractScopeFromBody(pre.body).length === 0) {
        return {
          ok: false,
          action: "promote",
          issue,
          reason: "missing-files-in-scope",
          detail: "the issue body has no '## Files in scope' section — issue-label-validation would revert ready-for-agent",
        };
      }

      // Write: add the label; clear the promote-source lanes so the board
      // does not double-count the issue in two lanes.
      const addFailure = await runWrite("promote", issue, "add ready-for-agent", () =>
        addLabel(issue, ORCH_BOARD_LABELS.ready_for_agent),
      );
      if (addFailure) return addFailure;
      for (const lane of [ORCH_BOARD_LABELS.needs_triage, ORCH_BOARD_LABELS.needs_research]) {
        if (!pre.labels.includes(lane)) continue;
        const rmFailure = await runWrite("promote", issue, `remove ${lane}`, () =>
          removeLabel(issue, lane),
        );
        if (rmFailure) return rmFailure;
      }

      // Verify (INV-6): success renders only off the re-read state.
      const verdict = await verifyPostWrite(
        "promote",
        issue,
        (post) =>
          post.labels.includes(ORCH_BOARD_LABELS.ready_for_agent) &&
          !post.labels.includes(ORCH_BOARD_LABELS.needs_triage) &&
          !post.labels.includes(ORCH_BOARD_LABELS.needs_research),
      );
      if (!("post" in verdict)) return verdict;
      return { ok: true, action: "promote", issue, verified: verifiedFrom(verdict.post) };
    });
  });

  // POST /autopilot/board-state/relabel — immediate-tier lane move.
  router.post("/autopilot/board-state/relabel", async (req, res) => {
    const parsed = RelabelActionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { issue, label } = parsed.data;
    return isolateAggregator(res, "autopilot/board-state/relabel", async () => {
      const pre = await viewIssue(issue);
      if (!pre) {
        return {
          ok: false,
          action: "relabel",
          issue,
          reason: "issue-read-failed",
          detail: `could not read issue #${issue} (absent, or gh unreachable)`,
        };
      }
      // Lane move: clear every orch lane label the row carries, then add the
      // target. (ready-for-agent can never be the target — that is promote's
      // gated path; the schema enum enforces it, this is the belt to it.)
      const laneLabels = [
        ORCH_BOARD_LABELS.needs_qa,
        ORCH_BOARD_LABELS.needs_triage,
        ORCH_BOARD_LABELS.needs_research,
        ORCH_BOARD_LABELS.in_progress,
        ORCH_BOARD_LABELS.blocked,
      ];
      for (const lane of laneLabels) {
        if (lane === label || !pre.labels.includes(lane)) continue;
        const rmFailure = await runWrite("relabel", issue, `remove ${lane}`, () =>
          removeLabel(issue, lane),
        );
        if (rmFailure) return rmFailure;
      }
      if (!pre.labels.includes(label)) {
        const addFailure = await runWrite("relabel", issue, `add ${label}`, () =>
          addLabel(issue, label),
        );
        if (addFailure) return addFailure;
      }
      const others = laneLabels.filter((l) => l !== label);
      const verdict = await verifyPostWrite("relabel", issue, (post) =>
        post.labels.includes(label) && others.every((l) => !post.labels.includes(l)),
      );
      if (!("post" in verdict)) return verdict;
      return { ok: true, action: "relabel", issue, verified: verifiedFrom(verdict.post) };
    });
  });

  // POST /autopilot/board-state/close — immediate-tier, verified.
  router.post("/autopilot/board-state/close", async (req, res) => {
    const parsed = IssueRefBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { issue } = parsed.data;
    return isolateAggregator(res, "autopilot/board-state/close", async () => {
      const writeFailure = await runWrite("close", issue, "close issue", () =>
        doClose(issue),
      );
      if (writeFailure) return writeFailure;
      const verdict = await verifyPostWrite(
        "close",
        issue,
        (post) => post.state === "CLOSED",
      );
      if (!("post" in verdict)) return verdict;
      return { ok: true, action: "close", issue, verified: verifiedFrom(verdict.post) };
    });
  });

  // POST /autopilot/board-state/reopen — immediate-tier, verified.
  router.post("/autopilot/board-state/reopen", async (req, res) => {
    const parsed = IssueRefBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }
    const { issue } = parsed.data;
    return isolateAggregator(res, "autopilot/board-state/reopen", async () => {
      const writeFailure = await runWrite("reopen", issue, "reopen issue", () =>
        doReopen(issue),
      );
      if (writeFailure) return writeFailure;
      const verdict = await verifyPostWrite(
        "reopen",
        issue,
        (post) => post.state === "OPEN",
      );
      if (!("post" in verdict)) return verdict;
      return { ok: true, action: "reopen", issue, verified: verifiedFrom(verdict.post) };
    });
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
