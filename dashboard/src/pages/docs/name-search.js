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

/**
 * Decode a location hash into an element id. A malformed %-escape must never throw
 * out of a React effect (that unmounts the whole dashboard), so fall back to the raw hash.
 */
export function hashToId(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    /* intentional: a malformed %-escape in the URL hash is looked up verbatim; no match = no scroll. */
    void err;
    return raw;
  }
}
