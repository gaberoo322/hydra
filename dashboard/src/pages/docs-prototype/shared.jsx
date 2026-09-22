// PROTOTYPE — wayfinder #4545 (map #4537). Throwaway: pieces every variant
// may use. Variants own their own layout; these are atoms only.
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import fx from "./fixture.json";
import "./docs-prototype.css";

export { fx };
export const GH = `https://github.com/gaberoo322/hydra/blob/${fx.build.fullSha}`;

// ---- linking inside /docs keeps the ?variant= param ----
export function useDocsHref() {
  const [params] = useSearchParams();
  const v = params.get("variant");
  return (key) => `/docs${key ? "/" + key : ""}${v ? `?variant=${v}` : ""}`;
}
export function DocLink({ to, children, className = "" }) {
  const href = useDocsHref();
  return <Link to={href(to)} className={`text-sky-300 hover:underline ${className}`}>{children}</Link>;
}
// A deep-link OUT to the page/route that owns live state (§10 hard line 1).
export function LiveLink({ to }) {
  const isApi = to.startsWith("/api");
  return (
    <a href={to} className="inline-flex items-center gap-1 rounded border border-emerald-700/60 bg-emerald-950/40 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300 hover:bg-emerald-900/50" title={isApi ? "raw API route — no page renders this" : "cockpit page that owns the live state"}>
      <span aria-hidden>↗</span>{isApi ? "api " : ""}{to}
    </a>
  );
}

