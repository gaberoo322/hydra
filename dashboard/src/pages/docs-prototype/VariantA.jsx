// PROTOTYPE — Variant A: "Manual". Classic three-pane reference:
// left = the IA nav tree (System → Areas → Catalogues) + name search,
// centre = the view, right = on-this-page TOC + provenance + live links.
import { useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { fx, Provenance, Prose, Generated, ClassesTable, RoutesTable, SkillCard, AdrRoster, DocLink, LiveLink, SourceTag, search, resolve, areaSlice, useDocsHref, CLASS_LIVE, STAGE_LABEL } from "./shared.jsx";

function TreeLink({ to, children, muted }) {
  const href = useDocsHref();
  return (
    <NavLink to={href(to)} end className={({ isActive }) => `block truncate rounded px-2 py-0.5 text-[13px] ${isActive ? "bg-zinc-800 text-white" : muted ? "text-zinc-600 hover:text-zinc-400" : "text-zinc-400 hover:text-zinc-100"}`}>
      {children}
    </NavLink>
  );
}

function Tree() {
  const [q, setQ] = useState("");
  const hits = search(q);
  const href = useDocsHref();
  return (
    <nav className="w-64 shrink-0 border-r border-zinc-800 h-screen sticky top-0 overflow-y-auto p-3 space-y-4 bg-zinc-950">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a name…  (classes, routes, ADRs, terms)" className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm placeholder:text-zinc-600" />
      {q ? (
        <ul className="space-y-0.5">
          {hits.map((h, i) => (
            <li key={i}><NavLink to={href(h.key.split("?")[0]) + (h.key.includes("?") ? (href("").includes("?") ? "&" : "?") + h.key.split("?")[1] : "")} className="block rounded px-2 py-0.5 text-[12px] text-zinc-300 hover:bg-zinc-800"><span className="mr-1 font-mono text-[10px] text-zinc-500">{h.kind}</span>{h.name}</NavLink></li>
          ))}
          {!hits.length && <li className="text-xs text-zinc-600 px-2">no name matches</li>}
        </ul>
      ) : (
        <>
          <div>
            <div className="px-2 text-[10px] uppercase tracking-wider text-zinc-600 mb-1">System</div>
            <TreeLink to="">Overview</TreeLink>
            <TreeLink to="cat/spine">Lifecycle spine</TreeLink>
            <TreeLink to="adr/0034">Dashboard (ADR-0034)</TreeLink>
            <TreeLink to="doc/readme">README</TreeLink>
          </div>
          <div>
            <div className="px-2 text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Areas</div>
            {fx.areas.map((a) => <TreeLink key={a.slug} to={`area/${a.slug}`} muted={a.retired}>{a.retired ? "✝ " : ""}{a.name}</TreeLink>)}
          </div>
          <div>
            <div className="px-2 text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Catalogues</div>
            <TreeLink to="cat/routes">Routes <span className="text-zinc-600">{fx.counts.routes}</span></TreeLink>
            <TreeLink to="cat/pages">Pages <span className="text-zinc-600">{fx.counts.pages}</span></TreeLink>
            <TreeLink to="cat/classes">Classes &amp; skills <span className="text-zinc-600">{fx.counts.classes}/{fx.counts.skills}</span></TreeLink>
            <TreeLink to="cat/adrs">ADRs <span className="text-zinc-600">{fx.counts.adrs}</span></TreeLink>
            <TreeLink to="cat/glossary">Glossary</TreeLink>
            <TreeLink to="cat/reference">Reference</TreeLink>
            <TreeLink to="cat/history" muted>History</TreeLink>
          </div>
        </>
      )}
    </nav>
  );
}

function Rail({ toc, source, live }) {
  return (
    <aside className="w-56 shrink-0 h-screen sticky top-0 overflow-y-auto p-3 border-l border-zinc-800 text-[12px] space-y-4">
      {live?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Live state lives on</div>
          <div className="flex flex-wrap gap-1">{live.map((l) => <LiveLink key={l} to={l} />)}</div>
        </div>
      )}
      {toc?.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">On this page</div>
          <ul className="space-y-0.5">
            {toc.filter((t) => t.depth > 1 && t.depth < 4).map((t) => (
              <li key={t.id} className={t.depth === 3 ? "pl-3" : ""}><a href={`#${t.id}`} className="text-zinc-400 hover:text-zinc-100 line-clamp-1">{t.text}</a></li>
            ))}
          </ul>
        </div>
      )}
      {source && <div><div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Source</div>{source}</div>}
    </aside>
  );
}

