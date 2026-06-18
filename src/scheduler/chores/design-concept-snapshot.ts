/**
 * Daily design-concept snapshot chore (issue #628; metric revised in #736).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`) — extracted
 * from `src/scheduler/housekeeping.ts` (issue #2090). Behaviour unchanged.
 */

interface DesignConceptSnapshotModule {
  getDesignConceptProductionCountForDate: (date: string) => Promise<number>;
  writeDailySnapshot: (date: string, count: number) => Promise<unknown>;
  readDailySnapshots: () => Promise<Array<{ date: string; count: number }>>;
}

/** External touchpoints of the design-concept-snapshot chore. */
export interface DesignConceptSnapshotDeps {
  module?: DesignConceptSnapshotModule;
  today?: () => string;
}

/**
 * Daily design-concept snapshot (issue #628; metric revised in #736) — record
 * today's *production count* (how many concepts were created today) so the
 * green-light criterion measures the gate WORKING rather than "an artifact
 * happens to be alive".
 *
 * Idempotent + monotone (the #736 invariant): a same-day re-run only WRITES
 * when the freshly-sampled production count is higher than what's already
 * stored for today. A no-change re-run returns `false` so the runner records it
 * as "skipped", keeping hourly housekeeping idempotent.
 */
export async function runDesignConceptSnapshot(
  deps: DesignConceptSnapshotDeps = {},
): Promise<boolean> {
  const mod = deps.module ?? (await import("../../redis/design-concept.ts"));
  const today = (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const count = await mod.getDesignConceptProductionCountForDate(today);
  const existing = await mod.readDailySnapshots();
  const stored = existing.find((s) => s.date === today)?.count;
  if (stored === undefined || count > stored) {
    await mod.writeDailySnapshot(today, count);
    return true;
  }
  return false;
}
