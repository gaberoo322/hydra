/**
 * Regression tests for `src/scout/calendar-walk.ts` (issue #485 — Phase B
 * of the /hydra-tool-scout epic).
 *
 * Coverage:
 *
 *   1. parseCategorySlugs — pure markdown parser, no I/O.
 *   2. isCooledDown — pure cooldown predicate over (lastIso, days, now).
 *   3. listRuntimeDependencies — reads orch + dashboard package.json from disk.
 *   4. planWalk — end-to-end against a temp HYDRA_ROOT (filesystem + Redis).
 *   5. Cooldown stamping (stampClassWalk / stampCategoryWalk + readback).
 *   6. Category cooldown skip logic (skipped vs eligible bucket).
 *
 * The Redis-touching tests use DB 1 + a file-level `after` hook to close
 * sockets — same pattern as `scout-seen-list.test.mts`.
 */

import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Redis from "ioredis";

process.env.REDIS_URL = "redis://localhost:6379/1";

const {
  parseCategorySlugs,
  isCooledDown,
  listRuntimeDependencies,
  planWalk,
  stampClassWalk,
  stampCategoryWalk,
  isClassCooledDown,
  isCategoryCooledDown,
  CLASS_COOLDOWN_DAYS,
  CATEGORY_COOLDOWN_DAYS,
  SCOUT_DAILY_COST_SHARE,
} = await import("../src/scout/calendar-walk.ts");

let testRedis: any = null;
function getTestRedis(): any {
  if (!testRedis) testRedis = new Redis("redis://localhost:6379/1");
  return testRedis;
}

async function cleanScoutKeys(): Promise<void> {
  const r = getTestRedis();
  const patterns = [
    "hydra:scout:last-calendar-walk",
    "hydra:scout:category-last-walked:*",
    "hydra:scout:stats:*",
  ];
  for (const p of patterns) {
    const keys = await r.keys(p);
    if (keys.length > 0) await r.del(...keys);
  }
}

after(async () => {
  if (testRedis && testRedis.status !== "end") {
    testRedis.disconnect();
    testRedis = null;
  }
  try {
    const { closeRedisConnections } = await import("../src/redis-adapter.ts");
    closeRedisConnections();
  } catch (err) {
    console.error("scout-calendar-walk teardown: closeRedisConnections failed", err);
  }
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ===========================================================================
// 1. parseCategorySlugs — pure parser
// ===========================================================================

describe("parseCategorySlugs", () => {
  test("extracts numbered H2 slugs", () => {
    const md = [
      "# Top",
      "## 1. typed-schemas",
      "Body...",
      "## 2. structured-errors",
      "More body",
      "### Sub heading does not count",
      "## 10. dependency-hygiene",
    ].join("\n");
    const targets = parseCategorySlugs(md);
    assert.deepEqual(
      targets.map((t) => t.slug),
      ["typed-schemas", "structured-errors", "dependency-hygiene"],
    );
    for (const t of targets) {
      assert.equal(t.kind, "category");
      assert.equal(t.source, "docs/ai-leverage-categories.md");
    }
  });

  test("handles H2 without numbering", () => {
    const md = "## simple-slug\n## another-one";
    const targets = parseCategorySlugs(md);
    assert.deepEqual(targets.map((t) => t.slug), ["simple-slug", "another-one"]);
  });

  test("deduplicates repeated slugs", () => {
    const md = "## 1. typed-schemas\n## typed-schemas";
    const targets = parseCategorySlugs(md);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].slug, "typed-schemas");
  });

  test("ignores non-slug headings (calibration footer etc.)", () => {
    const md = "## 1. typed-schemas\n## Calibrations the operator should revisit";
    const targets = parseCategorySlugs(md);
    assert.deepEqual(targets.map((t) => t.slug), ["typed-schemas"]);
  });

  test("returns empty for no H2s", () => {
    assert.deepEqual(parseCategorySlugs(""), []);
    assert.deepEqual(parseCategorySlugs("# Only h1\n### h3"), []);
  });
});

// ===========================================================================
// 2. isCooledDown — pure predicate
// ===========================================================================

