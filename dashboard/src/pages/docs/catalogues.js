// The code-imported (#4594) and scanned-infra (#4595) catalogue families on
// /docs (ADR-0034 §10), in tree order after Routes. Each entry's inventory and
// extractor names are DERIVED from `family` (inventories.js), never
// hand-typed here.

export const CODE_CATALOGUES = [
  { family: "redis-keys", label: "Redis keys" },
  { family: "streams", label: "Streams" },
  { family: "schemas", label: "Schemas" },
  { family: "tier-paths", label: "Tier paths" },
  { family: "chores", label: "Chores" },
  { family: "env-vars", label: "Env vars" },
  { family: "pages", label: "Pages" },
  { family: "config", label: "Config" },
  { family: "ci-gates", label: "CI gates" },
  { family: "units-scripts", label: "Units & scripts" },
];

/** The /docs view key for a catalogue family. */
export function catalogueKey(family) {
  return `cat/${family}`;
}

/** Families whose rows carry a `home` deep link (Live state lives on). */
export const HOMED_FAMILIES = new Set(["redis-keys", "streams"]);

/** Distinct cockpit-page homes (non-/api) of a homed family's rows, in row order. */
export function liveHomes(family, inventory) {
  if (!HOMED_FAMILIES.has(family) || !inventory?.ok) return [];
  return [
    ...new Set(inventory.rows.map((r) => r.home).filter((h) => typeof h === "string" && !h.startsWith("/api"))),
  ];
}
