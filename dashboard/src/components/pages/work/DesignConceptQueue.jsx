import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../../hooks/useApi.js";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import {
  ControlAffordance,
  useCheckedRefresh,
  useOperatorActions,
} from "../../ActionAffordance.jsx";
import { designConceptVerdicts } from "../../../lib/control-verdicts.ts";
import { resolveControlRoute } from "../../../lib/health-verdicts.ts";
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
 * Approve (#4633 INV-3..INV-6, moved onto the registry by #5163): the
 * control is the registry entry `control:work/design-concept-approve`, rendered
 * through ControlAffordance — its label, the three precondition lines and the
 * consequence come from the registry; this file holds none. The live ✓/✗ comes
 * from designConceptVerdicts over the server-evaluated `approve-preconditions`
 * read, and an unproven read (loading, failed, aged) is all-false so the
 * control stays disabled — unproven never enables. The page keeps only DATA:
 * the UNKNOWN line, "checklist as of" / "comments read" times and each failing
 * line's server `detail`. The row's status flips only from the list re-read
 * `onFired` triggers. Approved/stale rows render no control.
 *
 * Paging (#5163 INV-1): server-driven. `offset` rides the list path; Next uses
 * the envelope's `nextOffset`, Previous steps back one page. No client slicing.
 *
 * Trust seam (INV-11): usePageItems + Section, like every /work panel; no
 * direct fetch outside apiFetch/useApi.
 */

const PAGE_SIZE = 25;

/** `issue-736` / `#736` / `736` → 736; anything else → undefined. */
function issueNumberOf(anchorRef) {
  const m = /^(?:issue-|#)?(\d+)$/.exec(String(anchorRef).trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * The approve control for ONE draft row: the registry control plus the
 * page-owned DATA around it. Mounted only for draft rows, so the per-anchor gh
 * comment read behind approve-preconditions is bounded by the number of drafts.
 */
function DraftApproveControl({ anchorRef, registry, onFired }) {
  // Polled every 60 s (the server memoises the gh read 60 s). The freshness
  // budget is deliberately tight — two polls — so a hung poll can never let a
  // ✓ older than ~2 min enable Approve (it demotes to stale → disabled).
  const pre = usePageItems(`/design-concepts/${anchorRef}/approve-preconditions`, {
    poll: 60_000,
    freshnessMs: 120_000,
    itemsKey: "preconditions",
  });
  // Only a FRESH, proven read can enable — loading / unknown / stale never do.
  const proven = pre.status === "ready";
  const verdicts = designConceptVerdicts(pre.data, proven);
  const resolveRoute = useCallback(
    (route) => resolveControlRoute(route, { id: anchorRef }),
    [anchorRef],
  );
  const failing = proven ? pre.items.filter((p) => p.ok !== true && p.detail) : [];

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
          {" · "}
          {pre.data.commentsReadAt ? (
            <>
              comments read{" "}
              <LocalTimestamp ts={pre.data.commentsReadAt} stale={pre.status === "stale"} />
            </>
          ) : (
            "comments read: not read"
          )}
        </p>
      )}
      <ControlAffordance
        registry={registry}
        controlKey="control:work/design-concept-approve"
        verdicts={verdicts}
        context={{ number: issueNumberOf(anchorRef) }}
        resolveRoute={resolveRoute}
        testId="design-concept-approve-control"
        onFired={onFired}
        rereadNoun="queue"
      />
      {failing.length > 0 && (
        <ul data-testid="design-concept-approve-details" className="space-y-0.5 text-[11px] text-red-300">
          {failing.map((p) => (
            <li key={p.check ?? p.label}>— {p.detail}</li>
          ))}
        </ul>
      )}
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
  const [offset, setOffset] = useState(0);
  // One registry read (no poll — the registry changes only on deploy).
  const registry = useOperatorActions();

  // The paginated list, summary projection — the heavy arrays never ride
  // the 60 s poll (INV-2). Draft-only by default; the toggle shows all.
  const listPath = showAll
    ? `/design-concepts?view=summary&limit=${PAGE_SIZE}&offset=${offset}`
    : `/design-concepts?view=summary&status=draft&limit=${PAGE_SIZE}&offset=${offset}`;
  const list = usePageItems(listPath, {
    poll: 60_000,
    freshnessMs: 5 * 60 * 1000,
  });
  const refreshQueue = useCheckedRefresh(list);

  // A draft approved out from under the page can leave the offset past the
  // end: a settled read reporting total <= offset resets to 0 (a fixpoint).
  const settledTotal = list.data?.total;
  useEffect(() => {
    if (offset > 0 && Number.isFinite(settledTotal) && settledTotal <= offset) setOffset(0);
  }, [offset, settledTotal]);

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
          onClick={() => {
            setShowAll((v) => !v);
            setOffset(0);
          }}
          className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
        >
          {showAll ? "Show drafts only" : "Show all statuses"}
        </button>
        {(list.data?.nextOffset != null || offset > 0) && list.items.length > 0 && (
          <span data-testid="design-concept-range" className="text-zinc-500">
            showing {offset + 1}–{offset + list.items.length} of {list.data?.total}
          </span>
        )}
        {offset > 0 && (
          <button
            type="button"
            data-testid="design-concept-prev-page"
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
          >
            Previous page
          </button>
        )}
        {list.data?.nextOffset != null && (
          <button
            type="button"
            data-testid="design-concept-next-page"
            onClick={() => setOffset(list.data.nextOffset)}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
          >
            Next page
          </button>
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
              <DraftApproveControl
                anchorRef={row.anchorRef}
                registry={registry}
                onFired={refreshQueue}
              />
            )}

            {expanded === row.anchorRef && <ConceptDetail anchorRef={row.anchorRef} />}
          </li>
        ))}
      </ul>
    </Section>
  );
}
