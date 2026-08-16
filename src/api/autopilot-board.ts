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
  BoardPromoteActionSchema,
  BoardRelabelActionSchema,
  BoardIssueRefSchema,
  WORK_QUEUE_LANES,
  RELABEL_TARGETS,
  type AutopilotBoardStateResponse,
  type BoardStateScope,
  type BoardActionResponse,
  type BoardActionReason,
  type WorkQueueRow,
  type WorkQueueLane,
  type RelabelTarget,
} from "../schemas/autopilot-board.ts";
import {
  listOpenIssues,
  addIssueLabel,
  ISSUE_JSON_FIELDS,
  type IssueRow,
  type IssueReadResult,
  type IssueLabelWriteResult,
} from "../github/issues.ts";
import {
  removeIssueLabel,
  closeIssue,
  reopenIssue,
  viewIssue,
  type IssueViewResult,
  type IssueActionWriteResult,
} from "../github/issue-actions.ts";
import { extractStrictBlockerRefs } from "../github/blockers.ts";
import { hasScopeSection } from "../scope-section.ts";
import { getTargetGithubRepo } from "../target-config.ts";
import {
  deriveBoardState,
  resolveOpenBlockers,
} from "../autopilot/board-state.ts";
import { getGlmDrainerLiveness } from "../redis/autopilot.ts";
import { schemaValidationError } from "./route-helpers.ts";
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
  };
}

// ---------------------------------------------------------------------------
// Pure /work projections (issue #4010) — exported for tests
// ---------------------------------------------------------------------------

/**
 * Resolve an issue's operator lane from its labels: the FIRST
 * {@link WORK_QUEUE_LANES} entry present (the order encodes precedence —
 * `ready-for-agent` outranks a stray `needs-triage` because the dispatch
 * signal is the stronger claim). Null when the issue carries no operator lane
 * (agent-owned `in-progress`/`needs-qa`, classification-only labels, …).
 */
export function deriveWorkLane(labels: readonly string[]): WorkQueueLane | null {
  for (const lane of WORK_QUEUE_LANES) {
    if (labels.includes(lane)) return lane;
  }
  return null;
}

/**
 * Project one open {@link IssueRow} into a {@link WorkQueueRow}, or null when
 * it carries no operator lane. `openBlockers` is the endpoint-resolved OPEN
 * strict-blocker set (only meaningful for `ready-for-agent` rows — the same
 * population `resolveOpenBlockers` resolves); per-row numbers are this row's
 * strict refs intersected with that set, self-references excluded.
 */
export function toWorkQueueRow(
  row: IssueRow,
  openBlockers: ReadonlySet<number>,
): WorkQueueRow | null {
  const lane = deriveWorkLane(row.labels);
  if (lane === null) return null;
  const rowBlockers =
    lane === "ready-for-agent" && openBlockers.size > 0
      ? extractStrictBlockerRefs(row.body).filter(
          (n) => n !== row.number && openBlockers.has(n),
        )
      : [];
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    labels: row.labels,
    lane,
    updatedAt: row.updatedAt ?? "",
    openBlockers: rowBlockers,
    glmEligible: row.labels.includes("glm-eligible"),
  };
}

/**
 * Queue ordering: by lane in {@link WORK_QUEUE_LANES} order (the
 * ready-for-agent queue first), then oldest-updated first within a lane.
 */
export function compareWorkQueueRows(a: WorkQueueRow, b: WorkQueueRow): number {
  const laneDelta =
    WORK_QUEUE_LANES.indexOf(a.lane) - WORK_QUEUE_LANES.indexOf(b.lane);
  if (laneDelta !== 0) return laneDelta;
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  // Unparseable timestamps sort LAST (never ahead of a dated row).
  const na = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const nb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  return na - nb;
}

/** Refusal outcome of {@link evaluatePromoteEligibility}. */
export type PromoteEligibility =
  | { eligible: true }
  | { eligible: false; reason: BoardActionReason; detail: string };

/**
 * The promote-to-ready-for-agent gate (ADR-0034 §7's traps, issue #4010):
 *
 *   1. the issue is CLOSED                → refuse (`closed`);
 *   2. it already carries ready-for-agent → refuse (`already-ready`);
 *   3. its body lacks a `## Files in scope` section
 *      (via the ONE shared parser, `hasScopeSection`/`extractScopeFromBody`)
 *                                         → refuse (`missing-scope-section` —
 *                                           applying the label anyway is what
 *                                           issue-label-validation reverts);
 *   4. it cites an OPEN strict blocker     → refuse (`blocked`).
 *
 * Pure: `openBlockers` is pre-resolved by the caller so this stays
 * decision-table testable.
 */
