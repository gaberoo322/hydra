/**
 * Drift guard for the generated feature inventories (issue #4589 — the
 * inventory-pipeline tracer bullet per the #4542 resolution, ADR-0034 §10).
 *
 * docs/generated/*.json is COMMITTED, and the only thing that keeps it true is
 * this guard: it re-runs the SAME extract(repoRoot) the runner calls (never a
 * re-implementation — one extraction truth per family, scripts/docs/inventories/
 * routes.ts and corpus.ts)
 * and deepEquals the result against the committed bytes. A route added without
 * regenerating fails HERE, in the required `npm test` job, naming the fix.
 *
 * Pure filesystem — no Redis, no network, no running service. One top-level
 * describe; the drift assertions are AGGREGATE OFFENDERS (one per committed
 * file, message listing the added/removed rows), never a per-route subtest
 * loop: `--test-force-exit` drops large synchronous subtest sets
 * non-deterministically (measured in test/adr-roster.test.mts).
 *
 * The trailing fixture cases pin the extraction RULES against throwaway trees
 * (multi-line registration, @stability grammar, mount check, `:param` home
 * fall-through), so the rules hold independent of the live tree's shape.
 */

import { fail as assertFail, deepStrictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildCounts,
  corpusRowLabel,
  countRowLabel,
  diffLabelMultiset,
  routeRowLabel,
} from "../scripts/docs/generate-inventories.ts";
import type { CorpusRow, RouteRow } from "../scripts/docs/inventories/envelope.ts";
import { extractCorpus } from "../scripts/docs/inventories/corpus.ts";
import { extractRoutes } from "../scripts/docs/inventories/routes.ts";

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

describe("generated feature inventories", () => {
  it("docs/generated/routes.json matches a fresh extractRoutes() run", () => {
    const file = join(REPO_ROOT, "docs/generated/routes.json");
    if (!existsSync(file)) {
      assertFail(`docs/generated/routes.json is missing.\nFix: npm run docs:inventories`);
    }
    const committed = JSON.parse(readFileSync(file, "utf8"));
    const fresh = extractRoutes(REPO_ROOT);
    let same = true;
    try {
      deepStrictEqual(committed, fresh);
    } catch (err) {
      /* intentional: deepStrictEqual's AssertionError is expected on drift — the failure detail
       * it carries is redundant with the added/removed row diff driftMessage() builds below, but
       * we still log it here so a run's raw output isn't silent about why `same` flipped false. */
      console.error(`[generated-inventories-drift] routes.json deepStrictEqual failed — ${err}`);
      same = false;
    }
    if (!same) {
      assertFail(
        driftMessage(
          "docs/generated/routes.json",
          committed,
          fresh.rows.map(routeRowLabel),
          (row) => routeRowLabel(row as RouteRow),
        ),
      );
    }
  });

  it("docs/generated/counts.json matches freshly computed counts", () => {
    const file = join(REPO_ROOT, "docs/generated/counts.json");
    if (!existsSync(file)) {
      assertFail(`docs/generated/counts.json is missing.\nFix: npm run docs:inventories`);
    }
    const committed = JSON.parse(readFileSync(file, "utf8"));
    const fresh = buildCounts(extractRoutes(REPO_ROOT), extractCorpus(REPO_ROOT));
    let same = true;
    try {
      deepStrictEqual(committed, fresh);
    } catch (err) {
      /* intentional: deepStrictEqual's AssertionError is expected on drift — the failure detail
       * it carries is redundant with the added/removed row diff driftMessage() builds below, but
       * we still log it here so a run's raw output isn't silent about why `same` flipped false. */
      console.error(`[generated-inventories-drift] counts.json deepStrictEqual failed — ${err}`);
      same = false;
    }
    if (!same) {
      assertFail(
        driftMessage(
          "docs/generated/counts.json",
          committed,
          fresh.rows.map(countRowLabel),
          (row) => countRowLabel(row as { family: string; metric: string; value: number }),
        ),
      );
    }
  });

  it("docs/generated/corpus.json matches a fresh extractCorpus() run", () => {
    const file = join(REPO_ROOT, "docs/generated/corpus.json");
    if (!existsSync(file)) {
      assertFail(`docs/generated/corpus.json is missing.\nFix: npm run docs:inventories`);
    }
    const committed = JSON.parse(readFileSync(file, "utf8"));
    const fresh = extractCorpus(REPO_ROOT);
    let same = true;
    try {
      deepStrictEqual(committed, fresh);
    } catch (err) {
      /* intentional: deepStrictEqual's AssertionError is expected on drift — the failure detail
       * it carries is redundant with the added/removed path diff driftMessage() builds below, but
       * we still log it here so a run's raw output isn't silent about why `same` flipped false. */
      console.error(`[generated-inventories-drift] corpus.json deepStrictEqual failed — ${err}`);
      same = false;
    }
    if (!same) {
      assertFail(
        driftMessage(
          "docs/generated/corpus.json",
          committed,
          fresh.rows.map(corpusRowLabel),
          (row) => corpusRowLabel(row as CorpusRow),
        ),
      );
    }
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
    const counts = buildCounts(extractRoutes(REPO_ROOT), corpus);
    const metric = (m: string) => counts.rows.find((r) => r.family === "corpus" && r.metric === m)?.value;
    deepStrictEqual(metric("docs"), corpus.rows.length);
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
});
