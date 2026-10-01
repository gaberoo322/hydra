// Pure, marked-free logic for the /docs markdown pipeline (issue #4591,
// #4544 resolution, ADR-0034 §10).
//
// Why this is split from docs-markdown.js: the required `test` CI job runs
// only the ROOT `npm ci`, so dashboard/node_modules — and `marked` — is not
// installed there. Everything a root node:test test must pin (the GitHub
// slugger, the section splitter, the view model, the single link resolver,
// the name-index builder, raw-HTML escaping) lives HERE and imports nothing.
// docs-markdown.js is the thin marked adapter the dashboard-build job
// exercises end to end.
//
// One parse: the adapter lexes each doc once; these functions consume that
// token stream, so anchors, the TOC rail, the link resolver and the name index
// all read the same slugs and cannot disagree.

export const REPO_URL = "https://github.com/gaberoo322/hydra";

/** The page href for a view key ("" is the /docs entry). */
export function docsHref(key) {
  return key ? `/docs/${key}` : "/docs";
}

/** The view key for a corpus route ("/docs/ref/x" -> "ref/x", "/docs" -> ""). */
export function routeKey(route) {
  return route === "/docs" ? "" : route.replace(/^\/docs\//, "");
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip a leading YAML frontmatter block. */
export function stripFrontmatter(src) {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? src.slice(m[0].length) : src;
}

/**
 * Raw HTML found in source (block or inline): HTML comments are dropped, the
 * rest is ESCAPED and rendered as text — never passed through.
 */
export function renderRawHtml(text, block) {
  const kept = String(text).replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  if (!kept.trim()) return "";
  const escaped = escapeHtml(kept);
  return block ? `<p class="docs-raw-html">${escaped.trim()}</p>\n` : escaped;
}

/** Fenced code: monospace block with a language label, NO highlighting. */
export function renderCodeBlock(text, lang) {
  const label = String(lang ?? "").trim().split(/\s+/)[0];
  const head = label ? `<div class="docs-code-lang">${escapeHtml(label)}</div>` : "";
  return `<div class="docs-code">${head}<pre><code>${escapeHtml(String(text).replace(/\n$/, ""))}</code></pre></div>\n`;
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * GitHub-compatible heading slugger (github-slugger semantics): lowercase,
 * drop everything that is not a letter, mark, number, connector punctuation,
 * '-' or ' ', spaces -> '-'; repeats in one document get -1, -2, ...
 */
export function createSlugger() {
  const occurrences = new Map();
  return {
    slug(text) {
      const base = String(text)
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
        .replace(/ /g, "-");
      let result = base;
      while (occurrences.has(result)) {
        const n = occurrences.get(base) + 1;
        occurrences.set(base, n);
        result = `${base}-${n}`;
      }
      occurrences.set(result, 0);
      return result;
    },
  };
}

/** The visible text of an inline token list (marked token shape), as GitHub slugs it. */
export function plainText(tokens) {
  let out = "";
  for (const t of tokens ?? []) {
    if (t.type === "html" || t.type === "br") continue;
    if (t.type === "codespan") out += t.text;
    else if (t.type === "image") out += t.text ?? "";
    else if (Array.isArray(t.tokens) && t.tokens.length > 0) out += plainText(t.tokens);
    else out += t.text ?? "";
  }
  return out;
}

/** ADR-0037-style `### N.` heading -> "N", else null. */
export function sectionNumber(depth, text) {
  if (depth !== 3) return null;
  const m = String(text).match(/^(\d+)\.\s/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Outline + sections (from the ONE lex of each doc)
// ---------------------------------------------------------------------------

/** Split top-level tokens at every `##` heading. The first group (heading null) is the preamble. */
export function splitSections(tokens) {
  const groups = [{ heading: null, tokens: [] }];
  for (const t of tokens) {
    if (t.type === "heading" && t.depth === 2) groups.push({ heading: t, tokens: [t] });
    else groups[groups.length - 1].tokens.push(t);
  }
  return groups;
}

function nestedHeadings(token, out) {
  for (const child of token.tokens ?? []) {
    if (child.type === "heading") out.push(child);
    nestedHeadings(child, out);
  }
  for (const item of token.items ?? []) nestedHeadings(item, out);
}

/**
 * Walk a doc's top-level tokens once, assigning every heading (including ones
 * nested in lists/blockquotes) its GitHub slug in document order.
 *
 * Returns { ids: Map<token, {id, sec}>, headings: [{depth, text, slug, section, sec}] }
 * where `section` is the slug of the enclosing `##` section ("" = preamble).
 */
export function outlineTokens(tokens) {
  const slugger = createSlugger();
  const ids = new Map();
  const headings = [];
  const usedSec = new Set();
  let section = "";
  for (const t of tokens) {
    const found = [];
    if (t.type === "heading") found.push(t);
    nestedHeadings(t, found);
    for (const h of found) {
      const text = plainText(h.tokens).trim();
      const slug = slugger.slug(text);
      if (h === t && h.depth === 2) section = slug;
      let sec = sectionNumber(h.depth, text);
      if (sec && usedSec.has(sec)) sec = null;
      if (sec) usedSec.add(sec);
      ids.set(h, { id: slug, sec });
      headings.push({ depth: h.depth, text, slug, section, sec });
    }
  }
  return { ids, headings };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const LABEL_OVERRIDES = { "CONTEXT.md": "Glossary (CONTEXT.md)" };

/** Sections of an outline, in order: [{slug, title}] ("" = preamble). */
function sectionsOf(outline) {
  const out = [{ slug: "", title: "" }];
  for (const h of outline.headings) if (h.depth === 2 && h.section === h.slug) out.push({ slug: h.slug, title: h.text });
  return out;
}

function tocFor(outline, sections, maxDepth) {
  return outline.headings
    .filter((h) => (sections === null || sections.includes(h.section)) && h.depth >= 2 && h.depth <= maxDepth)
    .map((h) => ({ id: h.slug, text: h.text, depth: h.depth }));
}

/**
 * The view model. `rows` = corpus.json rows; `outlines` = Map<path, {headings}>.
 * A view = { key, label, group, depth, historical, sources: [{path, sections}], toc, children? }
 * where `sections` is null (whole doc) or a list of section slugs ("" = preamble).
 * Views exist only for members that are present, so every tree entry is built.
 */
export function buildViews(rows, outlines) {
  const views = [];
  const row = new Map(rows.map((r) => [r.path, r]));
  const outlineOf = (path) => outlines.get(path) ?? { headings: [] };
  const add = (v) => {
    const toc = v.sources.flatMap((s) => tocFor(outlineOf(s.path), s.sections, v.tocDepth ?? 3));
    views.push({ depth: 0, historical: false, ...v, toc });
  };

  // System
  if (row.has("README.md")) {
    const secs = sectionsOf(outlineOf("README.md"));
    const pick = (titles) => secs.filter((s) => titles.includes(s.title.toLowerCase())).map((s) => s.slug);
    add({ key: "", label: "Overview", group: "System", sources: [{ path: "README.md", sections: pick(["how it works"]) }] });
    const concepts = pick(["key concepts", "safety model", "design principles"]);
    if (concepts.length) add({ key: "system/concepts", label: "Key concepts", group: "System", sources: [{ path: "README.md", sections: concepts }] });
  }
  if (row.has("CLAUDE.md")) {
    const arch = sectionsOf(outlineOf("CLAUDE.md")).filter((s) => /^architecture\b/i.test(s.title)).map((s) => s.slug);
    add({ key: routeKey(row.get("CLAUDE.md").route), label: "Architecture", group: "System", sources: [{ path: "CLAUDE.md", sections: arch }] });
  }
  const vision = row.get("config/orchestrator/vision.md");
  if (vision) add({ key: routeKey(vision.route), label: "Vision", group: "System", sources: [{ path: vision.path, sections: null }] });
  for (const r of rows) {
    if (!r.path.startsWith("config/direction/")) continue;
    // Labelled by file (direction/<name>) — two titles are both "Vision".
    const label = r.path.slice("config/".length, -".md".length);
    add({ key: routeKey(r.route), label, group: "System", depth: 1, sources: [{ path: r.path, sections: null }] });
  }

  // Catalogues > Reference
  for (const r of rows) {
    if (r.tier !== "living" || !r.route.startsWith("/docs/ref/")) continue;
    const key = routeKey(r.route);
    const label = LABEL_OVERRIDES[r.path] ?? r.title;
    if (r.path === "docs/reference.md") {
      const secs = sectionsOf(outlineOf(r.path)).filter((s) => s.slug !== "");
      const children = secs.map((s) => ({ key: `${key}/${s.slug}`, label: s.title }));
      add({ key, label, group: "Reference", depth: 1, sources: [{ path: r.path, sections: [""] }], children });
      for (const s of secs) {
        add({ key: `${key}/${s.slug}`, label: s.title, group: "Reference", depth: 2, tocDepth: 4, sources: [{ path: r.path, sections: [s.slug] }] });
      }
    } else {
      add({ key, label, group: "Reference", depth: 1, sources: [{ path: r.path, sections: null }] });
    }
  }

  // Catalogues > History
  for (const r of rows) {
    if (r.tier !== "historical") continue;
    add({ key: routeKey(r.route), label: r.title, group: "History", depth: 1, historical: true, sources: [{ path: r.path, sections: null }] });
  }

  // Skills (#4592): one view per playbook-tier corpus row, at /docs/skill/<name>.
  // The group is deliberately NOT a DOCS_TREE group — the nav tree gains exactly
  // ONE Catalogues entry (/docs/cat/classes), never one per skill; these views
  // are reached through that catalogue and the name index.
  for (const r of rows) {
    if (r.tier !== "playbook") continue;
    add({ key: routeKey(r.route), label: r.title, group: "Skills", depth: 1, sources: [{ path: r.path, sections: null }] });
  }
  return views;
}

/** Map `${path}#${slug}` -> the key of the FIRST view that renders that heading. */
export function headingHosts(views, outlines) {
  const hosts = new Map();
  for (const v of views) {
    for (const s of v.sources) {
      for (const h of (outlines.get(s.path) ?? { headings: [] }).headings) {
        if (s.sections !== null && !s.sections.includes(h.section)) continue;
        const k = `${s.path}#${h.slug}`;
        if (!hosts.has(k)) hosts.set(k, v.key);
      }
    }
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// Links — the single resolver
// ---------------------------------------------------------------------------

/** Posix-normalise `rel` against the directory of `fromPath`; null when it escapes the repo. */
export function resolveRepoPath(fromPath, rel) {
  const base = rel.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const parts = [...base];
  for (const seg of rel.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

export function githubUrl(path, kind, sha) {
  const ref = !sha || sha === "unknown" ? "master" : sha;
  return `${REPO_URL}/${kind === "dir" ? "tree" : "blob"}/${ref}/${path}`;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (err) {
    /* intentional: a malformed %-escape in an authored link is kept verbatim; it then fails
     * resolution and renders visibly broken, which is the reported outcome. */
    void err;
    return s;
  }
}

/**
 * Build the one link resolver. Result: { kind, href?, target? } with kind one of
 *   internal — a corpus member (page route, #slug mapped to the hosting view)
 *   github   — any other existing repo path, at the build SHA (master when unknown)
 *   external — absolute http(s)/mailto/... left untouched
 *   broken   — unresolvable; `target` names what was asked for
 *
 * ctx = { rows, outlines, hosts, fileKind(path) -> "file"|"dir"|null, sha }
 */
export function createLinkResolver({ rows, outlines, hosts, fileKind, sha }) {
  const member = new Map(rows.map((r) => [r.path, r]));
  const hasSlug = (path, slug) => (outlines.get(path)?.headings ?? []).some((h) => h.slug === slug || h.sec === slug.replace(/^§/, ""));
  return function resolve(href, fromPath) {
    const raw = String(href ?? "").trim();
    if (!raw) return { kind: "broken", target: "(empty link)" };
    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
    if (scheme) {
      if (/^(javascript|data|vbscript|file)$/i.test(scheme[1])) return { kind: "broken", target: raw };
      return { kind: "external", href: raw };
    }
    if (raw.startsWith("//")) return { kind: "external", href: raw };

    const hashAt = raw.indexOf("#");
    const pathPart = (hashAt === -1 ? raw : raw.slice(0, hashAt)).replace(/\?.*$/, "");
    const hash = hashAt === -1 ? "" : safeDecode(raw.slice(hashAt + 1));
    const target = pathPart === "" ? fromPath : resolveRepoPath(fromPath, safeDecode(pathPart));
    if (target === null) return { kind: "broken", target: raw };

    const m = member.get(target);
    if (m) {
      if (!hash) return { kind: "internal", href: m.route };
      const slug = hash.toLowerCase();
      const host = hosts.get(`${target}#${slug}`) ?? hosts.get(`${target}#${hash}`);
      if (host !== undefined) return { kind: "internal", href: `${docsHref(host)}#${hosts.has(`${target}#${slug}`) ? slug : hash}` };
      const sec = [...(outlines.get(target)?.headings ?? [])].find((h) => h.sec && `§${h.sec}` === hash);
      if (sec) {
        const secHost = hosts.get(`${target}#${sec.slug}`);
        if (secHost !== undefined) return { kind: "internal", href: `${docsHref(secHost)}#${sec.slug}` };
      }
      // The heading exists but no built view renders it (e.g. a CLAUDE.md
      // section outside Architecture): GitHub renders the whole file.
      if (hasSlug(target, slug)) return { kind: "github", href: `${githubUrl(target, "file", sha)}#${slug}` };
      return { kind: "broken", target: `${target}#${hash}` };
    }
    const kind = fileKind(target);
    if (!kind) return { kind: "broken", target: hash ? `${target}#${hash}` : target };
    return { kind: "github", href: `${githubUrl(target, kind, sha)}${hash ? `#${hash}` : ""}` };
  };
}

// ---------------------------------------------------------------------------
// Name index
// ---------------------------------------------------------------------------

/** `**Term**:` definition lines in CONTEXT.md. */
export function extractGlossaryTerms(markdown) {
  const out = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = line.match(/^\*\*([^*]+)\*\*\s*:/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/**
 * The name index (#4541 decision 6, extended #4592): one entry per skill and
 * per class FIRST (so the SEARCH_LIMIT cap can never hide them behind heading
 * noise), then every heading a built view renders (route#slug) EXCEPT
 * playbook-tier docs (their headings are prose, not names), CONTEXT.md
 * glossary terms, and routes.json route paths. Each entry flags `historical`;
 * the search box hides those unless toggled.
 *
 * `skillRows`/`classRows` are the docs/generated/skills.json + classes.json
 * rows (missing inventories contribute no entries — the dashboard renders its
 * explicit 'inventory unavailable' state instead).
 */
export function buildNameIndex({ views, outlines, hosts, rows, glossaryTerms, routeRows, skillRows, classRows }) {
  const entries = [];
  for (const s of skillRows ?? []) {
    entries.push({ name: s.name, href: s.route, kind: "skill", historical: false });
  }
  for (const c of classRows ?? []) {
    entries.push({ name: c.name, href: `/docs/cat/classes#${encodeURIComponent(c.name)}`, kind: "class", historical: false });
  }
  const playbookPaths = new Set((rows ?? []).filter((r) => r.tier === "playbook").map((r) => r.path));
  const historical = new Set(views.filter((v) => v.historical).map((v) => v.key));
  for (const [path, outline] of outlines) {
    if (playbookPaths.has(path)) continue; // playbook headings are never indexed (#4592 INV-22)
    for (const h of outline.headings) {
      const host = hosts.get(`${path}#${h.slug}`);
      if (host === undefined || !h.text) continue;
      entries.push({ name: h.text, href: `${docsHref(host)}#${h.slug}`, kind: "heading", historical: historical.has(host) });
    }
  }
  const context = rows.find((r) => r.path === "CONTEXT.md");
  if (context) {
    for (const term of glossaryTerms) entries.push({ name: term, href: context.route, kind: "term", historical: false });
  }
  for (const r of routeRows ?? []) {
    entries.push({ name: `${r.method} ${r.path}`, href: "/docs/cat/routes", kind: "route", historical: false });
  }
  return entries;
}
