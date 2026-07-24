import { SkillModelCrossTab } from "./SkillModelCrossTab.jsx";

/**
 * "This week so far" per-model mix line (issue #691).
 *
 * Reads `byModel` (7d window) from `/api/usage` and renders the opus /
 * sonnet / haiku share of total tokens as a headline. The percentages are
 * derived in the view from `byModel[f].total / tokensLast7d.total` so the
 * tracker stays raw-counts-only. When quota-weight calibration is absent we
 * render a neutral chip instead of fabricating numbers — the share math
 * itself does not need calibration, but the chip signals the operator that
 * the weighted Quota-Weight burn figure isn't available yet.
 */
export function WeekModelMix({ usage }) {
  const byModel = usage?.byModel;
  const total = usage?.tokensLast7d?.total ?? 0;

  if (!byModel) return null;

  const pct = (family) => {
    if (total <= 0) return 0;
    return Math.round(((byModel[family]?.total ?? 0) / total) * 100);
  };

  const calibrated = Boolean(usage?.quotaWeightCalibrated);
  const hasUnknown = (byModel.unknown?.total ?? 0) > 0;
  // The quota weights only shape the *estimate* fallback figure; under the
  // OAuth meter the authoritative percentage comes straight from the OAuth
  // usage read, so calibration has no effect and the loud "needs calibration"
  // banner is a false alarm (issue #2405). Suppress it under `oauth` (including
  // a served-stale last-good, which is still `usageSource === "oauth"`) and
  // show a quiet explained state; only surface the loud banner when the
  // transcript estimate is the active source AND the weights are uncalibrated.
  const isOauthSource = usage?.usageSource === "oauth";

  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm uppercase tracking-wide text-zinc-400 mb-1">
            This week so far
          </h2>
          {total > 0 ? (
            <p className="text-lg font-semibold text-zinc-100">
              {pct("opus")}% opus
              <span className="text-zinc-500 mx-2">/</span>
              {pct("sonnet")}% sonnet
              <span className="text-zinc-500 mx-2">/</span>
              {pct("haiku")}% haiku
              {hasUnknown && (
                <>
                  <span className="text-zinc-500 mx-2">/</span>
                  {pct("unknown")}% unknown
                </>
              )}
            </p>
          ) : (
            <p className="text-lg font-semibold text-zinc-500">No tokens recorded yet</p>
          )}
        </div>
        {!calibrated &&
          (isOauthSource ? (
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs whitespace-nowrap bg-zinc-700/20 text-zinc-500 border border-zinc-700/40"
              title="Quota percentages come from the OAuth usage meter, so quota weights don't affect them — calibration isn't needed."
            >
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
              Quota weights inactive under OAuth meter
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm whitespace-nowrap bg-zinc-500/10 text-zinc-300 border border-zinc-500/30">
              <span className="w-2 h-2 rounded-full bg-zinc-400" />
              Quota-weight calibration needed
            </div>
          ))}
      </div>
      <SkillModelCrossTab
        bySkillByModel={usage?.bySkillByModel}
        bySkillWoW={usage?.bySkillWoW}
        byDispatchKind={usage?.byDispatchKind}
        attributedPercent={usage?.attributedPercent}
      />
    </div>
  );
}
