import { useState } from "react";
import { useServerConfirmedWrite } from "../../../hooks/useApi.js";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { Section } from "../today/Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * HoldbackEnrolState — /work's read-only Outcome Holdback enrol-state panel
 * (issue #4633 INV-9/INV-10, ADR-0034 §8.1/§9.4; substrate #4632).
 *
 * Post-merge rows (one per merged SHA) with the enrol state the merge-watch
 * automation recorded: enrolled | exempt | no-signal | retrying | failed.
 * Holdback enrolment is AUTOMATION, not an attention bucket (ADR-0034 §8.1)
 * — this panel is state, not a feed row, and src/attention.ts is untouched.
 *
 * The ONE write: "Enrol now" renders iff `row.state === 'failed'`. It is a
 * local confirm-first control (arm → Confirm / Cancel, the HitlGrillLane
 * pattern) that POSTs /holdback/enroll { commitSha, prNumber, tier } through
 * useServerConfirmedWrite; the new state renders ONLY from the re-read
 * (server-confirmed, ADR-0034 §7). It deliberately does not ride
 * ActionAffordance: that component's request bodies are a static map that
 * cannot carry a per-row commitSha — the registry/affordance wiring is
 * deferred to #4638's rung-1 classification of POST /holdback/enroll.
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
  const enrol = useServerConfirmedWrite(enrolments.refresh);
  const [armed, setArmed] = useState(null); // commitSha | null
  const [lastWrite, setLastWrite] = useState(null); // { commitSha, ok, error }

  async function confirmEnrol(row) {
    const result = await enrol.write("/holdback/enroll", {
      commitSha: row.commitSha,
      prNumber: row.prNumber,
      tier: row.tier,
    });
    setArmed(null);
    setLastWrite({ commitSha: row.commitSha, ok: result.ok, error: result.error });
    // A rejected enrol still records its attempt reason server-side — re-read
    // so a persisting 'failed' row shows it (the hook only re-reads on success).
    if (!result.ok) await enrolments.refresh();
  }

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
      {/* The write's outcome: a rejected request surfaces verbatim; a landed
          one says only that it was sent — the row's state line (from the
          re-read) is the confirmed result. */}
      {lastWrite && (
        <p
          data-testid="holdback-enrol-result"
          data-ok={lastWrite.ok ? "true" : "false"}
          className={`mb-3 text-xs ${lastWrite.ok ? "text-zinc-400" : "text-red-300"}`}
        >
          {lastWrite.ok
            ? `Enrol now sent for ${lastWrite.commitSha.slice(0, 7)} — the row below shows the re-read state.`
            : `✗ Enrol now for ${lastWrite.commitSha.slice(0, 7)} failed: ${lastWrite.error}`}
        </p>
      )}

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
                {armed === row.commitSha ? (
                  <>
                    <button
                      type="button"
                      data-testid="holdback-enrol-confirm-yes"
                      disabled={enrol.pending}
                      onClick={() => confirmEnrol(row)}
                      className="rounded-md border border-emerald-500/60 px-2 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      {enrol.pending ? "enrolling…" : "Confirm Enrol now?"}
                    </button>
                    <button
                      type="button"
                      data-testid="holdback-enrol-confirm-no"
                      disabled={enrol.pending}
                      onClick={() => setArmed(null)}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid="holdback-enrol-arm"
                    disabled={enrol.pending}
                    onClick={() => setArmed(row.commitSha)}
                    className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                  >
                    Enrol now…
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
