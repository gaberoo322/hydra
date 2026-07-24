import LocalTimestamp from "../LocalTimestamp.jsx";

// Renders the transcript metadata header (skill, dispatchId, runId, startedAt,
// projectDir). Self-contained: takes a `meta` prop and returns JSX (or null
// when meta is absent).

export default function MetaStrip({ meta }) {
  if (!meta) return null;
  const cells = [
    ["skill", meta.skill],
    ["dispatchId", meta.dispatchId],
    ["runId", meta.runId],
    ["startedAt", meta.startedAt],
    ["projectDir", meta.projectDir],
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 border border-zinc-800 rounded-lg p-4 bg-zinc-900/40">
      {cells.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">{k}</span>
          {k === "startedAt" ? (
            // Route the one UTC-ISO cell through the shared local-time seam:
            // browser-local wall-clock in the cell, full local date+time on
            // hover, em-dash on null/invalid (LocalTimestamp handles all three).
            <LocalTimestamp ts={v} className="text-xs text-zinc-200 font-mono truncate" />
          ) : (
            <span className="text-xs text-zinc-200 font-mono truncate" title={v || "—"}>
              {v || "—"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
