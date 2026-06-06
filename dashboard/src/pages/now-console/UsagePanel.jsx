import { useApi } from "../../hooks/useApi.js";
import {
  classifyPace,
  flattenAttribution,
  formatPercent,
  formatRatio,
  formatTokens,
} from "./console-state.ts";

/**
 * UsagePanel — quota / pacing drill-down (issue #891, now-console-4).
 *
 * Replaces the dead $0 cost framing (retired in #885/#704) with the live
 * quota surface from /api/usage/eligibility:
 *   - 5h burn vs the emergency-stop (5h quota) line + throttle-risk gauge
 *   - weekly pace curve: sinceReset% vs target% with ahead/on/behind
 *   - per-skill/per-model attribution from bySkillByModel
 *   - cache-hit efficiency (cacheHitRatioLast5h)
 *
 * No dollar metric anywhere — acceptance criterion #3.
 *
 * Source badge (issue #1083): `percentLast5h`/`percentLast7d` are now backed by
 * the authoritative OAuth `/api/oauth/usage` meter when it reads successfully.
 * `usage.usageSource` reports `"oauth"` (ground truth) vs `"estimate"` (the
 * transcript+calibration fallback used when the meter read fails / the token
 * expired). The badge surfaces which one is live so the operator can tell a
 * ground-truth number from the ~2x-wrong fallback guess during an outage.
 */

const PACE_STYLE = {
  ahead: { chip: "bg-amber-500/10 text-amber-300 border-amber-500/40", label: "ahead of pace" },
  on: { chip: "bg-emerald-500/10 text-emerald-300 border-emerald-500/40", label: "on pace" },
  behind: { chip: "bg-sky-500/10 text-sky-300 border-sky-500/40", label: "behind pace (headroom)" },
};

function Gauge({ label, value, max, testid, danger }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const barColor = danger && pct >= 80 ? "bg-rose-400" : pct >= 60 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div data-testid={testid}>
      <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
        <span>{label}</span>
        <span className="font-mono text-zinc-300">{formatPercent(pct)}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function UsagePanel() {
  const { data, loading } = useApi("/usage/eligibility", { poll: 30_000 });
  const usage = data?.usage ?? {};

  const percent5h = Number(usage.percentLast5h ?? 0);
  const tokens5h = Number(usage.tokensLast5h?.total ?? 0);
  const quota5h = Number(usage.fiveHourQuotaTokens ?? 0);
  const sinceReset = Number(
    usage.percentSinceReset ?? data?.sinceResetPercent ?? 0,
  );
  const targetPercent = Number(data?.targetPercent ?? usage.percentLast7d ?? 0);
  const paceVerdict = classifyPace(sinceReset, targetPercent);
  const pace = PACE_STYLE[paceVerdict] ?? PACE_STYLE.on;
  const cacheHit = Number(usage.cacheHitRatioLast5h ?? 0);
  const emergencyStop = Boolean(usage.emergencyStop);
  // Source of the headline percents (issue #1083): "oauth" = authoritative
  // meter, "estimate" = transcript+calibration fallback (meter read failed /
  // token expired). Default to "estimate" defensively for an older snapshot
  // shape that predates the field.
  const usageSource = usage.usageSource === "oauth" ? "oauth" : "estimate";
  const oauthError = usage.oauthError ?? null;

  const attribution = flattenAttribution(usage.bySkillByModel).slice(0, 6);

  return (
    <section
      data-testid="usage-panel"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Quota &amp; pacing</h2>
          {usageSource === "oauth" ? (
            <span
              data-testid="usage-source"
              data-source="oauth"
              title="Headline backed by the authoritative OAuth /usage meter"
              className="text-[10px] rounded px-1.5 py-0.5 bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
            >
              live meter
            </span>
          ) : (
            <span
              data-testid="usage-source"
              data-source="estimate"
              title={`OAuth meter unavailable${oauthError ? ` (${oauthError})` : ""}; showing transcript estimate (may read ~2x off)`}
              className="text-[10px] rounded px-1.5 py-0.5 bg-amber-500/10 text-amber-300 border border-amber-500/30"
            >
              estimate (fallback)
            </span>
          )}
        </div>
        {emergencyStop && (
          <span
            data-testid="emergency-stop-flag"
            className="text-[11px] rounded px-2 py-0.5 bg-rose-500/15 text-rose-300 border border-rose-500/40"
          >
            EMERGENCY STOP engaged
          </span>
        )}
      </div>

      {loading && !data ? (
        <p className="text-xs text-zinc-500 italic">Loading usage…</p>
      ) : (
        <>
          {/* 5h burn vs emergency-stop line */}
          <div className="space-y-2">
            <Gauge
              label="5h burn vs emergency-stop line"
              value={percent5h}
              max={100}
              danger
              testid="burn-5h-gauge"
            />
            <p className="text-[11px] text-zinc-500 font-mono">
              {formatTokens(tokens5h)} / {formatTokens(quota5h)} tokens in the last 5h
            </p>
          </div>

          {/* Weekly pace curve */}
          <div data-testid="weekly-pace" className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-400">Weekly pace</span>
              <span
                data-testid="pace-verdict"
                data-pace={paceVerdict}
                className={`text-[11px] rounded px-2 py-0.5 border ${pace.chip}`}
              >
                {pace.label}
              </span>
            </div>
            <div className="relative h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-indigo-400"
                style={{ width: `${Math.min(100, sinceReset)}%` }}
              />
              {/* even-pace target marker */}
              <div
                className="absolute top-0 h-full w-0.5 bg-zinc-100"
                style={{ left: `${Math.min(100, targetPercent)}%` }}
                aria-hidden
                title="even-pace target"
              />
            </div>
            <p className="text-[11px] text-zinc-500 font-mono">
              since reset {formatPercent(sinceReset)} · target {formatPercent(targetPercent)}
            </p>
          </div>

          {/* Cache-hit efficiency */}
          <div data-testid="cache-hit" className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-400">Cache-hit efficiency (5h)</span>
            <span className="font-mono text-zinc-200">{formatRatio(cacheHit)}</span>
          </div>

          {/* Per-skill / per-model attribution */}
          <div data-testid="attribution">
            <div className="text-[11px] text-zinc-400 mb-1">Attribution (skill × model)</div>
            {attribution.length === 0 ? (
              <p className="text-[11px] text-zinc-500 italic">No attributed usage yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {attribution.map((r) => (
                  <li
                    key={`${r.skill}:${r.model}`}
                    data-testid="attribution-row"
                    className="flex items-center justify-between text-[11px] font-mono"
                  >
                    <span className="text-zinc-300 truncate">
                      {r.skill} <span className="text-zinc-500">· {r.model}</span>
                    </span>
                    <span className="text-zinc-400">{formatTokens(r.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
