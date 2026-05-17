import { useApi } from "../hooks/useApi.js";

/**
 * Daily spend surrogate widget (issue #394).
 *
 * After PR-3 (#383) deleted codex-runner.ts, the legacy `recordSpend`
 * writer stopped feeding the daily-spend cap and cost dashboard for
 * code-writing work. This widget surfaces the post-cut surrogate built
 * from autopilot subagent token totals via `GET /api/metrics/cost`, and
 * clearly labels the data source so the operator never mistakes a
 * surrogate for true billed spend.
 *
 * Three source states are surfaced:
 *
 *   - `none` — no writer has data today (early-morning before any
 *     dispatch; or surrogate writer not yet wired in).
 *   - `autopilot-surrogate` — only the new token-based surrogate has data.
 *     Shown in amber: the dollar figure depends on the operator-set
 *     `HYDRA_TOKEN_USD_RATE`. If that rate is 0 (the default), the dollar
 *     value is exactly $0.00 by design — operators must opt in to a rate
 *     they actually trust.
 *   - `codex-recorded` — only the legacy reader has data (research-loop
 *     spend writes to it via scheduler.ts). Shown in zinc/neutral.
 *   - `mixed` — both writers contributed; surrogate dollar amount is
 *     summed with the legacy figure.
 */
export default function CostWidget() {
  const { data } = useApi("/metrics/cost");

  if (!data) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-zinc-400 mb-4">Daily Spend</h2>
        <p className="text-sm text-zinc-600 py-8 text-center">Loading…</p>
      </div>
    );
  }

  const source = data.source || "none";
  const tokens = Number(data.tokens) || 0;
  const ratePerMillion = Number(data.ratePerMillion) || 0;
  const costUsd = Number(data.costUsd) || 0;
  const legacyUsd = Number(data.legacyRecordSpendUsd) || 0;
  const totalDisplayedUsd = costUsd + legacyUsd;
  const bySkill = Array.isArray(data.bySkill) ? data.bySkill : [];

  const isSurrogate = source === "autopilot-surrogate" || source === "mixed";
  const showRateNotConfigured = isSurrogate && ratePerMillion === 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-zinc-400">Daily Spend</h2>
        <SourceBadge source={source} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4 text-xs">
        <Counter
          label="Date"
          value={data.date || "—"}
          tint="zinc"
        />
        <Counter
          label="Subagent tokens"
          value={fmtTokens(tokens)}
          tint={tokens > 0 ? "amber" : "zinc"}
        />
        <Counter
          label="Surrogate USD"
          value={fmtUsd(costUsd)}
          tint={costUsd > 0 ? "amber" : "zinc"}
        />
        <Counter
          label="Legacy recordSpend USD"
          value={fmtUsd(legacyUsd)}
          tint={legacyUsd > 0 ? "sky" : "zinc"}
        />
      </div>

      {showRateNotConfigured && (
        <div className="bg-amber-950/40 border border-amber-900/60 text-amber-200 text-xs rounded p-2 mb-3">
          <strong>HYDRA_TOKEN_USD_RATE</strong> is not configured (default 0). Token totals are shown but
          dollar conversion is intentionally $0 until the operator sets a USD-per-million-tokens rate
          they trust. Surrogate cap behavior is disabled while the rate is 0.
        </div>
      )}

      {source === "none" && (
        <p className="text-xs text-zinc-500 py-2">
          No spend data for today yet. The autopilot writes tokens via <code>POST /api/metrics/tokens</code>
          on subagent reap; the legacy scheduler writes USD via the research-loop path.
        </p>
      )}

      {totalDisplayedUsd > 0 && (
        <p className="text-xs text-zinc-500 mb-2">
          Combined total: <span className="text-zinc-200 tabular-nums">{fmtUsd(totalDisplayedUsd)}</span>
          {ratePerMillion > 0 && (
            <span className="ml-2 text-zinc-600">
              · rate ${ratePerMillion.toFixed(2)}/1M tokens
            </span>
          )}
        </p>
      )}

      {bySkill.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold text-zinc-500 mb-2">By skill (today)</h3>
          <ul className="space-y-2">
            {bySkill.map((s) => (
              <li key={s.skill}>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-zinc-200">{s.skill}</span>
                  <span className="text-zinc-500 tabular-nums">
                    {fmtTokens(s.tokens)} tokens · {fmtUsd(s.costUsd)} ({s.pct}%)
                  </span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded mt-1 overflow-hidden">
                  <div className="h-full bg-amber-500" style={{ width: `${Math.max(s.pct, 2)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SourceBadge({ source }) {
  const cfg = SOURCE_BADGE[source] || SOURCE_BADGE.none;
  return (
    <span
      className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${cfg.cls}`}
      title={cfg.title}
    >
      {cfg.label}
    </span>
  );
}

const SOURCE_BADGE = {
  "autopilot-surrogate": {
    label: "surrogate",
    cls: "bg-amber-950/40 text-amber-300 border-amber-900/60",
    title: "Dollar figure derived from autopilot subagent tokens × HYDRA_TOKEN_USD_RATE. Not real billed spend.",
  },
  "codex-recorded": {
    label: "recorded",
    cls: "bg-sky-950/40 text-sky-300 border-sky-900/60",
    title: "Dollar figure written by scheduler.recordSpend (research loop / pre-cut codex).",
  },
  mixed: {
    label: "mixed",
    cls: "bg-emerald-950/40 text-emerald-300 border-emerald-900/60",
    title: "Both writers contributed — surrogate + legacy recordSpend.",
  },
  none: {
    label: "no data",
    cls: "bg-zinc-950 text-zinc-500 border-zinc-800",
    title: "No daily spend recorded yet.",
  },
};

function Counter({ label, value, tint }) {
  const tintCls =
    tint === "amber"
      ? "text-amber-300"
      : tint === "sky"
      ? "text-sky-300"
      : "text-zinc-200";
  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1">
      <p className="text-zinc-500 uppercase tracking-wider text-[10px]">{label}</p>
      <p className={`${tintCls} font-semibold tabular-nums`}>{value}</p>
    </div>
  );
}

function fmtUsd(v) {
  const n = Number(v) || 0;
  if (n === 0) return "$0.00";
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v === 0) return "0";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}
