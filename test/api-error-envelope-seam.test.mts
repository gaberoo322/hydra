/**
 * Structural ratchet + behavioral pin for the isolateAggregator error-envelope
 * seam (issue #4402, completing the #909 migration).
 *
 * `src/api/route-helpers.ts` owns the one canonical never-throw-500 ritual:
 * run `produce()`, log the throw with the route label, answer
 * `500 { error: err?.message || String(err) }`. Issue #4402 drained the tail
 * of hand-rolled copies of that ritual across the src/api route files. This
 * suite keeps the tail drained:
 *
 *   1. STRUCTURAL — scan every `src/api/*.ts` for hand-rolled
 *      `res.status(500).json({ error ... })` sends and require the count to
 *      sit at or below the frozen DOCUMENTED_EXCEPTIONS map. Every entry there
 *      is a route the seam genuinely cannot express (text/plain send,
 *      await-dependent non-500 status, typed err.code discrimination, or a
 *      result-object check that is not a catch at all), documented at the
 *      route itself. A NEW hand-rolled send fails here; the fix is to adopt
 *      isolateAggregator — not to grow the map.
 *
 *   2. BEHAVIORAL — pin the seam's wire contract end-to-end on a migrated
 *      route (GET /api/autopilot/class-stats, whose composer is injectable):
 *      a thrown producer answers 500 with the canonical `{ error }` envelope,
 *      and the best-effort snapshot persist failure stays non-fatal (200).
 *
 * Hermetic: no Redis, no HTTP server — handler-level fakes only, matching the
 * api-class-stats.test.mts idiom. New top-level describes with trivial
 * lifecycles; no shared seam is opened.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createAutopilotClassStatsRouter } from "../src/api/class-stats.ts";
import {
  computeClassScoreboard,
  type ClassScoreboard,
} from "../src/autopilot/class-stats-math.ts";

const SRC_API_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "api",
);

/**
 * The hand-rolled ritual shape this ratchet freezes out: a 500 send whose body
 * is the bare `{ error ... }` envelope. Tolerates the multiline spelling
 * (`res\n  .status(500)\n  .json({`).
 */
