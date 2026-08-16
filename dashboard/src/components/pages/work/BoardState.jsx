import { useCallback, useState } from "react";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { apiFetch } from "../../../hooks/useApi.js";
import { relativeAge } from "../../../lib/page-item-format.ts";
import { Section } from "../today/Section.jsx";

/**
 * BoardState — the /work page's "what is queued, what is next" surface
 * (issue #4010, ADR-0034 §3): the board-state lane counts plus the
 * ready-for-agent queue with, per row, WHY it does not count toward the
 * dispatchable pool when it doesn't (`excluded` + `blockedBy` from
 * GET /autopilot/board-state's `ready_queue`).
 *
 * Trust contract (ADR-0034 §5, INV-2): one usePageItems call feeds both
 * panels — status derives from `sourcesOk` + `generatedAt`, so a degraded
 * board (gh unreachable, all-zero safe counts) renders UNKNOWN, never a
 * confident row of zeros. Minutes-tier freshness budget.
 *
 * Action tiering (ADR-0034 §7, INV-5/INV-6): relabel / close / reopen are
 * immediate-fire; promote is confirm-first ("ready-for-agent is a dispatch
 * trigger in disguise") AND double-refused server-side (open strict blocker,
 * missing "## Files in scope"). Success renders ONLY from the server's
 * verified post-write re-read; a refusal renders its specific reason.
 */

// Mirrors RELABEL_TARGET_LABELS in src/schemas/autopilot-board.ts — the five
// orch lanes promote can move OFF of and relabel can move ONTO. ready-for-agent
// is deliberately absent: the promote action (confirm + guards) is the only
// route onto that label.
const RELABEL_TARGETS = [
  { value: "needs-qa", label: "needs-qa" },
  { value: "needs-triage", label: "needs-triage" },
  { value: "needs-research", label: "needs-research" },
  { value: "in-progress", label: "in-progress" },
  { value: "blocked", label: "blocked" },
];

const EXCLUDED_LABEL = {
  "target-backlog": "target-backlog — Target-scope routing, not orch work",
  "glm-eligible-drainer-live": "glm-eligible — the drainer partition owns it",
  "blocked-by-open-issue": "blocked — open strict blocker",
};

