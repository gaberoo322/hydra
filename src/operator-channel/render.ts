/**
 * Telegram HTML renderer for the Operator Channel (ADR-0045 Decision 5,
 * issue #5045).
 *
 * Every rendered string passes through exactly one escaper, {@link escapeHtml}
 * (`&`, `<`, `>` and nothing else). Pure: no env, no I/O.
 */

import type { OperatorMessage } from "./message.ts";

export const MAX_RENDERED_CHARS = 4000;
const MAX_TITLE_CHARS = 300;
const MAX_VALUE_CHARS = 500;

export type RenderVariant = "page" | "reminder" | "recovered";

/** The single escaper. `&` first so later entities are not double-escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function renderLink(label: string, url: string): string {
  let ok = false;
  try {
    const u = new URL(url);
    ok = (u.protocol === "https:" || u.protocol === "http:") && !url.includes('"');
  } catch {
    /* intentional: an unparseable URL is rendered as plain text below */
  }
  if (!ok) return `${escapeHtml(clip(label, MAX_VALUE_CHARS))}: ${escapeHtml(clip(url, MAX_VALUE_CHARS))}`;
  return `<a href="${escapeHtml(url)}">${escapeHtml(clip(label, MAX_VALUE_CHARS))}</a>`;
}

export interface RenderOptions {
  variant?: RenderVariant;
  /** The resolved recommended command for `msg.action`, if any. */
  actionCommand?: string;
  /** Extra fact lines (e.g. the reminder's suppressed count). */
  extraFacts?: Array<{ label: string; value: string }>;
}

const PREFIX: Record<RenderVariant, string> = {
  page: "🚨",
  reminder: "🔁 still failing —",
  recovered: "✅ recovered —",
};

/** Render a message as Telegram HTML, never exceeding {@link MAX_RENDERED_CHARS}. */
export function renderMessage(msg: OperatorMessage, opts: RenderOptions = {}): string {
  const variant = opts.variant ?? "page";
  const head = `${PREFIX[variant]} <b>${escapeHtml(clip(msg.title, MAX_TITLE_CHARS))}</b>`;
  const optional: string[] = [
    ...[...msg.facts, ...(opts.extraFacts ?? [])].map(
      (f) => `${escapeHtml(clip(f.label, MAX_VALUE_CHARS))}: <code>${escapeHtml(clip(f.value, MAX_VALUE_CHARS))}</code>`,
    ),
    ...msg.links.map((l) => renderLink(l.label, l.url)),
  ];
  const tail = opts.actionCommand ? [`Action: <code>${escapeHtml(clip(opts.actionCommand, MAX_TITLE_CHARS))}</code>`] : [];

  const build = (items: string[], dropped: number) =>
    [head, ...items, ...(dropped > 0 ? [`… +${dropped} more`] : []), ...tail].join("\n");

  let kept = optional.length;
  let out = build(optional, 0);
  while (out.length > MAX_RENDERED_CHARS && kept > 0) {
    kept--;
    out = build(optional.slice(0, kept), optional.length - kept);
  }
  return out;
}