const HAND_ROLLED_500 = /res\s*\.\s*status\(500\)\s*\.\s*json\(\s*\{\s*error/g;

/**
 * Frozen residue of hand-rolled 500 `{ error }` sends, per src/api file. Each
 * count is a route the seam cannot express, with the reason inline here AND in
 * a comment at the route. The assertion is `<=`, so draining an entry (welcome!)
 * never breaks this suite; only RAISING a count or adding a new file does.
 */
const DOCUMENTED_EXCEPTIONS: Record<string, number> = {
  // /agents/stream — SSE; the seam JSONs produce's return, a stream can't.
  "agents.ts": 1,
  // POST /alerts/:id/dismiss — mid-loop, await-dependent 404 for a not-found
  // id (comment at the route).
  "alerts.ts": 1,
  // POST /metrics/record — recordCycle result.ok:false maps code→400/500
  // mid-handler (result-object convention, not a catch).
  "autopilot-lifecycle.ts": 1,
  // runs/:runId/log + /journal stream text/plain ("NOT JSON", file header),
  // plus the journal result-check 500.
  "autopilot-log.ts": 3,
  // listRuns result.ok:false check (result-object convention, not a catch).
  "autopilot-runs.ts": 1,
  // GET /config/:section/:name — await-dependent 404 + text/plain send;
  // DELETE /env/:project/:key — await-dependent 404.
  "config.ts": 2,
  // GET /cycle/report/:cycleId — await-dependent 404.
  "cycles.ts": 1,
  // /resolve — await-dependent 404 {found,handle,reason} (QA contract);
  // /:anchorRef GET — await-dependent 404; /approve — typed err.code → 404
  // discrimination in the catch.
  "design-concepts.ts": 3,
  // GET transcript — 404 / not-available branches (comment at the route).
  "dispatches.ts": 1,
  // GET /goals — await-dependent 404; GET /goals/summary — text/plain send.
  "goals.ts": 2,
  // Three result.ok:false checks (result-object convention, not catches).
  "holdback.ts": 3,
  // POST /merge/lock — await-dependent 409 when the lock is held.
  "merge-lock.ts": 1,
  // Outside issue #4402's Files-in-scope list — one leftover site parked for a
  // follow-up sweep. Do not grow it.
  "metrics.ts": 1,
  // GET /memory/:agent — text/plain send (comment at the route).
  "pattern-memory.ts": 1,
};

function countHandRolled500(src: string): number {
  return (src.match(HAND_ROLLED_500) ?? []).length;
}

describe("isolateAggregator seam — structural ratchet (issue #4402)", () => {
  test("the seam itself owns exactly one canonical 500 send", () => {
    const src = readFileSync(join(SRC_API_DIR, "route-helpers.ts"), "utf8");
    assert.equal(
      countHandRolled500(src),
      1,
      "route-helpers.ts isolateAggregator must keep the single canonical " +
        "res.status(500).json({ error }) site",
    );
  });

  test("no src/api file carries hand-rolled 500 error sends beyond the documented exceptions", () => {
    const files = readdirSync(SRC_API_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    assert.ok(files.length > 20, "src/api file scan found the route files");

    const violations: string[] = [];
    for (const f of files) {
      if (f === "route-helpers.ts") continue; // the seam itself — pinned at 1 above
      const allowed = DOCUMENTED_EXCEPTIONS[f] ?? 0;
      const observed = countHandRolled500(
        readFileSync(join(SRC_API_DIR, f), "utf8"),
      );
      if (observed > allowed) {
        violations.push(
          `${f}: ${observed} hand-rolled 500 { error } send(s), ` +
            `${allowed} allowed — adopt isolateAggregator ` +
            `(src/api/route-helpers.ts) or document the exception`,
        );
      }
    }
    assert.deepEqual(
      violations,
      [],
      "hand-rolled never-throw-500 ritual outside the frozen exception map:\n" +
        violations.join("\n") +
        (violations.length ? "\n" : ""),
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioral pin — a migrated route answers a thrown producer with the seam's
// canonical envelope. Uses the class-stats router because its composer and
// persist writer are injectable (no Redis, no server).
// ---------------------------------------------------------------------------

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

async function callClassStats(
  build: () => Promise<ClassScoreboard>,
  persist: (s: ClassScoreboard) => Promise<unknown> = async () => undefined,
): Promise<any> {
  const router = createAutopilotClassStatsRouter(build, persist);
  const handler = findHandler(router, "GET", "/autopilot/class-stats");
  assert.ok(handler, "GET /autopilot/class-stats handler must be registered");
  const res = mockRes();
  await handler({ query: {}, params: {} }, res);
  return res;
}

describe("isolateAggregator seam — wire contract on a migrated route", () => {
  test("a thrown producer answers 500 with the canonical { error } envelope", async () => {
    const res = await callClassStats(async () => {
      throw new Error("boom");
    });
    assert.equal(res._status, 500);
    assert.equal(res._body.error, "boom");
  });

  test("a non-Error throw stringifies instead of crashing the handler", async () => {
    const res = await callClassStats(async () => {
      throw "bare string";
    });
    assert.equal(res._status, 500);
    assert.equal(res._body.error, "bare string");
  });

  test("the best-effort snapshot persist stays non-fatal through the seam", async () => {
    // Composer returns a real (empty-inputs) board; persist REJECTS. The
    // persist failure is swallowed by the route's own .catch (non-fatal by
    // design) and must not surface as a 500 — the read still JSONs at 200.
    const board = computeClassScoreboard([], { metrics: [] }, { now: 1 });
    const res = await callClassStats(
      async () => board,
      async () => {
        throw new Error("persist down");
      },
    );
    assert.equal(res._status, 200);
    assert.equal(res._body.scoreboard, board);
  });
});
