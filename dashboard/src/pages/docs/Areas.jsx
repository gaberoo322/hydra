// The Areas surfaces (#4596 — docs-epic slice 10). Two components:
//
//  - AreasGrid: the entry view's grid of every CONTEXT-MAP area, inside ONE
//    Generated frame (family 'areas'). One tile per row in CONTEXT-MAP order
//    (domain table, then infra): live tiles link to /docs/area/<slug>; retired
//    rows are muted tombstones whose ONLY links are their ADR sub-views and
//    /docs/history/readme — never /docs/area/* (a retired area has no view).
//  - The AreaBody pieces (AreaTerms / AreaAdrs / AreaReferenceDocs /
//    AreaSlices), composed into the area view by Docs.jsx — which owns
//    MarkdownBody, so the module-map section stays there.
//
// Everything shown comes from docs/generated/areas.json (+ adrs.json,
// counts.json, the build-time areaRefs) — never a view-time network call
// (ADR-0034 §10). `areaRefs` is imported HERE, not into Docs.jsx: the
// docs-page test pins Docs.jsx's virtual-module import line exactly.

import { Link } from "react-router-dom";
import { areaRefs } from "virtual:hydra-docs";
import Generated from "./Generated.jsx";
import { adrRoute } from "./adrs.js";
import { CODE_CATALOGUES, catalogueKey } from "./catalogues.js";
import { docsHref } from "./tree.js";
import { loadInventory } from "./inventories.js";

/**
 * The slice families a row's `slices` can key, with the human label and the
 * catalogue view each slice frame links to. `skills` shares the ONE
 * Classes & skills catalogue (#4592); `corpus` has no catalogue — its rows are
 * this area's module maps, already rendered in the body — so it links nowhere.
 */
const SLICES = new Map([
  ["routes", { label: "routes", to: docsHref(catalogueKey("routes")) }],
  ["classes", { label: "classes", to: docsHref(catalogueKey("classes")) }],
  ["skills", { label: "skills", to: docsHref(catalogueKey("classes")) }],
  ["adrs", { label: "ADRs", to: docsHref(catalogueKey("adrs")) }],
  ...CODE_CATALOGUES.map(({ family, label }) => [family, { label: label.toLowerCase(), to: docsHref(catalogueKey(family)) }]),
  ["corpus", { label: "module maps", to: null }],
]);

/** The '<n> <family>' chip line of one tile (non-empty slices + the ADR count). */
function SliceCounts({ row }) {
  const chips = Object.entries(row.slices).map(([family, rows]) => (
    <span key={family}>
      {rows.length} {SLICES.get(family)?.label ?? family}
    </span>
  ));
  chips.push(<span key="adrs-count">{row.adrs.length} ADRs</span>);
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-zinc-500">
      {dotJoin(chips)}
    </div>
  );
}

/** Interleave children with the '·' separators the chip lines use. */
function dotJoin(items) {
  const out = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(<span key={`dot-${i}`} className="text-zinc-700">·</span>);
    out.push(item);
  });
  return out;
}

function RetiredTile({ row }) {
  return (
    <div data-testid="area-tile-retired" className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 opacity-60">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-sm text-zinc-500 line-through">{row.name}</span>
        <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">retired</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
        {row.adrs.map((n) => (
          <Link key={n} to={adrRoute(n)} className="font-mono text-zinc-500 hover:text-zinc-300">
            ADR-{n}
          </Link>
        ))}
        <Link to="/docs/history/readme" className="text-zinc-600 hover:text-zinc-400">
          history
        </Link>
      </div>
    </div>
  );
}

function LiveTile({ row }) {
  return (
    <div data-testid="area-tile" className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <Link to={row.route} className="font-mono text-sm text-sky-400 hover:underline">
        {row.name}
      </Link>
      {row.terms.length > 0 && (
        <div className="mt-0.5 line-clamp-1 text-[11px] text-zinc-500">
          {dotJoin(row.terms.map((t) => <span key={t.name}>{t.name}</span>))}
        </div>
      )}
      <div className="mt-1">
        <SliceCounts row={row} />
      </div>
    </div>
  );
}

/**
 * The entry view's Areas grid (#4596 INV-13): ONE Generated frame (family
 * 'areas') whose header line carries counts.json's areas/live and
 * areas/retired values, then every row as a tile.
 */
