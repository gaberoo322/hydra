// ---------------------------------------------------------------------------
// Minimal markdown renderer — dependency-free (ADR-0005 forbids unapproved
// runtime deps). Handles the high-frequency subset agents actually emit:
// headings, fenced code blocks, inline `code`, **bold**, *italic*, bullet
// lists. Everything is rendered through React elements (never
// dangerouslySetInnerHTML), so there is no XSS surface.
//
// The single dashboard-level prose renderer: any page that renders agent
// output (transcript, run logs, journal entries, learning context) imports
// this rather than re-copying the grammar. The inline-span pass lives in
// ../../lib/markdown-inline.jsx.
// ---------------------------------------------------------------------------

import { renderInline } from "../../lib/markdown-inline.jsx";

export default function Markdown({ text }) {
  const lines = String(text ?? "").split("\n");
  const nodes = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block.
    if (line.trim().startsWith("```")) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      nodes.push(
        <pre key={`md${key++}`} className="my-2 p-2 rounded bg-zinc-950/70 border border-zinc-800 overflow-x-auto text-[12px] font-mono text-zinc-300 whitespace-pre-wrap break-words">
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      nodes.push(
        <div key={`md${key++}`} className="font-semibold text-zinc-100 mt-2">
          {renderInline(h[2], `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }
    // Bullet list (consecutive lines).
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={`md${key++}`} className="list-disc list-inside my-1 space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `li${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    // Blank line → spacer.
    if (line.trim() === "") {
      nodes.push(<div key={`md${key++}`} className="h-2" />);
      i++;
      continue;
    }
    // Plain paragraph line.
    nodes.push(
      <div key={`md${key++}`} className="whitespace-pre-wrap break-words">
        {renderInline(line, `p${key}`)}
      </div>,
    );
    i++;
  }
  return <div className="text-sm text-zinc-200 leading-relaxed">{nodes}</div>;
}
