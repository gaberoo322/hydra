/**
 * Schemas for the autopilot board-state endpoint (issue #934).
 *
 * One read-only endpoint:
 *
 *   GET /api/autopilot/board-state → AutopilotBoardStateResponse
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
    /** ISO timestamp the projection was assembled. */
    generatedAt: z.string(),
  })
  .strict();

export type AutopilotBoardStateResponse = z.infer<
  typeof AutopilotBoardStateResponseSchema
>;
