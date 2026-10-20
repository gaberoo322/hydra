/**
 * Morning Brief HTML renderer (ADR-0045 Decision 5 + 7, issue #5047).
 *
 * Sections arrive as PLAIN text; every string passes through the single
 * `escapeHtml` escaper (via `renderLink` / `escapeHtml`) — no Markdown reaches
 * Telegram from this path. Pure: no env, no I/O. Never exceeds
 * {@link MAX_RENDERED_CHARS}: trailing lines are dropped and counted.
 */

import type { BriefSection } from "./brief-sources.ts";
import { MAX_RENDERED_CHARS, clip, escapeHtml, renderLink } from "./render.ts";

const MAX_LINE_CHARS = 400;

export function renderBrief(sections: BriefSection[], nowMs: number): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const head = `☀️ <b>Hydra Morning Brief</b> — ${escapeHtml(date)}`;

  // Flatten so trailing lines can be dropped to fit the Telegram limit.
  const rows: Array<{ text: string; header: boolean }> = [];
  for (const s of sections) {
    rows.push({ text: `\n<b>${escapeHtml(s.title)}</b>`, header: true });
    s.lines.forEach((line, idx) => {
      const url = s.urls?.[idx];
      const body = url ? renderLink(clip(line, MAX_LINE_CHARS), url) : escapeHtml(clip(line, MAX_LINE_CHARS));
      rows.push({ text: `• ${body}`, header: false });
    });
  }

  const build = (kept: number): string => {
    const dropped = rows.filter((r) => !r.header).length - rows.slice(0, kept).filter((r) => !r.header).length;
    return [head, ...rows.slice(0, kept).map((r) => r.text), ...(dropped > 0 ? [`… +${dropped} more lines`] : [])].join("\n");
  };

  let kept = rows.length;
  let out = build(kept);
  while (out.length > MAX_RENDERED_CHARS && kept > 0) {
    kept--;
    out = build(kept);
  }
  return out;
}
