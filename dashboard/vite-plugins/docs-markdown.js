// Vite plugin: render the /docs markdown corpus to HTML at BUILD time
// (issue #4591, #4544 resolution decisions 1–4 and 9, ADR-0034 §10).
//
// This is the ONLY module that imports `marked` (a dashboard devDependency);
// the browser bundle ships no markdown parser. All the rules — slugs,
// sections, views, the link resolver, the name index, raw-HTML escaping — are
// in the marked-free ./docs-core.js so root node:test tests can pin them.
//
// Membership: the plugin reads EXACTLY the .md paths docs/generated/corpus.json
// lists (no glob, no directory walk). A missing/unparseable corpus.json or a
// missing member file degrades to an empty/partial manifest with a
// console.warn — the build never fails over docs content.
//
// Virtual modules:
//   virtual:hydra-docs          eager + small: views, name index, per-doc lazy loaders
//   virtual:hydra-docs/doc/<n>  one lazy chunk per corpus doc: rendered sections

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";
import {
  buildNameIndex,
  buildViews,
  createLinkResolver,
  escapeHtml,
  extractGlossaryTerms,
  headingHosts,
  outlineTokens,
  prepareAdrSource,
  renderCodeBlock,
  renderRawHtml,
  splitSections,
  stripFrontmatter,
} from "./docs-core.js";

const MANIFEST_ID = "virtual:hydra-docs";
const DOC_PREFIX = "virtual:hydra-docs/doc/";

function readJson(abs, label) {
  if (!existsSync(abs)) {
    console.warn(`[hydra-docs] ${label} is missing — /docs renders without it`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    console.warn(`[hydra-docs] ${label} is unparseable — /docs renders without it:`, err?.message ?? err);
    return null;
  }
}

/** Build the whole model once per build: one lex per doc. */
function buildModel(repoRoot, sha) {
  const corpus = readJson(join(repoRoot, "docs/generated/corpus.json"), "docs/generated/corpus.json");
  const routes = readJson(join(repoRoot, "docs/generated/routes.json"), "docs/generated/routes.json");
  const listed = corpus?.family === "corpus" && Array.isArray(corpus.rows) ? corpus.rows : [];

  const lexer = new Marked({ gfm: true });
  const rows = [];
  const docs = new Map(); // path -> { tokens, outline }
  const outlines = new Map();
  let glossaryTerms = [];
  for (const row of listed) {
    const abs = join(repoRoot, row.path);
    if (!existsSync(abs)) {
      console.warn(`[hydra-docs] corpus member ${row.path} is missing from the checkout — skipped`);
      continue;
    }
    const raw = readFileSync(abs, "utf8");
    // ADR-tier sources are prepped before the lex (#4593): the /docs/adr/NNNN
    // metadata strip carries status/date/relations, so the lexed body drops the
    // header Status/Date lines and the head `## Status` section instead of
    // repeating them. Other tiers only lose their frontmatter, as before.
    const source = row.tier === "adr" ? prepareAdrSource(raw).source : stripFrontmatter(raw);
    const tokens = lexer.lexer(source);
    const outline = outlineTokens(tokens);
    rows.push(row);
    docs.set(row.path, { tokens, outline });
    outlines.set(row.path, { headings: outline.headings });
    if (row.path === "CONTEXT.md") glossaryTerms = extractGlossaryTerms(source);
  }

  const views = buildViews(rows, outlines);
  const hosts = headingHosts(views, outlines);
  const fileKind = (path) => {
    const abs = join(repoRoot, path);
    if (!existsSync(abs)) return null;
    return statSync(abs).isDirectory() ? "dir" : "file";
  };
  const resolveLink = createLinkResolver({ rows, outlines, hosts, fileKind, sha });
  const nameIndex = buildNameIndex({
    views,
    outlines,
    hosts,
    rows,
    glossaryTerms,
    routeRows: routes?.family === "routes" && Array.isArray(routes.rows) ? routes.rows : [],
  });
  return { rows, docs, views, nameIndex, resolveLink };
}

/** A marked instance whose renderer reads the per-doc context set before each parse. */
export function createRenderer(model) {
  const ctx = { path: "", ids: new Map() };
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading(token) {
        const meta = ctx.ids.get(token);
        const inner = this.parser.parseInline(token.tokens);
        if (!meta) return `<h${token.depth}>${inner}</h${token.depth}>\n`;
        const secAnchor = meta.sec ? `<a id="§${meta.sec}" class="docs-sec-anchor"></a>` : "";
        const secBadge = meta.sec ? ` <span class="docs-sec-badge">§${meta.sec}</span>` : "";
        return `<h${token.depth} id="${escapeHtml(meta.id)}">${secAnchor}${inner}${secBadge}</h${token.depth}>\n`;
      },
      html(token) {
        return renderRawHtml(token.text, token.block === true);
      },
      code(token) {
        return renderCodeBlock(token.text, token.lang);
      },
      link(token) {
        return renderLink(this.parser.parseInline(token.tokens), token.href, token.title);
      },
      image(token) {
        return renderLink(escapeHtml(token.text || token.href), token.href, token.title);
      },
    },
  });

  function renderLink(inner, href, title) {
    const res = model.resolveLink(href, ctx.path);
    if (res.kind === "broken") {
      console.warn(`[hydra-docs] ${ctx.path}: unresolvable link -> ${res.target}`);
      return `<a class="docs-link-broken" data-broken="true" title="${escapeHtml(`unresolved link: ${res.target}`)}">${inner}</a>`;
    }
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    const ext = res.kind === "internal" ? "" : ` target="_blank" rel="noreferrer" class="docs-link-out"`;
    return `<a href="${escapeHtml(res.href)}"${t}${ext}>${inner}</a>`;
  }

  return function renderDoc(path) {
    const doc = model.docs.get(path);
    ctx.path = path;
    ctx.ids = doc.outline.ids;
    return splitSections(doc.tokens).map((group) => {
      const slice = Object.assign([...group.tokens], { links: doc.tokens.links });
      return {
        slug: group.heading ? doc.outline.ids.get(group.heading).id : "",
        html: md.parser(slice),
      };
    });
  };
}

export function hydraDocs({ repoRoot, sha }) {
  let model = null;
  let renderDoc = null;
  const ensure = () => {
    if (!model) {
      model = buildModel(repoRoot, sha);
      renderDoc = createRenderer(model);
    }
    return model;
  };

  return {
    name: "hydra-docs",
    buildStart() {
      model = null; // rebuild per build (and per dev restart)
    },
    resolveId(id) {
      if (id === MANIFEST_ID || id.startsWith(DOC_PREFIX)) return `\0${id}`;
      return null;
    },
    load(id) {
      if (id === `\0${MANIFEST_ID}`) {
        const m = ensure();
        const loaders = m.rows
          .map((r, i) => `  ${JSON.stringify(r.path)}: () => import(${JSON.stringify(`${DOC_PREFIX}${i}`)}),`)
          .join("\n");
        return [
          `export const views = ${JSON.stringify(m.views)};`,
          `export const nameIndex = ${JSON.stringify(m.nameIndex)};`,
          `export const docLoaders = {\n${loaders}\n};`,
        ].join("\n");
      }
      if (id.startsWith(`\0${DOC_PREFIX}`)) {
        const m = ensure();
        const row = m.rows[Number(id.slice(`\0${DOC_PREFIX}`.length))];
        if (!row) return "export default { path: null, sections: [] };";
        this.addWatchFile(join(repoRoot, row.path));
        return `export default ${JSON.stringify({ path: row.path, sections: renderDoc(row.path) })};`;
      }
      return null;
    },
  };
}
