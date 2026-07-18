/**
 * Standard Schema seam re-export (tool-scout #3472, additive first slice).
 *
 * [Standard Schema](https://standardschema.dev/) is a shared TypeScript
 * contract — the `~standard` property on any compliant schema object — that
 * Zod, Valibot, ArkType, and ~900 other libraries implement. A schema
 * *consumer* typed against `StandardSchemaV1` accepts any compliant library
 * without importing library-specific types, so a future validation-library
 * swap has a blast radius of one call site instead of a codebase-wide grep.
 *
 * This module is the **discoverability anchor** for that contract: it is the
 * first-party call site CLAUDE.md/ADR-0005 require to justify even a
 * types-only devDependency, and the home future agents grep from when a
 * schema-consumer signature wants to decouple from `z.ZodType`.
 *
 * ## Source
 *
 * The types come from the canonical `@standard-schema/spec` package — pure
 * TypeScript types, zero runtime code, zero install scripts, zero transitive
 * deps. It is added as a **devDependency**: nothing here imports it at
 * runtime, so the ADR-0005 runtime-dependency allowlist and the lavamoat
 * allow-scripts gate are untouched. Zod v4 (already shipping in Hydra) is
 * Standard Schema compliant out of the box and re-exposes this same namespace
 * at `zod/v4/core/standard-schema`, so no Zod change is needed to benefit.
 *
 * ## Scope of this slice (ADDITIVE ONLY)
 *
 * This slice adds the devDep + this re-export and NOTHING else. It does **not**
 * retype `aggregatorRoute` (`src/api/route-helpers.ts`) or any other consumer.
 * That deferral is deliberate: `StandardSchemaV1["~standard"].validate` may be
 * async (`Result | Promise<Result>`) and its `issues[]` is narrowed to
 * `{ message, path? }`, whereas the current Schemas seam relies on Zod's
 * synchronous `safeParse` and projects the full `ZodIssue[]` into the 400
 * `{ code: "schema-validation-failed", issues }` body. Retyping a consumer to
 * this interface would change that client-observable wire shape and force an
 * async rewrite — so any future consumer migration must go through an adapter
 * (in its own scoped slice with a regression test) that maps
 * `~standard.issues` back onto the existing `SchemaValidationError.issues`
 * shape and preserves synchronous validation.
 */

export type {
  StandardSchemaV1,
  StandardTypedV1,
  StandardJSONSchemaV1,
} from "@standard-schema/spec";

import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * The inferred **output** type of a Standard Schema — the value a successful
 * `validate()` produces. Sugar over the namespace helper the spec already
 * ships (`StandardSchemaV1.InferOutput`), analogous to `z.infer<S>` for a Zod
 * consumer.
 *
 * No `SchemaInput<S>` counterpart is provided: `StandardSchemaV1.InferInput`
 * (also re-exported via the namespace above) already covers that direction,
 * and a hand-rolled alias would be redundant.
 */
export type SchemaOutput<S extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<S>;
