import { useState } from "react";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { apiFetch } from "../../../hooks/useApi.js";
import { Section } from "../today/Section.jsx";

/**
 * BoardState — the /work page's board + queue + issue-lifecycle-action panel
 * (issue #4010, ADR-0034 §2 + §7).
 *
 * Renders GET /autopilot/board-state through the shared trust contract
 * (#4006/#4007): the lane counts, and the ready-for-agent queue (the
 * dispatchable pool — what the autopilot could pick next). Carries the four
 * issue-lifecycle actions as INLINE row controls + an act-on-issue bar
 * (deliberately no separate IssueActions.jsx — the design concept kept the
 * dashboard file surface within the declared scope list).
 *
 * Action tiers (ADR-0034 §7), encoded UI-side and enforced server-side:
 *   - promote → CONFIRM step (a dispatch trigger in disguise); the POST
 *     carries confirm:true only after the explicit "Yes, promote" click.
 *   - relabel / close / reopen → immediate.
 *
 * No action renders success it has not verified: every response's issue
 * snapshot IS the server's post-write re-read, and the result line shows it
 * (or the specific refusal reason). Anti-scope (ADR-0034 §2): no run history
 * or failure detail here — that is /runs.
 */

const LANES = [
  { value: "needs-triage", label: "needs-triage" },
  { value: "needs-research", label: "needs-research" },
  { value: "needs-qa", label: "needs-qa" },
  { value: "needs-info", label: "needs-info" },
  { value: "in-progress", label: "in-progress" },
  { value: "blocked", label: "blocked" },
  { value: "ready-for-human", label: "ready-for-human" },
  { value: "wontfix", label: "wontfix" },
  { value: "target-backlog", label: "target-backlog" },
];

const COUNT_TILES = [
  ["ready_for_agent", "ready-for-agent"],
  ["needs_qa", "needs-qa"],
  ["needs_triage", "needs-triage"],
  ["needs_research", "needs-research"],
  ["in_progress", "in-progress"],
  ["blocked", "blocked"],
];

function VerifiedResultLine({ result }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <p data-testid="action-result" className="text-xs text-emerald-300">
        ✓ verified #{result.issue.number}: state={result.issue.state} · labels=[
        {result.issue.labels.join(", ")}]
      </p>
    );
  }
  return (
    <p data-testid="action-result" className="text-xs text-amber-300">
      ✗ refused ({result.code}): {result.reason}
    </p>
  );
}