const EXCLUDED_CLASS = {
  "target-backlog": "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
  "glm-eligible-drainer-live": "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "blocked-by-open-issue": "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

/** The board lane counts — one grid cell per lane, from the same payload. */
function LaneCounts({ data }) {
  const lanes = [
    ["ready-for-agent", data?.ready_for_agent, true],
    ["needs-qa", data?.needs_qa, false],
    ["needs-triage", data?.needs_triage, false],
    ["needs-research", data?.needs_research, false],
    ["in-progress", data?.in_progress, false],
    ["blocked", data?.blocked, false],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" data-testid="work-lane-counts">
      {lanes.map(([lane, count, headline]) => (
        <div
          key={lane}
          data-testid={`work-lane-${lane}`}
          className={`rounded-md border px-3 py-2 ${
            headline
              ? "border-blue-500/40 bg-blue-500/10"
              : "border-zinc-700 bg-zinc-900/40"
          }`}
        >
          <div className="text-lg font-mono text-zinc-100">{count ?? "—"}</div>
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">{lane}</div>
        </div>
      ))}
    </div>
  );
}

/** Ready-queue rows — the why-that explanation rides on each row. */
function ReadyQueueList({ items }) {
  return (
    <ul className="divide-y divide-zinc-700/50" data-testid="work-ready-queue">
      {items.map((row) => (
        <li key={row.number} className="py-2 flex items-center gap-3 flex-wrap" data-testid="work-ready-queue-row">
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-zinc-100 hover:text-violet-300 truncate max-w-72"
          >
            <span className="text-zinc-500 mr-1">#{row.number}</span>
            {row.title}
          </a>
          {row.excluded === null ? (
            <span
              data-testid="work-queue-dispatchable"
              className="shrink-0 px-2 py-0.5 text-xs rounded border bg-blue-500/10 text-blue-300 border-blue-500/30"
              title="counts toward the dispatchable pool"
            >
              dispatchable
            </span>
          ) : (
            <span
              data-testid="work-queue-excluded"
              className={`shrink-0 px-2 py-0.5 text-xs rounded border ${EXCLUDED_CLASS[row.excluded] ?? ""}`}
              title={EXCLUDED_LABEL[row.excluded] ?? row.excluded}
            >
              {EXCLUDED_LABEL[row.excluded] ?? row.excluded}
              {row.excluded === "blocked-by-open-issue" &&
                row.blockedBy?.length > 0 &&
                ` (#${row.blockedBy.join(", #")})`}
            </span>
          )}
          <span className="flex-1" />
          {row.updatedAt && (
            <span className="text-xs text-zinc-500 shrink-0">{relativeAge(row.updatedAt)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The issue-lifecycle action form (ADR-0034 §7). Policy lives server-side —
 * this is the thin fire-and-render surface: promote's two-step confirm,
 * immediate relabel/close/reopen, and a result panel that renders the
 * server's `verified` post-write state or the specific refusal `reason`.
 */
function IssueActions({ onSettled }) {
  const [issueInput, setIssueInput] = useState("");
  const [label, setLabel] = useState(RELABEL_TARGETS[0].value);
  const [pendingConfirm, setPendingConfirm] = useState(null); // issue number awaiting the 2nd click
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [actionError, setActionError] = useState(null);

  const issueNumber = Number.parseInt(issueInput, 10);
  const issueValid = Number.isInteger(issueNumber) && issueNumber > 0;

  const run = useCallback(
    async (path, body) => {
      setBusy(true);
      setActionError(null);
      try {
        const res = await apiFetch(path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setResult(res);
        // The board changed (or may have — a refusal can follow a landed
        // write on verify-failed): refresh either way.
        await onSettled();
      } catch (err) {
        setActionError(err.message);
      } finally {
        setBusy(false);
        setPendingConfirm(null);
      }
    },
    [onSettled],
  );

  return (
    <div className="space-y-3" data-testid="work-issue-actions">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="number"
          min="1"
          value={issueInput}
          onChange={(e) => {
            setIssueInput(e.target.value);
            setResult(null);
            setPendingConfirm(null);
          }}
          placeholder="issue #"
          aria-label="issue number"
          data-testid="work-action-issue-input"
          className="w-24 px-2 py-1 text-sm rounded border border-zinc-600 bg-zinc-900 text-zinc-100"
        />
        {/* Promote — ADR-0034 §7 confirm-first tier. The first click only
            arms the confirmation; the POST rides the second, explicit click. */}
        {pendingConfirm === null || !issueValid ? (
          <button
            type="button"
            disabled={!issueValid || busy}
            onClick={() => setPendingConfirm(issueNumber)}
            title="Promote to ready-for-agent — arms a dispatch (confirm required)"
            data-testid="work-promote-arm"
            className="px-2 py-1 text-xs rounded border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 disabled:opacity-40"
          >
            promote…
          </button>
        ) : (
          <span className="flex items-center gap-2" data-testid="work-promote-confirm">
            <span className="text-xs text-amber-300">
              Promote #{pendingConfirm} to ready-for-agent? This arms a dispatch.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                run("/autopilot/board-state/promote", { issue: pendingConfirm, confirm: true })
              }
              data-testid="work-promote-confirm-button"
              className="px-2 py-1 text-xs rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
            >
              {busy ? "…" : "confirm promote"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPendingConfirm(null)}
              className="px-2 py-1 text-xs rounded border border-zinc-600 text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
            >
              cancel
            </button>
          </span>
        )}
        <span className="flex items-center gap-1">
          <select
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="relabel target"
            data-testid="work-relabel-select"
            disabled={busy}
            className="px-2 py-1 text-xs rounded border border-zinc-600 bg-zinc-900 text-zinc-200"
          >
            {RELABEL_TARGETS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!issueValid || busy}
            onClick={() => run("/autopilot/board-state/relabel", { issue: issueNumber, label })}
            title="Move the issue to a lane (immediate — no confirm)"
            data-testid="work-relabel-button"
            className="px-2 py-1 text-xs rounded border border-zinc-600 text-zinc-300 hover:border-zinc-400 disabled:opacity-40"
          >
            relabel
          </button>
        </span>
        <button
          type="button"
          disabled={!issueValid || busy}
          onClick={() => run("/autopilot/board-state/close", { issue: issueNumber })}
          title="Close the issue (immediate — no confirm)"
          data-testid="work-close-button"
          className="px-2 py-1 text-xs rounded border border-zinc-600 text-zinc-300 hover:border-zinc-400 disabled:opacity-40"
        >
          close
        </button>
        <button
          type="button"
          disabled={!issueValid || busy}
          onClick={() => run("/autopilot/board-state/reopen", { issue: issueNumber })}
          title="Reopen the issue (immediate — no confirm)"
          data-testid="work-reopen-button"
          className="px-2 py-1 text-xs rounded border border-zinc-600 text-zinc-300 hover:border-zinc-400 disabled:opacity-40"
        >
          reopen
        </button>
      </div>

      {actionError && (
        <div data-testid="work-action-error" className="text-xs text-red-300 font-mono break-all">
          {actionError}
        </div>
      )}

      {/* Result panel (INV-6): success renders the VERIFIED post-write state
          the server re-read; a refusal renders its specific machine reason. */}
      {result && (
        <div
          data-testid="work-action-result"
          className={`rounded-md border px-3 py-2 text-xs ${
            result.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200"
          }`}
        >
          {result.ok ? (
            <span data-testid="work-action-verified">
              {result.action} #{result.issue} verified — state {result.verified?.state},
              labels [{(result.verified?.labels ?? []).join(", ")}]{" "}
              <a
                href={result.verified?.url}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-emerald-100"
              >
                open →
              </a>
            </span>
          ) : (
            <span data-testid="work-action-refused">
              {result.action} #{result.issue} refused — {result.reason}
              {result.detail ? `: ${result.detail}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function BoardState() {
  const { items, data, status, error, loading, refresh } = usePageItems(
    "/autopilot/board-state",
    {
      itemsKey: "ready_queue",
      poll: 30_000,
      // ADR-0034 §5: board state is a minutes-tier surface — a payload older
      // than 5 min is stale (labels move on every dispatch/reap).
      freshnessMs: 5 * 60 * 1000,
    },
  );

  const dispatchable = items.filter((r) => r.excluded === null);

  return (
    <div className="space-y-5">
      <Section
        title="Board state"
        subtitle="Lane counts over the open issue board — the dispatchable pool is the blue lane."
        loading={loading}
        error={status === "stale" ? null : error}
        unknown={status === "unknown" || status === "loading"}
        stale={status === "stale"}
        generatedAt={data?.generatedAt}
      >
        <LaneCounts data={data} />
      </Section>

      <Section
        title="Ready-for-agent queue"
        subtitle={
          dispatchable.length === items.length
            ? "Every ready-for-agent issue is dispatchable."
            : `${dispatchable.length} of ${items.length} ready-for-agent issues are dispatchable — excluded rows say why.`
        }
        count={items.length}
        loading={loading}
        error={status === "stale" ? null : error}
        empty={status === "empty"}
        unknown={status === "unknown" || status === "loading"}
        stale={status === "stale"}
        generatedAt={data?.generatedAt}
        emptyMessage="Queue is empty — no open issue carries ready-for-agent."
      >
        <ReadyQueueList items={items} />
      </Section>

      <Section
        title="Issue actions"
        subtitle="Promote needs a confirm (it arms a dispatch); relabel / close / reopen fire immediately. Success shows the re-read verified state."
      >
        <IssueActions onSettled={refresh} />
      </Section>
    </div>
  );
}