export function evaluatePromoteEligibility(
  row: IssueRow,
  openBlockers: ReadonlySet<number>,
): PromoteEligibility {
  if (row.state === "CLOSED") {
    return {
      eligible: false,
      reason: "closed",
      detail: "issue is closed — reopen it before promoting",
    };
  }
  if (row.labels.includes("ready-for-agent")) {
    return {
      eligible: false,
      reason: "already-ready",
      detail: "issue already carries ready-for-agent",
    };
  }
  if (!hasScopeSection(row.body)) {
    return {
      eligible: false,
      reason: "missing-scope-section",
      detail:
        "issue body has no ## Files in scope section — issue-label-validation would revert ready-for-agent (#396)",
    };
  }
  const openRefs = extractStrictBlockerRefs(row.body).filter(
    (n) => n !== row.number && openBlockers.has(n),
  );
  if (openRefs.length > 0) {
    return {
      eligible: false,
      reason: "blocked",
      detail: `blocked by open issue${openRefs.length > 1 ? "s" : ""} #${openRefs.join(", #")}`,
    };
  }
  return { eligible: true };
}

/** The label transitions a relabel performs: lanes to drop + whether to add. */
export function computeRelabelTransitions(
  currentLabels: readonly string[],
  target: RelabelTarget,
): { remove: string[]; add: boolean } {
  const remove = RELABEL_TARGETS.filter(
    (lane) => lane !== target && currentLabels.includes(lane),
  );
  return { remove, add: !currentLabels.includes(target) };
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
  // ---- Issue-lifecycle action seams (issue #4010, ADR-0034 §7) ------------
  // Every default is the real GitHub seam; injectable so tests drive the
  // refusal / verification matrix without a live `gh`.
  /** Single-issue re-read — the verify-after-write read (default `viewIssue`). */
  view?: (issueNumber: number) => Promise<IssueViewResult>;
  /** Add-one-label write (default `addIssueLabel` — issues.ts's ONE surface). */
  addLabel?: (
    issueNumber: number,
    label: string,
  ) => Promise<IssueLabelWriteResult>;
  /** Remove-one-label write (default the issue-actions leaf). */
  removeLabel?: (
    issueNumber: number,
    label: string,
  ) => Promise<IssueActionWriteResult>;
  /** Close write (default the issue-actions leaf). */
  close?: (issueNumber: number) => Promise<IssueActionWriteResult>;
  /** Reopen write (default the issue-actions leaf). */
  reopen?: (issueNumber: number) => Promise<IssueActionWriteResult>;
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
        counts = deriveBoardState(
          result.rows,
          nowMs,
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
      // Trust seam (#4010, INV: additive sourcesOk): the asserted-cleanly flag
      // derivePageStatus reads. `degraded` keeps its exact legacy shape and
      // consumer (collect-state.sh) — this field is purely additive.
      sourcesOk: !degraded,
      generatedAt: new Date(nowMs).toISOString(),
    };
    return res.json(body);
  });

  // ---- The /work queue read (issue #4010) --------------------------------
  //
  // One `listOpenIssues` fetch (the same seam read the board-state projection
  // rides), projected into operator-lane rows. Trust contract: `sourcesOk`
  // false on a degraded read so an unasserted empty queue renders UNKNOWN,
  // `scanned` as the the-lookup-ran evidence, `items` for usePageItems.
  // Orch-scope only (the /work page is the orchestrator board; the Target
  // board is a separate lane, ADR-0031 Decision 3).
  router.get("/autopilot/work-queue", async (_req, res) => {
    const nowMs = clock();
    const readQueueIssues =
      deps.readOpenIssues ?? (() => defaultReadOpenIssues());
    const glmQueueLiveness =
      deps.glmDrainerLiveness ??
      ((ms: number) => getGlmDrainerLiveness(ms).then((l) => l.live));
    let items: WorkQueueRow[] = [];
    let scanned = 0;
    let sourcesOk = true;

    try {
      const result = await readQueueIssues();
      if (result.ok === false) {
        sourcesOk = false;
        logger.error(
          { code: result.code },
          "[autopilot/work-queue] gh issue list failed — degraded empty queue",
        );
      } else {
        scanned = result.rows.length;
        let glmPartitionActive = false;
        try {
          glmPartitionActive = await glmQueueLiveness(nowMs);
        } catch (err: any) {
          logger.error(
            { err },
            "[autopilot/work-queue] glm drainer liveness read threw — partition inactive (fail-open, #3754)",
          );
          glmPartitionActive = false;
        }
        const resolveBlockers =
          deps.resolveOpenBlockers ??
          ((rows: readonly IssueRow[]) =>
            resolveOpenBlockers(rows, undefined, glmPartitionActive));
        const openBlockers = await resolveBlockers(result.rows);
        items = result.rows
          .map((row) => toWorkQueueRow(row, openBlockers))
          .filter((row): row is WorkQueueRow => row !== null)
          .sort(compareWorkQueueRows);
      }
    } catch (err: any) {
      sourcesOk = false;
      logger.error(
        { err },
        "[autopilot/work-queue] open-issue read threw despite never-throw seam",
      );
    }

    return res.json({
      items,
      scanned,
      sourcesOk,
      generatedAt: new Date(nowMs).toISOString(),
    });
  });

  // ---- The issue-lifecycle actions (issue #4010, ADR-0034 §7) -------------
  //
  // Shared write spine: ONE pre-read → action-specific gate → writes →
  // RE-READ → report the OBSERVED post-state. A write whose verification read
  // fails, or whose observed state does not match, reports `write-unverified`
  // — never success. Every content outcome (refusal included) is a 200 result
  // object (never-throw); only a malformed body is a 400
  // schema-validation-failed.
  const view = deps.view ?? ((n: number) => viewIssue(n));
  const addLabel =
    deps.addLabel ?? ((n: number, label: string) => addIssueLabel(n, label));
  const removeLabel =
    deps.removeLabel ??
    ((n: number, label: string) => removeIssueLabel(n, label));
  const closeWrite = deps.close ?? ((n: number) => closeIssue(n));
  const reopenWrite = deps.reopen ?? ((n: number) => reopenIssue(n));

  function actionResponse(
    action: BoardActionResponse["action"],
    issue: number,
    fields: Partial<BoardActionResponse>,
  ): BoardActionResponse {
    return {
      ok: false,
      action,
      issue,
      generatedAt: new Date(clock()).toISOString(),
      ...fields,
    } as BoardActionResponse;
  }

  /** A gate outcome: a full refusal response, or the writes to perform. */
  type ActionGate =
    | { refuse: BoardActionResponse }
    | { writes: Array<() => Promise<{ ok: boolean; code?: string; stderr?: string }>> };

  /**
   * Run one action through the verify spine. `gate` receives the freshly read
   * pre-state row and either refuses (returning the full response — its
   * reason/detail surface verbatim) or returns the write thunks to perform.
   */
  async function runVerifiedAction(opts: {
    action: BoardActionResponse["action"];
    issue: number;
    gate: (row: IssueRow) => Promise<ActionGate>;
    verify: (post: IssueRow) => boolean;
    verifyMissDetail: (post: IssueRow) => string;
  }): Promise<BoardActionResponse> {
    const viewed = await view(opts.issue);
    if (viewed.ok === false) {
      return actionResponse(opts.action, opts.issue, {
        reason: "read-failed",
        detail: `pre-write re-read failed (${viewed.code}) — no write attempted`,
      });
    }
    const gate = await opts.gate(viewed.row);
    if ("refuse" in gate) return gate.refuse;
    for (const write of gate.writes) {
      const writeRes = await write();
      if (writeRes.ok === false) {
        logger.error(
          { action: opts.action, issue: opts.issue, code: writeRes.code },
          "[autopilot/board-action] write failed",
        );
        return actionResponse(opts.action, opts.issue, {
          reason: "write-failed",
          detail: `gh write failed (${writeRes.code ?? "gh-failed"}${writeRes.stderr ? `: ${writeRes.stderr.slice(0, 200)}` : ""})`,
        });
      }
    }
    // ADR-0034 §7: no action renders success it has not verified — the
    // follow-up re-read is mandatory, and its observed state is the result.
    const post = await view(opts.issue);
    if (post.ok === false) {
      return actionResponse(opts.action, opts.issue, {
        reason: "write-unverified",
        detail: `write accepted but post-write re-read failed (${post.code}) — state unconfirmed`,
      });
    }
    if (!opts.verify(post.row)) {
      return actionResponse(opts.action, opts.issue, {
        reason: "write-unverified",
        detail: opts.verifyMissDetail(post.row),
      });
    }
    return actionResponse(opts.action, opts.issue, {
      ok: true,
      verified: { state: post.row.state, labels: post.row.labels },
    });
  }

  // POST /autopilot/board/promote — confirm-gated (ADR-0034 §7: a promote is a
  // dispatch trigger in disguise). Refusals surface their specific reason.
  router.post("/autopilot/board/promote", async (req, res) => {
    const parsed = BoardPromoteActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue } = parsed.data;

    const result = await runVerifiedAction({
      action: "promote",
      issue,
      gate: async (row) => {
        // Resolve the issue's OPEN strict blockers via the existing
        // resolveOpenBlockers, applied to the row AS IT WOULD BE post-promote
        // (the resolver only resolves rows that can count toward
        // ready_for_agent — the promoted row is exactly that row). glm
        // partition stays inactive here: resolve liberally, never skip.
        const resolveBlockers =
          deps.resolveOpenBlockers ??
          ((rows: readonly IssueRow[]) => resolveOpenBlockers(rows));
        const prospectiveRow: IssueRow = {
          ...row,
          labels: [...row.labels, "ready-for-agent"],
        };
        const openBlockers = await resolveBlockers([prospectiveRow]);
        const eligibility = evaluatePromoteEligibility(row, openBlockers);
        // `=== false`, not `!eligible`: tsconfig runs strict:false, where a
        // truthiness check does not narrow the discriminated union (same
        // reason issues.ts carries isIssueLabelWriteFailure).
        if (eligibility.eligible === false) {
          return {
            refuse: actionResponse("promote", issue, {
              reason: eligibility.reason,
              detail: eligibility.detail,
            }),
          };
        }
        // The add side rides issues.ts's ONE proven write surface.
        return { writes: [() => addLabel(issue, "ready-for-agent")] };
      },
      verify: (post) => post.labels.includes("ready-for-agent"),
      verifyMissDetail: (post) =>
        `post-write state lacks ready-for-agent (labels: ${post.labels.join(", ") || "none"})`,
    });
    return res.json(result);
  });

  // POST /autopilot/board/relabel — immediate-tier (no confirm, ADR-0034 §7).
  // Lane move: drop the other relabel-lane labels, add the target.
  router.post("/autopilot/board/relabel", async (req, res) => {
    const parsed = BoardRelabelActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue, label } = parsed.data;

    const result = await runVerifiedAction({
      action: "relabel",
      issue,
      gate: async (row) => {
        if (row.state === "CLOSED") {
          return {
            refuse: actionResponse("relabel", issue, {
              reason: "closed",
              detail: "issue is closed — reopen it before relabelling",
            }),
          };
        }
        const transitions = computeRelabelTransitions(row.labels, label);
        return {
          writes: [
            ...transitions.remove.map(
              (lane) => () => removeLabel(issue, lane),
            ),
            ...(transitions.add ? [() => addLabel(issue, label)] : []),
          ],
        };
      },
      verify: (post) =>
        post.labels.includes(label) &&
        computeRelabelTransitions(post.labels, label).remove.length === 0,
      verifyMissDetail: (post) =>
        `post-write labels do not resolve to lane "${label}" (labels: ${post.labels.join(", ") || "none"})`,
    });
    return res.json(result);
  });

  // POST /autopilot/board/close — immediate-tier.
  router.post("/autopilot/board/close", async (req, res) => {
    const parsed = BoardIssueRefSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue } = parsed.data;
    const result = await runVerifiedAction({
      action: "close",
      issue,
      gate: async () => ({ writes: [() => closeWrite(issue)] }),
      verify: (post) => post.state === "CLOSED",
      verifyMissDetail: (post) =>
        `post-write state is ${post.state || "(unset)"} — close unconfirmed`,
    });
    return res.json(result);
  });

  // POST /autopilot/board/reopen — immediate-tier.
  router.post("/autopilot/board/reopen", async (req, res) => {
    const parsed = BoardIssueRefSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    const { issue } = parsed.data;
    const result = await runVerifiedAction({
      action: "reopen",
      issue,
      gate: async () => ({ writes: [() => reopenWrite(issue)] }),
      verify: (post) => post.state === "OPEN",
      verifyMissDetail: (post) =>
        `post-write state is ${post.state || "(unset)"} — reopen unconfirmed`,
    });
    return res.json(result);
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
