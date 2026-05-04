import { useState, useEffect, useMemo, useCallback } from "react";
import { useApi } from "../hooks/useApi.js";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

// --- Color mappings (static classes for Tailwind JIT) ---
const GROUP_COLORS = {
  emerald: { fill: "#064e3b", stroke: "#34d399", text: "#6ee7b7", region: "rgba(6,78,59,0.25)", label: "#34d399" },
  blue:    { fill: "#1e3a5f", stroke: "#60a5fa", text: "#93c5fd", region: "rgba(30,58,95,0.25)", label: "#60a5fa" },
  amber:   { fill: "#78350f", stroke: "#fbbf24", text: "#fde68a", region: "rgba(120,53,15,0.25)", label: "#fbbf24" },
  purple:  { fill: "#3b0764", stroke: "#a78bfa", text: "#c4b5fd", region: "rgba(59,7,100,0.25)", label: "#a78bfa" },
  cyan:    { fill: "#164e63", stroke: "#22d3ee", text: "#67e8f9", region: "rgba(22,78,99,0.25)", label: "#22d3ee" },
  rose:    { fill: "#4c0519", stroke: "#fb7185", text: "#fda4af", region: "rgba(76,5,25,0.25)", label: "#fb7185" },
  zinc:    { fill: "#27272a", stroke: "#71717a", text: "#a1a1aa", region: "rgba(39,39,42,0.25)", label: "#71717a" },
};

const NODE_W = 150;
const NODE_H = 36;

