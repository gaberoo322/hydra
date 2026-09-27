import { Link } from "react-router-dom";
import { sourceUrl } from "./build-info.js";

// Routes catalogue (#4590, ADR-0034 §10). Renders every row of
// docs/generated/routes.json in FILE order — the extractor's
// router-file-then-line sort; the page never re-sorts or hand-filters.
// The home cell is a deep-link OUT to where the live state lives, never a
// restated live value.

const CONSUMER_PREFIX = "dashboard/src/";

/** Deep-link to a row's home: raw API routes as <a>, cockpit pages as <Link>. */
export function LiveLink({ to }) {
  const cls =
    "inline-flex items-center gap-1 rounded border border-emerald-700/60 bg-emerald-950/40 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300 hover:bg-emerald-900/50";
  if (to.startsWith("/api")) {
    return (
      <a href={to} className={cls} title="raw API route — no page renders this">
        <span aria-hidden>↗</span>api {to}
      </a>
    );
  }
  return (
    <Link to={to} className={cls} title="cockpit page that owns the live state">
      <span aria-hidden>↗</span>
      {to}
    </Link>
  );
}

function Consumers({ consumers }) {
  if (!consumers?.length) return <span className="text-zinc-600">—</span>;
  return (
    <span className="space-x-1">
      {consumers.map((c) => (
        <span key={c} title={c}>
          {c.startsWith(CONSUMER_PREFIX) ? c.slice(CONSUMER_PREFIX.length) : c}
        </span>
      ))}
    </span>
  );
}

export default function RoutesCatalogue({ rows }) {
  return (
    <table className="w-full text-left text-[12px]">
      <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
        <tr className="border-b border-zinc-800">
          <th className="py-1 pr-3 font-normal">method</th>
          <th className="py-1 pr-3 font-normal">path</th>
          <th className="py-1 pr-3 font-normal">router</th>
          <th className="py-1 pr-3 font-normal">stability</th>
          <th className="py-1 pr-3 font-normal">consumers</th>
          <th className="py-1 font-normal">home (live state)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.method} ${r.path} ${r.source?.path}:${r.source?.line}`} className="border-b border-zinc-900 align-top">
            <td className="py-1 pr-3 font-mono text-zinc-400">{r.method}</td>
            <td className="py-1 pr-3 font-mono text-zinc-200">{r.path}</td>
            <td className="py-1 pr-3">
              {r.source?.path ? (
                <a
                  href={sourceUrl(r.source.path, r.source.line)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300"
                >
                  {r.source.path}:{r.source.line}
                </a>
              ) : (
                <span className="text-zinc-600">—</span>
              )}
            </td>
            <td className="py-1 pr-3 text-zinc-500">
              {r.stability}
              {r.stabilityNote != null && <span className="ml-1 text-zinc-600">({r.stabilityNote})</span>}
            </td>
            <td className="py-1 pr-3 font-mono text-[11px] text-zinc-500">
              <Consumers consumers={r.consumers} />
            </td>
            <td className="py-1">{r.home ? <LiveLink to={r.home} /> : <span className="text-zinc-600">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
