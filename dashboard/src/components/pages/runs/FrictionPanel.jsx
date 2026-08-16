import { useApi } from "../../../hooks/useApi.js";
import { usePageItems } from "../../../hooks/usePageItems.js";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * FrictionPanel — the friction content absorbed from the retired Explore ›
 * Friction tab (issue #4009, ADR-0034 §3: "Explore's four live tabs are
 * folded, not deleted: Friction and Behavior → /runs").
 *
 * Two sources, deliberately different seams (design-concept a4cc4156, INV-7):
 *
 *   PRIMARY LIST — GET /explore/friction through usePageItems. The endpoint
 *   is fully trust-converted (generatedAt + scanned + sourcesOk), so the
 *   whole panel state machine rides the shared alpha seam: an unproven read
 *   renders UNKNOWN, a partial failure (sourcesOk === false) renders UNKNOWN
 *   even with rows present, and the as-of age is always visible.
 *
 *   SECONDARY STRIP — GET /learning/friction-patterns as a plain useApi
 *   summary of TOTALS (patterns per skill + demotion count). NEVER forced
 *   through usePageItems: that endpoint emits no generatedAt, so the trust
 *   machine would classify it unknown forever (rule 4). Totals are a derived
 *   count, not an observed current value — the strip claims no as-of and
 *   renders nothing but numbers it can decompose.
 *
 * Anti-scope: no trends, no hit-count sparklines — a pattern's hitCount is
 * shown as the observed integer, next to the promotion threshold it is
 * measured against.
 */

function SeverityChip({ severity }) {
  const cls =
    severity === "reinforce"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
      : "bg-amber-500/10 text-amber-300 border-amber-500/30";
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}>
      {severity}
    </span>
  );
}

/** The secondary strip: observed totals, no as-of claim, no list rendering. */
function FrictionTotalsStrip() {
  const { data } = useApi("/learning/friction-patterns", { poll: 5 * 60_000 });
  if (!data || typeof data !== "object") {
    return (
      <p data-testid="friction-totals" className="text-xs text-zinc-500">
        friction-pattern totals: <span className="text-zinc-400">UNKNOWN</span>
      </p>
    );
  }
  const skills = Object.keys(data).filter((k) => k !== "lastDemotionCount" && k !== "totalPatterns");
  const parts = skills.map((skill) => `${skill}: ${Array.isArray(data[skill]) ? data[skill].length : 0}`);
  return (
    <p data-testid="friction-totals" className="text-xs text-zinc-500 font-mono">
      derived totals · {data.totalPatterns ?? 0} patterns across {skills.length} skills
      {parts.length > 0 ? ` (${parts.join(", ")})` : ""}
      {typeof data.lastDemotionCount === "number" ? ` · demotions: ${data.lastDemotionCount}` : ""}
    </p>
  );
}

export default function FrictionPanel() {
  const { items, data, status } = usePageItems("/explore/friction", {
    itemsKey: "bySkill",
    freshnessMs: 60 * 60 * 1000,
    poll: 60_000,
  });

  const unknown = status === "loading" || status === "unknown";
  const stale = status === "stale";
  const candidates = Array.isArray(data?.thresholdCandidates) ? data.thresholdCandidates : [];
  const meta = Array.isArray(data?.recentMetaFrictionIssues) ? data.recentMetaFrictionIssues : [];

  return (
    <section data-testid="friction-panel" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">
          Friction{" "}
          <span className="text-zinc-600">
            (promotion at {typeof data?.promotionThreshold === "number" ? data.promotionThreshold : "—"} hits)
          </span>
        </h2>
        <div className="text-xs text-zinc-500">
          {stale && <span className="text-amber-400">stale · </span>}
          as of <LocalTimestamp ts={data?.generatedAt} stale={stale} />
        </div>
      </div>

      <FrictionTotalsStrip />

      {unknown ? (
        <div
          data-testid="friction-unknown"
          className="border border-zinc-700 rounded-md px-4 py-6 text-center text-sm text-zinc-400 bg-zinc-900/40"
        >
          UNKNOWN — friction read unproven (fetch failed, partial sources, or no as-of timestamp).
        </div>
      ) : status === "empty" ? (
        <div
          data-testid="friction-empty"
          className="border border-zinc-800 rounded-md px-4 py-6 text-center text-sm text-zinc-500 bg-zinc-900/30"
        >
          No friction patterns recorded.
        </div>
      ) : (
        <div className="space-y-4">
          {candidates.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
                Near promotion ({candidates.length})
              </h3>
              <ul className="divide-y divide-zinc-800/60">
                {candidates.map((p) => (
                  <li
                    key={`${p.skill}-${p.cue}`}
                    className="py-1.5 flex items-center gap-2"
                    data-testid="friction-candidate"
                  >
                    <span className="text-xs text-zinc-500 shrink-0 w-28 truncate">{p.skill}</span>
                    <span className="flex-1 min-w-0 text-sm text-zinc-100 truncate" title={p.cue}>
                      {p.cue}
                    </span>
                    <SeverityChip severity={p.severity} />
                    <span className="text-xs text-amber-300 shrink-0 font-mono">
                      {p.hitCount}/{p.hitCount + p.hitsToPromotion}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {meta.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
                Recent meta-friction issues ({meta.length})
              </h3>
              <ul className="divide-y divide-zinc-800/60">
                {meta.map((m) => (
                  <li key={`meta-${m.number}`} className="py-1.5">
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-zinc-100 hover:text-amber-300"
                    >
                      <span className="text-zinc-500 mr-1">#{m.number}</span>
                      {m.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-3">
            {items.map((group) => (
              <div key={group.skill} className="bg-zinc-900/30 rounded border border-zinc-700/50 p-3">
                <h3 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
                  {group.skill}
                  <span className="ml-2 text-zinc-600">({group.patterns.length})</span>
                </h3>
                <ul className="divide-y divide-zinc-800/60">
                  {group.patterns.map((p) => (
                    <li key={`${group.skill}-${p.cue}`} className="py-1 flex items-center gap-2">
                      <span className="flex-1 min-w-0 text-sm text-zinc-200 truncate" title={p.cue}>
                        {p.cue}
                      </span>
                      <SeverityChip severity={p.severity} />
                      {p.promoted && (
                        <span className="text-[10px] uppercase px-1.5 py-0.5 rounded border bg-violet-500/10 text-violet-300 border-violet-500/30">
                          promoted
                        </span>
                      )}
                      <span className="text-xs text-zinc-400 shrink-0 font-mono">{p.hitCount}x</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
