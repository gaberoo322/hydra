/**
 * Schema for the typed operator-action registry (issue #4620, ADR-0034 §8.2
 * — normative text lives only in the OPEN PR #4617, not yet on master; every
 * load-bearing rule below is inlined from that PR's diff + the issue #4620
 * design-concept artifact so this module needs no unmerged reference).
 *
 * The registry (`src/operator-actions/registry.ts`) is a checked-in TS
 * constant, not a data file (ADR-0005 allows no YAML parser, and a data file
 * would lose the `satisfies`-typed authoring this module enables). This file
 * owns every shape the registry must conform to:
 *
 *   - The closed **bucket** vocabulary and, per bucket, the closed
 *     **admission-line** vocabulary (`BUCKET_LINES`), transcribed verbatim
 *     from ADR-0034 §8.1's table. Together they define the closed
 *     `<bucket>:<line>` key space (`ADMISSION_LINE_KEYS`). A second key
 *     shape, `class:<name>`, is admitted by regex for a namespace slice 17
 *     populates — this slice ships ZERO `class:` entries.
 *   - A third key shape, `control:<page>/<name>` (issue #4629, ADR-0034
 *     §8.3 "action-bearing controls"), for the write controls on /work and
 *     /health. The closed list of shipped control keys is `CONTROL_KEYS`;
 *     the schema admits the shape by regex and `controlEntryCoverage`
 *     (registry.ts) pins the registry to the list in both directions.
 *   - The closed per-bucket **context** vocabulary (`BUCKET_CONTEXT`) a
 *     template placeholder may reference. Per-item buckets (`prs-not-landing`,
 *     `waiting-on-you`, `target-items`) get `{repo, number, kind}`; aggregate
 *     buckets (`machine-stopped`, `repetition`, `parked-over-cap`) and the
 *     `class:*` namespace get `{}` — a friction pattern or an aggregate row
 *     has no single repo/number to template against.
 *   - The **Action** discriminated union over the six closed `kind`s
 *     (`in-dashboard`, `terminal-skill`, `config-env`, `credential`,
 *     `research-beyond-autonomy`, `vision-decision`). `in-dashboard` is the
 *     one kind extended beyond the ADR-0034 §8.2 sketch: it carries a
 *     required `method` (`POST|PUT|PATCH|DELETE`) alongside `route`, because
 *     a route with no method cannot be fired by a future dashboard affordance
 *     and `.strict()` would force a breaking reshape later if added then.
 *   - The **Entry** shape: `key`, optional `variant`/`reviewBucket`,
 *     `recommended` + exactly two `alternatives` (a `z.tuple`), `rationale`,
 *     `doc`. Skip is implicit (the canonical option-table's slot 4,
 *     `docs/operator-playbooks/hydra-review.md` §4) and is never stored as an
 *     entry field.
 *   - `OperatorActionRegistrySchema`, the top-level array schema
 *     `registry.ts`'s `validateRegistry()` runs at import. Its `superRefine`
 *     also rejects a duplicate `(key, variant ?? "default")` pair — two
 *     entries claiming the same slot would make `missingDefaultLines` /
 *     drift assertion (a) ambiguous about which entry is authoritative.
 *
 * Follows the Schemas Seam convention (CLAUDE.md / CONTEXT.md): zod schemas
 * + `z.infer` types only, no express import, no I/O. `registry.ts` imports
 * this module; `src/api/operator-actions.ts` imports the registry, never
 * this module's schemas directly (other than the response envelope type).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Buckets + admission lines (ADR-0034 §8.1, PR #4617)
// ---------------------------------------------------------------------------

/** The six feed buckets, in drain order. Closed — adding one is vision-level. */
export const BUCKETS = [
  "machine-stopped",
  "prs-not-landing",
  "waiting-on-you",
  "target-items",
  "repetition",
  "parked-over-cap",
] as const;

export const BucketSchema = z.enum(BUCKETS);
export type Bucket = z.infer<typeof BucketSchema>;

/**
 * Per-bucket closed admission-line vocabulary, transcribed verbatim from
 * ADR-0034 §8.1's table (PR #4617 diff). `target-items` reuses the
 * `waiting-on-you` lines plus `reframe` (Target builds add a `reframe`
 * outcome `waiting-on-you` issues cannot reach) plus `archived` (the one
 * aggregate row rendered when the configured Target is archived or unset,
 * issue #4625).
 */
