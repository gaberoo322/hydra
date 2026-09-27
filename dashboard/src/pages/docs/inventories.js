// Generated-inventory reader for the /docs reference surface (#4590,
// ADR-0034 §10). Build-time glob + runtime parse:
//
//  - The eager `?raw` glob inlines docs/generated/routes.json as TEXT at build
//    time. A missing file compiles to an empty module map, so the build never
//    fails over it (a static JSON import would turn a missing inventory into a
//    build failure — rejected in the design concept).
//  - The text is parsed here, at view time, inside try/catch, and the
//    envelope is checked. Missing, unparseable, and wrong-shape all collapse to
//    { ok: false, reason } so the page renders the explicit
//    'inventory unavailable' state — never an empty table (§10 trust rule 4).
//
// No network access happens here: the inventory is part of the bundle.

const routesModules = import.meta.glob("../../../../docs/generated/routes.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

/**
 * Parse one inventory's raw text into { ok: true, rows, generatedFrom } or
 * { ok: false, reason }. Exported for reuse by later families.
 */
export function parseInventory(raw, family) {
  if (raw == null) return { ok: false, reason: "missing" };
  let inv;
  try {
    inv = JSON.parse(raw);
  } catch (err) {
    console.error(`[docs] docs/generated/${family}.json is unparseable`, err);
    return { ok: false, reason: "unparseable" };
  }
  if (inv?.family !== family || inv.schemaVersion !== 1 || !Array.isArray(inv.rows)) {
    console.error(`[docs] docs/generated/${family}.json has an unexpected envelope`);
    return { ok: false, reason: "envelope" };
  }
  return {
    ok: true,
    rows: inv.rows,
    generatedFrom: Array.isArray(inv.generatedFrom) ? inv.generatedFrom : [],
  };
}

/** The inventory file for a family — derived, never hand-typed per block. */
export function inventoryFile(family) {
  return `docs/generated/${family}.json`;
}

/** The extractor that writes a family's inventory — derived from the family. */
export function extractorFile(family) {
  return `scripts/docs/inventories/${family}.ts`;
}

let routesCache = null;

/** The routes inventory, parsed once per page load. */
export function loadRoutesInventory() {
  if (!routesCache) routesCache = parseInventory(Object.values(routesModules)[0], "routes");
  return routesCache;
}
