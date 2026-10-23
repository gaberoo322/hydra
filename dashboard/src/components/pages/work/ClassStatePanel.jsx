import { useMemo } from "react";
import { usePageItems } from "../../../hooks/usePageItems.js";
import { useApi } from "../../../hooks/useApi.js";
import { Section } from "../today/Section.jsx";
import LocalTimestamp from "../../LocalTimestamp.jsx";
import { ActionAffordance } from "../../ActionAffordance.jsx";
import { formatElapsed } from "../../../lib/autopilot-format.js";

/**
 * ClassStatePanel — /work's live per-class panel (issue #4637, ADR-0034 §9.2).
 *
 * The question: *what is every autopilot dispatch class doing right now, and
 * why?* One row per Dispatch-Class Taxonomy class, exactly as
 * GET /api/autopilot/class-state returns them (server order, every class,
 * nothing filtered or added), plus the global gates rendered ONCE in the
 * panel header.
 *
 * Server-verbatim (INV-2): cooldownRemainingSeconds, verdictFreshness,
 * starved and dead render exactly as the server computed them — this panel
 * never re-derives a cooldown, a freshness budget or a badge on the client.
 *
 * Trust contract (ADR-0034 §5, INV-3/INV-4): status rides usePageItems +
 * derivePageStatus, so a failed fetch or a missing generatedAt renders
 * UNKNOWN, never an empty table. The visible as-of is header.verdictAsOf (the
 * latest Autopilot Turn's epoch), flagged stale when the server says the
 * verdicts are stale; with no active run the header says so and the as-of
 * falls back to generatedAt. With no active run every verdict renders the
 * literal UNKNOWN; last-fired and cooldown remaining render regardless of
 * verdict freshness (never demoted).
 *
 * No dispatch, no run-now (ADR-0012, INV-5): the only per-row affordance is
 * the registry's `class:<name>` entry's recommended terminal-skill action,
 * rendered through the one ActionAffordance component (copy-only). The
 * registry is read client-side from GET /api/operator-actions (default-variant
 * entries indexed by key); a missing entry renders a visible marker.
 *
 * Anti-scope (ADR-0034 §2): live current-run state only — no run history, no
 * turn list, no failure output (/runs owns forensics).
 */

/** Render a nullable header value; null is UNKNOWN, never a confident zero. */
function orUnknown(value, render = (v) => v) {
  return value === null || value === undefined ? (
    <span className="text-zinc-500">UNKNOWN</span>
  ) : (
    render(value)
  );
}

