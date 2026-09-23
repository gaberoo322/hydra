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
 * outcome `waiting-on-you` issues cannot reach).
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

export function isAdmissionLineKey(key: string): boolean {
  return ADMISSION_LINE_KEYS.includes(key);
}

export function isClassKey(key: string): boolean {
  return CLASS_KEY_PATTERN.test(key);
}

/** Which bucket (or the `class` namespace) an entry key belongs to, or `null`
 * for a key that is neither a real admission line nor a `class:` key —
 * `EntryKeySchema` already rejects those, so callers past that boundary can
 * treat `null` as unreachable. */
export function bucketOfKey(key: string): Bucket | "class" | null {
  if (isClassKey(key)) return "class";
  const idx = key.indexOf(":");
  if (idx === -1) return null;
  const candidate = key.slice(0, idx);
  return (BUCKETS as readonly string[]).includes(candidate) && isAdmissionLineKey(key)
    ? (candidate as Bucket)
    : null;
}

export const EntryKeySchema = z.string().refine(
  (key) => isAdmissionLineKey(key) || isClassKey(key),
  {
    message:
      'key must be a "<bucket>:<line>" admission line drawn from BUCKET_LINES, ' +
      "or match /^class:[a-z0-9_]+$/",
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
 * parked-lane cap.
 */
export const BUCKET_CONTEXT: Readonly<Record<Bucket | "class", readonly string[]>> =
  Object.freeze({
    "machine-stopped": Object.freeze([]),
    "prs-not-landing": Object.freeze(["repo", "number", "kind"]),
    "waiting-on-you": Object.freeze(["repo", "number", "kind"]),
    "target-items": Object.freeze(["repo", "number", "kind"]),
    repetition: Object.freeze([]),
    "parked-over-cap": Object.freeze([]),
    class: Object.freeze([]),
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
export const VARIANTS = [
  "triage-origin",
  "tracking-parent",
  "dev-failure",
  "reframe",
  "grill-handoff",
] as const;
export const VariantSchema = z.enum(VARIANTS);
export type Variant = z.infer<typeof VariantSchema>;

/**
 * The `docs/operator-playbooks/hydra-review.md` §4 canonical option-table row
 * names, excluding the retiring "Overnight queue row" (ADR-0034 §8.1
 * supersedes the overnight decision queue — see PR #4617's
 * `docs/agents/triage-labels.md` amendment). A future drift assertion (b)
 * pins each of these against its table row's cells 1-3; this slice only
 * needs the closed vocabulary so `reviewBucket` can be set on today's
 * 1:1-mappable default entries without a later reshape.
 */
export const REVIEW_BUCKETS = [
  "Stalled PR",
  "Triage origin",
  "Tracking parent",
  "Dev failure",
  "Stale-blocked",
  "Target ready-for-human",
  "Target reframe",
  "Target stale-blocked",
] as const;
export const ReviewBucketSchema = z.enum(REVIEW_BUCKETS);
export type ReviewBucket = z.infer<typeof ReviewBucketSchema>;

// ---------------------------------------------------------------------------
// Action (ADR-0034 §8.2) — six closed kinds
// ---------------------------------------------------------------------------

export const ConfirmTierSchema = z.enum(["immediate-undo", "confirm-first"]);
export type ConfirmTier = z.infer<typeof ConfirmTierSchema>;

/** Fields every Action carries regardless of `kind`. */
const ActionCommonShape = {
  label: z.string().min(1),
  preconditions: z.array(z.string().min(1)),
  consequence: z.string().min(1),
};

/**
 * `in-dashboard` — fires an existing write route. `method` is a deliberate
 * extension beyond the ADR-0034 §8.2 sketch (see module docstring).
 */
export const InDashboardActionSchema = z
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
export const TerminalSkillActionSchema = z
  .object({
    kind: z.literal("terminal-skill"),
    command: z.string().min(1),
    ...ActionCommonShape,
  })
  .strict();

/** `config-env` — a hand-off to a tracked config file; the dashboard never
 * writes tracked config (ADR-0034 §9.1). */
export const ConfigEnvActionSchema = z
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
export const CredentialActionSchema = z
  .object({ kind: z.literal("credential"), ...ActionCommonShape })
  .strict();
export const ResearchBeyondAutonomyActionSchema = z
  .object({ kind: z.literal("research-beyond-autonomy"), ...ActionCommonShape })
  .strict();
export const VisionDecisionActionSchema = z
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
export type ActionKind = Action["kind"];

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
