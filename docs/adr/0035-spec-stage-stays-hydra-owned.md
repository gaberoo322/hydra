---
status: accepted
---

# ADR-0035: The spec stage stays Hydra-owned — `to-spec` is not its base

[ADR-0030](./0030-one-pocock-skill-lineage-replaces-forks.md) Decision 2 bound each stage of
the orchestrator spine to one upstream Pocock skill, and gave the **spec** stage to `to-spec`:
"`design_concept_orch` → `to-spec`; grill-before-build folds in". Four of the five bindings
were correct and have shipped. This one cannot be executed as written.

The vendored `_vendor/to-spec.md` sat wired to nothing for most of a month — no playbook ever
declared `compose_base: _vendor/to-spec.md` — while `design_concept_orch` continued dispatching
the 485-line `hydra-grill`. That gap was read as unfinished work. It is not: the binding is
unimplementable, and the next agent to "finish" it would be composing two skills that
contradict each other on their central instruction.

## Decision

**The spec stage stays Hydra-owned. `hydra-grill` composes on no upstream base, and
`_vendor/to-spec.md` is removed from the AFK path.** ADR-0030 Decision 2 is superseded on this
binding only; its other four stage bindings, Option C, and the stage-map-or-die frame all stand.

### Decision 1 — The two skills disagree on all three axes that matter

| Axis | upstream `to-spec` | `hydra-grill` |
|---|---|---|
| Central instruction | "Do NOT interview the user — just synthesize what you already know." | A relentless Q&A loop; interviewing *is* the skill. |
| Output artifact | A spec issue published to the tracker, labelled `ready-for-agent`. | A design-concept artifact POSTed to `/api/design-concepts`, persisted in Redis. |
| Consumer | A human, or an implementing agent reading the issue. | `gateCheck()`, which gates `dev_orch` dispatch. |

This is not a difference in emphasis that an overlay can smooth over. Composing them means
the emitted skill instructs both "do not interview" and "interview until the fog clears", and
produces an artifact one of the two consumers cannot read.

### Decision 2 — Superseding the conflict would consume the entire base

The structural supersession mechanism (issue #3990; contract in
[`_vendor/README.md`](../operator-playbooks/_vendor/README.md)) excises named base sections at
compose time. Applied honestly to `to-spec`, the overlay would have to supersede the interview stance,
the publish step, **and** the spec template — which is nearly the whole of a 75-line base. What
survives is a handful of lines about seams, at the cost of a permanent conflict surface and a
vendored file to keep refreshed.

A base that must be almost entirely excised is not a base. **Compose only where the upstream
skill contributes something the overlay keeps.** The other four spine bindings clear that bar:
`code-review` contributes its Fowler smell baseline (imported by name), `to-tickets` its
tracer-bullet and blocking-edge discipline, `implement` its TDD-at-seams posture.

### Decision 3 — The real upstream analogue is `grilling`, and it is already cited

`hydra-grill`'s discipline comes from upstream `grilling` — "ask one question at a time" and
"facts vs decisions, do not grill yourself" — which the playbook already cites by name and by
version. That is the honest lineage. Whether to formalise it as a `compose_base` is left open:
the citation is doing the work today, and composition would buy a refresh path for two short
rules at the cost of another vendored file. **Do not treat this as pending work.**

### Decision 4 — The stage's artifact and consumer have no upstream counterpart

Upstream has no analogue of the design-concept gate: a machine-readable artifact, persisted at
a canonical handle, whose freshness a dispatch gate reads before permitting code-writing work
([ADR-0008](./0008-design-concept-gate.md)). A stage whose *output contract* is Hydra-specific
cannot inherit its output contract from upstream. Stage-map-or-die (ADR-0030) requires every
skill to map to a stage or a named exception; the spec stage maps to a stage — it simply owns
its own implementation.

### Decision 5 — `hydra-grill` has no AFK/interactive mode split, and that is a real gap

`hydra-grill` is dispatched both ways — `design_concept_orch` fires it unattended, and the
operator invokes it directly — with no mode contract distinguishing the two. ADR-0030
Decision 3 requires an AFK stage to resolve from artifacts every gate its interactive mode
would ask a human. `hydra-grill` does not state how it does so.

This ADR **names the gap and does not close it**. It is recorded here so the next reader does
not mistake its absence for a decision, and so that closing it is not confused with reviving
the `to-spec` binding — they are unrelated.

## Consequences

- `docs/operator-playbooks/_vendor/to-spec.md` is deleted. `to-spec` remains available to the
  operator interactively through the Pocock plugin; only its use as an AFK compose base ends.
- A future agent reading ADR-0030 Decision 2 alone will still see the `to-spec` binding. The
  in-place supersession note added to that ADR is what prevents acting on it — Decision 2 of
  ADR-0037 forbids renumbering, so amendment-in-place is the only correct form.

## Alternatives considered

- **Compose `hydra-grill` on `to-spec` and supersede the conflicts.** Rejected by Decision 2:
  the surviving base is a handful of lines, bought with a permanent conflict surface. It would
  also stress-test the supersession mechanism on the one case where the right answer is not to
  use it.
- **Add the AFK/interactive mode split first, then re-decide.** Rejected as ordering: the mode
  split is worth doing (Decision 5) but changes nothing about the three-axis mismatch. Deferring
  the binding decision behind it would leave `_vendor/to-spec.md` wired to nothing for another
  month, which is the state that produced this ADR.
- **Retire `design_concept_orch` and let the tickets stage carry the spec.** Rejected: the
  design-concept gate is load-bearing for `dev_orch` (ADR-0008), and the tickets stage produces
  issues, not the artifact `gateCheck()` reads.
