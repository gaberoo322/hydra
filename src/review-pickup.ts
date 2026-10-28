/**
 * /hydra-review pickup-set aggregator (issue #745).
 *
 * The `/hydra-review` skill drains a specific, two-bucket pickup set (see
 * `docs/operator-playbooks/hydra-review.md`):
 *
 *   1. Issues currently labeled `ready-for-human` — the persistent operator
 *      attention queue (includes a `hydra-grill` gate-fail handoff: a
 *      `## hydra-grill handoff` comment plus this label on the anchor issue,
 *      ADR-0034 §8.1).
 *   2. **Stale-blocked** issues — `blocked`-labeled issues whose body cites no
 *      OPEN blocker (`blocked by #N` / `depends on #N` where #N is closed or
 *      absent). These are the ones the operator needs to re-decide.
 *
 * A third bucket — the dated `Operator decision queue YYYY-MM-DD` digest
 * issue — was retired by ADR-0034 §8.1 / #4621 (the former `decision-queue.ts` aggregator has since been deleted); `hydra-grill` now posts its gate-fail handoff directly
 * on the anchor issue instead of a dated queue issue.
 *
 * `hitl-grill` was a fourth bucket (#4026) until the park lane moved to its
 * own operator skill, `/hydra-hitl-grill`. A parked idea is not an
 * operator-attention item: it does not block the AFK frontier, so neither
 * `/hydra-review` nor the phone-notify hook that mirrors it reads the lane.
 *
 * The phone-notify hook (issue #745) must mirror what the operator will
 * actually see when they run `/hydra-review`, so it reads this aggregator.
 *
 * # Design contract (issue #5092)
 *
 * - **Projection only.** This module no longer fetches or classifies on its
 *   own: the pickup set is `projectPickupSet(await readWaitingIssues(deps))`
 *   from `aggregators/issues-waiting.ts`, so the feed's stale-blocked row and
 *   the pickup Page agree by construction.
 * - **Never throws.** `readWaitingIssues` maps a failed label read to `[]` and
 *   a failed blocker lookup counts every ref as open (fewer rows, never a
 *   false Page).
 */

import {
  projectPickupSet,
  readWaitingIssues,
  type IssuesWaitingDeps,
  type PickupItem,
} from "./aggregators/issues-waiting.ts";

export type { PickupItem, PickupSource } from "./aggregators/issues-waiting.ts";

/** Fetch the /hydra-review pickup set (ready-for-human + stale-blocked). */
export async function getReviewPickupSet(
  deps: IssuesWaitingDeps = {},
): Promise<PickupItem[]> {
  return projectPickupSet(await readWaitingIssues(deps));
}
