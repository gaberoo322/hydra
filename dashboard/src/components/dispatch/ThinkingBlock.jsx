import { useState } from "react";

// Renders Claude's internal thinking block in a collapsible aside (collapsed by
// default). Self-contained: takes a `text` prop and returns JSX.

export default function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false); // collapsed by default
  return (
    <div className="my-1 border border-zinc-800 rounded bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] text-zinc-400 hover:bg-zinc-800/40"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="uppercase tracking-widest">thinking</span>
      </button>
      {open && (
        <div className="px-2 pb-2 text-xs text-zinc-400 italic whitespace-pre-wrap break-words">
          {text}
        </div>
      )}
    </div>
  );
}
