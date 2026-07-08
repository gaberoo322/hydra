import { Router } from "express";
import {
  ContextTraceQuerySchema,
  ReflectionHealthQuerySchema,
} from "../schemas/learning.ts";
// Issue #2467: the reflection-deposit observability surface reads the recent
// cycle-metrics window (each row already carries a derived `reflectionMatchSource`
// from `deriveReflectionMatchSource(reflectionSources)`) and projects the bucket
// distribution. This is a PURE READ over the existing metrics trend — it adds NO
// second cycle-record writer (reap.py stays the sole writer; design-concept
// invariant) and NEVER fabricates a non-none bucket from an empty store.
// Issue #2492: `projectReflectionHealth` (and its types) relocated to the
// metrics domain alongside `deriveReflectionMatchSource`; re-exported below for
// this router's existing callers. The route still reads `getMetricsTrend()` and
// feeds the projection — a pure read, no second cycle-record writer.
import { getMetricsTrend, projectReflectionHealth } from "../metrics/trend.ts";
// Issue #2497: the pure learning-composition domain (`getContext` and its
// supporting types/helpers) relocated OUT of this route module into
// src/learning/composition.ts — "how the orchestrator composes learning
// context" now has a real domain home rather than living inside an Express
// route. This router consumes `getContext` for GET /api/learning/context-trace
// and re-exports the domain symbols below for back-compat so import sites
// outside this file (and the dynamic-import path in tests) keep working
// unchanged. The composition module has ZERO imports from src/api/ (it is a
// pure domain module the route happens to consume).
//
// Issue #2333 (prior home): getContext was folded from src/learning-context.ts
// into THIS route module when its only live consumer was this HTTP route. The
// correct fix (issue #2497) was a domain home, not the route file — so it now
// lives in src/learning/composition.ts (see that module's header for the full
// #2225 → #2333 → #2497 lineage).
import { getContext } from "../learning/composition.ts";

// ===========================================================================
// Learning diagnostics router (issue #3006 — focused after the split).
//
// This module previously bundled six structurally-distinct concerns routed to
// three domain homes. Issue #3006 split it into concern-aligned sub-routers:
//   - the read-side pattern-memory diagnostics (`/learning/ineffective-rules`,
//     `/learning/rule-action-log`, `/learning/friction-patterns`) moved to
//     src/api/pattern-memory.ts, beside the write-side /memory/* routes for the
//     same domain;
//   - the plan-time knowledge fetch + its #2647/#2717 telemetry side effects
//     (`/learning/knowledge`) moved to src/api/openviking.ts, which already owns
//     the Knowledge-Base HTTP surface (/openviking/search, /learning/coverage).
// What remains here are the two routes that are genuinely about the LEARNING
// COMPOSITION domain — `/context-trace` (a diagnostic view of `getContext()`'s
// composition) and `/reflection-health` (a pure projection over the metrics
// trend). All route paths are unchanged; only the file boundaries moved.
// ===========================================================================

// Issue #2497: re-export the learning-composition domain for back-compat. The
// route below imports `getContext` directly above; these re-exports keep the
// historical `src/api/learning.ts` import surface stable for any consumer (and
// the dynamic-import path in test/learning-context-trace.test.mts, which now
// has the option to import from the domain module directly).
export type {
  LearningContext,
  LearningContextSource,
  LearningContextBlock,
  SourceRead,
  GetContextDeps,
} from "../learning/composition.ts";
export { getContext } from "../learning/composition.ts";

// ===========================================================================
// Reflection-deposit health (issue #2467; projection relocated to metrics #2492)
//
// The recurring #1912/#2450/#2467/#2492 confusion is that a 100%-`none`
// `reflectionMatchSource` distribution LOOKS like broken telemetry but is the
// HONEST steady state whenever the per-anchor reflection store is empty —
// reflections are PRODUCED only on a non-merged failure (reap.py
// `_fire_reflection_for_completion`), so a high-merge-rate run structurally
// serves nothing and `none` is correct, NOT a regression
// (`deriveReflectionMatchSource("") === "none"` is the contract,
// src/metrics/trend.ts). The operator pain is that the metric alone cannot
// distinguish that honest-none from a genuinely-broken deposit; the dashboard
// just shows a flat `none` baseline.
//
// This surface makes the distinction READABLE without a second writer or a
// fabricated bucket: it reports the bucket distribution over the recent
// cycle-metrics window AND a `verdict` that is honest about ambiguity.
//
// Issue #2492: the PURE projection (`projectReflectionHealth` + its
// `ReflectionHealthReport` / `ReflectionHealthSampleProjection` types) moved to
// the metrics domain (src/metrics/trend.ts, alongside its sibling
// `deriveReflectionMatchSource`) so the deep-health diagnostics seam can consume
// it too — surfacing the verdict where operators actually look (GET
// /api/health/deep) to stop the #1912→#2450→#2467→#2492 re-file loop — WITHOUT
// the pure health seam importing this `src/api/` router (a backwards inward
// edge). They are re-exported here so the route below and its test keep their
// import site unchanged.
// ===========================================================================

export type {
  ReflectionHealthSampleProjection,
  ReflectionHealthReport,
} from "../metrics/trend.ts";
// Value re-export: the pure projection lives in the metrics domain now (#2492),
// but `GET /learning/reflection-health` and the existing test/learning-reflection-
// health.test.mts import it FROM here — keep that import site stable.
export { projectReflectionHealth } from "../metrics/trend.ts";

