# ADR-0029: hydra-autopilot charts and works wayfinder maps

Status: Accepted
Date: 2026-07-15
Deciders: Operator + Hydra (wayfinder map #3305, which locked all six decisions recorded here)
Related: #3305 (wayfinder map — the six decisions), #3306 (survey asset `docs/research/2026-07-15-autopilot-wayfinder-integration-survey.md`), #3307 / #3308 / #3309 / #3310 / #3312 (the design tickets), #3059 (dep-aware dispatch — the body-text blocked-by filter this leaves untouched), #3125 / ADR-0028 (the builder-health map, the operator-driven precedent this automates), ADR-0007 (decision-brain purity), ADR-0012 (autopilot is the single brain)

## Context

`hydra-wayfinder` (the Hydra adaptation of Matt Pocock's `wayfinder`) lets a large, foggy initiative be charted as a **map** — a `wayfinder:map` issue whose child tickets each resolve one open decision — then worked one ticket at a time until the way to a **destination** (a spec, a locked decision, or an in-place change) is clear. It has one real-world run: the builder-health map #3125 → ADR-0028 → epic #3285, all shipped 2026-07-13.

Today that machinery is **entirely operator-driven**. `wayfinder:*` tickets carry no lifecycle labels, so they are invisible to autopilot's selectors (which key off `ready-for-agent` / `needs-triage` counts) and to the sweeps. Every ticket — even the AFK research ones that need no human judgment — requires a manual `/wayfinder <map>` dispatch. In the #3125 precedent, its two research tickets *were* auto-routed to `/hydra-issue-research`, proving the AFK share is already compatible in principle; but the operator still had to initiate each one.

The survey (#3306) established that the AFK share of a map is autopilot-workable with no new capability beyond a dispatch trigger, that autopilot's decision brain (`decide.py`) is pure and cannot enumerate issues or call the network, and that the friction to account for is concrete (two blocking conventions live in the repo; the operator decision queue is PR-shaped; the off-radar rule is prompt-level only). Map #3305 charted the remaining fog into six blocking decision tickets and resolved each. This ADR is the **design of record** transcribing those decisions; it is a docs-only change — the net-new machinery (`wayfinder_orch`, the frontier collector, the hydra-review buckets) is built in the child tickets of the epic this ADR hands off to, not here.

Scope is **orchestrator-self maps only**. Target-realm maps are deferred (the Target's Redis-backlog tracker lacks native sub-issue / blocked-by machinery) and return only as a fresh effort if orch maps prove out.

## Decision

Six decisions, locked by map #3305. The through-line: **automate the AFK share, keep the human in the loop for judgment, and never let a machine synthesize the operator's side of a decision.**

### Decision 1 — Trigger and destination gate (#3307)

- **Trigger — fog-gated, size as floor.** A finding becomes a map (rather than a plain epic) only when the producing class asserts it carries **≥2 unresolved *decisions*** (open questions, not merely implementation slices) **AND** it clears a size floor (~≥4 slices or spans ≥2 subsystems; the exact number is a tuning knob). Size alone → epic; fog is the deciding predicate. This honors the wayfinder line: an epic is *decided-and-needs-slicing*, a map is *undecided-and-needs-charting*.
- **Proposers — `hydra-research` and `hydra-architecture-scan` only.** The two fog-native producers get the charting branch; `discover` / `retro` / `cleanup` keep filing normal issues. The destination gate backstops a false map proposal (it costs one rejection, not wasted work), so the trigger can lean on the producer's self-declaration.
- **Gate — a `wayfinder:destination-pending` label on the map.** The frontier collector counts a map's AFK tickets as dispatchable **only when the parent map lacks that label**. *Approve* = remove the label; *amend* = the operator edits the Destination section, then removes the label; *reject* = close the map.
- **Draft scope — destination-only.** A destination-pending map holds **only** the Destination + fog sketch, **no tickets**. The gate sits between wayfinder's two charting steps (name-destination / map-the-frontier); ticket-charting is the first working action against the now-locked destination, so an amendment strands nothing.
- **Surfacing — a hydra-review "destination-pending maps" bucket.**

### Decision 2 — Working class shape (#3308)

- **Charting is a branch in existing producers**, not a new class: when `hydra-research` / `hydra-architecture-scan` detect a fog-gated + size-floor finding, they chart a destination-pending map instead of filing an epic.
- **Working is one new signal class, `wayfinder_orch`.** It fires on the map-frontier signal and dispatches a frontier worker, **routing by ticket type** (`wayfinder:research` → `/hydra-issue-research`; `wayfinder:task` → a scoped task worker). Signal-class shape (cooldown-gated, no slot semantics) because the work is issue-driven and independent — it fits the existing issue/work-producing signal mold and needs no 8th pipeline slot.
- **One frontier ticket per fire, cooldown ~1h** (matching `cleanup_orch` / `architecture_orch`). The blocking graph already serializes most of a frontier, and the AFK work runs long, so cooldown-serialized dispatch is not the bottleneck. Fan-out is a deferred optimization.
- **Saturation guard — per-map single-flight + global cap ≤2** concurrent `wayfinder_orch` workers. The frontier query already excludes *claimed* (assigned) tickets; these two bounds add the ceiling.
- **Model omitted → inherit the parent session model** (as `wire_or_retire_target` / `design_qa_target`).
- **classes.json row**: `kind: signal`, `costClass: research`, `cooldownSeconds: 3600`, `scope: orch`, `provenanceLabel: null` (it resolves tickets; it does not file issues).

### Decision 3 — HITL routing and the off-radar rule (#3309)

- **HITL surfacing — a hydra-review "wayfinder HITL tickets" bucket** that queries open maps' frontiers for `wayfinder:grilling` / `wayfinder:prototype`-typed, unblocked, unclaimed tickets. `wayfinder_orch` never dispatches an HITL-typed ticket; it skips them and works the AFK ones not blocked by them. The tickets sit inert on the frontier until the operator runs `/wayfinder <map> <ticket>`.
- **Return path — the interactive session closes the loop.** That session records the resolution comment, closes the ticket, and appends to the map; autopilot's next tick sees the advanced frontier and resumes AFK dispatch. There is **no autopilot-side answer ingestion** — parsing operator comments back into resolutions is rejected as fragile and as a breach of the HITL contract (an agent must never synthesize the human's side of a decision).
- **Off-radar rule — preserved, not unwound.** `wayfinder:*` tickets keep zero lifecycle labels, so `hydra-sweep` and the orphan-backstop stay blind to them. AFK tickets are made dispatchable **not** by relabeling to `ready-for-agent` but by a **new dedicated map-frontier signal** in `collect-state.sh`. Net operator-attention surface: **hydra-review becomes the single wayfinder morning drain** with two buckets (destination-pending maps + HITL frontier tickets); everything else on a map runs AFK.

### Decision 4 — Handoff and the hydra-grill / hydra-prd relationship (#3310)

- **Handoff is destination-typed.** An **implementation-epic** destination → a capstone task synthesizes the Decisions-so-far into an ADR + structured PRD JSON → `hydra-prd --apply` → epic + tracer-bullet children (the #3125 pattern). A **decision/ADR-only** destination → the ADR lands; the map is done. An **in-place-change** destination → the map is the plan, executed directly. (The `hydra-wayfinder` playbook's `/to-spec` mention is corrected to name `hydra-prd` for the epic route — survey F7.)
- **Handoff is an operator surface with a first-class state (cockpit addendum).** A map whose frontier has gone empty is *handoff-ready*, not dead. It surfaces in `hydra-review` §0.7 (the HITL pipeline cockpit) marked `wayfinder:handoff-pending`, where the operator drives the destination-typed route above; `hydra-review` then **closes the map as the final handoff step** (or `keep-open` to retain it as a reference). Correspondingly, `hydra-epic-close` **excludes `wayfinder:map` from auto-GC** — a map must survive until handoff, so the handoff flow owns its death, closing the race where the sweeper would GC a cleared map before it could be handed off. The spec route (`/to-spec`) additionally relabels its output `needs-tickets` (dropping `ready-for-agent`) so an un-sliced spec lands back in `hydra-review` §0.8 for `/to-tickets` rather than being grabbed whole by `hydra-dev`.
- **wayfinder-working and `design_concept_orch` compose, they do not overlap.** They sit at different altitudes: **wayfinder is initiative-level** (upstream — resolves fog, produces the epic); **hydra-grill is issue-level** (downstream, per epic-child — produces the dev-gating design-concept artifact). A map's grilling tickets resolve initiative decisions and never dispatch `design_concept_orch`. The one obvious route for any finding is a **routing decision-tree**:

  | Finding shape | Route |
  |---|---|
  | Foggy + big (≥2 initiative decisions, epic-scale) | **wayfinder map** |
  | Clear + big (decided, ≥3 slices) | **hydra-prd** directly |
  | Clear + single issue needing implementation design | **hydra-grill** (design_concept_orch) |
  | Clear + trivial | **dev** directly |

### Decision 5 — Blocking convention (#3312)

The map and the handoff epic are distinct artifacts with distinct consumers, so they use different conventions — **no bridge**:

| Surface | Convention | Consumer |
|---|---|---|
| Map internals — charting wiring, the collect-state frontier collector, AFK gating | **Native** sub-issues + blocked-by (`gh api graphql`) | the wayfinder frontier query (tracker doc § Wayfinding operations) |
| Handoff epic — `hydra-prd` output | **Body-text** `## Sub-issues` + `Blocked by #N` | `hydra-dev`, `hydra-epic-close`, #3059's `deriveBoardState` filter |

Native for the map because the tracker doc's Wayfinding operations section (merged `8568ba6`) is the newer authoritative contract, native renders the frontier **visually** in GitHub for the HITL-heavy workflow, and it is empirically proven — map #3305 ran native across six sessions. #3059's body-text filter targets the `ready-for-agent` board (epic children), not the map frontier, so the two mechanisms never collide. `hydra-prd`'s capstone translation *is* the bridge.

### Decision 6 — decide.py purity (#3308)

The native frontier query drives dispatch without `decide.py` touching the network:

1. **`collect-state.sh`** runs the native GraphQL frontier query **per open approved map**, pre-resolves the next AFK-typed, unblocked, unclaimed frontier ticket (number, type, parent-map) into `state.json` as a signal, respecting the per-map single-flight + global-cap counters.
2. **`decide.py`** reads the pre-computed signal, applies cooldown + saturation + budget gates, and emits a **pure `dispatch` action** referencing the pre-resolved ticket + the `wayfinder_orch` class. It enumerates nothing and calls no network.
3. **The playbook** resolves ticket-type → skill and dispatches the background worker; on completion the worker records the resolution comment, closes the ticket, and appends to the map (the AFK analogue of the interactive close-the-loop).

## Consequences

- **Autopilot can advance the AFK share of a map unattended**, collapsing the operator's role to: approve a machine-charted destination, and resolve the HITL (grilling/prototype) tickets — both drained from a single hydra-review surface.
- **The HITL contract is structurally protected**: the machine never resolves a grilling/prototype ticket, because `wayfinder_orch` dispatches AFK types only and there is no answer-ingestion path.
- **This map (#3305) does not benefit from the capability it designs** — a bootstrap gap. #3305 is worked to completion manually; the *next* foggy initiative is the first candidate for autonomous charting/working. The dry-run prototype slice dogfoods `wayfinder_orch` on a scratch map before any real map depends on it.
- **The off-radar rule is refined, not removed**: the sweeps stay blind; a dedicated type-aware frontier path is added beside them. A mislabeled ticket is still the failure mode to guard against, but no worse than today.
- **Two blocking conventions persist in the repo by design** — native for map internals, body-text for epics — with the boundary documented so a future frontier collector or dependency filter reads exactly one.
- **A new stall class exists**: a `wayfinder:destination-pending` map never approved, or an HITL ticket never picked up. A staleness sweep surfaces both.

## Alternatives considered

- **Full autonomy (machine resolves HITL tickets too)** — rejected at charting; it breaks the wayfinder HITL contract.
- **Charting-only (autopilot proposes maps but never works tickets)** — rejected; it leaves the AFK share manual, the exact friction this effort removes.
- **A new pipeline slot for working** — rejected; map-frontier AFK work is independent and parallelizable, a poor fit for slot serialization, and it would compete with the seven existing slots.
- **Body-text blocking everywhere (reuse #3059's parser)** — rejected; it would revert the just-merged tracker doc, lose the visual frontier, and re-wire #3305.
- **Relabel AFK tickets to `ready-for-agent`** — rejected; it re-exposes them to the sweeps and blurs map tickets into board work.
- **Decision-queue rows for map approval / HITL surfacing** — rejected; the queue is PR-shaped (survey F6) and would need generalizing first, and it splits the operator surface that a hydra-review bucket unifies.
