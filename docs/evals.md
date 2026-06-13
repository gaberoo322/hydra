# Evals (promptfoo)

The orchestrator's eval harness tests **agent / prompt behavior** — the gap
between unit tests (`node:test`, which test *code* behavior) and production
observation. It is [promptfoo](https://promptfoo.dev), pre-endorsed by operator
direction (`config/direction/tech-preferences.md` → "Promptfoo for evals and
red teaming"; `config/meta.md` declares an `eval` proposal type). Filed by
tool-scout in issue #1802.

## How it runs

```bash
npm run eval          # runs evals/golden.yaml via pinned npx promptfoo
```

- Eval configs live under **`evals/`** at the repo root — **one YAML per skill
  or agent class** being eval'd. `evals/golden.yaml` is the seed.
- promptfoo runs a `TestSuite` (prompts × providers × assertions) and returns a
  stable, versioned JSON result. Agents match on `result.success`,
  `result.score`, `result.stats.failures` — no LLM mediation needed.

## The tool-lane: pinned `npx`, never a dependency

promptfoo is invoked via `npx --yes -p promptfoo@0.121.15` — it is **never**
added to `package.json` dependencies or devDependencies. This is the same lane
ast-grep and comby use (CLAUDE.md § Structural code search):

- promptfoo pulls 40+ transitive deps with install lifecycle scripts; the
  committed lavamoat allowlist is empty (`allowScripts: {}`), so a devDependency
  would trip the **allow-scripts** CI gate.
- Pinned `npx` keeps it off the ADR-0005 runtime-dep allowlist (`express`,
  `ioredis`, `ws`, `@sentry/node`, `zod`) too.
- The pinned version in the `eval` npm script and in
  `.github/workflows/eval-gate.yml` **must match** so local and CI runs use the
  same binary. Bump both together.

## The CI gate is advisory

`.github/workflows/eval-gate.yml` runs the eval on every PR/push and **exits 0
regardless of pass/fail**, surfacing the outcome as a GitHub-Actions annotation.
It is a Tier-3 sibling of `ast-grep-lint.yml` / `comby-check.yml`:

- It is a **new workflow file**, never an edit to `ci.yml` (Verifier Core, T4,
  exact-match untouchable per ADR-0015 / `src/untouchable.ts`). A new
  verification is a new workflow, not a change to the merge gate.
- It is **not** a required branch-protection check, so a non-deterministic eval
  can never wedge the merge queue (only `ci.yml` contexts are required).
- **Promotion to a hard gate** is a deliberate, reviewable later change: drop
  the advisory `exit 0` for the eval you want to enforce.

## The first eval is offline — no live provider calls

`evals/golden.yaml` uses promptfoo's built-in **`echo` provider**, which returns
the rendered prompt verbatim and makes **zero** network/LLM calls. It needs no
API key and is fully deterministic. The assertions verify that the prompt
template preserves the load-bearing safety invariants a dispatch must carry
(worktree isolation, never-push-to-master, `typecheck:test` before PR, the
ADR-0005 escalation list). This proves the harness runs green end-to-end in CI
with the only secret CI has today — `GITHUB_TOKEN`.

There is **no `ANTHROPIC_API_KEY`** (or any provider secret) in any CI workflow.
The tool-scout issue's claim that provider auth is "already in the runner
environment" is false at the workflow level.

## Live-provider follow-up (operator-gated)

A golden-task replay scored against real Anthropic calls — the issue's "first
useful eval" — is a **follow-up**, gated on two operator actions:

1. **Provision a scoped provider secret** into the eval workflow only — an
   ADR-0005 escalation (credentials/secrets are operator-only). Do not assume
   runner auth.
2. **Cost-cap it.** Each live `promptfoo eval` calls the configured providers;
   the live eval must be bounded by a `HYDRA_`-prefixed env cap and a
   `--sample` / max-concurrency flag (modelled on `HYDRA_RECS_DAILY_CAP_USD`,
   `src/recommendation-engine.ts`) — never an uncapped fan-out.

Until both land, keep new evals on offline / recorded / `file://` providers or
static assertions against fixtures.

## Adding an eval

1. Add `evals/<skill-or-class>.yaml` (copy `golden.yaml`'s header).
2. Keep it offline (echo / file:// / static) unless the live-provider follow-up
   has landed.
3. `npm run eval` locally to confirm it's green; the advisory workflow runs the
   seed config (`evals/golden.yaml`) — extend the workflow loop to cover more
   files when you add them.
