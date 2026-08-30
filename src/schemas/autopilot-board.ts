/**
 * Schemas for the autopilot board endpoints (issue #934; extended #4010).
 *
 * The board router's surfaces:
 *
 *   GET  /api/autopilot/board-state  → AutopilotBoardStateResponse
 *   GET  /api/autopilot/work-queue   → WorkQueueResponse        (#4010)
 *   GET  /api/autopilot/hitl-grill   → HitlGrillResponse        (#4028)
 *   POST /api/autopilot/board/promote|relabel|close|reopen      (#4010)
 *                                     → BoardActionResponse
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
     * Trust seam (issue #4010, ADR-0034 §5): `!degraded` — the board-state's
     * "lookup ran cleanly" assertion. Additive; `degraded` and its consumer
     * (`collect-state.sh`) are untouched. `sourcesOk === false` is what the
     * dashboard's derivePageStatus reads to render UNKNOWN instead of a
     * confident all-zero board.
     */
    sourcesOk: z.boolean(),
    /** ISO timestamp the projection was assembled. */
    generatedAt: z.string(),
  })
  .strict();

export type AutopilotBoardStateResponse = z.infer<
  typeof AutopilotBoardStateResponseSchema
>;

// ---------------------------------------------------------------------------
// Work queue (issue #4010 — the /work page's ready-for-agent + triage queue)
// ---------------------------------------------------------------------------

/**
 * The operator-lane labels the /work queue surfaces, in lane-resolution order
 * (first match wins — `ready-for-agent` outranks a stray `needs-triage` because
 * the dispatch signal is the stronger claim). `in-progress` / `needs-qa` are
 * agent-owned lifecycle states, not operator lanes, and are deliberately absent
 * (the queue is the operator's backlog view, not a dispatch mirror).
 */
export const WORK_QUEUE_LANES = [
  "ready-for-agent",
  "needs-info",
  "needs-triage",
  "blocked",
  "ready-for-human",
] as const;
export type WorkQueueLane = (typeof WORK_QUEUE_LANES)[number];

/**
 * The lane labels a relabel action may move an issue between (ADR-0034 §7:
 * relabel is immediate-tier). Promoting to `ready-for-agent` is its own
 * confirm-gated action; `in-progress`/`needs-qa` are agent-owned and never
 * set by hand.
 */
export const RELABEL_TARGETS = [
  "needs-triage",
  "needs-info",
  "ready-for-human",
  "blocked",
] as const;
export type RelabelTarget = (typeof RELABEL_TARGETS)[number];

/** One /work queue row. */
export const WorkQueueRowSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    labels: z.array(z.string()),
    /** Resolved operator lane (first match from WORK_QUEUE_LANES). */
    lane: z.enum(WORK_QUEUE_LANES),
    /** ISO last-updated timestamp (staleness rendering). */
    updatedAt: z.string(),
    /**
     * OPEN strict-blocker numbers this row cites (resolved only for
     * `ready-for-agent` rows — the same population `resolveOpenBlockers`
     * resolves for the board counts). Empty array otherwise.
     */
    openBlockers: z.array(z.number().int().positive()),
    /** Carries the GLM dev-drainer eligibility label (ADR-0032). */
    glmEligible: z.boolean(),
  })
  .strict();

export type WorkQueueRow = z.infer<typeof WorkQueueRowSchema>;

/** `GET /autopilot/work-queue` response — the trust-seam list contract. */
export const WorkQueueResponseSchema = z
  .object({
    items: z.array(WorkQueueRowSchema),
    /** Asserted-emptiness evidence: the count of open issues the lookup scanned. */
    scanned: z.number().int().nonnegative(),
    sourcesOk: z.boolean(),
    generatedAt: z.string(),
  })
  .strict();

// ---------------------------------------------------------------------------
// HITL grill lane (issue #4028 — the parked-idea inbox slice 4 of epic #4024)
// ---------------------------------------------------------------------------

/**
 * The terminal park label the whole hitl-grill lane keys on
 * (`docs/agents/triage-labels.md`: a park state no agent actions — the
 * operator grills it into real work or dismisses it). Lives here, beside
 * `WORK_QUEUE_LANES`, because this schema file is the label-vocabulary home
 * for the board router's surfaces.
 */
export const HITL_GRILL_LABEL = "hitl-grill";

/**
 * The open-park count at which the producers' pre-park cap check stops
 * parking new ideas (`docs/operator-playbooks/hydra-architecture-scan.md`
 * step 4c). The lane surfaces the state, not the gate: `capReached` on the
 * response is precomputed from the SAME read the lane renders.
 */
export const HITL_GRILL_CAP = 10;