function ClassStateHeader({ header }) {
  const run = header?.run ?? null;
  const usage = header?.usage ?? null;
  const degraded = Array.isArray(header?.degraded) ? header.degraded : [];
  return (
    <dl
      data-testid="class-state-header"
      className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 text-xs mb-4"
    >
      <div>
        <dt className="text-zinc-500 uppercase tracking-wide">Run</dt>
        <dd className="text-zinc-200">
          {run === null ? (
            <span data-testid="class-state-no-run" className="text-zinc-400">
              no active run
            </span>
          ) : (
            <>
              <span className="font-mono" title={run.runId}>
                {String(run.runId).slice(0, 8)}
              </span>{" "}
              · {run.lifecycle} · turn {orUnknown(run.latestTurnN)}
            </>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-zinc-500 uppercase tracking-wide">Scope</dt>
        <dd className="text-zinc-200 font-mono">{orUnknown(header?.scope)}</dd>
      </div>
      <div>
        <dt className="text-zinc-500 uppercase tracking-wide">Usage gate</dt>
        <dd className="text-zinc-200">
          {orUnknown(usage, (u) => (
            <>
              {u.allow ? "allow" : <span className="text-amber-300">blocked</span>}
              {" · shed: "}
              <span className="font-mono">{u.shed.length > 0 ? u.shed.join(", ") : "none"}</span>
            </>
          ))}
        </dd>
      </div>
      <div>
        <dt className="text-zinc-500 uppercase tracking-wide">Burned classes</dt>
        <dd className="text-zinc-200 font-mono">
          {orUnknown(header?.burnedClasses, (b) => (b.length > 0 ? b.join(", ") : "none"))}
        </dd>
      </div>
      <div>
        <dt className="text-zinc-500 uppercase tracking-wide">Quota delta cap</dt>
        <dd className="text-zinc-200 font-mono">
          {orUnknown(header?.quotaDeltaCap, (q) => `5h ${q.fiveHourMaxPts} pts · week ${q.weekMaxPts} pts`)}
        </dd>
      </div>
      {degraded.length > 0 && (
        <div data-testid="class-state-degraded">
          <dt className="text-zinc-500 uppercase tracking-wide">Degraded sources</dt>
          <dd className="text-amber-300 font-mono">{degraded.join(", ")}</dd>
        </div>
      )}
    </dl>
  );
}

/** Verdict cell — freshness and verdict render verbatim from the server. */
function VerdictCell({ row }) {
  if (row.verdictFreshness === "not-evaluated") {
    return <span className="text-zinc-500 italic">not evaluated this turn</span>;
  }
  if (row.verdictFreshness === "unknown" || row.verdict === null || row.verdict === undefined) {
    return <span className="text-zinc-500">UNKNOWN</span>;
  }
  return (
    <span>
      <span className="font-mono text-zinc-200">{row.verdict.outcome}</span>
      {row.verdict.reason ? <span className="text-zinc-400"> — {row.verdict.reason}</span> : null}
      {row.verdictFreshness === "stale" && (
        <span className="ml-1 text-[10px] uppercase tracking-widest text-amber-400">stale</span>
      )}
    </span>
  );
}

/** Cooldown remaining — the server's number, formatted only. */
function CooldownCell({ row }) {
  if (row.kind === "pipeline") return <span className="text-zinc-600">—</span>;
  const s = row.cooldownRemainingSeconds;
  if (s === null || s === undefined) return <span className="text-zinc-500">UNKNOWN</span>;
  if (s === 0) return <span className="text-emerald-300">ready</span>;
  return <span className="font-mono text-amber-300">{formatElapsed(s)}</span>;
}

/** Slot occupant (pipeline rows) — omitted when the server omits the key. */
function OccupantCell({ row }) {
  if (row.kind !== "pipeline" || !("slotOccupant" in row)) return null;
  const occ = row.slotOccupant;
  if (occ === null) return <span className="text-zinc-500">free</span>;
  const skill = occ?.skill ?? "(claimed)";
  const branch = occ?.branch ?? occ?.worktreeBranch ?? null;
  return (
    <span className="text-zinc-200" title={branch ?? undefined}>
      {skill}
      {branch && <span className="block font-mono text-[10px] text-zinc-500 truncate max-w-[14rem]">{branch}</span>}
    </span>
  );
}

function ManualCommandCell({ row, registry }) {
  const key = `class:${row.name}`;
  if (registry.state === "loading") return <span className="text-zinc-600">…</span>;
  if (registry.state === "unknown") {
    return <span className="text-zinc-500 text-xs">registry UNKNOWN</span>;
  }
  const entry = registry.byKey.get(key);
  if (!entry) {
    return (
      <span data-testid={`class-state-missing-entry-${row.name}`} className="text-red-400 text-xs font-mono">
        no class: entry
      </span>
    );
  }
  return <ActionAffordance action={entry.recommended} doc={entry.doc} />;
}

export function ClassStatePanel() {
  const { items, data, status, error, loading } = usePageItems("/autopilot/class-state", {
    itemsKey: "classes",
    poll: 60_000,
  });

  // The class:<name> registry entries — read once (the registry is a
  // checked-in, import-time-frozen table; it cannot change under a live page).
  const actions = useApi("/operator-actions");
  const registry = useMemo(() => {
    if (actions.loading && !actions.data) return { state: "loading", byKey: new Map() };
    if (!actions.data || !Array.isArray(actions.data.entries)) {
      return { state: "unknown", byKey: new Map() };
    }
    const byKey = new Map();
    for (const entry of actions.data.entries) {
      // Default-variant entries only (a variant is a situational override).
      if (entry && entry.variant === undefined) byKey.set(entry.key, entry);
    }
    return { state: "ready", byKey };
  }, [actions.data, actions.loading]);

  const header = data?.header ?? null;
  const verdictAsOf = header?.verdictAsOf ?? null;
  const asOf = verdictAsOf ?? data?.generatedAt;
  const stale = status === "stale" || header?.verdictFreshness === "stale";

  return (
    <Section
      title="Autopilot classes"
      subtitle={
        verdictAsOf
          ? "Every dispatch class's live verdict, cooldown and slot — as of the latest autopilot turn."
          : "Every dispatch class's last-fired and cooldown — no active run, so every verdict is UNKNOWN (as of compose time)."
      }
      count={items.length}
      loading={loading}
      error={status === "stale" ? null : error}
      empty={status === "empty"}
      unknown={status === "unknown"}
      stale={stale}
      generatedAt={asOf}
      emptyMessage="The taxonomy served zero classes (asserted by scanned) — nothing to show."
    >
      <div data-testid="class-state-panel">
        <ClassStateHeader header={header} />
        <div className="overflow-x-auto">
          <table data-testid="class-state-table" className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-zinc-700">
                <th className="py-2 pr-3 font-normal">Class</th>
                <th className="py-2 pr-3 font-normal">Scope</th>
                <th className="py-2 pr-3 font-normal">Skill</th>
                <th className="py-2 pr-3 font-normal">Verdict (why / why not)</th>
                <th className="py-2 pr-3 font-normal">Last fired</th>
                <th className="py-2 pr-3 font-normal">Cooldown left</th>
                <th className="py-2 pr-3 font-normal">Slot</th>
                <th className="py-2 pr-3 font-normal">Run by hand</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-700/50">
              {items.map((row) => (
                <tr key={row.name} data-testid={`class-state-row-${row.name}`} className="align-top">
                  <td className="py-1.5 pr-3">
                    <span className="font-mono text-zinc-100">{row.name}</span>{" "}
                    <span
                      className={`text-[10px] uppercase tracking-widest px-1 rounded ${
                        row.kind === "pipeline" ? "bg-sky-900/40 text-sky-300" : "bg-violet-900/40 text-violet-300"
                      }`}
                    >
                      {row.kind}
                    </span>
                    {row.starved === true && (
                      <span className="ml-1 text-[10px] uppercase tracking-widest px-1 rounded bg-amber-900/40 text-amber-300">
                        starved
                      </span>
                    )}
                    {row.dead === true && (
                      <span
                        className="ml-1 text-[10px] uppercase tracking-widest px-1 rounded bg-red-900/40 text-red-300"
                        title={row.deadReason ?? undefined}
                      >
                        dead
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-zinc-400">{row.scope}</td>
                  <td className="py-1.5 pr-3 font-mono text-zinc-400">{row.skill}</td>
                  <td className="py-1.5 pr-3">
                    <VerdictCell row={row} />
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-300">
                    {row.lastFiredEpoch === null || row.lastFiredEpoch === undefined ? (
                      <span className="text-zinc-500">never</span>
                    ) : (
                      <LocalTimestamp ts={row.lastFiredEpoch} />
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <CooldownCell row={row} />
                  </td>
                  <td className="py-1.5 pr-3">
                    <OccupantCell row={row} />
                  </td>
                  <td className="py-1.5 pr-3">
                    <ManualCommandCell row={row} registry={registry} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}
