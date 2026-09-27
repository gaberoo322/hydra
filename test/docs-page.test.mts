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
  test("routes.json is read via an eager ?raw glob, never a static import", async () => {
    const src = await readSource("../dashboard/src/pages/docs/inventories.js");
    assert.match(src, /import\.meta\.glob\("\.\.\/\.\.\/\.\.\/\.\.\/docs\/generated\/routes\.json"/);
    assert.match(src, /query: "\?raw"/);
    assert.match(src, /eager: true/);
    assert.match(src, /JSON\.parse\(raw\)/);
    assert.match(src, /schemaVersion !== 1/);
    for (const [rel, s] of await docsPageSources()) {
      assert.ok(!/import\s+\w+\s+from\s+["'][^"']*routes\.json["']/.test(s), `${rel} statically imports routes.json`);
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
