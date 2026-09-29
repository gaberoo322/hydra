/**
 * pages family extractor (issue #4595 — docs-epic 9/13, per the #4542
 * families table and ADR-0034 §1 + §10).
 *
 * One row per dashboard/src/App.jsx `<Route>` =
 *   {order, path, kind, component, redirectTo, inNav, navGroup, source}
 *
 * - The route parse is NOT re-implemented here: `classifyAppRoutes` in
 *   routes.ts is the ONE App.jsx classifier, consumed by both this family and
 *   routes.ts's home candidates (so pages.json kinds and routes.json homes can
 *   never disagree about what is live or a redirect).
 * - Nav comes from the exported JOURNEY_NAV and REFERENCE_NAV arrays in
 *   dashboard/src/components/Sidebar.jsx (what the issue's "NAV_ITEMS" means
 *   since #4590). A row is inNav when a nav `to` equals its path, or equals its
 *   path with a trailing `/*` removed.
 * - A missing or empty nav array throws, and so does a nav `to` that matches
 *   no live row: a nav link to nothing is a lie.
 * - Rows keep App.jsx source order with an explicit `order` index (the one
 *   family exception to label sorting).
 *
 * Read-only over App.jsx and Sidebar.jsx. Stdlib-only (ADR-0005).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PageRow, PagesInventory } from "./envelope.ts";
import { classifyAppRoutes } from "./routes.ts";
import { fail } from "./scan.ts";

const APP_FILE = "dashboard/src/App.jsx";
const SIDEBAR_FILE = "dashboard/src/components/Sidebar.jsx";

const GENERATED_FROM = [APP_FILE, SIDEBAR_FILE];

const NAV_ARRAYS: ReadonlyArray<{ name: string; group: "journey" | "reference" }> = [
  { name: "JOURNEY_NAV", group: "journey" },
  { name: "REFERENCE_NAV", group: "reference" },
];

/** The `to` literals of one exported nav array in Sidebar.jsx; throws when missing or empty. */
export function parseNavArray(sidebarSrc: string, name: string): string[] {
  const open = sidebarSrc.search(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[`));
  if (open === -1) fail(`${SIDEBAR_FILE}: no "export const ${name} = [" array found`);
  const start = sidebarSrc.indexOf("[", open);
  const end = sidebarSrc.indexOf("\n];", start);
  if (end === -1) fail(`${SIDEBAR_FILE}: the ${name} array never closes`);
  const body = sidebarSrc.slice(start, end);
  const tos = [...body.matchAll(/\bto:\s*(["'])([^"']+)\1/g)].map((m) => m[2]);
  if (tos.length === 0) fail(`${SIDEBAR_FILE}: ${name} scanned empty`);
  return tos;
}

/** Pure row-builder: App.jsx + Sidebar.jsx source text in, rows in App.jsx source order out. */
export function buildPageRows(input: { appSrc: string; sidebarSrc: string }): PageRow[] {
  const routes = classifyAppRoutes(input.appSrc);
  if (routes.length === 0) fail(`${APP_FILE}: no <Route path element /> found`);
  const nav: Array<{ to: string; group: "journey" | "reference" }> = [];
  for (const { name, group } of NAV_ARRAYS) {
    for (const to of parseNavArray(input.sidebarSrc, name)) nav.push({ to, group });
  }

  const navPath = (path: string): string => (path.endsWith("/*") ? path.slice(0, -2) : path);
  const liveMatch = (to: string) =>
    routes.find((r) => r.kind === "live" && (r.path === to || navPath(r.path) === to));
  for (const item of nav) {
    if (!liveMatch(item.to)) fail(`${SIDEBAR_FILE}: nav entry "${item.to}" matches no live App.jsx route`);
  }

  return routes.map((r) => {
    const hit = nav.find((item) => item.to === r.path || item.to === navPath(r.path));
    return {
      order: r.order,
      path: r.path,
      kind: r.kind,
      component: r.component,
      redirectTo: r.redirectTo,
      inNav: hit !== undefined,
      navGroup: hit ? hit.group : null,
      source: { path: APP_FILE, line: r.line },
    };
  });
}

/** The listing label of a pages row (App.jsx source order is part of the truth). */
export function pageRowLabel(row: PageRow): string {
  return `${row.order} ${row.path}`;
}

export function extractPages(repoRoot: string): PagesInventory {
  const rows = buildPageRows({
    appSrc: readFileSync(join(repoRoot, APP_FILE), "utf8"),
    sidebarSrc: readFileSync(join(repoRoot, SIDEBAR_FILE), "utf8"),
  });
  return { family: "pages", schemaVersion: 1, generatedFrom: GENERATED_FROM, rows };
}
