# Autopilot × Wayfinder integration survey

**Asset for wayfinder ticket [#3306](https://github.com/gaberoo322/hydra/issues/3306)** (map [#3305](https://github.com/gaberoo322/hydra/issues/3305) — "autopilot charts & works wayfinder maps"). Surveys how big initiatives flow through autopilot today, the decision-brain mechanics a new class must fit, the wayfinder machinery and its one real-world run, and the structural friction the map's design tickets must account for. Scoped to what informs the integration — not a general architecture verdict.

## 1. How a big initiative flows today

Finding → shipped code crosses five stages, each with its own machinery:

1. **Finding** — `hydra-discover` / `hydra-research` / `hydra-architecture-scan` / `hydra-cleanup` file issues (calibration gates: quantitative evidence, pattern-not-incident, shared dedup baseline via `scripts/ci/issue-dedup.ts`). Labels: `needs-triage` or `ready-for-agent` plus a provenance label per class.
2. **Epic decomposition** — a multi-slice finding goes through `hydra-prd` (non-interactive, structured JSON in): parent epic + ≥3 tracer-bullet children, created in dependency order, `Expected tier: N` stamped from `GET /api/tier`, children labelled `ready-for-agent` — except that chained children are label-gated `blocked` **by hand**, because autopilot is dependency-blind (see F2).
3. **Design concept** — `hydra-grill` (class `design_concept_orch`, Phase B warn-only) runs a Q&A loop against CONTEXT.md/ADRs, persists an artifact via `grill-artifact.sh write` (`POST /api/design-concepts`, 7-day Redis TTL), then `gate` → auto-approve (`approvedBy: auto-gate`) or escalate to the operator decision queue.
4. **Dev/QA** — `dev_orch` fires off the `orch_work_available` signal (board-state counts of `ready-for-agent`, from `deriveBoardState()` in `src/api/autopilot-board.ts`); QA and auto-merge follow the tier ladder.
5. **Close-out** — `hydra-epic-close` parses the parent's `## Sub-issues` checklist (`- [x] #N`) and closes epics whose children are all closed.

The **operator decision queue** (`scripts/autopilot/queue-decision.sh`) is a rolling daily issue ("Operator decision queue YYYY-MM-DD", one table row per decision with reason + recommendation) that `/hydra-review` drains each morning. It is the existing seam for "autopilot needs a human answer" — but its CLI contract is PR-shaped (`<pr_number> <tier> <reason> <recommendation>`), not general-purpose (F6).

## 2. Decision-brain mechanics a new class must fit

- **Adding a signal class** touches: a `scripts/autopilot/classes.json` row (name/kind/skill/costClass/cooldownSeconds/scope/provenanceLabel), a selector in `decide.py:_rule_signal_classes`, a signal emitter in `collect-state.sh`, cooldown carry-forward seeding in `bootstrap.sh` (Redis `hydra:autopilot:signal-last-fired`, #2715), the playbook class table, and golden-plan tests in `test/autopilot-decide.test.mts`. classes.json owns only the *alphabet*; all policy lives in `decide.py`.
- **Purity**: `decide()` is a pure function of (state, candidates, events) — no network, no Redis, no PR/issue enumeration, no model fields. Anything a selector needs (frontier counts, saturation, staleness) must be **pre-computed by `collect-state.sh` into boolean/count signals**. A "map frontier has work" signal is a collect-side change; the selector consuming it is decide-side.
- **Cooldown/saturation idioms** (copy from existing issue-producing classes):
  - simple cooldown (`retro_orch`, 24 h);
  - saturation cap checked *before* cooldown (`cleanup_orch`: skip when >10 open scan issues);
  - one-per-turn backfill stagger + 24 h starvation floor (`discover_orch`/`architecture_orch` share `orch_backfill_idle`);
  - per-run item caps threaded into `prompt_args.max_items` (`wire_or_retire_target` ≤2, `design_qa_target` ≤3) — machine-enforced at the seam, not prose.
- **Budget**: per-run token budget (INV-005 terminate), per-class soft/hard token caps → `burned_classes` (INV-003 never re-dispatch), daily cost-share gating precedent (`scout_orch`: 4% of daily spend, Redis-mirrored). A map-working class gets these for free by being a class.
- **Session model**: autopilot is print-mode; a run ends when the model goes quiet (baton-pass `cause=handoff`, #1903). Nothing session-resident survives between turns — all map continuity must live in the tracker/Redis, which wayfinder's tracker-is-canonical design already satisfies.

## 3. Wayfinder machinery + the builder-health precedent

The interactive machinery already works end-to-end. Map [#3125](https://github.com/gaberoo322/hydra/issues/3125) (builder-health) ran 2026-07-10 → 07-13: charted in one session (6 tickets), 2 research tickets auto-routed to `/hydra-issue-research` (AFK), 3 HITL tickets (2 grilling + 1 prototype) resolved in operator sessions, then a capstone task synthesized the decisions into ADR-0028 + a `/hydra-prd --apply` epic (#3285, 6 children, all merged same day). Decisions were recorded as rich resolution comments (headline + rationale + ruled-out + carries-into), with the map as a pure index.

What the precedent proves: **the AFK share of a map is already autopilot-compatible** (research tickets ran through existing machinery), the tracker holds all state between sessions, and the map→epic handoff is mechanical once decisions exist. What stayed human: naming the destination, every grilling/prototype resolution, and the ADR synthesis judgment in the capstone.

## 4. Where the integration attaches

| Integration piece | Natural attachment point |
|---|---|
| **Charting trigger** | An issue-producing signal class in the `discover_orch`/`architecture_orch` mold (backfill-idle + stagger + dedup baseline), or a size-threshold branch inside existing producers ("this finding is ≥N slices → chart a map instead of filing an epic") |
| **Destination gate** | The design-concept artifact pattern is the closest precedent: a persisted artifact with `gate` + `approve` verbs and an `approvedBy: operator:<name> \| auto-gate` field (`grill-artifact.sh`), escalating through the daily decision-queue issue. A map-level "destination-pending" state can reuse this shape rather than invent one |
| **Working AFK tickets** | A frontier signal from `collect-state.sh` (the GraphQL frontier query from `docs/agents/issue-tracker.md` § Wayfinding operations, reduced to counts) + a signal-class selector; research tickets dispatch `/hydra-issue-research`, task tickets a scoped worker |
| **HITL routing** | The decision-queue issue + `/hydra-review` morning drain — needs generalization beyond PR-shaped rows (F6) |
| **Cleared-map handoff** | `/hydra-prd --apply` directly (the precedent's path); the capstone-ticket pattern makes handoff a ticket the class can attempt and escalate if judgment-heavy |

**Easy** (existing idioms cover it): class wiring, cooldowns/caps/budget, AFK research tickets, frontier-as-collected-signal, map state surviving sessions, epic handoff mechanics, dedup.

**Hard** (no existing idiom): machine-charting quality (naming a destination breadth-first is judgment work — the gate exists precisely because this can mis-scope); generalizing the decision queue to carry map/ticket questions and flow answers *back* into ticket resolutions; deciding when a finding warrants a map vs an epic; ADR-synthesis in the capstone.

## 5. Friction register

Design tickets on map #3305 must account for these:

- **F1 — Dual blocking conventions.** `docs/agents/issue-tracker.md` § Wayfinding operations (merged 2026-07-13) prescribes **native** sub-issues + blocked-by (GraphQL mutations); the `hydra-wayfinder` playbook, `hydra-prd`/`hydra-epic-close`, and precedent map #3125 all use **body-text** `Blocked by #N` + `## Sub-issues` checklists. Both conventions are live in the repo today. Any frontier collector, and the #3059 parser (which reads body text only), sees exactly one of them. The design must pick one lane per surface — or bridge them — explicitly.
- **F2 — Dependency blindness until #3059 ships.** Dep-aware dispatch (seam: `deriveBoardState()` filter + `src/github/blockers.ts` strict body-text parser) is design-approved but not implemented. Until it lands, blocked map tickets and epic children are protected only by the manual `blocked` label convention. Note the collect-state fallback path (inline `gh` when the board-state seam is degraded) won't include the filter even after it lands.
- **F3 — Wayfinder's off-radar rule is prompt-level only.** No code filters `wayfinder:*`; tickets stay invisible to sweeps/orphan-backstop only because they carry no lifecycle labels. Flipping AFK tickets to autopilot-visible must not let sweeps re-triage HITL tickets — the amendment needs a deliberate mechanism (label taxonomy or code filter), not prose.
- **F4 — Purity boundary.** Frontier/staleness/destination-pending queries belong in `collect-state.sh` as signals; `decide()` cannot enumerate issues. GraphQL frontier queries also burn the constrained GraphQL budget (REST preferred for node-id fetches).
- **F5 — Print-mode session boundaries.** Multi-session maps are fine (tracker-canonical state; #3125 spanned 4 days), but each dispatched ticket-worker must be a self-contained background agent in the existing dispatch-sentinel/reap lifecycle — no session-resident map memory.
- **F6 — Decision queue is PR-shaped.** `queue-decision.sh` hard-codes `<pr_number> <tier> ...`; map destinations and HITL ticket questions don't fit its row schema, and nothing currently routes an operator's *answer* back into a ticket resolution + map update. This return path is new design surface.
- **F7 — Handoff drift.** The wayfinder playbook names `/to-spec`/`/to-tickets` as the handoff; the precedent used `/hydra-prd --apply` directly. Minor, but the spec should name one canonical route.
- **F8 — Charting duplication risk.** An autonomous charting class must consult the shared dedup baseline (and the map label) so overlapping findings don't spawn overlapping maps; `discover` already double-files against shipped work when premise-checks are skipped.

## 6. Pointers for the open design tickets

- *What triggers charting…* → §4 row 1 + F8; gate mechanics → §4 row 2 (design-concept artifact precedent) + F6.
- *What class shape…* → §2 idioms + F4/F5; one class or two (chart vs work) should weigh the stagger/cooldown idioms and the ≤N-items-per-run cap pattern.
- *How do HITL tickets route…* → §1 decision queue + F3/F6.
- *How do maps relate to hydra-grill/hydra-prd…* → §1 stages 2–3, §3 handoff, F1/F7. Note the overlap is real: a map's grilling tickets and `design_concept_orch`'s Q&A both produce operator-ratified design decisions; the taxonomy should say which lane a given initiative takes.
