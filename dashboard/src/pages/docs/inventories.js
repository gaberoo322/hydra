// Generated-inventory reader for the /docs reference surface (#4590,
// ADR-0034 §10; generalised to every family by #4594). Build-time glob +
// runtime parse:
//
//  - ONE eager `?raw` glob inlines every docs/generated/*.json as TEXT at
//    build time. A missing file simply has no entry in the module map, so the
//    build never fails over it (a static JSON import would turn a missing
//    inventory into a build failure — rejected in the design concept).
//  - loadInventory(family) parses that family's text here, at view time,
//    inside try/catch, and checks the envelope. Missing, unparseable, and
//    wrong-shape all collapse to { ok: false, reason } so the page renders the
//    explicit 'inventory unavailable' state — never an empty table (§10 trust
//    rule 4).
//
// No network access happens here: the inventories are part of the bundle.

const inventoryModules = import.meta.glob("../../../../docs/generated/*.json", {
  eager: true,
  query: "?raw",
  import: "default",
});

/**
 * Parse one inventory's raw text into { ok: true, rows, generatedFrom } or
 * { ok: false, reason }.
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

/** Raw text of a family's inventory from the build-time glob, or undefined when absent. */
function rawFor(family) {
  const suffix = `/docs/generated/${family}.json`;
  const key = Object.keys(inventoryModules).find((k) => k.endsWith(suffix));
  return key === undefined ? undefined : inventoryModules[key];
}

const cache = new Map();

/** A family's inventory, parsed once per page load. */
export function loadInventory(family) {
  if (!cache.has(family)) cache.set(family, parseInventory(rawFor(family), family));
  return cache.get(family);
}

/** The routes inventory (kept for the routes view and tree). */
export function loadRoutesInventory() {
  return loadInventory("routes");
}
