/**
 * Outcome-Holdback tier-enrollment policy (issue #2671, mirroring the #2507
 * `src/outcome-regression.ts` extraction).
 *
 * This module owns the *pure* Outcome Holdback enrollment policy: which tiers
 * enroll in an Outcome Holdback watch, and how long the watch window runs for a
 * given tier. Both predicates are deterministic tier-membership / watch-window
 * arithmetic over env-read constants — no Redis I/O, no filesystem, no event
 * bus. They previously lived in `src/redis/holdback.ts` (a Redis Adapter),
 * which violated the Redis Adapters Seam contract (CLAUDE.md: the typed accessor
 * family owns storage, not policy). Relocating them here concentrates the policy
 * where its name matches the concept and lets a caller test "T1 never enrolls,
 * T2/T3/T4 always enroll" as a pure unit test with no Redis fixture.
 *
 * No behaviour change — the predicate logic is byte-for-byte relocated, not
 * modified. `src/redis/holdback.ts` retains only storage operations; both
 * callers (`src/holdback.ts`, `src/scheduler/chores/holdback-merge-watch.ts`)
 * import the policy from here.
 *
 * Per CLAUDE.md conventions: this module has ZERO Redis import-time side effect —
 * importing it never opens a connection.
 */

// ---------------------------------------------------------------------------
// Tunables (ADR-0005 — named, not magic literals; env-overridable so #741 can
// layer a tier-aware window map on top without editing code).
// ---------------------------------------------------------------------------

/**
 * Default watch window length in autopilot cycles for the T2 floor (ADR-0004
 * step-4 default + `outcomes.yaml` schema comment). This is the **floor** of
 * the tier-aware window map (#741): deeper tiers watch at least as long. See
 * {@link windowCyclesForTier} for the carry-up.
 */
export const HOLDBACK_WINDOW_CYCLES = numFromEnv("HYDRA_HOLDBACK_WINDOW_CYCLES", 5);

/**
 * Tier-aware watch windows (#741, ADR-0015 monotonic ladder). Outcome Holdback
 * "carries up" the ladder: every tier deeper than T1 enrolls, and the deeper
 * the blast radius the longer the post-merge watch. The window is monotonic in
 * tier depth — `window(T4) >= window(T3) >= window(T2)` — with the existing
 * 5-cycle T2 value as the floor (clamped at read time, so a misconfigured env
 * override can never make a deeper tier watch for *less* time).
 *
 * Defaults: T2=5 (floor), T3=7, T4=10. All env-overridable (ADR-0005 — named,
 * not magic literals), documented in `config/direction/outcomes.yaml`.
 */
export const HOLDBACK_WINDOW_CYCLES_T3 = numFromEnv("HYDRA_HOLDBACK_WINDOW_CYCLES_T3", 7);
export const HOLDBACK_WINDOW_CYCLES_T4 = numFromEnv("HYDRA_HOLDBACK_WINDOW_CYCLES_T4", 10);

/**
 * The tiers that enroll in Outcome Holdback. T1 (prompt-shaped) is exempt — too
 * low signal-to-noise for a leading-outcome watch to attribute regressions
 * (ADR-0004 reasoning, preserved by ADR-0015). The carry-up applies to
 * **T2, T3, T4 only**.
 */
const HOLDBACK_ENROLLED_TIERS: ReadonlyArray<number> = [2, 3, 4];

/**
 * True when a merge of the given post-#767 monotonic tier enrolls in Outcome
 * Holdback. T1 → false; T2/T3/T4 → true; null/unknown → false (a merge whose
 * tier we cannot resolve is treated as "no signal" rather than over-watched —
 * matches the no-false-holdback posture elsewhere in this seam).
 */
export function isEnrolledTier(tier: number | null | undefined): boolean {
  return tier != null && HOLDBACK_ENROLLED_TIERS.includes(tier);
}

/**
 * The watch-window length (in autopilot cycles) for a merged diff's tier.
 *
 * Monotonic and floor-clamped: T2 is the floor (`HOLDBACK_WINDOW_CYCLES`), T3
 * is at least the T2 window, and T4 is at least the T3 window — even if an
 * operator's env override would otherwise invert the order. T1 and
 * null/unknown fall back to the T2 floor (they never actually enroll; this is
 * a safe default for any caller that asks anyway).
 */
export function windowCyclesForTier(tier: number | null | undefined): number {
  const t2 = HOLDBACK_WINDOW_CYCLES;
  if (tier === 3) return Math.max(HOLDBACK_WINDOW_CYCLES_T3, t2);
  if (tier === 4) {
    const t3 = Math.max(HOLDBACK_WINDOW_CYCLES_T3, t2);
    return Math.max(HOLDBACK_WINDOW_CYCLES_T4, t3);
  }
  // T2, T1, null/unknown → the floor.
  return t2;
}

function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
