import { useApi } from "../../../hooks/useApi.js";
import { Section } from "./Section.jsx";

/**
 * CostByClass — per-class token attribution (issue #1439).
 *
 * Reads `GET /api/metrics/cost-by-class` (today UTC) and renders a stacked
 * bar of the share of subagent token spend per autopilot dispatch class:
 * research / dev-orch / dev-target / qa / cleanup / retro / other. Answers
 * the operator question "what fraction of today's budget does research vs dev
 * vs QA consume?" — the per-class granularity the daily token counter alone
 * could not give.
 *
 * Token-based (not dollar): the orchestrator runs on a Claude Code
 * subscription, so spend is measured in tokens. The fraction is the class's
 * share of the day's total; bar widths are proportional. Polls every 5min to
 * match the Outcomes page cadence.
 */

// Stable display order + colour per class. `other` last and muted.
const CLASS_DISPLAY = [
  { key: "research", label: "Research", color: "bg-sky-500", text: "text-sky-300" },
  { key: "dev-orch", label: "Dev (orch)", color: "bg-emerald-500", text: "text-emerald-300" },
  { key: "dev-target", label: "Dev (target)", color: "bg-teal-500", text: "text-teal-300" },
  { key: "qa", label: "QA", color: "bg-amber-500", text: "text-amber-300" },
  { key: "cleanup", label: "Cleanup", color: "bg-violet-500", text: "text-violet-300" },
  { key: "retro", label: "Retro", color: "bg-rose-500", text: "text-rose-300" },
  { key: "other", label: "Other", color: "bg-zinc-500", text: "text-zinc-300" },
];

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function CostByClass() {
  const { data, error, loading } = useApi(`/metrics/cost-by-class`, { poll: 5 * 60_000 });

  const total = typeof data?.totalTokens === "number" ? data.totalTokens : 0;
  const byClass = data?.byClass || null;

  return (
    <Section
      title="Cost by class"
      subtitle="Share of today's subagent token spend per dispatch class. Identify which class is driving cost."
      right={data?.date && `${data.date} · ${fmtTokens(total)} tok`}
      loading={loading}
      error={error}
      empty={!loading && !error && (!byClass || total === 0)}
      emptyMessage="No subagent token spend recorded yet today."
    >
      {byClass && total > 0 && (
        <div className="space-y-4">
          {/* Stacked proportional bar */}
          <div className="flex h-6 w-full overflow-hidden rounded-md border border-zinc-700">
            {CLASS_DISPLAY.map(({ key, color, label }) => {
              const entry = byClass[key];
              const pct = entry && total > 0 ? (entry.tokens / total) * 100 : 0;
              if (pct <= 0) return null;
              return (
                <div
                  key={key}
                  className={color}
                  style={{ width: `${pct}%` }}
                  title={`${label}: ${pct.toFixed(1)}% (${fmtTokens(entry.tokens)} tok)`}
                />
              );
            })}
          </div>

          {/* Per-class legend rows */}
          <div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
            {CLASS_DISPLAY.map(({ key, label, color, text }) => {
              const entry = byClass[key] || { tokens: 0, fraction: 0 };
              const pct = total > 0 ? (entry.tokens / total) * 100 : 0;
              return (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 bg-zinc-900/40 rounded-md border border-zinc-700 px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-block h-3 w-3 rounded-sm ${color} shrink-0`} />
                    <span className="text-sm text-zinc-100 truncate">{label}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <span className={`text-sm font-mono ${text}`}>{pct.toFixed(1)}%</span>
                    <span className="text-[10px] text-zinc-500 ml-2">{fmtTokens(entry.tokens)} tok</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Section>
  );
}