export default function BoardState() {
  const { items, data, status, error, loading, refresh } = usePageItems(
    "/autopilot/board-state",
    {
      // The queue IS the dispatch decision input — minutes-tier freshness.
      itemsKey: "ready_for_agent_queue",
      freshnessMs: 5 * 60 * 1000,
      poll: 30_000,
    },
  );

  // --- issue-lifecycle action state (ADR-0034 §7) ---
  const [target, setTarget] = useState("");
  const [lane, setLane] = useState("needs-research");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function runAction(path, body) {
    setBusy(true);
    setActionError(null);
    try {
      const res = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setResult(res);
      // Refresh the board so the counts + queue reflect the verified write.
      await refresh();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const act = (issue) => ({
    promote: (confirm) =>
      runAction("/autopilot/board-state/promote", { issue, confirm }),
    relabel: (addLabel, removeLabels) =>
      runAction("/autopilot/board-state/relabel", { issue, addLabel, removeLabels }),
    close: () => runAction("/autopilot/board-state/close", { issue }),
    reopen: () => runAction("/autopilot/board-state/reopen", { issue }),
  });

  const targetIssue = parseInt(target, 10);

  return (
    <Section
      title="Board state"
      subtitle="What is queued, what is next — the dispatchable pool and its lane counts."
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
      emptyMessage="No dispatchable issues — every lane is clear."
    >
      <div data-testid="board-counts" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
        {COUNT_TILES.map(([key, label]) => (
          <div key={key} className="border border-zinc-700/60 rounded-md bg-zinc-900/40 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
            <div data-testid={`count-${key}`} className="text-lg font-mono text-zinc-100">
              {data?.[key] ?? "—"}
            </div>
          </div>
        ))}
      </div>

      <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        Ready-for-agent queue
      </h3>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500 italic mb-4">Queue is empty.</p>
      ) : (
        <ul data-testid="ready-queue" className="divide-y divide-zinc-700/50 border border-zinc-700/60 rounded-lg bg-zinc-900/30 px-3 mb-4">
          {items.map((row) => (
            <li key={row.number} className="py-2 flex items-center gap-3 flex-wrap" data-testid="queue-row">
              <a
                href={row.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-zinc-100 hover:text-violet-300 truncate min-w-0 flex-1"
              >
                <span className="text-zinc-500 mr-1">#{row.number}</span>
                {row.title}
              </a>
              <span className="flex-1" />
              <select
                aria-label={`Move #${row.number} to lane`}
                className="text-xs bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-zinc-300"
                value=""
                disabled={busy}
                onChange={(e) => {
                  if (e.target.value) {
                    act(row.number).relabel(e.target.value, ["ready-for-agent"]);
                  }
                }}
              >
                <option value="">move to lane…</option>
                {LANES.filter((l) => l.value !== "ready-for-agent").map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
              <button
                type="button"
                data-testid={`close-${row.number}`}
                className="text-xs text-zinc-400 hover:text-red-300 disabled:opacity-50"
                disabled={busy}
                onClick={() => act(row.number).close()}
              >
                close
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
        Act on an issue
      </h3>
      <div data-testid="issue-actions" className="flex items-center gap-2 flex-wrap">
        <label className="text-xs text-zinc-500" htmlFor="work-issue-number">
          issue #
        </label>
        <input
          id="work-issue-number"
          type="number"
          min="1"
          className="w-24 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 font-mono"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setConfirming(false);
            setResult(null);
          }}
          placeholder="1234"
        />
        <select
          aria-label="Target lane for relabel"
          className="text-xs bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-zinc-300"
          value={lane}
          onChange={(e) => setLane(e.target.value)}
        >
          {LANES.map((l) => (
            <option key={l.value} value={l.value}>{l.label}</option>
          ))}
        </select>
        {confirming ? (
          <span data-testid="promote-confirm" className="flex items-center gap-2">
            <span className="text-xs text-amber-300">
              Promoting #{targetIssue || "…"} arms a dispatch — confirm?
            </span>
            <button
              type="button"
              data-testid="promote-confirm-yes"
              className="text-xs px-2 py-1 rounded bg-amber-500/20 border border-amber-500/40 text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
              disabled={busy || !targetIssue}
              onClick={() => {
                setConfirming(false);
                act(targetIssue).promote(true);
              }}
            >
              Yes, promote
            </button>
            <button
              type="button"
              data-testid="promote-confirm-no"
              className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700/60"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="promote-button"
            className="text-xs px-2 py-1 rounded bg-blue-500/15 border border-blue-500/40 text-blue-200 hover:bg-blue-500/25 disabled:opacity-50"
            disabled={busy || !targetIssue}
            onClick={() => setConfirming(true)}
          >
            Promote to ready-for-agent…
          </button>
        )}
        <button
          type="button"
          data-testid="relabel-button"
          className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700/60 disabled:opacity-50"
          disabled={busy || !targetIssue}
          onClick={() => act(targetIssue).relabel(lane, ["ready-for-agent"])}
        >
          Relabel
        </button>
        <button
          type="button"
          data-testid="close-button"
          className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-red-300 disabled:opacity-50"
          disabled={busy || !targetIssue}
          onClick={() => act(targetIssue).close()}
        >
          Close
        </button>
        <button
          type="button"
          data-testid="reopen-button"
          className="text-xs px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-emerald-300 disabled:opacity-50"
          disabled={busy || !targetIssue}
          onClick={() => act(targetIssue).reopen()}
        >
          Reopen
        </button>
      </div>
      <div className="mt-2 space-y-1">
        {actionError && (
          <p data-testid="action-error" className="text-xs text-red-300 font-mono break-all">
            {actionError}
          </p>
        )}
        <VerifiedResultLine result={result} />
      </div>
    </Section>
  );
}
