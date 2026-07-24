import { useState, useMemo } from "react";

// Renders a tool_use + (paired) tool_result in collapsible form (collapsed by
// default), showing the tool input JSON and the tool output. Self-contained:
// takes name/input/result props and returns JSX.

export default function ToolBlock({ name, input, result }) {
  const [open, setOpen] = useState(false); // collapsed by default
  const inputStr = useMemo(() => {
    if (input == null) return "";
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }, [input]);
  return (
    <div className="my-1 border border-zinc-800 rounded bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-zinc-800/40"
      >
        <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
        <span className="uppercase tracking-widest text-sky-400">tool</span>
        <span className="font-mono text-zinc-300">{name}</span>
        {result?.isError && (
          <span className="text-[10px] text-red-400 uppercase tracking-widest">error</span>
        )}
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">input</div>
            <pre className="p-2 rounded bg-zinc-950/70 border border-zinc-800 overflow-x-auto text-[11px] font-mono text-zinc-300 whitespace-pre-wrap break-words">
              {inputStr || "(no input)"}
            </pre>
          </div>
          {result && (
            <div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-1">
                output{result.isError ? " (error)" : ""}
              </div>
              <pre className={`p-2 rounded bg-zinc-950/70 border overflow-x-auto text-[11px] font-mono whitespace-pre-wrap break-words ${result.isError ? "border-red-900/60 text-red-300" : "border-zinc-800 text-zinc-300"}`}>
                {result.text || "(no output)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