describe("isCooledDown", () => {
  const now = new Date("2026-05-19T00:00:00Z");

  test("null/empty → eligible", () => {
    assert.equal(isCooledDown(null, 7, now), true);
    assert.equal(isCooledDown("", 7, now), true);
  });

  test("unparseable timestamp → eligible (corrupt-record fallback)", () => {
    assert.equal(isCooledDown("not-a-date", 7, now), true);
  });

  test("inside cooldown → not eligible", () => {
    // 3 days ago, 7-day cooldown → not eligible.
    const past = new Date(now.getTime() - 3 * MS_PER_DAY).toISOString();
    assert.equal(isCooledDown(past, 7, now), false);
  });

  test("at cooldown boundary → eligible", () => {
    const past = new Date(now.getTime() - 7 * MS_PER_DAY).toISOString();
    assert.equal(isCooledDown(past, 7, now), true);
  });

  test("past cooldown → eligible", () => {
    const past = new Date(now.getTime() - 30 * MS_PER_DAY).toISOString();
    assert.equal(isCooledDown(past, 7, now), true);
  });

  test("exposed default constants match spec", () => {
    // 7 days / 30 days are pinned by the issue body.
    assert.equal(CLASS_COOLDOWN_DAYS, 7);
    assert.equal(CATEGORY_COOLDOWN_DAYS, 30);
    // ~4% of \$50/day cap is the steady-state recommendation.
    assert.equal(SCOUT_DAILY_COST_SHARE, 0.04);
  });
});

// ===========================================================================
// 3. listRuntimeDependencies — disk reader
// ===========================================================================

