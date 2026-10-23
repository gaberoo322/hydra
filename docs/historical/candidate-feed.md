# Candidate Feed (ADR-0036)

> **Retired by / replaced by.** Moved verbatim from `docs/reference.md` (issue #4599, audit REF-09). The `selectAnchor()` waterfall was deleted by ADR-0036, and the Candidate Feed that replaced it is itself retired (#3455); `decide.py` is the single decisional brain (ADR-0012). Kept for the why-did-this-change trail.

The `selectAnchor()` priority waterfall (a 13-tier chain in the retired
`src/anchor-selection/` family) was **deleted by ADR-0036**: it was orphaned at
both ends when ADR-0006 removed the in-process control loop, and ADR-0012 made
`decide.py` the single decisional brain. Retry / escalation / abandonment
policy — the product intent behind the Reframe Queue — belongs to `decide.py`,
not a dormant TypeScript store.

The live concept is the **Candidate Feed**: `src/anchor-candidates.ts`
(`getCandidateFeed(opts, deps?)`), served read-only at
`GET /api/anchor/candidates` (`src/api/anchor.ts` is a thin route over it). It
is *data the brain reads, not a decision the orchestrator makes*. One deep
module owns:

- **Enumeration** — the only two lanes with live writers: backlog kanban
  (`loadBacklog` — inProgress ∪ queued ∪ backlog) ∪ work-queue
  (`getWorkQueueItems`, fed by `POST /api/queue` + research auto-queue).
- **Scoring** — tier base (`kanban-queued` 0.85, `work-queue` 0.70) + freshness
  penalty (>14d, −0.15) + recent-reflection penalty (<24h, −0.20) +
  blocker-just-cleared bonus (+0.15), clamped to [0,1]. The abandonment penalty
  and the reframe / prior-failure / regression-hunt / codebase-health /
  priorities-doc tiers were dropped with their now-empty lanes.
- **Eligibility** — in-flight-PR 30-min suppression (#640), blocker-just-cleared
  detection, design-concept annotation (#628), and `research_recommended` (top
  score < 0.5, or no candidates).

`deps?` is injectable (`loadBacklog` / `getWorkQueueItems` / reflection reader /
design-concept reader) so the feed is the unit-test surface.
