# ADR-0030: One autonomous Pocock skill lineage replaces the hydra-prd/dev/qa forks

Status: Accepted
Date: 2026-07-17
Deciders: Operator + Hydra (wayfinder map #3383, which locked the five decisions transcribed here)
Related: #3383 (wayfinder map — the five decisions + destination), #3384 (audit — orch skill/class inventory, [gist](https://gist.github.com/gaberoo322/5007a0029000e082fb9ee34dd0db3a00)), #3385 (blast-radius trace), #3386 (generated-vs-vendored pipeline), #3387 (autonomy-conversion contract), #3388 (stage↔class mapping), ADR-0012 (autopilot is the single brain), ADR-0029 (autopilot charts and works wayfinder maps — the sibling that made the AFK share of a map autopilot-workable), ADR-0004 / ADR-0015 (self-modification tiers), #666 (the historical off-repo-skill-clobber hazard this design must not revive)

## Context

Hydra's orchestrator lifecycle runs on a bespoke skill triplet — `hydra-prd` (produce an epic + tracer children), `hydra-dev` (implement one issue), `hydra-qa` (review the PR) — plus a wide cast of class-less orchestrator skills. These forks were written before Matt Pocock's upstream `skills` lineage (`wayfinder` → `to-spec` → `to-tickets` → `implement` → `code-review`) existed as a coherent five-stage model, and they **re-implement** the same patterns inline rather than composing the upstream skills. The operator, working interactively, runs the upstream skills; autopilot, working AFK, runs the Hydra forks. Two skill populations, one drifting away from the other.

Map #3383 charted the fog of collapsing that split into a **single autonomy-capable lineage** — the same skill in two modes, interactive for the operator and AFK for autopilot — under a **stage-map-or-die** discipline: every surviving orchestrator skill must map to one Pocock stage or to a short ops/producer exception list; the rest merge or retire. The map's charting scope was the **orchestrator** taxonomy only; the Target mirrors (`dev_target` / `qa_target` / `research_target` / …) were ruled out at charting and return, if ever, as a fresh effort once the orchestrator refit proves out.

Five decision tickets were charted and closed to terminal verdicts. This ADR is the **design of record** transcribing those five, plus two first-pass dispositions the operator asked the capstone to lock rather than defer: the signal-class fate under stage-map-or-die, and the lineage-home mechanism left open by #3386. It is a docs-only change; the net-new machinery (a new `tickets` class, the `classes.json`/`decide.py` rename seams, the vendor-into-repo compose step) is built by the child tickets of the `hydra-prd` epic this ADR hands off to, not here.

The refit classifies **T3** (#3385): it touches `src/` + `scripts/autopilot/` but not `tier-classifier.ts` / `ci.yml` / `untouchable.ts`, so it stays clear of the Verifier Core.

## Decision

The through-line: **autopilot runs the same skills the operator does, just in AFK mode — one lineage, two modes, no fork.** Every orchestrator skill maps to a Pocock stage or a named exception; the `hydra-prd`/`dev`/`qa` fork identities retire.

### Decision 1 — The inventory maps 1:1 to the five stages (#3384)

The audit inventoried **13 orchestrator dispatch classes + 12 class-less orch skills** and first-pass stage-tagged each. The three forks map cleanly onto Pocock stages — `hydra-dev` → **implement**, `hydra-qa` → **review**, `hydra-prd` → **tickets** — confirming the collapse is a rename-and-compose, not a redesign. Open flags the later tickets resolved: the `tickets` stage had no dispatch class of its own; `spec` was contested between a Pocock stage and the existing `hydra-grill`; and the pre-`plan` producer cluster (`discover` / `architecture` / `cleanup` / `scout`) needed a fate.

### Decision 2 — Stage ↔ class mapping, stage-map-or-die applied (#3388)

The refitted spine binds each Pocock stage to exactly one orchestrator class:

| Pocock stage | Orchestrator class | Disposition |
|---|---|---|
| **plan** | `wayfinder_orch` | **Keep** (already the `wayfinder` adaptation; ADR-0029). |
| **spec** | `design_concept_orch` → `to-spec` | Rebind to upstream `to-spec`; **grill-before-build folds in** (the `hydra-grill` design-concept gate becomes the spec stage's interactive mode). |
| **tickets** | **NEW class** → `to-tickets` + Hydra overlay | `hydra-prd` is **demoted to a called bridge library** (the `PrdInput`→GitHub-issue renderer), invoked by the overlay; it is no longer a standalone dispatch identity. |
| **implement** | `dev_orch` → upstream `implement` | Rebind; `hydra-dev` fork retires. |
| **review** | `qa_orch` → upstream `code-review` | Rebind; `hydra-qa` fork retires. |

`research_orch` is **not a stage** — it is a pre-`plan` PRODUCER (it feeds findings into the `plan`/`wayfinder` intake), and stays a signal class (see Decision 6). This was the terminal decision that emptied the map's frontier.

### Decision 3 — Autonomy-conversion contract: two modes, one skill (#3387)

Each stage's skill runs in **two modes** — interactive for the operator, AFK for autopilot — and the AFK mode resolves each gate the interactive mode would ask a human, but **from an objective artifact, never by synthesizing the operator's preference**:

- **seams** ← `CONTEXT.md` + the ADRs named on the ticket
- **approval** ← the tier gate + CI (not a human ack)
- **fixed-point** (review base) ← the merge-base
- **spec** ← the issue's `Closes #N` reference

**Missing-artifact fallback** is a conservative default plus a surfaced flag; autopilot **escalates to the operator ONLY** when a stage would touch a **new seam** or a **T4 / Verifier-Core** path. Everything else it resolves and proceeds. This preserves the ADR-0029 HITL invariant one layer down: the machine fills the AFK share, the human keeps the judgment gates.

### Decision 4 — Lineage home: vendor-into-repo + compose (#3386, Option C — locked here)

#3386 established that the two skill populations are structurally disjoint and left three lineage-home options for this ADR to choose. **This ADR locks Option C.**

- **Generated `hydra-*` skills** — source is git-tracked `docs/operator-playbooks/*.md`; `scripts/sync-skills.sh` stamps a "DO NOT EDIT / Generated from…" banner into `~/.claude/skills/`; **gated** by the advisory size-ratchet + drift-check and eval-eligible.
- **Vendored upstream Pocock skills** — installed once via `npx skills add mattpocock/skills --copy` as real off-repo dirs; **no banner, no gate coverage** (every gate globs only `docs/operator-playbooks/**` or `evals/*.yaml`); clobbered on refresh.

The three options were: **A** keep everything playbook-generated (gated + tracked, but *perpetuates the re-implementation drift the refit exists to kill*); **B** vendor-and-adapt (same skill the operator runs, but ungated / off-repo / clobbered-on-refresh, and **revives #666**); **C** a new mechanism — **vendor the upstream skill into the repo, and have `sync-skills.sh` compose an upstream base + a thin Hydra AFK overlay**.

**Option C is the decision.** It is the only option that satisfies *both* load-bearing constraints — "the same skill the operator runs" (kills the drift) **and** gate coverage + git-tracking (no #666 clobber, stays eval-eligible) — at the cost of net-new compose plumbing (still T3). A and B each sacrifice one of the two constraints the whole refit is for.

**Hard constraint (from #3386, carried into the epic):** all four dispatched vendored skills ship `disable-model-invocation: true`, which **HARD-ERRORS under Skill-tool dispatch** (`sync-skills.sh`'s fail-safe rule). The compose step **must strip that frontmatter key** from the AFK-overlay output for any dispatched lineage.

### Decision 5 — Blast radius: one structural source of truth, four silent-rename seams (#3385)

`classes.json` is the **one structural source of truth** — `decide.py` and `src/taxonomy/classes.ts` both load and validate it, so `PIPELINE_SLOTS` / `SIGNAL_CLASSES` / cost-buckets / `learningAgent` follow a renamed row **automatically**. But skill-name **string literals** are hardcoded in **four non-derived seams** that break *silently* on a rename, plus the CI-green tripwire:

1. `decide.py` selectors — `make_dispatch(…, "hydra-dev" / "hydra-qa")`
2. `subagent-capture.ts` — the `SubagentSkill` union (**silent learning-loop severance** if not lock-stepped)
3. `demotion.ts` — `DEFAULT_FRICTION_SKILLS`
4. `hydra-prd-render.ts` + the playbook artifacts
5. **~85 test files** — the tripwire that fails CI if a seam is missed

Tier classifiers are **clean** (path-based, zero skill refs). `hydra-prd` has **no class row** (operator/sub-dispatched → an artifact-rename only). **Expand-contract applies cleanly to every seam**, so the epic can sequence the rewrite as a wide refactor that keeps CI green ticket-to-ticket (add the new identity beside the old, migrate seams, retire the old).

### Decision 6 — Signal-class fate under stage-map-or-die (first-pass, locked here)

Stage-map-or-die requires every surviving orchestrator skill to map to a stage **or a named exception**. The non-stage classes resolve into two exception buckets:

- **Pre-`plan` producers** (feed the `plan`/`wayfinder` intake; keep as signal classes): `research_orch`, `discover`, `architecture` (arch-scan), `cleanup`, `scout` (tool-scout). These are not lifecycle stages — they generate the findings the lineage then plans, specs, tickets, implements, and reviews.
- **Ops / observability exceptions** (no Pocock analogue; keep): `sweep` (board janitor), `retro` (learning capture), `skill_prune`.

`wayfinder_orch` is the `plan`-stage worker (Decision 2), not an exception. This disposition is **first-pass**: the concrete per-skill keep/merge/retire verdict for each of the ~40 orchestrator skills is deferred to the epic (it is ticket-grain, not a map-level decision), but the bucketing rule above is the frame it applies.

## Consequences

- **One lineage, two modes.** Autopilot dispatches the same `to-spec` / `to-tickets` / `implement` / `code-review` the operator runs interactively; the `hydra-prd` / `hydra-dev` / `hydra-qa` fork identities disappear as dispatch classes (`hydra-prd` survives only as a called renderer library).
- **The re-implementation drift is closed at the root** — the AFK path stops carrying a second inline copy of each pattern (Option C), so a change to a stage's behavior is made once, in the composed upstream base + overlay.
- **The learning loop must be re-keyed in lock-step** — `subagent-capture.ts`'s skill union and `demotion.ts`'s friction defaults are silent-failure seams (Decision 5); if a rename lands without them, per-class pattern capture stops with no error. The epic sequences these as blocking prerequisites.
- **CI stays green ticket-to-ticket** via expand-contract; the ~85-test tripwire is the guardrail that a seam was missed.
- **The refit is T3** — self-verifying through the normal gate, no Verifier-Core touch, no operator merge authority required beyond the tier's CI depth.
- **A new dependency exists on the upstream Pocock skills as a vendored base** — a refresh (`npx skills add … --copy`) now flows through the compose step, and the `disable-model-invocation` strip is a standing invariant the compose step must enforce or every dispatched skill hard-errors.
- **Signal classes are unaffected in count** but re-framed: producers vs ops-exceptions, all outside the five-stage spine.

## Alternatives considered

- **Keep the forks, adopt Pocock only interactively** — rejected; it is the status quo that produced the drift the map exists to kill.
- **#3386 Option A (all playbook-generated)** — rejected; gated and tracked, but perpetuates the two-copies re-implementation drift.
- **#3386 Option B (vendor-and-adapt in place)** — rejected; same skill as the operator, but ungated, off-repo, clobbered on refresh, and revives the #666 clobber hazard.
- **Make `research_orch` / `discover` / `architecture` lifecycle stages** — rejected; they produce the findings the lineage consumes, they are not steps in a single work item's lifecycle. Keeping them as pre-`plan` producer signal classes preserves the clean five-stage spine.
- **Big-bang rename (no expand-contract)** — rejected; the four silent-rename seams + 85 test files would red the suite mid-flight and strand the learning loop. Expand-contract is the only sequencing that keeps every intermediate merge green.
- **Defer the signal-class fate and the lineage-home mechanism to the epic** — declined by the operator at capstone; an ADR that leaves its central plumbing (Option C) and its exception frame (Decision 6) open is not a locked ADR. Both are fixed here; only per-skill verdicts remain ticket-grain.