export const BUCKET_LINES: Readonly<Record<Bucket, readonly string[]>> = Object.freeze({
  "machine-stopped": Object.freeze([
    "paused",
    "session-blocked",
    "scheduler-deliberate",
    "sha-drift",
  ]),
  "prs-not-landing": Object.freeze(["conflicted", "failed-required", "unshepherded"]),
  "waiting-on-you": Object.freeze([
    "ready-for-human",
    "stale-blocked",
    "needs-info",
    "blocked-live",
  ]),
  "target-items": Object.freeze([
    "ready-for-human",
    "stale-blocked",
    "needs-info",
    "blocked-live",
    "reframe",
    "archived",
  ]),
  repetition: Object.freeze(["hits"]),
  "parked-over-cap": Object.freeze(["cap"]),
});

/** Every valid `<bucket>:<line>` key, flattened in bucket drain order. */
export const ADMISSION_LINE_KEYS: readonly string[] = Object.freeze(
  BUCKETS.flatMap((bucket) => BUCKET_LINES[bucket].map((line) => `${bucket}:${line}`)),
);

/**
 * `class:<name>` namespace (ADR-0034 §9.2) — admitted by the schema so
 * slice 17 can add entries without a schema reshape, but ships zero entries
 * here. `name` mirrors the dispatch-class alphabet's naming convention
 * (`src/taxonomy/classes.ts`): lowercase, digits, underscore.
 */
const CLASS_KEY_PATTERN = /^class:[a-z0-9_]+$/;

/**
 * `control:<page>/<name>` namespace (issue #4629, design-concept 821e48ed
 * INV-2; ADR-0034 §8.3) — one registry entry per action-bearing control on a
 * dashboard page, so a page button reads its label, preconditions and
 * consequence from the registry instead of page prose. Kept separate from the
 * §8.1 admission lines on purpose: a page control bound to a feed line would
 * couple two surfaces (a feed authoring change would silently re-label a page
 * button). Add a page by appending it to the alternation; add a control by
 * appending one line to {@link CONTROL_KEYS}.
 */
const CONTROL_KEY_PATTERN = /^control:(work|health)\/[a-z0-9-]+$/;

/**
 * Every shipped `control:` key — one entry per line, grouped by page. The
 * registry must carry exactly one DEFAULT entry per key and no `control:`
 * entry outside this list (`controlEntryCoverage`, registry.ts), and each key
 * is referenced by exactly one dashboard page (test/operator-actions-registry
 * .test.mts).
 */
export const CONTROL_KEYS = [
  // /work — BoardState.jsx
  "control:work/promote",
  "control:work/relabel",
  "control:work/close",
  "control:work/reopen",
  // /health — Health.jsx
  "control:health/pause",
  "control:health/resume",
  "control:health/brake-engage",
  "control:health/brake-release",
  // /health — AlertsPanel.jsx, ServiceStrip.jsx and Health.jsx's housekeeping
  // section (issue #4631, design-concept 5ae4b72c INV-2)
  "control:health/alert-dismiss",
  "control:health/alerts-dismiss-all",
  "control:health/scheduler-stop",
  "control:health/scheduler-start",
  "control:health/housekeeping",
] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];

export function isAdmissionLineKey(key: string): boolean {
  return ADMISSION_LINE_KEYS.includes(key);
}

function isClassKey(key: string): boolean {
  return CLASS_KEY_PATTERN.test(key);
}

export function isControlKey(key: string): boolean {
  return CONTROL_KEY_PATTERN.test(key);
}

/** Which bucket (or the `class` / `control` namespace) an entry key belongs
 * to, or `null` for a key that is none of a real admission line, a `class:`
 * key or a `control:` key — `EntryKeySchema` already rejects those, so
 * callers past that boundary can treat `null` as unreachable. */
export function bucketOfKey(key: string): Bucket | "class" | "control" | null {
  if (isClassKey(key)) return "class";
  if (isControlKey(key)) return "control";
  const idx = key.indexOf(":");
  if (idx === -1) return null;
  const candidate = key.slice(0, idx);
  return (BUCKETS as readonly string[]).includes(candidate) && isAdmissionLineKey(key)
    ? (candidate as Bucket)
    : null;
}

const EntryKeySchema = z.string().refine(
  (key) => isAdmissionLineKey(key) || isClassKey(key) || isControlKey(key),
  {
    message:
      'key must be a "<bucket>:<line>" admission line drawn from BUCKET_LINES, ' +
      "or match /^class:[a-z0-9_]+$/, or match /^control:(work|health)\\/[a-z0-9-]+$/",
  },
);

// ---------------------------------------------------------------------------
// Per-bucket template context (ADR-0034 §8.2 "Context is closed per bucket")
// ---------------------------------------------------------------------------

