import { Router } from "express";
import { listFrictionPatterns } from "../pattern-memory/agent-memory.ts";
import {
  getIneffectivePromotedPatterns,
  getRuleActionLog,
} from "../pattern-memory/rule-effectiveness.ts";
import {
  RuleActionLogQuerySchema,
  ContextTraceQuerySchema,
  ReflectionHealthQuerySchema,
  KnowledgeQuerySchema,
} from "../schemas/learning.ts";
// Issue #2647: the dispatch-served, plan-time knowledge fetch. This route is
// the CONTENT-serving counterpart to the counts-only context-trace: it returns
// the rendered agent-scoped knowledge block (`loadKnowledgeBaseForPrompt`) that
// the dispatch playbooks weave into the implementation plan, and it records the
// #1440 per-cycle availability metric ON ITS SUCCESS PATH — so
// `cyclesWithContext` moves only on a real dispatch fetch, never on a diagnostic
// context-trace hit (the metric side effect moved OUT of getContext, #2647).
import { loadKnowledgeBaseForPrompt } from "../knowledge-base/ov-search.ts";
import {
  recordKnowledgeContextAvailability,
  appendKnowledgeFetch,
} from "../redis/ov-search-metrics.ts";
import type { KnowledgeLedgerRow } from "../redis/ov-search-metrics.ts";
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

const FRICTION_SKILLS = ["hydra-dev", "hydra-target-build", "hydra-qa"] as const;

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

/**
 * GET /learning/ineffective-rules — patterns that were auto-promoted to a
 * feedback file but keep firing at the same (or higher) rate post-promotion.
 *
 * Issue #289: promotion is supposed to durably change agent behavior, but the
 * observed reality is `scope-creep` at 231 hits and `verification-failure` at
 * 438 hits long after promotion. This endpoint surfaces those rules so an
 * operator (or a prompt-evolution agent — see #7) can rewrite or split them
 * into more specific sub-patterns.
 *
 * Response:
 *   {
 *     planner:  IneffectivePromotedPattern[],
 *     executor: IneffectivePromotedPattern[],
 *     skeptic:  IneffectivePromotedPattern[],
 *     totalIneffective: number,
 *   }
 *
 * Each entry includes pre/post firing rates, promotion date, and the ratio
 * between them so reviewers can prioritise the worst offenders.
 */
/**
 * Issue #2647 — injectable deps for the plan-time knowledge route. Both
 * optional; each defaults to the real implementation (`deps?.field ?? realImpl`)
 * so production mounts `createLearningRouter()` with no args and observes
 * byte-identical behaviour, while a test can drive the record-on-success
 * invariant deterministically without a live OpenViking / Redis connection.
 */
export interface LearningRouterDeps {
  loadKnowledgeBaseForPrompt?: (
    agent: string,
  ) => Promise<{ content: string; itemCount: number; itemIds: string[] }>;
  recordKnowledgeContextAvailability?: (hadContext: boolean) => Promise<void>;
  // Issue #2717: append one raw ledger row per served knowledge fetch. Injected
  // for deterministic tests; production defaults to the real Redis accessor.
  appendKnowledgeFetch?: (row: KnowledgeLedgerRow) => Promise<void>;
}

