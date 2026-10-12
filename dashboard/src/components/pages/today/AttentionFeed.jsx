import { useCallback, useState } from "react";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { apiFetch } from "../../../hooks/useApi.js";
import { relativeAge } from "../../../lib/page-item-format.ts";
import { Section } from "./Section.jsx";
import { ActionAffordance, DelayedCommitToast, useDelayedCommit } from "../../ActionAffordance.jsx";

/**
 * AttentionFeed — the `/` page's "what needs me" surface (issue #4007,
 * ADR-0034 §4; bucketed per §8.1/#4623, Variant B per #4422/issue #4628).
 *
 * Six fixed bucket sections in drain order (machine-stopped →
 * parked-over-cap), each header carrying the rank, the bucket name, its
 * count, and a one-line why-it-ranks-here from the closed BUCKET_WHY map.
 * Items keep the server's within-bucket order — the composer owns ordering,
 * the client never re-sorts.
 *
 * Every item's right column is the registry action grammar (ADR-0034 §8.2):
 * `Do:` + the ActionAffordance for the recommended action, the preconditions
 * as an UNCHECKED checklist (registry preconditions are prose with no
 * evaluator — never a verified tick, never a disabled button), the
 * consequence, then `or: alt · alt · Skip` as plain text with the
 * alternative's command/consequence on hover. Aggregate rows (rank-0
 * machine-stopped, parked-over-cap, the archived-Target row) render as ONE
 * wide well whose sub-lines each carry their OWN resolved action.
 *
 * Trust contract (ADR-0034 §5.2): per-bucket asserted emptiness. A bucket
 * whose summary has sourcesOk:false (or wired:false) renders UNKNOWN with
 * its sourceErrors — never an all-clear; an asserted zero renders a muted
 * "nothing crossed" line. A failed/absent whole payload keeps the Section
 * unknown/stale path (usePageItems status). Minutes-tier freshness budget:
 * attention data older than 5 min is stale.
 *
 * Dismiss (ADR-0034 §8.4) is TYPED — exactly the three reasons the strict
 * #4627 schema accepts — and fires through the same ~5 s delayed-commit undo
 * window as immediate-tier actions (there is no undismiss route), via this
 * component's own apiFetch call (the confirmed-write fence,
 * test/dashboard-server-confirmed-write.test.mts INV-7).
 */

/** Why each bucket ranks where it does — the header's one-line rationale.
 * Closed client-side, keyed by every BUCKETS value (pinned by
 * test/operator-actions-affordance.test.mts). */
const BUCKET_WHY = {
  "machine-stopped": "everything below is moot while the brain is off or prod is behind master",
  "prs-not-landing": "finished work, unstuck by one command",
  "waiting-on-you": "these need real thought",
  "target-items": "orchestrator-self is primary; the Target board follows",
  "repetition": "a signal about the machine, not a waiting piece of work",
  "parked-over-cap": "one skill session drains the whole lane",
};

/** Keys whose items are aggregate rows rendered as one wide well (INV-5):
 * rank-0 machine-stopped carries `subLines`; these two are single-line
 * aggregates with no sub-lines. */
const AGGREGATE_KEYS = new Set(["parked-over-cap:cap", "target-items:archived"]);

/** The three typed dismiss reasons (ADR-0034 §8.4 / #4627 strict schema). */
const DISMISS_REASONS = [
  { value: "not-a-problem", label: "Not a problem" },
  { value: "handled-elsewhere", label: "Handled elsewhere" },
  { value: "later", label: "Later" },
];

function isAggregate(item) {
  return (Array.isArray(item.subLines) && item.subLines.length > 0) || AGGREGATE_KEYS.has(item.key);
}

/** The hover text for a plain-text alternative label (INV-3): the command
 * where one exists, plus the consequence. Alternatives never fire anything. */
function altTitle(alt) {
  return alt.kind === "terminal-skill" ? `${alt.command} — ${alt.consequence}` : alt.consequence;
}

/**
 * The right column every item (and every machine-stopped sub-line) renders:
 * Do: <affordance>, the unchecked preconditions, → consequence, then the
 * alternatives as TEXT.
 */
