import { Router } from "express";
// Issue #954: the dashboard search proxy no longer hand-rolls its own
// `/search/find` fetch (a second, divergent search path that dropped the
// timeout, metrics, and fallback). It calls `trackedOvSearch` — the canonical
// reader — so there is exactly ONE search implementation in src/, carrying the
// OpenViking Request Adapter's transport discipline plus this reader's metrics
// and zero-result fallback.
import {
  getOvSearchMetrics,
  trackedOvSearch,
  loadKnowledgeBaseForPrompt,
} from "../knowledge-base/ov-search.ts";
import { getCoverageStats } from "../knowledge-base/indexer.ts";
import { OpenVikingSearchQuerySchema } from "../schemas/openviking.ts";
import { KnowledgeQuerySchema } from "../schemas/learning.ts";
// Issue #2647/#2717 (relocated here in #3006): the plan-time knowledge fetch
// records two best-effort Redis side effects on its 200 path — the #1440
// per-cycle availability metric and the per-fetch knowledge-retrieval ledger
// row. The accessors' never-throw contracts are owned by the redis seam; this
// router only re-imports them (their logic is unchanged by the move).
import {
  recordKnowledgeContextAvailability,
  appendKnowledgeFetch,
} from "../redis/ov-search-metrics.ts";
import type { KnowledgeLedgerRow } from "../redis/ov-search-metrics.ts";

/**
 * OpenViking proxy + knowledge metrics routes.
 *
 * Extracted from api/misc.ts as part of issue #268 (mirrors the learning.ts
 * split from #219). Issue #954 collapsed the divergent inline search fetch into
 * the canonical `trackedOvSearch` reader.
 *
 * Issue #3006: `GET /learning/knowledge` — the dispatch-served, plan-time
 * knowledge fetch (#2647) — moved here from `src/api/learning.ts`. It wraps the
 * knowledge-base domain this router already fronts (`loadKnowledgeBaseForPrompt`
 * is the agent-scoped OpenViking search), so the knowledge domain's HTTP surface
 * now lives in one file. The URL path is byte-identical (it is a LIVE dispatch
 * contract in the hydra-dev / hydra-target-build playbooks) — only the owning
 * source file changed.
 */

/**
 * Issue #2647 (bag relocated with the route in #3006): injectable deps for the
 * plan-time knowledge route. All optional; each defaults to the real
 * implementation (`deps?.field ?? realImpl`) so production mounts
 * `createOpenVikingRouter()` with no args and observes byte-identical
 * behaviour, while a test can drive the record-on-success invariant
 * deterministically without a live OpenViking / Redis connection.
 */
export interface OpenVikingRouterDeps {
  loadKnowledgeBaseForPrompt?: (
    agent: string,
  ) => Promise<{ content: string; itemCount: number; itemIds: string[] }>;
  recordKnowledgeContextAvailability?: (hadContext: boolean) => Promise<void>;
  // Issue #2717: append one raw ledger row per served knowledge fetch. Injected
  // for deterministic tests; production defaults to the real Redis accessor.
  appendKnowledgeFetch?: (row: KnowledgeLedgerRow) => Promise<void>;
}

export function createOpenVikingRouter(deps: OpenVikingRouterDeps = {}) {
  const router = Router();

  // Issue #2647: resolve the three knowledge-route primitives from the optional
  // deps bag, defaulting to the real implementations. Production passes no deps.
  const loadKnowledgeBaseForPromptFn =
    deps.loadKnowledgeBaseForPrompt ?? loadKnowledgeBaseForPrompt;
  const recordKnowledgeContextAvailabilityFn =
    deps.recordKnowledgeContextAvailability ?? recordKnowledgeContextAvailability;
  const appendKnowledgeFetchFn =
    deps.appendKnowledgeFetch ?? appendKnowledgeFetch;

  // GET /openviking/search — Proxy search to OpenViking via the canonical reader.
  router.get("/openviking/search", async (req, res) => {
    // ADR-0022 slice 3: read `q` + `limit` through the Schemas seam. `q` is a
    // REQUIRED non-empty string, so this route owns its bespoke 400 (inline
    // safeParse) rather than a default-on-garbage read. `limit` collapses bad
    // input to 10 (the legacy `parseInt(...) || 10`).
    const parsed = OpenVikingSearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Missing query parameter 'q'" });
    }
    const { q, limit } = parsed.data;

    // trackedOvSearch never throws — it routes through the OpenViking Request
    // Adapter (timeout + error classification) and folds every failure to an
    // empty `{ resources, memories }`. The proxy surfaces that shape; an OV
    // outage now degrades to an empty result with logged metrics rather than a
    // 502, matching how every other caller of the reader behaves.
    const { resources, memories } = await trackedOvSearch(q, limit);
    res.json({ result: { resources, memories } });
  });

  // GET /openviking-stats — OV search quality metrics (in-memory, resets on restart)
  router.get("/openviking-stats", (_req, res) => {
    res.json(getOvSearchMetrics());
  });

  // GET /learning/coverage — Knowledge index coverage (issue #210).
  // Reports indexed source/doc counts so operators can detect a regression
  // where the indexer is silently failing.
  router.get("/learning/coverage", (_req, res) => {
    res.json(getCoverageStats());
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
          `[openviking-api] knowledge availability record failed: ${recErr?.message ?? recErr}`,
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
          `[openviking-api] knowledge ledger append failed: ${ledgerErr?.message ?? ledgerErr}`,
        );
      }

      res.json({ agent, content, itemCount });
    } catch (err: any) {
      console.error(`[openviking-api] knowledge failed: ${err?.message || String(err)}`);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

  return router;
}
