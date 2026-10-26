import { useCallback } from "react";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { ControlAffordance, useCheckedRefresh, useOperatorActions } from "../../ActionAffordance.jsx";
import { enrolVerdicts } from "../../../lib/control-verdicts.ts";

/**
 * HoldbackEnrolState — /work's Outcome Holdback enrol-state panel
 * (issue #4633 INV-9/INV-10, ADR-0034 §8.1/§9.4; substrate #4632).
 *
 * Post-merge rows (one per merged SHA) with the enrol state the merge-watch
 * automation recorded: enrolled | exempt | no-signal | retrying | failed.
 * Holdback enrolment is AUTOMATION, not an attention bucket (ADR-0034 §8.1)
 * — this panel is state, not a feed row, and src/attention.ts is untouched.
 *
 * The ONE write: the enrol control renders iff `row.state === 'failed'`. It is the
 * registry's `control:work/holdback-enroll` entry (confirm-first; issue #5164,
 * ADR-0034 §9.1) rendered through ControlAffordance — the per-row
 * { commitSha, prNumber, tier } body comes from the closed IN_DASHBOARD_BODY
 * builder over the `context` below. The new state renders ONLY from the
 * checked re-read (server-confirmed, ADR-0034 §7); a REJECTED enrol still
 * re-reads so a persisting 'failed' row shows the attempt reason the server
 * recorded.
 *
 * Trust seam (INV-11): usePageItems + Section; no direct fetch outside
 * apiFetch/useApi.
 */
export function HoldbackEnrolState() {
  const enrolments = usePageItems("/holdback/enrolments?limit=25", {
    itemsKey: "enrolments",
    poll: 60_000,
    freshnessMs: 5 * 60 * 1000,
  });
  const registry = useOperatorActions();
  const enrolmentsChecked = useCheckedRefresh(enrolments);
  // A rejected enrol never reaches onFired (the affordance's catch path) but
  // still records its attempt reason server-side — re-read so a persisting
  // 'failed' row shows it.
  const reReadOnReject = useCallback(
    (result) => {
      if (!result.ok) enrolments.refresh();
    },
    [enrolments.refresh],
  );

  return (
    <Section
      title="Holdback enrolment"
      subtitle="Post-merge Outcome Holdback enrol state, newest first — read-only automation state. Enrol now appears only on a failed enrolment."
      count={enrolments.items.length}
      loading={enrolments.loading}
      error={enrolments.status === "stale" ? null : enrolments.error}
      empty={enrolments.status === "empty"}
      unknown={enrolments.status === "unknown"}
      stale={enrolments.status === "stale"}
      generatedAt={enrolments.data?.generatedAt}
      emptyMessage="No enrol-state records — the merge-watch store was read and holds none."
    >
      <ul className="space-y-2">
        {enrolments.items.map((row) => (
          <li
            key={row.commitSha}
            data-testid="holdback-enrol-row"
            className="flex flex-col gap-2 rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="font-mono text-zinc-300">{row.commitSha.slice(0, 7)}</span>
                <span className="text-zinc-400">
                  {row.prNumber != null ? `PR #${row.prNumber}` : "PR —"}
                </span>
                <span className="text-zinc-500">
                  {row.tier != null ? `T${row.tier}` : "tier —"}
                </span>
                <span className="text-zinc-500">{row.source}</span>
                <span
                  data-testid="holdback-enrol-state"
                  className={`rounded px-1.5 py-0.5 ${
                    row.state === "failed"
                      ? "bg-red-500/15 text-red-300"
                      : "bg-zinc-700/60 text-zinc-300"
                  }`}
                >
                  {row.state}
                </span>
                <span className="text-zinc-500">attempts {row.attempts}</span>
                <span className="text-zinc-500">
                  <LocalTimestamp ts={row.updatedAt} />
                </span>
              </div>
              {row.reason && (
                <p className="mt-1 text-xs text-zinc-500">reason: {row.reason}</p>
              )}
            </div>

            {row.state === "failed" && (
              <div className="flex shrink-0 items-center gap-2">
                <ControlAffordance
                  registry={registry}
                  controlKey="control:work/holdback-enroll"
                  testId="holdback-enrol"
                  verdicts={enrolVerdicts(row)}
                  context={{ commitSha: row.commitSha, prNumber: row.prNumber, tier: row.tier }}
                  onFired={enrolmentsChecked}
                  onResult={reReadOnReject}
                  rereadNoun="enrolments"
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
