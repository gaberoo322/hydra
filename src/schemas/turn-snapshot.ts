/**
 * The JSON Turn Snapshot — the single source of truth for what `decide.py`
 * sees on one autopilot turn (ADR-0043 Decision 5, issue #4934).
 *
 * `scripts/autopilot/turn-snapshot.ts --format json` builds one document from
 * the collectors' typed values (src/autopilot/turn-snapshot/json-snapshot.ts),
 * validates it against {@link TurnSnapshotSchema} on emit, and prints it. A
 * validation failure never crashes the turn: it becomes
 * `validation: {ok: false, issues}` plus a stderr note, and turn.sh runs the
 * legacy kv path for that turn. `scripts/autopilot/turn_snapshot.py` is the
 * ONE Python reader; it never trusts a document whose `validation.ok` is not
 * `true`. No JSON Schema is generated from this file and none is committed
 * (ADR-0043 rejects that artifact) — the contract test
 * (test/turn-snapshot-json.test.mts) round-trips golden documents through
 * both this schema and the Python accessor instead.
 *
 * Field shapes (the PR's "Decisions taken"):
 *   - `signals` keys are decide.py's existing signal vocabulary (the names
 *     merge-signals.py promoted), so events, cooldown tables, plan reasons and
 *     the playbook keep one vocabulary. Values are typed — the packed strings
 *     of the kv wire are structured here:
 *       pins     `issue-N:PR:branch` / `none` → `{issue, pr, branch} | null`
 *       anchors  `issue-N` / `none`           → positive int | null
 *       lists    space-separated numbers      → int[]
 *       surface  `pr:issue|none` tokens       → `[{pr, closing_issue}]`
 *       share    `0.1234` / `unavailable`     → number | null
 *   - `blobs` carry the data-plane bodies decide.py normalises itself
 *     (usage eligibility, emergency brake, class stats, slot events, the
 *     Target risk surface): their shapes are owned by the service routes, so
 *     the schema guarantees presence and parseability, not inner shape. A
 *     blob whose body did not parse is ABSENT (the previous state value is
 *     kept), never a fabricated default.
 *   - `degraded` lists every field a collector could not read, with why —
 *     explicit, never a silent default (ADR-0043 Decision 4).
 */
import { z } from "zod";

/** The one version decide.py's accessor reads; bump it on a breaking shape change. */
export const TURN_SNAPSHOT_SCHEMA_VERSION = 1;

const IssueNumber = z.number().int().positive();

const PinSchema = z
  .object({
    issue: IssueNumber,
    pr: IssueNumber,
    branch: z.string().min(1),
  })
  .strict();

const NumberList = z.array(IssueNumber);

const DirtySurfaceSchema = z.array(
  z
    .object({
      pr: IssueNumber,
      closing_issue: IssueNumber.nullable(),
    })
    .strict(),
);

const CandidateExclusionSchema = z
  .object({
    anchor: z.string(),
    member: z.enum(["target-scope-exclusion", "in-flight-dev-exclusion", "mechanical-exclusion", "trivial-anchor-exclusion"]),
    verdict: z.enum(["excluded", "survived"]),
    evidence: z.string(),
  })
  .strict();

