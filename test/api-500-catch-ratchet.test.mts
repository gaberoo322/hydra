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
 *   1. STRUCTURAL — count RAW `status(500)` occurrences in every `src/api/*.ts`
 *      and require the count to EQUAL the frozen EXPECTED_500_COUNTS map,
 *      entry for entry (and 0 for every file absent from it). Raw counting is
 *      deliberate: it is immune to envelope-shape drift (`{ error }` vs
 *      `{ recorded:false, error }` vs `{ outcomes: [], errors }`), so ANY new
 *      500 send — whatever its body — trips the ratchet. Exact equality (not
 *      `<=`) also trips when a count DROPS: the map then understates reality
 *      and must be regenerated in the same PR that changed it.
 *
 *      Every non-zero entry is a route the seam genuinely cannot express
 *      (text/plain send, await-dependent non-500 status, typed err.code
 *      discrimination, a specialized degraded envelope, or a result-object
 *      check that is not a catch at all), documented here AND in a comment at
 *      the route. The fix for a violation is to adopt isolateAggregator — or,
 *      when a route legitimately enters/leaves the kept set, to update this
 *      map in the same PR with the reason.
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
 * Exact per-file count of `status(500)` occurrences across `src/api/*.ts`
 * after the issue #4402 drain. Raw textual occurrences — every spelling
 * (`res.status(500).json(...)`, multiline chains) contains the substring.
 */
const EXPECTED_500_COUNTS: Record<string, number> = {
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
  // exempt-log POST + resolve + /:anchorRef GET + create + approve — each
  // keeps an await-dependent 404 / typed err.code→404 discrimination /
  // res.status(201) success the seam (JSON-at-200) can't express.
  "design-concepts.ts": 5,
  // GET transcript — 404 / not-available branches (comment at the route).
  "dispatches.ts": 1,
  // GET /goals — await-dependent 404; GET /goals/summary — text/plain send.
  "goals.ts": 2,
  // Three result.ok:false checks (result-object convention, not catches).
  "holdback.ts": 3,
  // POST /maintenance/housekeeping — keeps the `{ ok:false, error }` envelope
  // housekeeping.sh logs verbatim (comment at the route).
  "maintenance.ts": 1,
  // POST /merge/lock — await-dependent 409 when the lock is held.
  "merge-lock.ts": 1,
  // Outside issue #4402's Files-in-scope list — one leftover site parked for a
  // follow-up sweep. Do not grow it.
  "metrics.ts": 1,
  // GET /outcomes — the degraded `{ outcomes: [], errors }` envelope is the
  // dashboard contract: one result.ok:false arm + one defensive catch.
  "outcomes.ts": 2,
  // GET /memory/:agent — text/plain send; ineffective-rules /
  // rule-action-log / friction-patterns — specialized degraded envelopes the
  // uniform `{ error }` shape can't express (comments at the routes).
  "pattern-memory.ts": 4,
  // The seam itself: isolateAggregator's single canonical 500 send.
  "route-helpers.ts": 1,
  // POST /usage/dispatch-cost — keeps the paired `recorded:false` envelope so
  // both failure arms of the recorder answer the same shape.
  "usage.ts": 2,
};

function countRaw500(src: string): number {
  return src.split("status(500)").length - 1;
}

describe("isolateAggregator seam — structural ratchet (issue #4402)", () => {
  test("every src/api file's raw status(500) count equals the frozen map exactly", () => {
    const files = readdirSync(SRC_API_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    assert.ok(files.length > 20, "src/api file scan found the route files");

    const violations: string[] = [];
    for (const f of files) {
      const expected = EXPECTED_500_COUNTS[f] ?? 0;
      const observed = countRaw500(
        readFileSync(join(SRC_API_DIR, f), "utf8"),
      );
      if (observed !== expected) {
        violations.push(
          `${f}: observed ${observed} status(500) occurrence(s), ` +
            `${expected} expected — adopt isolateAggregator ` +
            `(src/api/route-helpers.ts) for a new 500 send, or update ` +
            `EXPECTED_500_COUNTS in this test in the same PR when the kept ` +
            `set legitimately changes`,
        );
      }
    }
    // A stale map entry (file deleted/renamed) must fail too, not rot.
    const knownFiles = new Set(files);
    for (const f of Object.keys(EXPECTED_500_COUNTS)) {
      if (!knownFiles.has(f)) {
        violations.push(
          `${f}: listed in EXPECTED_500_COUNTS but no such file under src/api ` +
            `— prune the stale map entry`,
        );
      }
    }
    assert.deepEqual(
      violations,
      [],
      "hand-rolled never-throw-500 ritual outside the frozen count map:\n" +
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