/**
 * The closed set of `{name}` placeholders a template field (`command` on
 * `terminal-skill`, `route` on `in-dashboard`) may reference for entries in
 * each bucket. Per-item buckets carry the item's `{repo, number, kind}`;
 * aggregate buckets and `class:*` carry none — there is no single repo/number
 * to template against for a machine-stopped flag, a friction pattern, or the
 * parked-lane cap. The `control:*` namespace carries exactly one, `{id}`
 * (issue #4631, design-concept 5ae4b72c INV-9, amending #4629's empty list):
 * the dashboard alert id is the only per-row ROUTE segment any control
 * carries (`/alerts/{id}/dismiss`). The page resolves it client-side through
 * `resolveControlRoute` (dashboard/src/lib/health-verdicts.ts) before the
 * action reaches ActionAffordance; every other per-row value travels in the
 * request body, built from the page's closed context (`IN_DASHBOARD_BODY` in
 * ActionAffordance.jsx).
 */
export const BUCKET_CONTEXT: Readonly<Record<Bucket | "class" | "control", readonly string[]>> =
  Object.freeze({
    "machine-stopped": Object.freeze([]),
    "prs-not-landing": Object.freeze(["repo", "number", "kind"]),
    "waiting-on-you": Object.freeze(["repo", "number", "kind"]),
    "target-items": Object.freeze(["repo", "number", "kind"]),
    repetition: Object.freeze([]),
    "parked-over-cap": Object.freeze([]),
    class: Object.freeze([]),
    control: Object.freeze(["id"]),
  });

// ---------------------------------------------------------------------------
// variant / reviewBucket (ADR-0034 §8.2)
// ---------------------------------------------------------------------------

/**
 * A `hydra-review` entry path the composer sets ONLY when it can detect it
 * mechanically (§8.2); this slice authors DEFAULT entries only (no variant),
 * but the schema admits the vocabulary now so a later slice's entries are a
 * pure data addition, never a schema reshape.
 */
const VARIANTS = [
  "triage-origin",
  "tracking-parent",
  "dev-failure",
  "reframe",
  "grill-handoff",
] as const;
const VariantSchema = z.enum(VARIANTS);
export type Variant = z.infer<typeof VariantSchema>;

/**
 * The `docs/operator-playbooks/hydra-review.md` §4 canonical option-table row
 * names. The retired "Overnight queue row" (ADR-0034 §8.1 superseded the
 * overnight decision queue with `hydra-grill`'s anchor-issue handoff — see PR
 * #4617's `docs/agents/triage-labels.md` amendment, and #4621) is replaced by
 * "Grill handoff". A future drift assertion (b) pins each of these against
 * its table row's cells 1-3; this slice only needs the closed vocabulary so
 * `reviewBucket` can be set on today's 1:1-mappable default entries without a
 * later reshape.
 */
export const REVIEW_BUCKETS = [
  "Stalled PR",
  "Triage origin",
  "Tracking parent",
  "Dev failure",
  "Stale-blocked",
  "Grill handoff",
  "Target ready-for-human",
  "Target reframe",
  "Target stale-blocked",
] as const;
const ReviewBucketSchema = z.enum(REVIEW_BUCKETS);

// ---------------------------------------------------------------------------
// Action (ADR-0034 §8.2) — six closed kinds
// ---------------------------------------------------------------------------

const ConfirmTierSchema = z.enum(["immediate-undo", "confirm-first"]);

/**
 * The closed vocabulary of LIVE precondition checks (issue #4629,
 * design-concept 821e48ed INV-3). A page evaluates the ids it owns from data
 * it already reads into a verdict table; the affordance resolves each
 * `{text, check}` line to ✓/✗ through `dashboard/src/lib/preconditions.ts`
 * (a missing verdict fails closed to ✗). Binding by a closed id — never by
 * the prose text or the array index — makes a misspelled or missing check a
 * parse error rather than a silently unevaluated line. One id per line,
 * grouped by the page that evaluates it; append new ids to their group.
 */
export const CONTROL_CHECKS = [
  // /work rows — the promote refusal table's four rules, in its order
  // (evaluatePromoteEligibility: closed, already-ready, missing-scope-section,
  // blocked), then the relabel picker and the reopen-by-number input.
  "issue-open",
  "not-already-ready",
  "has-scope-section",
  "no-open-blocker",
  "relabel-target-chosen",
  "issue-number-entered",
  // /health — the verified pause and brake reads.
  "pause-state-verified",
  "autopilot-running",
  "autopilot-paused",
  "brake-state-verified",
  "brake-off",
  "brake-engaged",
  // /health — the alert, scheduler and deliberate-stop reads (issue #4631,
  // design-concept 5ae4b72c INV-4), evaluated by dashboard/src/lib/health-verdicts.ts.
  "alert-open",
  "alerts-any-open",
  "scheduler-running",
  "scheduler-not-running",
  "no-fresh-deliberate-stop",
] as const;
export const ControlCheckSchema = z.enum(CONTROL_CHECKS);
export type ControlCheck = z.infer<typeof ControlCheckSchema>;

