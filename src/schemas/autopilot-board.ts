/**
 * Schemas for the autopilot board-state endpoints (issues #934, #4010).
 *
 * One read endpoint plus the four /work issue-lifecycle action endpoints:
 *
 *   GET  /api/autopilot/board-state          → AutopilotBoardStateResponse
 *   POST /api/autopilot/board-state/promote  → BoardActionResponse
 *   POST /api/autopilot/board-state/relabel  → BoardActionResponse
 *   POST /api/autopilot/board-state/close    → BoardActionResponse
 *   POST /api/autopilot/board-state/reopen   → BoardActionResponse
 *
 * # Why this exists
 *
 * `scripts/autopilot/collect-state.sh` (Phase 1 of /hydra-autopilot) assembles
 * the brain's per-turn decision input. Historically it issued a direct
 * `gh issue list --repo gaberoo322/hydra --json number,labels,updatedAt --jq …`
 * call and re-spelled, in bash, the three things the **GitHub Issue/PR Read**
 * seam (`src/github/issues.ts`, issue #908) already owns:
 *
 *   - the repo handle (`gaberoo322/hydra`),
 *   - the canonical `--json` field set, and
 *   - the orchestrator label vocabulary (`needs-qa`, `ready-for-agent`, …).
 *
 * When the label vocabulary or repo handle changes behind the seam, the bash
 * copy silently keeps reading the old shape — the exact cross-boundary drift
 * the seam exists to prevent (issue #934). This endpoint serves the board-count
 * + stale-list projection *on top of* the read seam, so `collect-state.sh`
 * stops re-deriving `gh` shapes and reads one surface instead.
 *
 * The label literals counted here are the orchestrator's triage/dispatch
 * vocabulary (see `docs/agents/triage-labels.md`), not the Dispatch-Class
 * Taxonomy Module's provenance vocabulary (`PROVENANCE_LABELS` in
 * `src/taxonomy/classes.ts`); they live in `ORCH_BOARD_LABELS`
 * in `src/board-labels.ts`, the single place a bash copy used to mirror.
 *
 * Schema discipline mirrors `src/schemas/autopilot-idle.ts` (ADR-0011):
 * `.strict()` objects, `z.infer<>` for canonical types, a
 * `schema-validation-failed` error envelope at the route boundary.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * The repo the board-state read projects: `orch` = the Orchestrator's own repo
 * (`gaberoo322/hydra`), `target` = the Target repo (`gaberoo322/hydra-betting`)
 * per ADR-0031. Exported so the endpoint and its tests share one spelling.
 */
export const BOARD_STATE_SCOPES = ["orch", "target"] as const;
export type BoardStateScope = (typeof BOARD_STATE_SCOPES)[number];

/**
 * Query schema for `GET /api/autopilot/board-state`. `.strict()` rejects
 * unexpected query keys so a typo surfaces as a 400 rather than being silently
 * ignored, mirroring the request-validation contract of the idle-diagnostics
 * endpoint.
 *
 * The single meaningful parameter is an OPTIONAL `scope` (`orch` | `target`,
 * ADR-0031 Decision 3). It defaults to `orch` so every existing scope-less
 * caller (`collect-state.sh`, current tests) keeps today's exact behavior; the
 * endpoint injects the Target repo handle into the read seam only when
 * `scope=target`, reusing the pure `deriveBoardState` byte-for-byte unchanged.
 */
