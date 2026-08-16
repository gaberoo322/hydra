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

import { ORCH_BOARD_LABELS } from "../board-labels.ts";

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
    /**
     * ADR-0034 §5 trust field (issue #4010, INV-3): `true` when every source
     * the projection reads ran cleanly — here exactly `!degraded`. The legacy
     * `degraded` field stays untouched (its consumer, `collect-state.sh`,
     * branches on it); `sourcesOk` is the additive spelling the dashboard's
     * `usePageItems` status machine reads (`sourcesOk === false` → UNKNOWN,
     * never a confident zero).
     *
     * OPTIONAL so the count-only fixtures and `deriveBoardState`'s
     * `Omit<AutopilotBoardStateResponse, "degraded" | "generatedAt">` return
     * type stay valid unchanged — the ROUTE always emits it; optionality is a
     * back-compat affordance for the strict parse of hand-built count bodies.
     */
    sourcesOk: z.boolean().optional(),
    /**
     * The ready-for-agent queue rows (issue #4010, INV-1): every open issue
     * carrying `ready-for-agent`, each annotated with WHY it does not count
     * toward `ready_for_agent` when it doesn't (`excluded`). Same optionality
     * rationale as `sourcesOk` — the route always emits it (empty when
     * degraded); hand-built count bodies keep parsing.
     */
    ready_queue: z.array(z.lazy(() => ReadyQueueRowSchema)).optional(),
  })
  .strict();

export type AutopilotBoardStateResponse = z.infer<
  typeof AutopilotBoardStateResponseSchema
>;

// ---------------------------------------------------------------------------
// Ready queue rows (issue #4010, INV-1)
// ---------------------------------------------------------------------------

/**
 * Why a `ready-for-agent` row does NOT count toward the `ready_for_agent`
 * dispatch pool. `null` = counted (dispatchable). Machine-readable literals —
 * the dashboard renders them verbatim; they mirror `deriveBoardState`'s
 * exclusion order (target-backlog, glm-eligible-under-live-drainer, open
 * strict blocker).
 */
export const READY_QUEUE_EXCLUDED_REASONS = [
  "target-backlog",
  "glm-eligible-drainer-live",
  "blocked-by-open-issue",
] as const;

/** One ready-for-agent queue row. */
export const ReadyQueueRowSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string(),
    /** ISO last-updated timestamp (may be "" when the row carried none). */
    updatedAt: z.string(),
    /** null = counted in `ready_for_agent`; otherwise one of the reason literals. */
    excluded: z.nullable(z.enum(READY_QUEUE_EXCLUDED_REASONS)),
    /** The specific OPEN strict-blocker numbers, when excluded for that reason. */
    blockedBy: z.array(z.number().int().positive()),
  })
  .strict();

export type ReadyQueueRow = z.infer<typeof ReadyQueueRowSchema>;

// ---------------------------------------------------------------------------
// Issue-lifecycle action bodies + results (issue #4010, ADR-0034 §7)
// ---------------------------------------------------------------------------

/**
 * The relabel targets — every orch board lane EXCEPT `ready-for-agent`.
 * Relabel is the immediate-tier action (no confirm step); reaching
 * `ready-for-agent` through it would bypass the promote gate's confirm +
 * two refusal guards ("ready-for-agent is a dispatch trigger in disguise",
 * ADR-0034 §7) — so the promote action is the only route onto that label.
 */
export const RELABEL_TARGET_LABELS = [
  ORCH_BOARD_LABELS.needs_qa,
  ORCH_BOARD_LABELS.needs_triage,
  ORCH_BOARD_LABELS.needs_research,
  ORCH_BOARD_LABELS.in_progress,
  ORCH_BOARD_LABELS.blocked,
] as const;

/** Body for `POST /autopilot/board-state/promote`. */
export const PromoteActionBodySchema = z
  .object({
    /** The issue to promote onto `ready-for-agent`. */
    issue: z.number().int().positive(),
    /**
     * ADR-0034 §7 confirm-first tier: the client must have shown an explicit
     * confirm step; the server re-checks (never trust the UI alone).
     */
    confirm: z.boolean(),
  })
  .strict();

/** Body for `POST /autopilot/board-state/relabel`. */
export const RelabelActionBodySchema = z
  .object({
    issue: z.number().int().positive(),
    /** Target lane label — one of {@link RELABEL_TARGET_LABELS}. */
    label: z.enum(RELABEL_TARGET_LABELS),
  })
  .strict();

/** Body for `POST /autopilot/board-state/close` and `/reopen`. */
export const IssueRefBodySchema = z
  .object({
    issue: z.number().int().positive(),
  })
  .strict();

/**
 * The machine-readable refusal reasons every action route may return with
 * `ok: false`. Surfaced verbatim by the dashboard so the operator sees the
 * SPECIFIC reason (INV-5), never a generic failure.
 */
export const BOARD_ACTION_REFUSAL_REASONS = [
  /** `confirm` was not true (promote only — ADR-0034 §7 confirm-first tier). */
  "confirm-required",
  /** The single-issue verification read failed (gh down, or no such number —
   *  the seam cannot distinguish the two; the detail says which issue). */
  "issue-read-failed",
  /** Promote refusal: the issue declares an OPEN strict blocker (INV-5). */
  "blocked-by-open-issue",
  /** Promote refusal: body lacks a "## Files in scope" section (INV-5). */
  "missing-files-in-scope",
  /** A write primitive failed (gh non-zero / timeout / spawn). */
  "write-failed",
  /** The write's command succeeded but the post-write re-read disagrees. */
  "verify-failed",
] as const;

/** The verified post-write issue state returned on success (INV-6). */
export const VerifiedIssueStateSchema = z
  .object({
    number: z.number().int().positive(),
    state: z.string(),
    labels: z.array(z.string()),
    url: z.string(),
  })
  .strict();

export type VerifiedIssueState = z.infer<typeof VerifiedIssueStateSchema>;

/** Uniform result envelope for the four action routes. */
export const BoardActionResultSchema = z
  .object({
    ok: z.boolean(),
    /** Which action produced this result. */
    action: z.enum(["promote", "relabel", "close", "reopen"]),
    issue: z.number().int().positive(),
    /** Present iff `ok: false` — one of {@link BOARD_ACTION_REFUSAL_REASONS}. */
    reason: z.enum(BOARD_ACTION_REFUSAL_REASONS).optional(),
    /** Human-readable detail (e.g. the blocking issue numbers, gh stderr). */
    detail: z.string().optional(),
    /** Present iff `ok: true` — the re-read post-write state (INV-6). */
    verified: VerifiedIssueStateSchema.optional(),
  })
  .strict();

export type BoardActionResult = z.infer<typeof BoardActionResultSchema>;