export function AreasGrid() {
  const areas = loadInventory("areas");
  const counts = loadInventory("counts");
  const metric = (name) =>
    counts.ok ? counts.rows.find((r) => r.family === "areas" && r.metric === name)?.value : undefined;
  const live = metric("live");
  const retired = metric("retired");
  return (
    <Generated family="areas" inventory={areas} title="Areas">
      <div data-testid="areas-grid" className="space-y-3">
        <div className="font-mono text-[11px] text-zinc-500">
          areas/live {live ?? "?"} · areas/retired {retired ?? "?"}
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2">
          {areas.rows.map((row) => (row.retired ? <RetiredTile key={row.slug} row={row} /> : <LiveTile key={row.slug} row={row} />))}
        </div>
      </div>
    </Generated>
  );
}

/** The terms line of an area view (#4596 INV-11): each term links into /docs/ref/context's paragraph anchor. */
export function AreaTerms({ row }) {
  if (row.terms.length === 0) return null;
  return (
    <div data-testid="area-terms" className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="text-zinc-500">Glossary terms</span>
      {dotJoin(
        row.terms.map((t) =>
          t.anchor ? (
            <Link key={t.name} to={`/docs/ref/context#${t.anchor}`} className="text-sky-400 hover:underline">
              {t.name}
            </Link>
          ) : (
            <span key={t.name} className="text-zinc-400">{t.name}</span>
          ),
        ),
      )}
    </div>
  );
}

/**
 * The ADR lists of an area view (#4596 INV-14): the Relevant-ADRs cell first
 * (linked, titled from adrs.json), then — muted, labelled 'cited by this
 * area's docs' — the ADRs this area's module map / reference docs cite beyond
 * that cell.
 */
export function AreaAdrs({ row, adrsInventory }) {
  const titleOf = (n) =>
    adrsInventory.ok ? adrsInventory.rows.find((r) => r.number === n)?.title ?? null : null;
  return (
    <div data-testid="area-adrs" className="space-y-1.5 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-zinc-500">Relevant ADRs</span>
        {row.adrs.map((n) => (
          <span key={n}>
            <Link to={adrRoute(n)} className="font-mono text-[12px] text-sky-400 hover:underline">
              ADR-{n}
            </Link>
            {titleOf(n) && <span className="ml-1 text-[12px] text-zinc-500">{titleOf(n)}</span>}
          </span>
        ))}
      </div>
      {row.adrsCited.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 opacity-70">
          <span className="text-[12px] text-zinc-500">cited by this area's docs</span>
          {row.adrsCited.map((n) => (
            <Link key={n} to={adrRoute(n)} className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300">
              ADR-{n}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The Reference-docs cell of an area view (#4596 INV-12): the links the vite
 * plugin resolved at build time (keyed by route in the virtual module's
 * areaRefs) — a broken one keeps the docs-link-broken class the renderer uses.
 */
export function AreaReferenceDocs({ row }) {
  const refs = areaRefs[row.route];
  if (!refs || refs.length === 0) return null;
  return (
    <div data-testid="area-reference-docs" className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="text-zinc-500">Reference docs</span>
      {refs.map((ref) => (
        <Link
          key={`${ref.path}#${ref.anchor ?? ""}`}
          to={ref.href}
          className={`text-[12px] ${ref.kind === "broken" ? "docs-link-broken text-amber-500" : "text-sky-400 hover:underline"}`}
        >
          {ref.path}
          {ref.anchor ? `#${ref.anchor}` : ""}
        </Link>
      ))}
    </div>
  );
}

/**
 * One Generated frame per non-empty slice (#4596 INV-14): the family-derived
 * header (Generated derives file names from `family`), the slice's label
 * strings as rows, and — for families that have one — a link to the catalogue.
 */
export function AreaSlices({ row }) {
  return (
    <div data-testid="area-slices" className="space-y-2">
      {Object.entries(row.slices).map(([family, rows]) => {
        const meta = SLICES.get(family);
        return (
          <Generated key={family} family={family} title={meta?.label ?? family} inventory={{ ok: true, rows, generatedFrom: [] }}>
            <div className="space-y-1">
              {meta?.to && (
                <Link to={meta.to} className="text-[12px] text-sky-400 hover:underline">
                  open the {meta.label} catalogue
                </Link>
              )}
              <ul className="space-y-0.5 font-mono text-[11px] text-zinc-400">
                {rows.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </div>
          </Generated>
        );
      })}
    </div>
  );
}
