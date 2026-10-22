import { useCallback, useState } from "react";
import { useApi } from "../../../hooks/useApi.js";
import { usePageItems, derivePageStatus } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import {
  ControlAffordance,
  UndoToastStack,
  UndoWindowContext,
  useOperatorActions,
  useUndoWindowHost,
} from "../../ActionAffordance.jsx";

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
 * Actions (ADR-0034 §7/§8.3, issue #4629 — design-concept 821e48ed): every
 * write control renders through the shared {@link ActionAffordance} from its
 * `control:work/<name>` registry entry (read once via useOperatorActions) —
 * this file carries NO action label, precondition or consequence string of
 * its own. Each row joins the entry's typed `{text, check}` preconditions to
 * the page's verdict table ({@link rowVerdicts}), so the button shows a live
 * ✓/✗ checklist and is disabled while any line is ✗:
 *   - Promote is CONFIRM-FIRST (a promote is a dispatch trigger in disguise);
 *     its four checks are the promote gate's refusal table, fed by the row
 *     facts the server computes (`hasScopeSection`, `openBlockers`). The
 *     server gate stays the authority — a refusal renders verbatim.
 *   - Relabel / close / reopen are immediate-with-undo: the ~5 s delayed
 *     commit hosted here (useUndoWindowHost + UndoToastStack). The relabel
 *     select is the closed picker only; the chosen target becomes the
 *     affordance's `context.label`.
 *   - EVERY action is server-verified: the affordance awaits the POST and the
 *     follow-up reads (onFired) before rendering, then lifts the outcome —
 *     observed `verified` state, or the refusal's `reason` + `detail` — into
 *     the work-action-result panel. No action renders success it has not
 *     verified.
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

/**
 * The /work verdict table (issue #4629 INV-4/INV-14): one boolean per
 * CONTROL_CHECKS id the row controls use, computed from the row facts the
 * server already projects (never a client-side body parse). A check missing
 * here would render ✗ and disable its button (fail closed).
 */
function rowVerdicts(row, relabelTarget) {
  return {
    // Every queue row comes from the open-issues scan (GET /autopilot/work-queue
    // reads open issues only) — closed issues never reach this table.
    "issue-open": true,
    "not-already-ready": row.lane !== "ready-for-agent",
    "has-scope-section": row.hasScopeSection === true,
    "no-open-blocker": Array.isArray(row.openBlockers) && row.openBlockers.length === 0,
    "relabel-target-chosen": RELABEL_TARGETS.includes(relabelTarget),
  };
}

/** The reopen-by-number verdict table — the number input is the only fact. */
function reopenVerdicts(reopenNumber) {
  const n = Number(reopenNumber);
  return { "issue-number-entered": reopenNumber !== "" && Number.isInteger(n) && n >= 1 };
}

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
  // Registry entries (one read, no poll) + the page-level undo-window host
  // for the immediate-tier controls (ADR-0034 §7).
  const registry = useOperatorActions();
  const undoHost = useUndoWindowHost();
  const [actionResult, setActionResult] = useState(null); // lifted affordance outcome
  const [relabelTargets, setRelabelTargets] = useState({}); // issue number → chosen lane
  const [reopenNumber, setReopenNumber] = useState("");

  // SERVER-CONFIRMED: the affordance awaits these follow-up reads (onFired)
  // before it renders or lifts any outcome.
  const refreshBoard = useCallback(
    async () => {
      await Promise.all([board.refresh(), queue.refresh()]);
    },
    // board/queue object identity churns per render; only the stable
    // refresh callbacks are read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board.refresh, queue.refresh],
  );

  const readyQueue = queue.items.filter((row) => row.lane === "ready-for-agent");
  const otherLanes = queue.items.filter((row) => row.lane !== "ready-for-agent");

  return (
    <UndoWindowContext.Provider value={undoHost}>
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
            {actionResult.ok === true && actionResult.verified ? (
              <span>
                {actionResult.label} #{actionResult.issue} verified — state{" "}
                <strong>{actionResult.verified?.state}</strong>, labels:{" "}
                <strong>{actionResult.verified?.labels?.join(", ") || "none"}</strong>
              </span>
            ) : actionResult.ok === true ? (
              <span>{actionResult.text}</span>
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

                      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                        {/* Promote: confirm-first (ADR-0034 §7) — a promote is a
                            dispatch trigger in disguise. Hidden on ready rows:
                            there is nothing to promote. */}
                        {row.lane !== "ready-for-agent" && (
                          <ControlAffordance
                            registry={registry}
                            controlKey="control:work/promote"
                            testId="work-promote"
                            verdicts={rowVerdicts(row, relabelTargets[row.number])}
                            context={{ number: row.number }}
                            onFired={refreshBoard}
                            onResult={setActionResult}
                          />
                        )}

                        {/* Relabel: the closed picker chooses the target; the
                            immediate-tier affordance fires it (never on change). */}
                        <div className="flex flex-wrap items-start gap-2">
                          <select
                            data-testid="work-relabel-select"
                            value={relabelTargets[row.number] ?? ""}
                            onChange={(e) =>
                              setRelabelTargets((prev) => ({ ...prev, [row.number]: e.target.value }))
                            }
                            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                            aria-label={`Relabel target for issue #${row.number}`}
                          >
                            <option value="">lane…</option>
                            {RELABEL_TARGETS.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                          <ControlAffordance
                            registry={registry}
                            controlKey="control:work/relabel"
                            testId="work-relabel"
                            verdicts={rowVerdicts(row, relabelTargets[row.number])}
                            context={{ number: row.number, label: relabelTargets[row.number] }}
                            onFired={refreshBoard}
                            onResult={setActionResult}
                          />
                        </div>

                        {/* Close: immediate-tier. */}
                        <ControlAffordance
                          registry={registry}
                          controlKey="control:work/close"
                          testId="work-close"
                          verdicts={rowVerdicts(row, relabelTargets[row.number])}
                          context={{ number: row.number }}
                          onFired={refreshBoard}
                          onResult={setActionResult}
                        />
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
          <ControlAffordance
            registry={registry}
            controlKey="control:work/reopen"
            testId="work-reopen"
            verdicts={reopenVerdicts(reopenNumber)}
            context={{ number: Number(reopenNumber) }}
            onFired={refreshBoard}
            onResult={setActionResult}
          />
        </div>
      </Section>
    </div>
    <UndoToastStack windows={undoHost.windows} onUndo={undoHost.undo} />
    </UndoWindowContext.Provider>
  );
}
