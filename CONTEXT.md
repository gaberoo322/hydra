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

**Builder Health**:
The capability of the orchestrator-as-builder, measured as a small, trended set of metrics (the **Builder-Health Scorecard**) that answers whether the 25% **Self-Improvement Share** investment is producing a measurably better builder. The builder-side counterpart to **Target Outcomes** — where Target Outcomes measure the product the orchestrator builds, Builder Health measures the orchestrator's own ability to build. Composed read-only from existing signal (capacity-floor, cycle metrics, lessons/friction trends) plus two new derivations (**Autonomy Rate**, time-to-merge); surfaced in the digest and dashboard. Grounded in ADR-0003 (the floor is an input with no output signal today) and the Orchestrator Vision mandate to surface builder health honestly.
_Avoid_: orchestrator health (overloaded with the service-level liveness check at `/api/health`), self-improvement metrics (informal), velocity (too narrow)

**Health Snapshot**:
The normalized internal model the `/api/health/deep` handler builds from its probe fan-out — everything a **Health Diagnostic** rule may read (basic health, scheduler status, service probes, queue/backlog counts, disk/mem/systemd, patterns/reflections/OV search, the emergency brake, and the `recent` pipeline metrics carrying raw counts *and* rates). Produced by `parseProbes()` in `src/health-diagnostics.ts`; the handler owns only the I/O fan-out and the HTTP wire projection. Distinct from **Builder Health** (a trended capability metric) and the `/api/health` liveness boolean (process up).
_Avoid_: health state (vague), health payload (that is the HTTP wire envelope, a projection of the snapshot), metrics (overloaded)

**Health Diagnostic**:
One finding emitted by the `/api/health/deep` ruleset — a structured `{severity, component, what, why, impact, action, autoRecovery}` record describing a single thing that is or may be wrong. Produced by a pure rule function `(snapshot: HealthSnapshot) => HealthDiagnostic | null` in `src/health-diagnostics.ts`; adding a condition = appending one rule. Distinct from a `/recommendations` operator action item (a different surface).
_Avoid_: alert (implies a push/notification channel we do not have), check (the probe is the check; this is its interpreted result), warning (one severity, not the category)

**Health Assessment**:
The folded result of running every **Health Diagnostic** rule over a **Health Snapshot** — `{diagnostics, status, summary}`, where `status` is the worst-severity fold (`critical > unhealthy > degraded > healthy`) and `summary` is the human banner. Produced by `assessHealth()` in `src/health-diagnostics.ts` and projected verbatim onto the `/api/health/deep` response. Distinct from **Builder Health** (capability trend, not a point-in-time fault scan).
_Avoid_: health report (the HTTP wire envelope is the report; this is the pure core that feeds it), health score (it is a status enum + diagnostics list, not a number)

**Self-Improvement Share**:
The share of recent non-idle cycles whose merged work was orchestrator-side rather than target-side, over a rolling window. The realised output signal for the 25% self-improvement floor (ADR-0003): the floor is the *input* budget, this share is the *observed* spend. Computed by `capacity-floor.ts` against `ORCHESTRATOR_FLOOR = 0.25`; the headline self-investment input to the **Builder-Health Scorecard**.
_Avoid_: capacity split (the dashboard label, not the metric), self-improvement floor (the target, not the realised value), 25% floor (the threshold, not the measurement)

**Autonomy Rate**:
The headline **Builder Health** metric: the share of dispatches reaching a merged PR with zero **Operator-Required Intervention**, over a rolling window. A dispatch is *autonomous* iff its PR was merged by the auto-merge bot AND its issue/PR timeline never carried an `operator-approved` or `ready-for-human` label AND no human authored a review or commit on the branch — i.e. nothing on the closed escalation list (ADR-0005) was touched. An automated rebase is *not* intervention (it is autonomous self-healing). Derived from GitHub on read via the dispatch→PR link; no per-dispatch intervention flag is stored.
_Avoid_: merge rate (whole-system, not zero-intervention — distinct metric in the scorecard), success rate (overloaded), hands-off rate (informal)