/**
 * A precondition is either prose (rendered ☐, never disables — every feed
 * line and class entry stays string-only) or a strict `{text, check}` pair
 * whose `check` is a {@link CONTROL_CHECKS} id (rendered ✓/✗ live; ✗ disables
 * the trigger). `{text, check}` appears ONLY on `control:` entries — pinned by
 * test/operator-actions-registry.test.mts, so AttentionFeed.jsx (which renders
 * precondition strings directly) is never handed an object.
 */
const PreconditionSchema = z.union([
  z.string().min(1),
  z.object({ text: z.string().min(1), check: ControlCheckSchema }).strict(),
]);
export type Precondition = z.infer<typeof PreconditionSchema>;

/** Fields every Action carries regardless of `kind`. */
const ActionCommonShape = {
  label: z.string().min(1),
  preconditions: z.array(PreconditionSchema),
  consequence: z.string().min(1),
};

/**
 * `in-dashboard` — fires an existing write route. `method` is a deliberate
 * extension beyond the ADR-0034 §8.2 sketch (see module docstring).
 */
const InDashboardActionSchema = z
  .object({
    kind: z.literal("in-dashboard"),
    route: z.string().min(1),
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    confirmTier: ConfirmTierSchema,
    ...ActionCommonShape,
  })
  .strict();

/**
 * `terminal-skill` — a command template. `{repo}`/`{number}` (where the
 * entry's bucket context admits them) are resolved server-side from the
 * item's context by the feed composer (slice 4) — this router serves
 * templates UNRESOLVED.
 */
const TerminalSkillActionSchema = z
  .object({
    kind: z.literal("terminal-skill"),
    command: z.string().min(1),
    ...ActionCommonShape,
  })
  .strict();

/** `config-env` — a hand-off to a tracked config file; the dashboard never
 * writes tracked config (ADR-0034 §9.1). */
const ConfigEnvActionSchema = z
  .object({
    kind: z.literal("config-env"),
    project: z.enum(["orchestrator", "target"]),
    file: z.string().min(1),
    ...ActionCommonShape,
  })
  .strict();

/** The three ADR-0005 closed-escalation kinds — doc link + instruction, no
 * control. Each is `.strict()` with no kind-specific fields: the link is the
 * entry's own `doc`. */
const CredentialActionSchema = z
  .object({ kind: z.literal("credential"), ...ActionCommonShape })
  .strict();
const ResearchBeyondAutonomyActionSchema = z
  .object({ kind: z.literal("research-beyond-autonomy"), ...ActionCommonShape })
  .strict();
const VisionDecisionActionSchema = z
  .object({ kind: z.literal("vision-decision"), ...ActionCommonShape })
  .strict();

export const ActionSchema = z.discriminatedUnion("kind", [
  InDashboardActionSchema,
  TerminalSkillActionSchema,
  ConfigEnvActionSchema,
  CredentialActionSchema,
  ResearchBeyondAutonomyActionSchema,
  VisionDecisionActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;

// ---------------------------------------------------------------------------
// Entry + registry
// ---------------------------------------------------------------------------

export const OperatorActionEntrySchema = z
  .object({
    key: EntryKeySchema,
    variant: VariantSchema.optional(),
    reviewBucket: ReviewBucketSchema.optional(),
    recommended: ActionSchema,
    /** Exactly two alternatives — Skip is implicit and never stored. */
    alternatives: z.tuple([ActionSchema, ActionSchema]),
    rationale: z.string().min(1),
    doc: z.string().min(1),
  })
  .strict();
export type OperatorActionEntry = z.infer<typeof OperatorActionEntrySchema>;
export type OperatorActionEntryInput = z.input<typeof OperatorActionEntrySchema>;

/**
 * The whole checked-in table. `validateRegistry()` (registry.ts) runs this
 * `safeParse` at import; a failure throws `InvariantViolationError`. The
 * `superRefine` below rejects a duplicate `(key, variant ?? "default")` pair
 * — two entries claiming the same slot.
 */
export const OperatorActionRegistrySchema = z
  .array(OperatorActionEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const slot = `${entry.key}::${entry.variant ?? "default"}`;
      if (seen.has(slot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate entry for key "${entry.key}" variant "${entry.variant ?? "default"}"`,
          path: [index, "key"],
        });
      }
      seen.add(slot);
    });
  });

/** The wire body of `GET /api/operator-actions`. */
export const OperatorActionsResponseSchema = z.object({
  entries: z.array(OperatorActionEntrySchema),
});
export type OperatorActionsResponse = z.infer<typeof OperatorActionsResponseSchema>;
