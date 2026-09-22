// PROTOTYPE — wayfinder #4545 (map #4537). Throwaway. Not the real extractor.
//
// Emits fixture.json: a crude, one-shot run of the recipes #4542 decided
// (routes w/ consumer-scan homes, pages, classes + proposed stage, skills,
// ADRs, areas, counts) plus build-time `marked` renders of a handful of real
// corpus files (#4544). The real thing is scripts/docs/inventories/*.ts +
// a Vite plugin; this only exists so the page can be judged on real data.
//
// Run from the worktree root:
//   MARKED=/path/to/node_modules/marked/lib/marked.esm.js \
//     node dashboard/src/pages/docs-prototype/gen-fixture.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const { marked } = await import(process.env.MARKED);
const ROOT = process.cwd();
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const SHA = execSync("git rev-parse --short HEAD").toString().trim();
const FULL_SHA = execSync("git rev-parse HEAD").toString().trim();
const GH = `https://github.com/gaberoo322/hydra/blob/${FULL_SHA}`;

// ---------- pages (App.jsx <Route>) + import graph for consumer → page ----------
const appSrc = read("dashboard/src/App.jsx");
const imports = {}; // component name → file
for (const m of appSrc.matchAll(/import (\w+) from "\.\/([^"]+)"/g)) imports[m[1]] = "dashboard/src/" + m[2];
const pages = [];
for (const m of appSrc.matchAll(/<Route path="([^"]+)" element={<(\w+)[^>]*\/>}/g)) {
  const [_, p, el] = m;
  const kind = el === "Navigate" || /Redirect/.test(el) ? "redirect" : p.includes(":") ? "detail" : "live";
  pages.push({ path: p, component: el, kind, file: imports[el] ?? "dashboard/src/App.jsx", source: { path: "dashboard/src/App.jsx", line: lineOf(appSrc, m.index) } });
}
pages.find((p) => p.path === "/now").file = "dashboard/src/pages/now-console/NowConsole.jsx"; // NowRoute is an inline wrapper in App.jsx
const sidebar = read("dashboard/src/components/Sidebar.jsx");
const navTo = [...sidebar.matchAll(/to: "([^"]+)"/g)].map((m) => m[1]);
for (const p of pages) p.inNav = navTo.includes(p.path);

// dashboard import graph (relative imports only)
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(jsx?|tsx?)$/.test(e.name) ? [path.join(d, e.name)] : []));
const dashFiles = walk("dashboard/src");
const importedBy = {};
for (const f of dashFiles) {
  for (const m of read(f).matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
    let t = path.normalize(path.join(path.dirname(f), m[1]));
    if (!fs.existsSync(path.join(ROOT, t))) for (const ext of [".jsx", ".js", ".ts"]) if (fs.existsSync(path.join(ROOT, t + ext))) t += ext;
    (importedBy[t] ??= new Set()).add(f);
  }
}
const pageFiles = new Map(pages.filter((p) => p.kind !== "redirect").map((p) => [p.file, p.path]));
function pagesOf(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  if (pageFiles.has(file) && file !== "dashboard/src/App.jsx") return [pageFiles.get(file)];
  return [...(importedBy[file] ?? [])].flatMap((f) => pagesOf(f, seen));
}