function Spine() {
  const stages = ["plan", "spec", "tickets", "implement", "review"];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Lifecycle spine</h1>
      <p className="text-sm text-zinc-400 max-w-prose">One skill lineage, five stages, one dispatch class each (<DocLink to="adr/0030">ADR-0030</DocLink>). Everything else is a pre-plan producer or an ops exception.</p>
      <Generated family="classes" title="stage ↔ class ↔ skill">
        <div className="flex items-stretch gap-2">
          {stages.map((s, i) => {
            const c = fx.classes.find((x) => x.stage === s);
            return (
              <div key={s} className="flex items-center gap-2">
                <div className="rounded border border-violet-800 bg-violet-950/30 p-2 w-36">
                  <div className="text-[10px] uppercase text-violet-300">{s}</div>
                  <div className="font-mono text-xs">{c?.name}</div>
                  <DocLink to={`skill/${c?.skill}`} className="font-mono text-xs">{c?.skill}</DocLink>
                </div>
                {i < stages.length - 1 && <span className="text-zinc-600">→</span>}
              </div>
            );
          })}
        </div>
      </Generated>
      <ClassesTable />
    </div>
  );
}

export default function VariantA({ viewKey, q }) {
  const [params] = useSearchParams();
  const r = resolve(viewKey.startsWith("cat/spine") ? "" : viewKey);
  let body, toc, source, live;
  if (viewKey === "cat/spine") {
    body = <Spine />; live = CLASS_LIVE;
  } else if (r.kind === "entry") {
    const d = fx.docs["doc/readme-how-it-works"];
    body = (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Hydra — system reference</h1>
        <Prose doc={d} />
        <Generated family="areas" title="Areas" count={fx.counts.areas}>
          <div className="grid grid-cols-3 gap-2">
            {fx.areas.filter((a) => !a.retired).map((a) => (
              <DocLink key={a.slug} to={`area/${a.slug}`} className="!text-zinc-200 rounded border border-zinc-800 bg-zinc-900 p-2 hover:border-zinc-600 !no-underline">
                <div className="font-mono text-xs">{a.name}</div>
                <div className="text-[11px] text-zinc-500 line-clamp-1">{a.terms.join(", ") || "—"}</div>
                <div className="mt-1 flex gap-2 text-[10px] text-zinc-500">{Object.entries(a.counts).filter(([, n]) => n).map(([k, n]) => <span key={k}>{n} {k}</span>)}</div>
              </DocLink>
            ))}
          </div>
        </Generated>
      </div>
    );
    toc = d.toc; source = <SourceTag path="README.md" section="How It Works" />;
  } else if (r.kind === "adr" || r.kind === "doc") {
    body = <Prose doc={r.doc} />; toc = r.doc?.toc; source = r.doc && <SourceTag path={r.doc.file} />;
  } else if (r.kind === "skill") {
    const cls = fx.classes.filter((c) => c.skill === r.skill?.name);
    body = (
      <div className="space-y-5">
        {r.skill && <SkillCard s={r.skill} />}
        {r.skill?.name === "hydra-autopilot" && (
          <Generated family="classes" title="Classes this skill dispatches (decide.py reads classes.json)" count={fx.classes.length}><ClassesTable /></Generated>
        )}
        <Prose doc={r.doc} />
      </div>
    );
    toc = r.doc?.toc; source = r.skill && <SourceTag path={r.skill.source.path} />;
    live = cls.length || r.skill?.name === "hydra-autopilot" ? CLASS_LIVE : [];
  } else if (r.kind === "area" && r.area) {
    const s = areaSlice(r.area);
    body = (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold font-mono">{r.area.name}</h1>
        <div className="text-sm text-zinc-400">Terms: {r.area.terms.join(" · ") || "—"}</div>
        {s.colocated && <details open className="rounded border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-300">Module map — {r.area.colocated}</summary><Prose doc={s.colocated} /></details>}
        {s.adrs.length > 0 && <Generated family="adrs" title="ADRs" count={s.adrs.length}><ul className="text-sm space-y-1">{s.adrs.map((a) => <li key={a.number}><DocLink to={`adr/${a.number}`}>ADR-{a.number}</DocLink> {a.title}</li>)}</ul></Generated>}
        {s.classes.length > 0 && <Generated family="classes" title="Dispatch classes" count={s.classes.length}><ClassesTable rows={s.classes} /></Generated>}
        {s.routes.length > 0 && <Generated family="routes" title="Routes" count={s.routes.length}><RoutesTable rows={s.routes} /></Generated>}
        {s.skills.length > 0 && <Generated family="skills" title="Skills" count={s.skills.length}><div className="grid grid-cols-2 gap-2">{s.skills.map((k) => <SkillCard key={k.name} s={k} compact />)}</div></Generated>}
      </div>
    );
    live = s.classes.length ? CLASS_LIVE : [];
  } else if (r.kind === "cat") {
    const cat = r.cat;
    body =
      cat === "routes" ? <div className="space-y-3"><h1 className="text-2xl font-bold">Routes</h1><Generated family="routes" count={fx.routes.length}><RoutesTable filter={params.get("q") ?? q} /></Generated></div>
      : cat === "classes" ? <div className="space-y-4"><h1 className="text-2xl font-bold">Classes &amp; skills</h1><Generated family="classes" title="Dispatch classes" count={fx.classes.length}><ClassesTable /></Generated><Generated family="skills" title="Skills (playbooks)" count={fx.skills.length}><div className="grid grid-cols-2 gap-2">{fx.skills.map((k) => <SkillCard key={k.name} s={k} compact />)}</div></Generated></div>
      : cat === "adrs" ? <div className="space-y-3"><h1 className="text-2xl font-bold">ADRs</h1><Generated family="adrs" count={fx.adrs.length}><AdrRoster /></Generated></div>
      : cat === "pages" ? <div className="space-y-3"><h1 className="text-2xl font-bold">Pages</h1><Generated family="pages" count={fx.pages.length}><table className="inv"><thead><tr><th>path</th><th>kind</th><th>in nav</th><th>component</th><th /></tr></thead><tbody>{fx.pages.map((p) => <tr key={p.path + p.component}><td className="font-mono">{p.path}</td><td>{p.kind}</td><td className={p.kind === "live" && !p.inNav ? "text-amber-400" : ""}>{p.inNav ? "yes" : p.kind === "live" ? "NO — §1 defect" : "—"}</td><td className="font-mono text-zinc-500">{p.component}</td><td>{p.kind === "live" && <LiveLink to={p.path} />}</td></tr>)}</tbody></table></Generated></div>
      : cat === "reference" ? <div className="space-y-2"><h1 className="text-2xl font-bold">Reference</h1><p className="text-sm text-zinc-500">docs/reference.md, split at ##</p><ul className="text-sm">{fx.refIndex.map((x) => <li key={x.key}><DocLink to={x.key}>{x.title}</DocLink></li>)}</ul></div>
      : cat === "glossary" ? <div className="space-y-2"><h1 className="text-2xl font-bold">Glossary</h1><ul className="columns-3 text-sm">{fx.glossary.map((g, i) => <li key={i}><SourceTag path={g.source.path} line={g.source.line} /> <span className="text-zinc-200">{g.term}</span></li>)}</ul></div>
      : <div className="text-zinc-500">not built in the prototype</div>;
  } else {
    body = <div className="text-zinc-500">not in the prototype fixture: {viewKey}</div>;
  }
  return (
    <div className="flex">
      <Tree />
      <main className="flex-1 min-w-0 p-6">
        <Provenance />
        {body}
      </main>
      <Rail toc={toc} source={source} live={live} />
    </div>
  );
}

export { STAGE_LABEL };
