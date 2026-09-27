import { NavLink, useParams } from "react-router-dom";
import Provenance from "./Provenance.jsx";
import Generated from "./Generated.jsx";
import RoutesCatalogue, { LiveLink } from "./RoutesCatalogue.jsx";
import { inventoryFile, loadRoutesInventory } from "./inventories.js";
import { DOCS_TREE, docsHref } from "./tree.js";

// /docs — the Orchestrator reference surface (#4590, ADR-0034 §10). The
// Variant A "Manual" three-pane shell (prototype/docs-4545 @ 23f33647):
// left, the nav tree (System → Areas → Catalogues); centre, the view with
// the provenance line first; right, the rail (Live state lives on · On this
// page · Source — only the sections that have content).
//
// App.jsx mounts ONE splat route (`/docs/*`); this shell resolves the splat to
// a view key. Unbuilt entries are ABSENT from the tree and unknown keys render
// an explicit 'not built yet' state — never fake content.
//
// Hard line (§10): nothing on this page is loaded over the network at view
// time. Inventories are baked into the bundle at build time (inventories.js).

const routes = loadRoutesInventory();

function Tree() {
  return (
    <nav data-testid="docs-tree" className="sticky top-0 h-screen w-60 shrink-0 space-y-4 overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-3">
      {DOCS_TREE.map(({ group, entries }) => (
        <div key={group}>
          <div className="mb-1 px-2 text-[10px] uppercase tracking-wider text-zinc-600">{group}</div>
          {entries.length === 0 ? (
            <div className="px-2 text-[12px] italic text-zinc-700">not yet generated</div>
          ) : (
            entries.map((e) => (
              <NavLink
                key={e.key}
                to={docsHref(e.key)}
                end
                className={({ isActive }) =>
                  `block truncate rounded px-2 py-0.5 text-[13px] ${
                    isActive ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-100"
                  }`
                }
              >
                {e.label}
                {e.count != null && <span className="ml-1 text-zinc-600">{e.count}</span>}
              </NavLink>
            ))
          )}
        </div>
      ))}
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
              <li key={t.id}>
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

function entryView() {
  const built = DOCS_TREE.find((g) => g.group === "Catalogues").entries;
  return {
    body: (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Hydra — system reference</h1>
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

/** View key → view. Later slices add keys here, never in App.jsx. */
const VIEWS = {
  "": entryView,
  "cat/routes": routesView,
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

export default function Docs() {
  const viewKey = (useParams()["*"] ?? "").replace(/\/+$/, "");
  const view = VIEWS[viewKey] ? VIEWS[viewKey]() : notBuiltView({ viewKey });
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
