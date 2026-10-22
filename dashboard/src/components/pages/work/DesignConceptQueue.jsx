import { useState } from "react";
import { useApi } from "../../../hooks/useApi.js";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import { ActionAffordance } from "../../ActionAffordance.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * DesignConceptQueue — /work's design-concept approval queue (issue #4633,
 * ADR-0034 §9.1/§9.4; design-concept a493aead).
 *
 * The two /work homes ADR-0034 §9.4 names for the design-concept reads:
 *   - the paginated list `/design-concepts` (view=summary, status filter —
 *     default 'draft', with a toggle to show every status), and
 *   - the flat single-artifact read `/design-concepts/${anchorRef}`, fetched
 *     only when a row is expanded (invariants + gate reasons).
 *
 * Approve (INV-3..INV-6): every string the control shows — label, the three
 * precondition lines, the consequence — comes from the registry's
 * grill-handoff approve action, served resolved by the server-evaluated
 * `approve-preconditions` read. ActionAffordance (confirm-first) mounts ONLY
 * when that read is fresh AND `allOk`; otherwise a disabled button with the
 * same label plus the ✗ reasons. An unproven checklist (loading, failed,
 * aged) renders UNKNOWN and stays disabled — unproven never enables. The
 * row's status flips only from the list re-read `onFired` triggers.
 * Approved/stale rows render no control.
 *
 * Trust seam (INV-11): usePageItems + Section, like every /work panel; no
 * direct fetch outside apiFetch/useApi.
 */

const PAGE_SIZE = 25;

/** The ✓/✗/? glyph for one precondition line. */
function Mark({ ok, unknown }) {
  if (unknown) return <span className="text-zinc-500">?</span>;
  return ok ? (
    <span className="text-emerald-400">✓</span>
  ) : (
    <span className="text-red-400">✗</span>
  );
}

/**
 * The approve control for ONE draft row: the live checklist + the gated
 * affordance. Mounted only for draft rows, so the per-anchor gh comment read
 * behind approve-preconditions is bounded by the number of drafts.
 */
