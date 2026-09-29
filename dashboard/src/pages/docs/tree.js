import { loadInventory, loadRoutesInventory } from "./inventories.js";
import { CODE_CATALOGUES, catalogueKey } from "./catalogues.js";

// The /docs IA tree (#4590, ADR-0034 §10; Variant A). Group headers
// (System → Areas → Catalogues) are always present; entries are ONLY the views
// that exist — unbuilt sections are absent, never disabled links. An empty
// group renders a muted 'not yet generated' line. The code-imported catalogue
// families (#4594) follow Routes, each with its row count.

const routes = loadRoutesInventory();

const rowCount = (inv) => (inv.ok ? inv.rows.length : null);

export const DOCS_TREE = [
  { group: "System", entries: [{ key: "", label: "Overview" }] },
  { group: "Areas", entries: [] },
  {
    group: "Catalogues",
    entries: [
      { key: "cat/routes", label: "Routes", count: rowCount(routes) },
      ...CODE_CATALOGUES.map(({ family, label }) => ({
        key: catalogueKey(family),
        label,
        count: rowCount(loadInventory(family)),
      })),
    ],
  },
];

export function docsHref(key) {
  return key ? `/docs/${key}` : "/docs";
}
