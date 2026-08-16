import { useCallback, useState } from "react";
import { useApi, apiFetch } from "../../../hooks/useApi.js";
import { usePageItems, derivePageStatus } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * BoardState — /work's "what is queued" panel (issue #4010, ADR-0034 §2):
 * the board counts plus the operator-lane queue, with the issue-lifecycle
 * actions ADR-0034 §7 assigns this page.
 *
 * Two reads, both on the trust seam (#4006):
 *   - GET /autopilot/board-state — the six counts (non-list payload →
 *     derivePageStatus with itemsLen 1, the Health.jsx payloadStatus idiom;
 *     its sourcesOk:false flows to UNKNOWN, never a confident all-zero board).
 *   - GET /autopilot/work-queue  — the operator-lane rows (usePageItems).
 *
 * Actions (ADR-0034 §7, tiered by blast radius):
 *   - Promote to ready-for-agent is CONFIRM-FIRST — a promote is a dispatch
 *     trigger in disguise, so it arms ("Promote…") and only fires the POST on
 *     an explicit second "Confirm promote" click.
 *   - Relabel / close / reopen are immediate-tier: one click, no confirm.
 *   - EVERY action is server-verified: the POST response carries the observed
 *     post-write state (`verified`), refusals carry their specific `reason` +
 *     `detail`, and the panels re-render only from the follow-up reads. No
 *     action renders success it has not verified.
 *
 * Anti-scope (ADR-0034 §2): no run history, no failure detail — /runs owns
 * forensics.
 */

/** The relabel targets the server schema accepts (RELABEL_TARGETS' mirror). */
const RELABEL_TARGETS = ["needs-triage", "needs-info", "ready-for-human", "blocked"];

const LANE_BADGES = {
  "ready-for-agent": "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40",
  "needs-info": "bg-amber-500/10 text-amber-300 border border-amber-500/40",
  "needs-triage": "bg-sky-500/10 text-sky-300 border border-sky-500/40",
  blocked: "bg-rose-500/10 text-rose-300 border border-rose-500/40",
  "ready-for-human": "bg-violet-500/10 text-violet-300 border border-violet-500/40",
};

const COUNTS = [
  ["needs_qa", "needs-qa"],
  ["ready_for_agent", "ready-for-agent"],
  ["needs_triage", "needs-triage"],
  ["needs_research", "needs-research"],
  ["in_progress", "in-progress"],
  ["blocked", "blocked"],
];

/** Trust status for the non-list board-state payload (Health.jsx idiom). */
function payloadStatus({ data, error, loading, freshnessMs }) {
  return derivePageStatus({ data, error, loading, itemsLen: 1, freshnessMs });
}

function CountChip({ label, value, unknown }) {
  return (
    <div
      data-testid={`board-count-${label}`}
      className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2"
    >
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-lg text-zinc-100">
        {unknown ? <span className="text-zinc-500">UNKNOWN</span> : value}
      </div>
    </div>
  );
}

export function BoardState() {
  // Board counts: minutes-tier read (ADR-0034 §5 budgets — /work is the
  // operator's hourly-ish board review, not the seconds-tier /now).
  const board = useApi("/autopilot/board-state", { poll: 60_000 });
  const queue = usePageItems("/autopilot/work-queue", {
    poll: 60_000,
    freshnessMs: 5 * 60 * 1000,
  });

  const boardStatus = payloadStatus({
    data: board.data,
    error: board.error,
    loading: board.loading,
    freshnessMs: 5 * 60 * 1000,
  });
  const boardUnknown = boardStatus === "loading" || boardStatus === "unknown";

  // ---- Action state ------------------------------------------------------
  const [armedPromote, setArmedPromote] = useState(null); // issue number | null
  const [actionPending, setActionPending] = useState(false);
  const [actionResult, setActionResult] = useState(null); // BoardActionResponse + label
  const [reopenNumber, setReopenNumber] = useState("");

  const runAction = useCallback(
    async (path, body, label) => {
      setActionPending(true);
      setActionResult(null);
      try {
        const res = await apiFetch(path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        // The response IS the verified outcome (server re-read the post-write
        // state) — surface ok + verified / reason + detail verbatim.
        setActionResult({ label, ...res });
        setArmedPromote(null);
        // SERVER-CONFIRMED: panels re-render only from the follow-up reads.
        await Promise.all([board.refresh(), queue.refresh()]);
      } catch (err) {
        setActionResult({
          label,
          ok: false,
          reason: "request-failed",
          detail: err?.message || String(err),
        });
      } finally {
        setActionPending(false);
      }
    },
    // board/queue object identity churns per render; only the stable
    // refresh callbacks are read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.refresh, queue.refresh],
  );

  const readyQueue = queue.items.filter((row) => row.lane === "ready-for-agent");
  const otherLanes = queue.items.filter((row) => row.lane !== "ready-for-agent");

  return (
    <div className="space-y-4">
      {/* ---- Board counts ------------------------------------------------- */}
      <Section
        title="Board"
        subtitle="Current state of the orchestrator issue board."
        loading={board.loading}
        error={boardStatus === "stale" ? null : board.error}
        unknown={boardStatus === "unknown"}
        stale={boardStatus === "stale"}
        generatedAt={board.data?.generatedAt}
      >
        <div data-testid="board-counts" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {COUNTS.map(([key, label]) => (
            <CountChip key={key} label={label} value={board.data?.[key]} unknown={boardUnknown} />
          ))}
        </div>
        {!boardUnknown &&
          board.data?.stale_in_progress?.length > 0 && (
            <p className="mt-2 text-xs text-amber-400/80">
              stale in-progress: #{board.data.stale_in_progress.join(", #")}
            </p>
          )}
        {!boardUnknown &&
          board.data?.stale_blocked?.length > 0 && (
            <p className="mt-1 text-xs text-amber-400/80">
              stale blocked: #{board.data.stale_blocked.join(", #")}
            </p>
          )}
      </Section>

      {/* ---- The queue + actions ------------------------------------------ */}
      <Section
        title="Ready-for-agent queue"
        subtitle="What the autopilot can dispatch next — oldest first. Promote confirms before it fires; relabel, close, and reopen apply immediately."
        count={queue.items.length}
        loading={queue.loading}
        error={queue.status === "stale" ? null : queue.error}
        empty={queue.status === "empty"}
        unknown={queue.status === "unknown"}
        stale={queue.status === "stale"}
        generatedAt={queue.data?.generatedAt}
        emptyMessage="No operator-lane issues open — the queue is empty (the lookup scanned and found none)."
      >
        {/* The verified outcome of the last action — success shows the observed
            post-write state; refusal shows its specific reason. */}
        {actionResult && (
          <div
            data-testid="work-action-result"
            data-ok={actionResult.ok === true ? "true" : "false"}
            className={`mb-3 rounded-md border p-3 text-sm ${
              actionResult.ok === true
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
            }`}
          >
            {actionResult.ok === true ? (
              <span>
                {actionResult.label} #{actionResult.issue} verified — state{" "}
                <strong>{actionResult.verified?.state}</strong>, labels:{" "}
                <strong>{actionResult.verified?.labels?.join(", ") || "none"}</strong>
              </span>
            ) : (
              <span>
                {actionResult.label} #{actionResult.issue} refused —{" "}
                <strong>{actionResult.reason}</strong>
                {actionResult.detail ? `: ${actionResult.detail}` : ""}
              </span>
            )}
          </div>
        )}

        {[["ready-for-agent", readyQueue], ["other lanes", otherLanes]].map(
          ([groupLabel, rows]) =>
            rows.length > 0 && (
              <div key={groupLabel} className="mb-4 last:mb-0">
                <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                  {groupLabel}
                </h3>
                <ul className="space-y-2">
                  {rows.map((row) => (
                    <li
                      key={row.number}
                      data-testid="work-queue-row"
                      className="flex flex-col gap-2 rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${LANE_BADGES[row.lane] ?? "bg-zinc-700/60 text-zinc-300"}`}
                          >
                            {row.lane}
                          </span>
                          <a
                            href={row.url}
                            className="font-mono text-xs text-zinc-400 hover:text-zinc-200"
                          >
                            #{row.number}
                          </a>
                          {row.glmEligible && (
                            <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-xs text-zinc-400">
                              glm-eligible
                            </span>
                          )}
                          <span className="truncate text-sm text-zinc-200" title={row.title}>
                            {row.title}
                          </span>
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          updated <LocalTimestamp ts={row.updatedAt} />
                          {row.openBlockers.length > 0 && (
                            <span className="ml-2 text-rose-300">
                              blocked by #{row.openBlockers.join(", #")}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {/* Promote: confirm-first (ADR-0034 §7) — a promote is a
                            dispatch trigger in disguise. */}
                        {row.lane !== "ready-for-agent" &&
                          (armedPromote === row.number ? (
                            <span data-testid="work-promote-confirm" className="flex items-center gap-1">
                              <button
                                type="button"
                                data-testid="work-promote-confirm-yes"
                                disabled={actionPending}
                                onClick={() =>
                                  runAction(
                                    "/autopilot/board/promote",
                                    { issue: row.number, confirm: true },
                                    "promote",
                                  )
                                }
                                className="rounded-md border border-emerald-500/60 px-2 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                              >
                                {actionPending ? "promoting…" : "Confirm promote"}
                              </button>
                              <button
                                type="button"
                                data-testid="work-promote-confirm-no"
                                disabled={actionPending}
                                onClick={() => setArmedPromote(null)}
                                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              data-testid="work-promote-arm"
                              disabled={actionPending}
                              onClick={() => setArmedPromote(row.number)}
                              className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                            >
                              Promote…
                            </button>
                          ))}

                        {/* Relabel: immediate-tier lane move. */}
                        <select
                          data-testid="work-relabel-select"
                          value=""
                          disabled={actionPending}
                          onChange={(e) => {
                            if (e.target.value) {
                              runAction(
                                "/autopilot/board/relabel",
                                { issue: row.number, label: e.target.value },
                                "relabel",
                              );
                            }
                          }}
                          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 disabled:opacity-50"
                          aria-label={`Relabel issue #${row.number}`}
                        >
                          <option value="">Relabel…</option>
                          {RELABEL_TARGETS.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>

                        {/* Close: immediate-tier. */}
                        <button
                          type="button"
                          data-testid="work-close"
                          disabled={actionPending}
                          onClick={() =>
                            runAction("/autopilot/board/close", { issue: row.number }, "close")
                          }
                          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
                        >
                          Close
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ),
        )}

        {/* Reopen by number — closed issues aren't listed in the open-only
            queue, so reopen takes an explicit number. Immediate-tier. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-700/60 pt-3">
          <span className="text-xs uppercase tracking-wide text-zinc-500">Reopen by number</span>
          <input
            data-testid="work-reopen-input"
            type="number"
            min="1"
            value={reopenNumber}
            onChange={(e) => setReopenNumber(e.target.value)}
            placeholder="issue #"
            className="w-24 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-200"
            aria-label="Issue number to reopen"
          />
          <button
            type="button"
            data-testid="work-reopen-button"
            disabled={actionPending || !Number.isInteger(Number(reopenNumber)) || Number(reopenNumber) < 1}
            onClick={() =>
              runAction(
                "/autopilot/board/reopen",
                { issue: Number(reopenNumber) },
                "reopen",
              )
            }
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Reopen
          </button>
        </div>
      </Section>
    </div>
  );
}
