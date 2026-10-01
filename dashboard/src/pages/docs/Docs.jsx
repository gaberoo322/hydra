import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { docLoaders, nameIndex } from "virtual:hydra-docs";
import Provenance from "./Provenance.jsx";
import Generated from "./Generated.jsx";
import RoutesCatalogue, { LiveLink } from "./RoutesCatalogue.jsx";
import Catalogue, { CATALOGUE_CAVEATS } from "./Catalogue.jsx";
import { CODE_CATALOGUES, catalogueKey, liveHomes } from "./catalogues.js";
import { inventoryFile, loadInventory, loadRoutesInventory } from "./inventories.js";
import { sourceUrl } from "./build-info.js";
import { filterNameIndex, hashToId } from "./name-search.js";
import { DOCS_TREE, DOCS_VIEWS, docsHref } from "./tree.js";
import "./docs-prose.css";

// /docs — the Orchestrator reference surface (#4590, ADR-0034 §10). The
// Variant A "Manual" three-pane shell (prototype/docs-4545 @ 23f33647):
// left, the nav tree (System → Areas → Catalogues) with the name search on
// top; centre, the view with the provenance line first; right, the rail
// (Live state lives on · On this page · Source — only the sections that have
// content).
//
// App.jsx mounts ONE splat route (`/docs/*`); this shell resolves the splat to
// a view key. Unbuilt entries are ABSENT from the tree and unknown keys render
// an explicit 'not built yet' state — never fake content.
//
// Hard line (§10): nothing on this page is loaded over the network at view
// time. Inventories are baked into the bundle at build time (inventories.js);
// markdown views (#4591) are HTML rendered at BUILD time by
// dashboard/vite-plugins/docs-markdown.js — one lazy bundle chunk per doc,
// never a runtime markdown parse. That build-time output from corpus-listed
// repo files is the only HTML this page injects.

const routes = loadRoutesInventory();

function TreeEntries({ entries }) {
  return entries.map((e) =>
    e.header ? (
      <div key={`h:${e.header}`} className={`mt-2 px-2 text-[11px] font-medium ${e.retired ? "text-zinc-600" : "text-zinc-500"}`}>
        {e.header}
        {e.retired && <span className="ml-1 text-[10px] uppercase tracking-wider text-zinc-700">retired</span>}
      </div>
    ) : (
      <NavLink
        key={e.key}
        to={docsHref(e.key)}
        end
        style={e.depth ? { paddingLeft: `${0.5 + e.depth * 0.6}rem` } : undefined}
        className={({ isActive }) =>
          `block truncate rounded px-2 py-0.5 text-[13px] ${
            isActive ? "bg-zinc-800 text-white" : e.historical ? "text-zinc-600 hover:text-zinc-300" : "text-zinc-400 hover:text-zinc-100"
          }`
        }
      >
        {e.label}
        {e.count != null && <span className="ml-1 text-zinc-600">{e.count}</span>}
      </NavLink>
    ),
  );
}