/** Every signal decide.py reads, typed. Keys are its existing vocabulary. */
const SignalsSchema = z
  .object({
    // orch board (board-state counts) + the orch needs-triage set
    orch_work_available: z.boolean(),
    needs_qa_orch: z.boolean(),
    needs_research: z.boolean(),
    needs_triage_orch: z.boolean(),
    needs_qa_numbers: NumberList,
    orch_needs_triage_items: NumberList,
    untriaged_orphans_orch: z.boolean(),
    // target lane
    target_work_available: z.boolean(),
    target_board_work_available: z.boolean(),
    target_board_research_due: z.boolean(),
    target_wip_saturated: z.boolean(),
    needs_qa_target: z.boolean(),
    target_needs_qa_pr_ref: z.string(),
    target_needs_qa_pr_head: z.string(),
    target_dev_resume_pick: PinSchema.nullable(),
    needs_triage_target: z.boolean(),
    target_needs_triage_items: NumberList,
    // health / scout
    health_fail: z.boolean(),
    scout_walk_due: z.boolean(),
    scout_board_saturated: z.boolean(),
    scout_alert_eligible_count: z.number().int().nonnegative(),
    // backfill producers and their saturation caps
    orch_backfill_idle: z.boolean(),
    arch_board_saturated: z.boolean(),
    hitl_grill_open: z.number().int().nonnegative(),
    hitl_grill_saturated: z.boolean(),
    orch_board_signals_degraded: z.boolean(),
    cleanup_board_saturated: z.boolean(),
    skill_prune_board_saturated: z.boolean(),
    target_backfill_idle: z.boolean(),
    target_cleanup_board_saturated: z.boolean(),
    wire_or_retire_target_available: z.boolean(),
    design_qa_target_due: z.boolean(),
    design_qa_target_saturated: z.boolean(),
    retro_run_available: z.boolean(),
    retro_run_drillable: z.boolean(),
    // PR gate (#4240) and the GLM / resume / conflict-fix picks
    orch_prs_dirty: NumberList,
    orch_prs_unchecked: NumberList,
    orch_prs_behind: NumberList,
    orch_ci_trigger_stale: z.boolean(),
    orch_prs_glm_red: NumberList,
    orch_glm_red_forward_fix: PinSchema.nullable(),
    orch_dev_resume_pick: PinSchema.nullable(),
    orch_dirty_forward_fix: PinSchema.nullable(),
    orch_prs_dirty_surface: DirtySurfaceSchema,
    // grill gate (#628 / #3711)
    orch_pending_grill_anchor: IssueNumber.nullable(),
    orch_dev_ready_anchor: IssueNumber.nullable(),
    // wayfinder / tickets stages (ADR-0029, ADR-0030)
    wayfinder_orch_frontier: IssueNumber.nullable(),
    wayfinder_orch_ticket_type: z.string(),
    wayfinder_orch_inflight_global: z.number().int().nonnegative(),
    tickets_available: z.boolean(),
    tickets_orch_pending_spec: IssueNumber.nullable(),
    // budget (#4161) — null is the kv `unavailable`
    orch_realm_weekly_share: z.number().min(0).max(1).nullable(),
  })
  .strict();

/** The data-plane bodies decide.py normalises itself. Absent = unparseable this turn (previous state value kept). */
const BlobsSchema = z
  .object({
    usage_eligibility: z.unknown(),
    emergency_brake: z.unknown(),
    target_risk_surface: z.unknown(),
    class_stats: z.unknown(),
    slot_events: z.unknown(),
    candidate_exclusions: z.array(CandidateExclusionSchema),
  })
  .partial()
  .strict();

const DegradedSchema = z
  .object({
    collector: z.string().min(1),
    field: z.string().min(1),
    reason: z.string(),
  })
  .strict();

const ValidationSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()),
    })
    .strict(),
]);

export const TurnSnapshotSchema = z
  .object({
    schema_version: z.literal(TURN_SNAPSHOT_SCHEMA_VERSION),
    generated_at: z.string().min(1),
    signals: SignalsSchema,
    blobs: BlobsSchema,
    /** `scout_spend_usd_today` (scout daily cost cap); absent = not numeric this turn (previous value kept). */
    scout_spend_usd_today: z.number().nonnegative().optional(),
    degraded: z.array(DegradedSchema),
    validation: ValidationSchema,
  })
  .strict();

export type TurnSnapshotDoc = z.infer<typeof TurnSnapshotSchema>;
export type TurnSnapshotSignals = z.infer<typeof SignalsSchema>;
export type TurnSnapshotPin = z.infer<typeof PinSchema>;
