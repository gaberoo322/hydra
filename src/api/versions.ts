/**
 * Versions read surface (issue #3680, epic #3676 delta).
 *
 *   GET /api/versions → { projects: ProjectVersions[], generatedAt }
 *
 * The dashboard-facing join of two things #3676 already shipped: the semver git
 * tag `scripts/deploy.sh` stamps at deploy (#3677) and the per-PR
 * `.changelog/<issue>-<slug>.md` fragments (#3678). Per release it reports the
 * tag, the date it was cut, the commit it points at, and the curated notes that
 * landed inside that tag-to-tag window. #3681 renders it as the Versions panel.
 *
 * THIN BY DESIGN — every decision (which tag is `current`, how a window is
 * bounded, what counts as a fragment, the per-root cache) lives in
 * `src/versions/read-versions.ts`. This file only mounts the path and hands the
 * body to the aggregator seam.
 *
 * NO ZOD SCHEMA, NO QUERY PARAMS. The route takes no request body and no query
 * string, so it stays off the Schemas Seam entirely — the input-free-GET
 * precedent is `src/api/class-stats.ts` and `src/api/architecture.ts`. The
 * history bound is env-derived (`HYDRA_VERSIONS_HISTORY_LIMIT`), deliberately
 * NOT a `?limit=N` param, which would drag `src/schemas/versions.ts` and the
 * `aggregatorRoute(schema, …)` query path in for a knob nobody asked for.
 *
 * NEVER-THROW. The read degrades a failing repository to
 * `{ current: null, history: [], error: "<code>" }` at HTTP 200 and leaves
 * sibling entries intact (the `src/api/taxonomy.ts` degraded-at-200 precedent) —
 * a blank Versions panel is a worse failure than a card reading "no releases
 * yet". `aggregatorRouteNoQuery` is the outer belt-and-braces isolation, not the
 * primary path. NOTE that at merge time BOTH repositories are legitimately
 * tagless, so an empty response is the EXPECTED live result, not a bug.
 *
 * No `eventBus` parameter: this is a pure read that emits nothing.
 */

import { Router } from "express";

import { aggregatorRouteNoQuery } from "./route-helpers.ts";
import {
  readAllVersions,
  type ProjectVersions,
  type ReadVersionsDeps,
} from "../versions/read-versions.ts";

/** Injectable deps — the read seam plus the clock, all defaulted. */
export type VersionsRouterDeps = ReadVersionsDeps;

/** The wire body of `GET /api/versions`. */
export interface VersionsResponse {
  /**
   * One entry per repository with a version stream. Named `projects` because
   * the #3680 acceptance criterion and #3681's consumer both name it literally;
   * the per-entry `scope: "orch" | "target"` is the machine identity, and prose
   * never calls the Target "the project".
   */
  projects: ProjectVersions[];
  generatedAt: string;
}

export function createVersionsRouter(deps: VersionsRouterDeps = {}) {
  const router = Router();
  const clock = deps.now ?? (() => Date.now());

  router.get(
    "/versions",
    aggregatorRouteNoQuery<VersionsResponse>("versions", async () => ({
      projects: await readAllVersions(deps),
      generatedAt: new Date(clock()).toISOString(),
    })),
  );

  return router;
}