function SearchResults({ results }) {
  if (results.length === 0) return <div className="px-2 text-[12px] italic text-zinc-600">no matching names</div>;
  return (
    <ul data-testid="docs-search-results" className="space-y-0.5">
      {results.map((r, i) => (
        <li key={`${r.href}:${i}`}>
          <Link to={r.href} className="block rounded px-2 py-0.5 text-[12px] text-zinc-300 hover:bg-zinc-900 hover:text-white">
            <span className={r.historical ? "text-zinc-500" : ""}>{r.name}</span>
            <span className="ml-1 text-[10px] uppercase tracking-wider text-zinc-600">{r.historical ? "history" : r.kind}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Tree() {
  const [query, setQuery] = useState("");
  const [withHistory, setWithHistory] = useState(false);
  const searching = query.trim() !== "";
  const results = searching ? filterNameIndex(nameIndex, query, { includeHistory: withHistory }) : [];
  return (
    <nav data-testid="docs-tree" className="sticky top-0 h-screen w-60 shrink-0 space-y-4 overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-3">
      <div className="space-y-1">
        <input
          type="search"
          data-testid="docs-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search names…"
          className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
        <label className="flex items-center gap-1 px-1 text-[11px] text-zinc-500">
          <input type="checkbox" checked={withHistory} onChange={(e) => setWithHistory(e.target.checked)} />
          include History
        </label>
      </div>
      {searching ? (
        <SearchResults results={results} />
      ) : (
        DOCS_TREE.map(({ group, entries }) => (
          <div key={group}>
            <div className="mb-1 px-2 text-[10px] uppercase tracking-wider text-zinc-600">{group}</div>
            {entries.length === 0 ? (
              <div className="px-2 text-[12px] italic text-zinc-700">not yet generated</div>
            ) : (
              <TreeEntries entries={entries} />
            )}
          </div>
        ))
      )}
    </nav>
  );
}

function RailSection({ title, children }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">{title}</div>
      {children}
    </div>
  );
}

function Rail({ live, toc, source }) {
  const hasLive = live?.length > 0;
  const hasToc = toc?.length > 0;
  if (!hasLive && !hasToc && !source) return null;
  return (
    <aside data-testid="docs-rail" className="sticky top-0 h-screen w-56 shrink-0 space-y-4 overflow-y-auto border-l border-zinc-800 p-3 text-[12px]">
      {hasLive && (
        <RailSection title="Live state lives on">
          <div className="flex flex-wrap gap-1">
            {live.map((l) => (
              <LiveLink key={l} to={l} />
            ))}
          </div>
        </RailSection>
      )}
      {hasToc && (
        <RailSection title="On this page">
          <ul className="space-y-0.5">
            {toc.map((t) => (
              <li key={t.id} style={t.depth > 2 ? { paddingLeft: `${(t.depth - 2) * 0.6}rem` } : undefined}>
                <a href={`#${t.id}`} className="line-clamp-1 text-zinc-400 hover:text-zinc-100">
                  {t.text}
                </a>
              </li>
            ))}
          </ul>
        </RailSection>
      )}
      {source && <RailSection title="Source">{source}</RailSection>}
    </aside>
  );
}

/**
 * The rendered body of a markdown view: loads each source doc's lazy chunk
 * (build-time HTML), keeps only the sections this view shows, and routes
 * in-page /docs links through react-router instead of a full reload.
 */
function MarkdownBody({ view }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [loaded, setLoaded] = useState({ key: null, docs: null, error: null });

  useEffect(() => {
    let live = true;
    const paths = [...new Set(view.sources.map((s) => s.path))];
    Promise.all(paths.map((p) => (docLoaders[p] ? docLoaders[p]() : Promise.resolve({ default: null }))))
      .then((mods) => {
        if (live) setLoaded({ key: view.key, docs: new Map(mods.map((m, i) => [paths[i], m.default])), error: null });
      })
      .catch((err) => {
        console.error(`[docs] failed to load the rendered chunk for ${paths.join(", ")}`, err);
        if (live) setLoaded({ key: view.key, docs: null, error: String(err?.message ?? err) });
      });
    return () => {
      live = false;
    };
  }, [view]);

  const ready = loaded.key === view.key && loaded.docs;
  useEffect(() => {
    if (!ready || !location.hash) return;
    const el = document.getElementById(hashToId(location.hash));
    if (el) el.scrollIntoView();
  }, [ready, location.hash]);

  if (loaded.key === view.key && loaded.error) {
    return <div className="text-sm text-amber-300">rendered doc failed to load: {loaded.error}</div>;
  }
  if (!ready) return <div className="text-sm text-zinc-600">loading…</div>;

  const parts = [];
  for (const s of view.sources) {
    const doc = loaded.docs.get(s.path);
    if (!doc) {
      parts.push(`<p class="docs-link-broken">source missing from this build: ${s.path.replace(/[<>&]/g, "")}</p>`);
      continue;
    }
    for (const sec of doc.sections) {
      if (s.sections === null || s.sections.includes(sec.slug)) parts.push(sec.html);
    }
  }

  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.("a[href]");
    const href = a?.getAttribute("href");
    if (href && href.startsWith("/docs")) {
      e.preventDefault();
      navigate(href);
    }
  };

  return (
    <div data-testid="docs-markdown" className="docs-prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: parts.join("") }} />
  );
}

function SourceList({ paths }) {
  return (
    <ul className="space-y-0.5 font-mono text-[11px]">
      {paths.map((p) => (
        <li key={p}>
          <a href={sourceUrl(p)} target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-zinc-300">
            {p}
          </a>
        </li>
      ))}
    </ul>
  );
}

function markdownView(view) {
  const paths = [...new Set(view.sources.map((s) => s.path))];
  return {
    body: (
      <div className={view.historical ? "docs-retired space-y-3" : "space-y-3"}>
        {view.historical && (
          <div data-testid="docs-retired" className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-400">
            <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">retired</span>
            Historical record — describes a subsystem or practice Hydra no longer runs.
          </div>
        )}
        <MarkdownBody view={view} />
        {view.children?.length > 0 && (
          <ul className="space-y-1 text-sm">
            {view.children.map((c) => (
              <li key={c.key}>
                <NavLink to={docsHref(c.key)} className="text-sky-400 hover:underline">
                  {c.label}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    ),
    toc: view.toc,
    source: <SourceList paths={paths} />,
  };
}

function entryView() {
  const built = DOCS_TREE.find((g) => g.group === "Catalogues").entries.filter((e) => !e.header && !e.historical && (e.depth ?? 0) <= 1);
  const overview = DOCS_VIEWS.get("");
  const md = overview ? markdownView(overview) : null;
  return {
    body: (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Hydra — system reference</h1>
        {md?.body}
        <div>
          <h2 className="mb-2 text-sm font-semibold text-zinc-300">Catalogues</h2>
          <ul className="space-y-1 text-sm">
            {built.map((e) => (
              <li key={e.key}>
                <NavLink to={docsHref(e.key)} className="text-sky-400 hover:underline">
                  {e.label}
                </NavLink>
                {e.count != null && <span className="ml-1 text-zinc-500">{e.count} rows</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    ),
    toc: md?.toc,
    source: md?.source,
  };
}

function routesView() {
  // Distinct cockpit-page homes (non-/api), in first-seen file order.
  const live = routes.ok
    ? [...new Set(routes.rows.map((r) => r.home).filter((h) => typeof h === "string" && !h.startsWith("/api")))]
    : [];
  return {
    body: (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Routes</h1>
        <Generated family="routes" inventory={routes}>
          {routes.ok && <RoutesCatalogue rows={routes.rows} />}
        </Generated>
      </div>
    ),
    live,
    source: (
      <div className="space-y-1 font-mono text-[11px] text-zinc-500">
        <div>{inventoryFile("routes")}</div>
        {routes.ok && routes.generatedFrom.length > 0 && (
          <div>
            <div className="text-zinc-600">generated from</div>
            <ul>
              {routes.generatedFrom.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    ),
  };
}

/** The rail Source section: the inventory file plus its generatedFrom globs. */
function sourceRail(family, inventory) {
  return (
    <div className="space-y-1 font-mono text-[11px] text-zinc-500">
      <div>{inventoryFile(family)}</div>
      {inventory.ok && inventory.generatedFrom.length > 0 && (
        <div>
          <div className="text-zinc-600">generated from</div>
          <ul>
            {inventory.generatedFrom.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One code-imported catalogue view (#4594): Generated frame + generic table + rail. */
function catalogueView(family, label) {
  return () => {
    const inventory = loadInventory(family);
    return {
      body: (
        <div className="space-y-3">
          <h1 className="text-2xl font-bold">{label}</h1>
          {CATALOGUE_CAVEATS[family]}
          <Generated family={family} inventory={inventory}>
            {inventory.ok && <Catalogue family={family} rows={inventory.rows} />}
          </Generated>
        </div>
      ),
      live: liveHomes(family, inventory),
      source: sourceRail(family, inventory),
    };
  };
}

/**
 * View key → view. Hand-built views live here; markdown views come from the
 * build-time manifest (DOCS_VIEWS). Later slices add keys here, never in App.jsx.
 */
const VIEWS = {
  "": entryView,
  "cat/routes": routesView,
  ...Object.fromEntries(CODE_CATALOGUES.map(({ family, label }) => [catalogueKey(family), catalogueView(family, label)])),
};

function notBuiltView({ viewKey }) {
  return {
    body: (
      <div data-testid="docs-not-built" className="text-sm text-zinc-500">
        not built yet: <span className="font-mono">/docs/{viewKey}</span>
      </div>
    ),
  };
}

function resolveView(viewKey) {
  if (VIEWS[viewKey]) return VIEWS[viewKey]();
  const md = DOCS_VIEWS.get(viewKey);
  return md ? markdownView(md) : notBuiltView({ viewKey });
}

export default function Docs() {
  const viewKey = (useParams()["*"] ?? "").replace(/\/+$/, "");
  const view = resolveView(viewKey);
  return (
    // -m-6 reclaims Layout's padding so the three panes run edge to edge;
    // Layout.jsx itself is unchanged.
    <div data-testid="docs-shell" className="-m-6 flex">
      <Tree />
      <main className="min-w-0 flex-1 p-6">
        <Provenance />
        {view.body}
      </main>
      <Rail live={view.live} toc={view.toc} source={view.source} />
    </div>
  );
}
