import { Router } from "express";
import { ContextTraceQuerySchema } from "../schemas/learning.ts";
// Issue #4638 (ADR-0024 §3): `GET /learning/reflection-health` was retired —
// zero callers. Its pure projection, `projectReflectionHealth`
// (src/metrics/reflection-health.ts), stays: GET /api/health/deep's
// reflection rule (src/health/diagnostics.ts) is its live consumer.
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
import { isolateAggregator, schemaValidationError } from "./route-helpers.ts";

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
//     (`/learning/knowledge`) moved to src/api/openviking.ts — since DELETED
//     with the knowledge plane (ADR-0033), along with `/openviking/search`,
//     `/learning/coverage`, the #2717 retrieval ledger and the #1440
//     `cyclesWithContext` metric. None of those routes exist today.
// What remains here is the route genuinely about the LEARNING COMPOSITION
// domain — `/context-trace` (a diagnostic view of `getContext()`'s
// composition). Its sibling `/reflection-health` was retired in #4638.
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
    // and keeps its own response rather than going through aggregatorRoute —
    // built on schemaValidationError so the code:"schema-validation-failed"
    // contract holds (issue #4563).
    const parsed = ContextTraceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        ...schemaValidationError(parsed.error),
        error: "agent, reference, and type query params are required",
      });
      return;
    }
    const { agent, reference, type } = parsed.data;
    const filesParam = parsed.data.files ?? "";
    const files = filesParam
      ? filesParam.split(",").map(s => s.trim()).filter(Boolean)
      : undefined;

    // The bespoke 400 above stays inline; the never-throw-500 isolation now
    // comes from the isolateAggregator seam (route-helpers.ts, #909) — the 500
    // envelope + pino `err`-field log live there once (ADR-0027 eighth sweep).
    return isolateAggregator(res, "learning/context-trace", async () => {
      const ctx = await getContext(agent, { type, reference, files });
      return {
        blocks: ctx.blocks.map(b => ({
          source: b.source,
          status: b.status,
          contentBytes: b.content.length,
          itemCount: b.itemCount,
          ...(b.error ? { error: b.error } : {}),
        })),
        promptBytes: ctx.toPrompt().length,
      };
    });
  });

  return router;
}
