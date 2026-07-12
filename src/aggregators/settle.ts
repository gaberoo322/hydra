/**
 * Back-compat re-export for the settled-fold contract (issue #3216).
 *
 * The settled-fold utility was relocated from this aggregators-namespaced path
 * to the flat `src/` root — `src/settled-fold.ts` — because "degrade a
 * `Promise.allSettled` slice to a safe fallback while logging the rejection" is
 * a general async utility, not an aggregators-domain concept (a cross-group
 * caller like `src/autopilot/status.ts` should not have to reach into the
 * `aggregators` group to use it). This file remains as a thin re-export (per
 * the #2125 precedent) so the historical `./settle.ts` / `../aggregators/settle.ts`
 * import path keeps resolving. New callers should import from
 * `src/settled-fold.ts` directly.
 */
export { settle, settledOr, settledOrEmpty, settledOrNull } from "../settled-fold.ts";
