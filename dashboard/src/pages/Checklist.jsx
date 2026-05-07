import { useState } from "react";
import { useApi } from "../hooks/useApi.js";

const SEVERITY_STYLES = {
  critical: { bg: "bg-red-500/10", border: "border-red-500/30", dot: "bg-red-400", text: "text-red-400" },
  warning: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", dot: "bg-yellow-400", text: "text-yellow-400" },
  info: { bg: "bg-blue-500/10", border: "border-blue-500/30", dot: "bg-blue-400", text: "text-blue-400" },
};

const CATEGORY_LABELS = {
  "system-health": "System Health",
  "backlog-hygiene": "Backlog Hygiene",
  "strategic-review": "Strategic Review",
  "target-project": "Target Project",
};

const CATEGORY_ICONS = {
  "system-health": "M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z",
  "backlog-hygiene": "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
  "strategic-review": "M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z",
  "target-project": "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h6m-6 4h6m-6 4h3",
};

function ChecklistItem({ item, dismissed, onDismiss }) {
  const style = SEVERITY_STYLES[item.severity];

  return (
    <div className={`${style.bg} border ${style.border} rounded-lg p-4 transition-all ${dismissed ? "opacity-40" : ""}`}>
      <div className="flex items-start gap-3">
        <button
          onClick={() => onDismiss(item.id)}
          className={`mt-0.5 w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
            dismissed
              ? "bg-zinc-600 border-zinc-600"
              : `border-zinc-600 hover:border-zinc-400`
          }`}
        >
          {dismissed && (
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-2 h-2 rounded-full ${style.dot}`} />
            <span className={`text-sm font-medium ${dismissed ? "text-zinc-500 line-through" : "text-zinc-200"}`}>
              {item.title}
            </span>
          </div>
          <p className="text-xs text-zinc-400 mb-2 line-clamp-2">{item.description}</p>
          {!dismissed && (
            <ActionButton action={item.action} />
          )}
        </div>
      </div>
    </div>
  );
}

function ActionButton({ action }) {
  if (action.type === "dashboard") {
    return (
      <a
        href={action.target}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
        {action.label}
      </a>
    );
  }

  // Skill or link — show as copyable command
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
      {action.target}
    </span>
  );
}

function SkillReference({ skills }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-8">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-medium text-zinc-300 hover:text-white transition-colors"
      >
        <svg
          className={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Skill Reference Guide
      </button>

      {expanded && (
        <div className="mt-4 space-y-6">
          {skills.map((category) => (
            <div key={category.category}>
              <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500 mb-2">
                {category.category}
              </h4>
              <div className="space-y-1">
                {category.skills.map((skill) => (
                  <div key={skill.name} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
                    <div className="flex items-baseline gap-3">
                      <code className="text-sm font-mono text-emerald-400 whitespace-nowrap">{skill.name}</code>
                      <span className="text-xs text-zinc-400">{skill.description}</span>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1">When: {skill.when}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
      <svg className="w-12 h-12 text-emerald-400 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="text-zinc-300 font-medium">All clear</p>
      <p className="text-sm text-zinc-500 mt-1">No items need your attention right now.</p>
    </div>
  );
}

export default function Checklist() {
  const { data, loading, error, refresh } = useApi("/checklist", { poll: 60000 });
  const [dismissed, setDismissed] = useState(() => {
    try {
      const stored = localStorage.getItem("hydra-checklist-dismissed");
      if (!stored) return {};
      const parsed = JSON.parse(stored);
      // Expire dismissals after 24h
      const now = Date.now();
      const filtered = {};
      for (const [id, ts] of Object.entries(parsed)) {
        if (now - ts < 24 * 60 * 60 * 1000) filtered[id] = ts;
      }
      return filtered;
    } catch { return {}; }
  });

  function toggleDismiss(id) {
    setDismissed((prev) => {
      const next = { ...prev };
      if (next[id]) {
        delete next[id];
      } else {
        next[id] = Date.now();
      }
      localStorage.setItem("hydra-checklist-dismissed", JSON.stringify(next));
      return next;
    });
  }

  if (loading && !data) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-zinc-800 rounded w-48" />
          <div className="h-24 bg-zinc-800 rounded" />
          <div className="h-24 bg-zinc-800 rounded" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
          Failed to load checklist: {error}
        </div>
      </div>
    );
  }

  const items = data?.items || [];
  const skills = data?.skills || [];

  // Group by category
  const grouped = {};
  for (const item of items) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  }

  const categoryOrder = ["system-health", "backlog-hygiene", "strategic-review", "target-project"];
  const activeCount = items.filter((i) => !dismissed[i.id]).length;

  return (
    <div className="p-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Operator Checklist</h2>
          <p className="text-sm text-zinc-400 mt-1">
            {activeCount > 0
              ? `${activeCount} item${activeCount > 1 ? "s" : ""} need${activeCount === 1 ? "s" : ""} attention`
              : "All clear"}
            {data?.generatedAt && (
              <span className="text-zinc-600 ml-2">
                Updated {new Date(data.generatedAt).toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={refresh}
          className="text-zinc-400 hover:text-white transition-colors p-2 rounded-lg hover:bg-zinc-800"
          title="Refresh"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {/* Checklist items grouped by category */}
      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">
          {categoryOrder.map((cat) => {
            const catItems = grouped[cat];
            if (!catItems || catItems.length === 0) return null;

            return (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-3">
                  <svg className="w-4 h-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={CATEGORY_ICONS[cat]} />
                  </svg>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                    {CATEGORY_LABELS[cat]}
                  </h3>
                </div>
                <div className="space-y-2">
                  {catItems.map((item) => (
                    <ChecklistItem
                      key={item.id}
                      item={item}
                      dismissed={!!dismissed[item.id]}
                      onDismiss={toggleDismiss}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Skill reference */}
      <SkillReference skills={skills} />
    </div>
  );
}
