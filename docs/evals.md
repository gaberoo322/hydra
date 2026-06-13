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

## TypeScript scorers (the evalite niche, on the no-dep lane) — issue #1803

When the assertion you want is a **numeric 0/1 scorer expressed as a
type-checked TypeScript function** (e.g. "does this PR body close the right
issue? score 0/1"), you do **not** need a second eval tool. promptfoo's
`type: javascript` assertion takes a `value: file://<path>.ts`, imports the
file through its own esbuild loader, and runs the default export as the scorer
— no `vitest`, no build step, **no new dependency**.

The seed scorer is **`evals/scorers/issue-ref.ts`**, wired into
`evals/hydra-dev.yaml` (`npm run eval:ts`). The scorer contract:

```ts
import type { AssertionValueFunctionContext, GradingResult } from "promptfoo";
export default function scorer(
  output: string,                         // the provider output under test
  context: AssertionValueFunctionContext, // context.vars = the test's `vars` block
): GradingResult {
  return { pass, score /* numeric 0..1 */, reason };
}
```

The two-arg `(output, context)` signature is load-bearing: promptfoo passes the
output value as the first positional arg to a default-exported function — it
does **not** pass an `AssertionParams` object, so destructuring `{ output }`
yields `undefined` (verified against promptfoo@0.121.15). Read the test `vars`
off `context.vars`, not off arg-one. Use `type: not-javascript` to invert a
scorer for a negative test (see the second case in `hydra-dev.yaml`).

The scorer file lives under `evals/`, which is **outside** both typecheck
scopes (`tsconfig.json` includes only `src/**`; `tsconfig.test.json` widens to
`test/**` + `scripts/**`), exactly like the YAML configs — so the `promptfoo`
type-only import never enters `npm run typecheck` / `typecheck:test`; promptfoo
resolves its own types at eval-run time.

### Why not evalite? (tool-scout #1803, declined)

tool-scout #1803 proposed [evalite](https://github.com/mattpocock/evalite) for
exactly this niche (agent-authored TypeScript scorers). It was **declined** —
the niche is real but evalite cannot run in Hydra's eval lane:

- evalite **hard-requires a resolvable `vitest`** package: `npx evalite run
  <file>.eval.ts` dies with `Cannot find package 'vitest'` (verified
  2026-06-13). It is not a standalone CLI like promptfoo's `echo` provider, so
  the pinned-`npx`, never-a-dependency lane (above) does not apply to it.
- Adopting it means adding `evalite` **and** `vitest` + their large transitive
  trees as devDependencies, which trips the **allow-scripts** CI gate (the
  committed lavamoat allowlist is empty, `allowScripts: {}`) and contradicts
  ADR-0005 + this doc's no-dependency rule, reaffirmed one day earlier when
  promptfoo (#1806) landed.
- promptfoo **already** delivers the capability (the `file://*.ts` scorer
  above) on the established lane, zero new packages. evalite would add a second
  eval runner, a vitest project, and a bus-factor-of-one dependency for a niche
  promptfoo already covers.

If a future need genuinely requires evalite's Vitest-watch DX, re-open #1803
with that concrete need; until then, write TypeScript scorers as promptfoo
`file://*.ts` assertions.

## Adding an eval

1. Add `evals/<skill-or-class>.yaml` (copy `golden.yaml`'s header). For a
   TypeScript scorer, add `evals/scorers/<name>.ts` and reference it with a
   `type: javascript` / `value: file://scorers/<name>.ts` assertion (see
   `evals/hydra-dev.yaml`).
2. Keep it offline (echo / file:// / static) unless the live-provider follow-up
   has landed.
3. `npm run eval` (golden) / `npm run eval:ts` (TS scorer) locally to confirm
   green. The advisory `eval-gate` workflow loops over **every** `evals/*.yaml`,
   so a new config is picked up with no workflow edit.