function DraftApproveControl({ anchorRef, onFired }) {
  // Polled every 60 s (the server memoises the gh read 60 s). The freshness
  // budget is deliberately tight — two polls — so a hung poll can never let a
  // ✓ older than ~2 min enable Approve (it demotes to stale → disabled).
  const pre = usePageItems(`/design-concepts/${anchorRef}/approve-preconditions`, {
    poll: 60_000,
    freshnessMs: 120_000,
    itemsKey: "preconditions",
  });
  const action = pre.data?.action ?? null;
  // Only a FRESH, proven read can enable — loading / unknown / stale never do.
  const proven = pre.status === "ready";
  const enabled = proven && pre.data?.allOk === true && action !== null;
  const failing = pre.items.filter((p) => p.ok !== true);

  return (
    <div data-testid="design-concept-approve" className="mt-2 space-y-1">
      {!proven && (
        <p data-testid="design-concept-approve-unknown" className="text-xs text-zinc-500">
          UNKNOWN — approve preconditions unproven
          {pre.status === "stale" ? " (stale read)" : ""}
          {pre.status === "loading" ? " (checking…)" : ""}
        </p>
      )}
      {pre.data?.generatedAt && (
        <p data-testid="design-concept-approve-asof" className="text-[11px] text-zinc-500">
          checklist as of{" "}
          <LocalTimestamp ts={pre.data.generatedAt} stale={pre.status === "stale"} />
        </p>
      )}
      {pre.items.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {pre.items.map((p) => (
            <li key={p.label} className="flex gap-2">
              <Mark ok={p.ok === true} unknown={!proven} />
              <span className="text-zinc-300">{p.label}</span>
              {p.detail && <span className="text-zinc-500">— {p.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {enabled ? (
        <ActionAffordance action={action} onFired={onFired} />
      ) : action ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled
            data-testid="design-concept-approve-disabled"
            className="cursor-not-allowed rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-500 opacity-40"
          >
            {action.label}
          </button>
          {proven && failing.length > 0 && (
            <span className="text-[11px] text-red-300">
              ✗ {failing.map((p) => p.label).join("; ")}
            </span>
          )}
        </span>
      ) : null}
    </div>
  );
}

/** The expanded detail: the flat single-artifact read (fetched on expand). */
function ConceptDetail({ anchorRef }) {
  const detail = useApi(`/design-concepts/${anchorRef}`);
  if (detail.loading && !detail.data) {
    return <p className="mt-2 text-xs text-zinc-500">loading artifact…</p>;
  }
  if (!detail.data) {
    return (
      <p className="mt-2 text-xs text-zinc-500">
        UNKNOWN — artifact read failed{detail.error ? `: ${detail.error}` : ""}
      </p>
    );
  }
  const dc = detail.data;
  const reasons = dc.gate?.reasons ?? [];
  return (
    <div data-testid="design-concept-detail" className="mt-2 space-y-2 text-xs">
      <div>
        <span className="text-zinc-400">gate:</span>{" "}
        {dc.gate?.ok ? (
          <span className="text-emerald-300">pass</span>
        ) : (
          <span className="text-amber-300">fail</span>
        )}
        {reasons.length > 0 && (
          <ul className="ml-4 list-disc text-zinc-400">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <span className="text-zinc-400">invariants ({dc.invariants?.length ?? 0}):</span>
        <ol className="ml-4 list-decimal space-y-0.5 text-zinc-300">
          {(dc.invariants ?? []).map((inv) => (
            <li key={inv}>{inv}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function DesignConceptQueue() {
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(null); // anchorRef | null

  // The paginated list, summary projection — the heavy arrays never ride
  // the 60 s poll (INV-2). Draft-only by default; the toggle shows all.
  const listPath = showAll
    ? `/design-concepts?view=summary&limit=${PAGE_SIZE}`
    : `/design-concepts?view=summary&status=draft&limit=${PAGE_SIZE}`;
  const list = usePageItems(listPath, {
    poll: 60_000,
    freshnessMs: 5 * 60 * 1000,
  });

  return (
    <Section
      title="Design concepts"
      subtitle="Grilled design concepts awaiting approval — newest first. Approve unlocks only when the server-evaluated checklist is all ✓."
      count={list.data?.total ?? list.items.length}
      loading={list.loading}
      error={list.status === "stale" ? null : list.error}
      empty={list.status === "empty"}
      unknown={list.status === "unknown"}
      stale={list.status === "stale"}
      generatedAt={list.data?.generatedAt}
      emptyMessage={
        showAll
          ? "No design concepts in the 7-day window (the index was read and is empty)."
          : "No draft design concepts awaiting approval (the index was read and holds none)."
      }
    >
      <div className="mb-3 flex items-center gap-3 text-xs">
        <button
          type="button"
          data-testid="design-concept-status-toggle"
          onClick={() => setShowAll((v) => !v)}
          className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
        >
          {showAll ? "Show drafts only" : "Show all statuses"}
        </button>
        {list.data?.nextOffset != null && (
          <span className="text-zinc-500">
            showing {list.items.length} of {list.data.total}
          </span>
        )}
      </div>

      <ul className="space-y-2">
        {list.items.map((row) => (
          <li
            key={row.anchorRef}
            data-testid="design-concept-row"
            className="rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <button
                type="button"
                onClick={() =>
                  setExpanded((cur) => (cur === row.anchorRef ? null : row.anchorRef))
                }
                className="font-mono text-xs text-zinc-300 hover:text-zinc-100"
              >
                {expanded === row.anchorRef ? "▾" : "▸"} {row.anchorRef}
              </button>
              <span className="rounded bg-zinc-700/60 px-1.5 py-0.5 text-xs text-zinc-300">
                {row.status}
              </span>
              <span className="text-xs text-zinc-500">{row.scope}</span>
              <span className="font-mono text-xs text-zinc-500">
                {String(row.artifactHash ?? "").slice(0, 8)}
              </span>
              <span className="text-xs text-zinc-500">
                gate {row.gate?.ok ? "pass" : "fail"} · {row.counts?.invariants ?? 0} invariants
              </span>
              {row.approvedBy && (
                <span className="text-xs text-zinc-500">by {row.approvedBy}</span>
              )}
              <span className="text-xs text-zinc-500">
                {/* createdAt is epoch-ms; LocalTimestamp takes ISO or epoch-s. */}
                <LocalTimestamp
                  ts={Number.isFinite(row.createdAt) ? new Date(row.createdAt).toISOString() : null}
                />
              </span>
            </div>

            {row.status === "draft" && (
              <DraftApproveControl anchorRef={row.anchorRef} onFired={list.refresh} />
            )}

            {expanded === row.anchorRef && <ConceptDetail anchorRef={row.anchorRef} />}
          </li>
        ))}
      </ul>
    </Section>
  );
}
