# Hydra Orchestrator

## Language

**Orchestrator**:
The codebase that runs the control loop, manages agents, and holds state. Distinct from the products it builds.
_Avoid_: Hydra (ambiguous — could mean orchestrator or the whole system), "the system"

**Target**:
The software product the orchestrator is currently building.
_Avoid_: project, app, product (each ambiguous in this codebase)

**Target Vision**:
The prose document declaring what the target product is for and how it wins.
_Avoid_: vision (unqualified)

**Orchestrator Vision**:
The prose document declaring what good autonomous building looks like and the trade-offs the orchestrator makes when ambiguous. Separate from target vision.
_Avoid_: vision (unqualified)

**Target Outcomes**:
The structured config declaring the named metrics the orchestrator optimizes the target against. The contract between target vision prose and orchestrator behavior — if these metrics aren't moving, the prose is fiction.
_Avoid_: metrics, KPIs, success criteria

**Untouchable Core**:
The set of orchestrator files Hydra cannot modify via its own PR pipeline — only the operator can. Protects the merge gate, rollback, watchdog, cost guardrails, and the untouchable list itself.
_Avoid_: protected paths (unless referring specifically to the file pattern), frozen code

**Pre-merge Gate**:
The set of CI jobs that must pass before a PR can merge: test, typecheck, dashboard-build, mutation kill-rate (`scripts/ci/mutation-check.ts`), scope enforcement (`scripts/ci/scope-check.ts`), tier-gate (untouchable + tier-classifier). Defined by `.github/workflows/ci.yml`; cannot be bypassed. Disassembled from the in-process Gate module by ADR-0006.
_Avoid_: Gate (ambiguous post-ADR-0006 — the in-process Gate module was disassembled into CI jobs + Merge Lock + Post-merge Regression Check), verification (too narrow), merge gate (overloaded with Merge Lock)

**Merge Lock**:
The Redis primitive (`hydra:merge:lock`, 60s TTL) preventing concurrent merges. Acquired by autopilot subagents via `/api/merge-lock`. Distinct from the **Pre-merge Gate** — the lock serialises merges; the Gate decides whether a merge is allowed at all.
_Avoid_: merge gate (overloaded with Pre-merge Gate)

**Post-merge Regression Check**:
The `hydra-qa` subagent's verification that a merged PR did not regress **Target Outcomes** or the test count. Runs after merge; can trigger a rollback PR. Replaced the deleted in-process Outcome Holdback watcher (`src/holdback.ts`, removed in the ADR-0006 cut-over). Distinct from **Outcome Holdback** (ADR-0004) — the holdback is the *policy* declaring which tiers warrant a watch window; this is the *mechanism* that runs the check.
_Avoid_: rollback (too narrow — this is the check, not the action), holdback watcher (no longer exists as a module)

**Modification Tier**:
The blast-radius classification of a self-modification (Tier 0 Untouchable / 1 auto-merge / 2 auto-merge with outcome holdback / 3 operator review). Determines who merges the PR and whether outcome regression triggers auto-revert. Defined by ADR-0004.
_Avoid_: risk level, severity

**Outcome Holdback**:
The post-merge watch window where a Tier-2 change is monitored against **Target Outcomes**. Regression vs pre-merge baseline triggers auto-revert. Uses leading outcomes only — terminal outcomes are too slow for the watch window.
_Avoid_: canary, soak (overloaded with deploy meanings)

