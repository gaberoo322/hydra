/**
 * Zod schemas for the dispatch -> issue cost-join HTTP surface (issue #4126,
 * ADR-0032 epic #4123 slice gamma). `src/api/usage.ts`'s pre-existing
 * `ForceQuerySchema` / `SessionBlockBodySchema` stay defined inline there
 * (out of this slice's additive-only scope); the two routes THIS slice adds
 * follow the documented convention (CLAUDE.md: "HTTP request bodies validate
 * through `src/schemas/<domain>.ts`") from the start.
 */

import { z } from "zod";

/**
 * Body schema for `POST /api/usage/dispatch-cost` — the reap-time writer.
 * `scripts/autopilot/reap.py`'s `run_completion` POSTs here once per
 * completed dispatch, alongside its existing `_fire_token_record` per-cycle
 * write (see that function's Python docstring for the full producer
 * contract). `issue: null` means reap could not resolve an anchor for this
 * dispatch; the route still records it — into the UNATTRIBUTED residual
 * ledger (`src/redis/cost.ts`'s `recordDispatchCostJoin`) — rather than
 * dropping it.
 *
 * `reapedAt` is deliberately NOT accepted from the caller: the route stamps
 * it server-side (`new Date().toISOString()`) so a skewed or stalled reap
 * subprocess clock can never corrupt the ledger's timestamp.
 *
 * `skill` (issue #4126 INV-2) is the `bySkillByModel` cross-tab key reap
 * already resolved for this dispatch (e.g. `hydra-dev`) — the route uses it
 * to look up that skill's 7-day per-family mix and derive
 * `weightedQuotaTokensEstimate`. Optional/nullable: an older or non-reap
 * caller that omits it still gets a valid record, just with the quota-weight
 * fold degrading to the raw identity (see `getWeightedQuotaTokensEstimate`).
 */
export const DispatchCostJoinBodySchema = z.object({
  issue: z.number().int().positive().nullable(),
  class: z.string().min(1),
  dispatchKind: z.string().min(1),
  dispatchTokensEstimate: z.number().finite().nonnegative(),
  skill: z.string().min(1).nullable().optional(),
});
export type DispatchCostJoinBody = z.infer<typeof DispatchCostJoinBodySchema>;

/**
 * Query schema for `GET /api/usage/by-issue`. `issue` is optional — absent
 * returns every attributed issue's rollup plus the global unattributed
 * residual and `attributedPercent`; present narrows the `byIssue` array to
 * just that one issue (the residual/`attributedPercent` figures stay
 * computed over the WHOLE ledger regardless — see the route's docstring in
 * `src/api/usage.ts` for why: a GLM-arm issue's own residual visibility must
 * not depend on which issue the caller happened to query).
 */
export const UsageByIssueQuerySchema = z.object({
  issue: z.coerce.number().int().positive().optional(),
});
export type UsageByIssueQuery = z.infer<typeof UsageByIssueQuerySchema>;