export const AutopilotBoardStateQuerySchema = z
  .object({
    scope: z.enum(BOARD_STATE_SCOPES).default("orch"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * One row of the ready-for-agent queue: the identity + labels the /work page
 * needs to render the queue and its row actions. Deliberately carries NO
 * `body` (issue bodies are large; every body-derived decision runs
 * server-side in the action routes).
 */
const ReadyQueueEntrySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    labels: z.array(z.string()),
  })
  .strict();

export type ReadyQueueEntry = z.infer<typeof ReadyQueueEntrySchema>;

/**
 * The orchestrator issue-board projection the autopilot brain consumes each
 * turn. The count fields and the two stale-number lists are a 1:1 mirror of the
 * JSON `collect-state.sh` used to shape inline with `--jq`; preserving the
 * field names keeps the playbook's `state.json` stitching unchanged.
 *
 * `*` count fields are non-negative integers. `stale_*` are issue-number lists
 * (the issues whose label has gone stale past its window — see the windows in
 * `src/board-labels.ts`).
 */
export const AutopilotBoardStateResponseSchema = z
  .object({
    /** Open issues carrying `needs-qa`. */
    needs_qa: z.number().int().nonnegative(),
    /** Open issues carrying `ready-for-agent` — the `dev_orch` dispatch signal. */
    ready_for_agent: z.number().int().nonnegative(),
    /** Open issues carrying `needs-triage`. */
    needs_triage: z.number().int().nonnegative(),
    /** Open issues carrying `needs-research`. */
    needs_research: z.number().int().nonnegative(),
    /** Open issues carrying `in-progress`. */
    in_progress: z.number().int().nonnegative(),
    /** Open issues carrying `blocked`. */
    blocked: z.number().int().nonnegative(),
    /** `in-progress` issues not updated within the stale window (numbers). */
    stale_in_progress: z.array(z.number().int().positive()),
    /** `blocked` issues not updated within the stale window (numbers). */
    stale_blocked: z.array(z.number().int().positive()),
    /**
     * `true` when the GitHub-Read seam could not reach `gh` and the counts are
     * the all-zero safe default. The collector treats a degraded response as
     * "fall back to the inline call" so a transient outage never wedges the
     * turn; the autopilot turn can also see the degradation explicitly.
     */
    degraded: z.boolean(),
    /**
     * The ADR-0034 §5 asserted-cleanliness signal (issue #4010, additive):
     * `!degraded`. An all-zero board from an unreachable `gh` must render as
     * UNKNOWN on /work, never as a confident zero — `usePageItems` keys its
     * unknown status off exactly this field. Kept as a SEPARATE field rather
     * than a replacement so `collect-state.sh`'s existing `degraded` consumer
     * is byte-for-byte untouched (design-concept invariant 3).
     */
    sourcesOk: z.boolean(),
    /**
     * The dispatchable ready-for-agent pool as issue rows (issue #4010): the
     * rows that count toward `ready_for_agent` above — i.e. after the
     * `target-backlog` / live-`glm-eligible` / open-strict-blocker exclusions
     * the pure projection applies. The /work page renders this as the
     * ready-for-agent queue. Empty when degraded.
     */
    ready_for_agent_queue: z.array(ReadyQueueEntrySchema),
    /** ISO timestamp the projection was assembled. */
    generatedAt: z.string(),
  })
  .strict();

export type AutopilotBoardStateResponse = z.infer<
  typeof AutopilotBoardStateResponseSchema
>;

// ---------------------------------------------------------------------------
// Issue-lifecycle action endpoints (issue #4010, ADR-0034 §7)
// ---------------------------------------------------------------------------

/**
 * The lane labels a /work action may write. The orchestrator's triage +
 * board vocabulary (docs/agents/triage-labels.md + `src/board-labels.ts`) —
 * restricting writes to this closed list keeps an arbitrary string out of
 * the `gh issue edit` argv and out of the board.
 */
export const ACTIONABLE_LABELS = [
  "needs-triage",
  "needs-info",
  "needs-research",
  "needs-qa",
  "ready-for-agent",
  "ready-for-human",
  "in-progress",
  "blocked",
  "wontfix",
  "target-backlog",
] as const;
export type ActionableLabel = (typeof ACTIONABLE_LABELS)[number];

/** Body for `POST /autopilot/board-state/promote` (issue #4010). */
export const PromoteActionBodySchema = z
  .object({
    /** The issue to promote to `ready-for-agent`. */
    issue: z.number().int().positive(),
    /**
     * MUST be `true`. Promoting to ready-for-agent is a dispatch trigger in
     * disguise (ADR-0034 §7) — the UI shows an explicit confirm step and the
     * route independently refuses a request without it (HTTP 400
     * `promote-confirm-required`), so the guard holds even if a client skips
     * the dialog. A bare boolean rather than `z.literal(true)` so the missing
     * / false case is separable from generic schema garbage.
     */
    confirm: z.boolean(),
  })
  .strict();

export type PromoteActionBody = z.infer<typeof PromoteActionBodySchema>;

/** Body for `POST /autopilot/board-state/relabel` (issue #4010). */
export const RelabelActionBodySchema = z
  .object({
    /** The issue to relabel. */
    issue: z.number().int().positive(),
    /** The lane label to add. */
    addLabel: z.enum(ACTIONABLE_LABELS),
    /** Lane labels to remove first (the lane being moved away from). */
    removeLabels: z.array(z.enum(ACTIONABLE_LABELS)).default([]),
  })
  .strict();

export type RelabelActionBody = z.infer<typeof RelabelActionBodySchema>;

/** Body for `POST /autopilot/board-state/close` and `.../reopen`. */
export const IssueStateActionBodySchema = z
  .object({
    /** The issue to close / reopen. */
    issue: z.number().int().positive(),
  })
  .strict();

export type IssueStateActionBody = z.infer<typeof IssueStateActionBodySchema>;

/**
 * The post-write issue snapshot every verified action response carries — the
 * re-read ACTUAL state (design-concept invariant 6), never a projection of
 * what the write should have achieved.
 */
const BoardIssueStateSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    labels: z.array(z.string()),
    state: z.string(),
  })
  .strict();

/** The four /work actions (ADR-0034 §7's confirm-tier vs immediate-tier). */
export const BOARD_ACTIONS = ["promote", "relabel", "close", "reopen"] as const;
export type BoardAction = (typeof BOARD_ACTIONS)[number];

/**
 * Machine-readable refusal / failure codes an action response can carry.
 * `promote-blocked-issue` and `promote-missing-scope` are the two guard
 * refusals (ADR-0034 §7); `verification-mismatch` is a write that claimed
 * success but whose read-back disagreed — reported, never papered over.
 */
export const BOARD_ACTION_REFUSAL_CODES = [
  "promote-blocked-issue",
  "promote-missing-scope",
  "verification-mismatch",
] as const;

/**
 * Response for all four action endpoints: a discriminated union on `ok`.
 * Success carries the verified post-write snapshot; refusal carries a
 * machine-readable `code` plus the operator-readable `reason` (the specific
 * refusal grounds surfaced in the UI).
 */
export const BoardActionResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      action: z.enum(BOARD_ACTIONS),
      issue: BoardIssueStateSchema,
      generatedAt: z.string(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      action: z.enum(BOARD_ACTIONS),
      code: z.enum(BOARD_ACTION_REFUSAL_CODES),
      reason: z.string(),
      /** Open blocker issue numbers, when the refusal is `promote-blocked-issue`. */
      blockers: z.array(z.number().int().positive()).optional(),
      issue: BoardIssueStateSchema.optional(),
      generatedAt: z.string(),
    })
    .strict(),
]);

export type BoardActionResponse = z.infer<typeof BoardActionResponseSchema>;
