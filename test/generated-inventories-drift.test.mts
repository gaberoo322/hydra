/**
 * Drift guard for the generated feature inventories (issue #4589 — the
 * inventory-pipeline tracer bullet per the #4542 resolution, ADR-0034 §10;
 * extended to the code-imported families by #4594).
 *
 * docs/generated/*.json is COMMITTED, and the only thing that keeps it true is
 * this guard: it iterates the SAME FAMILIES registry the runner iterates
 * (scripts/docs/generate-inventories.ts — one extraction truth per family,
 * never a re-implementation) and deepEquals each fresh result against the
 * committed bytes. A route, key builder, stream, schema, tier path, chore or
 * env var added without regenerating fails HERE, in the required `npm test`
 * job, naming the fix.
 *
 * Pure filesystem — no Redis, no network, no running service. One top-level
 * describe; the drift assertions are AGGREGATE OFFENDERS (one per committed
 * file, message listing the added/removed rows), never a per-row subtest
 * loop: `--test-force-exit` drops large synchronous subtest sets
 * non-deterministically (measured in test/adr-roster.test.mts).
 *
 * The trailing fixture cases pin the extraction RULES against throwaway trees
 * or injected inputs, so the rules hold independent of the live tree's shape.
 */

import { fail as assertFail, deepStrictEqual, ok, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import {
  buildAllInventories,
  buildCounts,
  COUNTS_FILE,
  corpusRowLabel,
  countRowLabel,
  diffLabelMultiset,
  FAMILIES,
} from "../scripts/docs/generate-inventories.ts";
import type { CorpusRow, RouteRow } from "../scripts/docs/inventories/envelope.ts";
import { extractCorpus } from "../scripts/docs/inventories/corpus.ts";
import { extractRoutes } from "../scripts/docs/inventories/routes.ts";
import { buildChoreRows } from "../scripts/docs/inventories/chores.ts";
import { buildEnvVarRows } from "../scripts/docs/inventories/env-vars.ts";
import { buildRedisKeyRows, parseParams } from "../scripts/docs/inventories/redis-keys.ts";
import { buildSchemaRows } from "../scripts/docs/inventories/schemas.ts";
import { buildTierPathRows } from "../scripts/docs/inventories/tier-paths.ts";
import { walkFiles } from "../scripts/docs/inventories/scan.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Build a throwaway tree from a rel-path → content map, run `fn(root)`, always clean up. */
function withFixture(files: Record<string, string>, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "hydra-inventories-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The shared drift check: deepEquals committed JSON against a fresh extract,
 * but on mismatch reports the added/removed row labels instead of a giant
 * object dump, and ends with the regeneration command.
 */
function driftMessage(
  file: string,
  committed: { rows?: unknown[] } | null,
  freshLabels: string[],
  labelOf: (row: unknown) => string,
): string {
  const committedLabels = ((committed && committed.rows) || []).map((row) => {
    try {
      return labelOf(row);
    } catch (err) {
      /* intentional: a committed row that doesn't match the expected shape (stale/legacy
       * envelope) only degrades this diff's row label — the caller already knows the file
       * is stale via the outer deepStrictEqual failure that triggered this message. */
      console.error(`[generated-inventories-drift] could not label a committed row — ${err}`);
      return "<unparseable committed row>";
    }
  });
  const { added, removed } = diffLabelMultiset(committedLabels, freshLabels);
  const lines = [
    `${file} is stale: the committed inventory does not match a fresh extraction of the tree.`,
  ];
  for (const a of added) lines.push(`  + ${a}`);
  for (const r of removed) lines.push(`  - ${r}`);
  if (added.length === 0 && removed.length === 0) {
    lines.push("  (row labels identical — row fields or envelope differ; regenerate)");
  }
  lines.push("Fix: npm run docs:inventories");
  return lines.join("\n");
}

/** One aggregate-offender drift assertion: committed file vs fresh inventory. */
function assertNoDrift(file: string, fresh: { rows: unknown[] }, labelOf: (row: unknown) => string): void {
  const abs = join(REPO_ROOT, file);
  if (!existsSync(abs)) {
    assertFail(`${file} is missing.\nFix: npm run docs:inventories`);
  }
  const committed = JSON.parse(readFileSync(abs, "utf8"));
  let same = true;
  try {
    deepStrictEqual(committed, fresh);
  } catch (err) {
    /* intentional: deepStrictEqual's AssertionError is expected on drift — the failure detail
     * it carries is redundant with the added/removed row diff driftMessage() builds below, but
     * we still log it here so a run's raw output isn't silent about why `same` flipped false. */
    console.error(`[generated-inventories-drift] ${file} deepStrictEqual failed — ${err}`);
    same = false;
  }
  if (!same) {
    assertFail(driftMessage(file, committed, fresh.rows.map(labelOf), labelOf));
  }
}

// Built once for the whole suite (lazily, in a before() hook, so an extractor
// error fails a test instead of crashing the file at import): every family
// from the one registry.
let fresh: ReturnType<typeof buildAllInventories>;

describe("generated feature inventories", () => {
  before(() => {
    fresh = buildAllInventories(REPO_ROOT);
  });

  // One aggregate assertion per registered family file — the registry, not
  // this test, decides which families exist (runner and test cannot disagree).
  for (const fam of FAMILIES) {
    it(`${fam.file} matches a fresh ${fam.family} extraction`, () => {
      const inv = fresh.get(fam.family);
      ok(inv, `registry family ${fam.family} produced no inventory`);
      assertNoDrift(fam.file, inv, fam.label);
    });
  }

  it("docs/generated/counts.json matches freshly computed counts", () => {
    assertNoDrift(COUNTS_FILE, buildCounts(fresh), (row) =>
      countRowLabel(row as { family: string; metric: string; value: number }),
    );
  });

  it("family registry: every docs/generated file is registered and counts cover every family", () => {
    const committed = readdirSync(join(REPO_ROOT, "docs/generated"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => `docs/generated/${f}`)
      .sort();
    deepStrictEqual(committed, [...FAMILIES.map((f) => f.file), COUNTS_FILE].sort());
    for (const fam of FAMILIES) {
      deepStrictEqual(fam.file, `docs/generated/${fam.family}.json`);
      ok(existsSync(join(REPO_ROOT, `scripts/docs/inventories/${fam.family}.ts`)), `no extractor module for ${fam.family}`);
    }
    const counts = buildCounts(fresh);
    const metrics = counts.rows.map((r) => `${r.family}/${r.metric}`);
    for (const fam of FAMILIES) ok(metrics.includes(`${fam.family}/rows`), `counts.json lacks ${fam.family}/rows`);
    ok(metrics.includes("redis-keys/retired"));
    ok(metrics.includes("routes/routers") && metrics.includes("routes/routes"));
    deepStrictEqual(counts.generatedFrom, FAMILIES.map((f) => f.file).sort());
  });

  it("docs/generated/corpus.json matches a fresh extractCorpus() run", () => {
    // Also covered by the registry loop above; kept as the named pin for #4591's INV-5.
    assertNoDrift("docs/generated/corpus.json", extractCorpus(REPO_ROOT), (row) => corpusRowLabel(row as CorpusRow));
  });

  it("corpus membership rules: research excluded, historical tiered, nested historical included", () => {
    withFixture(
      {
        "README.md": "# Hydra\n\n## How It Works\n",
        "CLAUDE.md": "```md\n# not a title\n```\n# Hydra Orchestrator\n",
        "CONTEXT.md": "---\ntitle: x\n---\n# Glossary\n",
        "docs/reference.md": "no heading here\n",
        "docs/agents/domain.md": "# Domain Docs\n",
        "docs/agents/nested/deeper.md": "# Not a member (docs/agents/*.md is one level)\n",
        "docs/research/2026-01-01-idea.md": "# Research is never a member\n",
        "docs/adr/0001-x.md": "# ADRs join in #4593, not this slice\n",
        "config/direction/priorities.md": "# Current state\n",
        "config/orchestrator/vision.md": "# Orchestrator Vision\n",
        "docs/historical/README.md": "# Historical\n",
        "docs/historical/a/b/Old Doc.md": "# Old doc\n",
      },
      (root) => {
        const inv = extractCorpus(root);
        deepStrictEqual(inv.family, "corpus");
        deepStrictEqual(inv.schemaVersion, 1);
        deepStrictEqual(
          inv.rows.map((r) => `${r.path} [${r.tier}] ${r.route} :: ${r.title}`),
          [
            "CLAUDE.md [living] /docs/system/architecture :: Hydra Orchestrator",
            "CONTEXT.md [living] /docs/ref/context :: Glossary",
            "README.md [living] /docs :: Hydra",
            "config/direction/priorities.md [living] /docs/system/vision/priorities :: Current state",
            "config/orchestrator/vision.md [living] /docs/system/vision :: Orchestrator Vision",
            "docs/agents/domain.md [living] /docs/ref/agents/domain :: Domain Docs",
            "docs/historical/README.md [historical] /docs/history/readme :: Historical",
            "docs/historical/a/b/Old Doc.md [historical] /docs/history/a/b/old-doc :: Old doc",
            "docs/reference.md [living] /docs/ref/reference :: reference.md",
          ],
        );
        // Every declared source is echoed as a glob, never an expanded file list.
        deepStrictEqual(inv.generatedFrom.includes("docs/historical/**/*.md"), true);
        deepStrictEqual(inv.generatedFrom.some((g) => g.startsWith("docs/research")), false);
        // The playbook tier exists in the type but has zero rows in this slice.
        deepStrictEqual(inv.rows.filter((r) => r.tier === "playbook").length, 0);
        // Byte-identical on an unchanged tree: no timestamp, no SHA.
        deepStrictEqual(JSON.stringify(extractCorpus(root)), JSON.stringify(inv));
      },
    );
  });

  it("corpus counts are derived from the corpus inventory via buildCounts", () => {
    const corpus = extractCorpus(REPO_ROOT);
    const counts = buildCounts(fresh);
    const metric = (m: string) => counts.rows.find((r) => r.family === "corpus" && r.metric === m)?.value;
    deepStrictEqual(metric("rows"), corpus.rows.length);
    deepStrictEqual(metric("historical"), corpus.rows.filter((r) => r.tier === "historical").length);
    deepStrictEqual(metric("living"), corpus.rows.filter((r) => r.tier === "living").length);
    deepStrictEqual(metric("playbook"), 0);
  });

  it("extraction rules: multi-line registration, @stability grammar, areas collapse, home resolution", () => {
    withFixture(
      {
        "src/api.ts": [
          'import { createOneRouter } from "./api/one.ts";',
          'import { createParamRouter } from "./api/param.ts";',
          "const api = {};",
          "api.use(createOneRouter());",
          "api.use(createParamRouter());",
        ].join("\n"),
        "src/api/one.ts": [
          'import { Router } from "express";',
          'import { logger } from "../logger.ts";',
          'import { getThing } from "../redis/thing.ts";',
          'import { helper } from "./route-helpers.ts";',
          "export function createOneRouter() {",
          "  const router = Router();",
          "  // @stability deprecated — sunset after the Work page migrates (#999)",
          "  router.get(",
          '    "/one/thing",',
          "    async (req, res) => res.json({}),",
          "  );",
          '  router.post("/one/thing", async (req, res) => res.json({}));',
          "  return router;",
          "}",
        ].join("\n"),
        "src/api/param.ts": [
          'import { Router } from "express";',
          "export function createParamRouter() {",
          "  const router = Router();",
          '  router.get("/param/:id", async (req, res) => res.json({}));',
          "  return router;",
          "}",
        ].join("\n"),
        "dashboard/src/App.jsx": [
          'import List from "./pages/List.jsx";',
          'import Detail from "./pages/Detail.jsx";',
          'export default function App() {',
          "  return (",
          "    <Routes>",
          '      <Route path="/gone" element={<Navigate replace to="/list" />} />',
          '      <Route path="/list" element={<List />} />',
          '      <Route path="/items/:id" element={<Detail />} />',
          "    </Routes>",
          "  );",
          "}",
        ].join("\n"),
        "dashboard/src/pages/List.jsx": [
          'import { useApi } from "../../hooks/useApi.js";',
          "export default function List() {",
          '  const { data } = useApi("/one/thing");',
          "  return null;",
          "}",
        ].join("\n"),
        "dashboard/src/pages/Detail.jsx": [
          "export default function Detail() {",
          "  const { id } = useParams();",
          "  const { data } = useApi(`/param/${id}`);",
          "  return null;",
          "}",
        ].join("\n"),
      },
      (root) => {
        const inv = extractRoutes(root);
        deepStrictEqual(
          inv.rows.map((r) => `${r.method} ${r.path}`),
          ["GET /api/one/thing", "POST /api/one/thing", "GET /api/param/:id"],
        );

        const get = inv.rows[0] as RouteRow;
        // The multi-line registration: the path sits two lines below `router.get(`.
        deepStrictEqual(get.source, { path: "src/api/one.ts", line: 8 });
        deepStrictEqual(get.stability, "deprecated");
        deepStrictEqual(get.stabilityNote, "sunset after the Work page migrates (#999)");
        // Areas: first-party imports collapsed; ./route-helpers.ts (src/api/) excluded.
        deepStrictEqual(get.areas, ["src/logger.ts", "src/redis/"]);
        deepStrictEqual(get.consumers, ["dashboard/src/pages/List.jsx"]);
        deepStrictEqual(get.home, "/list");

        // The POST on the same path shares consumers and home (path-only matching).
        const post = inv.rows[1] as RouteRow;
        deepStrictEqual(post.stability, "stable");
        deepStrictEqual(post.consumers, ["dashboard/src/pages/List.jsx"]);

        // A consumer whose only page is a :param detail page never homes there —
        // it falls through to the route's own /api path (finding 2).
        const param = inv.rows[2] as RouteRow;
        deepStrictEqual(param.consumers, ["dashboard/src/pages/Detail.jsx"]);
        deepStrictEqual(param.home, "/api/param/:id");
      },
    );
  });

  it("extraction errors: unknown @stability value, unmounted router, non-literal path", () => {
    withFixture(
      {
        "src/api.ts": "api.use(createBadRouter());",
        "src/api/bad.ts": [
          'import { Router } from "express";',
          "export function createBadRouter() {",
          "  const router = Router();",
          "  // @stability beta",
          '  router.get("/bad", async (req, res) => res.json({}));',
          "  return router;",
          "}",
        ].join("\n"),
      },
      (root) => {
        throws(() => extractRoutes(root), /unknown @stability value "beta"/);
      },
    );
    withFixture(
      {
        "src/api.ts": "// no mounts at all",
        "src/api/lonely.ts": [
          'import { Router } from "express";',
          "export function createLonelyRouter() {",
          "  const router = Router();",
          '  router.get("/lonely", async (req, res) => res.json({}));',
          "  return router;",
          "}",
        ].join("\n"),
      },
      (root) => {
        throws(() => extractRoutes(root), /never mounted in src\/api\.ts/);
      },
    );
    withFixture(
      {
        "src/api.ts": "api.use(createComputedRouter());",
        "src/api/computed.ts": [
          'import { Router } from "express";',
          "export function createComputedRouter() {",
          "  const router = Router();",
          "  const p = buildPath();",
          "  router.get(p, async (req, res) => res.json({}));",
          "  return router;",
          "}",
        ].join("\n"),
      },
      (root) => {
        throws(() => extractRoutes(root), /not followed by a path literal/);
      },
    );
  });

  it("redis-keys rules: placeholder pattern, call-site count, retired only while code-referenced", () => {
    const builders = {
      plain: () => "hydra:plain",
      withId: (id: string) => `hydra:thing:${id}`,
      pair: (a: string, b: string) => `hydra:pair:${a}:${b}`,
    };
    deepStrictEqual(parseParams("withId", builders.withId), ["id"]);
    deepStrictEqual(parseParams("plain", builders.plain), []);
    const keysSource = [
      "export const redisKeys = {",
      '  plain: () => "hydra:plain",',
      "  withId: (id: string) => `hydra:thing:${id}`,",
      "  pair: (a: string, b: string) => `hydra:pair:${a}:${b}`,",
      "};",
    ].join("\n");
    const rows = buildRedisKeyRows({
      builders,
      keysSource,
      files: [
        {
          path: "src/redis/thing.ts",
          src: [
            'import { redisKeys } from "./keys.ts";',
            "// redisKeys.withId in a whole-line comment never counts",
            "/* redisKeys.withId in a block comment never counts */",
            "export const a = () => redisKeys.withId(x);",
            "export const b = () => redisKeys.withId(y) + redisKeys.plain();",
            "// hydra:plans:cache — a comment-only mention of a retired family",
            'export const lock = "hydra:workspace:lock";',
            "export const agents = (id) => `hydra:cycle:${id}:agents`;",
          ].join("\n"),
        },
        { path: "scripts/tool.ts", src: "redisKeys.withId(z);" },
        {
          path: "src/api/thing.ts",
          src: 'import { a } from "../redis/thing.ts";\nrouter.get("/thing", h);',
        },
      ],
      routes: [{ method: "GET", path: "/api/thing", home: "/work", source: { path: "src/api/thing.ts" } }],
    });
    const byLabel = new Map(rows.map((r) => [r.builder ?? `retired ${r.pattern}`, r]));
    const withId = byLabel.get("withId");
    deepStrictEqual(withId?.pattern, "hydra:thing:{id}");
    deepStrictEqual(withId?.params, ["id"]);
    deepStrictEqual(withId?.callSites, 3); // 2 in the adapter + 1 in scripts/, comments stripped
    deepStrictEqual(withId?.accessors, ["src/redis/thing.ts"]);
    deepStrictEqual(withId?.servedBy, ["GET /api/thing"]);
    deepStrictEqual(withId?.home, "/work");
    deepStrictEqual(withId?.source, { path: "src/redis/keys.ts", line: 3 });
    deepStrictEqual(byLabel.get("pair")?.pattern, "hydra:pair:{a}:{b}");
    const unused = byLabel.get("pair");
    deepStrictEqual([unused?.callSites, unused?.home], [0, null]);
    // Retired: the code references produce rows; the comment-only mention does not.
    const retired = rows.filter((r) => r.retired).map((r) => r.pattern).sort();
    deepStrictEqual(retired, ["hydra:cycle:{id}:agents", "hydra:workspace:lock"]);
    ok(!rows.some((r) => r.pattern === "hydra:plans:cache"));
  });

  it("redis-keys rules: a builder returning a non-string fails loud", () => {
    throws(
      () =>
        buildRedisKeyRows({
          builders: { bad: () => 42 },
          keysSource: "  bad: () => 42,",
          files: [],
          routes: [],
        }),
      /returned a non-string/,
    );
  });

  it("schemas rules: nearest-preceding registration join, importedBy, type exports excluded", () => {
    const rows = buildSchemaRows({
      schemaFiles: [
        {
          path: "src/schemas/thing.ts",
          src: [
            'import { z } from "zod";',
            "export const ThingBody = z.object({});",
            "export const OtherBody = z.object({});",
            "export type Thing = z.infer<typeof ThingBody>;",
          ].join("\n"),
        },
      ],
      srcFiles: [
        {
          path: "src/api/thing.ts",
          src: [
            'import { ThingBody, OtherBody } from "../schemas/thing.ts";', // 1
            "const early = ThingBody;", // 2 — above the first registration: no route
            'router.get("/a", h);', // 3
            'router.post("/b", (req) => {', // 4
            "  ThingBody.safeParse(req.body);", // 5 → POST /b
            "});",
            'router.put("/c", (req) => OtherBody.parse(req.body));', // 7 → PUT /c
          ].join("\n"),
        },
        { path: "src/lib/uses.ts", src: 'import { ThingBody } from "../schemas/thing.ts";\nThingBody;' },
      ],
      routes: [
        { method: "GET", path: "/api/a", source: { path: "src/api/thing.ts", line: 3 } },
        { method: "POST", path: "/api/b", source: { path: "src/api/thing.ts", line: 4 } },
        { method: "PUT", path: "/api/c", source: { path: "src/api/thing.ts", line: 7 } },
      ],
    });
    deepStrictEqual(rows.map((r) => r.name), ["OtherBody", "ThingBody"]);
    const thing = rows[1];
    deepStrictEqual(thing.importedBy, ["src/api/thing.ts", "src/lib/uses.ts"]);
    deepStrictEqual(thing.routes, ["POST /api/b"]);
    deepStrictEqual(thing.source, { path: "src/schemas/thing.ts", line: 2 });
    deepStrictEqual(rows[0].routes, ["PUT /api/c"]);
  });

  it("tier-paths rules: a classifier probe mismatch or an empty scanned list throws", () => {
    const classifierSource = [
      'const TIER_1_PREFIXES: readonly string[] = Object.freeze([ "config/agents/" ]);',
      'const TIER_2_PREFIXES: readonly string[] = Object.freeze([ "dashboard/" ]);',
      'const TIER_2_FILES: readonly string[] = Object.freeze([ "src/anchor-selection.ts" ]);',
      "function classifyOne(path) {}",
    ].join("\n");
    const untouchableSource = 'export const VERIFIER_CORE_PATHS = Object.freeze([\n  "src/untouchable.ts",\n]);';
    const honest = (files: string[]): { tier: number } => {
      const f = files[0];
      if (f === "src/untouchable.ts") return { tier: 4 };
      if (f.startsWith("config/agents/")) return { tier: 1 };
      if (f.startsWith("dashboard/") || f === "src/anchor-selection.ts") return { tier: 2 };
      return { tier: 3 };
    };
    const rows = buildTierPathRows({ verifierCorePaths: ["src/untouchable.ts"], classifierSource, untouchableSource, classify: honest });
    deepStrictEqual(
      rows.map((r) => `T${r.tier} ${r.kind} ${r.path}`),
      ["T1 prefix config/agents/", "T2 prefix dashboard/", "T2 file src/anchor-selection.ts", "T3 default *", "T4 file src/untouchable.ts"],
    );
    // A classifier that disagrees with a scanned row is an extraction error.
    throws(
      () =>
        buildTierPathRows({
          verifierCorePaths: ["src/untouchable.ts"],
          classifierSource,
          untouchableSource,
          classify: (files) => (files[0].startsWith("dashboard/") ? { tier: 3 } : honest(files)),
        }),
      /scanned as T2 but classifyChange/,
    );
    throws(
      () =>
        buildTierPathRows({
          verifierCorePaths: ["src/untouchable.ts"],
          classifierSource: classifierSource.replace('"config/agents/"', ""),
          untouchableSource,
          classify: honest,
        }),
      /TIER_1_PREFIXES scanned empty/,
    );
  });

  it("chores rules: cadence mapping from the guard period, registry order, empty list throws", () => {
    const src = [
      "const DAY_MS = 1; const WEEK_MS = 7;",
      "  const chores: Chore[] = [",
      "    {",
      '      name: "every",',
      "      work: async () => { await x(); },",
      "    },",
      "    {",
      '      name: "weekly-one",',
      "      guard: () => choreGuard(get, WEEK_MS, deps.now),",
      "      work: () => y(),",
      "    },",
      "    {",
      "      // a guard mentioned in a comment is not a guard",
      '      name: "daily-one",',
      "      guard: () =>",
      "        choreGuard(deps.getX ?? getX, DAY_MS, deps.now),",
      "      work: () => z(),",
      "    },",
      "  ];",
    ].join("\n");
    deepStrictEqual(
      buildChoreRows(src).map((r) => `${r.order} ${r.name} ${r.cadence} ${r.source.line}`),
      ["0 every every-run 4", "1 weekly-one weekly 8", "2 daily-one daily 14"],
    );
    throws(() => buildChoreRows("  const chores: Chore[] = [\n  ];"), /scanned empty/);
    throws(
      () => buildChoreRows('  const chores: Chore[] = [\n    { name: "x", guard: () => choreGuard(g, HOUR_MS), work: w },\n  ];'),
      /unrecognised period constant \(HOUR_MS\)/,
    );
    throws(
      () => buildChoreRows('  const chores: Chore[] = [\n    { name: "x", work: w },\n    { name: "x", work: w },\n  ];'),
      /duplicate chore name "x"/,
    );
  });

  it("env-vars rules: dynamic-literal reads, shell-local exclusion, .env.example-only rows, no values", () => {
    const PE = ["process", "env"].join(".");
    const rows = buildEnvVarRows({
      codeFiles: [
        { path: "src/a.ts", src: `const x = ${PE}.HYDRA_ALPHA;\n// ${PE}.HYDRA_COMMENTED\n` },
        {
          path: "src/holdback.ts",
          src: `function envInt(n) { return Number(${PE}[n]); }\nconst t3 = envInt("HYDRA_WINDOW_T3");\nconst nope = "lowercase_x";\n`,
        },
        { path: "src/plain.ts", src: 'const notEnv = "NOT_AN_ENV";\n' },
      ],
      shellFiles: [
        {
          path: "scripts/run.sh",
          src: '#!/bin/bash\n# ${HYDRA_IN_COMMENT}\nANCHOR="$1"\necho "${ANCHOR}"\necho "$HYDRA_SHELL_ONLY ${HYDRA_ALPHA} $EXAMPLE_ONLY"\n',
        },
      ],
      envExample: "# comment\nEXAMPLE_ONLY=secret-value-never-emitted\nHYDRA_ALPHA=1\n",
    });
    const byName = new Map(rows.map((r) => [r.name, r]));
    deepStrictEqual([...byName.keys()], ["EXAMPLE_ONLY", "HYDRA_ALPHA", "HYDRA_SHELL_ONLY", "HYDRA_WINDOW_T3"]);
    // A dynamic-read file's quoted UPPER_SNAKE literal is a read site; a file without one is not.
    deepStrictEqual(byName.get("HYDRA_WINDOW_T3")?.readSites, [{ path: "src/holdback.ts", line: 2 }]);
    ok(!byName.has("NOT_AN_ENV"));
    ok(!byName.has("HYDRA_COMMENTED"));
    // Shell locals are not env vars; HYDRA_ and established names attach.
    ok(!byName.has("ANCHOR"));
    ok(!byName.has("HYDRA_IN_COMMENT"));
    deepStrictEqual(byName.get("HYDRA_ALPHA")?.readSites, [
      { path: "scripts/run.sh", line: 5 },
      { path: "src/a.ts", line: 1 },
    ]);
    deepStrictEqual(byName.get("HYDRA_ALPHA")?.inEnvExample, true);
    // A .env.example-only name gets a row with empty readSites, sourced at its line.
    const exampleOnly = byName.get("EXAMPLE_ONLY");
    deepStrictEqual(exampleOnly?.inEnvExample, true);
    deepStrictEqual(exampleOnly?.readSites, [{ path: "scripts/run.sh", line: 5 }]);
    ok(!JSON.stringify(rows).includes("secret-value-never-emitted"), "no value is ever emitted");
    const onlyInExample = buildEnvVarRows({ codeFiles: [], shellFiles: [], envExample: "LONELY_VAR=x\n" });
    deepStrictEqual(onlyInExample, [
      { name: "LONELY_VAR", readSites: [], inEnvExample: true, source: { path: ".env.example", line: 1 } },
    ]);
  });

  it("scans never walk into node_modules, dist or nested .claude/worktrees copies", () => {
    withFixture(
      {
        "src/real.ts": "x",
        "src/node_modules/pkg/index.ts": "x",
        "src/dist/built.ts": "x",
        "src/.claude/worktrees/agent-1/src/copy.ts": "x",
        "src/worktrees/agent-2/copy.ts": "x",
      },
      (root) => {
        deepStrictEqual(walkFiles(root, "src", (n) => n.endsWith(".ts")), ["src/real.ts"]);
      },
    );
  });

  it("the code-imported families do not depend on the #4591 corpus or marked plugin", () => {
    const files = [
      ...["redis-keys", "streams", "schemas", "tier-paths", "chores", "env-vars", "scan"].map(
        (f) => `scripts/docs/inventories/${f}.ts`,
      ),
      "dashboard/src/pages/docs/Catalogue.jsx",
      "dashboard/src/pages/docs/catalogues.js",
    ];
    for (const rel of files) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      ok(!/from\s+["']marked["']/.test(src), `${rel} imports marked`);
      ok(!/corpus\.json/.test(src), `${rel} references the #4591 corpus`);
    }
  });
});
