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
  IssueStateActionBodySchema,
  type AutopilotBoardStateResponse,
  type BoardStateScope,
  type ReadyQueueEntry,
  type BoardActionResponse,
} from "../schemas/autopilot-board.ts";
import {
  listOpenIssues,
  addIssueLabel,
  isIssueLabelWriteFailure,
  ISSUE_JSON_FIELDS,
  type IssueRow,
  type IssueReadResult,
  type IssueLabelWriteResult,
} from "../github/issues.ts";
import {
  removeIssueLabel,
  closeIssue,
  reopenIssue,
  viewIssueState,
  isIssueStateFailure,
  type IssueActionWriteResult,
  type IssueStateResult,
} from "../github/issue-actions.ts";
import { extractScopeFromBody } from "../scope-sections.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import {
  deriveBoardState,
  resolveOpenBlockers,
} from "../autopilot/board-state.ts";
import { ORCH_BOARD_LABELS } from "../board-labels.ts";
import { schemaValidationError } from "./route-helpers.ts";
import { getGlmDrainerLiveness } from "../redis/autopilot.ts";
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
  "degraded" | "generatedAt" | "sourcesOk"
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
    ready_for_agent_queue: [],
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
   * The /work issue-lifecycle action seams (issue #4010, ADR-0034 §7):
   * label add (the existing `issues.ts` primitive — reused, never
   * re-implemented), the new issue-actions leaf's remove/close/reopen
   * writes, its post-write verification read, and the open-blocker resolver
   * for the promote guard. Grouped as one object so a test stubs the whole
   * action surface in one literal; defaults wire the production seams.
   */
  issueActions?: {
    addLabel: (issue: number, label: string) => Promise<IssueLabelWriteResult>;
    removeLabel: (issue: number, label: string) => Promise<IssueActionWriteResult>;
    close: (issue: number) => Promise<IssueActionWriteResult>;
    reopen: (issue: number) => Promise<IssueActionWriteResult>;
    view: (issue: number) => Promise<IssueStateResult>;
  };
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
        counts = {
          ...deriveBoardState(result.rows, nowMs, openBlockers, glmPartitionActive),
          ready_for_agent_queue: deriveReadyQueue(
            result.rows,
            nowMs,
            openBlockers,
            glmPartitionActive,
          ),
        };
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
      // ADR-0034 §5 asserted-cleanliness signal (issue #4010, additive): an
      // all-zero degraded board must render UNKNOWN on /work, never a
      // confident zero. Separate field — `degraded`'s existing consumer
      // (collect-state.sh) stays byte-for-byte untouched.
      sourcesOk: !degraded,
      generatedAt: new Date(nowMs).toISOString(),
    };
    return res.json(body);
  });

  // -------------------------------------------------------------------------
  // Issue-lifecycle actions (issue #4010, ADR-0034 §7)
  // -------------------------------------------------------------------------
  //
  // Four POST routes carrying the /work page's action POLICY server-side, so
  // it cannot drift client-side: the confirm-tier promote (a dispatch trigger
  // in disguise) with its two guard refusals, and the three immediate-tier
  // actions. Every action re-reads the issue's ACTUAL post-write state before
  // reporting success (design-concept invariant 6) — a write whose read-back
  // disagrees is reported as a verification-mismatch, never as success.

  const actions =
    deps.issueActions ??
    ({
      addLabel: (issue: number, label: string) => addIssueLabel(issue, label),
      removeLabel: (issue: number, label: string) => removeIssueLabel(issue, label),
      close: (issue: number) => closeIssue(issue),
      reopen: (issue: number) => reopenIssue(issue),
      view: (issue: number) => viewIssueState(issue),
    } as NonNullable<AutopilotBoardRouterDeps["issueActions"]>);

  /**
   * Project a verification snapshot onto the response's issue shape — drops
   * the (large) `body` the guard reads need but the HTTP contract
   * (BoardIssueStateSchema, `.strict()`) deliberately does not carry.
   */
  const toBoardIssueState = (s: {
    number: number;
    title: string;
    url: string;
    labels: string[];
    state: string;
    body: string;
  }) => ({
    number: s.number,
    title: s.title,
    url: s.url,
    labels: s.labels,
    state: s.state,
  });

  /** Refusal helper: 200 + ok:false + the specific reason (the verified "no"). */
  const refused = (
    res: any,
    body: Extract<BoardActionResponse, { ok: false }>,
  ) => res.status(200).json(body);

  /** Read-back failure helper: 502 — the action is UNVERIFIED, not failed-closed. */
  const unverified = (res: any, action: string, read: { code: string; stderr: string }) => {
    logger.error(
      { action, code: read.code, stderr: read.stderr.slice(0, 300) },
      "[autopilot/board-state] action read-back failed — result unverified",
    );
    return res.status(502).json({
      code: "github-read-failed",
      action,
      detail: { code: read.code, stderr: read.stderr },
    });
  };

  /** Write failure helper: 502 — the gh write itself failed. */
  const writeFailed = (res: any, action: string, write: { code: string; stderr: string }) => {
    logger.error(
      { action, code: write.code, stderr: write.stderr.slice(0, 300) },
      "[autopilot/board-state] action write failed",
    );
    return res.status(502).json({
      code: "github-write-failed",
      action,
      detail: { code: write.code, stderr: write.stderr },
    });
  };

  // POST /autopilot/board-state/promote — confirm-tier (ADR-0034 §7).
  router.post("/autopilot/board-state/promote", async (req, res) => {
    const parsed = PromoteActionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue, confirm } = parsed.data;

    // Guard 0 — the confirm step. The UI shows an explicit confirm dialog;
    // the route independently refuses without it so the guard holds even for
    // a client that skips the dialog.
    if (confirm !== true) {
      return res.status(400).json({
        code: "promote-confirm-required",
        reason:
          "promoting to ready-for-agent is a dispatch trigger in disguise — re-send with confirm:true after the operator confirms (ADR-0034 §7)",
      });
    }

    // Pre-write guard read: the issue's actual body + labels.
    const before = await actions.view(issue);
    if (isIssueStateFailure(before)) {
      return unverified(res, "promote", before);
    }
    const snapshot = before.data;
    const generatedAt = new Date(clock()).toISOString();

    // Guard 1 — a blocked issue must never be promoted. Two spellings of
    // "blocked": the manual `blocked` label, and an OPEN strict blocker
    // cited in the body. The blocker resolve reuses the SAME resolver the
    // ready_for_agent count filters through (`resolveOpenBlockers`, issue
    // #3059) — which only resolves rows carrying `ready-for-agent`, i.e.
    // rows that could count toward the dispatch pool — so the candidate is
    // handed to it AS-IF promoted: the exact state the promote would create.
    if (snapshot.labels.includes(ORCH_BOARD_LABELS.blocked)) {
      return refused(res, {
        ok: false,
        action: "promote",
        code: "promote-blocked-issue",
        reason: `#${issue} carries the 'blocked' label — clear the blocker before promoting`,
        issue: toBoardIssueState(snapshot),
        generatedAt,
      });
    }
    const asIfPromoted: IssueRow[] = [
      {
        number: snapshot.number,
        title: snapshot.title,
        url: snapshot.url,
        createdAt: "",
        labels: Array.from(
          new Set([...snapshot.labels, ORCH_BOARD_LABELS.ready_for_agent]),
        ),
        body: snapshot.body,
        state: snapshot.state,
      },
    ];
    // Same injectable resolver the GET uses (default: the shared
    // resolveOpenBlockers with no repo override and no glm skip — a promote
    // candidate's blockers resolve regardless of its glm eligibility).
    const resolveBlockers =
      deps.resolveOpenBlockers ?? ((rows: readonly IssueRow[]) => resolveOpenBlockers(rows));
    const openBlockers = await resolveBlockers(asIfPromoted);
    if (openBlockers.size > 0) {
      return refused(res, {
        ok: false,
        action: "promote",
        code: "promote-blocked-issue",
        reason: `#${issue} is blocked by open issue(s) ${[...openBlockers].sort((a, b) => a - b).join(", ")} — promoting would dispatch onto an unmerged blocker`,
        blockers: [...openBlockers].sort((a, b) => a - b),
        issue: toBoardIssueState(snapshot),
        generatedAt,
      });
    }

    // Guard 2 — an issue lacking a '## Files in scope' section. The
    // issue-label-validation workflow REVERTS a ready-for-agent label added
    // to such an issue, so promoting it produces churn, not a dispatchable
    // anchor. Checked via the ONE existing parser (extractScopeFromBody),
    // never a re-implemented regex.
    if (extractScopeFromBody(snapshot.body).length === 0) {
      return refused(res, {
        ok: false,
        action: "promote",
        code: "promote-missing-scope",
        reason: `#${issue} has no '## Files in scope' section — issue-label-validation would revert the label; add the section first`,
        issue: toBoardIssueState(snapshot),
        generatedAt,
      });
    }

    // Write — the existing, already-proven label-add primitive (issue #3755).
    const write = await actions.addLabel(issue, ORCH_BOARD_LABELS.ready_for_agent);
    if (isIssueLabelWriteFailure(write)) {
      return writeFailed(res, "promote", write);
    }

    // Verified read-back (design-concept invariant 6): report ONLY the state
    // the re-read confirms.
    const after = await actions.view(issue);
    if (isIssueStateFailure(after)) {
      return unverified(res, "promote", after);
    }
    if (!after.data.labels.includes(ORCH_BOARD_LABELS.ready_for_agent)) {
      return refused(res, {
        ok: false,
        action: "promote",
        code: "verification-mismatch",
        reason: `write reported success but #${issue} still lacks 'ready-for-agent' on re-read — NOT promoted`,
        issue: toBoardIssueState(after.data),
        generatedAt: new Date(clock()).toISOString(),
      });
    }
    return res.status(200).json({
      ok: true,
      action: "promote",
      issue: toBoardIssueState(after.data),
      generatedAt: new Date(clock()).toISOString(),
    });
  });

  // POST /autopilot/board-state/relabel — immediate-tier (ADR-0034 §7).
  router.post("/autopilot/board-state/relabel", async (req, res) => {
    const parsed = RelabelActionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue, addLabel, removeLabels } = parsed.data;

    for (const label of removeLabels) {
      const remove = await actions.removeLabel(issue, label);
      if (remove.ok === false) {
        return writeFailed(res, "relabel", remove);
      }
    }
    const write = await actions.addLabel(issue, addLabel);
    if (isIssueLabelWriteFailure(write)) {
      return writeFailed(res, "relabel", write);
    }

    const after = await actions.view(issue);
    if (isIssueStateFailure(after)) {
      return unverified(res, "relabel", after);
    }
    if (!after.data.labels.includes(addLabel)) {
      return refused(res, {
        ok: false,
        action: "relabel",
        code: "verification-mismatch",
        reason: `write reported success but #${issue} still lacks '${addLabel}' on re-read — relabel NOT confirmed`,
        issue: toBoardIssueState(after.data),
        generatedAt: new Date(clock()).toISOString(),
      });
    }
    return res.status(200).json({
      ok: true,
      action: "relabel",
      issue: toBoardIssueState(after.data),
      generatedAt: new Date(clock()).toISOString(),
    });
  });

  // POST /autopilot/board-state/close — immediate-tier (ADR-0034 §7).
  router.post("/autopilot/board-state/close", async (req, res) => {
    const parsed = IssueStateActionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue } = parsed.data;

    const write = await actions.close(issue);
    if (write.ok === false) {
      return writeFailed(res, "close", write);
    }

    const after = await actions.view(issue);
    if (isIssueStateFailure(after)) {
      return unverified(res, "close", after);
    }
    if (after.data.state !== "CLOSED") {
      return refused(res, {
        ok: false,
        action: "close",
        code: "verification-mismatch",
        reason: `write reported success but #${issue} reads '${after.data.state}' on re-read — close NOT confirmed`,
        issue: toBoardIssueState(after.data),
        generatedAt: new Date(clock()).toISOString(),
      });
    }
    return res.status(200).json({
      ok: true,
      action: "close",
      issue: toBoardIssueState(after.data),
      generatedAt: new Date(clock()).toISOString(),
    });
  });

  // POST /autopilot/board-state/reopen — immediate-tier (ADR-0034 §7).
  router.post("/autopilot/board-state/reopen", async (req, res) => {
    const parsed = IssueStateActionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue } = parsed.data;

    const write = await actions.reopen(issue);
    if (write.ok === false) {
      return writeFailed(res, "reopen", write);
    }

    const after = await actions.view(issue);
    if (isIssueStateFailure(after)) {
      return unverified(res, "reopen", after);
    }
    if (after.data.state !== "OPEN") {
      return refused(res, {
        ok: false,
        action: "reopen",
        code: "verification-mismatch",
        reason: `write reported success but #${issue} reads '${after.data.state}' on re-read — reopen NOT confirmed`,
        issue: toBoardIssueState(after.data),
        generatedAt: new Date(clock()).toISOString(),
      });
    }
    return res.status(200).json({
      ok: true,
      action: "reopen",
      issue: toBoardIssueState(after.data),
      generatedAt: new Date(clock()).toISOString(),
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Ready-for-agent queue derivation (issue #4010)
// ---------------------------------------------------------------------------

/**
 * Derive the ready-for-agent queue — the rows that count toward
 * `ready_for_agent` under the pure projection's exclusion rules
 * (`target-backlog`, live-`glm-eligible`, open strict blockers).
 *
 * The filter itself is NOT re-implemented here: each row is run through the
 * canonical {@link deriveBoardState} projection INDIVIDUALLY, so a row is in
 * the queue exactly when it alone increments the count. The filter policy
 * stays in exactly one place (`src/autopilot/board-state.ts`); a future rule
 * added there flows into both the count and this queue with zero drift.
 * Pure, O(rows) over a board of dozens.
 */
function deriveReadyQueue(
  rows: readonly IssueRow[],
  nowMs: number,
  openBlockers: ReadonlySet<number>,
  glmPartitionActive: boolean,
): ReadyQueueEntry[] {
  const queue: ReadyQueueEntry[] = [];
  for (const row of rows) {
    const counts = deriveBoardState([row], nowMs, openBlockers, glmPartitionActive);
    if (counts.ready_for_agent > 0) {
      queue.push({
        number: row.number,
        title: row.title,
        url: row.url,
        labels: row.labels,
      });
    }
  }
  return queue;
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
