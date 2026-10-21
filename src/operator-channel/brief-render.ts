/**
 * Telegram HTML renderer for the Morning Brief (ADR-0045 Decisions 5 and 7,
 * issue #5047).
 *
 * Takes the plain-text {@link BriefModel} `brief.ts` composes and produces the
 * on-wire HTML. Every string passes through exactly one escaper,
 * {@link escapeHtml} — no Markdown reaches Telegram from this path. Pure: no
 * env, no I/O. Never exceeds {@link MAX_RENDERED_CHARS}: whole lines are
 * trimmed from the longest sections first, each trimmed section ending in a
 * `… +N more` marker, so a busy night still ships one well-formed message.
 */

import { escapeHtml, MAX_RENDERED_CHARS } from "./render.ts";

export interface BriefSection {
  heading: string;
  /** Plain-text lines; empty means the section renders its own "nothing" line. */
  lines: string[];
  /** Rendered as a plain-text link line after `lines`; label/url are escaped. */
  links?: Array<{ label: string; url: string }>;
}

export interface BriefModel {
  /** e.g. "Tue 2026-10-20". */
  dateLabel: string;
  /** e.g. "yesterday 07:30" / "the last 24h". */
  sinceLabel: string;
  sections: BriefSection[];
}

const EMPTY_LINE = "nothing to report";

function renderLink(label: string, url: string): string {
  let ok = false;
  try {
    const u = new URL(url);
    ok = (u.protocol === "https:" || u.protocol === "http:") && !url.includes('"');
  } catch {
    /* intentional: an unparseable URL renders as escaped plain text below */
  }
  if (!ok) return `${escapeHtml(label)}: ${escapeHtml(url)}`;
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

interface RenderableSection {
  head: string;
  items: string[];
}

function toRenderable(s: BriefSection): RenderableSection {
  const items = s.lines.map((l) => `• ${escapeHtml(l)}`);
  for (const l of s.links ?? []) items.push(`• ${renderLink(l.label, l.url)}`);
  return { head: `<b>${escapeHtml(s.heading)}</b>`, items: items.length > 0 ? items : [`• ${EMPTY_LINE}`] };
}

/** Render the brief as Telegram HTML, never exceeding {@link MAX_RENDERED_CHARS}. */
export function renderBrief(model: BriefModel): string {
  const head = `☀️ <b>Hydra Morning Brief — ${escapeHtml(model.dateLabel)}</b>\n<i>since ${escapeHtml(model.sinceLabel)}</i>`;
  const sections = model.sections.map(toRenderable);
  const kept = sections.map((s) => s.items.length);

  const build = () =>
    [
      head,
      ...sections.map((s, i) => {
        const dropped = s.items.length - kept[i];
        return [s.head, ...s.items.slice(0, kept[i]), ...(dropped > 0 ? [`… +${dropped} more`] : [])].join("\n");
      }),
    ].join("\n\n");

  let out = build();
  while (out.length > MAX_RENDERED_CHARS) {
    // Trim one line from the section currently keeping the most lines; stop
    // when every section is down to one line (the head alone always fits).
    let idx = -1;
    for (let i = 0; i < kept.length; i++) if (kept[i] > 1 && (idx === -1 || kept[i] > kept[idx])) idx = i;
    if (idx === -1) break;
    kept[idx]--;
    out = build();
  }
  return out;
}
