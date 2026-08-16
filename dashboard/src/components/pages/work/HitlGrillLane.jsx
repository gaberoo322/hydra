import { useCallback, useState } from "react";
import { apiFetch } from "../../../hooks/useApi.js";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * HitlGrillLane — /work's human-in-the-loop grill inbox (issue #4028, slice 4
 * of the hitl-grill epic #4024): the open `hitl-grill` park lane, oldest
 * first, with producer provenance and the parsed park reason. These are ideas
 * upstream of the board, not queued work — the operator delivers one of two
 * verdicts per row:
 *
 *   - Grill   → POST /autopilot/board/promote — the SAME confirm-first,
 *     guard-railed promote the queue uses (closed / already-ready /
 *     missing-scope-section / blocked refusals all surface verbatim); the
 *     server strips `hitl-grill` in the same verified write that adds
 *     ready-for-agent.
 *   - Dismiss → POST /autopilot/board/close { reason: "not planned" } — a
 *     pure close: NO label writes, so `hitl-grill` is RETAINED on the closed
 *     issue for audit and the producer's dedup baseline.
 *
 * Cap state: at >=10 open parks the producers have stopped parking — surfaced
 * from the response's precomputed `capReached` (the same read the lane
 * renders; never a second call to a producer's own cap check).
 *
 * Deliberately NOT the #4007 attention feed: no shared component, no merged
 * data source (AttentionFeed.jsx and src/review-pickup.ts are this issue's
 * Files out of scope and stay byte-for-byte unchanged). The only things
 * shared with any other panel are the generic page primitives every cockpit
 * panel rides — usePageItems + Section (ADR-0034 §5/§7).
 */
export function HitlGrillLane() {
  // Minutes-tier read, like every /work panel (ADR-0034 §5 budgets).
  const lane = usePageItems("/autopilot/hitl-grill", {
    poll: 60_000,
    freshnessMs: 5 * 60 * 1000,
  });

  // ---- Action state (the same local confirm-arm pattern BoardState uses;
  // deliberately NOT an extracted shared hook — BoardState.jsx is outside
  // this slice's file scope, and the block is small) -------------------------
  const [armedGrill, setArmedGrill] = useState(null); // issue number | null
  const [actionPending, setActionPending] = useState(false);
  const [actionResult, setActionResult] = useState(null); // BoardActionResponse + label

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
        setArmedGrill(null);
        // SERVER-CONFIRMED: the lane re-renders only from the follow-up read.
        await lane.refresh();
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
    // lane object identity churns per render; only the stable refresh
    // callback is read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lane.refresh],
  );

  return (
    <Section
      title="HITL grill inbox"
      subtitle="Ideas parked for the operator — oldest first. Grill promotes into ready-for-agent; dismiss closes not planned (the park label stays for audit)."
      count={lane.items.length}
      loading={lane.loading}
      error={lane.status === "stale" ? null : lane.error}
      empty={lane.status === "empty"}
      unknown={lane.status === "unknown"}
      stale={lane.status === "stale"}
      generatedAt={lane.data?.generatedAt}
      emptyMessage="No parked ideas — the hitl-grill lane is empty (the lookup scanned and found none)."
    >
      {/* The cap indicator — same read as the rows, precomputed server-side. */}
      {lane.status !== "unknown" && lane.data?.capReached && (
        <p
          data-testid="hitl-grill-cap"
          className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300"
        >
          Cap reached — {lane.items.length} ideas parked and the producers have
          stopped parking new ones. Grill or dismiss to drain the lane.
        </p>
      )}

      {/* The verified outcome of the last verdict — success shows the observed
          post-write state; refusal shows its specific reason. */}
      {actionResult && (
        <div
          data-testid="hitl-grill-action-result"
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

      <ul className="space-y-2">
        {lane.items.map((row) => (
          <li
            key={row.number}
            data-testid="hitl-grill-row"
            className="flex flex-col gap-2 rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                {/* Producer provenance — every label except the lane label. */}
                {row.provenance.map((label) => (
                  <span
                    key={label}
                    className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-xs text-zinc-300"
                  >
                    {label}
                  </span>
                ))}
                <a
                  href={row.url}
                  className="font-mono text-xs text-zinc-400 hover:text-zinc-200"
                >
                  #{row.number}
                </a>
                <span className="truncate text-sm text-zinc-200" title={row.title}>
                  {row.title}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs text-zinc-500">
                <span>parked <LocalTimestamp ts={row.createdAt} /></span>
                {row.reason && (
                  <span data-testid="hitl-grill-reason" className="text-zinc-400">
                    reason: {row.reason}
                  </span>
                )}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {/* Grill: confirm-first, reusing the queue's promote guardrails —
                  a promote IS a dispatch trigger in disguise (ADR-0034 §7). */}
              {armedGrill === row.number ? (
                <span data-testid="hitl-grill-confirm" className="flex items-center gap-1">
                  <button
                    type="button"
                    data-testid="hitl-grill-confirm-yes"
                    disabled={actionPending}
                    onClick={() =>
                      runAction(
                        "/autopilot/board/promote",
                        { issue: row.number, confirm: true },
                        "grill",
                      )
                    }
                    className="rounded-md border border-emerald-500/60 px-2 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {actionPending ? "grilling…" : "Confirm grill"}
                  </button>
                  <button
                    type="button"
                    data-testid="hitl-grill-confirm-no"
                    disabled={actionPending}
                    onClick={() => setArmedGrill(null)}
                    className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="hitl-grill-arm"
                  disabled={actionPending}
                  onClick={() => setArmedGrill(row.number)}
                  className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  Grill…
                </button>
              )}

              {/* Dismiss: immediate-tier close, not planned. The hitl-grill
                  label is deliberately retained — no label writes here. */}
              <button
                type="button"
                data-testid="hitl-grill-dismiss"
                disabled={actionPending}
                onClick={() =>
                  runAction(
                    "/autopilot/board/close",
                    { issue: row.number, reason: "not planned" },
                    "dismiss",
                  )
                }
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
