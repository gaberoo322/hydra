/**
 * Aggregator-route composition seam (issue #909).
 *
 * The dashboard-v2 read routes (`today-page.ts`, `now-page.ts`,
 * `outcomes-page.ts`, `explore-page.ts`, `autopilot-idle.ts`, and siblings)
 * all follow one repeated ritual:
 *
 *   1. (optional) validate `req.query` through a zod schema → on failure
 *      return 400 `{ code: "schema-validation-failed", issues }`.
 *   2. run a pure aggregator → JSON the body.
 *   3. wrap the body-producing work in a `try/catch` that converts ANY thrown
 *      error into a logged 500 (`console.error` + `{ error }`), honouring the
 *      CLAUDE.md fail-loud rule and the aggregators' never-throw contract.
 *
 * That ritual was copy-pasted across ~35 `safeParse` sites and ~21 never-throw
 * catch blocks. This module folds *both* halves — the validate-or-400 AND the
 * never-throw-500 isolation — into one seam so:
 *
 *   - the `schema-validation-failed` envelope lives in exactly one place;
 *   - the "aggregator threw despite never-throw contract" log string lives in
 *     exactly one place;
 *   - a route can no longer *forget* the catch (a real silent-crash hazard);
 *   - the validate-then-isolate behaviour is one tested surface, not 35
 *     near-identical per-route assertions.
 *
 * Scope (see CONTEXT.md): this is the **query/aggregator-route** shape only. It
 * EXTENDS the Schemas Seam convention — it does NOT move HTTP *body* validation
 * out of `src/schemas/`. The body-validation seam-check (which targets
 * `req.body`, not `req.query`) is unchanged; POST body routes keep their inline
 * `req.body` safeParse.
 */

import type { Request, Response } from "express";
import type { z } from "zod";

/**
 * The 400 envelope shape returned on a failed query parse. Mirrors the
 * `schema-validation-failed` contract every `src/api/*` route already returns
 * (CLAUDE.md: HTTP request validation → 400 `{ code, issues }`).
 */
export interface SchemaValidationError {
  code: "schema-validation-failed";
  issues: z.ZodError["issues"];
}

/**
 * Build the canonical `schema-validation-failed` 400 envelope from a zod parse
 * failure. One place owns the `code` literal and the `issues` projection.
 */
export function schemaValidationError(
  error: z.ZodError,
): SchemaValidationError {
  return { code: "schema-validation-failed", issues: error.issues };
}

/**
 * Wrap a body-producing async function in the never-throw 500 isolation. Runs
 * `produce()`; on success JSONs the body, on a thrown error logs it with
 * `routeLabel` context (the CLAUDE.md fail-loud rule — never a silent catch)
 * and returns a 500 `{ error }`. The `routeLabel` matches the existing log
 * convention, e.g. `v2/today/summary`.
 *
 * This is the never-throw half of the seam, exported separately so a route
 * that has no query schema (or does its own validation) can still get the
 * single-site failure isolation without re-spelling the catch.
 */
export async function isolateAggregator<T>(
  res: Response,
  routeLabel: string,
  produce: () => Promise<T>,
): Promise<Response> {
  try {
    const body = await produce();
    return res.json(body);
  } catch (err: any) {
    console.error(
      `[${routeLabel}] aggregator threw despite never-throw contract: ${err?.message || err}`,
    );
    return res.status(500).json({ error: err?.message || String(err) });
  }
}

/**
 * Compose a validated aggregator GET route. Given a query `schema` and a
 * `produce` handler, returns an Express request handler that:
 *
 *   1. `schema.safeParse(req.query ?? {})` → 400 `schema-validation-failed` on
 *      failure (the validate half);
 *   2. runs `produce(validatedData, req)` inside the never-throw 500 isolation
 *      (the isolate half).
 *
 * `produce` returns the response body to JSON. Routes shrink to "this schema,
 * this aggregator, this body shape" — the 400 envelope, the error-code literal,
 * and the never-throw catch are all behind the seam.
 */
export function aggregatorRoute<S extends z.ZodType, T>(
  schema: S,
  routeLabel: string,
  produce: (data: z.infer<S>, req: Request) => Promise<T>,
): (req: Request, res: Response) => Promise<Response> {
  return async (req, res) => {
    const parsed = schema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json(schemaValidationError(parsed.error));
    }
    return isolateAggregator(res, routeLabel, () => produce(parsed.data, req));
  };
}

/**
 * Compose an unvalidated aggregator GET route — the no-query shape (e.g.
 * `/now/service-strip`, `/explore/friction`). Same never-throw 500 isolation,
 * no parse step. `produce` receives the raw `req` for the handful of routes
 * that read params or headers without a query schema.
 */
export function aggregatorRouteNoQuery<T>(
  routeLabel: string,
  produce: (req: Request) => Promise<T>,
): (req: Request, res: Response) => Promise<Response> {
  return async (req, res) =>
    isolateAggregator(res, routeLabel, () => produce(req));
}