**Verifier Core**:
The five self-referential files where a bad merge would disable *future* verification: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`. Still auto-mergeable (T4), but guarded by the **Live-Gate Invariant** and the deepest **Modification Tier** verification. Defined by ADR-0015.
_Avoid_: Untouchable Core (retired by ADR-0015 — nothing is untouchable; T4 is touchable with the deepest verification), protected paths, frozen code, Tier 0

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
The depth of verification a self-modification must clear before it **auto-merges** — NOT who merges it. Every tier auto-merges; the operator is never a gate. Monotonic in blast radius: **T1** prompt-shaped (`config/agents/`, `config/feedback/`) = CI + standard QA; **T2** behaviour-shaping (`.claude/skills/`, `dashboard/`, anchor-selection) = T1 + **Outcome Holdback**; **T3** core `src/` (incl. `grounding.ts`, `src/cost/`, watchdogs, `deploy.sh`) = T2 + raised mutation floor + scope-clean + adversarial QA; **T4** **Verifier Core** = T3 + the deep-QA remediation loop + **Live-Gate Invariant**. Defined by ADR-0015 (supersedes the ADR-0004 authority ladder).
_Avoid_: risk level, severity, "who merges" (authority is no longer an axis), Tier 0 (retired — T4 is the deepest tier)

**Outcome Holdback**:
The post-merge watch window where a merged change is monitored against **Target Outcomes**; regression vs pre-merge baseline triggers auto-revert. Uses leading outcomes only — terminal outcomes are too slow for the watch window. Applies to **T2 and up** (it carries up the ladder — every tier deeper than T1 inherits it), not T2 alone.
_Avoid_: canary, soak (overloaded with deploy meanings)

**Live-Gate Invariant**:
The rule that a change to the **Verifier Core** is verified by the *currently-deployed* gate, never by the proposed one — CI runs the verifier scripts from the **base** ref and reviews the diff against live behaviour. The single principle that makes auto-merging `ci.yml`/`tier-classify*.ts`/`untouchable.ts` safe instead of circular: a malformed gate that "always passes" is judged by the old gate, which still works. Defined by ADR-0015.
_Avoid_: self-check, base-ref check (too narrow — it's the invariant, not one CI flag)

**Deep-QA Remediation Loop**:
The verification escalation a **T4** change must survive: a specialized QA reviewer comments on the PR and bounces it back to a dev agent; a **second** failed pass blocks the PR and routes it to the operator via the `/hydra-review` set. The remediation loop (QA fail → bounce → retry) is universal across tiers; the block-and-escalate *teeth* and the specialized/adversarial reviewer depth are T4-only. Implemented by extending the tier-aware `hydra-qa` skill with a Verifier-Core checklist, not a separate agent. Defined by ADR-0015.
_Avoid_: deep QA (informal), re-review loop (misses the escalation/block half)

**Deep-QA PASS marker**:
The positive, SHA-bound proof that a **T4** PR cleared the deep-QA branch of the **Deep-QA Remediation Loop**: a PR comment of the exact form `Verifier-Core deep-QA: PASS @ <head-sha>`, posted by `hydra-qa`'s T4 PASS path. The PASS counterpart to the `Verifier-Core deep-QA: FAIL` ledger marker — same PR-as-ledger surface (no new verdict literal, Redis key, or label). The `deep-qa-gate` required check verifies a marker matching the PR's *current* head SHA before a T4 PR may merge; new commits invalidate a stale marker and force re-QA. It is **bug-defense, not adversary-defense** — all agents share one GitHub identity, so the marker proves the deep branch ran in the normal flow but is forgeable by a same-identity agent (a separate QA identity is the future hardening). Replaces the `operator-approved`-label block as the T4 merge gate. Defined by ADR-0020.
_Avoid_: operator-approved (retired as the T4 gate), deep-QA verdict (it is a ledger marker, not a `FinalVerdict` literal)

**Design Concept**:
The structured, persisted alignment artifact (`src/design-concept.ts`, `hydra:design-concept:{anchorRef}`) that a code-writing subagent must produce — and an automated gate must accept — before any `dev_orch` / `dev_target` dispatch. Schema includes glossary terms grounded, glossary gaps, modules touched (with interface-impact and depth classification), invariants, rejected alternatives, Q&A trace, and prototype snippets. The same artifact is the ground truth for PR-time two-axis review (Standards + Spec). Defined by ADR-0008 (see epic #437). Phase A (issue #438) ships persistence + API only; autopilot wiring is Phase B, CI hook is Phase C.
_Avoid_: design doc (overloaded), plan (informal), spec (overloaded with `src/specs.ts` — multi-cycle task decomposition, a different thing)

**Candidate Feed**:
The ranked, scored list of eligible anchors the autopilot brain (`decide.py`) reads to choose a dispatch, served at `GET /api/anchor/candidates` (issue #424). Sourced from the two live work lanes — backlog kanban ∪ work-queue (the only lanes with live writers) — scored by tier base + reflection penalty + blocker-just-cleared bonus, and filtered by eligibility (in-flight-PR freshness window, design-concept gate, research-recommended threshold). Owned end-to-end by `src/anchor-candidates.ts`; `src/api/anchor.ts` is a thin route over it. The feed carries **data, not decisions** — retry / escalation / abandonment *policy*, if ever wanted, belongs to `decide.py` per [[ADR-0012]], not to a TypeScript work-picker. Defined by [[ADR-0016]], which retired the orphaned `selectAnchor()` priority waterfall.
_Avoid_: "priority waterfall" / "anchor selection" / "selectAnchor()" (the 13-tier chain was retired with the in-process control loop — ADR-0006/0016), "Reframe Queue" (the retry lane it described had no live writer and was deleted by ADR-0016), candidate list (too generic)

**Operator-Required Intervention**:
The closed list of categories where Hydra escalates to the operator instead of attempting autonomous remedy: credentials/secrets, external-account actions, vision-level conflicts, and a **second** failed **Deep-QA Remediation Loop** pass on a T4 change. Everything else Hydra researches and tries. Tier no longer triggers escalation (ADR-0015 retired the operator-only tier); only an exhausted remediation loop does. Defined by ADR-0005 (amended by ADR-0015).
_Avoid_: blocker (overloaded), needs-human (informal), "Tier 0 changes" (retired escalation trigger)

**Pattern Memory**:
The Redis-backed per-agent / per-skill pattern store (`hydra:memory:{agent}:patterns`, `hydra:friction:{skill}:patterns`) that captures recurring lessons and friction from cycle outcomes. Auto-promotes patterns to `config/feedback/to-{agent}.md` at the 3-hit threshold and dispatches recurring friction to GitHub issues via the **Escalation** seam at the same threshold (+ every multiple of 10 thereafter). Lives in `src/pattern-memory/`.
_Avoid_: agent memory (one of several Redis keys it manages, not the whole concept), lessons (only one of the namespaces — `memory` vs `friction`)

**Feedback File**:
The on-disk prompt-shaping artifact `config/feedback/to-{agent}.md` that **Pattern Memory** promotion writes into, plus the markdown grammar that governs it: the `## Auto-Promoted Rules` and `## Stale Rules (review needed)` sections and the `### <category> (Nx since <date>)` promoted-rule block with its `<!-- auto-promoted <date>, last hit <date> -->` trailer. The grammar — path resolution, section layout, block format, and the three block operations (append a promoted block, remove a demoted block, archive a stale block) — is owned by one Module (`src/pattern-memory/feedback-file.ts`), so a format change is a one-place edit rather than a writer-plus-two-readers sweep held together by a comment (issue #940). The promotion (`agent-memory.ts`), stale-archival (`agent-memory.ts`), and demotion (`rule-effectiveness.ts`) callers operate on named Feedback-File operations rather than each re-deriving the grammar over raw markdown. A sibling Module to **Pattern Memory**'s store + promotion, mirroring the **Escalation** (#823) and rule-effectiveness (#900) splits. The byte format on disk is unchanged — this concentrates *where the grammar is defined*, not the format itself.
_Avoid_: "feedback grammar" (too narrow — the Module owns the path + sections + block ops, not just the heading regex), "the to-{agent} files" (the artifact, not the owning Module), bundling it into **Pattern Memory** (it is the on-disk-format Seam, distinct from the Redis pattern store)

