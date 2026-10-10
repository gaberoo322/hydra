/**
 * Corpus family extractor (issue #4591 — docs-epic slice 5, per the #4544
 * resolution decision 2 and ADR-0034 §10).
 *
 * `extractCorpus(repoRoot)` is the ONE membership truth for the markdown the
 * /docs page renders: the runner (scripts/docs/generate-inventories.ts) writes
 * it to docs/generated/corpus.json, the drift test
 * (test/generated-inventories-drift.test.mts) deepEquals a fresh run against
 * that file, and the dashboard's Vite plugin (dashboard/vite-plugins/) reads
 * EXACTLY the paths it lists — never a glob of its own.
 *
 * Membership = the #4541 decision-3 living docs this slice renders, plus
 * docs/adr/*.md as tier `adr` (#4593; the roster README is skipped) and
 * docs/historical/** as tier `historical`. It is declared below as
 * `CORPUS_SOURCES` and those globs are echoed verbatim as `generatedFrom`.
 * docs/research/* is never a member. Playbooks (#4592) and co-located
 * src/<area>/CONTEXT.md docs (#4596) join membership in their own slices,
 * together with the view their route points at — so every row's route
 * resolves to a view that is built.
 *
 * Stdlib-only (ADR-0005): no markdown parser here. A row's title is the first
 * `# ` heading outside a code fence (regex), falling back to the basename.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { CorpusInventory, CorpusRow, CorpusTier } from "./envelope.ts";

/** Extraction errors throw with this prefix so tests and humans can tell them from I/O failures. */
function fail(message: string): never {
  throw new Error(`[docs-inventories] ${message}`);
}

/**
 * The declared corpus sources, in the only three glob shapes the expander
 * understands: an exact path, `dir/*.md` (one level), `dir/**\/*.md` (recursive).
 */
export const CORPUS_SOURCES: ReadonlyArray<{ glob: string; tier: CorpusTier }> = [
  { glob: "README.md", tier: "living" },
  { glob: "CLAUDE.md", tier: "living" },
  { glob: "CONTEXT.md", tier: "living" },
  { glob: "CONTEXT-MAP.md", tier: "living" },
  { glob: "docs/reference.md", tier: "living" },
  { glob: "docs/agents/*.md", tier: "living" },
  { glob: "docs/quality-gates.md", tier: "living" },
  { glob: "docs/evals.md", tier: "living" },
  { glob: "docs/operations/*.md", tier: "living" },
  { glob: "docs/observability/README.md", tier: "living" },
  { glob: "docs/target-swap-runbook.md", tier: "living" },
  { glob: "config/orchestrator/vision.md", tier: "living" },
  { glob: "config/direction/*.md", tier: "living" },
  { glob: "docs/adr/*.md", tier: "adr" },
  { glob: "docs/operator-playbooks/*.md", tier: "playbook" },
  { glob: "docs/historical/**/*.md", tier: "historical" },
];

function isFile(abs: string): boolean {
  return existsSync(abs) && statSync(abs).isFile();
}

function listMd(repoRoot: string, dir: string, recursive: boolean): string[] {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive) out.push(...listMd(repoRoot, rel, true));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

/** Expand one declared glob against the tree. Unknown glob shapes are an extraction error. */
export function expandCorpusGlob(repoRoot: string, glob: string): string[] {
  if (glob.endsWith("/**/*.md")) return listMd(repoRoot, glob.slice(0, -"/**/*.md".length), true);
  if (glob.endsWith("/*.md")) return listMd(repoRoot, glob.slice(0, -"/*.md".length), false);
  if (glob.includes("*")) fail(`unsupported corpus glob "${glob}"`);
  return isFile(join(repoRoot, glob)) ? [glob] : [];
}

/** Lowercase, and anything outside [a-z0-9/_-] becomes '-'. */
function routeSegment(p: string): string {
  return p.toLowerCase().replace(/[^a-z0-9/_-]+/g, "-");
}

/**
 * The page route for a member, derived ONLY from its path. The view each route
 * names is built by dashboard/vite-plugins/docs-core.js (`buildViews`).
 */
export function corpusRoute(path: string): string {
  if (path === "README.md") return "/docs";
  if (path === "CLAUDE.md") return "/docs/system/architecture";
  if (path === "config/orchestrator/vision.md") return "/docs/system/vision";
  if (path.startsWith("config/direction/")) {
    return `/docs/system/vision/${routeSegment(path.slice("config/direction/".length, -".md".length))}`;
  }
  if (path === "CONTEXT.md") return "/docs/ref/context";
  if (path === "CONTEXT-MAP.md") return "/docs/ref/context-map";
  if (path.startsWith("docs/operator-playbooks/")) {
    // The skill view route: /docs/skill/<frontmatter name>. The name equals
    // the file basename (the skills extractor enforces it), so it derives
    // from the path alone.
    return `/docs/skill/${routeSegment(path.slice("docs/operator-playbooks/".length, -".md".length))}`;
  }
  if (path.startsWith("docs/adr/")) {
    // docs/adr/NNNN-slug.md -> /docs/adr/NNNN — the one home of the ADR route rule (#4593).
    const m = path.match(/^docs\/adr\/(\d{4})-[^/]*\.md$/);
    if (!m) fail(`ADR corpus member "${path}" is not an NNNN-slug.md file`);
    return `/docs/adr/${m[1]}`;
  }
  if (path.startsWith("docs/historical/")) {
    return `/docs/history/${routeSegment(path.slice("docs/historical/".length, -".md".length))}`;
  }
  if (path.startsWith("docs/")) return `/docs/ref/${routeSegment(path.slice("docs/".length, -".md".length))}`;
  return fail(`no route rule for corpus member "${path}"`);
}

/** The first `# ` heading outside a code fence, else the file basename. */
export function corpusTitle(path: string, source: string): string {
  let fence: string | null = null;
  let body = source;
  // A leading YAML frontmatter block is never a heading.
  const fm = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (fm) body = body.slice(fm[0].length);
  for (const line of body.split(/\r?\n/)) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (h) return h[1];
  }
  return basename(path);
}

/** Build the corpus inventory for `repoRoot`. Rows sorted by path; routes unique. */
export function extractCorpus(repoRoot: string): CorpusInventory {
  const byPath = new Map<string, CorpusRow>();
  for (const { glob, tier } of CORPUS_SOURCES) {
    for (const path of expandCorpusGlob(repoRoot, glob)) {
      if (path.startsWith("docs/research/")) continue; // never a member (#4541 decision 3)
      if (path === "docs/adr/README.md") continue; // the roster is never a corpus member (#4593)
      if (byPath.has(path)) continue;
      const source = readFileSync(join(repoRoot, path), "utf8");
      byPath.set(path, { path, tier, route: corpusRoute(path), title: corpusTitle(path, source) });
    }
  }
  const rows = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Map<string, string>();
  for (const row of rows) {
    const prior = seen.get(row.route);
    if (prior) fail(`corpus route ${row.route} is claimed by both ${prior} and ${row.path}`);
    seen.set(row.route, row.path);
  }
  return {
    family: "corpus",
    schemaVersion: 1,
    generatedFrom: CORPUS_SOURCES.map((s) => s.glob),
    rows,
  };
}
