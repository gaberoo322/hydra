import { Link } from "react-router-dom";
import { sourceUrl } from "./build-info.js";
import { LiveLink } from "./RoutesCatalogue.jsx";

// Generic catalogue table for the code-imported families (#4594, ADR-0034
// §10). ONE table driven by a per-family column spec — not six bespoke
// components — so the trust rules live in one place:
//
//  - rows render in the inventory's own order (the extractor's sort); the page
//    never re-sorts or hand-filters;
//  - redis-keys / streams rows deep-link OUT to their `home` (never a restated
//    live value); a null home reads 'no route reads this directly', never a
//    guessed page;
//  - schemas rows link their routes to the routes catalogue;
//  - tier-paths, chores and env-vars rows show no live state and no link-out;
//  - the scanned infra families (#4595): pages rows deep-link to the page
//    (live) or show the pattern / redirect target; config, ci-gates and
//    units-scripts rows link only to their source file at the build SHA.

const MUTED = <span className="text-zinc-600">—</span>;

function SourceLink({ source }) {
  if (!source?.path) return MUTED;
  return (
    <a
      href={sourceUrl(source.path, source.line)}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
    >
      {source.path}:{source.line}
    </a>
  );
}

function SourceText({ source }) {
  if (!source?.path) return MUTED;
  return (
    <span className="font-mono text-[11px] text-zinc-500">
      {source.path}:{source.line}
    </span>
  );
}

function Home({ home }) {
  if (!home) return <span className="text-[11px] italic text-zinc-600">no route reads this directly</span>;
  return <LiveLink to={home} />;
}

function List({ items, max = 4 }) {
  if (!items?.length) return MUTED;
  const shown = items.slice(0, max);
  return (
    <span className="font-mono text-[11px] text-zinc-500">
      {shown.join(", ")}
      {items.length > max && <span className="text-zinc-600"> +{items.length - max} more</span>}
    </span>
  );
}

function RouteLinks({ routes }) {
  if (!routes?.length) return MUTED;
  return (
    <span className="flex flex-wrap gap-1">
      {routes.map((r) => (
        <Link key={r} to="/docs/cat/routes" className="font-mono text-[11px] text-sky-400 hover:underline">
          {r}
        </Link>
      ))}
    </span>
  );
}

const mono = (v) => <span className="font-mono text-zinc-200">{v}</span>;

/** Per-family column spec: [header, (row) => cell]. */
export const COLUMN_SPECS = {
  "redis-keys": [
    ["builder", (r) => (r.retired ? <span className="text-amber-400">retired</span> : mono(r.builder))],
    ["pattern", (r) => <span className="font-mono text-[11px] text-zinc-300">{r.pattern}</span>],
    ["call sites", (r) => <span className="text-zinc-400">{r.callSites}</span>],
    ["accessors", (r) => <List items={r.accessors} max={3} />],
    ["source", (r) => <SourceLink source={r.source} />],
    ["home (live state)", (r) => <Home home={r.home} />],
  ],
  streams: [
    ["key", (r) => mono(r.key)],
    ["constant", (r) => <span className="font-mono text-[11px] text-zinc-400">{`${r.retained ? "RETAINED_STREAMS" : "STREAMS"}.${r.constant}`}</span>],
    ["consumer groups", (r) => <List items={r.consumerGroups} />],
    ["source", (r) => <SourceLink source={r.source} />],
    ["home (live state)", (r) => <Home home={r.home} />],
  ],
  schemas: [
    ["name", (r) => mono(r.name)],
    ["source", (r) => <SourceLink source={r.source} />],
    ["imported by", (r) => <List items={r.importedBy} max={3} />],
    ["routes", (r) => <RouteLinks routes={r.routes} />],
  ],
  "tier-paths": [
    ["tier", (r) => <span className="font-mono text-zinc-300">T{r.tier}</span>],
    ["kind", (r) => <span className="text-zinc-500">{r.kind}</span>],
    ["path", (r) => mono(r.path)],
    ["source", (r) => <SourceText source={r.source} />],
  ],
  chores: [
    ["order", (r) => <span className="text-zinc-500">{r.order}</span>],
    ["name", (r) => mono(r.name)],
    ["cadence", (r) => <span className="text-zinc-400">{r.cadence}</span>],
    ["source", (r) => <SourceText source={r.source} />],
  ],
  "env-vars": [
    ["name", (r) => mono(r.name)],
    ["read sites", (r) => <List items={r.readSites.map((s) => `${s.path}:${s.line}`)} max={2} />],
    ["in .env.example", (r) => <span className="text-zinc-500">{r.inEnvExample ? "yes" : "no"}</span>],
  ],
  // Scanned infra families (#4595): pages link to the page itself (a deep
  // link, never a live value); config / ci-gates / units-scripts rows link
  // only to their source file at the build SHA.
  pages: [
    ["order", (r) => <span className="text-zinc-500">{r.order}</span>],
    ["path", (r) => <PagePath row={r} />],
    ["kind", (r) => <span className="text-zinc-400">{r.kind}</span>],
    ["component", (r) => (r.component ? <span className="font-mono text-[11px] text-zinc-400">{r.component}</span> : MUTED)],
    ["nav", (r) => (r.inNav ? <span className="text-zinc-300">{r.navGroup}</span> : MUTED)],
    ["source", (r) => <SourceLink source={r.source} />],
  ],
  config: [
    ["kind", (r) => <span className="text-zinc-500">{r.kind}</span>],
    ["path / section", (r) => mono(r.kind === "file" ? r.path : `${r.section} → config/${r.dir}/*${r.ext}`)],
    ["section", (r) => (r.kind === "file" ? (r.section ? mono(r.section) : MUTED) : <span className="text-zinc-500">{r.fileCount} files</span>)],
    ["read by", (r) => (r.kind === "file" ? <List items={r.readBy} max={2} /> : MUTED)],
    ["flag", (r) => <ConfigFlag row={r} />],
    ["source", (r) => <SourceLink source={r.source} />],
  ],
  "ci-gates": [
    ["workflow / job", (r) => mono(`${r.workflow} / ${r.job}`)],
    ["name", (r) => (r.name ? <span className="text-zinc-400">{r.name}</span> : MUTED)],
    ["triggers", (r) => <List items={r.triggers} />],
    // A required:false row only means "not in ci.yml" — it renders "no", nothing stronger.
    ["required (ci.yml convention)", (r) => <span className="text-zinc-400">{r.required ? "yes" : "no"}</span>],
    ["source", (r) => <SourceLink source={r.source} />],
  ],
  "units-scripts": [
    ["path", (r) => mono(r.path)],
    ["kind", (r) => <span className="text-zinc-500">{r.kind}</span>],
    [
      "description",
      (r) =>
        r.description ? (
          <span className="text-zinc-300">{r.description}</span>
        ) : (
          <span className="text-[11px] italic text-zinc-600">no header comment</span>
        ),
    ],
    ["runs", (r) => <UnitRuns row={r} />],
    ["source", (r) => <SourceLink source={r.source} />],
  ],
};

