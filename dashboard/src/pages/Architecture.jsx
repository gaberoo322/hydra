import { useState, useEffect, useMemo } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "/api";

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
  // Bold
  let html = line.replace(/\*\*(.+?)\*\*/g, '<strong class="text-zinc-100 font-semibold">$1</strong>');
  // Inline code
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

    // Table
    if (line.includes("|") && lines[i + 1]?.match(/^\|[-|\s]+\|$/)) {
      const headerCells = line.split("|").map((c) => c.trim()).filter(Boolean);
      i += 2; // skip header + separator
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

    // H3
    if (line.startsWith("### ")) {
      elements.push(
        <h4 key={i} className="text-sm font-semibold text-zinc-200 mt-4 mb-2">
          {renderMarkdownLine(line.slice(4), i)}
        </h4>
      );
      i++;
      continue;
    }

    // Bullet with bold lead
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

    // Numbered list
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

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
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
  // Extract score from title like "1. Control Loop Quality — 8/10"
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

export default function Architecture() {
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

  // Separate the dimension sections (numbered 1-8) from other sections
  const dimensionSections = sections.filter((s) => s.title.match(/^\d+\./));
  const otherSections = sections.filter((s) => !s.title.match(/^\d+\./) && s.title !== "Scorecard" && !s.title.startsWith("Hydra Architecture"));

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Architecture</h1>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 animate-pulse h-96" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Architecture</h1>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-400 text-sm">No architecture review found.</p>
          <p className="text-zinc-600 text-xs mt-2">
            Run <code className="text-zinc-400 bg-zinc-800 px-1.5 py-0.5 rounded">/hydra-architect</code> to generate one.
          </p>
        </div>
      </div>
    );
  }

  // Find Executive Summary section
  const summarySection = sections.find((s) => s.title.startsWith("Executive Summary"));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Architecture Review</h1>
          <p className="text-sm text-zinc-500 mt-1">
            System assessment from <code className="text-zinc-400">config/direction/architecture-review.md</code>
          </p>
        </div>
        <div className="flex items-center gap-4">
          {meta.date && <span className="text-xs text-zinc-500">{meta.date}</span>}
          {meta.reviewer && (
            <span className="text-[10px] uppercase tracking-wider text-zinc-600 bg-zinc-800 px-2 py-1 rounded">
              {meta.reviewer}
            </span>
          )}
        </div>
      </div>

      {/* Overall score + summary */}
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

      {/* Scorecard grid */}
      {scorecard.length > 0 && <ScorecardGrid items={scorecard} />}

      {/* Dimension details (collapsible) */}
      {dimensionSections.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-600 px-1">Dimensions</h2>
          {dimensionSections.map((s, i) => (
            <SectionCard key={i} title={s.title} content={s.content} />
          ))}
        </div>
      )}

      {/* Other sections (Key Findings, Recommendations, etc.) */}
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
