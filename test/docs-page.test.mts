/**
 * /docs page shell source pins (issue #4590 — docs-epic slice 4, ADR-0034 §1
 * as amended by #4587 and §10).
 *
 * The dashboard ships no JSX test runner, so — like
 * test/dashboard-routes.test.mts — the slice is pinned at the boundaries that
 * ARE mechanically checkable from source: the two-group sidebar, the single
 * `/docs/*` splat route, the no-runtime-call hard line under
 * dashboard/src/pages/docs/**, the build-time provenance constants, the
 * build-time-glob inventory loader with its explicit 'inventory unavailable'
 * state, and the family-derived GENERATED frame header.
 *
 * Lifecycle: top-level describes with no shared mutable state and no Redis.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

async function readSource(rel: string): Promise<string> {
  return readFile(new URL(rel, import.meta.url), "utf8");
}

/** Every source file under dashboard/src/pages/docs, as [relPath, source]. */
async function docsPageSources(): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push([rel, await readSource(rel)]);
    }
  };
  await walk("../dashboard/src/pages/docs");
  return out;
}

/** Slice the source of an exported array literal `export const NAME = [ ... ];`. */
function exportedArray(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = [`);
  assert.ok(start >= 0, `expected an exported ${name} array`);
  const end = src.indexOf("\n];", start);
  assert.ok(end > start, `expected ${name} to close with a top-level "];"`);
  return src.slice(start, end);
}

describe("Sidebar has exactly two groups: journey then a separated Docs group (INV-1)", () => {
  test("JOURNEY_NAV lists Today, Health, Work, Runs, Builder in order, then the unchanged Now entry", async () => {
    const src = await readSource("../dashboard/src/components/Sidebar.jsx");
    const journey = exportedArray(src, "JOURNEY_NAV");
    const labels = [...journey.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["Today", "Health", "Work", "Runs", "Builder", "Now"]);
    const paths = [...journey.matchAll(/\bto: "([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(paths, ["/", "/health", "/work", "/runs", "/builder", "/now"]);
    // The /now literal stays byte-identical (dashboard-routes INV-5).
    assert.match(journey, /\{ to: "\/now", label: "Now"/);
  });

  test("REFERENCE_NAV holds only the Docs entry and renders under a border-top divider", async () => {
    const src = await readSource("../dashboard/src/components/Sidebar.jsx");
    const reference = exportedArray(src, "REFERENCE_NAV");
    const entries = [...reference.matchAll(/\{ to: "([^"]+)", label: "([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`);
    assert.deepEqual(entries, ["/docs=Docs"]);
    assert.ok(!exportedArray(src, "JOURNEY_NAV").includes('"/docs"'), "Docs must not be in the journey group");
    assert.match(src, /data-testid="nav-reference"[^>]*border-t/);
    assert.match(src, /REFERENCE_NAV\.map/);
    assert.match(src, /JOURNEY_NAV\.map/);
  });
});

