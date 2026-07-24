import { useState, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import LocalTimestamp from "../components/LocalTimestamp.jsx";

// Issue #695 — subagent transcript viewer.
//
// Renders the JSONL conversation of any active or recently-completed subagent
// dispatch at /dispatch/:dispatchId/transcript. The :dispatchId path param is
// the harness sessionId (the unified active-dispatch row's id for the subagent
// source). The page is deep-linkable: it reads everything it needs from the
// URL + a one-shot fetch, with no required client-side state.
//
// v1 render policy (per the gate-approved design concept for #695):
//   - user/assistant/system filter toggles
//   - tool_use blocks collapsed by default, expand shows input + (paired)
//     tool_result output
//   - thinking blocks collapsed by default
//   - user/assistant text rendered as (minimal, dependency-free) markdown
//   - NO raw-JSON view
//   - missing-JSONL → "transcript not available" with metadata visible

const PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Minimal markdown renderer — dependency-free (ADR-0005 forbids unapproved
// runtime deps). Handles the high-frequency subset agents actually emit:
// headings, fenced code blocks, inline `code`, **bold**, *italic*, bullet
// lists. Everything is rendered through React elements (never
// dangerouslySetInnerHTML), so there is no XSS surface.
// ---------------------------------------------------------------------------

function renderInline(text, keyPrefix) {
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

function Markdown({ text }) {
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

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function ThinkingBlock({ text }) {
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

function ToolBlock({ name, input, result }) {
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

const ROLE_STYLES = {
  user: { label: "user", chip: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30" },
  assistant: { label: "assistant", chip: "bg-sky-500/10 text-sky-300 border-sky-500/30" },
  system: { label: "system", chip: "bg-zinc-700/40 text-zinc-300 border-zinc-600" },
};

function MessageCard({ message }) {
  const role = ROLE_STYLES[message.role] || ROLE_STYLES.system;
  // Pair each tool_use with the immediately-following tool_result so the
  // expand control shows input AND output together.
  const rendered = [];
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "tool_use") {
      let result = null;
      if (blocks[i + 1] && blocks[i + 1].type === "tool_result") {
        result = blocks[i + 1];
        i++; // consume the paired result
      }
      rendered.push(<ToolBlock key={i} name={b.name} input={b.input} result={result} />);
    } else if (b.type === "tool_result") {
      // Unpaired tool_result (result without a preceding use in this message).
      rendered.push(<ToolBlock key={i} name="(result)" input={null} result={b} />);
    } else if (b.type === "thinking") {
      rendered.push(<ThinkingBlock key={i} text={b.text} />);
    } else {
      // text — markdown for user/assistant, plain for system.
      rendered.push(
        message.role === "system" ? (
          <div key={i} className="text-xs text-zinc-400 whitespace-pre-wrap break-words">{b.text}</div>
        ) : (
          <Markdown key={i} text={b.text} />
        ),
      );
    }
  }
  return (
    <div className="border border-zinc-800 rounded-lg bg-zinc-900/30 p-3 space-y-1">
      <div className="flex items-center gap-2">
        <span className={`px-1.5 py-0.5 text-[10px] rounded border ${role.chip}`}>{role.label}</span>
        {message.timestamp && (
          <LocalTimestamp ts={message.timestamp} className="text-[10px] text-zinc-600 font-mono" />
        )}
      </div>
      <div className="space-y-1">{rendered}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metadata strip
// ---------------------------------------------------------------------------

function MetaStrip({ meta }) {
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const ALL_ROLES = ["user", "assistant", "system"];

export default function DispatchTranscript() {
  const { dispatchId } = useParams();
  const [offset, setOffset] = useState(0);
  const [roleFilter, setRoleFilter] = useState({ user: true, assistant: true, system: false });

  const { data, error, loading } = useApi(
    `/dispatches/${encodeURIComponent(dispatchId)}/transcript?offset=${offset}&limit=${PAGE_LIMIT}`,
  );

  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const total = Number(data?.total ?? 0);
  const notAvailable = data?.transcriptStatus === "not-available";
  const is404 = error && /^404/.test(error);

  const visible = messages.filter((m) => roleFilter[m.role]);

  const header = (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-bold text-white">Dispatch transcript</h1>
        <Link to="/now" className="text-xs text-blue-400 hover:underline">← Back to Now</Link>
      </div>
      <p className="text-sm text-zinc-500 font-mono">{dispatchId}</p>
    </div>
  );

  if (loading && !data) {
    return (
      <div className="p-6 space-y-5">
        {header}
        <div className="text-zinc-500 text-sm">Loading…</div>
      </div>
    );
  }

  if (is404) {
    return (
      <div className="p-6 space-y-5">
        {header}
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          <h2 className="text-base font-semibold text-zinc-200 mb-1">Dispatch not found</h2>
          <p className="text-sm text-zinc-500">
            No subagent dispatch is registered for this id. Subagent rows expire 24h after the session starts.
          </p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-6 space-y-5">
        {header}
        <div className="border border-zinc-800 rounded-lg p-6 bg-zinc-900/50">
          <h2 className="text-base font-semibold text-red-400 mb-1">Failed to load transcript</h2>
          <p className="text-sm text-zinc-500 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  const meta = data?.sessionMetadata;

  return (
    <div className="p-6 space-y-5">
      {header}
      <MetaStrip meta={meta} />

      {notAvailable ? (
        <div className="border border-amber-700/40 rounded-lg p-6 bg-amber-900/10">
          <h2 className="text-base font-semibold text-amber-300 mb-1">Transcript not available</h2>
          <p className="text-sm text-zinc-400">
            This dispatch is registered, but its conversation transcript is not on disk
            (it may have been cleaned up, or the session never wrote one). The dispatch
            metadata above is all that remains.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-zinc-500 mr-1">show</span>
            {ALL_ROLES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRoleFilter((prev) => ({ ...prev, [r]: !prev[r] }))}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${roleFilter[r] ? "border-emerald-500/50 bg-emerald-900/20 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:border-zinc-600"}`}
              >
                {r}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-zinc-500">
              {visible.length} shown · {total} total
            </span>
          </div>

          <div className="space-y-2">
            {visible.length === 0 ? (
              <div className="text-sm text-zinc-500 italic">
                {messages.length === 0
                  ? "No messages on this page."
                  : "No messages match the current filter."}
              </div>
            ) : (
              visible.map((m, idx) => <MessageCard key={offset + idx} message={m} />)
            )}
          </div>

          {total > PAGE_LIMIT && (
            <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_LIMIT))}
                className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                ← Newer page
              </button>
              <span className="text-[11px] text-zinc-500 font-mono">
                {offset + 1}–{Math.min(offset + PAGE_LIMIT, total)} of {total}
              </span>
              <button
                type="button"
                disabled={offset + PAGE_LIMIT >= total}
                onClick={() => setOffset((o) => o + PAGE_LIMIT)}
                className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                Older page →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
