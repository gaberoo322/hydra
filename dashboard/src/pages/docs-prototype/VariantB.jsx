// PROTOTYPE — Variant B: "Atlas". No tree. Top bar (search + catalogue
// tabs + breadcrumbs); the entry is a hub (three layers → Areas grid); every
// detail view is a full-width *join page* with its own section tabs, so an
// entity's card, generated tables, prose and live links sit on one screen.
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fx, Provenance, Prose, Generated, ClassesTable, RoutesTable, SkillCard, AdrRoster, DocLink, LiveLink, SourceTag, search, resolve, areaSlice, useDocsHref, CLASS_LIVE } from "./shared.jsx";

const LAYERS = [
  { name: "The brain", sub: "hydra-autopilot · decide.py · classes.json", to: "skill/hydra-autopilot", area: "area/scripts-autopilot-decide-py-classes-json", adr: "0012" },
  { name: "The hands", sub: "one subagent per class, fresh worktree, CI is the gate", to: "cat/classes", area: "area/claude-skills-docs-operator-playbooks", adr: "0030" },
  { name: "The data plane", sub: "Express :4000 · Redis · hydra:* streams · dashboard", to: "cat/routes", area: "area/src-api-src-api-ts", adr: "0034" },
];

function TopBar({ crumbs }) {
  const [q, setQ] = useState("");
  const hits = search(q);
  const href = useDocsHref();
  const tabs = [["", "Overview"], ["cat/classes", "Classes & skills"], ["cat/routes", "Routes"], ["cat/adrs", "ADRs"], ["cat/pages", "Pages"], ["cat/reference", "Reference"]];
  return (
    <div className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-6 pt-3">
      <div className="flex items-center gap-4">
        <div className="text-lg font-bold">Docs</div>
        <div className="relative flex-1 max-w-md">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a name…" className="w-full rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm" />
          {q && (
            <div className="absolute left-0 right-0 mt-1 max-h-96 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 shadow-xl">
              {hits.map((h, i) => <Link key={i} onClick={() => setQ("")} to={href(h.key.split("?")[0])} className="block px-3 py-1 text-xs hover:bg-zinc-800"><span className="font-mono text-[10px] text-zinc-500 mr-2">{h.kind}</span>{h.name}</Link>)}
              {!hits.length && <div className="px-3 py-1 text-xs text-zinc-500">no name matches</div>}
            </div>
          )}
        </div>
        <Provenance compact />
      </div>
      <div className="flex gap-4 mt-2 text-sm">
        {tabs.map(([k, l]) => <Link key={k} to={href(k)} className="pb-2 text-zinc-400 hover:text-zinc-100">{l}</Link>)}
      </div>
      {crumbs && <div className="pb-2 text-xs text-zinc-500">{crumbs}</div>}
    </div>
  );
}

function Tabs({ tabs }) {
  const [i, setI] = useState(0);
  return (
    <div>
      <div className="flex gap-1 border-b border-zinc-800 mb-4">
        {tabs.map((t, j) => <button key={t[0]} onClick={() => setI(j)} className={`px-3 py-1.5 text-sm rounded-t ${i === j ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"}`}>{t[0]}</button>)}
      </div>
      {tabs[i][1]}
    </div>
  );
}

