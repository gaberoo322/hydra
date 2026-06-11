/**
 * Badges.jsx — the shared dashboard page-item seam's view half (issue #822).
 * Data-driven chips that read their class strings off the single palette
 * table in lib/page-item-format.ts, replacing the per-component palette
 * dicts that had to be hand-synced when the ramp changed.
 *
 * Each badge is a thin renderer: it maps a value to a class via
 * `paletteClass()` and emits the same `<span>` the list pages used. The
 * markup (px/py/text-size/border/rounded) is byte-identical to what each
 * component rendered before, so chip colours and text are unchanged.
 */
import {
  TIER_PALETTE,
  SOURCE_PALETTE,
  SEVERITY_PALETTE,
  DECISION_SOURCE_PALETTE,
  DECISION_SOURCE_LABEL,
  paletteClass,
  ZINC_DEFAULT,
} from "../../lib/page-item-format.ts";

const CHIP_BASE = "px-1.5 py-0.5 text-[10px] rounded border";

/**
 * TierBadge — the monotonic-ladder tier chip ("T1".."T4", legacy "T0").
 * Renders nothing for null/undefined tiers (matching RecentMerges' guard).
 */
export function TierBadge({ tier }) {
  if (tier === null || tier === undefined) return null;
  return (
    <span className={`${CHIP_BASE} ${paletteClass(TIER_PALETTE, tier)}`}>T{tier}</span>
  );
}

/** SourceBadge — dispatch source chip (autopilot/operator/subagent). */
function SourceBadge({ source }) {
  return (
    <span className={`${CHIP_BASE} shrink-0 ${paletteClass(SOURCE_PALETTE, source)}`}>
      {source}
    </span>
  );
}

/** SeverityBadge — alert severity chip (critical/error/warning/info). */
function SeverityBadge({ severity }) {
  return (
    <span className={`${CHIP_BASE} shrink-0 ${paletteClass(SEVERITY_PALETTE, severity)}`}>
      {severity}
    </span>
  );
}

/**
 * DecisionSourceBadge — operator-attention source chip. Unknown sources
 * fall through to an empty class (NOT zinc), preserving the prior
 * OperatorDecisionQueue behaviour where `SOURCE_STYLE[s] || ""` rendered an
 * unstyled chip rather than a zinc default.
 */
export function DecisionSourceBadge({ source }) {
  return (
    <span className={`${CHIP_BASE} ${paletteClass(DECISION_SOURCE_PALETTE, source, "")}`}>
      {DECISION_SOURCE_LABEL[source] || source}
    </span>
  );
}

/**
 * ClassLabelBadge — the autopilot class label chip (always zinc). Used by
 * RecentMerges; kept here so every list-page chip shares one surface.
 */
export function ClassLabelBadge({ label }) {
  if (!label) return null;
  return <span className={`${CHIP_BASE} ${ZINC_DEFAULT}`}>{label}</span>;
}