function ArchitectureDiagram() {
  const { data, loading, error } = useApi("/architecture", { poll: 30000 });
  const [selected, setSelected] = useState(null);
  const [showAllEdges, setShowAllEdges] = useState(false);

  // Build lookup maps
  const { nodeMap, inEdges, outEdges } = useMemo(() => {
    if (!data) return { nodeMap: {}, inEdges: {}, outEdges: {} };
    const nm = {};
    const ie = {};
    const oe = {};
    for (const n of data.nodes) {
      nm[n.id] = n;
      ie[n.id] = [];
      oe[n.id] = [];
    }
    for (const e of data.edges) {
      oe[e.from]?.push(e);
      ie[e.to]?.push(e);
    }
    return { nodeMap: nm, inEdges: ie, outEdges: oe };
  }, [data]);

  // Compute canvas bounds
  const viewBox = useMemo(() => {
    if (!data?.nodes?.length) return "0 0 1400 800";
    let maxX = 0, maxY = 0;
    for (const n of data.nodes) {
      maxX = Math.max(maxX, n.x + NODE_W + 40);
      maxY = Math.max(maxY, n.y + NODE_H + 40);
    }
    return `0 0 ${maxX} ${maxY}`;
  }, [data]);

  const connectedEdges = useMemo(() => {
    if (!selected) return new Set();
    const set = new Set();
    for (const e of (outEdges[selected] || [])) set.add(`${e.from}->${e.to}`);
    for (const e of (inEdges[selected] || [])) set.add(`${e.from}->${e.to}`);
    return set;
  }, [selected, outEdges, inEdges]);

  const connectedNodes = useMemo(() => {
    if (!selected) return new Set();
    const set = new Set([selected]);
    for (const e of (outEdges[selected] || [])) set.add(e.to);
    for (const e of (inEdges[selected] || [])) set.add(e.from);
    return set;
  }, [selected, outEdges, inEdges]);

  const handleBgClick = useCallback(() => setSelected(null), []);

  if (loading && !data) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 animate-pulse h-[600px]" />
    );
  }

  if (error) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
        <p className="text-red-400 text-sm">Failed to load architecture: {error}</p>
      </div>
    );
  }

  if (!data) return null;

  const groupColorMap = {};
  for (const g of data.groups) groupColorMap[g.id] = GROUP_COLORS[g.color] || GROUP_COLORS.zinc;

  // Edge path: simple bezier from node center-bottom/top to target
  function edgePath(e) {
    const from = nodeMap[e.from];
    const to = nodeMap[e.to];
    if (!from || !to) return "";
    const fx = from.x + NODE_W / 2;
    const fy = from.y + NODE_H / 2;
    const tx = to.x + NODE_W / 2;
    const ty = to.y + NODE_H / 2;
    const dx = tx - fx;
    const dy = ty - fy;
    const cx = Math.abs(dx) * 0.3;
    const cy = Math.abs(dy) * 0.3;
    return `M ${fx} ${fy} C ${fx + cx} ${fy + cy}, ${tx - cx} ${ty - cy}, ${tx} ${ty}`;
  }

  return (
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex items-center gap-4 text-xs text-zinc-400">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${data.status?.cycle === "running" ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
          <span>Cycle: {data.status?.cycle || "unknown"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${data.status?.redis ? "bg-emerald-400" : "bg-red-400"}`} />
          <span>Redis</span>
        </div>
        <span className="text-zinc-600">|</span>
        <span>{data.moduleCount} modules</span>
        <span>{data.edgeCount} dependencies</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showAllEdges}
              onChange={(e) => setShowAllEdges(e.target.checked)}
              className="w-3 h-3 rounded border-zinc-600 bg-zinc-800 text-emerald-400 focus:ring-0"
            />
            <span>Show all edges</span>
          </label>
        </div>
      </div>

      {/* SVG Diagram */}
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg overflow-auto">
        <svg
          viewBox={viewBox}
          className="w-full min-w-[900px]"
          style={{ minHeight: 600 }}
          onClick={handleBgClick}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#52525b" />
            </marker>
            <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#fbbf24" />
            </marker>
          </defs>

          {/* Group regions */}
          {data.groups.map((g) => {
            const c = GROUP_COLORS[g.color] || GROUP_COLORS.zinc;
            const b = g.bounds;
            if (!b || !b.w) return null;
            return (
              <g key={g.id}>
                <rect
                  x={b.x} y={b.y} width={b.w} height={b.h}
                  rx={12} fill={c.region} stroke={c.stroke} strokeWidth={1} strokeOpacity={0.3}
                />
                <text x={b.x + 12} y={b.y + 16} fill={c.label} fontSize={11} fontWeight={600} opacity={0.8}>
                  {g.label}
                </text>
              </g>
            );
          })}

          {/* Edges */}
          {data.edges.map((e) => {
            const key = `${e.from}->${e.to}`;
            const isConnected = connectedEdges.has(key);
            const visible = showAllEdges || isConnected || !selected;
            return (
              <path
                key={key}
                d={edgePath(e)}
                fill="none"
                stroke={isConnected ? "#fbbf24" : "#3f3f46"}
                strokeWidth={isConnected ? 1.5 : 0.5}
                opacity={!visible ? 0 : isConnected ? 0.7 : (selected ? 0.08 : 0.15)}
                markerEnd={isConnected ? "url(#arrow-active)" : "url(#arrow)"}
                style={{ transition: "opacity 0.2s, stroke 0.2s" }}
              />
            );
          })}

          {/* Nodes */}
          {data.nodes.map((n) => {
            const gc = groupColorMap[n.group] || GROUP_COLORS.zinc;
            const isSelected = selected === n.id;
            const isConnected = connectedNodes.has(n.id);
            const dimmed = selected && !isConnected;
            return (
              <g
                key={n.id}
                onClick={(e) => { e.stopPropagation(); setSelected(isSelected ? null : n.id); }}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={n.x} y={n.y} width={NODE_W} height={NODE_H}
                  rx={6}
                  fill={isSelected ? gc.stroke : gc.fill}
                  fillOpacity={isSelected ? 0.25 : dimmed ? 0.3 : 0.8}
                  stroke={isSelected ? gc.stroke : gc.stroke}
                  strokeWidth={isSelected ? 2 : 1}
                  strokeOpacity={dimmed ? 0.2 : isSelected ? 1 : 0.5}
                  style={{ transition: "all 0.2s" }}
                />
                <text
                  x={n.x + NODE_W / 2} y={n.y + NODE_H / 2 + 1}
                  textAnchor="middle" dominantBaseline="central"
                  fill={isSelected ? "#fff" : gc.text}
                  fontSize={10} fontWeight={isSelected ? 700 : 500}
                  opacity={dimmed ? 0.3 : 1}
                  style={{ transition: "opacity 0.2s", pointerEvents: "none" }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Detail panel */}
      {selected && nodeMap[selected] && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-zinc-100">{nodeMap[selected].label}</h3>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
              {nodeMap[selected].group}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-zinc-500 mb-1">Imports ({outEdges[selected]?.length || 0})</p>
              <div className="space-y-0.5">
                {(outEdges[selected] || []).map((e) => (
                  <button key={e.to} onClick={() => setSelected(e.to)}
                    className="block text-zinc-300 hover:text-white transition-colors">
                    → {nodeMap[e.to]?.label || e.to}
                  </button>
                ))}
                {!outEdges[selected]?.length && <span className="text-zinc-600">none</span>}
              </div>
            </div>
            <div>
              <p className="text-zinc-500 mb-1">Imported by ({inEdges[selected]?.length || 0})</p>
              <div className="space-y-0.5">
                {(inEdges[selected] || []).map((e) => (
                  <button key={e.from} onClick={() => setSelected(e.from)}
                    className="block text-zinc-300 hover:text-white transition-colors">
                    ← {nodeMap[e.from]?.label || e.from}
                  </button>
                ))}
                {!inEdges[selected]?.length && <span className="text-zinc-600">none</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] text-zinc-500">
        {data.groups.map((g) => {
          const c = GROUP_COLORS[g.color] || GROUP_COLORS.zinc;
          return (
            <div key={g.id} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: c.stroke, opacity: 0.7 }} />
              <span>{g.label} ({g.modules.length})</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Architecture Review (existing scorecard) — moved into a tab
// ============================================================

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) meta[key.trim()] = rest.join(":").trim();
  }
  return { meta, body: match[2] };
}

function parseScorecard(body) {
  const match = body.match(/\| #[^\n]*\n\|[-|\s]*\n([\s\S]*?)\n\n/);
  if (!match) return [];
  return match[1].split("\n").filter(Boolean).map((row) => {
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    return {
      num: cells[0],
      name: cells[1],
      score: parseInt(cells[2]?.replace(/\*/g, "") || "0", 10),
      trend: cells[3] || "",
    };
  });
}

function parseSections(body) {
  const parts = body.split(/^## /m).filter(Boolean);
  return parts.map((part) => {
    const lines = part.split("\n");
    const title = lines[0].trim();
    const content = lines.slice(1).join("\n").trim();
    return { title, content };
  });
}

function scoreColor(score) {
  if (score >= 8) return { bg: "bg-emerald-400/10", border: "border-emerald-400/30", text: "text-emerald-400", ring: "ring-emerald-400" };
  if (score >= 6) return { bg: "bg-blue-400/10", border: "border-blue-400/30", text: "text-blue-400", ring: "ring-blue-400" };
  if (score >= 4) return { bg: "bg-amber-400/10", border: "border-amber-400/30", text: "text-amber-400", ring: "ring-amber-400" };
  return { bg: "bg-red-400/10", border: "border-red-400/30", text: "text-red-400", ring: "ring-red-400" };
}

function ScoreRing({ score, size = 48 }) {
  const colors = scoreColor(score);
  const pct = (score / 10) * 100;
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  return (
    <svg width={size} height={size} className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#27272a" strokeWidth={3} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="currentColor"
        className={colors.text}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x={size / 2} y={size / 2} textAnchor="middle" dominantBaseline="central"
        className={`${colors.text} text-xs font-bold`} fill="currentColor">
        {score}
      </text>
    </svg>
  );
}

function ScorecardGrid({ items }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {items.map((item) => {
        const colors = scoreColor(item.score);
        return (
          <div key={item.num} className={`rounded-lg border ${colors.border} ${colors.bg} p-3 flex items-center gap-3`}>
            <ScoreRing score={item.score} size={40} />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-zinc-200 leading-tight truncate">{item.name}</p>
              <p className="text-[10px] text-zinc-500 mt-0.5">{item.trend}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function renderMarkdownLine(line, i) {
  let html = line.replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-100 font-semibold">$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code class="text-zinc-300 bg-zinc-800 px-1 py-0.5 rounded text-[11px]">$1</code>');
  return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
}

function MarkdownBlock({ content }) {
  if (!content) return null;
  const lines = content.split("\n");
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.includes("|") && lines[i + 1]?.match(/^\|[-|\s]+\|$/)) {
      const headerCells = line.split("|").map((c) => c.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i].split("|").map((c) => c.trim()).filter(Boolean));
        i++;
      }
      elements.push(
        <div key={i} className="overflow-x-auto my-3">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-zinc-700">
                {headerCells.map((c, j) => (
                  <th key={j} className="text-left py-2 px-3 text-zinc-400 font-semibold">
                    {renderMarkdownLine(c, j)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-b border-zinc-800/50">
                  {row.map((c, ci) => (
                    <td key={ci} className="py-2 px-3 text-zinc-300">
                      {renderMarkdownLine(c, ci)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={i} className="text-sm font-semibold text-zinc-200 mt-4 mb-2">
          {renderMarkdownLine(line.slice(4), i)}
        </h4>
      );
      i++;
      continue;
    }

    if (line.match(/^- /)) {
      elements.push(
        <div key={i} className="flex gap-2 text-xs text-zinc-400 leading-relaxed ml-1 my-1">
          <span className="text-zinc-600 shrink-0 mt-0.5">&bull;</span>
          <span>{renderMarkdownLine(line.slice(2), i)}</span>
        </div>
      );
      i++;
      continue;
    }

    const numMatch = line.match(/^(\d+)\.\s+(.*)/);
    if (numMatch) {
      elements.push(
        <div key={i} className="flex gap-2 text-xs text-zinc-400 leading-relaxed ml-1 my-1">
          <span className="text-zinc-500 shrink-0 tabular-nums w-4 text-right">{numMatch[1]}.</span>
          <span>{renderMarkdownLine(numMatch[2], i)}</span>
        </div>
      );
      i++;
      continue;
    }

    if (!line.trim()) { i++; continue; }

    elements.push(
      <p key={i} className="text-xs text-zinc-400 leading-relaxed my-2">
        {renderMarkdownLine(line, i)}
      </p>
    );
    i++;
  }

  return <>{elements}</>;
}

function SectionCard({ title, content, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const scoreMatch = title.match(/(\d+)\/10$/);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-zinc-800/50 transition-colors"
      >
        <h3 className="text-sm font-semibold text-zinc-100">{title.replace(/ — \d+\/10$/, "")}</h3>
        <div className="flex items-center gap-3">
          {score !== null && <ScoreRing score={score} size={32} />}
          <svg
            className={`w-4 h-4 text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-zinc-800">
          <MarkdownBlock content={content} />
        </div>
      )}
    </div>
  );
}

