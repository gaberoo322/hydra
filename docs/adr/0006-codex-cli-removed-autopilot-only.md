# Codex CLI fully removed; autopilot is the only execution path

## Status

Accepted, 2026-05-14. Supersedes the measurement-gated rollout in [`docs/codex-removal-measurement.md`](../codex-removal-measurement.md) (kept as historical record of the original plan).

## Context

Hydra began as a Codex-CLI-driven control loop: each cycle spawned `planner`, `executor`, optional `fixer`, optional `skeptic` / `high-risk-review`, and `meta` agent calls through `@openai/codex-sdk`. State was Redis, verification was deterministic, but the *work-writing* happened inside a single tight loop owned by `src/control-loop.ts`.

Over 2026-Q2 we developed `hydra-autopilot` as a parallel-class dispatcher that fans out Claude Code subagents (`hydra-dev`, `hydra-target-build`, `hydra-research`, `hydra-sweep`, `hydra-doctor`, etc.) across the same Redis-backed work surface. The autopilot subagents wrote code in isolated worktrees and opened PRs; the codex control loop continued ticking in parallel and also wrote code via direct merges to master.

By PR-2 of the codex-removal epic ([#380](https://github.com/gaberoo322/hydra/issues/380)), the two paths had measurably duplicated work, contested the merge lock, and forced operator memory `feedback_bg_agent_worktree_hygiene` into existence after the codex path silently used the main tree on 2026-05-11. The cost and throughput comparison from the autopilot's 5-day soak (issue #382) showed autopilot delivering higher merge rates per dollar with the deterministic CI quality gates re-homed from the cycle (issue #382 → PR #393), so the codex path no longer carried any unique capability.

## Decision

Delete the Codex CLI runtime and the in-process planner/executor/skeptic/fixer/meta agents. All code-writing work flows through `hydra-autopilot`-dispatched Claude Code subagents. The orchestrator HTTP service is retained as the **data plane** (dashboard, REST API, Redis state, event bus, knowledge indexer, scheduler, merge-gate facade, tier classifier).

Specifically:

- `@openai/codex-sdk` removed from `package.json` (PR-3, [#383](https://github.com/gaberoo322/hydra/issues/383) / PR [#400](https://github.com/gaberoo322/hydra/pull/400)).
- `src/codex-runner.ts`, `src/preflight.ts` (the codex-side preflight), `src/skeptic.ts`, `src/fixer.ts`, `src/meta.ts`, and the planner/executor/skeptic in-process call sites deleted.
- `config/agents/{planner,executor,skeptic,meta}.md` and `config/feedback/to-{planner,executor,skeptic}.md` moved to `docs/historical/agent-personalities/` for posterity.
- The Codex-cycle scheduler trigger (`hydra cycle start`, formerly autopilot priority P5) is gone; the autopilot is the sole dispatcher.
- Per-agent model routing (`frontier` / `codex` / `mini` tiers, gpt-5.x family) is replaced by Claude Code's harness-level model selection (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`).
- `src/codex-otel.ts` is intentionally **retained** as legacy telemetry attribution. SigNoz/Tempo spans emitted before the cut-over are still queried by operators via the trace-UI link in `/cycles`. No new spans are produced. A follow-up will retire it once the historical-trace retention window expires.
- The Phase A → B → C measurement plan in `docs/codex-removal-measurement.md` is marked outcome-complete (see that document's "Outcome (2026-05-13/14)" section). Phase B and Phase C were combined and the 5-day / 14-day soak gates were waived in favor of de-facto evidence: the autopilot path had already been the primary code-writing source for two weeks before PR-3 shipped, and the codex path had been delivering near-zero unique merges.

## Consequences

**Positive:**

- **One execution path.** No more dual-write race on `hydra:merge:lock`, no more "which agent owned this PR?" forensic work in incident reviews.
- **Worktree isolation is uniform.** Every code-writing dispatch runs under `Agent(isolation: "worktree")` with the abort-on-main-tree guard. The codex path's silent `cwd` reliance is gone.
- **Lower runtime surface.** Four runtime deps (`express`, `ioredis`, `ws`, `@sentry/node`), no `~/.codex/` configuration, no per-call OTel env injection, no codex session-rollout JSONL replay.
- **Quality gates are CI, not cycle.** Mutation kill-rate and scope-enforcement run on every PR (issue #382 → PR #393), so hydra-dev / hydra-target-build / manual / external PRs all get the same merge safety net.

**Negative / accepted trade-offs:**

- **Tier-classifier and capacity-floor logic still reference paths like `config/agents/`, `config/feedback/`** for backwards compatibility — those prefixes are now empty in the repo, so the classifier's Tier-1 prefix list is effectively dead branches for those entries. Cleaning that up is a follow-up; it would have widened PR-4's scope unnecessarily.
- **`src/context-builder.ts` and the per-agent `getAgentContext` / Redis pattern promotion paths** were originally written to build prompts for codex agents and to promote rules into `config/feedback/to-{agent}.md`. They are not deleted in PR-4 (docs-only). They still pass tests via temp-path mocks and don't crash at runtime because their read targets are missing-file-tolerant. Treating them as dead code and pruning is a separate orchestrator-self-improvement issue.
- **`docs/operator-playbooks/hydra-dev.md` and `docs/operator-playbooks/hydra-autopilot.md`** still describe codex coexistence in places (e.g. the `dev_target` row's "Claude-side replacement for Codex cycles" note, the `CODEX_IDLE` gate). PR-4 leaves those untouched and will be cleaned up in a follow-up that owns the playbook generators (`scripts/sync-skills.sh`).
- **`scripts/otel/*` example artifacts** still document codex's `~/.codex/config.toml` exporter wiring. Those examples remain valid for anyone querying historical traces; they will be removed once `src/codex-otel.ts` is retired.

## Considered options

- **Keep the codex path under a kill-switch (`HYDRA_CODEX_CYCLE_ENABLED`).** Implemented as a stop-gap in PR-1 (issue #381 → PR #390). Used to validate the autopilot-only path in production for ~9 days before PR-3. Now redundant; the env var is honored by deleted code paths only and can be removed in a follow-up.
- **Migrate codex agents to direct Anthropic SDK calls instead of Claude Code subagents.** Rejected: it would have rebuilt the same single-cycle, single-process bottleneck the autopilot was designed to replace. The class-taxonomy + per-class cooldown model in autopilot is the architectural win.
- **Keep `src/codex-otel.ts` deleted.** Rejected during the QA review of PR-3 ([#400](https://github.com/gaberoo322/hydra/pull/400)): operators still rely on the trace-UI link on the `/cycles` page to debug historical incidents recorded under codex-era cycle IDs. Retain until the trace retention window (SigNoz default: 30 days, Tempo: operator-configured) expires.

## References

- Epic: [#380](https://github.com/gaberoo322/hydra/issues/380) Codex CLI removal
- PR-1: [#390](https://github.com/gaberoo322/hydra/pull/390) (`HYDRA_CODEX_CYCLE_ENABLED` kill-switch)
- PR-2: [#393](https://github.com/gaberoo322/hydra/pull/393) (mutation + scope gates re-homed to CI)
- PR-3: [#400](https://github.com/gaberoo322/hydra/pull/400) (codex-runner + in-process agents deleted)
- PR-4: this docs sweep, closes [#384](https://github.com/gaberoo322/hydra/issues/384)
- Original measurement plan: [`docs/codex-removal-measurement.md`](../codex-removal-measurement.md)
- Class taxonomy: [`docs/operator-playbooks/hydra-autopilot.md`](../operator-playbooks/hydra-autopilot.md)
- Worktree-isolation memory: `feedback_bg_agent_worktree_hygiene` (PR #245 incident)