describe("listRuntimeDependencies", () => {
  test("reads orchestrator + dashboard package.json runtime deps only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-walk-deps-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          dependencies: { express: "^5", ioredis: "^5", ws: "^8", "@sentry/node": "^10" },
          devDependencies: { typescript: "^6" },
        }),
      );
      mkdirSync(join(dir, "dashboard"));
      writeFileSync(
        join(dir, "dashboard", "package.json"),
        JSON.stringify({
          dependencies: { react: "^19", recharts: "^3" },
          devDependencies: { vite: "^4" },
        }),
      );

      const deps = await listRuntimeDependencies(dir);
      const slugs = deps.map((d) => d.slug).sort();
      // Runtime only — no typescript/vite.
      assert.deepEqual(slugs, [
        "dep:@sentry/node",
        "dep:express",
        "dep:ioredis",
        "dep:react",
        "dep:recharts",
        "dep:ws",
      ]);
      // Source labelling separates the two manifests for diagnostics.
      const sources = new Set(deps.map((d) => d.source));
      assert.ok(sources.has("package.json"));
      assert.ok(sources.has("dashboard/package.json"));
      for (const d of deps) assert.equal(d.kind, "dependency");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing manifest is logged + skipped (no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-walk-no-deps-"));
    try {
      // No package.json at all.
      const deps = await listRuntimeDependencies(dir);
      assert.deepEqual(deps, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON is logged + skipped (no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-walk-bad-json-"));
    try {
      writeFileSync(join(dir, "package.json"), "{not json");
      const deps = await listRuntimeDependencies(dir);
      assert.deepEqual(deps, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 4. planWalk — end-to-end against a temp HYDRA_ROOT + clean Redis
// ===========================================================================

describe("planWalk (Redis-backed)", () => {
  beforeEach(async () => {
    await cleanScoutKeys();
  });

  function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "scout-walk-root-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { express: "^5" } }),
    );
    mkdirSync(join(dir, "dashboard"));
    writeFileSync(
      join(dir, "dashboard", "package.json"),
      JSON.stringify({ dependencies: { react: "^19" } }),
    );
    mkdirSync(join(dir, "docs"));
    writeFileSync(
      join(dir, "docs", "ai-leverage-categories.md"),
      [
        "# AI-Leverage Categories",
        "## 1. typed-schemas",
        "...",
        "## 2. structured-errors",
        "...",
      ].join("\n"),
    );
    return dir;
  }

  test("fresh Redis: classCooledDown=true, all categories+deps eligible", async () => {
    const dir = makeRoot();
    try {
      const plan = await planWalk(dir, new Date("2026-05-19T12:00:00Z"));
      assert.equal(plan.classCooledDown, true);
      const slugs = plan.eligible.map((t) => t.slug).sort();
      assert.deepEqual(slugs, [
        "dep:express",
        "dep:react",
        "structured-errors",
        "typed-schemas",
      ]);
      assert.deepEqual(plan.skipped, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("category cooldown skips one category, dependencies always eligible", async () => {
    const dir = makeRoot();
    try {
      // Stamp typed-schemas 5 days ago — well inside the 30d cooldown.
      const now = new Date("2026-05-19T12:00:00Z");
      const recent = new Date(now.getTime() - 5 * MS_PER_DAY);
      await stampCategoryWalk("typed-schemas", recent);

      const plan = await planWalk(dir, now);
      const eligibleSlugs = plan.eligible.map((t) => t.slug).sort();
      const skippedSlugs = plan.skipped.map((t) => t.slug).sort();
      // typed-schemas is in the cooldown window → skipped.
      // structured-errors has no prior stamp → eligible.
      // deps are eligible regardless of category cooldown (per-tool is handled
      // inside the scout via the seen-list).
      assert.deepEqual(skippedSlugs, ["typed-schemas"]);
      assert.deepEqual(eligibleSlugs, ["dep:express", "dep:react", "structured-errors"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("class cooldown stamped recently → classCooledDown=false", async () => {
    const dir = makeRoot();
    try {
      const now = new Date("2026-05-19T12:00:00Z");
      // Walk fired yesterday — not yet 7 days.
      await stampClassWalk(new Date(now.getTime() - MS_PER_DAY));
      const plan = await planWalk(dir, now);
      assert.equal(plan.classCooledDown, false);
      // The planner still returns the target list — the caller decides
      // whether to dispatch. classCooledDown is the gate.
      assert.ok(plan.eligible.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("class cooldown elapsed → classCooledDown=true", async () => {
    const dir = makeRoot();
    try {
      const now = new Date("2026-05-19T12:00:00Z");
      // 10 days ago — past the 7d threshold.
      await stampClassWalk(new Date(now.getTime() - 10 * MS_PER_DAY));
      const plan = await planWalk(dir, now);
      assert.equal(plan.classCooledDown, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("planWalk is deterministic for fixed Redis state + now", async () => {
    const dir = makeRoot();
    try {
      const now = new Date("2026-05-19T12:00:00Z");
      const a = await planWalk(dir, now);
      const b = await planWalk(dir, now);
      assert.deepEqual(
        a.eligible.map((t) => t.slug).sort(),
        b.eligible.map((t) => t.slug).sort(),
      );
      assert.equal(a.classCooledDown, b.classCooledDown);
      assert.equal(a.computedAt, b.computedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isClassCooledDown + isCategoryCooledDown round-trip with stamps", async () => {
    const now = new Date("2026-05-19T12:00:00Z");
    // No stamp → cooled down.
    assert.equal(await isClassCooledDown(now), true);
    assert.equal(await isCategoryCooledDown("typed-schemas", now), true);
    // Stamp class walk now → not cooled down.
    await stampClassWalk(now);
    assert.equal(await isClassCooledDown(now), false);
    // Stamp category 1 day ago → still inside 30d cooldown.
    await stampCategoryWalk(
      "typed-schemas",
      new Date(now.getTime() - MS_PER_DAY),
    );
    assert.equal(await isCategoryCooledDown("typed-schemas", now), false);
    // 40 days ago → cooled down.
    await stampCategoryWalk(
      "typed-schemas",
      new Date(now.getTime() - 40 * MS_PER_DAY),
    );
    assert.equal(await isCategoryCooledDown("typed-schemas", now), true);
  });

  test("rejects empty category arg", async () => {
    await assert.rejects(
      () => isCategoryCooledDown("", new Date()),
      TypeError,
    );
    await assert.rejects(
      () => stampCategoryWalk("", new Date()),
      TypeError,
    );
  });
});
