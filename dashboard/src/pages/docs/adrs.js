// Pure helpers for the ADRs views (#4593). Dependency-free plain JS — no
// React, no imports — so the root node:test suite pins them directly
// (test/docs-adrs.test.mts), same lane as vite-plugins/docs-core.js.
//
// plainStatusLine: the /docs/adr/NNNN metadata strip renders the status
// declaration as PLAIN text — the strip is not markdown (ADR-0034 §10: only
// build-time corpus HTML is injected), so emphasis/code/links must go.
// partitionAdrRows: the /docs/cat/adrs catalogue order — live statuses first
// in number order, then a rule, then superseded/deprecated muted.

/** Strip markdown links / code spans / emphasis from a status line. */
export function plainStatusLine(line) {
  return String(line ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

/** Statuses shown first, in number order, above the rule. */
const LIVE_STATUSES = new Set(["accepted", "superseded-in-part", "proposed"]);

/**
 * Partition ADR rows for the catalogue: { active, demoted } — active =
 * accepted/superseded-in-part/proposed in number order, demoted =
 * superseded/deprecated in number order (rendered muted, below the rule).
 */
export function partitionAdrRows(rows) {
  const byNumber = (a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0);
  const all = [...(rows ?? [])].sort(byNumber);
  return {
    active: all.filter((r) => LIVE_STATUSES.has(r.status)),
    demoted: all.filter((r) => !LIVE_STATUSES.has(r.status)),
  };
}

/** The /docs route for an ADR number — corpusRoute's rule, /docs/adr/NNNN. */
export function adrRoute(number) {
  return `/docs/adr/${number}`;
}
