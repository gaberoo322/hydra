import { loadRoutesInventory } from "./inventories.js";

// The /docs IA tree (#4590, ADR-0034 §10; Variant A). Group headers
// (System → Areas → Catalogues) are always present; entries are ONLY the views
// that exist — unbuilt sections are absent, never disabled links. An empty
// group renders a muted 'not yet generated' line.

const routes = loadRoutesInventory();

export const DOCS_TREE = [
  { group: "System", entries: [{ key: "", label: "Overview" }] },
  { group: "Areas", entries: [] },
  {
    group: "Catalogues",
    entries: [{ key: "cat/routes", label: "Routes", count: routes.ok ? routes.rows.length : null }],
  },
];

export function docsHref(key) {
  return key ? `/docs/${key}` : "/docs";
}
