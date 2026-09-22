// PROTOTYPE — Variant C: "Index". The primary affordance is the NAME LIST
// (every generated entity, typed, filterable) on the left; the right is an
// entity panel whose top strip is its RELATIONS — ADRs it cites, classes it
// dispatches, the area it belongs to, the page that owns its live state —
// so the reader walks the graph rather than a tree. No Areas grid entry:
// the entry view is the lifecycle as a map of classes.
import { useState } from "react";
import { Link } from "react-router-dom";
import { fx, Provenance, Prose, Generated, ClassesTable, RoutesTable, AdrRoster, DocLink, LiveLink, SourceTag, INDEX, resolve, areaSlice, useDocsHref, CLASS_LIVE, STAGE_LABEL } from "./shared.jsx";

const KINDS = ["class", "skill", "adr", "area", "route", "page", "term", "reference"];

function NameList() {
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState(new Set(["class", "skill", "adr", "area"]));
  const href = useDocsHref();
  const s = q.toLowerCase();
  const rows = INDEX.filter((i) => kinds.has(i.kind) && (!s || i.name.toLowerCase().includes(s)));
  return (
    <div className="w-80 shrink-0 h-screen sticky top-0 flex flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="p-3 space-y-2 border-b border-zinc-800">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter names…" className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
        <div className="flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <button key={k} onClick={() => { const n = new Set(kinds); n.has(k) ? n.delete(k) : n.add(k); setKinds(n); }} className={`rounded-full px-2 text-[11px] border ${kinds.has(k) ? "border-sky-600 text-sky-300 bg-sky-950/40" : "border-zinc-700 text-zinc-500"}`}>{k}</button>
          ))}
        </div>
        <div className="text-[10px] text-zinc-600">{rows.length} names · name-only substring, no full text</div>
      </div>
      <ul className="flex-1 overflow-y-auto text-[12.5px]">
        {rows.map((h, i) => (
          <li key={i}>
            <Link to={href(h.key.split("?")[0])} className="flex items-baseline gap-2 px-3 py-1 hover:bg-zinc-900">
              <span className="w-12 shrink-0 font-mono text-[10px] text-zinc-600">{h.kind}</span>
              <span className="truncate text-zinc-300">{h.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Relations({ groups }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0,1fr))` }}>
      {groups.map(([label, items]) => (
        <div key={label}>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
          <div className="flex flex-wrap gap-1">{items.length ? items : <span className="text-xs text-zinc-600">—</span>}</div>
        </div>
      ))}
    </div>
  );
}
const Pill = ({ to, children }) => <DocLink to={to} className="rounded bg-zinc-800 px-1.5 text-[11px] font-mono !text-zinc-200 hover:bg-zinc-700 !no-underline">{children}</DocLink>;

export default function VariantC({ viewKey, q }) {
  const r = resolve(viewKey);
  let body;
  if (r.kind === "entry") {
    const cols = [["plan", "spec", "tickets", "implement", "review"], ["pre-plan-producer"], ["ops"], ["target"]];
    body = (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Hydra</h1>
        <p className="text-sm text-zinc-400 max-w-2xl">A long-running <DocLink to="skill/hydra-autopilot">hydra-autopilot</DocLink> session (<DocLink to="adr/0012">ADR-0012</DocLink>) dispatches one subagent per <b>class</b> below; code-writing classes open PRs that CI gates; the <DocLink to="area/src-api-src-api-ts">data plane</DocLink> ({fx.counts.routes} routes) records it all.</p>
        <Generated family="classes" title="Every dispatch class, by stage" count={fx.classes.length}>
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3">
            {cols.map((stages) => (
              <div key={stages[0]} className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">{stages.length > 1 ? "spine" : STAGE_LABEL[stages[0]]}</div>
                {fx.classes.filter((c) => stages.includes(c.stage)).sort((a, b) => stages.indexOf(a.stage) - stages.indexOf(b.stage)).map((c) => (
                  <DocLink key={c.name} to={`skill/${c.skill}`} className={`stage stage-${c.stage} !block !whitespace-normal !text-left px-2 py-1 !rounded !text-[12px] !no-underline`}>
                    {stages.length > 1 && <span className="opacity-60 mr-1">{c.stage}</span>}<span className="font-mono">{c.name}</span>
                  </DocLink>
                ))}
              </div>
            ))}
          </div>
        </Generated>
        <div className="grid grid-cols-2 gap-4">
          <Generated family="adrs" title="Accepted ADRs"><AdrRoster compact /></Generated>
          <Prose doc={fx.docs["doc/readme-how-it-works"]} />
        </div>
      </div>
    );
  } else if (r.kind === "skill" && r.skill) {
    const s = r.skill;
    const cls = fx.classes.filter((c) => c.skill === s.name);
    const isBrain = s.name === "hydra-autopilot";
    const cited = [...new Set([...(r.doc?.html ?? "").matchAll(/\/docs\/adr\/(\d{4})/g)].map((m) => m[1]))];
    body = (
      <div className="space-y-4">
        <div className="flex items-baseline gap-3"><h1 className="text-2xl font-bold font-mono">{s.name}</h1><SourceTag path={s.source.path} /></div>
        <p className="text-sm text-zinc-300 max-w-3xl">{s.description}</p>
        <Relations groups={[
          [isBrain ? "dispatches" : "is class", (isBrain ? fx.classes : cls).map((c) => <Pill key={c.name} to={`skill/${c.skill}`}>{c.name}</Pill>)],
          ["cites", cited.map((n) => <Pill key={n} to={`adr/${n}`}>ADR-{n}</Pill>)],
          ["composed from", s.composedFrom.map((f) => <span key={f} className="rounded bg-zinc-800 px-1.5 text-[11px] font-mono text-zinc-500">{f.split("/")[1]}</span>)],
          ["live state", (cls.length || isBrain ? CLASS_LIVE : []).map((l) => <LiveLink key={l} to={l} />)],
        ]} />
        {(cls.length > 0 || isBrain) && <Generated family="classes" title={isBrain ? "Dispatch classes" : "Class row"} count={(isBrain ? fx.classes : cls).length}><ClassesTable rows={isBrain ? fx.classes : cls} /></Generated>}
        <Prose doc={r.doc} />
      </div>
    );
  } else if (r.kind === "adr") {
    const citedBy = fx.skills.filter((s) => (fx.docs[`skill/${s.name}`]?.html ?? "").includes(`/docs/adr/${r.adr?.number}`));
    const areas = fx.areas.filter((a) => a.adrs.includes(r.adr?.number));
    body = (
      <div className="space-y-4">
        <Relations groups={[
          ["status", [<span key="s" className="text-xs">{r.adr?.statusLine}</span>]],
          ["areas", areas.map((a) => <Pill key={a.slug} to={`area/${a.slug}`}>{a.name}</Pill>)],
          ["cited by (rendered playbooks)", citedBy.map((s) => <Pill key={s.name} to={`skill/${s.name}`}>{s.name}</Pill>)],
        ]} />
        <Prose doc={r.doc} />
      </div>
    );
  } else if (r.kind === "area" && r.area) {
    const s = areaSlice(r.area);
    body = (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold font-mono">{r.area.name}</h1>
        <Relations groups={[
          ["terms", r.area.terms.map((t) => <span key={t} className="rounded bg-zinc-800 px-1.5 text-[11px]">{t}</span>)],
          ["ADRs", s.adrs.map((a) => <Pill key={a.number} to={`adr/${a.number}`}>ADR-{a.number}</Pill>)],
          ["classes", s.classes.slice(0, 30).map((c) => <Pill key={c.name} to={`skill/${c.skill}`}>{c.name}</Pill>)],
          ["live state", [...new Set(s.routes.flatMap((x) => x.home).filter((h) => !h.startsWith("/api")))].concat(s.classes.length ? CLASS_LIVE : []).filter((v, i, a) => a.indexOf(v) === i).map((l) => <LiveLink key={l} to={l} />)],
        ]} />
        {s.colocated && <Prose doc={s.colocated} />}
        {s.routes.length > 0 && <Generated family="routes" count={s.routes.length}><RoutesTable rows={s.routes} /></Generated>}
      </div>
    );
  } else if (r.kind === "doc") body = <Prose doc={r.doc} />;
  else if (r.kind === "cat") {
    body = r.cat === "routes" ? <Generated family="routes" count={fx.routes.length}><RoutesTable filter={q} /></Generated>
      : r.cat === "classes" ? <Generated family="classes" count={fx.classes.length}><ClassesTable /></Generated>
      : r.cat === "adrs" ? <Generated family="adrs"><AdrRoster /></Generated>
      : <div className="text-zinc-500">Catalogue "{r.cat}" — in this variant, use the name list (filter by kind).</div>;
  } else body = <div className="text-zinc-500">not in the prototype fixture: {viewKey}</div>;
  return (
    <div className="flex">
      <NameList />
      <main className="flex-1 min-w-0 p-6">
        <Provenance />
        {body}
      </main>
    </div>
  );
}
