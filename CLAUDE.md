# Hydra Orchestrator

Autonomous software-building framework. The **Orchestrator** is a control plane for **Claude Code subagents** (`hydra-dev` for orchestrator work, `hydra-target-build` for target work) dispatched in parallel by **`hydra-autopilot`**. State lives in Redis; configs are git-tracked under `~/hydra/config/`; agents query OpenViking for semantic knowledge. Hard verification (`npm test`, `tsc`, build) is deterministic — never an agent claim.

> Terms in **bold** are defined in [`CONTEXT.md`](./CONTEXT.md). Use them exactly.

## Documentation Map

Start here; load the rest on demand.

- [`CONTEXT-MAP.md`](./CONTEXT-MAP.md) — **where domain language lives**: the cross-cutting glossary ([`CONTEXT.md`](./CONTEXT.md)) plus co-located `src/<domain>/CONTEXT.md` files, mapped by code area. Read before naming a concept or touching a subsystem.
- [`README.md`](./README.md) — system overview, dashboard/API surface, design principles
- [`docs/adr/`](./docs/adr/) — architectural decision records (the "why"); read the ones touching your area
- [`docs/operator-playbooks/hydra-autopilot.md`](./docs/operator-playbooks/hydra-autopilot.md) — autopilot class taxonomy + dispatch contract
- [`docs/agents/domain.md`](./docs/agents/domain.md) — the READ + WRITE doc contract subagents follow
- [`docs/reference.md`](./docs/reference.md) — on-demand reference: Redis keys, event streams, API endpoints, model tiers, learning-system internals, config, deploy recipe
- `config/direction/` — **target** vision, outcomes, priorities, goals · [`config/orchestrator/vision.md`](./config/orchestrator/vision.md) — **orchestrator-self** vision

## Architecture (one paragraph)

`hydra-autopilot` is a long-running decision loop: a single Claude Code session dispatches background subagents in parallel — one per **class** — under per-class cooldowns and a token budget (full taxonomy in the autopilot playbook). Each code-writing class runs in a fresh `git worktree` and opens a PR; **CI is the merge gate**, never an in-cycle check. The orchestrator HTTP service (port 4000) is the **data plane**: Redis state, event bus (`hydra:*` streams), the observability heartbeat (`src/scheduler/heartbeat.ts`), the knowledge plane (OpenViking), the dashboard + REST API, and the tier classifier (`src/tier-classifier.ts`). The **Pre-merge Gate** itself is CI jobs + branch protection, not an in-process module — `src/gate.ts` was removed with the codex control loop. It no longer runs a self-driving control loop (see [ADR-0006](./docs/adr/0006-codex-cli-removed-autopilot-only.md), [ADR-0012](./docs/adr/0012-autopilot-is-the-single-brain.md)).

## Running

```bash
# Service (production)
systemctl --user restart hydra-orchestrator.service
journalctl --user -u hydra-orchestrator.service -f

# Development (check port 4000 first — see Pitfalls)
npx tsx src/index.ts
npm test                    # regression suite (node:test, zero deps)

# Health
curl http://localhost:4000/api/health
curl http://localhost:4000/api/scheduler/status
```

## Coding Conventions

