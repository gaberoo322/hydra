/**
 * test/api-500-catch-ratchet.test.mts — per-file `res.status(500)` ratchet
 * over `src/api/*.ts` (issue #4402, design-concept INV-5 / INV-8).
 *
 * Why this test exists
 * --------------------
 *
 * `src/api/route-helpers.ts` exports `isolateAggregator(res, routeLabel,
 * produce)` — the one seam that owns the never-throw 500 `{ error }` envelope
 * and its pino `err`-field log line (issue #909, ADR-0027). ADR-0022 records
 * that convention-only adoption of the seam decayed into a tail of ~24
 * hand-rolled `catch (err) { res.status(500).json({ error: err.message }) }`
 * blocks across 13 files, each drifting on `err.message` vs
 * `err?.message || String(err)`, `console.error` present or absent, etc.
 *
 * Issue #4402 drained that tail. This test is the drift guard that keeps it
 * drained: it counts the literal `status(500)` per `src/api/*.ts` file and
 * asserts equality with the explicit allowlist below. A new hand-rolled 500
 * catch — or a new file that hand-rolls one — fails `npm test` (the REQUIRED
 * `test` job) unless the allowlist is edited deliberately in the same PR. A
 * sibling advisory workflow could not block auto-merge; a `test/*.test.mts`
 * inside the required job can, with zero `ci.yml` edits.
 *
 * What the allowlist encodes
 * --------------------------
 *
 * Every remaining site is one of:
 *   - a result-object 500 (the module honours a never-throw result contract,
 *     so there is no catch to migrate — holdback.ts x3, autopilot-runs.ts,
 *     autopilot-log.ts journal, outcomes.ts loader, usage.ts dispatch-cost
 *     write-failure, autopilot-lifecycle.ts inner);
 *   - a kept-bespoke catch annotated `Not an isolateAggregator route:` because
 *     the success path is text/plain, a non-200 branch sits inside the try
 *     (404 / 409 / 201), or the 500 carries a specialized envelope
 *     (`{ recorded: false, error }`, `{ ok: false, error }`,
 *     `{ outcomes: [], errors }`, the FrictionPanel degraded bodies);
 *   - the seam line itself in route-helpers.ts.
 *
 * Files absent from the allowlist are expected to contain ZERO sites. Adding
 * a file to `src/api/` that hand-rolls a 500 therefore fails here too.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const API_DIR = join(REPO_ROOT, "src", "api");

/** The literal every hand-rolled or result-object 500 spells. */
const NEEDLE = "status(500)";

/**
 * Per-file allowed `status(500)` counts after the #4402 migration. Files not
 * listed here must contain zero occurrences. Edit deliberately, in the same
 * PR as the route change, with a comment on the route explaining why it is
 * `Not an isolateAggregator route:` (or why it is a result-object branch).
 */
const ALLOWLIST: Record<string, number> = {
  "agents.ts": 1,
  "alerts.ts": 1,
  "autopilot-lifecycle.ts": 1,
  "autopilot-log.ts": 3,
  "autopilot-runs.ts": 1,
  "config.ts": 2,
  "cycles.ts": 1,
  "design-concepts.ts": 5,
  "dispatches.ts": 1,
  "goals.ts": 2,
  "holdback.ts": 3,
  "maintenance.ts": 1,
  "merge-lock.ts": 1,
  "metrics.ts": 1,
  "outcomes.ts": 2,
  "pattern-memory.ts": 4,
  "route-helpers.ts": 1,
  "usage.ts": 2,
};

/** Files whose every 500 site was migrated onto the seam in #4402. */
const DRAINED_IN_4402 = [
  "architecture.ts",
  "attention.ts",
  "capacity.ts",
  "class-stats.ts",
  "digest.ts",
  "events.ts",
  "grounding.ts",
  "scout.ts",
];

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function listApiFiles(): string[] {
  return readdirSync(API_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

function countFor(file: string): number {
  return countOccurrences(readFileSync(join(API_DIR, file), "utf-8"), NEEDLE);
}

describe("api-500-catch-ratchet: src/api/*.ts status(500) allowlist (issue #4402)", () => {
  test("every src/api/*.ts file's status(500) count equals the allowlist (absent => 0)", () => {
    const files = listApiFiles();
    assert.ok(files.length > 0, "src/api/ has TypeScript files");

    const drift: string[] = [];
    for (const file of files) {
      const expected = ALLOWLIST[file] ?? 0;
      const actual = countFor(file);
      if (actual !== expected) {
        drift.push(`  src/api/${file}: expected ${expected}, observed ${actual}`);
      }
    }

    assert.deepEqual(
      drift,
      [],
      `\nHand-rolled res.status(500) drift detected in src/api (issue #4402):\n` +
        drift.join("\n") +
        `\n\nRoute a thrown error through isolateAggregator / aggregatorRouteNoQuery` +
        ` (src/api/route-helpers.ts) instead of a per-route catch. If the route's` +
        ` success path genuinely cannot ride the seam (text/plain send, 404/409/201` +
        ` inside the try, or a specialized 500 envelope), annotate the route with a` +
        ` comment starting "Not an isolateAggregator route:", log through` +
        ` logger.error({ ..., err }) (ADR-0027), and bump the allowlist in` +
        ` test/api-500-catch-ratchet.test.mts in the SAME PR.`,
    );
  });

  test("every allowlisted file still exists (a rename must move its allowlist row)", () => {
    const files = new Set(listApiFiles());
    const missing = Object.keys(ALLOWLIST).filter((f) => !files.has(f));
    assert.deepEqual(
      missing,
      [],
      `allowlist names files that no longer exist under src/api/: ${missing.join(", ")}` +
        ` — move or delete their rows in test/api-500-catch-ratchet.test.mts.`,
    );
  });

  test("the files drained in #4402 contain zero status(500) sites", () => {
    for (const file of DRAINED_IN_4402) {
      assert.equal(
        countFor(file),
        0,
        `src/api/${file} was fully migrated onto the seam in #4402 and must stay at zero status(500) sites`,
      );
    }
  });

  test("route-helpers.ts keeps the single seam line that produces the { error } 500 envelope", () => {
    const src = readFileSync(join(API_DIR, "route-helpers.ts"), "utf-8");
    assert.ok(
      src.includes("return res.status(500).json({ error: err?.message || String(err) });"),
      "isolateAggregator's 500 line is the one definition of the { error } envelope (INV-2)",
    );
    // INV-1: the seam gains no option soup — enforce the seam, do not grow it
    // for the n=1 bespoke routes (ADR-0022 precedent). Word-bounded so the
    // existing `schemaValidationError` identifier (which contains the
    // substring "onError") is not a false positive.
    for (const forbidden of [/\bonError\b/, /\bfallback\b/, /\bcontentType\b/]) {
      assert.ok(
        !forbidden.test(src),
        `route-helpers.ts must not grow a ${forbidden.source} option (INV-1)`,
      );
    }
  });

  test("countOccurrences counts non-overlapping literal matches", () => {
    assert.equal(countOccurrences("", NEEDLE), 0);
    assert.equal(countOccurrences("status(500)", NEEDLE), 1);
    assert.equal(countOccurrences("res.status(500).json(); res.status(500)", NEEDLE), 2);
    assert.equal(countOccurrences("status(400) status(404)", NEEDLE), 0);
  });
});
