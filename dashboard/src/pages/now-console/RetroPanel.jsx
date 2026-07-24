import { useApi } from "../../hooks/useApi.js";
import LocalTimestamp from "../../components/LocalTimestamp.jsx";

/**
 * RetroPanel — recent persisted retrospectives (issue #921, retro-4 of epic
 * #917).
 *
 * Renders the durable retro artifacts from /api/autopilot/retros (the
 * #921 read endpoint over the `redis/retro` artifact store), newest-first.
 * Each row shows the run the retrospective analysed, its findings (with the
 * per-gotcha recurrence count that gates the conservative emit policy), and
 * the issue/PR refs the retrospective produced — so the operator can audit
 * what each retrospective concluded and acted on over time.
 *
 * Grafts onto the /now Console (#891) alongside StuckSignals: the Console is
 * the autopilot-diagnostics surface, and "what did the last retrospective
 * conclude" is the audit complement to "what is stuck right now".
 */

const GH_REPO = "gaberoo322/hydra";

function RefBadge({ ref }) {
  const url = `https://github.com/${GH_REPO}/${ref.kind === "pr" ? "pull" : "issues"}/${ref.number}`;
  const tone =
    ref.kind === "pr"
      ? "text-violet-300 bg-violet-500/10"
      : "text-sky-300 bg-sky-500/10";
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      data-testid="retro-emitted-ref"
      data-kind={ref.kind}
      className={`text-[10px] rounded px-1.5 py-0.5 font-mono ${tone} hover:underline`}
      title={ref.title || ""}
    >
      {ref.kind === "pr" ? "PR" : "#"}
      {ref.number}
    </a>
  );
}

function RetroRow({ artifact }) {
  const findings = Array.isArray(artifact.findings) ? artifact.findings : [];
  const emitted = Array.isArray(artifact.emitted) ? artifact.emitted : [];

  return (
    <li
      data-testid="retro-row"
      data-run-id={artifact.run_id}
      className="border-l-2 border-zinc-700 pl-2 py-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-zinc-400 truncate">
          {artifact.run_id}
        </span>
        <LocalTimestamp
          ts={artifact.generatedAt}
          className="text-[10px] text-zinc-500 whitespace-nowrap"
        />
      </div>

      {artifact.summary && (
        <p className="text-[11px] text-zinc-300 mt-0.5">{artifact.summary}</p>
      )}

      {findings.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {findings.map((f, i) => (
            <li
              key={`${f.cue}-${i}`}
              data-testid="retro-finding"
              className="text-[10px] leading-tight flex items-start gap-1.5"
            >
              <span className="font-mono text-zinc-500">{f.cue}</span>
              {typeof f.recurrence === "number" && f.recurrence > 0 && (
                <span
                  data-testid="retro-recurrence"
                  className="text-[9px] rounded px-1 py-0.5 font-mono text-amber-300 bg-amber-500/10"
                  title="recurrence count across runs"
                >
                  ×{f.recurrence}
                </span>
              )}
              <span className="text-zinc-300 flex-1">{f.summary}</span>
            </li>
          ))}
        </ul>
      )}

      {emitted.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[9px] text-zinc-500 uppercase tracking-wide">
            produced
          </span>
          {emitted.map((ref, i) => (
            <RefBadge key={`${ref.kind}-${ref.number}-${i}`} ref={ref} />
          ))}
        </div>
      )}
    </li>
  );
}

export default function RetroPanel() {
  const { data, loading } = useApi("/autopilot/retros?limit=20", { poll: 60_000 });
  const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];

  return (
    <section
      data-testid="retro-panel"
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
    >
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-zinc-200">Retrospectives</h2>
        {artifacts.length > 0 && (
          <span className="text-[10px] text-zinc-500 font-mono">
            {artifacts.length} recent
          </span>
        )}
      </div>

      {loading && !data ? (
        <p className="text-xs text-zinc-500 italic">Loading retrospectives…</p>
      ) : artifacts.length === 0 ? (
        <p data-testid="retro-panel-empty" className="text-xs text-zinc-500 italic">
          No retrospectives recorded yet.
        </p>
      ) : (
        <ul
          className="divide-y divide-zinc-900"
          style={{ maxHeight: 360, overflowY: "auto" }}
        >
          {artifacts.map((a) => (
            <RetroRow key={a.run_id} artifact={a} />
          ))}
        </ul>
      )}
    </section>
  );
}