export default function VariantB({ viewKey }) {
  const [params] = useSearchParams();
  const r = resolve(viewKey);
  let crumbs = null, body;
  if (r.kind === "entry") {
    body = (
      <div className="space-y-8">
        <div className="grid grid-cols-3 gap-4">
          {LAYERS.map((l) => (
            <div key={l.name} className="rounded-lg border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 p-4 space-y-2">
              <div className="text-lg font-semibold">{l.name}</div>
              <div className="text-xs text-zinc-400">{l.sub}</div>
              <div className="flex flex-wrap gap-2 text-sm pt-1"><DocLink to={l.to}>open →</DocLink><DocLink to={l.area}>area</DocLink><DocLink to={`adr/${l.adr}`}>ADR-{l.adr}</DocLink></div>
            </div>
          ))}
        </div>
        <details className="rounded border border-zinc-800 p-3"><summary className="cursor-pointer text-sm text-zinc-400">How it works (README)</summary><Prose doc={fx.docs["doc/readme-how-it-works"]} /></details>
        <Generated family="areas" title="Areas" count={fx.counts.areas}>
          <div className="grid grid-cols-4 gap-3">
            {fx.areas.filter((a) => !a.retired).map((a) => (
              <DocLink key={a.slug} to={`area/${a.slug}`} className="!text-zinc-100 !no-underline rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 hover:border-cyan-700 block">
                <div className="font-mono text-sm">{a.name}</div>
                <div className="text-[11px] text-zinc-500 mt-1 line-clamp-2 min-h-[2.2em]">{a.terms.join(" · ") || "no glossary terms"}</div>
                <div className="mt-2 grid grid-cols-4 gap-1 text-center">
                  {["routes", "classes", "adrs", "skills"].map((k) => <div key={k} className={a.counts[k] ? "" : "opacity-25"}><div className="text-base font-semibold">{a.counts[k]}</div><div className="text-[9px] uppercase text-zinc-500">{k}</div></div>)}
                </div>
              </DocLink>
            ))}
          </div>
        </Generated>
        <div className="text-xs text-zinc-600">Retired areas: {fx.areas.filter((a) => a.retired).map((a) => a.name).join(", ")} → History</div>
      </div>
    );
  } else if (r.kind === "skill" && r.skill) {
    const s = r.skill;
    const cited = [...new Set([...(r.doc?.html ?? "").matchAll(/\/docs\/adr\/(\d{4})/g)].map((m) => m[1]))];
    const isBrain = s.name === "hydra-autopilot";
    crumbs = <><DocLink to="">Docs</DocLink> / <DocLink to="cat/classes">Classes &amp; skills</DocLink> / {s.name}</>;
    body = (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1"><SkillCard s={s} /></div>
          <div className="w-64 rounded border border-emerald-900 bg-emerald-950/20 p-3 text-xs space-y-2">
            <div className="uppercase text-[10px] tracking-wider text-emerald-500">Watch it run</div>
            {CLASS_LIVE.map((l) => <div key={l}><LiveLink to={l} /></div>)}
          </div>
        </div>
        <Tabs tabs={[
          ...(isBrain ? [["Dispatch classes", <Generated key="c" family="classes" count={fx.classes.length}><ClassesTable /></Generated>]] : []),
          ["Playbook", <Prose key="p" doc={r.doc} />],
          ["ADRs cited", <ul key="a" className="text-sm space-y-1">{cited.map((n) => { const a = fx.adrs.find((x) => x.number === n); return <li key={n}><DocLink to={`adr/${n}`}>ADR-{n}</DocLink> {a?.title}</li>; })}</ul>],
          ["Composed from", <ul key="f" className="text-sm font-mono">{s.composedFrom.map((f) => <li key={f}>{f}</li>)}{!s.composedFrom.length && <li className="text-zinc-500">—</li>}</ul>],
        ]} />
      </div>
    );
  } else if (r.kind === "area" && r.area) {
    const s = areaSlice(r.area);
    crumbs = <><DocLink to="">Docs</DocLink> / Areas / {r.area.name}</>;
    body = (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold font-mono">{r.area.name}</h1>
        <div className="flex gap-2 flex-wrap">{r.area.terms.map((t) => <span key={t} className="rounded-full border border-zinc-700 px-2 text-xs">{t}</span>)}</div>
        <Tabs tabs={[
          ...(s.colocated ? [["Module map", <Prose key="m" doc={s.colocated} />]] : []),
          ...(s.classes.length ? [["Classes", <Generated key="c" family="classes" count={s.classes.length}><ClassesTable rows={s.classes} /></Generated>]] : []),
          ...(s.routes.length ? [["Routes", <Generated key="r" family="routes" count={s.routes.length}><RoutesTable rows={s.routes} /></Generated>]] : []),
          ["ADRs", <Generated key="a" family="adrs" count={s.adrs.length}><ul className="text-sm space-y-1">{s.adrs.map((a) => <li key={a.number}><DocLink to={`adr/${a.number}`}>ADR-{a.number}</DocLink> {a.title}</li>)}</ul></Generated>],
          ...(s.skills.length ? [["Skills", <div key="s" className="grid grid-cols-3 gap-2">{s.skills.map((k) => <SkillCard key={k.name} s={k} compact />)}</div>]] : []),
        ]} />
      </div>
    );
  } else if (r.kind === "adr" || r.kind === "doc") {
    crumbs = <><DocLink to="">Docs</DocLink> / {r.kind === "adr" ? <><DocLink to="cat/adrs">ADRs</DocLink> / ADR-{r.adr?.number}</> : r.doc?.title}</>;
    body = (
      <div className="grid grid-cols-[1fr_14rem] gap-8">
        <Prose doc={r.doc} />
        <div className="sticky top-32 self-start text-xs space-y-1">{r.doc?.toc.filter((t) => t.depth === 2 || t.id.startsWith("§")).map((t) => <a key={t.id} href={`#${t.id}`} className="block text-zinc-500 hover:text-zinc-200 truncate">{t.text}</a>)}</div>
      </div>
    );
  } else if (r.kind === "cat") {
    crumbs = <><DocLink to="">Docs</DocLink> / {r.cat}</>;
    body =
      r.cat === "classes" ? (
        <div className="space-y-6">
          {["plan|spec|tickets|implement|review", "pre-plan-producer", "ops", "target"].map((grp) => {
            const rows = fx.classes.filter((c) => new RegExp(`^(${grp})$`).test(c.stage));
            return <div key={grp}><h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-2">{grp.includes("|") ? "The spine — plan → spec → tickets → implement → review" : grp}</h2><div className="grid grid-cols-3 gap-2">{rows.map((c) => <SkillCard key={c.name} s={fx.skills.find((k) => k.name === c.skill) ?? { name: c.skill, description: "(no playbook found)", composedFrom: [] }} compact />)}</div></div>;
          })}
          <div><h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-2">Operator-interactive skills</h2><div className="grid grid-cols-3 gap-2">{fx.skills.filter((k) => !k.classes.length).map((k) => <SkillCard key={k.name} s={k} compact />)}</div></div>
        </div>
      )
      : r.cat === "routes" ? <Generated family="routes" count={fx.routes.length}><RoutesTable filter={params.get("q") ?? ""} /></Generated>
      : r.cat === "adrs" ? <Generated family="adrs" count={fx.adrs.length}><AdrRoster /></Generated>
      : r.cat === "pages" ? <Generated family="pages"><div className="grid grid-cols-3 gap-2">{fx.pages.filter((p) => p.kind !== "redirect").map((p) => <div key={p.path + p.component} className="rounded border border-zinc-800 p-2 text-sm"><div className="font-mono">{p.path}</div><div className="text-xs text-zinc-500">{p.kind} · {p.inNav ? "in nav" : <span className="text-amber-400">not in nav</span>}</div>{p.kind === "live" && <LiveLink to={p.path} />}</div>)}</div></Generated>
      : r.cat === "reference" ? <div className="grid grid-cols-3 gap-2">{fx.refIndex.map((x) => <DocLink key={x.key} to={x.key} className="rounded border border-zinc-800 p-2 text-sm !text-zinc-200">{x.title}</DocLink>)}</div>
      : <div className="text-zinc-500">not built in the prototype</div>;
  } else body = <div className="text-zinc-500">not in the prototype fixture: {viewKey}</div>;
  return (
    <div>
      <TopBar crumbs={crumbs} />
      <main className="p-6 max-w-7xl">{body}</main>
    </div>
  );
}

export { SourceTag };
