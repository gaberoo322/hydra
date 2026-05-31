# ADR-0016: Anchor selection retired; the Candidate Feed is data, not decisions

Status: Proposed
Date: 2026-05-30
Deciders: Operator + Hydra (via `/improve-codebase-architecture` deepening session)
Issue: TBD (anchor-selection retirement)

## Context

`src/anchor-selection/` — a 16-file directory plus the `src/anchor-selection.ts` re-export
facade, `src/anchor-scorer.ts`, and `src/anchor-actionability.ts` — implements the
`selectAnchor()` priority waterfall: a 13-tier chain (kanban → work-queue → failing-tests →
reframe → prior-failures → regression-hunt → codebase-health → priorities-doc) with atomic
Lua claims, a reframe-queue lifecycle, prior-failure escalation, an abandonment circuit-breaker,
capacity-floor pre-emption, drift filtering, and `reportOutcome()` post-cycle bookkeeping.

This machinery was the **in-process control loop's** work-picker. ADR-0006 removed that loop;
ADR-0012 made `decide.py` the single decisional brain. The waterfall was never re-wired, and a
trace confirms it is **orphaned at both ends**:

- `selectAnchor()` (the reader) has **zero live callers** — every reference in `src/`, `scripts/`,
  and the Python autopilot is a comment or the facade re-export.
- `reportOutcome()` (the writer-driver) has **zero live callers**. The write-side lane accessors
  it drove — `pushReframeItem`, `appendPriorFailure`, `incrAbandonment`, `popReframeQueueHead`,
  `replaceReframeQueue` — are called only from inside `src/anchor-selection/` and tests.
- Therefore the reframe-queue, prior-failures, and abandonment Redis lanes are **never written in
  production**. They are empty.

Meanwhile the *live* surface is `src/api/anchor.ts`, which serves `GET /api/anchor/candidates`
(issue #424). It re-implements candidate enumeration by reading the raw Redis lanes directly,
borrows only `scoreCandidate` + two types from the whole family, and **also reads the three empty
lanes** (reframe / prior-failures / abandonment) on every request — enumerating and scoring tiers
that nothing fills. `decide.py` consumes that payload, reading only `research_recommended` and the
per-candidate `score`, `reasons`, `designConcept`, `anchorRef`, and `issue` fields. It never reads
`abandonments` and never branches on `priority_tier`.

The net effect: the "how does Hydra pick the next anchor" concept lives in **two implementations**
— a dead, elaborate waterfall and a live, shallow route — which can (and already do) drift in tier
ordering, with no end-to-end test of either path.

## Decision

**Retire the anchor-selection waterfall. The live concept is a `Candidate Feed` — data the brain
reads, not a decision the orchestrator makes.**

1. **Delete the dead machinery.** Remove `src/anchor-selection/` (all 16 files), the
   `src/anchor-selection.ts` facade, `src/anchor-scorer.ts`, `src/anchor-actionability.ts`, and the
   now-unreachable lane accessors in `src/redis/anchors.ts` (reframe / prior-failure / abandonment /
   perm-skip / regression-hunt-last reads and writes). Delete their tests.

2. **Promote the live concept to one deep module: `src/anchor-candidates.ts`.** It owns enumeration
   (backlog kanban ∪ work-queue — the only two lanes with live writers), scoring (tier base +
   reflection penalty + blocker-cleared bonus), and eligibility (in-flight-PR freshness window,
   design-concept gate, research-recommended threshold) behind one interface,
   `getCandidateFeed(opts, deps?)`. `src/api/anchor.ts` collapses to a thin route over it.

3. **Decisions belong to `decide.py`, not the feed.** Retry / escalation / abandonment policy — the
   product intent behind the Reframe Queue — is *not* re-homed in TypeScript. If it is ever wanted,
   it becomes `decide.py`'s responsibility, consistent with ADR-0012. The feed carries data only.

4. **Preserve the HTTP contract.** The `/api/anchor/candidates` response shape is unchanged. The
   `abandonments` scoring signal/field is dropped (decide.py ignores it) and the `PriorityTier`
   union shrinks to the two live values (`kanban-queued`, `work-queue`).

The CONTEXT.md glossary retires the **Reframe Queue** term and adds **Candidate Feed**.

## Consequences

### Positive

- **Locality.** Tier ordering, scoring, and eligibility have exactly one home; the two
  implementations can no longer drift.
- **Leverage.** A caller (and `decide.py`) learns one interface — the feed — instead of a 20-file
  family it already ignores 95% of.
- **The interface becomes the test surface.** `getCandidateFeed` is testable end-to-end with stubbed
  deps, replacing coverage that only poked extracted pure helpers through a `_testing` hatch.
- **~2,000 lines of dead code removed**, including empty-lane reads on a hot request path.

### Negative

- **The Reframe Queue capability is gone**, not dormant. Re-introducing retry-with-fresh-diagnostic
  later means designing it in `decide.py`, not un-deleting this code. Accepted: it was already dead,
  and the brain is the right home.
- **Lossy history.** The drift-filter, capacity-floor cadence, and starvation instrumentation
  (#233/#288/#321/#377) are deleted. This ADR is the record of why, so the work isn't blindly redone.

### Risks accepted

- A future explorer might re-suggest "resurrect the reframe queue." This ADR is the standing answer:
  it was orphaned by ADR-0006, and retry policy belongs to `decide.py` per ADR-0012.

## Alternatives considered

- **Keep the lanes, delete only the waterfall.** Preserve `redis/anchors.ts` accessors and the API's
  lane reads so `decide.py` could repopulate them later. Rejected: leaves empty-lane reads on the hot
  path and a half-retired concept; the resurrection path is a `decide.py` design, not a dormant TS
  store.
- **Resurrect — re-wire `reportOutcome`'s writers into the live autopilot path.** Rejected: that is a
  feature project, not a deepening, and it would re-home decisional logic in TypeScript against the
  ADR-0012 single-brain rule.
- **Inline the feed into `src/api/anchor.ts`.** Rejected: violates the thin-mount-point route
  convention and keeps eligibility logic in the HTTP layer.

## Related

- ADR-0006 Codex CLI removed; autopilot-only — orphaned `selectAnchor()`/`reportOutcome()` at both ends
- ADR-0012 Autopilot is the single decisional brain — the precedent for collapsing stranded TS
  decision logic toward `decide.py` (exactly as it did for the scheduler-side research floor)
- ADR-0010 Stuckness detector retired — same lineage: system-curated trip wires give way to the brain
- Issue #424 — the `/api/anchor/candidates` endpoint that is the live Candidate Feed
- Issue #513 — Specs retirement, the prior precedent for deleting an orphaned in-loop subsystem
