// Inline-span markdown renderer, split out from the block-level Markdown
// component (#3593) so the component file exports only a component (keeps
// react-refresh happy). Handles inline `code`, **bold**, and *italic*; emphasis
// inside code spans is left literal because code is matched first.

export function renderInline(text, keyPrefix) {
  // Split on inline code first (so emphasis inside code is left literal).
  const parts = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      parts.push(
        <code key={`${keyPrefix}-c${i}`} className="px-1 py-0.5 rounded bg-zinc-800 text-emerald-300 font-mono text-[0.85em]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      parts.push(<strong key={`${keyPrefix}-b${i}`} className="text-zinc-100">{tok.slice(2, -2)}</strong>);
    } else {
      parts.push(<em key={`${keyPrefix}-i${i}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