export function createLearningRouter(deps: LearningRouterDeps = {}) {
  const router = Router();

  // Issue #2647: resolve the two knowledge-route primitives from the optional
  // deps bag, defaulting to the real implementations. Production passes no deps.
  const loadKnowledgeBaseForPromptFn =
    deps.loadKnowledgeBaseForPrompt ?? loadKnowledgeBaseForPrompt;
  const recordKnowledgeContextAvailabilityFn =
    deps.recordKnowledgeContextAvailability ?? recordKnowledgeContextAvailability;
  const appendKnowledgeFetchFn =
    deps.appendKnowledgeFetch ?? appendKnowledgeFetch;

  router.get("/learning/ineffective-rules", async (_req, res) => {
    try {
      const [planner, executor, skeptic] = await Promise.all([
        getIneffectivePromotedPatterns("planner"),
        getIneffectivePromotedPatterns("executor"),
        getIneffectivePromotedPatterns("skeptic"),
      ]);
      const totalIneffective = planner.length + executor.length + skeptic.length;
      res.json({ planner, executor, skeptic, totalIneffective });
    } catch (err: any) {
      console.error(`[learning-api] ineffective-rules failed: ${err?.message || String(err)}`);
      res.status(500).json({
        planner: [],
        executor: [],
        skeptic: [],
        totalIneffective: 0,
        errors: [err?.message || String(err)],
      });
    }
  });

  /**
   * GET /learning/rule-action-log — audit trail of auto-demote / alert
   * actions taken by the daily effectiveness check (issue #365). Newest
   * first; capped at RULE_ACTION_LOG_CAP entries.
   *
   * Query param `limit` (default 50, max 200).
   */
  router.get("/learning/rule-action-log", async (req, res) => {
    try {
      // ADR-0022: read `limit` through the Schemas seam (safeParse on the whole
      // req.query). The schema reuses countQuerySchema's coercion, which
      // collapses bad/absent/out-of-range input to the default (50) and clamps
      // to [1, 200] — exactly the legacy `parseInt(...) || 50` + clamp.
      const limit = RuleActionLogQuerySchema.safeParse(req.query).data?.limit ?? 50;
      const entries = await getRuleActionLog(limit);
      res.json({ entries, count: entries.length });
    } catch (err: any) {
      console.error(`[learning-api] rule-action-log failed: ${err?.message || String(err)}`);
      res.status(500).json({ entries: [], count: 0, errors: [err?.message || String(err)] });
    }
  });

  /**
   * GET /learning/friction-patterns — observability surface for the soft
   * friction items captured from subagent runs (issue #512). Returns the
   * aggregated friction patterns keyed by skill, mirroring the shape of
   * `/learning/ineffective-rules` for symmetry.
   */
  router.get("/learning/friction-patterns", async (_req, res) => {
    try {
      const out: Record<string, unknown[]> = {};
      let total = 0;
      for (const skill of FRICTION_SKILLS) {
        const patterns = await listFrictionPatterns(skill);
        out[skill] = patterns;
        total += patterns.length;
      }
      res.json({ ...out, totalPatterns: total });
    } catch (err: any) {
      console.error(`[learning-api] friction-patterns failed: ${err?.message || String(err)}`);
      res.status(500).json({
        totalPatterns: 0,
        errors: [err?.message || String(err)],
      });
    }
  });

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
   * GET /learning/knowledge?agent= — the dispatch-served, plan-time knowledge
   * fetch (issue #2647).
   *
   * This is the CONTENT-serving knowledge route the dispatch playbooks
   * (`hydra-dev`, `hydra-target-build`) fetch at planning time — the same seam
   * where they already read `/api/reflections`, `/api/design-concepts/<ref>`,
   * and `/api/tier`. It wraps `loadKnowledgeBaseForPrompt` (the agent-scoped
   * OpenViking search, top-5 rendered into a prompt block) and returns real
   * `content` the agent weaves into its implementation plan — deliberately NOT
   * the counts-only `/api/learning/context-trace` shape, which omits block
   * `.content` by design (#804/#841) and is a diagnostic composer no dispatch
   * consumes.
   *
   * CRITICAL (issue #2647): this route is the SINGLE place the #1440 per-cycle
   * knowledge-context-availability metric is recorded. The record fires
   * SERVER-SIDE on the success path — any served fetch increments `cyclesTotal`,
   * a non-empty result (`itemCount > 0`) also increments `cyclesWithContext` —
   * so the metric tracks actual dispatch-served fetches, never a diagnostic
   * context-trace hit (the side effect was MOVED here out of `getContext()`).
   * Recording server-side (rather than from a playbook shell block) keeps the
   * record co-located with a real served fetch and sidesteps the single-quoted
   * heredoc / `$VAR`-expansion fragility the dispatch PR-body quoting has.
   *
   * The availability record is best-effort / never-throw: a Redis error is
   * logged and swallowed so it can never break the plan-time fetch the dispatch
   * depends on.
   *
   * Issue #2717: this route ALSO appends one raw row per served fetch to the
   * per-fetch knowledge-retrieval ledger (`appendKnowledgeLedgerRow`) — the
   * dark-tolerant-ledger slice that makes retrieval→outcome attribution possible
   * later. The append is best-effort / never-throws (same contract as the
   * availability record) and fires on EVERY 200 (including an itemCount:0 miss);
   * a 400/500 appends nothing. The optional `anchor` query param is the join key
   * the ledger records against the eventual cycle outcome.
   *
   * Query params:
   *   agent  (required) — the agent/skill name (e.g. `hydra-dev`)
   *   anchor (optional) — the anchor/cycle id (e.g. `issue-2717`) the ledger
   *                       records as the retrieval→outcome join key; `null` when
   *                       the dispatch sends no anchor.
   *
   * Response (200): { agent, content, itemCount }
   *   - `content` is prompt-ready markdown; `""` / `itemCount: 0` on a miss (OV
   *     returned nothing) — a clean no-op the dispatch degrades over silently.
   * Response (400): { error } when `agent` is absent/blank.
   */
  router.get("/learning/knowledge", async (req, res) => {
    // ADR-0022: read query through the Schemas seam. This route owns a bespoke
    // 400 (mirroring context-trace), so it safeParses inline.
    const parsed = KnowledgeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "agent query param is required" });
      return;
    }
    const { agent } = parsed.data;
    const anchor = parsed.data.anchor ?? null;

    try {
      const { content, itemCount, itemIds } = await loadKnowledgeBaseForPromptFn(agent);

      // Issue #2647 / #1440: record per-cycle knowledge-context availability on
      // the SUCCESS path of this dispatch-served fetch. Best-effort and
      // never-throws — a Redis hiccup must not break the plan-time fetch. Any
      // served fetch counts toward cyclesTotal; a non-empty result also counts
      // toward cyclesWithContext (itemCount > 0 ⇔ the block had content).
      try {
        await recordKnowledgeContextAvailabilityFn(itemCount > 0);
      } catch (recErr: any) {
        console.error(
          `[learning-api] knowledge availability record failed: ${recErr?.message ?? recErr}`,
        );
      }

      // Issue #2717: append exactly one raw observation row per served fetch to
      // the per-fetch knowledge-retrieval ledger — the dark-tolerant-ledger
      // slice that makes retrieval→outcome attribution possible later (the
      // correlation slice is deferred until this has volume). The row carries
      // the join key (agent + anchor/cycle id) plus which items were served
      // (stable content-hash ids), so a later analysis can ask "did THESE
      // OpenViking items appear in a successful dispatch?". Best-effort /
      // never-throws — same contract as the availability record above; a Redis
      // hiccup must not break the plan-time fetch. Fires on EVERY 200 (including
      // an itemCount:0 miss, so the denominator is honest); a 400/500 appends
      // nothing (this is on the success path only).
      try {
        await appendKnowledgeFetchFn({
          ts: Date.now(),
          agent,
          anchor,
          itemCount,
          itemIds,
        });
      } catch (ledgerErr: any) {
        console.error(
          `[learning-api] knowledge ledger append failed: ${ledgerErr?.message ?? ledgerErr}`,
        );
      }

      res.json({ agent, content, itemCount });
    } catch (err: any) {
      console.error(`[learning-api] knowledge failed: ${err?.message || String(err)}`);
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