// ---- §10 trust contract, static form ----
export function Provenance({ compact }) {
  return (
    <div className={`font-mono text-[11px] text-zinc-500 ${compact ? "" : "border-b border-zinc-800 pb-2 mb-4"}`}>
      as of commit <a className="text-zinc-300 hover:underline" href={`https://github.com/gaberoo322/hydra/commit/${fx.build.fullSha}`}>{fx.build.sha}</a>, built {fx.build.builtAt.replace("T", " ").slice(0, 16)}Z
      {" · "}<a href="/health" className="text-zinc-400 hover:underline">is prod on this commit? → /health</a>
    </div>
  );
}
export function SourceTag({ path: p, line, section }) {
  return (
    <a href={`${GH}/${p}${line ? `#L${line}` : ""}`} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300">
      source: {p}{section ? ` § ${section}` : ""}{line ? `:${line}` : ""}
    </a>
  );
}
// Generated blocks look different from prose (§10 rule 3).
export function Generated({ family, title, children, count }) {
  if (!fx[family] && family !== "counts") {
    return <div className="rounded border border-amber-700 bg-amber-950/30 p-3 text-amber-300 text-sm">inventory unavailable: docs/generated/{family}.json missing or unparseable</div>;
  }
  return (
    <section className="gen-block rounded-md border border-dashed border-cyan-800/70 bg-cyan-950/10">
      <header className="flex items-center justify-between gap-3 border-b border-dashed border-cyan-800/70 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-cyan-900/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cyan-300">generated</span>
          {title && <span className="text-sm font-medium text-zinc-200">{title}</span>}
          {count != null && <span className="text-xs text-zinc-500">{count} rows</span>}
        </div>
        <span className="font-mono text-[11px] text-cyan-700">docs/generated/{family}.json ← scripts/docs/inventories/{family}.ts</span>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

// ---- rendered markdown (build-time HTML from `marked`) ----
export function Prose({ doc, showSource = true }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  if (!doc) return <div className="text-amber-300 text-sm">not rendered in the prototype (the real corpus.json renders ~100 files)</div>;
  const onClick = (e) => {
    const a = e.target.closest("a.int");
    if (!a) return;
    e.preventDefault();
    const url = new URL(a.getAttribute("href"), location.origin);
    const v = params.get("variant");
    if (v) url.searchParams.set("variant", v);
    navigate(url.pathname + url.search + url.hash);
  };
  return (
    <article className="prose-doc">
      {showSource && (
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-400">{doc.tier === "playbook" ? "agent instruction — source of the deployed skill" : "prose"}</span>
          <SourceTag path={doc.file} section={doc.section} />
        </div>
      )}
      <div onClick={onClick} dangerouslySetInnerHTML={{ __html: doc.html }} />
    </article>
  );
}

// ---- inventory tables ----
const STAGE_ORDER = ["plan", "spec", "tickets", "implement", "review", "pre-plan-producer", "ops", "operator-interactive", "target"];
export const STAGE_LABEL = { plan: "spine · plan", spec: "spine · spec", tickets: "spine · tickets", implement: "spine · implement", review: "spine · review", "pre-plan-producer": "pre-plan producer", ops: "ops / observability", "operator-interactive": "operator-interactive", target: "Target class" };
export const byStage = (rows) => [...rows].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));

// Where does a class's live state live? The consumer scan says /runs/:runId
// (useTaxonomy); the prototype adds /now by hand — see the finding in the README.
export const CLASS_LIVE = ["/now", "/runs"];

export function ClassesTable({ rows = fx.classes, onPick }) {
  return (
    <table className="inv">
      <thead><tr><th>class</th><th>stage</th><th>skill</th><th>kind</th><th>scope</th><th>cooldown</th><th>cost</th><th>src</th></tr></thead>
      <tbody>
        {byStage(rows).map((c) => (
          <tr key={c.name} id={`class-${c.name}`}>
            <td className="font-mono">{c.name}</td>
            <td><span className={`stage stage-${c.stage}`}>{STAGE_LABEL[c.stage]}</span></td>
            <td>{onPick ? <button className="text-sky-300 hover:underline font-mono" onClick={() => onPick(c.skill)}>{c.skill}</button> : <DocLink to={`skill/${c.skill}`} className="font-mono">{c.skill}</DocLink>}</td>
            <td>{c.kind}</td><td>{c.scope}</td>
            <td>{c.cooldownSeconds == null ? "—" : c.cooldownSeconds >= 3600 ? `${c.cooldownSeconds / 3600}h` : `${c.cooldownSeconds / 60}m`}</td>
            <td>{c.costClass}</td>
            <td><SourceTag path={c.source.path} line={c.source.line} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RoutesTable({ rows = fx.routes, filter = "" }) {
  const f = filter.toLowerCase();
  const shown = rows.filter((r) => !f || r.path.toLowerCase().includes(f) || r.router.includes(f));
  return (
    <table className="inv">
      <thead><tr><th>method</th><th>path</th><th>router</th><th>stability</th><th>consumers</th><th>home (live state)</th></tr></thead>
      <tbody>
        {shown.map((r) => (
          <tr key={r.method + r.path + r.source.line}>
            <td className="font-mono text-zinc-400">{r.method}</td>
            <td className="font-mono">{r.path}</td>
            <td><SourceTag path={r.source.path} line={r.source.line} /></td>
            <td className="text-zinc-500">{r.stability}</td>
            <td className="font-mono text-[11px] text-zinc-500">{r.consumers.map((c) => c.replace("dashboard/src/", "")).join(", ") || "—"}</td>
            <td className="space-x-1">{r.home.map((h) => <LiveLink key={h} to={h} />)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SkillCard({ s, compact }) {
  const cls = fx.classes.filter((c) => c.skill === s.name);
  return (
    <div className="rounded-md border border-dashed border-cyan-800/70 bg-zinc-900/60 p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <DocLink to={`skill/${s.name}`} className="font-mono text-sm font-semibold">{s.name}</DocLink>
        <span className={`stage stage-${cls[0]?.stage ?? s.stage}`}>{STAGE_LABEL[cls[0]?.stage ?? s.stage]}</span>
      </div>
      <p className="text-xs text-zinc-300 leading-snug">{s.description}</p>
      {!compact && s.whenToUse && <p className="text-[11px] text-zinc-500 leading-snug">{s.whenToUse}</p>}
      <div className="flex flex-wrap gap-1 text-[11px] text-zinc-400">
        {cls.map((c) => <span key={c.name} className="rounded bg-zinc-800 px-1.5 font-mono">{c.name} · {c.kind} · {c.scope}{c.cooldownSeconds ? ` · ${c.cooldownSeconds / 3600 >= 1 ? c.cooldownSeconds / 3600 + "h" : c.cooldownSeconds / 60 + "m"}` : ""}</span>)}
        {!cls.length && <span className="rounded bg-zinc-800 px-1.5">no dispatch class</span>}
        {s.composeBase && <span className="rounded bg-zinc-800 px-1.5">base: {s.composeBase}</span>}
      </div>
      {!compact && cls.length > 0 && <div className="pt-1 flex gap-1 items-center text-[11px] text-zinc-500">live: {CLASS_LIVE.map((l) => <LiveLink key={l} to={l} />)}</div>}
    </div>
  );
}

export function AdrRoster({ compact }) {
  const live = fx.adrs.filter((a) => a.status !== "superseded");
  const dead = fx.adrs.filter((a) => a.status === "superseded");
  const Row = ({ a, muted }) => (
    <tr className={muted ? "opacity-50" : ""}>
      <td className="font-mono"><DocLink to={`adr/${a.number}`}>{a.number}</DocLink></td>
      <td><DocLink to={`adr/${a.number}`} className="text-zinc-200">{a.title}</DocLink>{!compact && a.decision && <div className="text-[11px] text-zinc-500">{a.decision}</div>}</td>
      <td className="text-[11px] text-zinc-500">{a.status}</td>
      {!compact && <td className="text-[11px] text-zinc-500">{a.whenToRead}</td>}
    </tr>
  );
  return (
    <table className="inv">
      <thead><tr><th>#</th><th>decision</th><th>status</th>{!compact && <th>read when</th>}</tr></thead>
      <tbody>
        {live.map((a) => <Row key={a.number} a={a} />)}
        <tr><td colSpan={4} className="!py-1 text-[10px] uppercase tracking-wider text-zinc-600 border-t border-zinc-700">superseded / retired</td></tr>
        {dead.map((a) => <Row key={a.number} a={a} muted />)}
      </tbody>
    </table>
  );
}

// ---- name-search index (IA #4541 d6: name-only substring, no dependency) ----
export const INDEX = [
  ...fx.classes.map((c) => ({ kind: "class", name: c.name, key: `skill/${c.skill}`, hint: STAGE_LABEL[c.stage] })),
  ...fx.skills.map((s) => ({ kind: "skill", name: s.name, key: `skill/${s.name}`, hint: s.description?.slice(0, 80) })),
  ...fx.adrs.map((a) => ({ kind: "adr", name: `ADR-${a.number} ${a.title}`, key: `adr/${a.number}`, hint: a.status })),
  ...fx.routes.map((r) => ({ kind: "route", name: `${r.method} ${r.path}`, key: `cat/routes?q=${encodeURIComponent(r.path)}`, hint: r.router, live: r.home[0] })),
  ...fx.areas.filter((a) => !a.retired).map((a) => ({ kind: "area", name: a.name, key: `area/${a.slug}`, hint: a.terms.join(", ") })),
  ...fx.glossary.map((g) => ({ kind: "term", name: g.term, key: `cat/glossary`, hint: "CONTEXT.md" })),
  ...fx.refIndex.map((r) => ({ kind: "reference", name: r.title, key: r.key, hint: "docs/reference.md" })),
  ...fx.pages.filter((p) => p.kind === "live").map((p) => ({ kind: "page", name: p.path, key: "cat/pages", hint: p.component, live: p.path })),
];
export const search = (q) => {
  if (!q) return [];
  const s = q.toLowerCase();
  return INDEX.filter((i) => i.name.toLowerCase().includes(s)).slice(0, 40);
};

// ---- view resolution: key → what to render (variants choose how) ----
export function resolve(key) {
  const [kind, ...rest] = key.split("/");
  const id = rest.join("/");
  if (!key) return { kind: "entry" };
  if (kind === "adr") return { kind: "adr", adr: fx.adrs.find((a) => a.number === id), doc: fx.docs[`adr/${id}`] };
  if (kind === "skill") return { kind: "skill", skill: fx.skills.find((s) => s.name === id), doc: fx.docs[`skill/${id}`] };
  if (kind === "area") return { kind: "area", area: fx.areas.find((a) => a.slug === id) };
  if (kind === "ref") return { kind: "doc", doc: fx.docs[key] };
  if (kind === "doc") return { kind: "doc", doc: fx.docs[key] };
  if (kind === "cat") return { kind: "cat", cat: id };
  return { kind: "missing", key };
}

// Area slice joins by source path (the #4541 join key).
export function areaSlice(a) {
  const under = (p) => a.paths.some((ap) => (ap.endsWith("/") ? p.startsWith(ap) : p === ap || p.startsWith(ap.replace(/\.ts$/, "") + "/")));
  return {
    routes: fx.routes.filter((r) => under(r.source.path)),
    classes: a.paths.some((p) => /scripts\/autopilot|src\/taxonomy|src\/autopilot/.test(p)) ? fx.classes : [],
    skills: a.paths.some((p) => p.includes("operator-playbooks")) ? fx.skills : [],
    adrs: fx.adrs.filter((x) => a.adrs.includes(x.number)),
    colocated: a.colocated ? fx.docs["doc/src-autopilot-context"] : null,
  };
}
