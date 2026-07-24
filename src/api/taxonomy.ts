/**
 * Dispatch-class taxonomy HTTP surface (issue #2524).
 *
 *   GET /api/taxonomy/classes → TaxonomyClassesResponse
 *
 * The **Dispatch-Class Taxonomy** (`scripts/autopilot/classes.json`, surfaced
 * as typed views by `src/taxonomy/classes.ts`) is the single machine-readable
 * table owning the autopilot class alphabet. `decide.py` derives its
 * `PIPELINE_SLOTS` / `SIGNAL_CLASSES` / `SIGNAL_COOLDOWNS` tuples from it, so
 * the Python and TS views can never drift.
 *
 * But the dashboard hard-codes three independent copies of this alphabet —
 * `dashboard/src/pages/Autopilot.jsx` (PIPELINE_SLOTS / SIGNAL_CLASSES /
 * SIGNAL_COOLDOWN_SEC) and `dashboard/src/pages/now-pixel/sprite-map.ts`
 * (PIPELINE_CLASSES / SIGNAL_CLASSES / SIGNAL_COOLDOWNS). Those copies already
 * diverge and force a 3-4 file manual edit whenever a class is added or
 * retired. This route exposes the authoritative typed views over HTTP so the
 * dashboard fetches the alphabet instead of mirroring it — concentrating
 * ownership in `classes.json` rather than dispersing it.
 *
 * This route is a thin, READ-ONLY adapter over `src/taxonomy/classes.ts`. Like
 * `autopilot-board.ts`, the single read is an overridable `deps` loader so
 * tests stub the taxonomy without the real file, and the projection math is a
 * pure exported function ({@link deriveTaxonomyClasses}) the tests pin
 * directly. The route never re-spells a class name, slot order, or cooldown
 * value — `classes.json` stays the single source of truth (it is NOT modified
 * by this deepening).
 *
 * Never-throw contract (CLAUDE.md): the taxonomy module hard-fails loudly at
 * IMPORT time on a malformed file (its documented fail-loud invariant), so a
 * served process always has a valid table. As belt-and-braces this route still
 * degrades a runtime read failure to the empty SAFE DEFAULT with
 * `degraded: true` plus a logged `logger.error`, NOT a 500. The only non-200
 * is a 400 `schema-validation-failed` for a malformed query. No `eventBus`
 * parameter is needed (pure read), consistent with `createAutopilotBoardRouter`.
 */

import { Router } from "express";

import {
  TaxonomyClassesQuerySchema,
  type TaxonomyClassesResponse,
  type TaxonomyClassRow,
} from "../schemas/taxonomy.ts";
import {
  DISPATCH_CLASSES,
  PIPELINE_SLOT_NAMES,
  SIGNAL_CLASS_NAMES,
  SIGNAL_CLASS_COOLDOWNS,
  type DispatchClassRow,
} from "../taxonomy/classes.ts";
import { logger } from "../logger.ts";

// ---------------------------------------------------------------------------
// The loaded views the route reads — one authoritative source
// ---------------------------------------------------------------------------

/**
 * The four typed views the route projects to JSON. This is exactly the set
 * `src/taxonomy/classes.ts` already derives from `classes.json`; the route
 * never re-derives them. Bundled into one object so a test can inject a fixture
 * in a single dep override, mirroring `autopilot-board.ts`'s `readOpenIssues`.
 */
export interface TaxonomyViews {
  readonly classes: readonly DispatchClassRow[];
  readonly pipelineSlots: readonly string[];
  readonly signalClasses: readonly string[];
  readonly signalCooldowns: Readonly<Record<string, number>>;
}

/** Default loader — the live typed views over `classes.json`. */
export function defaultLoadTaxonomy(): TaxonomyViews {
  return {
    classes: DISPATCH_CLASSES,
    pipelineSlots: PIPELINE_SLOT_NAMES,
    signalClasses: SIGNAL_CLASS_NAMES,
    signalCooldowns: SIGNAL_CLASS_COOLDOWNS,
  };
}

// ---------------------------------------------------------------------------
// Pure projection — exported for tests
// ---------------------------------------------------------------------------

/**
 * Project the typed taxonomy views into the wire shape. Pure (no I/O); the
 * route and tests pin it directly. A row's optional `notes` is carried through
 * only when present, matching the typed module's "explicit null, never absent"
 * column contract for the nullable columns.
 */
export function deriveTaxonomyClasses(
  views: TaxonomyViews,
): Omit<TaxonomyClassesResponse, "degraded" | "generatedAt"> {
  const classes: TaxonomyClassRow[] = views.classes.map((r) => ({
    name: r.name,
    kind: r.kind,
    skill: r.skill,
    costClass: r.costClass,
    learningAgent: r.learningAgent,
    cooldownSeconds: r.cooldownSeconds,
    scope: r.scope,
    provenanceLabel: r.provenanceLabel,
    ...(typeof r.notes === "string" ? { notes: r.notes } : {}),
  }));
  return {
    classes,
    pipelineSlots: [...views.pipelineSlots],
    signalClasses: [...views.signalClasses],
    signalCooldowns: { ...views.signalCooldowns },
  };
}

// ---------------------------------------------------------------------------
// The empty safe default (degraded read)
// ---------------------------------------------------------------------------

function emptyTaxonomy(): Omit<
  TaxonomyClassesResponse,
  "degraded" | "generatedAt"
> {
  return {
    classes: [],
    pipelineSlots: [],
    signalClasses: [],
    signalCooldowns: {},
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/** Loader for the taxonomy views. Defaults to the live typed module. */
interface TaxonomyLoader {
  (): TaxonomyViews;
}

export interface TaxonomyRouterDeps {
  /**
   * Loader for the dispatch-class views. Defaults to {@link defaultLoadTaxonomy}
   * (the live `src/taxonomy/classes.ts` exports). A throw degrades to the empty
   * `degraded: true` body — never a 500.
   */
  loadTaxonomy?: TaxonomyLoader;
  /** Clock — defaults to `() => Date.now()`. Injected so `generatedAt` is testable. */
  now?: () => number;
}

export function createTaxonomyRouter(deps: TaxonomyRouterDeps = {}) {
  const router = Router();
  const loadTaxonomy = deps.loadTaxonomy ?? defaultLoadTaxonomy;
  const clock = deps.now ?? (() => Date.now());

  router.get("/taxonomy/classes", (req, res) => {
    const parsed = TaxonomyClassesQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        code: "schema-validation-failed",
        issues: parsed.error.issues,
      });
    }

    const nowMs = clock();
    let projection = emptyTaxonomy();
    let degraded = false;

    try {
      projection = deriveTaxonomyClasses(loadTaxonomy());
    } catch (err: any) {
      // The taxonomy module hard-fails at import, so a served process always
      // has a valid table; honour the never-throw contract here anyway — a
      // thrown load degrades to the empty default, it does not 500.
      degraded = true;
      // Not a 500: the empty-alphabet body (with degraded:true) IS the
      // never-throw SAFE DEFAULT, so the isolateAggregator seam does not apply.
      // ADR-0027 eighth sweep: the log adopts the pino `err`-field seam.
      logger.error(
        { err },
        "[taxonomy/classes] taxonomy load threw — degraded empty alphabet",
      );
    }

    const body: TaxonomyClassesResponse = {
      ...projection,
      degraded,
      generatedAt: new Date(nowMs).toISOString(),
    };
    return res.json(body);
  });

  return router;
}
