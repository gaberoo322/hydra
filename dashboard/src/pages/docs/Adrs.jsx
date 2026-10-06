// The ADRs view components (#4593). Two surfaces:
//
//  - AdrsCatalogue: /docs/cat/adrs — every ADR row from the generated
//    inventory, live statuses first in number order, a rule, then
//    superseded/deprecated muted; each row links to its sub-view.
//  - AdrStrip: the /docs/adr/NNNN metadata strip above the rendered body —
//    number, status badge, the status line as plain text, date, supersedes /
//    superseded-by links, and the corpus files that cite it.
//
// Everything shown comes from docs/generated/adrs.json at BUILD time (the
// inventories.js glob); nothing is fetched at view time (ADR-0034 §10). The
// strip renders plain text only — the pure helpers in ./adrs.js strip the
// markdown; the only HTML ever injected is the lexed corpus body.

import { Link } from "react-router-dom";
import { adrRoute, partitionAdrRows, plainStatusLine } from "./adrs.js";

const STATUS_STYLES = {
  accepted: "border-emerald-800 bg-emerald-950/40 text-emerald-400",
  "superseded-in-part": "border-amber-800 bg-amber-950/40 text-amber-400",
  proposed: "border-sky-800 bg-sky-950/40 text-sky-400",
  superseded: "border-zinc-700 bg-zinc-900 text-zinc-400",
  deprecated: "border-zinc-700 bg-zinc-900 text-zinc-400",
};

function StatusBadge({ status }) {
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STATUS_STYLES[status] ?? STATUS_STYLES.superseded}`}>
      {status}
    </span>
  );
}

function AdrNumberLink({ number, className }) {
  return (
    <Link to={adrRoute(number)} className={`font-mono text-sky-400 hover:underline ${className ?? ""}`}>
      ADR-{number}
    </Link>
  );
}

function CatalogueRow({ row }) {
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <AdrNumberLink number={row.number} className="text-[13px]" />
        <span className="text-sm text-zinc-200">{row.title}</span>
        <StatusBadge status={row.status} />
        {row.date && <span className="font-mono text-[11px] text-zinc-500">{row.date}</span>}
      </div>
      <div className="text-[12px] text-zinc-500">{row.decision}</div>
    </li>
  );
}

/** The /docs/cat/adrs listing inside the GENERATED frame. */
export function AdrsCatalogue({ rows }) {
  const { active, demoted } = partitionAdrRows(rows);
  return (
    <div>
      <ul data-testid="adrs-active" className="space-y-0.5">
        {active.map((row) => (
          <CatalogueRow key={row.number} row={row} />
        ))}
      </ul>
      {demoted.length > 0 && (
        <>
          <div className="my-3 border-t border-zinc-800" />
          <ul data-testid="adrs-demoted" className="space-y-0.5 opacity-70">
            {demoted.map((row) => (
              <CatalogueRow key={row.number} row={row} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RelationList({ label, numbers }) {
  if (!numbers?.length) return null;
  return (
    <span className="text-zinc-400">
      {label}{" "}
      {numbers.map((n, i) => (
        <span key={n}>
          {i > 0 && ", "}
          <AdrNumberLink number={n} className="text-[11px]" />
        </span>
      ))}
    </span>
  );
}

/**
 * The metadata strip above one ADR's rendered body. `row` is the adrs.json
 * row (null when the inventory parsed but the row is absent — the strip then
 * shows nothing but the body still renders).
 */
export function AdrStrip({ row }) {
  if (!row) return null;
  return (
    <div data-testid="adr-strip" className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-zinc-100">ADR-{row.number}</span>
        <StatusBadge status={row.status} />
        <span className="text-zinc-300">{plainStatusLine(row.statusLine)}</span>
        {row.date && <span className="font-mono text-zinc-500">{row.date}</span>}
      </div>
      {(row.supersedes?.length > 0 || row.supersededBy?.length > 0) && (
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <RelationList label="supersedes" numbers={row.supersedes} />
          <RelationList label="superseded by" numbers={row.supersededBy} />
        </div>
      )}
      {row.citedBy?.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-zinc-500">cited by</span>
          {row.citedBy.map((p) => (
            <code key={p} className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-500">
              {p}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}
