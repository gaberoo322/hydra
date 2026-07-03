/**
 * Query-param schemas for the learning read routes (ADR-0022, slice 2).
 *
 * ADR-0022 brought `req.query` validation into the **Schemas** Seam for GET
 * read routes: every handler reads `req.query` through a `src/schemas/*` zod
 * schema, never via raw `parseInt(req.query.x)` / `typeof req.query.x ===
 * "string"`. This module owns the two `learning.ts` query surfaces:
 *
 *   - `GET /learning/rule-action-log?limit=N` — numeric pager, reuses the
 *     shared `countQuerySchema` factory (the `parseInt(...) || N` idiom) with
 *     the route's historic default (50) and cap (200).
 *   - `GET /learning/context-trace?agent=&reference=&type=&files=` — three
 *     REQUIRED string params plus an optional `files` CSV. This route owns a
 *     bespoke 400 ("agent, reference, and type query params are required"), so
 *     per ADR-0022 §1 it `safeParse`s inline and keeps its own response shape
 *     rather than going through `aggregatorRoute`'s hard 500.
 */
import { z } from "zod";
import { countQuerySchema } from "./common.ts";

/**
 * `GET /learning/rule-action-log?limit=N`.
 *
 * The wire param is named `limit`. The legacy read was
 * `parseInt(req.query.limit ?? "50") || 50` clamped to `[1, 200]`, which is
 * exactly `countQuerySchema`'s default-on-garbage + clamp contract — so we
 * REUSE the factory's coercion (`.shape.count`) under the `limit` field name.
 * The route passes the WHOLE `req.query` to `safeParse` (no raw
 * `req.query.<field>` read), and the schema picks the named field; unknown
 * params are ignored (non-strict object).
 */
export const RuleActionLogQuerySchema = z.object({
  limit: countQuerySchema(50, 200).shape.count,
});

/**
 * `GET /learning/context-trace?agent=&reference=&type=&files=`.
 *
 * `agent`, `reference`, and `type` are REQUIRED non-empty strings — an absent
 * or whitespace-only value can never address a real context composition, so
 * the route rejects it at the boundary (bespoke 400). `files` is an optional
 * comma-separated path hint for the by-file index.
 *
 * Non-strict (a plain object schema ignores unknown keys) so the route can
 * still parse these fields without tripping on any other query param.
 */
export const ContextTraceQuerySchema = z.object({
  agent: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  type: z.string().trim().min(1),
  files: z.string().optional(),
});

/**
 * `GET /learning/reflection-health?count=N` (issue #2467).
 *
 * The window-size pager for the reflection-deposit observability surface. The
 * wire param is named `count`; it REUSES `countQuerySchema`'s coercion
 * (`parseInt(...) || N`, clamped to `[1, max]`) with the route's default (20,
 * matching `getMetricsTrend`'s default window) and cap (200). Garbage / absent
 * / out-of-range values collapse to the default exactly like the rule-action
 * pager above. Non-strict so any other query param is ignored.
 */
export const ReflectionHealthQuerySchema = z.object({
  count: countQuerySchema(20, 200).shape.count,
});

/**
 * `GET /learning/knowledge?agent=` (issue #2647).
 *
 * The dispatch-served, plan-time knowledge fetch. `agent` is a REQUIRED
 * non-empty string (the skill name, e.g. `hydra-dev`) — it scopes the
 * OpenViking search (`loadKnowledgeBaseForPrompt`) to that agent's learned
 * patterns. An absent/whitespace-only value can never address a real knowledge
 * search, so the route rejects it at the boundary (bespoke 400) — mirroring the
 * `ContextTraceQuerySchema` required-string idiom. Non-strict so any other
 * query param is ignored.
 *
 * `anchor` (issue #2717) is an OPTIONAL anchor/cycle identifier (e.g.
 * `issue-2717`) the dispatch may send so the per-fetch knowledge-retrieval
 * ledger can record the join key between the retrieval and the eventual cycle
 * outcome. It is optional so an anchor-less fetch (or a caller that predates the
 * ledger) still succeeds — the ledger row records a `null` anchor in that case.
 */
export const KnowledgeQuerySchema = z.object({
  agent: z.string().trim().min(1),
  anchor: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().min(1).optional(),
  ),
});