describe("App.jsx mounts one /docs/* splat route (INV-2)", () => {
  test("the splat route renders the docs shell", async () => {
    const src = await readSource("../dashboard/src/App.jsx");
    assert.match(src, /<Route path="\/docs\/\*" element=\{<Docs \/>\} \/>/);
    assert.match(src, /import Docs from "\.\/pages\/docs\/Docs\.jsx";/);
    assert.equal((src.match(/path="\/docs/g) ?? []).length, 1, "exactly one /docs route");
  });

  test("the shell resolves the splat to exactly the entry and cat/routes keys, else 'not built yet'", async () => {
    const src = await readSource("../dashboard/src/pages/docs/Docs.jsx");
    assert.match(src, /useParams\(\)\["\*"\]/);
    assert.match(src, /"": entryView,/);
    assert.match(src, /"cat\/routes": routesView,/);
    assert.ok(src.includes("not built yet"));
  });
});

describe("no runtime API call under dashboard/src/pages/docs (INV-3)", () => {
  test("no useApi / usePageItems / apiFetch / fetch( / WebSocket / EventSource", async () => {
    const sources = await docsPageSources();
    assert.ok(sources.length >= 5, "expected the docs page modules");
    // The extractor's CALL_RE family (scripts/docs/inventories/routes.ts),
    // widened to any first argument, plus the streaming transports.
    const forbidden = /\b(?:useApi|usePageItems|apiFetch|fetch)\s*\(|\bWebSocket\b|\bEventSource\b/;
    for (const [rel, src] of sources) {
      assert.ok(!forbidden.test(src), `${rel} contains a runtime API call form`);
    }
  });
});

describe("provenance is a build constant (INV-4)", () => {
  test("vite.config.js defines the build SHA and time with an 'unknown' fallback", async () => {
    const src = await readSource("../dashboard/vite.config.js");
    assert.match(src, /"import\.meta\.env\.HYDRA_BUILD_SHA": JSON\.stringify\(sha\)/);
    assert.match(src, /"import\.meta\.env\.HYDRA_BUILD_TIME": JSON\.stringify\(builtAt\)/);
    assert.match(src, /execSync\("git rev-parse HEAD"/);
    assert.match(src, /return "unknown";/);
    assert.match(src, /console\.error\(/);
  });

  test("the provenance line reads the constants, renders 'commit unknown', and links /health", async () => {
    const info = await readSource("../dashboard/src/pages/docs/build-info.js");
    assert.match(info, /import\.meta\.env\.HYDRA_BUILD_SHA/);
    assert.match(info, /import\.meta\.env\.HYDRA_BUILD_TIME/);
    const prov = await readSource("../dashboard/src/pages/docs/Provenance.jsx");
    assert.ok(prov.includes("commit unknown"));
    assert.ok(prov.includes("as of"));
    assert.match(prov, /<Link to="\/health"/);
    const shell = await readSource("../dashboard/src/pages/docs/Docs.jsx");
    assert.match(shell, /<main[^>]*>\s*<Provenance \/>/, "provenance renders first in the centre pane");
  });
});

describe("inventory loading is build-time glob + runtime parse (INV-5)", () => {
  test("every inventory is read via ONE eager ?raw glob over docs/generated/*.json, never a static import (#4594)", async () => {
    const src = await readSource("../dashboard/src/pages/docs/inventories.js");
    assert.match(src, /import\.meta\.glob\("\.\.\/\.\.\/\.\.\/\.\.\/docs\/generated\/\*\.json"/);
    assert.equal((src.match(/import\.meta\.glob\(/g) ?? []).length, 1, "exactly one inventory glob");
    assert.match(src, /export function loadInventory\(family\)/);
    assert.match(src, /query: "\?raw"/);
    assert.match(src, /eager: true/);
    assert.match(src, /JSON\.parse\(raw\)/);
    assert.match(src, /schemaVersion !== 1/);
    for (const [rel, s] of await docsPageSources()) {
      assert.ok(!/import\s+\w+\s+from\s+["'][^"']*\.json["']/.test(s), `${rel} statically imports an inventory`);
    }
  });

  test("an unavailable inventory renders 'inventory unavailable', not a table", async () => {
    const src = await readSource("../dashboard/src/pages/docs/Generated.jsx");
    assert.ok(src.includes("inventory unavailable"));
    assert.match(src, /!inventory \|\| !inventory\.ok/);
  });
});

describe("the GENERATED frame header is derived from the family (INV-6)", () => {
  test("source file and extractor names are built from the family string", async () => {
    const inv = await readSource("../dashboard/src/pages/docs/inventories.js");
    assert.ok(inv.includes("`docs/generated/${family}.json`"));
    assert.ok(inv.includes("`scripts/docs/inventories/${family}.ts`"));
    const frame = await readSource("../dashboard/src/pages/docs/Generated.jsx");
    assert.ok(frame.includes("${inventoryFile(family)} ← ${extractorFile(family)}"));
    assert.ok(frame.includes("border-dashed"));
    assert.ok(frame.includes("generated"));
  });
});

// ---------------------------------------------------------------------------
// #4591 — build-time markdown pipeline (docs-epic slice 5)
// ---------------------------------------------------------------------------

const ROOT = new URL("../", import.meta.url);

/** Every .js/.jsx file under dashboard/src, as [relPath, source]. */
async function dashboardSrcSources(): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(rel);
      else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push([rel, await readSource(rel)]);
    }
  };
  await walk("../dashboard/src");
  return out;
}

const IMPORTS_MARKED = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']marked["']/;

describe("marked is a build-time-only dashboard devDependency (#4591 INV-1)", () => {
  test("marked is a devDependency only, has no transitive deps, and allowScripts stays empty", async () => {
    const pkg = JSON.parse(await readSource("../dashboard/package.json"));
    assert.ok(pkg.devDependencies?.marked, "marked must be a dashboard devDependency");
    assert.equal(pkg.dependencies?.marked, undefined, "marked must never be a runtime dependency");
    assert.deepEqual(pkg.lavamoat?.allowScripts, {});
    const lock = JSON.parse(await readSource("../dashboard/package-lock.json"));
    const entry = lock.packages?.["node_modules/marked"];
    assert.ok(entry, "marked is locked");
    assert.equal(entry.dev, true);
    assert.equal(entry.dependencies, undefined, "marked adds zero transitive deps");
    assert.equal(entry.hasInstallScript, undefined, "marked has no install script");
    const root = JSON.parse(await readSource("../package.json"));
    assert.equal(root.dependencies?.marked, undefined, "marked never joins the root runtime allowlist");
  });

  test("marked is never imported from dashboard/src — only by dashboard/vite-plugins", async () => {
    for (const [rel, src] of await dashboardSrcSources()) {
      assert.ok(!IMPORTS_MARKED.test(src), `${rel} imports marked — the browser must ship no markdown parser`);
    }
    assert.match(await readSource("../dashboard/vite-plugins/docs-markdown.js"), /from "marked";/);
    assert.ok(!IMPORTS_MARKED.test(await readSource("../dashboard/vite-plugins/docs-core.js")), "docs-core.js stays marked-free");
    assert.ok(!IMPORTS_MARKED.test(await readSource("../scripts/docs/inventories/corpus.ts")), "corpus.ts is stdlib-only");
  });
});

describe("corpus.json is the plugin's only membership truth (#4591 INV-2)", () => {
  test("the plugin reads docs/generated/corpus.json and never globs or walks directories", async () => {
    const src = await readSource("../dashboard/vite-plugins/docs-markdown.js");
    assert.ok(src.includes('"docs/generated/corpus.json"'));
    assert.ok(!/readdirSync|opendirSync|import\.meta\.glob|\bglob\b\s*\(/.test(src), "no plugin-side glob or walk");
    const cfg = await readSource("../dashboard/vite.config.js");
    assert.match(cfg, /hydraDocs\(\{ repoRoot, sha \}\)/);
  });
});

describe("heading slugs are GitHub-compatible (#4591 INV-8)", () => {
  test("slugger lowercases, strips punctuation, keeps - and _, suffixes duplicates", async () => {
    const { createSlugger } = await import("../dashboard/vite-plugins/docs-core.js");
    const s = createSlugger();
    assert.equal(s.slug("API Endpoints (port 4000, all under /api)"), "api-endpoints-port-4000-all-under-api");
    assert.equal(s.slug("Target Outcomes (issue #241, ADR-0003 + ADR-0004)"), "target-outcomes-issue-241-adr-0003--adr-0004");
    assert.equal(s.slug("snake_case & Stuff!"), "snake_case--stuff");
    assert.equal(s.slug("Events"), "events");
    assert.equal(s.slug("Events"), "events-1");
    assert.equal(s.slug("Events"), "events-2");
    assert.equal(s.slug("events-1"), "events-1-1");
  });

  test("one outline pass assigns slugs, sections and ADR §N ids from the same tokens", async () => {
    const { outlineTokens, splitSections } = await import("../dashboard/vite-plugins/docs-core.js");
    const h = (depth: number, text: string) => ({ type: "heading", depth, text, tokens: [{ type: "text", text }] });
    const tokens = [
      h(1, "Title"),
      { type: "paragraph", tokens: [] },
      h(2, "Decision"),
      h(3, "1. First rule"),
      { type: "blockquote", tokens: [h(3, "Nested")] },
      h(2, "Decision"),
      { type: "heading", depth: 3, text: "`code` here", tokens: [{ type: "codespan", text: "code" }, { type: "text", text: " here" }] },
    ];
    const { ids, headings } = outlineTokens(tokens);
    assert.deepEqual(
      headings.map((x: { slug: string; section: string; sec: string | null }) => `${x.slug}@${x.section}${x.sec ? `§${x.sec}` : ""}`),
      ["title@", "decision@decision", "1-first-rule@decision§1", "nested@decision", "decision-1@decision-1", "code-here@decision-1"],
    );
    assert.equal(ids.get(tokens[3]).sec, "1");
    const groups = splitSections(tokens);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].heading, null);
    assert.equal(groups[1].heading, tokens[2]);
  });
});

describe("the single link resolver (#4591 INV-7)", () => {
  const rows = [
    { path: "README.md", tier: "living", route: "/docs", title: "Hydra" },
    { path: "CONTEXT.md", tier: "living", route: "/docs/ref/context", title: "Glossary" },
    { path: "docs/reference.md", tier: "living", route: "/docs/ref/reference", title: "Ref" },
    { path: "CLAUDE.md", tier: "living", route: "/docs/system/architecture", title: "Hydra Orchestrator" },
  ];
  const outlines = new Map([
    ["README.md", { headings: [{ depth: 2, text: "How It Works", slug: "how-it-works", section: "how-it-works", sec: null }] }],
    ["CONTEXT.md", { headings: [{ depth: 2, text: "Language", slug: "language", section: "language", sec: null }] }],
    ["docs/reference.md", { headings: [{ depth: 2, text: "Redis Keys", slug: "redis-keys", section: "redis-keys", sec: null }] }],
    [
      "CLAUDE.md",
      {
        headings: [
          { depth: 2, text: "Architecture", slug: "architecture", section: "architecture", sec: null },
          { depth: 2, text: "Running", slug: "running", section: "running", sec: null },
        ],
      },
    ],
  ]);
  const files = new Map([
    ["src/api.ts", "file"],
    ["docs/research/x.md", "file"],
    ["src/redis", "dir"],
  ]);

  async function resolver(sha: string) {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const views = core.buildViews(rows, outlines);
    const hosts = core.headingHosts(views, outlines);
    for (const r of rows) files.set(r.path, "file");
    return core.createLinkResolver({ rows, outlines, hosts, fileKind: (p: string) => files.get(p) ?? null, sha });
  }

  test("members go to page routes, anchors to the view that hosts the heading", async () => {
    const resolve = await resolver("abc123");
    assert.deepEqual(resolve("../CONTEXT.md", "docs/reference.md"), { kind: "internal", href: "/docs/ref/context" });
    assert.deepEqual(resolve("./reference.md#redis-keys", "docs/reference.md"), { kind: "internal", href: "/docs/ref/reference/redis-keys#redis-keys" });
    assert.deepEqual(resolve("../CONTEXT.md#language", "docs/reference.md"), { kind: "internal", href: "/docs/ref/context#language" });
    assert.deepEqual(resolve("docs/reference.md#redis-keys", "README.md"), { kind: "internal", href: "/docs/ref/reference/redis-keys#redis-keys" });
    assert.deepEqual(resolve("#how-it-works", "README.md"), { kind: "internal", href: "/docs#how-it-works" });
    // A CLAUDE.md heading outside the Architecture view falls back to GitHub@SHA.
    assert.deepEqual(resolve("CLAUDE.md#running", "README.md"), {
      kind: "github",
      href: "https://github.com/gaberoo322/hydra/blob/abc123/CLAUDE.md#running",
    });
  });

  test("non-member repo paths go to GitHub at the build SHA, master when unknown; external links untouched", async () => {
    const resolve = await resolver("abc123");
    assert.deepEqual(resolve("src/api.ts", "README.md"), { kind: "github", href: "https://github.com/gaberoo322/hydra/blob/abc123/src/api.ts" });
    assert.deepEqual(resolve("docs/research/x.md", "README.md"), { kind: "github", href: "https://github.com/gaberoo322/hydra/blob/abc123/docs/research/x.md" });
    assert.deepEqual(resolve("src/redis/", "README.md"), { kind: "github", href: "https://github.com/gaberoo322/hydra/tree/abc123/src/redis" });
    assert.deepEqual(resolve("https://example.com/a#b", "README.md"), { kind: "external", href: "https://example.com/a#b" });
    assert.deepEqual(resolve("mailto:a@b.c", "README.md"), { kind: "external", href: "mailto:a@b.c" });
    const unknown = await resolver("unknown");
    assert.deepEqual(unknown("src/api.ts", "README.md"), { kind: "github", href: "https://github.com/gaberoo322/hydra/blob/master/src/api.ts" });
  });

  test("unresolvable links resolve to 'broken' (rendered visibly broken, never a build failure)", async () => {
    const resolve = await resolver("abc123");
    assert.equal(resolve("./nope.md", "README.md").kind, "broken");
    assert.equal(resolve("CONTEXT.md#no-such-heading", "README.md").kind, "broken");
    assert.equal(resolve("../../escape.md", "docs/reference.md").kind, "broken");
    assert.equal(resolve("javascript:alert(1)", "README.md").kind, "broken");
    assert.equal(resolve("", "README.md").kind, "broken");
    const plugin = await readSource("../dashboard/vite-plugins/docs-markdown.js");
    assert.ok(plugin.includes("docs-link-broken"), "broken links carry a distinct class");
    assert.match(plugin, /console\.warn\(`\[hydra-docs\] \$\{ctx\.path\}: unresolvable link/);
    assert.ok(!/throw\b/.test(plugin), "the docs plugin never throws — docs content never fails the build");
  });
});

describe("safety: frontmatter, raw HTML, comments, fences (#4591 INV-9)", () => {
  test("raw HTML is escaped, HTML comments dropped, frontmatter stripped", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    assert.equal(core.renderRawHtml("<!-- hidden -->", true), "");
    assert.equal(core.renderRawHtml('<script>alert("x")</script>', false), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    assert.equal(core.renderRawHtml("<details><!-- c -->open</details>", true), '<p class="docs-raw-html">&lt;details&gt;open&lt;/details&gt;</p>\n');
    assert.equal(core.stripFrontmatter("---\ntitle: x\n---\n# Hi\n"), "# Hi\n");
    assert.equal(core.stripFrontmatter("# No frontmatter\n---\n"), "# No frontmatter\n---\n");
  });

  test("fenced code renders monospace with a language label and no highlighting", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    assert.equal(
      core.renderCodeBlock("echo <hi>\n", "bash title=x"),
      '<div class="docs-code"><div class="docs-code-lang">bash</div><pre><code>echo &lt;hi&gt;</code></pre></div>\n',
    );
    assert.ok(!core.renderCodeBlock("x", "").includes("docs-code-lang"));
  });

  test("dangerouslySetInnerHTML appears only in Docs.jsx, fed from the build-time doc chunks", async () => {
    for (const [rel, src] of await docsPageSources()) {
      if (rel.endsWith("/Docs.jsx")) continue;
      assert.ok(!src.includes("dangerouslySetInnerHTML"), `${rel} injects HTML`);
    }
    const shell = await readSource("../dashboard/src/pages/docs/Docs.jsx");
    assert.equal((shell.match(/dangerouslySetInnerHTML/g) ?? []).length, 1);
    assert.match(shell, /import \{ docLoaders, nameIndex \} from "virtual:hydra-docs";/);
    const plugin = await readSource("../dashboard/vite-plugins/docs-markdown.js");
    assert.match(plugin, /import\(\$\{JSON\.stringify\(`\$\{DOC_PREFIX\}\$\{i\}`\)\}\)/, "one lazy chunk per corpus doc");
  });
});

describe("Markdown.jsx stays the untrusted-output renderer (#4591 INV-10)", () => {
  test("Markdown.jsx and markdown-inline.jsx share no code with the docs pipeline", async () => {
    const md = await readSource("../dashboard/src/components/dispatch/Markdown.jsx");
    const inline = await readSource("../dashboard/src/lib/markdown-inline.jsx");
    for (const src of [md, inline]) {
      assert.ok(!src.includes("vite-plugins"), "untrusted renderer must not import the docs pipeline");
      assert.ok(!/dangerouslySetInnerHTML=|__html/.test(src), "untrusted renderer never injects HTML");
    }
    for (const [rel, src] of await docsPageSources()) {
      assert.ok(!/Markdown\.jsx|markdown-inline/.test(src), `${rel} reuses the untrusted-output renderer`);
    }
  });
});

describe("views and name index (#4591 INV-12, INV-13)", () => {
  test("every committed corpus row routes to a built view; History views are flagged retired", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const corpus = JSON.parse(await readFile(new URL("docs/generated/corpus.json", ROOT), "utf8"));
    // A fixture outline so README section picks and the reference.md `##` split really run.
    const mk = (depth: number, text: string, slug: string) => ({ depth, text, slug, section: slug, sec: null });
    const outlines = new Map([
      ["README.md", { headings: [mk(2, "How It Works", "how-it-works"), mk(2, "Key Concepts", "key-concepts"), mk(2, "Safety Model", "safety-model")] }],
      ["docs/reference.md", { headings: [mk(2, "Redis Keys", "redis-keys"), mk(2, "Event Streams", "event-streams")] }],
    ]);
    const views = core.buildViews(corpus.rows, outlines);
    const concepts = views.find((v: { key: string }) => v.key === "system/concepts");
    assert.deepEqual(concepts?.sources, [{ path: "README.md", sections: ["key-concepts", "safety-model"] }]);
    const refKey = core.routeKey(corpus.rows.find((r: { path: string }) => r.path === "docs/reference.md").route);
    const refSubs = views.filter((v: { key: string }) => v.key.startsWith(`${refKey}/`)).map((v: { key: string }) => v.key);
    assert.deepEqual(refSubs, [`${refKey}/redis-keys`, `${refKey}/event-streams`], "one sub-view per ## section");
    const keys = new Set(views.map((v: { key: string }) => v.key));
    for (const row of corpus.rows) {
      assert.ok(keys.has(core.routeKey(row.route)), `${row.path} routes to ${row.route}, which has no built view`);
    }
    for (const v of views) {
      assert.equal(v.historical, v.group === "History", `${v.key} historical flag`);
      assert.ok(!/^(what|how do i|when should)/i.test(v.label), `${v.key} is titled by an operator situation`);
    }
  });

  test("name index covers hosted headings, glossary terms and routes; History hidden unless toggled", async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const { filterNameIndex } = await import("../dashboard/src/pages/docs/name-search.js");
    const rows = [
      { path: "CONTEXT.md", tier: "living", route: "/docs/ref/context", title: "Glossary" },
      { path: "docs/historical/old.md", tier: "historical", route: "/docs/history/old", title: "Old" },
    ];
    const outlines = new Map([
      ["CONTEXT.md", { headings: [{ depth: 2, text: "Language", slug: "language", section: "language", sec: null }] }],
      ["docs/historical/old.md", { headings: [{ depth: 2, text: "Old Language", slug: "old-language", section: "old-language", sec: null }] }],
    ]);
    const views = core.buildViews(rows, outlines);
    const hosts = core.headingHosts(views, outlines);
    const terms = core.extractGlossaryTerms("**Orchestrator**:\nThe control plane.\n\n**Target**: the product.\nnot **a term** here\n");
    assert.deepEqual(terms, ["Orchestrator", "Target"]);
    const index = core.buildNameIndex({
      views,
      outlines,
      hosts,
      rows,
      glossaryTerms: terms,
      routeRows: [{ method: "GET", path: "/api/language" }],
    });
    assert.deepEqual(
      index.map((e: { name: string; href: string; historical: boolean }) => `${e.name} -> ${e.href}${e.historical ? " (h)" : ""}`),
      [
        "Language -> /docs/ref/context#language",
        "Old Language -> /docs/history/old#old-language (h)",
        "Orchestrator -> /docs/ref/context",
        "Target -> /docs/ref/context",
        "GET /api/language -> /docs/cat/routes",
      ],
    );
    assert.deepEqual(filterNameIndex(index, "LANGUAGE").map((e: { name: string }) => e.name), ["Language", "GET /api/language"]);
    assert.deepEqual(
      filterNameIndex(index, "language", { includeHistory: true }).map((e: { name: string }) => e.name),
      ["Language", "Old Language", "GET /api/language"],
    );
    assert.deepEqual(filterNameIndex(index, "   "), []);
  });

  test("the search box sits on top of the tree and replaces it while a query is non-empty", async () => {
    const shell = await readSource("../dashboard/src/pages/docs/Docs.jsx");
    assert.ok(shell.includes('data-testid="docs-search"'));
    assert.ok(shell.includes("include History"));
    assert.match(shell, /\{searching \? \(\s*<SearchResults results=\{results\} \/>\s*\) : \(\s*DOCS_TREE\.map/);
    const tree = await readSource("../dashboard/src/pages/docs/tree.js");
    assert.match(tree, /import \{ views \} from "virtual:hydra-docs";/);
  });
});

describe("code-imported catalogue families on /docs (#4594)", () => {
  test("the tree lists the six families after Routes and each view renders in the Generated frame", async () => {
    const cats = await readSource("../dashboard/src/pages/docs/catalogues.js");
    const labels = [...cats.matchAll(/\{ family: "([^"]+)", label: "([^"]+)" \}/g)].map((m) => `${m[1]}=${m[2]}`);
    assert.deepEqual(labels, [
      "redis-keys=Redis keys",
      "streams=Streams",
      "schemas=Schemas",
      "tier-paths=Tier paths",
      "chores=Chores",
      "env-vars=Env vars",
      // The scanned infra families (#4595).
      "pages=Pages",
      "config=Config",
      "ci-gates=CI gates",
      "units-scripts=Units & scripts",
    ]);
    const tree = await readSource("../dashboard/src/pages/docs/tree.js");
    assert.ok(tree.indexOf('label: "Routes"') < tree.indexOf("...CODE_CATALOGUES"), "families follow Routes");
    const shell = await readSource("../dashboard/src/pages/docs/Docs.jsx");
    assert.match(shell, /<Generated family=\{family\} inventory=\{inventory\}>/);
    assert.match(shell, /catalogueKey\(family\), catalogueView\(family, label\)/);
    const table = await readSource("../dashboard/src/pages/docs/Catalogue.jsx");
    assert.ok(table.includes("no route reads this directly"));
    assert.match(table, /export const COLUMN_SPECS = \{/);
  });

  test("ci-gates catalogue is honest about the ci.yml convention (#4595)", async () => {
    const table = await readSource("../dashboard/src/pages/docs/Catalogue.jsx");
    assert.ok(table.includes('"required (ci.yml convention)"'), "the required column names its convention");
    assert.ok(table.includes("branches/master/protection"), "the caveat names the branch-protection spot-check");
    assert.ok(table.includes("design-concept-reconcile") && table.includes("push-only"), "the caveat names the known mismatches");
    const ciStart = table.indexOf('"ci-gates": [');
    const ciEnd = table.indexOf('"units-scripts": [');
    assert.ok(ciStart >= 0 && ciEnd > ciStart, "ci-gates and units-scripts column specs exist, in that order");
    const ciSpec = table.slice(ciStart, ciEnd);
    assert.ok(ciSpec.includes("required (ci.yml convention)"), "the slice really covers the ci-gates columns");
    assert.ok(!/advisory/i.test(ciSpec), "a required:false ci-gates row is never labelled 'advisory'");
    const shell = await readSource("../dashboard/src/pages/docs/Docs.jsx");
    assert.match(shell, /\{CATALOGUE_CAVEATS\[family\]\}/);
  });
});

describe("URL-hash decoding never throws (#4591 QA)", () => {
  test("hashToId decodes valid escapes and falls back to the raw hash on a malformed one", async () => {
    const { hashToId } = await import("../dashboard/src/pages/docs/name-search.js");
    assert.equal(hashToId("#redis-keys"), "redis-keys");
    assert.equal(hashToId("#%C2%A71"), "\u00a71");
    assert.equal(hashToId("#bad%E0%A4%A"), "bad%E0%A4%A");
    assert.equal(hashToId(""), "");
    const shell = await readSource("../dashboard/src/pages/docs/Docs.jsx");
    assert.ok(!/decodeURIComponent/.test(shell), "Docs.jsx decodes the hash only through the guarded hashToId");
  });
});

describe("the marked adapter renders what the pure core promises (#4591 QA)", async () => {
  // marked is a dashboard devDependency; the root test job has no dashboard/node_modules,
  // so this runs wherever `cd dashboard && npm ci` has happened and skips otherwise.
  let Marked: undefined | (new (o: object) => { lexer(s: string): unknown[] });
  try {
    ({ Marked } = await import(new URL("../dashboard/node_modules/marked/lib/marked.esm.js", import.meta.url).href));
  } catch (err) {
    /* intentional: marked not installed in this checkout — the adapter test skips */
    void err;
  }

  test("heading ids, resolved links, broken links and escaped raw HTML", { skip: Marked ? false : "marked not installed" }, async () => {
    const core = await import("../dashboard/vite-plugins/docs-core.js");
    const { createRenderer } = await import("../dashboard/vite-plugins/docs-markdown.js");
    const lexer = new Marked!({ gfm: true });
    const rows = [
      { path: "README.md", tier: "living", route: "/docs", title: "Hydra" },
      { path: "CONTEXT.md", tier: "living", route: "/docs/ref/context", title: "Glossary" },
    ];
    const src = [
      "## How It Works",
      "",
      "See [glossary](CONTEXT.md), [code](src/api.ts), [gone](./nope.md), [evil](javascript:alert(1)).",
      "",
      "<script>alert(1)</script>",
      "",
      "```ts",
      "const a = '<b>';",
      "```",
    ].join("\n");
    const tokens = lexer.lexer(src);
    const outline = core.outlineTokens(tokens);
    const outlines = new Map([["README.md", { headings: outline.headings }]]);
    const views = core.buildViews(rows, outlines);
    const hosts = core.headingHosts(views, outlines);
    const resolveLink = core.createLinkResolver({
      rows,
      outlines,
      hosts,
      fileKind: (p: string) => (p === "src/api.ts" || p === "CONTEXT.md" ? "file" : null),
      sha: "abc123",
    });
    const render = createRenderer({ resolveLink, docs: new Map([["README.md", { tokens, outline }]]) });
    const sections = render("README.md") as { slug: string; html: string }[];
    const html = sections.map((x) => x.html).join("\n");
    assert.match(html, /<h2 id="how-it-works">/);
    assert.match(html, /<a href="\/docs\/ref\/context">glossary<\/a>/);
    assert.match(html, /<a href="https:\/\/github\.com\/gaberoo322\/hydra\/blob\/abc123\/src\/api\.ts" target="_blank" rel="noreferrer" class="docs-link-out">code<\/a>/);
    assert.equal((html.match(/data-broken="true"/g) ?? []).length, 2, "unresolvable and javascript: links render visibly broken");
    assert.ok(!html.includes("<script>"), "raw HTML is escaped, never emitted");
    assert.ok(!html.includes("href=\"javascript:"), "no javascript: href survives");
  });

  test("docs-markdown.js registers the html and code renderer overrides", async () => {
    const plugin = await readSource("../dashboard/vite-plugins/docs-markdown.js");
    assert.match(plugin, /html\(token\)\s*\{\s*return renderRawHtml\(/);
    assert.match(plugin, /code\(token\)\s*\{\s*return renderCodeBlock\(/);
  });
});