- **TypeScript** (`.ts`, import/export). Source in `src/`, tests in `test/*.test.mts`.
- **Runtime deps are operator-approved only** (ADR-0005): `express`, `ioredis`, `ws`, `@sentry/node`, `zod`. Node stdlib for everything else.
- **Never throw from merge/grounding/verification** — return result objects so callers decide how to report failures.
- **Fail loud**: every `catch` either logs `console.error` with context or is annotated `/* intentional: reason */`. Silent catches caused every major 2026-04 incident.
- **Typed errors carry a machine-readable `code`** (#756) — for exceptional `throw` sites prefer a subclass from `src/errors.ts` (e.g. `InvalidArgumentError`, `RedisSeamError`) over a bare `Error`; callers/tests discriminate on `err.code`, not `err.message`. Migration is opportunistic.
- **Backlog lane mutations go through `moveItemToLane`** (`src/backlog/lanes.ts`) — API handlers must not reach into `src/backlog` internals directly. Lane transitions return result objects (e.g. `{ok:false, error}`), never throw.
- **Redis access through `src/redis/<domain>.ts` typed accessors** — never `new Redis()` directly; never import `redis/keys` or `redis/kv` from outside `src/redis/`. See **Redis Adapters** in `CONTEXT.md`; enforced by `scripts/ci/redis-seam-check.ts`.
- **HTTP request bodies validate through `src/schemas/<domain>.ts`** (zod `safeParse`; on failure return 400 `{code:"schema-validation-failed", issues}`). The schema is the source of truth for both the parser and the inferred type. See **Schemas** in `CONTEXT.md`.
- **API routes in sub-routers** — `src/api.ts` is a thin mount point; handlers live in `src/api/<domain>.ts` (factory functions receiving `eventBus` if needed). `eventBus` is a parameter, never a module global.
- **`grounding.ts` is read-only** — never mutate the workspace from inside grounding.
- **Structural code search** — for call-site / AST questions ("find every caller of `moveItemToLane`", "every `new Redis(...)`") prefer `npm run ast-search -- --pattern '<ast-grep pattern>'` (`scripts/ast-search.ts`, tool-scout #1797) over text `grep`: it matches *syntax*, so it never false-matches a comment or string literal. Reusable AST-exact lint rules live as YAML under `src/ast-grep-rules/` and run in the advisory `ast-grep-lint` workflow (a Tier-3 sibling, NOT in `ci.yml`); add a sibling file to add a rule. ast-grep is invoked via `npx`, deliberately not a package.json dependency (keeps it off the ADR-0005 runtime-dep allowlist and the lavamoat allow-scripts gate). **Lane boundary:** ast-grep owns TypeScript (it has a TS tree-sitter grammar wired here); for the non-TS long tail — YAML / shell / Markdown under `.github/`, `config/`, `scripts/` — reach for **comby** (`comby.dev`) instead, whose `:[hole]` template matches a balanced expression in any language. Comby rules live as `.toml` under `scripts/comby-rules/` and run in the advisory `comby-check` workflow (another Tier-3 sibling, NOT in `ci.yml`); comby is a pinned pre-built binary downloaded in CI (no npm distribution), same ADR-0005 / allow-scripts rationale as ast-grep. **Third lane — fuzzy block search:** when you *don't yet know* the exact identifier or AST shape ("where is the embedding backend configured?", "find the retry logic"), use `npm run probe-search -- --query '<words>'` (`scripts/probe-search.ts`, tool-scout #1799) — probe (probelabs) combines ripgrep speed with tree-sitter parsing and BM25 ranking to return whole, relevance-ranked code *blocks* across any language with zero indexing. Use ast-search for EXACT syntax, probe-search for FUZZY relevance, OpenViking for SEMANTIC similarity over accumulated knowledge. Same pinned-`npx`, no-dependency lane as ast-grep/comby/promptfoo. The higher-leverage probe MCP-server path is an operator decision (out of scope of #1799).
- **Evals (agent/prompt behavior)** — to A/B-test a skill or agent-class prompt against a golden-task set, use **promptfoo** (`npm run eval`, configs under `evals/`); the advisory `eval-gate` workflow runs it on PRs (Tier-3 sibling, NOT in `ci.yml`; same pinned-`npx`, no-dependency lane as ast-grep/comby). The first eval is offline (no API key); live-provider CI is an operator-gated follow-up. For a numeric **TypeScript** scorer (e.g. "does this PR close the right issue? 0/1"), write a `file://scorers/<name>.ts` assertion (seed: `evals/scorers/issue-ref.ts` via `npm run eval:ts`) — promptfoo runs it through its own esbuild loader, so it stays on the no-dependency lane (evalite was scouted in #1803 and declined: it hard-requires a vitest devDep that trips the allow-scripts gate — promptfoo already covers the niche). Full contract: [`docs/evals.md`](./docs/evals.md).

## CI/CD & Deployment

- **All changes to master go through a PR.** Branch protection enforces CI. **Agents: always work on a feature branch; never push directly to master.**
- **Always run `npm test` before committing.**
- **CI** (`.github/workflows/ci.yml`): typecheck + test, dashboard build, tier-gate, mutation kill-rate + scope-enforcement (see [`docs/quality-gates.md`](./docs/quality-gates.md)).
- **Deploy** runs automatically on merge to master (self-hosted runner). **Never deploy by restarting the service without building the dashboard first** — Express serves `dashboard/dist/`, so stale builds mean stale UI. Full deploy steps + emergency manual deploy: [`docs/reference.md`](./docs/reference.md).

## Self-Modification: Verifier Core & Tiers

Every PR is classified by blast radius on the monotonic ladder T1 (shallowest) → T4 (deepest), regardless of who proposed it ([ADR-0004](./docs/adr/0004-self-modification-tiers.md) + ADR-0015) — required verification depth ascends with the tier. The **Verifier Core** path list lives in `src/untouchable.ts` (`VERIFIER_CORE_PATHS` / `isVerifierCore`; [ADR-0001](./docs/adr/0001-untouchable-core-and-gate-extraction.md) + ADR-0015 — "Untouchable Core" is the retired name). **Never bypass the gate.** Operator escalation is the closed list in [ADR-0005](./docs/adr/0005-operator-escalation-is-narrow.md) (credentials/secrets, external-account actions, T4 / Verifier-Core changes, vision conflicts) — everything else Hydra researches and tries autonomously. Full tier table + path lists: [`docs/reference.md`](./docs/reference.md).

Tier names verification *depth*, not merge authority (ADR-0015, #742). Every PR auto-merges once it passes the verification depth required for its tier; the only route to the operator is an exhausted Deep-QA Remediation Loop on T4 (a 2nd failed deep-QA pass, #740).

| Tier | Scope | Required verification depth |
|------|-------|-----------|
| T1 — Prompt-shaped | Lesson files, prompt-only tweaks (`config/agents/`, `config/feedback/`) | QA PASS → auto-merge |
| T2 — Skill / verification | Skills under `~/.claude/skills/`, dashboard, `src/anchor-selection/` | QA PASS + **Outcome Holdback** → auto-merge |
| T3 — Core `src/` + demoted infra | Everything else in `src/`, plus `src/grounding.ts`, `src/cost/`, watchdog scripts, `scripts/deploy.sh` | QA PASS → auto-merge |
| T4 — Verifier Core | `ci.yml`, `deploy.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts` | Deep-QA pass (#740); operator only via exhausted remediation loop |

## Common Pitfalls

- **Port 4000 conflict**: running `npx tsx src/index.ts` while the service is up trips the port guard. Check `lsof -ti:4000` first; `systemctl --user restart hydra-orchestrator.service` is the safe restart after a crash leaves the port held.
- **Worktree isolation**: every code-writing dispatch (`hydra-dev`, `hydra-target-build`) MUST run in a fresh `git worktree` — the harness aborts if cwd is the main working tree (`/home/gabe/hydra` or `/home/gabe/hydra-betting`). Abort rather than falling back to the main repo.
- **Kanban title matching**: use `anchor.reference`, not `task.title`, when calling `backlog.ts` functions — subagent-generated titles don't always match Kanban rows.
- **zsh `$status` is read-only**: never name a shell loop/poll variable `status` — zsh aliases `$status` to `$?`, so the assignment fails and the script exits 1 (bites Monitor/CI-poll loops). Use `st` / `run_state` instead.
- **A `$VAR` inside a single-quoted heredoc (`<<'EOF'`) stays literal — by design**: the skill templates (`hydra-dev`, `hydra-discover`, `hydra-research`, …) write PR bodies with a *single-quoted* delimiter (`gh pr create --body-file /dev/stdin <<'EOF' … EOF`) **on purpose** — quoting the delimiter suppresses ALL `$var` / `$(...)` expansion in the body as a shell-injection-safety measure. So `$CYCLE_ID` (or any branch-name var) inside that body lands as the literal text `$CYCLE_ID`, not its value (bit a retro/PR-create cycle). This is NOT a subshell-scoping issue — the var is perfectly in scope; the quoted delimiter is deliberately refusing to expand it. **Fix:** pass the value into the body literally — inline the already-resolved string, or build the body with `printf` / `jq --arg name "$CYCLE_ID" …` and feed *that* into the heredoc. **Do NOT "fix" this by switching to an unquoted `<<EOF`** — that re-enables `$var`/`$(...)` expansion and reintroduces the exact shell-injection vulnerability the single-quoting exists to prevent.
- **Single-file test run in a worktree uses `--experimental-strip-types`, not `--import tsx`**: to run one test file (rather than the whole `npm test` glob), match the `npm test` runner — `node --experimental-strip-types --test --test-force-exit test/<name>.test.mts`. `node --import tsx --test …` fails `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` inside `.claude/worktrees/*` and `/dev/shm` worktrees, because `tsx` is a global install absent from the worktree's `node_modules`. (`npx tsx -e` still works — it resolves the global bin; only the `--import tsx` loader hook trips. **Caveat:** `npx tsx -e` transpiles to CJS, so a *top-level* `await` fails `ERR: Top-level await is currently not supported with the "cjs" output format` — wrap async work in an IIFE or a `.then()` chain, e.g. `(async () => { … process.exit(0); })().catch(e => { console.error(e); process.exit(1); });`. The retro/recurrence Redis shims in this repo already use that pattern.)
- **`npm test` buffers the reporter — a `not ok` failure shows the count, not the failing test name**: the default runner streams a TAP summary, so a red run tells you *how many* failed without naming *which*. Don't grep the buffered stdout — re-run `npm run test:debug`, which adds a `--test-reporter=tap --test-reporter-destination=test-debug.tap` sink (alongside `--test-concurrency=1`); then read the `not ok` lines (and their `# Subtest:` names) out of `test-debug.tap`. That is the fast path from "something failed" to the exact `test/<name>.test.mts` + subtest to fix.
- **Don't add new tests by nesting them inside an existing `describe` that owns a shared-Redis `after()` teardown**: a `describe`-block's `after()` hook (e.g. `test/backlog.test.mts` line ~65, which `redis.disconnect()`s the shared connection) fires when *that* suite finishes — but `node:test` runs sibling top-level suites afterward, so any **other** top-level suite that reuses the same Redis seam then runs against a torn-down connection and flakes. When you add tests that touch a shared Redis adapter, add them as a **new top-level `describe` with its own `before`/`after` lifecycle** (or reuse the suite that already owns that teardown) — never as a nested child that piggybacks on a sibling's teardown timing. (Retro-recurring; distinct from the documented "trust CI on worktree-shared-Redis flakes" coping note — this is the authoring rule that prevents the flake.)

## Agent skills

- **Issue tracker** — GitHub Issues on `gaberoo322/hydra` via the `gh` CLI. See [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).
- **Triage labels** — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, `target-backlog`. See [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).
- **Domain docs** — multi-context via [`CONTEXT-MAP.md`](./CONTEXT-MAP.md). See [`docs/agents/domain.md`](./docs/agents/domain.md).

## History

Retired subsystems (Codex CLI, the in-process control loop, Specs, the in-process Gate) and how the system reached today's shape: [`docs/historical/`](./docs/historical/) and the ADRs they reference.
