# Historical

Subsystems and machinery that no longer exist in the codebase. Kept so the "why did this change" trail survives, and so agents don't try to re-introduce or call into things that were deliberately removed. Live behavior is documented in `CLAUDE.md`, `CONTEXT.md`, `docs/reference.md`, and the ADRs — **not here**.

## Retired subsystems

| What | When / record | Replaced by |
|---|---|---|
| **Codex CLI** + in-process planner/executor/skeptic/fixer/meta agents + `@openai/codex-sdk` | 2026-05-14 — [ADR-0006](../adr/0006-codex-cli-removed-autopilot-only.md), [`../codex-removal-measurement.md`](../codex-removal-measurement.md) | All code-writing flows through Claude Code subagents under `hydra-autopilot` |
| **In-process control loop** (self-driving cycle loop, `src/prepare-workspace.ts`) | issue #609 | Autopilot's child-dispatch model; the HTTP service is now the data plane only ([ADR-0012](../adr/0012-autopilot-is-the-single-brain.md)) |
| **Specs subsystem** (auto-decompose, `/api/specs`, active-spec anchor tier, spec capacity-floor, `spec-starvation`) | issue #513 | Autopilot child-dispatch superseded multi-cycle task decomposition. Residual `hydra:specs:*` keys: `bash scripts/cleanup/retire-specs.sh` |
| **In-process Gate module** (`src/gate.ts`, `src/holdback.ts`) | ADR-0006 cut-over | Disassembled into CI jobs + **Merge Lock** + **Post-merge Regression Check** (see `CONTEXT.md`) |
| **Legacy agent personalities** (`config/agents/{planner,executor,skeptic,meta}.md`) + feedback files (`config/feedback/to-*.md`) | 2026-05-14 | Subagent personalities now live under `~/.claude/skills/`. Archived under [`agent-personalities/`](./agent-personalities/) |
| **Stuckness detector** | [ADR-0010](../adr/0010-stuckness-detector-retired.md) | Self-improvement floor is operator-curated |
| **Dollar/cost machinery** (daily-spend cap, per-cycle circuit breaker, JSONL reconciliation) | B-series, #602, #720 | Subscription model has no per-call cost; see **Cost** / **Quota Weight** in `CONTEXT.md` |

`docs/reference.md` also retains several `— historical` sections (Codex OpenTelemetry #199, the pre-#383 merge gate, cost reconciliation #296) for deeper archaeology.
