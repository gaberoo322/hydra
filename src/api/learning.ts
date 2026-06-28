import { Router } from "express";
import { loadAgentMemory, listFrictionPatterns } from "../pattern-memory/agent-memory.ts";
import { formatMemoryForPrompt } from "../pattern-memory/prompt-format.ts";
import {
  getIneffectivePromotedPatterns,
  getRuleActionLog,
} from "../pattern-memory/rule-effectiveness.ts";
import {
  RuleActionLogQuerySchema,
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
// Issue #2333: concentrate learning-context.ts into src/api/learning.ts.
// src/learning-context.ts was a single-consumer module — its only live
// production caller was this router (GET /api/learning/context-trace). The
// extraction was motivated by separating domain logic from HTTP transport when
// two consumers existed (the in-process planner buildPlannerContext was the
// second). That consumer was retired with the codex control loop in issue #1128
// (ADR-0006). With exactly one HTTP consumer, "domain logic" IS the route
// body — keeping it in a separate file added navigational friction without any
// decoupling benefit. The deletion test (ADR-0014 / issue #2333) passes: folding
// getContext and its public types here concentrates "how the diagnostic trace is
// assembled" at the single HTTP seam that serves it.
//
// Issue #2232 / #2238: reach the reflections domain through its single entry
// point (`./reflections/index.ts`) and delegate the two-axis composition to the
// `loadReflectionsForAnchor` coordinator. The composer used to keep its own
// inline per-anchor + by-file reads with a backfill-then-read ORDERING — that
// ordering existed only to commit a read-time `backfillByFileIndex` SADD before
// the by-file read. Issue #2238 deleted that read-time backfill (it was a dead
// idempotent no-op: `recordAnchorReflection` already backfills at WRITE time
// since #326, and reflections age out at a 7-day TTL, so no un-indexed legacy
// reflection survives). With the side effect gone there is no sequencing
// constraint, so getContext now consumes the coordinator's parallel read and
// projects its `perAnchor` / `byFile` sub-blocks onto the two distinct trace
// blocks — keeping the trace wire shape byte-identical while removing dead code.
// The coordinator stays a PURE read (no Redis write); by-file index correctness
// is preserved by the write-time backfill in `recordAnchorReflection`.
import {
  loadAnchorReflections,
  loadAnchorReflectionsByFile,
  loadReflectionsForAnchor,
  type ReflectionBlock,
} from "../reflections/index.ts";
// Issue #1440: per-cycle knowledge-context-availability tracking. The
// knowledge-base block below records whether the OV search produced non-empty
// context, so the health surface can trend it. Behind a best-effort wrapper so
// a Redis error never breaks trace composition.
import { recordKnowledgeContextAvailability } from "../redis/ov-search-metrics.ts";

// ===========================================================================
// getContext — diagnostic trace composer for Hydra's learning subsystems
//
// Issue #2333: folded from src/learning-context.ts into this module (its sole
// live consumer). See module header above for the consolidation rationale.
//
// Issue #2225 (prior home): extracted out of this file into
// src/learning-context.ts. On today's architecture there is NO in-process
// planner that dispatches this output: the LIVE reflection-injection path is
// `GET /api/reflections` (src/api/reflections.ts), which dispatch skills fetch
// at planning time and which calls the reflection sub-modules directly without
// touching this composer.
//
// getContext() therefore serves a single role now: composing the diagnostic
// view behind GET /api/learning/context-trace — "what learning context *would*
// assemble for anchor X, and which sources have data?". The retired
// cross-cluster-orchestration vocabulary (the `LEARNING_DROP_PRIORITY`
// drop-priority table that fed the dead in-process budgeter, the injectable
// `SourceDescriptor` abstraction, and the generic `loadBlock` over it) was
// removed in issue #2198 because it had zero live consumers — budget/drop
// POLICY now lives in decide.py (ADR-0006/0012), not a TypeScript composer.
// Re-add the drop-order machinery only when a real in-process budgeter returns.
//
// The three learning clusters live as sibling top-level modules:
//   - src/pattern-memory/  — Redis-backed pattern store, promotion, escalation
//   - src/reflections/     — per-anchor + by-file Reflexion-style storage
//   - src/knowledge-base/  — OpenViking search + indexers (source, knowledge)
//
// Issue #2035: the startup + daily-maintenance lifecycle (initLearning,
// consolidate) lives in src/learning-lifecycle.ts, a one-way sibling that
// imports NOTHING from this composer.
// ===========================================================================

/**
 * The sources getContext() composes. The names appear in the public trace,
 * so they're part of the interface — renaming one is a breaking change for
 * anything reading /api/learning/context-trace.
 *
 * Issue #804: `"knowledge-base"` joins the union. OpenViking search used to
 * be folded silently into the `agent-memory` block (inside `loadAgentMemory`);
 * it now surfaces as its own honest block at this composition seam. The OV
 * cluster is still *composed* here, not *owned* here — the dynamic import that
 * reaches OV lives behind the knowledge-base thunk, keeping the cluster
 * boundary visible (see CONTEXT.md — Learning Context).
 *
 * Issue #1454: the `"global-reflections"` member was removed with the dead
 * global reflection buffer subsystem. getContext() now composes four blocks.
 */
export type LearningContextSource =
  | "agent-memory"
  | "knowledge-base"
  | "per-anchor-reflections"
  | "by-file-reflections";

/**
 * Per-source diagnostic envelope. `status` distinguishes three real cases:
 *
 *   - "hit"   — the source returned content; it contributed to the trace.
 *   - "miss"  — the source ran successfully but had nothing to say (steady
 *               state for a brand-new anchor; not a failure).
 *   - "error" — the source threw. `error` is populated. `content` is "".
 *               Detecting an all-error pattern across calls is the operator
 *               signal that something is broken (Redis namespace shift,
 *               by-file index drift, etc.).
 *
 * `content` carries the raw block text for "hit"; empty otherwise.
 *
 * Issue #804: `itemCount` is the structured count of discrete items the block
 * contributed — reflections for the reflection sources, OpenViking memories
 * for `knowledge-base`, promoted-pattern groups for `agent-memory`. It is
 * sourced from the underlying data, NOT regex-scanned out of the rendered
 * markdown. `0` for `miss`/`error` blocks. This is the field that lets
 * reflection-injection telemetry be exact instead of re-parsing the prompt.
 */
export interface LearningContextBlock {
  source: LearningContextSource;
  status: "hit" | "miss" | "error";
  content: string;
  itemCount: number;
  error?: string;
}

/**
 * Structured result of getContext(). Callers that want the composed prompt
 * string (the historical return shape, still consumed by tests asserting the
 * legacy `\n\n`-joined layout) call `toPrompt()`. Callers that want to know
 * *which* sources contributed (the context-trace endpoint, telemetry, tests)
 * inspect `blocks` directly.
 */
export interface LearningContext {
  blocks: LearningContextBlock[];
  /** Join the content of every "hit" block with the legacy "\n\n" separator. */
  toPrompt(): string;
}

function buildContext(blocks: LearningContextBlock[]): LearningContext {
  return {
    blocks,
    toPrompt(): string {
      return blocks
        .filter(b => b.status === "hit" && b.content.length > 0)
        .map(b => b.content)
        .join("\n\n");
    },
  };
}

/**
 * What every learning source's read returns: rendered prompt `content` and the
 * structured `itemCount` of items that contributed to it. Both are sourced
 * from the underlying data inside the source's own read (#804 count-from-data),
 * never re-derived from the rendered markdown at this seam. An empty `content`
 * means the source ran but had nothing to say (→ a `miss` block).
 */
export interface SourceRead {
  content: string;
  itemCount: number;
}

/**
 * Map one source's `{content,itemCount}` read into a `LearningContextBlock`,
 * defining the hit/miss/error envelope ONCE for every source:
 *
 *   - thunk resolves with non-empty `content` → `hit` (itemCount from data)
 *   - thunk resolves with empty `content`     → `miss` (itemCount forced to 0)
 *   - thunk throws                            → `error` (content "", count 0)
 *
 * The envelope is defined here rather than re-hand-rolled per source. (Issue
 * #2198 removed the `SourceDescriptor`/`loadBlock` indirection and the
 * `dropPriority` stamping that fed the retired in-process budgeter; the trace
 * never put `dropPriority` on the wire, so the HTTP response is unchanged.)
 */
async function runSource(
  source: LearningContextSource,
  load: () => Promise<SourceRead>,
): Promise<LearningContextBlock> {
  try {
    const { content, itemCount } = await load();
    if (content.length > 0) {
      return { source, status: "hit", content, itemCount };
    }
    return { source, status: "miss", content: "", itemCount: 0 };
  } catch (err: any) {
    console.error(`[Learning] getContext: ${source} load failed: ${err.message}`);
    return { source, status: "error", content: "", itemCount: 0, error: err.message };
  }
}

/**
 * Best-effort, never-throw wrapper around the per-cycle context-availability
 * record (issue #1440). Observability must never break trace composition, so a
 * Redis error here is logged and swallowed.
 */
async function recordContextAvailability(hadContext: boolean): Promise<void> {
  try {
    await recordKnowledgeContextAvailability(hadContext);
  } catch (err: any) {
    console.error(`[Learning] knowledge-context availability record failed: ${err?.message ?? err}`);
  }
}

/**
 * Issue #2141 — the injectable dependency surface for `getContext`. The four
 * fields are the PRIMITIVE source-loaders the per-source thunks call, NOT the
 * thunks themselves: injecting the primitives keeps the production composition
 * logic (formatMemoryForPrompt adaptation, the two-axis reflection composition
 * via loadReflectionsForAnchor, the #1440 availability record) under test while
 * the Redis / OpenViking boundary drops out behind a stub. The two reflection
 * loaders are forwarded into the coordinator's own deps bag (issue #2238).
 *
 * Every field is OPTIONAL; each defaults to the real implementation at the top
 * of `getContext` via `deps?.field ?? realImpl` — the same optional-deps-bag
 * idiom as `AutonomyRateDeps` (src/aggregators/autonomy-rate.ts) and
 * `CollectProbeDeps` (src/health/fan-out.ts). Production callers
 * (the context-trace route below) pass no `deps` and observe byte-identical
 * behaviour.
 *
 * Field types mirror the loaders' real signatures so a stub is type-checked:
 *   - loadAgentMemory(agent): Promise<string>            — Pattern Memory raw read
 *   - loadKnowledgeBaseForPrompt(agent): Promise<SourceRead> — KB/OpenViking read
 *     (injecting it lets a test pass a plain stub WITHOUT triggering the dynamic
 *     `import('./knowledge-base/ov-search.ts')` the default path keeps)
 *   - loadAnchorReflections(anchorRef): Promise<ReflectionBlock> — per-anchor read
 *   - loadAnchorReflectionsByFile(files, excludeAnchorRef?): Promise<ReflectionBlock>
 */
export interface GetContextDeps {
  loadAgentMemory?: (agent: string) => Promise<string>;
  loadKnowledgeBaseForPrompt?: (agent: string) => Promise<SourceRead>;
  loadAnchorReflections?: (anchorRef: string) => Promise<ReflectionBlock>;
  loadAnchorReflectionsByFile?: (
    files: string[],
    excludeAnchorRef?: string,
  ) => Promise<ReflectionBlock>;
}

/**
 * Compose a diagnostic trace of the learning context for an agent + anchor.
 * Returns a structured trace: each source contributes a block with a status
 * ("hit" / "miss" / "error"). Never throws — sources degrade individually
 * (each read flows through the one `runSource` hit/miss/error envelope).
 *
 * The composed prompt string (what the trace's `promptBytes` measures, and
 * what the legacy tests assert) is available via `result.toPrompt()`.
 *
 * `anchor.files` (optional) hints scope files for the by-file index
 * lookup. When omitted, file paths are extracted from `anchor.reference`.
 *
 * The four sources, in trace order (issue #804 added knowledge-base; issue
 * #1454 removed the dead global-reflections block):
 *
 *   1. agent-memory             — promoted pattern lessons for `agent`; the
 *                                 itemCount is the rendered pattern-group count
 *                                 reported by formatMemoryForPrompt (from data,
 *                                 not a regex over the markdown).
 *   2. knowledge-base           — OpenViking memory search (lifted out of the
 *                                 agent-memory block so OV is honestly
 *                                 attributed in the trace); the thunk also
 *                                 records #1440 context availability.
 *   3. per-anchor-reflections   — legacy verbatim-key match on `reference`,
 *                                 projected from the coordinator's `perAnchor`
 *                                 sub-block (a pure read; issue #2238 deleted
 *                                 the old read-time by-file backfill side
 *                                 effect).
 *   4. by-file-reflections      — reflections from *other* anchors that touched
 *                                 the same files (issue #326), projected from
 *                                 the coordinator's `byFile` sub-block (the
 *                                 extractFilesFromAnchor gate lives inside it).
 */
export async function getContext(
  agent: string,
  anchor: { type: string; reference: string; files?: string[] },
  deps?: GetContextDeps,
): Promise<LearningContext> {
  // Issue #2141: resolve each primitive source-loader from the optional deps
  // bag, defaulting to the real implementation (`deps?.field ?? realImpl`). The
  // per-source thunks below call these resolved *Fn variables, so the
  // production composition logic stays intact while a test can drop in stubs
  // that need no Redis / OpenViking connection. For the knowledge-base loader a
  // provided stub also lets us SKIP the dynamic `import('./knowledge-base/…')`
  // entirely — the default path keeps the lazy import so the OV cluster boundary
  // stays visible (module header / issue #804).
  const loadAgentMemoryFn = deps?.loadAgentMemory ?? loadAgentMemory;
  const loadAnchorReflectionsFn = deps?.loadAnchorReflections ?? loadAnchorReflections;
  const loadAnchorReflectionsByFileFn =
    deps?.loadAnchorReflectionsByFile ?? loadAnchorReflectionsByFile;
  const loadKnowledgeBaseForPromptFn =
    deps?.loadKnowledgeBaseForPrompt ??
    (async (a: string): Promise<SourceRead> => {
      const { loadKnowledgeBaseForPrompt } = await import("../knowledge-base/ov-search.ts");
      return loadKnowledgeBaseForPrompt(a);
    });

  const blocks: LearningContextBlock[] = [];

  blocks.push(await runSource("agent-memory", async () => {
    const memory = await loadAgentMemoryFn(agent);
    // formatMemoryForPrompt reports the rendered pattern-group count from the
    // structured blocks it assembles — the count-from-data source.
    return formatMemoryForPrompt(memory, agent);
  }));

  blocks.push(await runSource("knowledge-base", async () => {
    const read = await loadKnowledgeBaseForPromptFn(agent);
    // Issue #1440: record per-cycle knowledge-context availability so the
    // operator can trend "what fraction of planned cycles saw non-empty
    // knowledge context". itemCount > 0 ⇔ the block had content. Best-effort
    // and never-throws — a Redis hiccup must not break trace composition.
    await recordContextAvailability(read.itemCount > 0);
    return read;
  }));

  // Issue #2238: delegate the two reflection axes to the coordinator. It reads
  // per-anchor + by-file IN PARALLEL (a pure read — no Redis write, no
  // sequencing constraint, the read-time backfill it used to require is gone),
  // then we project its `perAnchor` / `byFile` sub-blocks onto the two distinct
  // trace blocks below so the wire shape stays byte-identical. The injected
  // GetContextDeps reflection loaders forward straight into the coordinator's
  // own deps bag, so the test stub path is unchanged.
  //
  // The coordinator runs ONCE; both thunks `await` the same memoized promise
  // INSIDE their own runSource envelope, so a coordinator throw degrades BOTH
  // reflection blocks to `error` (invariant #4: getContext never throws) — the
  // same per-block error degradation the prior inline reads produced on a Redis
  // fault, without firing the read twice.
  const reflectionsPromise = loadReflectionsForAnchor(anchor.reference, {
    scopeFiles: anchor.files,
    deps: {
      loadAnchorReflections: loadAnchorReflectionsFn,
      loadAnchorReflectionsByFile: loadAnchorReflectionsByFileFn,
    },
  });

  blocks.push(await runSource("per-anchor-reflections", async () => {
    const { perAnchor } = await reflectionsPromise;
    return { content: perAnchor.content, itemCount: perAnchor.count };
  }));

  blocks.push(await runSource("by-file-reflections", async () => {
    const { byFile } = await reflectionsPromise;
    return { content: byFile.content, itemCount: byFile.count };
  }));

  return buildContext(blocks);
}

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
export function createLearningRouter() {
  const router = Router();

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
