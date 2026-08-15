import LocalTimestamp from "../../LocalTimestamp.jsx";

/**
 * DeployAxes — the /health page's deploy-state block (issue #4008, ADR-0034
 * §2 "/health" contract).
 *
 * Deploy state renders as TWO ORTHOGONAL AXES, never one combined status
 * light (design-concept 2880e735 INV-3): the Argo CD pattern — one light
 * cannot express "deployed the wrong thing but running fine".
 *
 *   DRIFT  — does the deployed SHA match origin/master?
 *   HEALTH — is the service actually working?
 *
 * Drift is computed CLIENT-SIDE here (INV-2, ADR-0034 §5 rule 3): the server
 * ships the two RAW SHAs (`deployedSha` / `originMasterSha`) verbatim and the
 * derived boolean never exists server-side detached from its decomposable
 * inputs. When EITHER SHA is null the axis renders UNKNOWN — never a
 * confident in-sync/drifted claim (INV-4).
 *
 * Phone-grade: two stacked cards, big chips, short SHAs (full SHA on hover),
 * everything wraps — no horizontal scroll at 390px (INV-9).
 */

const SHORT = (sha) => (typeof sha === "string" && sha.length > 0 ? sha.slice(0, 7) : null);

const CHIP = {
  good: "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40",
  bad: "bg-rose-500/10 text-rose-300 border border-rose-500/40",
  warn: "bg-amber-500/10 text-amber-300 border border-amber-500/40",
  unknown: "bg-zinc-700/40 text-zinc-400 border border-zinc-600",
};

function Axis({ testId, label, chipStyle, chipLabel, children }) {
  return (
    <div
      data-testid={testId}
      data-state={chipLabel}
      className="bg-zinc-900/40 rounded-md border border-zinc-700 p-3 sm:p-4 min-w-0"
    >
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">{label}</div>
      <span
        className={`inline-block rounded-md px-3 py-1.5 text-base sm:text-lg font-bold tracking-wide ${chipStyle}`}
      >
        {chipLabel}
      </span>
      <div className="mt-2 text-xs text-zinc-500 min-w-0 break-words">{children}</div>
    </div>
  );
}

export default function DeployAxes({ data, status }) {
  // status: "loading" | "unknown" | "stale" | "ready" (derived by the page via
  // the shared trust seam — ADR-0034 §5).
  const stale = status === "stale";
  const unknown = status === "loading" || status === "unknown";

  // ---- DRIFT axis (INV-2: client-side decomposition; INV-4: null → UNKNOWN) --
  const deployed = SHORT(data?.deployedSha);
  const origin = SHORT(data?.originMasterSha);
  const driftState = unknown
    ? "UNKNOWN"
    : deployed && origin
      ? (data.deployedSha === data.originMasterSha ? "IN SYNC" : "DRIFTED")
      : "UNKNOWN";

  // ---- HEALTH axis (orthogonal — service working, independent of drift) ----
  const healthState = unknown
    ? "UNKNOWN"
    : data?.status === "killed"
      ? "KILLED"
      : data?.redis === false
        ? "DOWN"
        : data?.status === "ok" && data?.redis === true
          ? "HEALTHY"
          : "UNKNOWN";

  return (
    <section data-testid="deploy-axes" className="space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="text-sm uppercase tracking-wide text-zinc-400">Deploy</h2>
        {/* ADR-0034 §5.4 — as-of age always visible, every status branch. */}
        {data?.generatedAt && (
          <div className="text-xs text-zinc-500">
            {stale && <span className="text-amber-400">stale · </span>}
            as of <LocalTimestamp ts={data.generatedAt} stale={stale} />
          </div>
        )}
      </div>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        <Axis
          testId="drift-axis"
          label="Drift — deployed vs origin/master"
          chipStyle={
            driftState === "IN SYNC"
              ? CHIP.good
              : driftState === "DRIFTED"
                ? CHIP.warn
                : CHIP.unknown
          }
          chipLabel={driftState}
        >
          {driftState === "UNKNOWN" ? (
            <span data-testid="drift-shas">a SHA is unavailable — can&apos;t verify</span>
          ) : (
            <span data-testid="drift-shas" className="font-mono">
              <span title={data?.deployedSha ?? undefined}>{deployed}</span>
              {" vs "}
              <span title={data?.originMasterSha ?? undefined}>{origin}</span>
            </span>
          )}
        </Axis>
        <Axis
          testId="health-axis"
          label="Health — is the service working"
          chipStyle={
            healthState === "HEALTHY"
              ? CHIP.good
              : healthState === "UNKNOWN"
                ? CHIP.unknown
                : CHIP.bad
          }
          chipLabel={healthState}
        >
          {data ? (
            <span data-testid="health-fact">
              api {String(data.status)}
              {" · "}
              redis {String(data.redis)}
            </span>
          ) : (
            <span data-testid="health-fact">no reading yet</span>
          )}
        </Axis>
      </div>
    </section>
  );
}