**Design Concept**:
The structured, persisted alignment artifact (`src/design-concept.ts`, `hydra:design-concept:{anchorRef}`) that a code-writing subagent must produce — and an automated gate must accept — before any `dev_orch` / `dev_target` dispatch. Schema includes glossary terms grounded, glossary gaps, modules touched (with interface-impact and depth classification), invariants, rejected alternatives, Q&A trace, and prototype snippets. The same artifact is the ground truth for PR-time two-axis review (Standards + Spec). Defined by ADR-0008 (see epic #437). Phase A (issue #438) ships persistence + API only; autopilot wiring is Phase B, CI hook is Phase C.
_Avoid_: design doc (overloaded), plan (informal), spec (overloaded with `src/specs.ts` — multi-cycle task decomposition, a different thing)

**Operator-Required Intervention**:
The closed list of categories where Hydra escalates to the operator instead of attempting autonomous remedy: credentials/secrets, external-account actions, Tier 0 changes, vision-level conflicts. Everything else Hydra researches and tries. Defined by ADR-0005.
_Avoid_: blocker (overloaded), needs-human (informal)

**Pattern Memory**:
The Redis-backed per-agent / per-skill pattern store (`hydra:memory:{agent}:patterns`, `hydra:friction:{skill}:patterns`) that captures recurring lessons and friction from cycle outcomes. Auto-promotes patterns to `config/feedback/to-{agent}.md` at the 3-hit threshold and dispatches recurring friction to GitHub issues via the **Escalation** seam at the same threshold (+ every multiple of 10 thereafter). Lives in `src/pattern-memory/`.
_Avoid_: agent memory (one of several Redis keys it manages, not the whole concept), lessons (only one of the namespaces — `memory` vs `friction`)

**Reflections**:
The per-anchor and per-file Reflexion-style episodic store (`hydra:reflections:{anchor}`, 7-day TTL by default; extends to 30 days when the reflection has >50% recurrence-success rate). Records *what failed, why, and what to try differently* after a non-merged cycle outcome; loaded into the next attempt at the same anchor (or any anchor touching the same files, post-#326). Distinct from **Pattern Memory** — patterns are durable behaviour rules, reflections are episodic narrative tied to specific cycle attempts. Lives in `src/reflections/`.
_Avoid_: memory (overloaded with Pattern Memory), retrospective (informal)

**Knowledge Base**:
The OpenViking-backed semantic store of indexed source code, reality reports, and subagent session transcripts (`src/knowledge-base/`). Subagents query it for relevant past experience; the indexer watches files and Redis report keys to keep embeddings current. Distinct from **Pattern Memory** (Redis hash store of structured patterns) and **Reflections** (Redis key/value store of episodic narrative) — the Knowledge Base is the semantic / embeddings tier and lives outside Redis (HTTP to the OV service).
_Avoid_: OV (insider shorthand), embeddings store (too narrow — it also holds raw transcripts)

**Redis Adapters**:
The `src/redis/*` Module family — each owns a domain slice of Redis state (cycles, scheduler, work-queue, reflections, plan-cache, …) and exposes typed read/write accessors. Keys (`src/redis/keys.ts`) and raw primitives (`src/redis/kv.ts`) are private to the family. The single Seam for Redis access: TTL, key shape, JSON schema, and index maintenance live behind the Module, not at the call site. Stream keys are an exception by design — they live in `src/event-bus.ts`, which owns the Event Bus alphabet and uses Redis as the implementation. The legacy `src/redis-keys.ts` and `src/redis-adapter.ts` files are migration shims, retired in the final PR of the Seam closure (ADR-0009). Pre-merge Gate job `redis-seam-check` forbids imports of `redis/keys`, `redis/kv`, `redis-keys`, or `redis-adapter` from any file outside `src/redis/`.
_Avoid_: "Redis layer" (too generic), DAO (overloaded), "Redis adapter" (singular — there are 18, not 1), "redis-adapter.ts" (the legacy shim, not the family)

## Relationships

- An **Orchestrator** builds one **Target** at a time; running a second target means a second orchestrator instance, not multi-tenant inside one
- A **Target** has one **Target Vision** (prose) and one **Target Outcomes** (config)
- The **Orchestrator** has its own **Orchestrator Vision**
- The **Gate** is the only path to merge; the **Untouchable Core** includes the **Gate**
- A **Design Concept** is the prerequisite for any code-writing dispatch; PR-time review consumes it as ground truth
- **Pattern Memory**, **Reflections**, and **Knowledge Base** are three independent learning surfaces — patterns are structural rules, reflections are episodic narrative, the Knowledge Base is semantic search. `src/learning.ts` orchestrates them but owns none.
- **Pattern Memory**, **Reflections**, and every other Redis-resident state described above are read and written through the **Redis Adapters**. The raw `hydra:…` keys that appear in their definitions are documentation of today's storage shape, not a public surface — callers obtain values through typed accessors on `src/redis/*`.

## Example dialogue

> **Operator:** "This **Target** PR has been sitting in **Outcome Holdback** for two days."
> **Maintainer:** "Which Tier was it classified?"
> **Operator:** "Tier 2 — leading outcome regressed slightly on the second cycle post-merge."
> **Maintainer:** "OK. The **Post-merge Regression Check** should have already opened a rollback PR if it crossed the threshold. If it didn't, the holdback policy says we ride the watch window to completion — the regression has to be both leading AND a real move beyond `noise_epsilon` for the auto-revert to fire."
