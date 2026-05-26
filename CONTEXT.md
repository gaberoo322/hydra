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

**Reframe Queue**:
The Redis-backed retry lane (`hydra:anchors:reframe-queue`) holding tasks that have been abandoned or have failed past the prior-failure retry cap. The planner gets a fresh diagnostic prompt for each item instead of looping forever on the same approach. Sits below kanban / work-queue / failing-tests in the anchor-selection priority chain; protected from indefinite shadowing by a capacity-floor cadence (`HYDRA_REFRAME_FLOOR_N`, default every 5 eligible cycles). NOT WIP-gated — bypasses the WIP cap because a reframe item already represents a stuck task. Owned end-to-end by `src/anchor-selection/reframe.ts` (maintenance + selection + starvation instrumentation). Issues #57, #233, #288, #377.
_Avoid_: reframe lane (informal), retry queue (overloaded — distinct from prior-failures queue, which feeds it)

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

**Autopilot Run**:
One invocation of `/hydra-autopilot` — a Claude Code session that wakes on a schedule, walks the decision loop, dispatches subagents, and exits. Bookended by `POST /api/autopilot/run-start` (from `scripts/autopilot/bootstrap.sh`) and `POST /api/autopilot/run-end` (from `term-check.py`). Persisted as a Redis hash at `hydra:autopilot:run:<runId>` plus a ZSET index scored by start time; 7-day TTL. The orchestrator-side lifecycle (start → turn* → end, with idempotency on `runId` and the read-time `running → killed/crash` sweeper for dead-pid runs) is owned by `src/autopilot/runs.ts`. The `Autopilot Run` is the **unit of operator-facing observability** — every dashboard view of "what did the autopilot do" answers questions about one or more runs.
_Avoid_: "autopilot session" (informal), "autopilot job" (overloaded with the dispatched subagents)

