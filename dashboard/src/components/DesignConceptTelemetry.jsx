import { useApi } from "../hooks/useApi.js";

/**
 * Design-concept Phase B telemetry widget (issue #465 / #437).
 *
 * Renders six promotion-criteria chips + min-sample chip + promotion
 * eligibility status, polling /api/design-concepts/telemetry every 60s.
 *
 * Under each RED chip we surface the top-3 entries from
 * `gate_fail_reasons` and `operator_override_reasons` so an operator
 * can see WHICH gate-check is failing, not just that gate-pass-rate is
 * low. (Counters are populated by B-1 (#466) and the hydra-grill
 * SKILL.md per-skill; this widget is observation-only.)
 */
export default function DesignConceptTelemetry() {
  const { data, error } = useApi("/design-concepts/telemetry", { poll: 60_000 });

  // Note: the file is .jsx, not .tsx as the issue body suggested — the
  // dashboard is plain React/JS (see `dashboard/src/components/*.jsx`),
  // so we follow repo convention. The naming is otherwise unchanged.
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-400">
          Design-Concept Telemetry (Phase B)
        </h2>
        {data?.window_days && (
          <span className="text-xs text-zinc-500">
            rolling {data.window_days}d window
          </span>
        )}
      </div>

      {error ? (
        <p className="text-sm text-zinc-600 py-6 text-center">
          telemetry unavailable ({error})
        </p>
      ) : !data ? (
        <p className="text-sm text-zinc-600 py-6 text-center">loading…</p>
      ) : (
        <>
          <PromotionBar eligibility={data.promotion_eligibility} />

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-4">
            {orderedCriteria(data.criteria).map(([name, c]) => (
              <CriterionChip
                key={name}
                name={name}
                value={c.value}
                threshold={c.threshold}
                status={c.status}
                diagnostics={
                  c.status === "red"
                    ? topDiagnostics(name, data.diagnostics)
                    : null
                }
              />
            ))}
            <CriterionChip
              key="min_sample"
              name="min_sample"
              value={data.min_sample.value}
              threshold={data.min_sample.threshold}
              status={data.min_sample.status}
              diagnostics={null}
            />
          </div>
        </>
      )}
    </div>
  );
}

const CRITERION_ORDER = [
  "artifact_rate",
  "gate_pass_rate",
  "handoff_rate_per_day",
  "median_qa_trace",
  "dev_pr_latency_ratio",
  "exempt_rate",
];

function orderedCriteria(criteria) {
  if (!criteria || typeof criteria !== "object") return [];
  return CRITERION_ORDER.filter((n) => n in criteria).map((n) => [
    n,
    criteria[n],
  ]);
}

const STATUS_COLOR = {
  green: { bg: "bg-emerald-950/60", border: "border-emerald-700", text: "text-emerald-300" },
  yellow: { bg: "bg-amber-950/60", border: "border-amber-700", text: "text-amber-300" },
  red: { bg: "bg-red-950/60", border: "border-red-700", text: "text-red-300" },
};

function CriterionChip({ name, value, threshold, status, diagnostics }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.red;
  return (
    <div className={`border ${c.border} ${c.bg} rounded p-2`}>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-zinc-400 font-mono">{name}</span>
        <span className={`text-xs ${c.text} uppercase font-semibold`}>{status}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-lg ${c.text} font-semibold tabular-nums`}>
          {formatValue(name, value)}
        </span>
        <span className="text-[10px] text-zinc-500">
          / threshold {formatValue(name, threshold)}
        </span>
      </div>
      {diagnostics && diagnostics.length > 0 && (
        <ul className="mt-2 text-[10px] text-zinc-500 space-y-0.5">
          {diagnostics.map(([label, count]) => (
            <li key={label} className="flex justify-between gap-2 truncate">
              <span className="truncate">{label}</span>
              <span className="text-zinc-400 tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PromotionBar({ eligibility }) {
  if (!eligibility) return null;
  const { ready, consecutive_green_days, blocking_criteria, estimated_ready_date } =
    eligibility;
  if (ready) {
    return (
      <div className="border border-emerald-600 bg-emerald-950/60 rounded p-2 text-sm text-emerald-200">
        Ready: file Phase C epic ({consecutive_green_days}/3 green days).
      </div>
    );
  }
  if (blocking_criteria && blocking_criteria.length > 0) {
    return (
      <div className="border border-amber-700 bg-amber-950/60 rounded p-2 text-xs text-amber-200">
        Blocked on: {blocking_criteria.join(", ")} ({consecutive_green_days}/3 green days)
      </div>
    );
  }
  if (estimated_ready_date) {
    return (
      <div className="border border-zinc-700 bg-zinc-950 rounded p-2 text-xs text-zinc-300">
        Phase C eligible {estimated_ready_date} ({consecutive_green_days}/3 green days)
      </div>
    );
  }
  return (
    <div className="border border-zinc-700 bg-zinc-950 rounded p-2 text-xs text-zinc-400">
      {consecutive_green_days}/3 green days
    </div>
  );
}

function topDiagnostics(criterionName, diagnostics) {
  if (!diagnostics) return null;
  // For gate-pass-rate failures, the gate_fail_reasons HASH has the
  // most signal — it tells the operator WHICH gate-check rule is
  // tripping. operator_override_reasons reinforces with "and the
  // operator overrode it for these reasons".
  const sources = [
    diagnostics.gate_fail_reasons || {},
    diagnostics.operator_override_reasons || {},
  ];
  const merged = {};
  for (const src of sources) {
    for (const [k, v] of Object.entries(src)) {
      merged[k] = (merged[k] || 0) + (Number(v) || 0);
    }
  }
  const top = Object.entries(merged)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return top.length > 0 ? top : null;
  // criterionName intentionally unused here — Phase B exposes the
  // shared diagnostics under every red chip. Phase C may filter
  // by criterion once auto-promotion logic lands.
}

function formatValue(name, v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  // Rates render as percentages; trace + sample render as integers;
  // latency-ratio renders with 2 decimal places.
  const pctNames = ["artifact_rate", "gate_pass_rate", "exempt_rate"];
  if (pctNames.includes(name)) {
    return `${Math.round(Number(v) * 100)}%`;
  }
  if (name === "median_qa_trace" || name === "min_sample") {
    return String(Math.round(Number(v)));
  }
  if (name === "handoff_rate_per_day" || name === "dev_pr_latency_ratio") {
    return Number(v).toFixed(2);
  }
  return String(v);
}