// consumer literals
const consumerCalls = [];
for (const f of dashFiles) {
  const t = read(f);
  for (const m of t.matchAll(/(?:useApi|usePageItems|apiFetch|fetch)\(\s*[`"']((?:\$\{API_BASE\}|\/api)?\/[^`"'?]+)/g)) {
    const p = m[1].replace("${API_BASE}", "").replace(/^\/api/, "");
    consumerCalls.push({ path: p, file: f });
  }
}

// ---------- routes ----------
const apiFiles = ["src/api.ts", ...fs.readdirSync(path.join(ROOT, "src/api")).filter((f) => f.endsWith(".ts")).map((f) => "src/api/" + f)];
const routes = [];
for (const f of apiFiles) {
  const t = read(f);
  for (const m of t.matchAll(/(?:router|app|api)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
    const [, verb, p] = m;
    if (!p.startsWith("/")) continue;
    const full = f === "src/api.ts" && !p.startsWith("/api") ? p : "/api" + p.replace(/^\/api/, "");
    const re = new RegExp("^" + p.replace(/^\/api/, "").replace(/:[^/]+/g, "(\\$\\{[^}]+\\}|[^/]+)") + "$");
    const consumers = [...new Set(consumerCalls.filter((c) => re.test(c.path)).map((c) => c.file))];
    const homes = [...new Set(consumers.flatMap((c) => pagesOf(c)))];
    routes.push({ method: verb.toUpperCase(), path: full, router: path.basename(f, ".ts"), stability: "stable", consumers, home: homes.length ? homes : [full], source: { path: f, line: lineOf(t, m.index) } });
  }
}

// ---------- classes (+ proposed stage/model — hand-assigned in the prototype) ----------
const STAGE = {
  wayfinder_orch: "plan", design_concept_orch: "spec", tickets_orch: "tickets", dev_orch: "implement", qa_orch: "review",
  research_orch: "pre-plan-producer", discover_orch: "pre-plan-producer", architecture_orch: "pre-plan-producer", cleanup_orch: "pre-plan-producer", scout_orch: "pre-plan-producer",
  sweep_orch: "ops", retro_orch: "ops", skill_prune: "ops", health: "ops",
};
const classesJson = JSON.parse(read("scripts/autopilot/classes.json"));
const clsText = read("scripts/autopilot/classes.json");
const classes = classesJson.classes.map((c) => ({ ...c, stage: STAGE[c.name] ?? (c.scope === "target" ? "target" : "ops"), _stageIsProposed: true, source: { path: "scripts/autopilot/classes.json", line: lineOf(clsText, clsText.indexOf(`"${c.name}"`)) } }));

// ---------- skills (playbook frontmatter) ----------
const PB = "docs/operator-playbooks";
const skills = fs.readdirSync(path.join(ROOT, PB)).filter((f) => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md").map((f) => {
  const t = read(`${PB}/${f}`);
  const fm = t.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const get = (k) => fm.match(new RegExp(`^${k}:\\s*(.*)$`, "m"))?.[1]?.replace(/^["']|["']$/g, "") ?? null;
  const name = get("name") ?? f.replace(/\.md$/, "");
  const cls = classes.filter((c) => c.skill === name).map((c) => c.name);
  return { name, description: get("description"), whenToUse: get("when_to_use"), composeBase: get("compose_base"), claudeOnly: get("claude_only") === "true", classes: cls, stage: cls.length ? null : "operator-interactive", composedFrom: [...new Set([...t.matchAll(/_(?:fragments|vendor)\/[\w.-]+\.md/g)].map((m) => m[0]))], source: { path: `${PB}/${f}`, line: 1 } };
});

// ---------- ADRs ----------
const adrs = fs.readdirSync(path.join(ROOT, "docs/adr")).filter((f) => /^\d{4}-/.test(f)).map((f) => {
  const t = read(`docs/adr/${f}`);
  const title = (t.match(/^# (.*)$/m)?.[1] ?? f).replace(/^ADR-\d+:\s*/, "");
  const statusLine = t.match(/^status:\s*(.*)$/im)?.[1] ?? "?"; // two header dialects on master: frontmatter `status:` and body `Status:`
  const status = /supersed|retired/i.test(statusLine.split(/[(—]/)[0]) ? "superseded" : /propos/i.test(statusLine.split(/[(—]/)[0]) ? "proposed" : "accepted";
  return { number: f.slice(0, 4), slug: f.replace(/\.md$/, ""), title, status, statusLine, source: { path: `docs/adr/${f}`, line: 1 } };
});
// roster one-liners
const roster = read("docs/adr/README.md");
for (const a of adrs) {
  const row = roster.split("\n").find((l) => l.includes(`[${a.number}]`) || l.includes(`${a.number}-`));
  if (row) { const cells = row.split("|").map((s) => s.trim()).filter(Boolean); a.decision = cells[2] ?? null; a.whenToRead = cells[3] ?? null; }
}

// ---------- areas (CONTEXT-MAP rows) ----------
const cmap = read("CONTEXT-MAP.md");
const areas = [];
for (const l of cmap.split("\n")) {
  if (!l.startsWith("| `") && !l.startsWith("| ~~") && !l.startsWith("| backlog") && !l.startsWith("| self-mod") && !l.startsWith("| **process")) continue;
  const cells = l.split("|").slice(1, -1).map((s) => s.trim());
  const retired = cells[0].startsWith("~~");
  const paths = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const name = cells[0].replace(/[`~*]/g, "").trim();
  const adrRefs = [...l.matchAll(/ADR-(\d{4})/g)].map((m) => m[1]);
  const terms = cells.length >= 4 ? cells[1].replace(/~~/g, "").split(/,\s*/).filter((s) => s && s !== "—" && !s.startsWith("—")) : [];
  const colocated = cells.length >= 4 && cells[2].includes("CONTEXT.md") ? cells[2].match(/`([^`]+)`/)?.[1] : null;
  const slug = name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  areas.push({ slug, name, paths, retired, terms, colocated, adrs: adrRefs });
}
const under = (p, a) => a.paths.some((ap) => (ap.endsWith("/") ? p.startsWith(ap) : p === ap || p.startsWith(ap.replace(/\.ts$/, "") + "/")));
for (const a of areas) {
  a.counts = {
    routes: routes.filter((r) => under(r.source.path, a)).length,
    classes: a.paths.some((p) => p.startsWith("scripts/autopilot") || p.startsWith("src/taxonomy") || p.startsWith("src/autopilot")) ? classes.length : 0,
    adrs: a.adrs.length,
    skills: a.paths.some((p) => p.includes("operator-playbooks")) ? skills.length : 0,
  };
}

// ---------- corpus: marked renders ----------
const corpusFiles = {
  "README.md": "doc/readme",
  "docs/adr/0012-autopilot-is-the-single-brain.md": "adr/0012",
  "docs/adr/0030-one-pocock-skill-lineage-replaces-forks.md": "adr/0030",
  "docs/adr/0034-orchestrator-dashboard-page-inventory.md": "adr/0034",
  "docs/operator-playbooks/hydra-autopilot.md": "skill/hydra-autopilot",
  "docs/operator-playbooks/hydra-dev.md": "skill/hydra-dev",
  "src/autopilot/CONTEXT.md": "doc/src-autopilot-context",
  "docs/reference.md": "ref",
};
const route = (p) => corpusFiles[p] ?? (p.startsWith("docs/adr/0") ? "adr/" + path.basename(p).slice(0, 4) : p.startsWith(PB + "/") && !p.includes("/_") ? "skill/" + path.basename(p, ".md") : null);
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s/g, "-");

function render(file, text) {
  text = text.replace(/^---\n[\s\S]*?\n---\n/, ""); // frontmatter stripped (#4544 d6)
  const toc = [];
  const renderer = new marked.Renderer();
  renderer.html = ({ text }) => (text.trim().startsWith("<!--") ? "" : text.replace(/</g, "&lt;")); // raw HTML escaped (d9)
  renderer.heading = function ({ tokens, depth, text: raw }) {
    const inner = this.parser.parseInline(tokens);
    const id = slugify(raw);
    const sec = file.startsWith("docs/adr/") && depth === 3 && raw.match(/^(\d+)\./)?.[1];
    toc.push({ depth, text: raw.replace(/`/g, ""), id: sec ? `§${sec}` : id });
    return `<h${depth} id="${sec ? `§${sec}` : id}">${sec ? `<span class="sec-badge">§${sec}</span>` : ""}${inner}<a class="anchor" href="#${sec ? `§${sec}` : id}">#</a></h${depth}>`;
  };
  renderer.code = ({ text, lang }) => `<div class="code-block"><span class="code-lang">${lang || "text"}</span><pre><code>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre></div>`;
  renderer.link = function ({ href, tokens }) {
    const inner = this.parser.parseInline(tokens);
    if (/^(https?:|mailto:)/.test(href)) return `<a href="${href}" class="ext" target="_blank" rel="noreferrer">${inner}</a>`;
    if (href.startsWith("#")) return `<a href="${href}">${inner}</a>`;
    const [p, hash] = href.split("#");
    const resolved = path.normalize(path.join(path.dirname(file), p)).replace(/\/$/, "");
    const r = route(resolved);
    if (r) return `<a href="/docs/${r}${hash ? "#" + hash : ""}" class="int">${inner}</a>`;
    if (fs.existsSync(path.join(ROOT, resolved))) return `<a href="${GH}/${resolved}" class="gh" target="_blank" rel="noreferrer">${inner}</a>`;
    return `<a class="broken" title="unresolvable: ${href}">${inner}</a>`;
  };
  const html = marked.parse(text, { renderer, gfm: true });
  return { html, toc };
}
const docs = {};
for (const [file, key] of Object.entries(corpusFiles)) {
  if (file === "docs/reference.md") continue;
  const text = read(file);
  const title = text.replace(/^---\n[\s\S]*?\n---\n/, "").match(/^# (.*)$/m)?.[1] ?? file;
  docs[key] = { key, file, title, tier: file.startsWith(PB) ? "playbook" : "living", ...render(file, text) };
}
// reference.md split at ## (#4544 d5)
const refText = read("docs/reference.md");
const refSections = refText.split(/^(?=## )/m).filter((s) => s.startsWith("## "));
const refIndex = [];
for (const s of refSections) {
  const h = s.match(/^## (.*)$/m)[1];
  const key = "ref/" + slugify(h);
  refIndex.push({ key, title: h });
  docs[key] = { key, file: "docs/reference.md", section: h, title: h, tier: /histor/i.test(h) ? "historical" : "living", ...render("docs/reference.md", s) };
}
// README: just How It Works (entry)
const readme = read("README.md");
const hiw = readme.slice(readme.indexOf("## How It Works"), readme.indexOf("## Key Concepts"));
docs["doc/readme-how-it-works"] = { key: "doc/readme-how-it-works", file: "README.md", section: "How It Works", title: "How It Works", tier: "living", ...render("README.md", hiw) };

// glossary terms (CONTEXT.md ### / **Term** entries) — names only for search
const ctx = read("CONTEXT.md");
const glossary = [...ctx.matchAll(/^\*\*([A-Z][^*]{2,40})\*\*[:\s—-]/gm)].map((m) => ({ term: m[1], source: { path: "CONTEXT.md", line: lineOf(ctx, m.index) } }));
const glossary2 = [...ctx.matchAll(/^###\s+(.*)$/gm)].map((m) => ({ term: m[1], source: { path: "CONTEXT.md", line: lineOf(ctx, m.index) } }));

const counts = { routes: routes.length, routers: new Set(routes.map((r) => r.router)).size, pages: pages.filter((p) => p.kind === "live").length, classes: classes.length, skills: skills.length, adrs: adrs.length, areas: areas.filter((a) => !a.retired).length, glossary: glossary.length + glossary2.length };

const out = { build: { sha: SHA, fullSha: FULL_SHA, builtAt: new Date().toISOString() }, counts, routes, pages, classes, skills, adrs, areas, glossary: [...glossary2, ...glossary], docs, refIndex };
fs.writeFileSync(path.join(ROOT, "dashboard/src/pages/docs-prototype/fixture.json"), JSON.stringify(out));
console.log(JSON.stringify(counts), "docs:", Object.keys(docs).length, "unhomed-to-page routes:", routes.filter((r) => r.home[0].startsWith("/api")).length);