function ArchitectureReview() {
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/config/direction/architecture-review`);
        if (res.status === 404) {
          setNotFound(true);
        } else if (res.ok) {
          setRaw(await res.text());
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const { meta, body } = useMemo(() => parseFrontmatter(raw), [raw]);
  const scorecard = useMemo(() => parseScorecard(body), [body]);
  const sections = useMemo(() => parseSections(body), [body]);
  const dimensionSections = sections.filter((s) => s.title.match(/^\d+\./));
  const otherSections = sections.filter((s) => !s.title.match(/^\d+\./) && s.title !== "Scorecard" && !s.title.startsWith("Hydra Architecture"));

  if (loading) return <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 animate-pulse h-96" />;

  if (notFound) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
        <p className="text-zinc-400 text-sm">No architecture review found.</p>
        <p className="text-zinc-600 text-xs mt-2">
          Run <code className="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">/hydra-architect</code> to generate one.
        </p>
      </div>
    );
  }

  const summarySection = sections.find((s) => s.title.startsWith("Executive Summary"));

  return (
    <div className="space-y-6">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex gap-6 items-start">
        {meta.overall_score && (
          <div className="flex flex-col items-center shrink-0">
            <ScoreRing score={parseFloat(meta.overall_score)} size={72} />
            <span className="text-[10px] text-zinc-500 mt-1.5 uppercase tracking-wider">Overall</span>
          </div>
        )}
        {summarySection && (
          <div className="min-w-0 flex-1">
            <MarkdownBlock content={summarySection.content} />
          </div>
        )}
      </div>
      {scorecard.length > 0 && <ScorecardGrid items={scorecard} />}
      {dimensionSections.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-600 px-1">Dimensions</h2>
          {dimensionSections.map((s, i) => (
            <SectionCard key={i} title={s.title} content={s.content} />
          ))}
        </div>
      )}
      {otherSections.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-600 px-1">Analysis</h2>
          {otherSections.map((s, i) => (
            <SectionCard key={i} title={s.title} content={s.content} defaultOpen={s.title.includes("Recommendations") || s.title.includes("Key Findings")} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Main export — tabbed: Diagram | Review
// ============================================================

const TABS = [
  { id: "diagram", label: "Diagram" },
  { id: "review", label: "Review" },
];

export default function Architecture() {
  const [tab, setTab] = useState("diagram");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Architecture</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {tab === "diagram"
              ? "Live module dependency graph — auto-generated from source"
              : "System assessment from config/direction/architecture-review.md"}
          </p>
        </div>
        <div className="flex bg-zinc-800 rounded-lg p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                tab === t.id
                  ? "bg-zinc-700 text-white"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === "diagram" && <ArchitectureDiagram />}
      {tab === "review" && <ArchitectureReview />}
    </div>
  );
}
