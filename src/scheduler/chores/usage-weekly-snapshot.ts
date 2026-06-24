/**
 * Weekly usage-snapshot chore (issue #2404).
 *
 * One of the Housekeeping chore family (`src/scheduler/chores/`). It samples the
 * Subscription Usage Tracker's current per-skill cross-tab (`bySkillByModel`),
 * reduces it to per-skill RAW token totals, and PERSISTS that under the current
 * ISO week via the typed `src/redis/usage-snapshots.ts` accessor — the ONE new
 * Redis write the issue allows, performed HERE (a chore) rather than in the pure
 * read-side tracker (ADR-0021 / CONTEXT.md).
 *
 * This persisted history is what the week-over-week per-skill trend
 * (`UsageSnapshot.bySkillWoW`) reads back: a given week's snapshot is compared
 * against the immediately-prior stored week. The chore runs on a WEEKLY cadence
 * guard (read at the housekeeping composition level, mirroring `weekly-summary`),
 * so an hourly housekeeping invocation snapshots at most once per ISO week. The
 * write is idempotent on the ISO-week key, so even a guard miss-fire is harmless.
 */

interface UsageWeeklySnapshotModule {
  getUsage: (opts?: { now?: Date }) => Promise<{
    bySkillByModel: Record<string, Record<string, { total: number }>>;
  }>;
  writeWeeklyUsageSnapshot: (snapshot: {
    isoWeek: string;
    takenAt: string;
    bySkill: Record<string, number>;
  }) => Promise<void>;
  isoWeekLabel: (at: Date) => string;
}

/** External touchpoints of the usage-weekly-snapshot chore. */
export interface UsageWeeklySnapshotDeps {
  module?: UsageWeeklySnapshotModule;
  now?: () => Date;
}

/**
 * Sample the current per-skill cross-tab and persist this ISO week's per-skill
 * raw-token rollup. Returns `true` (counts as `ran`) on a successful write.
 *
 * The per-skill total is the sum over ALL model families of the skill's row in
 * `bySkillByModel` — RAW counts only (no quota-weight, no USD), matching the
 * cross-tab's read-only posture. The weekly cadence is enforced by the
 * housekeeping-level time-guard; the write itself is idempotent on the ISO-week
 * key.
 */
export async function runUsageWeeklySnapshot(
  deps: UsageWeeklySnapshotDeps = {},
): Promise<boolean> {
  const mod =
    deps.module ??
    ({
      ...(await import("../../cost/index.ts")),
      ...(await import("../../redis/usage-snapshots.ts")),
    } as unknown as UsageWeeklySnapshotModule);
  const now = (deps.now ?? (() => new Date()))();

  const snapshot = await mod.getUsage({ now });
  const bySkillByModel = snapshot.bySkillByModel ?? {};

  const bySkill: Record<string, number> = {};
  for (const skill of Object.keys(bySkillByModel)) {
    const row = bySkillByModel[skill] ?? {};
    bySkill[skill] = Object.values(row).reduce(
      (sum, fam) => sum + (fam?.total ?? 0),
      0,
    );
  }

  const isoWeek = mod.isoWeekLabel(now);
  await mod.writeWeeklyUsageSnapshot({
    isoWeek,
    takenAt: now.toISOString(),
    bySkill,
  });
  return true;
}