/** One parked-idea row — an OPEN issue carrying {@link HITL_GRILL_LABEL}. */
export const HitlGrillRowSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    /**
     * The producer provenance labels: every label on the issue EXCEPT the
     * `hitl-grill` lane label itself (the pilot producer always attaches
     * `architecture-scan` alongside; filtering rather than hardcoding one
     * producer generalizes to the other feeders named in epic #4024).
     */
    provenance: z.array(z.string()),
    /**
     * The parsed park reason: an explicit `Recommendation strength:` line
     * wins (a future producer's literal field), falling back to today's
     * blockquoted `> Reason:` park-body line; blank when neither is present.
     */
    reason: z.string(),
    /** ISO creation timestamp — the lane's oldest-first ordering key. */
    createdAt: z.string(),
  })
  .strict();

export type HitlGrillRow = z.infer<typeof HitlGrillRowSchema>;

/** `GET /autopilot/hitl-grill` response — the trust-seam list contract. */
export const HitlGrillResponseSchema = z
  .object({
    items: z.array(HitlGrillRowSchema),
    /** Asserted-emptiness evidence: the count of issues the lookup scanned. */
    scanned: z.number().int().nonnegative(),
    /**
     * `items.length >= HITL_GRILL_CAP` — the producer's parking cap is
     * reached, precomputed from this same read (never a second network call
     * to a producer's own cap check).
     */
    capReached: z.boolean(),
    sourcesOk: z.boolean(),
    generatedAt: z.string(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Issue-lifecycle actions (issue #4010, ADR-0034 §7)
// ---------------------------------------------------------------------------

/**
 * `POST /autopilot/board/promote` body. `confirm: true` is the explicit
 * confirm step ADR-0034 §7 requires for anything that starts an agent (a
 * promote IS a dispatch trigger in disguise) — `z.literal(true)` means an
 * absent/false/mistyped confirm is a 400 before any write is attempted.
 */
export const BoardPromoteActionSchema = z
  .object({
    issue: z.number().int().positive(),
    confirm: z.literal(true),
  })
  .strict();

/** `POST /autopilot/board/relabel` body (immediate-tier, no confirm). */
export const BoardRelabelActionSchema = z
  .object({
    issue: z.number().int().positive(),
    label: z.enum(RELABEL_TARGETS),
  })
  .strict();

/**
 * `POST /autopilot/board/close` body (immediate-tier). The OPTIONAL `reason`
 * rides `gh issue close --reason` verbatim (issue #4028: the hitl-grill lane's
 * Dismiss verdict closes `"not planned"`); omitted preserves #4010's plain
 * close. Constrained to GitHub's own close-reason vocabulary so an
 * off-vocabulary literal is a 400 before any write.
 */
export const BOARD_CLOSE_REASONS = ["completed", "not planned"] as const;

export const BoardCloseActionSchema = z
  .object({
    issue: z.number().int().positive(),
    reason: z.enum(BOARD_CLOSE_REASONS).optional(),
  })
  .strict();

/** `POST /autopilot/board/reopen` body (immediate-tier). */
export const BoardIssueRefSchema = z
  .object({
    issue: z.number().int().positive(),
  })
  .strict();

/**
 * The machine-readable refusal/write outcomes an action returns. HTTP status
 * stays 200 for every content outcome (the never-throw result-object
 * convention — callers discriminate on `ok`/`reason`, not on status codes);
 * only a malformed body is a 400 `schema-validation-failed`.
 */
export const BOARD_ACTION_REASONS = [
  "already-ready",
  "closed",
  "missing-scope-section",
  "blocked",
  "read-failed",
  "write-failed",
  "write-unverified",
] as const;
export type BoardActionReason = (typeof BOARD_ACTION_REASONS)[number];

/** One action's response envelope. */
export const BoardActionResponseSchema = z
  .object({
    ok: z.boolean(),
    action: z.enum(["promote", "relabel", "close", "reopen"]),
    issue: z.number().int().positive(),
    /** Present on every `ok:false` — the specific reason, surfaced by the UI. */
    reason: z.enum(BOARD_ACTION_REASONS).optional(),
    /** Human-readable one-liner expanding the reason (also on success notes). */
    detail: z.string().optional(),
    /**
     * The VERIFIED post-write state (present only when the follow-up re-read
     * confirmed the write — ADR-0034 §7: no action renders success it has not
     * verified).
     */
    verified: z
      .object({
        state: z.string(),
        labels: z.array(z.string()),
      })
      .optional(),
    generatedAt: z.string(),
  })
  .strict();

export type BoardActionResponse = z.infer<typeof BoardActionResponseSchema>;
