/**
 * Ratchet: no NEW hand-rolled `res.status(500)` catch may appear under
 * `src/api/*.ts` without deliberately widening this allowlist (issue #4402,
 * architecture-scan follow-up to #909).
 *
 * WHY A RATCHET AND NOT A ONE-TIME SWEEP. `src/api/route-helpers.ts` already
 * exports `isolateAggregator` — a general try/produce/catch/log/500 wrapper
 * proven on mutation routes, not just GET aggregators — and 16+ files already
 * called it before this issue. Despite that, ~19 more files independently
 * re-derived the same "log + 500 { error }" ritual by hand, with details
 * drifting across sites (`err.message` vs `err?.message || String(err)`,
 * `console.error` present in some, absent in others, a hardcoded string in
 * others). #4402 migrated every migratable site onto the seam. Without this
 * ratchet the tail regrows silently: a new route added tomorrow can copy an
 * old hand-rolled pattern instead of the seam, and nothing would notice until
 * the next architecture scan finds it — same drift, one cycle later.
 *
 * WHAT THIS DOES NOT DO. It does not force every remaining hand-rolled catch
 * onto the seam — a handful of routes have a success shape `isolateAggregator`
 * genuinely cannot express (text/plain, a 404/409/201 branch inside the try, a
 * specialized error envelope like `{ ok: false, error }` or
 * `{ outcomes: [], errors }`). Those are legitimate and documented inline with
 * a `Not an isolateAggregator route:` comment (ADR-0022: enforce the seam, do
 * not grow the wrapper for n=1). This test freezes their COUNT per file, not
 * their existence — a file's count can only change by editing the allowlist
 * in the same PR, which is the intended escape hatch (mirrors the shrink-only
 * ratchet convention in `test/adr-roster.test.mts` / `skill-size-ratchet`).
 *
 * A file not present in ALLOWLIST is asserted to have COUNT 0 — the default
 * for every route module that already goes through `isolateAggregator` /
 * `aggregatorRoute*` end to end.
 *
 * Pure filesystem read + regex count, no Redis, no running service.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const API_DIR = resolve(import.meta.dirname, "../src/api");

/**
 * Explicit per-file allowlist of hand-rolled `res.status(500)` occurrences
 * that stay OUTSIDE the `isolateAggregator` seam, plus the seam module's own
 * canonical definition line. Every count here is the file's TOTAL — not just
 * the ones this PR touched — so an unrelated future PR that adds one more
 * hand-rolled 500 to, say, `holdback.ts` fails here and must widen this map
 * deliberately, in the same PR, the same way `suite-count-baseline.json` and
 * `adr-area-baseline.json` are deliberately re-baselined.
 */
const ALLOWLIST: Record<string, number> = {
  // The seam's own definition (`isolateAggregator`'s canonical 500 line).
  "route-helpers.ts": 1,

  // Kept-bespoke sites this PR (#4402) migrated everything ELSE away from —
  // each has an inline `Not an isolateAggregator route:` comment naming why.
  "alerts.ts": 1, // POST /alerts/:id/dismiss — success path writes a 404 inside the try.
  "config.ts": 2, // GET /config/:section/:name (text/plain) + DELETE /env/:project/:key (404 inside try).
  "cycles.ts": 1, // GET /cycle/report/:cycleId — success path writes a 404 inside the try.
  "merge-lock.ts": 1, // POST /merge/lock — success path writes a 409 inside the try.
  "usage.ts": 2, // POST /usage/dispatch-cost — specialized { recorded: false, error } envelope (write-failure branch + catch).

  // Pre-existing bespoke sites #4402 left untouched or only relogged through
  // `logger.error` in place (never migrated — see file-local comments).
  "agents.ts": 1,
  "autopilot-lifecycle.ts": 1, // POST /metrics/record — dynamic 400/500 from a result-object code.
  "autopilot-log.ts": 3, // two text/plain streaming routes + a result-object journal-read failure.
  "autopilot-runs.ts": 1,
  "design-concepts.ts": 5,
  "dispatches.ts": 1,
  "goals.ts": 2, // GET /goals (404 inside try) + GET /goals/summary (text/plain).
  "holdback.ts": 3,
  "maintenance.ts": 1, // specialized { ok: false, error } envelope.
  "metrics.ts": 1,
  "outcomes.ts": 2, // specialized { outcomes: [], errors } envelope (result-object branch + catch).
  "pattern-memory.ts": 4,
};

function countStatus500(source: string): number {
  const matches = source.match(/status\(500\)/g);
  return matches ? matches.length : 0;
}

describe("src/api/*.ts hand-rolled 500-catch ratchet (issue #4402)", () => {
  const files = readdirSync(API_DIR).filter((f) => f.endsWith(".ts"));

  test("every allowlisted file exists under src/api/", () => {
    for (const name of Object.keys(ALLOWLIST)) {
      assert.ok(
        files.includes(name),
        `ALLOWLIST references src/api/${name}, which no longer exists — remove its entry`,
      );
    }
  });

  test("per-file res.status(500) counts match the allowlist exactly (0 when absent)", () => {
    const violations: string[] = [];
    for (const name of files) {
      const source = readFileSync(resolve(API_DIR, name), "utf8");
      const actual = countStatus500(source);
      const expected = ALLOWLIST[name] ?? 0;
      if (actual !== expected) {
        violations.push(`${name}: expected ${expected}, found ${actual}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      `hand-rolled res.status(500) count drifted from the allowlist:\n${violations.join("\n")}\n` +
        "If this is a deliberate new bespoke catch (a success shape isolateAggregator " +
        "genuinely can't express), widen ALLOWLIST in this same PR and document the " +
        "reason inline with a 'Not an isolateAggregator route:' comment. If it's a " +
        "route that CAN adopt the seam, migrate it to isolateAggregator instead.",
    );
  });
});
