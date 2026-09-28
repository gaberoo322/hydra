// Name search over the build-time name index (#4591, #4541 decision 6).
// Case-insensitive substring match on entry names; History entries are
// excluded unless `includeHistory`. Pure and dependency-free — the index is a
// build-time virtual module (virtual:hydra-docs), never loaded over the network.

export const SEARCH_LIMIT = 100;

/** Filter `entries` ({name, href, kind, historical}) by `query`. Empty query -> []. */
export function filterNameIndex(entries, query, { includeHistory = false, limit = SEARCH_LIMIT } = {}) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const e of entries ?? []) {
    if (e.historical && !includeHistory) continue;
    if (!String(e.name).toLowerCase().includes(q)) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
