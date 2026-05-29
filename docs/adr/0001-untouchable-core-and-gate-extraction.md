---
status: superseded-in-part by ADR-0015
---

# Untouchable core protects the merge gate from self-modification

> **Superseded-in-part (ADR-0015):** the "operator-modifiable only" premise is retired — the former Untouchable Core is now the **Verifier Core** (T4) and auto-merges under the deepest verification. What survives and is *strengthened* below is the gate-extraction architecture and the principle that a change to the gate is verified by the live gate, not the proposed one (the **Live-Gate Invariant**).

Hydra can propose changes to its own architecture via its PR pipeline, but a designated **Untouchable Core** of files is operator-modifiable only: the gate, rollback, watchdog, cost guardrails, and the protected-paths list itself. Enforced via a CI check that blocks PRs touching protected paths without an `operator-approved` label that only the operator can apply.

The merge gate is being extracted from `src/control-loop.ts` into a new frozen module `src/gate.ts` — grounding, verification, scope enforcement, mutation kill-rate, merge lock, and rollback all live there. The control loop body remains mutable; the gate it calls is not. This lets Hydra evolve loop orchestration (anchor selection, dispatch, drift detection) freely without the ability to bypass what proves the work shipped or what catches it when it fails.

## Considered options

Freezing the whole `src/control-loop.ts` was considered and rejected: the loop body is where most legitimate self-improvement happens, so freezing it would block the "tool-shape evolution" failure mode (Hydra knowing the problem but lacking the capability to fix it) — which is one of the two pain points this work exists to address.
