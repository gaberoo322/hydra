import { loadRoutesInventory } from "./inventories.js";
import { views } from "virtual:hydra-docs";

// The /docs IA tree (#4590, ADR-0034 §10; Variant A). Group headers
// (System → Areas → Catalogues) are always present; entries are ONLY the views
// that exist — unbuilt sections are absent, never disabled links. An empty
// group renders a muted 'not yet generated' line.
//
// #4591: the markdown views come from the build-time manifest
// (virtual:hydra-docs, emitted by dashboard/vite-plugins/docs-markdown.js from
// docs/generated/corpus.json), so the tree gains entries only for views the
// build actually rendered.

const routes = loadRoutesInventory();

/** View key → markdown view (from the build-time manifest). */
export const DOCS_VIEWS = new Map(views.map((v) => [v.key, v]));

const entryOf = (v) => ({ key: v.key, label: v.label, depth: v.depth, historical: v.historical });
const ofGroup = (group) => views.filter((v) => v.group === group).map(entryOf);

const system = ofGroup("System");
if (!DOCS_VIEWS.has("")) system.unshift({ key: "", label: "Overview", depth: 0 });
const reference = ofGroup("Reference");
const history = ofGroup("History");

export const DOCS_TREE = [
  { group: "System", entries: system },
  { group: "Areas", entries: [] },
  {
    group: "Catalogues",
    entries: [
      { key: "cat/routes", label: "Routes", count: routes.ok ? routes.rows.length : null },
      ...(reference.length ? [{ header: "Reference" }, ...reference] : []),
      ...(history.length ? [{ header: "History", retired: true }, ...history] : []),
    ],
  },
];

export function docsHref(key) {
  return key ? `/docs/${key}` : "/docs";
}
