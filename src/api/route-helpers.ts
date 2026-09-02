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
 * EXTENDS the Schemas Seam convention — it does NOT move HTTP request-body
 * validation out of `src/schemas/`. The body-validation seam-check (which
 * targets the request body, not the query string) is unchanged; POST body
 * routes keep their inline body safeParse.
 */

import type { Request, Response } from "express";
import type { z } from "zod";
import { logger } from "../logger.ts";

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
    logger.error(
      { routeLabel, err },
      "aggregator threw despite never-throw contract",
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

/**
 * The structural shape a degradable read produces (issue #4327). Deliberately
 * NOT `github/issues.ts`'s `IssueReadResult` — this module is consumed by
 * non-GitHub aggregators too (`metrics.ts`, `today-page.ts`, `now-page.ts`,
 * `explore-page.ts`) and carries zero domain imports. `IssueReadResult<T>` is
 * assignable to it structurally (its `GhErrorCode` is a string union), so a
 * seam read closure passes through untouched.
 */
export type DegradableRead<T> =
  | { ok: true; rows: T[] }
  | { ok: false; code: string };

/**
 * What {@link degradeIssueRead} hands back: the read's own success arm, or a
 * bare `{ ok: false }` the caller turns into its `degraded: true` /
 * `sourcesOk: false` flag. No `code` on the failure arm — the helper already
 * logged it, and the routes' response shapes never surface it.
 */
export type DegradedReadResult<T> = { ok: true; rows: T[] } | { ok: false };

/**
 * Run a degradable read behind the never-throw-**200** contract (issue #4327,
 * ADR-0034 §5). Awaits `read()`:
 *
 *   - `{ ok: true, rows }`  → returned as-is;
 *   - `{ ok: false, code }` → `logger.error` ONCE with `routeLabel` + `code`,
 *     returns `{ ok: false }`;
 *   - a thrown error        → `logger.error` ONCE with `routeLabel` + `err`
 *     ("read threw despite never-throw seam"), returns `{ ok: false }`.
 *
 * This is the "degrade-to-flag" sibling of {@link isolateAggregator}, NOT a
 * layer on top of it: `isolateAggregator` / `aggregatorRouteNoQuery` convert a
 * throw into a logged **500**, whereas the `/autopilot/*` read routes
 * (`board-state`, `work-queue`, `hitl-grill`) promise a **200** safe default
 * with `degraded: true` on ANY read failure — `collect-state.sh` parses that
 * body to decide whether to fall back to its inline `gh` call, so a 500 would
 * wedge the autopilot turn. The helper therefore never touches `res` and
 * never throws; failure is reported purely through the return value, and the
 * single log site here replaces the two per-route call sites (ok:false branch
 * + thrown branch) each route used to hand-roll.
 */
export async function degradeIssueRead<T>(
  routeLabel: string,
  read: () => Promise<DegradableRead<T>>,
): Promise<DegradedReadResult<T>> {
  try {
    const result = await read();
    if (result.ok === false) {
      logger.error({ routeLabel, code: result.code }, "read failed — degraded");
      return { ok: false };
    }
    return result;
  } catch (err: any) {
    // Belt-and-braces: the seam never throws, but honour the never-throw
    // contract here too — a thrown read degrades, it does not 500.
    logger.error({ routeLabel, err }, "read threw despite never-throw seam");
    return { ok: false };
  }
}
