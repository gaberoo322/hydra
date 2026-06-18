/**
 * Merge→done reconciler chore (issue #1715).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

/** Per-feed liveness + batch metrics shape returned by the reconciler (#2057). */
interface ReconcilerRunResult {
  reconciled: Array<{ id: string; ref: string }>;
  escalated?: Array<{ id: string; reason: string }>;
  scanned: number;
  feed?: {
    prs: { examined: number; failed?: string };
    commits: { examined: number; failed?: string };
  };
  metrics?: { referencesFound: number; movesFailed: number; durationMs: number };
  alert?: { code: string; message: string };
}

/** External touchpoints of the merged-item-reconciler chore. */
export interface MergedItemReconcilerDeps {
  reconcileMergedItems?: () => Promise<ReconcilerRunResult>;
  /** Persist the last-run health snapshot (issue #2057). Injected for tests. */
  setReconcilerHealth?: (record: import("../../redis/reconciler.ts").ReconcilerHealthRecord) => Promise<void>;
}

/**
 * Merge→done reconciler (issue #1715) — sweeps recently merged target PRs and
 * default-branch merge commits for `item-NNN` references and moves any
 * referenced item still in a non-done lane to `done` with audit stamps.
 * Fail-closed + idempotent, so no Redis time-guard is needed.
 *
 * Also runs the stale-claim escalation pass (issue #2031): items that are
 * unconfirmable-but-probably-shipped (far past a generous age, or claimed by a
 * retired claimant) are routed to `blocked` (operator-visible) — never silently
 * to `done` — so the claim path stops re-serving shipped/obsolete work.
 *
 * Observability (issue #2057): after every run it persists a structured
 * last-run health snapshot (feed liveness + batch metrics) so the
 * scheduler-status endpoint can surface reconciler liveness without re-running
 * the sweep. The persist is best-effort — a Redis write failure is logged but
 * never aborts the chore (the reconciler's own alert path already fired).
 */
export async function runMergedItemReconciler(deps: MergedItemReconcilerDeps = {}): Promise<void> {
  const reconcileMergedItems =
    deps.reconcileMergedItems ?? (await import("../../backlog/reconciler.ts")).reconcileMergedItems;
  const setHealth =
    deps.setReconcilerHealth ?? (await import("../../redis/reconciler.ts")).setReconcilerHealth;
  const rec = await reconcileMergedItems();
  if (rec.reconciled.length > 0) {
    console.log(
      `[Housekeeping] Merge→done reconciler: closed ${rec.reconciled.length} item${rec.reconciled.length === 1 ? "" : "s"} (scanned ${rec.scanned}): ${rec.reconciled.map((r) => `${r.id}←${r.ref}`).join(", ")}`,
    );
  }
  const esc = rec.escalated ?? [];
  if (esc.length > 0) {
    console.log(
      `[Housekeeping] Stale-claim escalation: routed ${esc.length} unconfirmable item${esc.length === 1 ? "" : "s"} to blocked (operator-attention): ${esc.map((e) => e.id).join(", ")}`,
    );
  }

  // Issue #2057: log batch metrics every run (even an empty one) so a stalled
  // reconciler is diagnosable from the journal, and persist the health snapshot
  // for the status endpoint. Fail-soft on the Redis write.
  const feed = rec.feed ?? { prs: { examined: 0 }, commits: { examined: 0 } };
  const metrics = rec.metrics ?? { referencesFound: 0, movesFailed: 0, durationMs: 0 };
  console.log(
    `[Housekeeping] Merge→done reconciler metrics: prs=${feed.prs.examined}${feed.prs.failed ? "(failed)" : ""} commits=${feed.commits.examined}${feed.commits.failed ? "(failed)" : ""} refs=${metrics.referencesFound} movesFailed=${metrics.movesFailed} duration=${metrics.durationMs}ms${rec.alert ? ` ALERT=${rec.alert.code}` : ""}`,
  );
  try {
    await setHealth({
      ranAt: new Date().toISOString(),
      feed,
      metrics: {
        referencesFound: metrics.referencesFound,
        movesFailed: metrics.movesFailed,
        itemsReconciled: rec.reconciled.length,
        itemsEscalated: esc.length,
        scanned: rec.scanned,
        durationMs: metrics.durationMs,
      },
      ...(rec.alert ? { alert: rec.alert } : {}),
    });
  } catch (err: any) {
    console.error(`[Housekeeping] Merge→done reconciler health persist failed: ${err?.message ?? err}`);
  }
}
