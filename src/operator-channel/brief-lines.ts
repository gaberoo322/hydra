/**
 * Morning Brief line rendering (ADR-0045 Decision 7, issues #5047 / #5389).
 *
 * The per-kind renderers live on the rows of `KIND_TABLE` in `./page-list.ts`
 * (the one per-kind table); this file re-exports the brief types and the
 * `fact` helper so existing importers keep compiling, and owns the generic
 * fallback dispatch and the tolerant stored-item parse. A kind with no
 * `briefLine` (an arbitrary `/events/publish` payload, or a literal-page row)
 * renders through the generic `kind — title (facts)` line and is never blank.
 *
 * Every renderer returns PLAIN TEXT. The HTML escaping happens exactly once,
 * in `brief-render.ts` through `escapeHtml` (ADR-0045 Decision 5).
 */

import { genericBriefLine, rowOf, type BriefItem } from "./page-list.ts";

export { fact } from "./page-list.ts";
export type { BriefItem, BriefKind, BriefLineRenderer } from "./page-list.ts";

/**
 * Render one brief item as a plain-text line. A kind whose row carries a
 * `briefLine` uses it; anything else gets the generic `kind — title (facts)`
 * line, so an unknown on-wire kind is reported rather than silently dropped.
 */
export function renderBriefLine(item: BriefItem): string {
  const renderer = rowOf(item.kind)?.briefLine;
  return renderer ? renderer(item) : genericBriefLine(item);
}

/**
 * Tolerant parse of a stored list entry. Returns null for an entry that is not
 * a brief item (corrupt, or missing kind/at) so one bad row never blanks the
 * section.
 */
export function briefItemFromStored(raw: unknown): BriefItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : null;
  const at = typeof r.at === "number" ? r.at : Number(r.at);
  if (!kind || !Number.isFinite(at)) return null;
  const facts = Array.isArray(r.facts)
    ? r.facts
        .filter((f): f is { label: unknown; value: unknown } => !!f && typeof f === "object")
        .map((f) => ({ label: String(f.label), value: String(f.value) }))
    : [];
  const links = Array.isArray(r.links)
    ? r.links
        .filter((l): l is { label: unknown; url: unknown } => !!l && typeof l === "object")
        .map((l) => ({ label: String(l.label), url: String(l.url) }))
    : [];
  return {
    severity: "brief",
    kind,
    title: typeof r.title === "string" ? r.title : kind,
    facts,
    links,
    dedupKey: typeof r.dedupKey === "string" ? r.dedupKey : kind,
    at,
  };
}