/** A pages row's path: live → deep link to the page; detail → the pattern, unlinked; redirect → '→ target'. */
function PagePath({ row }) {
  if (row.kind === "live") {
    const to = row.path.endsWith("/*") ? row.path.slice(0, -2) : row.path;
    return (
      <Link to={to} className="font-mono text-sky-400 hover:underline">
        {row.path}
      </Link>
    );
  }
  if (row.kind === "redirect") {
    return (
      <span className="font-mono text-zinc-400">
        {row.path} <span className="text-zinc-500">→ {row.redirectTo ?? "(computed in App.jsx)"}</span>
      </span>
    );
  }
  return <span className="font-mono text-zinc-400">{row.path}</span>;
}

function ConfigFlag({ row }) {
  if (row.kind === "file") return row.unread ? <span className="text-amber-400">unread</span> : MUTED;
  return row.exists ? MUTED : <span className="text-amber-400">directory missing</span>;
}

function UnitRuns({ row }) {
  if (row.kind === "service") return row.execStart ? <span className="font-mono text-[11px] text-zinc-500">{row.execStart}</span> : MUTED;
  if (row.kind === "timer") {
    return (
      <span className="font-mono text-[11px] text-zinc-500">
        {row.triggers}
        {row.schedule && <span className="text-zinc-600"> @ {row.schedule}</span>}
      </span>
    );
  }
  return MUTED;
}

/**
 * Per-family caveats rendered above a catalogue table. ci-gates: `required` is
 * a convention, not the gate — branch protection is the only truth.
 */
export const CATALOGUE_CAVEATS = {
  "ci-gates": (
    <div data-testid="ci-gates-caveat" className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-[12px] text-zinc-400">
      <strong className="text-zinc-300">required</strong> here is the <em>ci.yml convention</em> (every job in ci.yml),
      not the Pre-merge Gate itself. Branch protection is the only truth — verify it with an operator spot-check of the
      GitHub <span className="font-mono">branches/master/protection</span> API. Known mismatches: ci.yml&apos;s{" "}
      <span className="font-mono">deploy</span> job is push-only (it never gates a PR), and{" "}
      <span className="font-mono">design-concept-reconcile</span> is required but lives outside ci.yml.
    </div>
  ),
};

export default function Catalogue({ family, rows }) {
  const columns = COLUMN_SPECS[family];
  if (!columns) return null;
  return (
    <table className="w-full text-left text-[12px]">
      <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
        <tr className="border-b border-zinc-800">
          {columns.map(([header]) => (
            <th key={header} className="py-1 pr-3 font-normal">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.source?.path}:${r.source?.line}:${i}`} className="border-b border-zinc-900 align-top">
            {columns.map(([header, cell]) => (
              <td key={header} className="py-1 pr-3">
                {cell(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
