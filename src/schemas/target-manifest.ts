/**
 * Target Manifest schema (epic #3014, ADR-0026 — the third per-target artifact
 * alongside Target Vision and Target Outcomes).
 *
 * A **Target Manifest** is the typed JSON config a target repo ships at
 * `<workspace>/.hydra/manifest.json` declaring how the builder machinery
 * operates against that target: the `verify` command block and the
 * `riskCritical` surface. It lives IN the target repo and is read fresh (no
 * orchestrator-side mirror) — see `src/target/manifest.ts` for the loader.
 *
 * # Why this lives under `src/schemas/`
 *
 * ADR-0026 decision 5 places the manifest schema here because it is a validated,
 * typed input that code branches on via `safeParse` — the same discipline the
 * **Schemas** seam owns for HTTP request bodies. This is a *file*-input schema,
 * NOT an HTTP-body schema, so it is deliberately EXEMPT from the
 * `schema-validation-check` ratchet (that guard only inspects `req.body` access
 * inside `src/api/*`). The zod schema is the single source of truth for both the
 * `loadManifest` parser AND the inferred `TargetManifest` type — no hand-written
 * interface duplicates it.
 *
 * # `risk-critical` vs the Modification Tier ladder
 *
 * `riskCritical` (ADR-0026 decision 4) is the generalization of the
 * betting-specific "money-critical" flag: a two-level boolean (in-`surface` vs
 * safe). It is EXPLICITLY NOT the monotonic T1→T4 Modification Tier ladder. This
 * slice introduces only the schema block `{ surface, mutationKillFloor,
 * acknowledgedNoRiskSurface? }`; the classifier migration and the
 * `MONEY_CRITICAL_TARGET_PATHS` const deletion are sibling work (out of scope).
 *
 * # Invariants encoded here
 *
 *   - `version` is a required top-level integer, so schema skew is an actionable
 *     validation error rather than a cryptic downstream failure.
 *   - Every object level is `.strict()`: unknown top-level keys, unknown `verify`
 *     keys, and unknown `riskCritical` keys all fail validation.
 *   - An empty `riskCritical.surface` is valid ONLY with
 *     `acknowledgedNoRiskSurface: true`. The cross-field rule lives on the INNER
 *     `RiskCriticalSchema` via `superRefine` so the issue path nests to
 *     `['riskCritical', 'surface']`, keeping the error field-local and
 *     actionable. This guarantees the keystone risk gate can never be silently
 *     disabled (an unset/false ack with no surface fails closed).
 *   - `appSubdir` intentionally has NO `.min(1)`: a repo-root target legitimately
 *     uses `''`.
 */
import { z } from "zod";

/**
 * The `verify` command block. Each command string is required and non-empty
 * except `appSubdir`, which may be `''` for a repo-root target.
 */
const VerifySchema = z
  .object({
    install: z.string().min(1),
    test: z.string().min(1),
    typecheck: z.string().min(1),
    build: z.string().min(1),
    // NO .min(1): a repo-root target uses '' (the app is not nested in a subdir).
    appSubdir: z.string(),
  })
  .strict();

/**
 * The `riskCritical` block. The empty-`surface`-requires-acknowledgement rule is
 * a `superRefine` on THIS inner schema (not the top-level manifest) so the
 * emitted issue path nests to `['riskCritical', 'surface']` — a top-level refine
 * would flatten the path and lose the field locality.
 */
const RiskCriticalSchema = z
  .object({
    surface: z.array(z.string()),
    mutationKillFloor: z.number(),
    acknowledgedNoRiskSurface: z.boolean().optional(),
  })
  .strict()
  .superRefine((rc, ctx) => {
    if (rc.surface.length === 0 && rc.acknowledgedNoRiskSurface !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["surface"],
        message:
          "empty riskCritical.surface requires acknowledgedNoRiskSurface:true (the risk gate cannot be silently disabled)",
      });
    }
  });

/**
 * The Target Manifest schema. `.strict()` at the top level rejects unknown keys.
 * This schema is the single source of truth for both the `loadManifest` parser
 * and the inferred `TargetManifest` type below.
 */
export const TargetManifestSchema = z
  .object({
    version: z.number().int(),
    verify: VerifySchema,
    riskCritical: RiskCriticalSchema,
  })
  .strict();

/**
 * The inferred manifest type. Derived from the schema (never hand-written) so the
 * parser and the type can never drift.
 */
export type TargetManifest = z.infer<typeof TargetManifestSchema>;
