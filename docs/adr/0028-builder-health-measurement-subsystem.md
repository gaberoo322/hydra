# ADR-0028: Builder-Health Measurement Subsystem — a per-realm metric panel, not a composite index

Status: Accepted
Date: 2026-07-13
Deciders: Operator (Orchestrator Vision vector 6) + Hydra (wayfinder map #3125, which locked all three decisions recorded here; design-concept artifact `bbe3ccff`)
Related: #3125 (wayfinder map — the three decisions), #3128 / #3129 / #3130 (child build tickets), #3126 / #3127 (research), #732 (the existing Builder-Health Scorecard this extends), #2628 (Outcome Attribution Spine — deliberately *not* coupled), ADR-0006 (Codex removal — why mutation-kill-rate is dark)

## Context

Orchestrator Vision **vector 6** mandates surfacing *builder health* honestly:
ADR-0013 elevates the builder itself to the durable asset, and ADR-0003's 25%
self-improvement floor is an *input* budget with no *output* signal. The
Builder-Health Scorecard (#732, `src/aggregators/builder-health.ts`) is that
output signal today — a small trended set of per-metric slots, read-only-composed
from existing substrate (capacity floor, `metrics/aggregate.ts` rework, autonomy
rate + time-to-merge from the dispatch→PR link) over a default 50-cycle rolling
window, and already rendered in the digest (`src/digest.ts`) and the dashboard.

What #732 does **not** yet decide is the *shape* of the subsystem it seeds: what
the metric set is and whether it collapses to one number; how a metric is
attributed to the builder rather than to confounds; and how an unhealthy builder
is *surfaced* to the operator proactively rather than only on a glance. Those are
design decisions with real failure modes (a composite index that hides which
signal broke; a statistical attribution model that over-fits a sparse cycle
stream; an absolute-threshold alert that false-alarms across realms with
different native rates). Wayfinder map **#3125** charted that fog into three
blocking decision tickets and resolved each. This ADR is the **design of record**
that transcribes those three locked decisions; it is a docs-only change — the net
-new instrumentation it governs (cycle-yield signal, stagnation alert) is built
in child tickets #3128 / #3129 / #3130, not here.

Metrics are computed **per realm** — orch vs target dispatch domains are never
blended, because their native rates differ (the same absolute number means
different things in each).

## Decision

Three decisions, locked by map #3125.

### Decision 1 — Metric set: a per-realm PANEL, no composite index

Builder health is a **panel of signals**, never a single blended builder-health
index or weighted score.

- **Four signals**, each computed per realm:
  - **Autonomy rate** — core.
  - **Rework rate** — core.
  - **Cycle yield** — core (the net-new signal; #3128).
  - **Time-to-merge** — secondary.
- **`builder unhealthy` = ANY signal breaches its own rule (OR semantics)** —
  never a blended/weighted aggregate. A composite score would hide *which*
  signal broke and would invite gaming; the panel with OR semantics preserves
  per-signal legibility.
- **`mutation-kill-rate` is deferred to phase-2.** No Redis writer has produced
  it since the Codex removal (ADR-0006), so it would be dark on arrival;
  including it now would be false coverage.
- **Causal class-attribution is ruled out.** Builder health is a
  **trend-watcher** (map #3125 Path C), not the #2628 ridge estimator (Path B).
  A statistical causal model is out of scope and would over-fit the sparse
  per-realm cycle stream.

### Decision 2 — Attribution: definitional + contextual, dark-tolerant, NO statistical model

Attribution is **definitional and contextual**, dark-tolerant, and carries no
statistical model.

- **Control only the two cheap confounds:**
  - **External-PR volume** — compute over **dispatched-work-only**, so
    human/external PRs never dilute a builder metric.
  - **Realm mix** — compute **per realm**, never blend orch and target.
- **Tier mix / backlog composition / target difficulty are exposed as window
  context, not adjusted out.** There is no cheap control for them (tier is not
  on the data substrate); fabricating an adjustment would be false precision.
  Exposing them as context alongside the window is the honest choice.
- **Relative-to-self normalization.** Each signal is normalized against its own
  **trailing per-realm rolling baseline** — never an absolute cross-realm
  threshold.
- **Chosen failure mode:** accept the **boiling-frog blind spot** (a slow, flat
  decay that never breaches a relative band) in exchange for **not**
  false-alarming on confounds. This is a deliberate consequence of
  relative-to-self attribution, stated here so it is a decision and not an
  omission.

### Decision 3 — Surfacing: three surfaces, band + N-cycle-sustain trigger

Three surfaces with a division of labour:

- **Pattern-detection alert** — `builder-health.stagnation` emitted into
  notifications = **proactive** (fires without the operator looking).
- **Digest section** — extend the #732 digest block = **glance**.
- **Dashboard page** — = **deep-dive**.

**MVP = alert + digest** (the dashboard page is phase-2).

- **Trigger SHAPE = relative-to-baseline band + N-cycle sustain.** Fire when the
  current value is `delta` worse than the trailing baseline for **N consecutive
  cycles**. A single-cycle excursion does not fire; the sustain requirement
  suppresses noise.
- **Window = the existing 50-cycle aggregate default.** It fits the 7-day Redis
  TTL, so there is no backfill requirement.
- **Cold-start = suppress alerts until the baseline has ≥ K cycles.** No firing
  against an under-populated baseline, which would false-alarm on startup.

Absolute-threshold alerting was rejected: absolute thresholds do not travel
across realms with different native rates, and they false-alarm on cold start;
the relative band + sustain suppresses both single-cycle noise and cold-start
false alarms.

## Consequences

- **Reuses existing substrate.** The subsystem extends the #732 scorecard, the
  digest section, and the dashboard widget rather than standing up a parallel
  pipeline. The new work is the cycle-yield signal and the stagnation alert
  (#3128 / #3129 / #3130), not a green-field metrics store.
- **Blind to slow flat decay by design.** The boiling-frog case (a gradual,
  monotone decline that never breaches a relative band) will not fire an alert.
  This is the deliberate trade accepted in Decision 2 — legibility and low
  false-alarm rate over sensitivity to slow drift.
- **Target-realm autonomy / rework are dark until new instrumentation lands.**
  Per-realm computation means the target realm's autonomy and rework slots read
  "no data yet" until the target dispatch→PR link is instrumented; the panel
  must degrade to an empty slot (the #732 never-throws contract), not error.
- **Phase-2 backlog** (deferred, tracked, not built here):
  - the **dashboard deep-dive page** (MVP is alert + digest only);
  - **mutation-kill-rate** as a fifth signal, once a Redis writer produces it
    post-ADR-0006;
  - any richer attribution than the two cheap confounds — explicitly *not* the
    #2628 ridge estimator for this subsystem.
- **Docs-only, Tier 3.** This ADR touches no `src/` interface, so `npm test` and
  `tsc` stay green unchanged; it classifies to Tier 3 (operator-review change,
  not Verifier-Core).

## References

- Wayfinder map **#3125** — charted the fog and locked all three decisions above.
- Child build tickets **#3128 / #3129 / #3130** — the net-new instrumentation
  (cycle-yield signal, stagnation alert) this ADR governs.
- Research **#3126 / #3127** — the frontier research that fed the map.
- Builds on **#732** — the existing Builder-Health Scorecard
  (`src/aggregators/builder-health.ts`, `src/digest.ts`).
- Related to **#2628** — the Outcome Attribution Spine; this subsystem is a
  trend-watcher (Path C) and deliberately does **not** couple to the ridge
  estimator (Path B).
- **ADR-0006** — Codex removal; why mutation-kill-rate has no writer and is
  deferred to phase-2.