export function createLearningRouter() {
  const router = Router();

  /**
   * GET /learning/context-trace — diagnostic view of `getContext()`'s
   * COMPOSITION. Answers "what learning context *would* `getContext()`
   * assemble for this agent+anchor, and why is it shallow?" without the
   * operator having to grep server logs.
   *
   * IMPORTANT — composition, NOT a dispatched prompt (issue #841 honesty
   * re-scope): on today's architecture there is no in-process planner that
   * dispatches `getContext()`'s output. The dead in-process assembly path that
   * used to consume it (`buildPlannerContext`) was retired with the codex
   * control loop (issue #1128); `getContext()` now serves only this diagnostic
   * trace, composing a prompt string that no subagent receives. A block
   * reporting `status: "hit"` here therefore means "this source *would*
   * contribute content if this prompt were dispatched" — it does NOT prove a
   * subagent actually received it.
   *
   * The LIVE reflection-injection path is `GET /api/reflections?anchor=&files=`,
   * which the dispatch skills (`hydra-dev`, `hydra-target-build`) fetch at
   * planning time and weave into the real implementation prompt. Use that
   * endpoint — not this trace — to verify reflections reach a retry dispatch.
   * This trace remains a useful composition-level diagnostic (which sources
   * have data for an anchor), but reading it as proof-of-delivery is the
   * false-positive #841 documents.
   *
   * Query params (required):
   *   agent     — agent name (e.g. "planner")
   *   reference — anchor reference string
   *   type      — anchor type (e.g. "codebase-health")
   *
   * Optional:
   *   files — comma-separated file path hint for the by-file index
   *
   * Response:
   *   {
   *     blocks: [
   *       { source, status: "hit" | "miss" | "error",
   *         contentBytes: number, itemCount: number, error?: string }
   *     ],
   *     promptBytes: number,   // size of the COMPOSED (not dispatched) prompt
   *   }
   *
   * Issue #804: `itemCount` (additive) is the structured count of items the
   * block contributed (reflections / OV memories / pattern groups) — sourced
   * from data, not regex-parsed from the rendered prompt. The new
   * `knowledge-base` source also appears here automatically (the trace maps
   * over whatever sources getContext composes).
   *
   * `content` itself is omitted — the trace is for diagnostics, not for
   * exfiltrating prompts. Operators can still read prompts through normal
   * cycle inspection endpoints.
   */
  router.get("/learning/context-trace", async (req, res) => {
    // ADR-0022: read query through the Schemas seam. This route owns a bespoke
    // 400 ("agent, reference, and type are required"), so it safeParses inline
    // and keeps its own response rather than going through aggregatorRoute.
    const parsed = ContextTraceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "agent, reference, and type query params are required" });
      return;
    }
    const { agent, reference, type } = parsed.data;
    const filesParam = parsed.data.files ?? "";
    const files = filesParam
      ? filesParam.split(",").map(s => s.trim()).filter(Boolean)
      : undefined;

    try {
      const ctx = await getContext(agent, { type, reference, files });
      res.json({
        blocks: ctx.blocks.map(b => ({
          source: b.source,
          status: b.status,
          contentBytes: b.content.length,
          itemCount: b.itemCount,
          ...(b.error ? { error: b.error } : {}),
        })),
        promptBytes: ctx.toPrompt().length,
      });
    } catch (err: any) {
      console.error(`[learning-api] context-trace failed: ${err?.message || String(err)}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  /**
   * GET /learning/reflection-health — operator-readable reflection-deposit
   * observability surface (issue #2467).
   *
   * The `reflectionMatchSource` cycle metric reads a flat 100%-`none` whenever
   * the per-anchor reflection store is empty — which is the HONEST steady state
   * in a high-merge-rate run (reflections are produced only on a non-merged
   * failure), NOT a regression. The bare metric cannot distinguish that honest
   * empty-store `none` from a genuinely-broken deposit, so #1912/#2450/#2467
   * keep re-filing the same false alarm. This surface makes the distinction
   * readable: it returns the bucket distribution over the recent cycle-metrics
   * window AND a `verdict` that is explicit about ambiguity (see
   * `ReflectionHealthReport`), keyed on whether any cycle actually carried a
   * present `reflectionSources` deposit.
   *
   * A pure read: it composes `getMetricsTrend()` (which already derives
   * `reflectionMatchSource` per row) through the pure `projectReflectionHealth`
   * tally. No second cycle-record writer, no fabricated bucket.
   *
   * Query param (optional): `count` — window size (default 20, clamped [1,200]).
   *
   * Response (200): a `ReflectionHealthReport`.
   */
  router.get("/learning/reflection-health", async (req, res) => {
    try {
      // ADR-0022: read `count` through the Schemas seam. The schema reuses
      // countQuerySchema's coercion (default-on-garbage 20, clamp [1,200]).
      const count = ReflectionHealthQuerySchema.safeParse(req.query).data?.count ?? 20;
      const cycles = await getMetricsTrend(count);
      res.json(projectReflectionHealth(cycles));
    } catch (err: any) {
      console.error(`[learning-api] reflection-health failed: ${err?.message || String(err)}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