function ActionColumn({ entry, onFired }) {
  const a = entry.recommended;
  return (
    <div className="grid content-start gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500">Do:</span>
        <ActionAffordance action={a} doc={entry.doc} onFired={onFired} />
      </div>
      {a.preconditions.length > 0 && (
        <ul className="grid gap-0.5">
          {a.preconditions.map((p) => (
            <li key={p} className="flex items-baseline gap-1.5 text-zinc-400">
              {/* Registry preconditions are prose with no evaluator — an
                  UNCHECKED box, never a verified tick, and it never
                  disables the button (ADR-0034 §8.3). */}
              <span aria-hidden="true" className="text-zinc-600">
                ☐
              </span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="text-zinc-300">→ {a.consequence}</div>
      <div className="text-zinc-500">
        or: <span title={altTitle(entry.alternatives[0])}>{entry.alternatives[0].label}</span>
        {" · "}
        <span title={altTitle(entry.alternatives[1])}>{entry.alternatives[1].label}</span>
        {" · Skip"}
      </div>
    </div>
  );
}

/** The typed-dismiss control: exactly the three schema reasons, each firing
 * through the page-level delayed-commit window (onDismissStart). */
function DismissControl({ item, onDismissStart }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-[11px] text-zinc-600">
      <span>dismiss:</span>
      {DISMISS_REASONS.map((r, i) => (
        <span key={r.value} className="flex items-baseline gap-1.5">
          {i > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            onClick={() => onDismissStart(item, r)}
            title={`30-day snooze · ${r.value}`}
            className="text-zinc-500 underline hover:text-zinc-200"
          >
            {r.label}
          </button>
        </span>
      ))}
    </div>
  );
}

/** One per-item row: the crossed line and its explanation on the left, the
 * action grammar on the right. */
function FeedItem({ item, onFired, onDismissStart }) {
  return (
    <div className="grid gap-2 border-t border-zinc-700/50 py-2.5 md:grid-cols-[minmax(0,1fr)_minmax(280px,40%)]">
      <div className="min-w-0">
        <a
          href={item.url}
          target={item.url.startsWith("http") ? "_blank" : undefined}
          rel="noreferrer"
          className="text-sm text-zinc-100 hover:text-violet-300"
        >
          {item.title}
        </a>
        {/* The line is the explanation: observed value next to the threshold
            it crossed (ADR-0034 §4/§5.3), then the crossing's age. */}
        <div className="mt-0.5 font-mono text-[11px] text-zinc-400">
          {item.observedValue} · {item.thresholdLabel} ·{" "}
          <span className="text-zinc-500">{relativeAge(item.crossedAt)}</span>
        </div>
        <div className="mt-1 text-xs italic text-zinc-500">{item.action.rationale}</div>
        {item.detail && <div className="mt-0.5 text-[11px] text-zinc-500">{item.detail}</div>}
        <DismissControl item={item} onDismissStart={onDismissStart} />
      </div>
      <ActionColumn entry={item.action} onFired={onFired} />
    </div>
  );
}

/**
 * An aggregate row as ONE wide well (INV-5): headline = title (+detail), and
 * each sub-line carries its OWN Do:/consequence/or: block driven by
 * `subLine.action` — sub-lines resolve to distinct registry entries and must
 * not collapse to the parent's. The two single-line aggregates (parked over
 * cap, archived Target) render the parent's action block directly.
 */
function AggregateWell({ item, onFired, onDismissStart }) {
  return (
    <div className="mt-2 grid gap-2.5 rounded-md border border-zinc-700/60 bg-zinc-900/60 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100">{item.title}</div>
          {item.detail && <div className="mt-0.5 text-[11px] text-zinc-500">{item.detail}</div>}
        </div>
        <DismissControl item={item} onDismissStart={onDismissStart} />
      </div>
      {(item.subLines?.length ?? 0) > 0
        ? item.subLines.map((sub) => (
            <div
              key={sub.key}
              className="grid gap-2 border-t border-zinc-700/40 pt-2 md:grid-cols-[minmax(0,1fr)_minmax(280px,40%)]"
            >
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-zinc-300">{sub.line}</div>
                <div className="mt-0.5 text-[11px] text-zinc-500">{sub.detail}</div>
              </div>
              <ActionColumn entry={sub.action} onFired={onFired} />
            </div>
          ))
        : <ActionColumn entry={item.action} onFired={onFired} />}
    </div>
  );
}

/** One bucket section: header (rank · name · count · why), then the trust
 * branch — UNKNOWN on an unproven bucket, a muted asserted zero, or the
 * items in the server's within-bucket order. */
function BucketSection({ summary, items, onFired, onDismissStart }) {
  const unproved = !summary.wired || !summary.sourcesOk;
  return (
    <div>
      <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2 text-xs uppercase tracking-wide text-zinc-400">
        <span className="font-mono normal-case text-zinc-500">rank {summary.rank}</span>
        <span>{summary.bucket.replace(/-/g, " ")}</span>
        <span className="rounded bg-zinc-700/60 px-1.5 text-[11px] tracking-normal text-zinc-300">
          {summary.count}
        </span>
        <span className="text-[11px] font-normal normal-case tracking-normal text-zinc-500">
          — {BUCKET_WHY[summary.bucket]}
        </span>
      </h3>
      {unproved ? (
        <div className="rounded-md border border-zinc-700 bg-zinc-800 p-2.5 text-xs">
          <div className="font-semibold text-zinc-300">UNKNOWN</div>
          <div className="text-zinc-500">
            {summary.wired ? "can't confirm this bucket is current" : "not wired yet"}
            {summary.sourceErrors.length > 0 && (
              <span className="ml-1 break-all font-mono text-[11px] text-zinc-600">
                {summary.sourceErrors.join(" · ")}
              </span>
            )}
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs italic text-zinc-600">nothing crossed</p>
      ) : (
        <div>
          {items.map((item) =>
            isAggregate(item) ? (
              <AggregateWell key={item.id} item={item} onFired={onFired} onDismissStart={onDismissStart} />
            ) : (
              <FeedItem key={item.id} item={item} onFired={onFired} onDismissStart={onDismissStart} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function AttentionFeed() {
  const { items, data, status, error, loading, refresh } = usePageItems("/attention/feed", {
    poll: 30_000,
    // ADR-0034 §5: attention data is a minutes-tier surface — a payload
    // older than 5 min is stale (crossings may have changed since).
    freshnessMs: 5 * 60 * 1000,
  });

  const [dismissError, setDismissError] = useState(null);
  const undoWindow = useDelayedCommit();

  // The typed dismiss (ADR-0034 §8.4): { reason, key } is the strict #4627
  // body — the legacy free-text { reason, signal } is a 400 there. Fires
  // through this component's own apiFetch (the confirmed-write fence),
  // then refreshes; a failure surfaces inline, persistently.
  const dismissItem = useCallback(
    async (item, reason) => {
      try {
        await apiFetch(`/attention/${encodeURIComponent(item.id)}/dismiss`, {
          method: "POST",
          body: JSON.stringify({ reason, key: item.key }),
        });
        await refresh();
      } catch (err) {
        /* intentional: the inline dismiss-failed banner is the failure
           surface — visible until the next attempt, never a silent catch */
        setDismissError(`${item.title}: ${err?.message ?? String(err)}`);
      }
    },
    [refresh],
  );

  // The dismiss row's entry point: arm the delayed-commit window with the
  // clicked (item, reason) captured in the closure, so the 5 s expiry can
  // never fire a stale pair after a re-render.
  const onDismissStart = useCallback(
    (item, reason) =>
      undoWindow.start(`Dismissing · ${reason.label}`, () => dismissItem(item, reason.value)),
    [undoWindow.start, dismissItem],
  );

  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];

  return (
    <Section
      title="Needs attention"
      subtitle="Fixed bucket drain order; each bucket says why it ranks where it does. Dismiss with a typed reason."
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      // A failed/absent WHOLE payload keeps the Section-level UNKNOWN path;
      // a payload that exists renders per-bucket UNKNOWN blocks instead
      // (ADR-0034 §5.2 — the partial failure names its bucket, and the
      // proven buckets keep rendering).
      unknown={status === "unknown" && !data}
      stale={status === "stale"}
      generatedAt={data?.generatedAt}
    >
      {dismissError && (
        <div className="mb-2 break-all font-mono text-xs text-red-300">
          dismiss failed: {dismissError}
        </div>
      )}
      <div className="grid gap-5">
        {buckets.map((summary) => (
          <BucketSection
            key={summary.bucket}
            summary={summary}
            items={items.filter((item) => item.bucket === summary.bucket)}
            onFired={refresh}
            onDismissStart={onDismissStart}
          />
        ))}
      </div>
      <DelayedCommitToast pending={undoWindow.pending} onUndo={undoWindow.undo} />
    </Section>
  );
}