**Escalation Outcome**:
The durable *result* of an escalation that actually fired — the `EscalationResult` discriminated union (`created` / `commented` / `reopened` / `skipped` / `error`) `escalatePatternToIssue` computes, threaded up through `escalateIfNeeded` and `recordPattern` and stamped on the pattern record as `MemoryPattern.lastEscalation` (full-ISO `at`, written only when an escalation fired). Distinct from the *act* of escalating (the **Escalation** seam) and from the escalation *intent* (`EscalationInput`, the decision that an escalation is due). Surfaced per-row on the `/learning/friction-patterns` observability surface, so a systematic gh/auth outage shows as a column of `error` statuses instead of a silent `console.error` (issue #843). Lives in `src/pattern-memory/escalation.ts` (the type) + `agent-memory.ts` (the stamp).
_Avoid_: escalation (the seam / act, not the result), escalation intent (`EscalationInput` — the pre-dispatch decision, not the outcome)

**Reflections**:
The per-anchor and per-file Reflexion-style episodic store (`hydra:reflections:{anchor}`, 7-day TTL by default; extends to 30 days when the reflection has >50% recurrence-success rate). Records *what failed, why, and what to try differently* after a non-merged cycle outcome; loaded into the next attempt at the same anchor (or any anchor touching the same files, post-#326). Distinct from **Pattern Memory** — patterns are durable behaviour rules, reflections are episodic narrative tied to specific cycle attempts. Lives in `src/reflections/`.
_Avoid_: memory (overloaded with Pattern Memory), retrospective (informal)

**Knowledge Base**:
The OpenViking-backed semantic store of indexed source code, reality reports, and subagent session transcripts (`src/knowledge-base/`). Subagents query it for relevant past experience; the indexer watches files and Redis report keys to keep embeddings current. Distinct from **Pattern Memory** (Redis hash store of structured patterns) and **Reflections** (Redis key/value store of episodic narrative) — the Knowledge Base is the semantic / embeddings tier and lives outside Redis (HTTP to the OV service).
_Avoid_: OV (insider shorthand), embeddings store (too narrow — it also holds raw transcripts)

**Learning Context**:
The structured value `src/learning.ts::getContext()` returns — the dispatch-time composition of the learning surfaces into a subagent prompt, as an ordered list of **Learning Context Blocks** rather than an opaque string. Each block names its `source` (`agent-memory`, `knowledge-base`, `per-anchor-reflections`, `by-file-reflections`, `global-reflections`), a `status` (`hit` / `miss` / `error`), a typed `itemCount`, and a within-bundle drop priority. It is **the test surface** for "what context a subagent receives" and the structured payload behind `/api/learning/context-trace`. Budgeting drops whole blocks lowest-priority-first (never slicing a reflection mid-text), so post-budget accounting (`reflectionInjected` / `reflectionSources`) is read off surviving blocks, not re-parsed from rendered markdown. Per-anchor reflections are never dropped before another learning block (retry correctness, #193). Defined by issue #804.
_Avoid_: planner context (too narrow — `PlannerContext` is the wider struct that *embeds* this plus grounding/priorities/feedback), plannerMemory (the legacy flattened string this replaces), context trace (the diagnostic endpoint, not the value)

**Autopilot Run**:
One invocation of `/hydra-autopilot` — a Claude Code session that wakes on a schedule, walks the decision loop, dispatches subagents, and exits. Bookended by `POST /api/autopilot/run-start` (from `scripts/autopilot/bootstrap.sh`) and `POST /api/autopilot/run-end` (from `term-check.py`). Persisted as a Redis hash at `hydra:autopilot:run:<runId>` plus a ZSET index scored by start time; 7-day TTL. The orchestrator-side lifecycle (start → turn* → end, with idempotency on `runId` and the read-time `running → killed/crash` sweeper for dead-pid runs) is owned by `src/autopilot/runs.ts`. The `Autopilot Run` is the **unit of operator-facing observability** — every dashboard view of "what did the autopilot do" answers questions about one or more runs.
_Avoid_: "autopilot session" (informal), "autopilot job" (overloaded with the dispatched subagents)

**Autopilot Turn**:
One iteration of the decision loop inside an **Autopilot Run** — `decide.py` reads state, picks actions, the playbook executes them, `heartbeat.py` posts `POST /api/autopilot/turn`. Persisted as an immutable JSON member in `hydra:autopilot:run:<runId>:turns` ZSET, scored by `turn_n`. Idempotent on `(runId, turn_n)` — a re-post at the same turn number is a no-op. Each turn carries the dispatch actions it triggered; the **Autopilot Run** view joins those actions onto cycle-record outcomes so the dashboard can show "this turn dispatched X, which produced Y."
_Avoid_: "tick" (overloaded with the **Orchestrator Scheduler** loop), "iteration" (informal)

**Orchestrator Scheduler** (a.k.a. **Observability Heartbeat**):
The in-process heartbeat in `src/scheduler/heartbeat.ts` (renamed from the former `loop.ts` in #725, scheduler fold PR-4/4) that ticks every 5 minutes while `hydra-orchestrator.service` is running. Continuously alive — distinct from the **Autopilot Run**, which is a discrete timer-fired session. Per the architecture decision recorded in [[ADR-0012]] ("scheduler is bookkeeping; autopilot is decisions"), it is **strictly observability-and-counters only**: it stamps `lastTickAt` (watchdog liveness), computes rolling merge-rate windows, holds the deliberate-stop marker, and rehydrates lifetime cycle counters. It does NOT make policy decisions, dispatch work, or mutate kanban/work-queue state based on rules. The historical research-floor and stale-claim-reaper logic moved into `decide.py` (the **Autopilot Run** owns all decisions about *what to do*; the Heartbeat only records *what happened*). The module-rename to **Observability Heartbeat** (anticipated here) landed in #725, completing PP-1.
_Avoid_: "scheduler" (unqualified — could mean this loop, the systemd timers, or the scheduling concept generally), "control loop" (was retired in [[ADR-0006]]; do not use), "in-process loop" (informal)

**Research Floor**:
The 24-hour silence threshold currently enforced inside the **Orchestrator Scheduler** (`src/scheduler/research-floor.ts`) — when no research cycle has run for ≥24h AND the work queue has slack, the floor "fires" and the Scheduler launches a research cycle via `runResearchLoop`. A parallel, structurally-identical policy lives in `decide.py:_research_force_allowed` for the autopilot's `research_orch` slot. Per the ADR collapsing scheduler decisional authority, the Scheduler-side floor is being deleted; the autopilot-side policy becomes the single source of truth.
_Avoid_: "research throttle" (informal), "research silence" (one input to the policy, not the policy itself)

**Epic**:
A GitHub issue carrying a `## Sub-issues` section that links N child issues; satisfaction is "every child CLOSED." The **unit of work**. Auto-closes via the `hydra-epic-close` skill when satisfaction holds. The orchestrator-side analogue of a "deliverable" — multi-PR work that hangs together and finishes together. Examples: #437 (design-concept gate, three sub-phases), #642 (now-pixel dashboard slices). Distinct from **Roadmap Milestone** (timeline grouping of epics), **Focus Label** (theme tag on individual issues), and **Autopilot Focus** (the operator-set pointer that biases the autopilot's dispatch).
_Avoid_: "parent issue" (ambiguous — could also mean a tracking issue without satisfaction semantics), "story" (Jira-flavored), "feature" (overloaded)

**Roadmap Milestone**:
A timeline grouping in `config/direction/roadmap.md` that names one or more **Epics** intended to ship in the same window. Free-form prose today — no GitHub Milestone object, no machine-checked completion. The roadmap is refreshed by the `hydra-target-research` skill on its research cycle. Provides operator-facing answers to "what are we shipping next" without committing the orchestrator to a schedule.
_Avoid_: "milestone" (unqualified — GitHub also has a Milestone object; we don't use that), "sprint" (we don't sprint), "phase" (overloaded with epic sub-phases)

**Focus Label**:
A GitHub issue label of the form `focus-<theme>` (e.g. `focus-modernization`, `focus-kalshi-integration`, `focus-orch-tech-debt`) that tags an individual issue with a theme. Orthogonal to **Epic** and **Roadmap Milestone** — the same issue can belong to one Epic, be referenced by one Milestone, and carry one Focus Label. The label vocabulary is operator-curated; no fixed taxonomy. Doesn't currently exist as a label family in the issue tracker, but is the natural shape for the theme-axis of work grouping.
_Avoid_: "tag" (overloaded), "category" (already used for triage roles `bug` vs `enhancement`), "focus area" (informal)

**Autopilot Focus**:
The operator-set pointer at `hydra:autopilot:focus` that biases — but does not gate — `decide.py`'s candidate selection. One of four shapes: `epic:<N>`, `milestone:<slug>`, `label:<l>` (typically a **Focus Label**), or `auto` (no bias; full candidate set). Set/cleared via `hydra focus set <kind> <value>` / `hydra focus clear`; observed in `decide.py:_select_for_slot` which prefers focus-matching candidates when the intersection is non-empty, else falls back to the global top-scored eligible candidate. **The focus biases; it never blocks** — if nothing in the focus area is eligible, the autopilot does normal work. Surfaced on the dashboard with the current value plus an eligible-in-focus count so the operator can spot a wedged or stale focus.
_Avoid_: "campaign" (the original framing — rejected because **Epic** already does the unit-of-work job and **Autopilot Focus** is just a pointer, not a new object family), "priority" (overloaded with backlog priority field), "filter" (too strong — focus doesn't filter out non-matches, just biases toward matches)

**GitHub CLI Adapter**:
The `src/github/*` Module family that owns the `gh`/`git` external-process boundary — the third boundary Seam, sibling to **Redis Adapters** (storage) and **Schemas** (HTTP input). A single private spawn primitive (`src/github/exec.ts` — `runExec`, `classifyFailure`, `ghBin`/`gitBin`) concentrates the binary resolution (`HYDRA_GH_BIN`/`HYDRA_GIT_BIN` overrides), the timeout discipline, and the four external-process error modes (binary-not-installed, auth failure, empty stdout, malformed JSON); the typed accessors `ghExec`/`ghJson<T>` (`src/github/gh.ts`) and `gitExec` (`src/github/git.ts`) are its only callers and expose a discriminated `GhResult<T>` (`{ok:true; data} | {ok:false; code; stderr}`) to the rest of `src/`. The `gh-*` failure codes are result-object literals on the `HydraErrorCode` union — the Seam returns, it never throws (CLAUDE.md). Pre-merge Gate job `github-seam-check` forbids `node:child_process` imports from any file outside `src/github/`, enforced via a shrink-only baseline ratchet (`scripts/ci/github-seam-baseline.json`) mirroring the **Redis Adapters** / **Schemas** closure mechanic. Excludes `src/exec-with-timeout.ts` (a separate process-group-aware primitive for test-runner subprocesses, not a `gh`/`git` caller). Tracer-bullet caller `src/pattern-memory/escalation.ts` (#896/#897); remaining direct-`child_process` callers fold on slice by slice (#899).
_Avoid_: "gh wrapper" (too narrow — it owns `git` too), "github adapter" (singular — there are two adapters, `gh` and `git`, on one primitive), "exec layer" (too generic — `src/exec-with-timeout.ts` is a different exec primitive outside this Seam), `child_process` calls (the thing the Seam exists to forbid at call sites)

**GitHub Issue/PR Read**:
The `src/github/issues.ts` domain-read Seam that sits ABOVE the **GitHub CLI Adapter** (it consumes `ghJson`, it does not spawn) and BELOW the dashboard aggregators. The Adapter owns the *raw process* boundary but `ghJson<T>` is shallow — a caller still has to know the whole `gh issue list` CLI surface plus the dispatch-class taxonomy. This Module concentrates the *domain-read* boundary in one place each: the repo handle (`resolveGithubRepo` — env-overridable via `HYDRA_GITHUB_REPO`, default `gaberoo322/hydra`), the autopilot **dispatch-class taxonomy** (`KNOWN_CLASS_LABELS` + the two classifier flavors `classFromLabels` → `"unclassified"` and `classLabelFromLabels` → `null`, formerly a divergent array-in-`backlog-flow` vs Set-in-`recent-merges` copy), the canonical `--json` field set + typed rows (`IssueRow`/`PrRow`, `parseIssueRows`/`parsePrRows`), and the label/search list + PR-view readers (`listIssuesByLabel`, `listIssuesBySearch`, `listOpenPrs`, `viewPr`). The list readers return a discriminated `IssueReadResult<T>` (`{ok:true; rows} | {ok:false; code}`) and never throw; the `*OrEmpty` wrappers fold the failure arm to `[]` after logging, for the `Promise.allSettled` aggregators. Distinct from the **GitHub CLI Adapter** (process seam, #899), the friction GitHub read (`aggregators/friction-source.ts::readMetaFrictionIssues`, #864), and the metric-join composition (`src/metrics/*`, #820). Introduced by #908.
_Avoid_: "github adapter" (that is the process Seam below this one), "issue API" (it reads via the `gh` CLI, not the REST API), reimplementing `KNOWN_CLASS_LABELS` at a call site (the drift this Seam exists to prevent)

**Host-Probe Adapter**:
The `src/host-probe/*` Module family that owns the host-info external-process boundary — the `df`/`free`/`systemctl` binaries — as a sibling Seam to the **GitHub CLI Adapter** (`gh`/`git`), on the same private spawn discipline but a *separate* primitive (it does NOT import `src/github/exec.ts` — each process Seam owns its own `node:child_process`). A single private spawn primitive (`src/host-probe/exec.ts`) concentrates the binary resolution, the timeout discipline, and the external-process error modes; the typed accessors (`src/host-probe/probe.ts` — disk/mem/service-status readers) are its only callers and expose a discriminated never-throw result (`{ok:true; data} | {ok:false; code}`) to the rest of `src/`, replacing the `.catch(() => null)` / `.catch(() => "unknown")` sentinels that `/api/health/deep` inlined. The `df`/`free` columnar parse moves here from `parseProbes` (`src/health-diagnostics.ts`). With the spawning behind the adapter, `src/api/health.ts` drops off the `github-seam-check` baseline (which closes to zero); `src/host-probe/*` is carved out of the `github-seam-check` `node:child_process` scan (it spawns host binaries, not `gh`/`git`), and a sibling `host-probe-seam-check` ratchet forbids host-binary `child_process` imports outside the family. Excludes `src/exec-with-timeout.ts` (the process-group-aware test-runner primitive, a third unrelated exec concern).
_Avoid_: "health adapter" (too narrow — it owns the host-info boundary, not the `/api/health` route), "exec layer" (too generic — there are three distinct exec primitives: this Seam, the **GitHub CLI Adapter**, and `src/exec-with-timeout.ts`), "systemctl wrapper" (too narrow — it owns `df`/`free` too), reusing `src/github/exec.ts` from a host probe (couples two Seams — each owns its own spawn primitive)

**Redis Adapters**:
The `src/redis/*` Module family — each owns a domain slice of Redis state (cycles, scheduler, work-queue, reflections, plan-cache, …) and exposes typed read/write accessors. Keys (`src/redis/keys.ts`) and raw primitives (`src/redis/kv.ts`) are private to the family. The single Seam for Redis access: TTL, key shape, JSON schema, and index maintenance live behind the Module, not at the call site. Stream keys are an exception by design — they live in `src/event-bus.ts`, which owns the Event Bus alphabet and uses Redis as the implementation. The legacy `src/redis-keys.ts` and `src/redis-adapter.ts` files are migration shims, retired in the final PR of the Seam closure (ADR-0009). Pre-merge Gate job `redis-seam-check` forbids imports of `redis/keys`, `redis/kv`, `redis-keys`, or `redis-adapter` from any file outside `src/redis/`.
_Avoid_: "Redis layer" (too generic), DAO (overloaded), "Redis adapter" (singular — there are 18, not 1), "redis-adapter.ts" (the legacy shim, not the family)

**Schemas**:
The `src/schemas/*` Module family that owns boundary validation for every HTTP request body entering the orchestrator. Each Module exports a zod schema (the runtime parser) and the inferred TypeScript type — both derived from the same `z.object().strict()` declaration, so the schema is the source of truth for both. Handlers `safeParse` inline and return HTTP 400 `{code: "schema-validation-failed", issues: result.error.issues}` on failure so callers — including subagents — pattern-match on a structured error shape instead of parsing prose. Pre-merge Gate job `schema-validation-check` forbids `req.body.<field>` access outside a parsed-result variable in `src/api/*`, enforced via a shrink-only baseline ratchet (`scripts/ci/schema-validation-baseline.json`) mirroring the **Redis Adapters** closure mechanic. The Seam excludes Redis reads (owned by **Redis Adapters**), HTTP query/param values (validated inline by handler convention), and structured subagent outputs (a separate boundary, not the HTTP-input surface). First landed Module: `src/schemas/queue.ts` (covers `POST /api/queue`, #562).
_Avoid_: validation (too generic), DTOs (REST-overloaded), "zod schemas" (too narrow — it's the Module that wraps the zod object), "request validation" (misses the inferred-type half of what the Module exists for)

**Subscription Usage Tracker**:
The `src/cost/usage-tracker.ts` Module that projects rolling 5-hour and 7-day token consumption against the operator's Claude Code subscription quota. Reads the JSONL session transcripts under `~/.claude/projects/**/*.jsonl` — the same on-disk data source the CLI's interactive `/usage` command parses — because Claude Code exposes no programmatic usage-introspection surface (no `claude --usage`, no SDK call, no documented state file). Snapshot is calibrated by env (`HYDRA_USAGE_WEEKLY_QUOTA_TOKENS`, `HYDRA_USAGE_5H_QUOTA_TOKENS`); without those set, raw token counts are still reported but percentages, `pacingState`, and `emergencyStop` stay neutral. The Module is a pure read-side projection — no Redis writes, no event bus — memoized for 60s in-process to bound the cost of multiple readers within one autopilot tick. Surfaced over HTTP at `GET /api/usage` and `GET /api/usage/eligibility` (the autopilot-facing projection consumed by `decide.py` via `state.usage_eligibility` to hard-stop on `emergencyStop` and shed `discover_*`/`sweep_*`/`scout_orch` on `pacingState === "over"`). Imports flow through the `src/cost/index.ts` Module surface.
_Avoid_: spend tracker (carry-over name from the deleted dollar-cap path — the orchestrator pays no dollar costs under the Claude Code subscription model), daily-spend (the old surrogate), cost tracker (too generic — `Cost` is the parent Module that wraps it)

**Cost**:
The `src/cost/` Module family that owns Claude Code subagent spend accounting on the orchestrator side: token recording + per-skill/per-cycle attribution (`surrogate.ts`), tier rollups for the dashboard (`attribution.ts`), and Anthropic-quota projection (`usage-tracker.ts` — the **Subscription Usage Tracker**). Single public Interface at `src/cost/index.ts`; the internal split between the three implementation files is invisible to callers. Storage delegated to `src/redis/cost.ts` (Redis Adapter for `hydra:cost:*`) and the JSONL transcripts on disk (tracker). The Module is **accounting + projection only** — actual gating happens in the autopilot via `/api/usage/eligibility`. Three codex-era pieces were retired in the cleanup wave: the JSONL reconciliation pipeline (#602), the dollar-based scheduler daily-spend cap (B-series), and the per-cycle circuit breaker (`src/cost/cap.ts`, this PR). Tier 0 (Untouchable Core).
_Avoid_: cost module (too generic — capitalize **Cost**), cost-attribution (one of three sub-Modules), token-tracking (too narrow — misses attribution + tracker)

**Quota Weight**:
The per-model multiplier that converts raw token counts into a comparable quota-burn unit (`opus * w_opus + sonnet * w_sonnet + haiku * w_haiku`). The operator-facing answer to "which skill / model / class burned the most subscription quota this week," independent of token mix. Lives inside the **Cost** Module family and is consumed by `/api/usage` + dashboard panels. Deliberately **not** a dollar figure — under the Claude Code subscription, the orchestrator pays no per-call charge, so USD attribution would be a fiction. Weight ratios are operator-calibrated (same shape as `HYDRA_USAGE_*_QUOTA_TOKENS`), not derived from any external price API.
_Avoid_: USD / dollars / spend (subscription model has no per-call cost), price (implies an external rate card), cost-per-token (overloaded — we already have token counts, this is the *weighted* form)

**Weekly Reset Anchor**:
The fixed wall-clock instant the operator's Claude Code Max-5x *weekly* limit resets — the boundary the **Pacing Curve** targets. Operator-seeded once (env, read from the interactive `/usage` view), projected forward in 7-day multiples, then auto-corrected whenever a real rate-limit reset timestamp is observed in a transcript. Distinct from the **Subscription Usage Tracker**'s rolling 7-day window, which never resets: the Anchor is a *calendar* boundary, the rolling window is a *trailing sum*. Reconciling the two — rolling `percentLast7d` vs a new `percentSinceReset` — is why this term exists.
_Avoid_: weekly window (that's the rolling 7-day trailing sum, not a reset boundary), week start (ambiguous — this is the reset instant, not a calendar Monday)

**Pacing Curve**:
The target cumulative-burn trajectory the system paces *total* quota consumption along — a linear ramp from 0 at the **Weekly Reset Anchor** to the **Pacing Ceiling** at the next Anchor. Position relative to the curve (behind / on / ahead) is the signal the **Pace Gate** acts on. Replaces the **Subscription Usage Tracker**'s older rate-projection `pacingState` (which asked "is my current *rate* sustainable for 7 days," not "am I above the *target line* right now").
_Avoid_: pacing state (the old rate-projection enum — the Curve is position-vs-target, a different model), burn rate (the Curve is cumulative, not a rate)

**Pacing Ceiling**:
The sub-100% fraction of the weekly quota the **Pacing Curve** climbs to by end of week (default ~0.92, `HYDRA_USAGE_WEEKLY_PACE_CEILING`); the deliberate gap below 100% absorbs pacing overshoot and the independent 5-hour cliff. Its complement is the **Operator Reserve**.
_Avoid_: budget (overloaded with the per-run token budget), 100% target (the Ceiling sits deliberately below 100%)

**Operator Reserve**:
The headroom between the **Pacing Ceiling** and the real weekly cap that autopilot will not consume for self-directed work — guaranteed quota for the operator's interactive sessions, and (by the strict-pause rule) for nothing else. Because the **Subscription Usage Tracker** measures *total* burn across all transcripts, the Reserve is what keeps the operator unlocked once autopilot has paced the shared pool up to the Ceiling.
_Avoid_: buffer (too generic), headroom (describes it but isn't the named carve-out)

**Pace Gate**:
The admission-control supervisor that decides *whether to launch* an **Autopilot Run** — a periodic timer-fired check (not a decision brain) that skips launch when an Autopilot Run is already live, when the 5-hour `emergencyStop` is tripped, or when total burn sits at/above the **Pacing Curve**; otherwise it launches a normal finite run. The mechanism for both "stop only when usage is exceeded" (the Gate is the system's only deliberate dormancy) and "resume when usage resets" (the Gate relaunches the moment burn falls below the Curve, the 5h window drains, or the Anchor passes). Consistent with [[ADR-0012]]: it governs *admission*, never *what work to do* — that stays with `decide.py`.
_Avoid_: scheduler (that's the observability **Heartbeat**), autopilot launcher (misses the gating role), control loop (the retired in-process brain — the Gate makes no work decisions)

## Relationships

- An **Orchestrator** builds one **Target** at a time; running a second target means a second orchestrator instance, not multi-tenant inside one
- A **Target** has one **Target Vision** (prose) and one **Target Outcomes** (config)
- The **Orchestrator** has its own **Orchestrator Vision**
- The **Pre-merge Gate** is the only path to merge; the **Verifier Core** is the gate's own source, guarded by the **Live-Gate Invariant** so a change to it is judged by the live gate, not itself
- A **Design Concept** is the prerequisite for any code-writing dispatch; PR-time review consumes it as ground truth
- **Pattern Memory**, **Reflections**, and **Knowledge Base** are three independent learning surfaces — patterns are structural rules, reflections are episodic narrative, the Knowledge Base is semantic search. All three are composed at agent-dispatch time by `src/learning.ts::getContext()` into the **Learning Context** — Pattern Memory as the `agent-memory` block, Reflections as three blocks, and a curated Knowledge Base lessons-slice as its own `knowledge-base` block (issue #804 lifts this out of the `agent-memory` block, where it had been folded in via a `trackedOvSearch` call, so the trace is honest about every source). This dispatch-time KB slice is distinct from — and additional to — the subagent's own ad-hoc OV HTTP queries during its work, which remain at the subagent's discretion. `src/learning.ts` owns none of the three surfaces — it composes them and exposes the composition's diagnostic trace at `/api/learning/context-trace`.
- **Pattern Memory**, **Reflections**, and every other Redis-resident state described above are read and written through the **Redis Adapters**. The raw `hydra:…` keys that appear in their definitions are documentation of today's storage shape, not a public surface — callers obtain values through typed accessors on `src/redis/*`.
- Every HTTP request body entering `src/api/*` passes through the **Schemas** Seam before its fields are read. **Schemas** and **Redis Adapters** are sibling Seams at opposite ends of the orchestrator — Schemas hardens the *external-input* boundary; Redis Adapters hardens the *storage* boundary. Each Module's lint rule is the mechanism that converts a hypothetical Seam (one adapter) into a real one (forced multiple adapters under CI enforcement).
- **Epic**, **Roadmap Milestone**, and **Focus Label** are three orthogonal axes of work grouping. One issue can simultaneously belong to one **Epic**, be referenced by one **Roadmap Milestone**, and carry one **Focus Label** — these are not nested, they are perpendicular. Epic is the unit-of-work axis (deliverable boundary); Milestone is the timeline axis (when do we want this shipped); Focus Label is the theme axis (what category of work is this).
- **Autopilot Focus** is the operator-set pointer that selects one of the three axes (or `auto` for no bias). `decide.py` reads it once per turn; the **Autopilot Run** carries no other notion of "current campaign of work." Closure of focus work is the closure of the underlying object — **Epic** auto-closure via `hydra-epic-close`, milestone tickoff via roadmap.md edit, label-set drain to zero matching issues. Autopilot Focus never closes itself; the operator clears it when the focus area drains.
- The **Pace Gate** launches **Autopilot Runs**; the **Observability Heartbeat** records what they did. Two perpendicular control-plane timers: the Gate is *admission control* (should a run start now?), the Heartbeat is *bookkeeping* (what happened?). Neither decides work — that is the Run's own `decide.py`.
- The **Pacing Curve** governs *total* burn (as measured by the **Subscription Usage Tracker** across all transcripts) against the **Weekly Reset Anchor**, climbing to the **Pacing Ceiling** and leaving the **Operator Reserve** untouched. The independent 5-hour `emergencyStop` can pause the **Pace Gate** regardless of weekly position.

## Example dialogue

> **Operator:** "This **Target** PR has been sitting in **Outcome Holdback** for two days."
> **Maintainer:** "Which Tier was it classified?"
> **Operator:** "Tier 2 — leading outcome regressed slightly on the second cycle post-merge."
> **Maintainer:** "OK. The **Post-merge Regression Check** should have already opened a rollback PR if it crossed the threshold. If it didn't, the holdback policy says we ride the watch window to completion — the regression has to be both leading AND a real move beyond `noise_epsilon` for the auto-revert to fire."
