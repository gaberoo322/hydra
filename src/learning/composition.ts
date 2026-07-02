// ===========================================================================
// getContext — diagnostic trace composer for Hydra's learning subsystems
//
// Issue #2497: the pure learning-composition domain — `getContext()`, its
// public types (`LearningContext`, `LearningContextSource`,
// `LearningContextBlock`, `GetContextDeps`, `SourceRead`) and helpers
// (`runSource()`, `buildContext()`) — relocated here OUT of the HTTP route
// module `src/api/learning.ts`. This module is PURE domain: it imports the
// three learning clusters (pattern-memory, reflections, knowledge-base) and has
// ZERO imports from `src/api/`. The
// route file re-exports these symbols for back-compat so import sites outside
// it (and the dynamic-import path in tests) do not need to change. "How the
// orchestrator composes learning context for a dispatch" now has a real
// domain home rather than being trapped inside an Express route.
//
// Issue #2647: `getContext()` is a PURE diagnostic composer with NO metric side
// effect. The per-cycle knowledge-context-availability record (issue #1440) was
// MOVED OUT of the knowledge-base thunk here into the dispatch-served plan-time
// fetch route (`GET /api/learning/knowledge`, src/api/learning.ts). Recording it
// here polluted the real-cycle `cyclesWithContext` metric with diagnostic-trace
// hits (context-trace is `getContext`'s only live caller, so the counter only
// ever moved on an operator diagnostic — never on an actual dispatch). The
// record now fires ONLY on a dispatch-served knowledge fetch.
//
// Issue #2333 (prior home): folded from src/learning-context.ts into
// src/api/learning.ts (its sole live consumer at the time). The motivating
// observation there — getContext serves a single diagnostic role today — is
// unchanged; #2497 just gives that single concept a domain module instead of
// a route body.
//
// Issue #2225 (earlier home): extracted out of the route into
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
import { loadAgentMemory } from "../pattern-memory/agent-memory.ts";
import { formatMemoryForPrompt } from "../pattern-memory/prompt-format.ts";
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
 * Issue #2141 — the injectable dependency surface for `getContext`. The four
 * fields are the PRIMITIVE source-loaders the per-source thunks call, NOT the
 * thunks themselves: injecting the primitives keeps the production composition
 * logic (formatMemoryForPrompt adaptation, the two-axis reflection composition
 * via loadReflectionsForAnchor) under test while
 * the Redis / OpenViking boundary drops out behind a stub. The two reflection
 * loaders are forwarded into the coordinator's own deps bag (issue #2238).
 *
 * Every field is OPTIONAL; each defaults to the real implementation at the top
 * of `getContext` via `deps?.field ?? realImpl` — the same optional-deps-bag
 * idiom as `AutonomyRateDeps` (src/aggregators/autonomy-rate.ts) and
 * `CollectProbeDeps` (src/health/fan-out.ts). Production callers
 * (the context-trace route) pass no `deps` and observe byte-identical
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
 *                                 attributed in the trace). Issue #2647: this
 *                                 thunk no longer records #1440 context
 *                                 availability — that record moved to the
 *                                 dispatch-served GET /api/learning/knowledge
 *                                 route so the metric tracks real cycles, not
 *                                 diagnostic-trace hits.
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
    // Issue #2647: no per-cycle availability record here. getContext is a pure
    // diagnostic composer; the #1440 `cyclesWithContext` record now fires only
    // on the dispatch-served GET /api/learning/knowledge fetch, so a diagnostic
    // context-trace hit no longer pollutes the real-cycle metric.
    return loadKnowledgeBaseForPromptFn(agent);
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