**Autopilot Turn**:
One iteration of the decision loop inside an **Autopilot Run** — `decide.py` reads state, picks actions, the playbook executes them, `heartbeat.py` posts `POST /api/autopilot/turn`. Persisted as an immutable JSON member in `hydra:autopilot:run:<runId>:turns` ZSET, scored by `turn_n`. Idempotent on `(runId, turn_n)` — a re-post at the same turn number is a no-op. Each turn carries the dispatch actions it triggered; the **Autopilot Run** view joins those actions onto cycle-record outcomes so the dashboard can show "this turn dispatched X, which produced Y."
_Avoid_: "tick" (overloaded with the orchestrator scheduler's housekeeping loop), "iteration" (informal)

**Redis Adapters**:
The `src/redis/*` Module family — each owns a domain slice of Redis state (cycles, scheduler, work-queue, reflections, plan-cache, …) and exposes typed read/write accessors. Keys (`src/redis/keys.ts`) and raw primitives (`src/redis/kv.ts`) are private to the family. The single Seam for Redis access: TTL, key shape, JSON schema, and index maintenance live behind the Module, not at the call site. Stream keys are an exception by design — they live in `src/event-bus.ts`, which owns the Event Bus alphabet and uses Redis as the implementation. The legacy `src/redis-keys.ts` and `src/redis-adapter.ts` files are migration shims, retired in the final PR of the Seam closure (ADR-0009). Pre-merge Gate job `redis-seam-check` forbids imports of `redis/keys`, `redis/kv`, `redis-keys`, or `redis-adapter` from any file outside `src/redis/`.
_Avoid_: "Redis layer" (too generic), DAO (overloaded), "Redis adapter" (singular — there are 18, not 1), "redis-adapter.ts" (the legacy shim, not the family)

**Schemas**:
The `src/schemas/*` Module family that owns boundary validation for every HTTP request body entering the orchestrator. Each Module exports a zod schema (the runtime parser) and the inferred TypeScript type — both derived from the same `z.object().strict()` declaration, so the schema is the source of truth for both. Handlers `safeParse` inline and return HTTP 400 `{code: "schema-validation-failed", issues: result.error.issues}` on failure so callers — including subagents — pattern-match on a structured error shape instead of parsing prose. Pre-merge Gate job `schema-validation-check` forbids `req.body.<field>` access outside a parsed-result variable in `src/api/*`, enforced via a shrink-only baseline ratchet (`scripts/ci/schema-validation-baseline.json`) mirroring the **Redis Adapters** closure mechanic. The Seam excludes Redis reads (owned by **Redis Adapters**), HTTP query/param values (validated inline by handler convention), and structured subagent outputs (a separate boundary, not the HTTP-input surface). First landed Module: `src/schemas/queue.ts` (covers `POST /api/queue`, #562).
_Avoid_: validation (too generic), DTOs (REST-overloaded), "zod schemas" (too narrow — it's the Module that wraps the zod object), "request validation" (misses the inferred-type half of what the Module exists for)

**Subscription Usage Tracker**:
The `src/cost/usage-tracker.ts` Module that projects rolling 5-hour and 7-day token consumption against the operator's Claude Code subscription quota. Reads the JSONL session transcripts under `~/.claude/projects/**/*.jsonl` — the same on-disk data source the CLI's interactive `/usage` command parses — because Claude Code exposes no programmatic usage-introspection surface (no `claude --usage`, no SDK call, no documented state file). Snapshot is calibrated by env (`HYDRA_USAGE_WEEKLY_QUOTA_TOKENS`, `HYDRA_USAGE_5H_QUOTA_TOKENS`); without those set, raw token counts are still reported but percentages, `pacingState`, and `emergencyStop` stay neutral. The Module is a pure read-side projection — no Redis writes, no event bus — memoized for 60s in-process to bound the cost of multiple readers within one autopilot tick. Surfaced over HTTP at `GET /api/usage`. The autopilot integration that actually consumes `emergencyStop` (hard-stop the tick) and `pacingState === "over"` (shed `discover_*` and `sweep_*`, keep `dev_*`, `qa`, `health`) lands in a follow-up PR.
_Avoid_: spend tracker (carry-over name from the deleted dollar-cap path — the orchestrator pays no dollar costs under the Claude Code subscription model), daily-spend (the old surrogate), cost tracker (too generic)

## Relationships

- An **Orchestrator** builds one **Target** at a time; running a second target means a second orchestrator instance, not multi-tenant inside one
- A **Target** has one **Target Vision** (prose) and one **Target Outcomes** (config)
- The **Orchestrator** has its own **Orchestrator Vision**
- The **Gate** is the only path to merge; the **Untouchable Core** includes the **Gate**
- A **Design Concept** is the prerequisite for any code-writing dispatch; PR-time review consumes it as ground truth
- **Pattern Memory**, **Reflections**, and **Knowledge Base** are three independent learning surfaces — patterns are structural rules, reflections are episodic narrative, the Knowledge Base is semantic search. They sit at two different seams: **Pattern Memory** and **Reflections** are composed at agent-dispatch time by `src/learning.ts::getContext()`, which injects them into the subagent prompt; the **Knowledge Base** is queried by subagents directly via OV HTTP at their own discretion during their work. `src/learning.ts` owns neither surface — it composes the first two and exposes the composition's diagnostic trace.
- **Pattern Memory**, **Reflections**, and every other Redis-resident state described above are read and written through the **Redis Adapters**. The raw `hydra:…` keys that appear in their definitions are documentation of today's storage shape, not a public surface — callers obtain values through typed accessors on `src/redis/*`.
- Every HTTP request body entering `src/api/*` passes through the **Schemas** Seam before its fields are read. **Schemas** and **Redis Adapters** are sibling Seams at opposite ends of the orchestrator — Schemas hardens the *external-input* boundary; Redis Adapters hardens the *storage* boundary. Each Module's lint rule is the mechanism that converts a hypothetical Seam (one adapter) into a real one (forced multiple adapters under CI enforcement).

## Example dialogue

> **Operator:** "This **Target** PR has been sitting in **Outcome Holdback** for two days."
> **Maintainer:** "Which Tier was it classified?"
> **Operator:** "Tier 2 — leading outcome regressed slightly on the second cycle post-merge."
> **Maintainer:** "OK. The **Post-merge Regression Check** should have already opened a rollback PR if it crossed the threshold. If it didn't, the holdback policy says we ride the watch window to completion — the regression has to be both leading AND a real move beyond `noise_epsilon` for the auto-revert to fire."
