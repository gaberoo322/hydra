# AI-Leverage Categories

> **Status:** Starter taxonomy. The operator ratifies entries by merging changes to this file. The `hydra-tool-scout` skill walks **only** the closed list below — see `docs/operator-playbooks/hydra-tool-scout.md` for how this file feeds the scout.

Every category answers one question: **"if Hydra had better tooling in this slot, would the AI agents working in this repo become measurably faster, safer, or more capable?"** Categories where the answer is "marginally" don't earn a slot; categories where the answer is "yes — agents are currently working around the absence" earn priority during a scout walk.

Each entry below is structured:

- **Slug** — stable kebab-case identifier the scout uses as the `category` argument and as part of the seen-list key.
- **What it buys the AI** — the leverage thesis in one paragraph.
- **Maps to** — concrete examples of tools that belong here.
- **Does NOT map to** — examples that look similar but don't earn the category, with reasoning. These calibrate the rubric.
- **Canonical topic tags** — the GitHub topics / npm keywords the scout queries during discovery.

The starter set is 10 categories. The operator may add, retire, or split categories by editing this file — adding a category is a PR, not a runtime action.

---

## 1. typed-schemas

**What it buys the AI:** Schemas (Zod, TypeBox, Effect Schema, Valibot, JSON Schema) collapse a class of "the runtime received the wrong shape" bugs into compile-time or boundary-time errors that agents see in CI. When the schema is the single source of truth — for HTTP payloads, Redis records, config files — agents stop having to reverse-engineer expected shapes from runtime stack traces. Highest-leverage when the schema can be reflected into TS types AND validated at runtime from the same definition.

**Maps to:**
- Zod, Valibot, TypeBox, Effect Schema, ArkType — runtime validators with TS reflection.
- JSON Schema toolchains (ajv) when used as the source of truth, not a derived artifact.
- tRPC, ts-rest — typed RPC where the contract IS the schema.

**Does NOT map to:**
- io-ts: same shape but momentum has moved to Zod/Valibot in the ecosystem; the scout should not propose a swap unless there's a concrete pain.
- ORM-only type generation (Prisma, Drizzle): these are *database* schemas — see `code-search-infra` and `dependency-hygiene` instead. They earn typed-schemas only when used as the API boundary.
- Hand-written `interface` declarations: not a tool — that's just TypeScript.

**Canonical topic tags:** `validation`, `zod`, `typebox`, `schema-validation`, `typescript-validation`.

---

## 2. structured-errors

**What it buys the AI:** When errors carry a machine-readable code, a stable shape, and a context bag, agents can match on `error.code` instead of regexing `error.message`. This is the difference between "the test failed for a known reason" and "the test failed for *some* reason and the agent has to LLM its way through stderr." High leverage in long-running services (the orchestrator itself).

**Maps to:**
- `neverthrow`, `oxide.ts`, `effect/Either` — Result-type libraries that make error paths first-class.
- `verror`, `ts-custom-error` — extension classes with stable codes + causal chains.
- OpenTelemetry exception attributes when treated as the canonical surface.

**Does NOT map to:**
- Sentry SDKs alone — those are reporting, not a typed error contract. The scout should split: the SDK belongs in `observability-ai-readable-spans`, the *coding pattern* belongs here.
- Generic `throw new Error("...")` patterns — not a tool.

**Canonical topic tags:** `error-handling`, `result-type`, `typed-errors`, `either`, `option-type`.

---

## 3. deterministic-builds

**What it buys the AI:** Heisenbugs caused by non-deterministic builds (timestamp-sensitive bundling, unpinned transitive deps, system-Python-vs-Nix divergence) are the worst possible outcome for an AI agent — the agent will write a "fix" for a green-on-its-machine, red-in-CI symptom, and CI will keep being red. Deterministic builds make CI failures *real signal*. Highest-leverage when paired with a typed-error system (§2) so a failed build's reason is machine-readable.

**Maps to:**
- Nix (flakes), Bazel, Turborepo with content hashing, pnpm with strict peer deps.
- npm overrides + lockfile linting (e.g. `npm audit --omit=dev` enforcement in CI).
- esbuild with `--metafile` for reproducible bundle attribution.

**Does NOT map to:**
- Docker base images alone — necessary but not sufficient; APT mirrors drift.
- `node --experimental-strip-types` — that's a runtime, not a build-determinism story.

**Canonical topic tags:** `reproducible-builds`, `nix`, `bazel`, `monorepo`, `lockfile`.

---

## 4. code-search-infra

**What it buys the AI:** Agents spend disproportionate time hunting for "the function that does X" or "the file that owns Y." `grep` works but doesn't understand the AST; `ripgrep` is faster but still text. Tools like `ast-grep`, `comby`, `srgn`, treesitter-based queries, and embedding-based code search (OpenViking itself) give agents structured access to code — they can ask "find all callers of `safeKanban`" or "find every async function that doesn't await its `redis.set` call" and get a clean answer.

**Maps to:**
- `ast-grep`, `comby`, `srgn`, `tree-sitter` CLIs.
- `git grep -P` advanced patterns wrapped as repeatable queries.
- Local code-embedding search (OpenViking peers: Aider's repo-map, sourcegraph-CLI, cody-CLI).

**Does NOT map to:**
- ChatGPT-style "explain this code" UIs — that's an agent, not infra.
- LSP itself — that's `lsp-language-tooling` below.

**Canonical topic tags:** `ast-grep`, `tree-sitter`, `code-search`, `structural-search`, `codemod`.

---

## 5. eval-harnesses

**What it buys the AI:** Once Hydra produces code with measurable quality (mutation kill-rate, scope enforcement, fix:feat ratio), an eval harness lets us **regress those metrics** when an agent change degrades them. The orchestrator already has primitive eval (`hydra-doctor`, the merge gate, the cycle-history endpoint), but tooling like Inspect (Anthropic's), promptfoo, lm-eval-harness, or DeepEval would let us A/B agent prompts/skills on a held-out task set instead of measuring on production.

**Maps to:**
- `inspect_ai`, `promptfoo`, `deepeval`, `lm-eval-harness`.
- `langsmith` evals, `helicone` eval runs.
- Internally-built golden-task replays.

**Does NOT map to:**
- Generic test runners (Vitest, Jest) — those are unit-test infra, not eval. The distinction is: evals score *agent behavior* against a rubric; tests score *code behavior* against a spec.

**Canonical topic tags:** `llm-evaluation`, `eval-harness`, `prompt-testing`, `inspect-ai`.

---

## 6. observability-ai-readable-spans

**What it buys the AI:** Traces and metrics where the span/metric *names and attributes* are stable enough for an agent to query programmatically. The agent should be able to ask "what was the p95 of `merge-gate.tier-classifier` over the last 24h" and get an answer without scraping a Grafana dashboard. Logs that aren't structured are noise; logs that ARE structured AND have a query layer are leverage.

**Maps to:**
- OpenTelemetry SDK + semantic conventions, when the conventions are enforced in CI.
- Honeycomb, SigNoz, Tempo + Loki when used with structured attributes.
- `pino` / `winston` with strict JSON schemas (overlaps with `typed-schemas`).

**Does NOT map to:**
- `console.log` and "we'll grep stderr later" — anti-pattern.
- Datadog APM without a programmatic query layer that an agent can hit.

**Canonical topic tags:** `opentelemetry`, `structured-logging`, `observability`, `tracing`.

---

## 7. type-and-contract-driven-testing

**What it buys the AI:** Property tests (fast-check, hedgehog), schema-derived test cases (Zod + zod-fast-check), contract tests (pact, schemathesis) generate cases the agent couldn't think of. They tighten the verification step in the merge gate without the agent having to author every edge case by hand. Especially valuable when paired with `typed-schemas` (§1) — the same schema feeds the validator AND the generator.

**Maps to:**
- `fast-check`, `@fast-check/vitest`, `hedgehog`.
- `schemathesis`, `pact`, `dredd` for HTTP contract tests.
- Mutation testers (`stryker`, `pitest`) — kill-rate is already in our merge gate; better tooling here lands here.

**Does NOT map to:**
- Unit-test runners (Vitest, node:test) — necessary infra, not leverage.
- Snapshot tests — these often hide bugs from agents (the snapshot becomes the spec); deliberately excluded.

**Canonical topic tags:** `property-based-testing`, `fast-check`, `contract-testing`, `mutation-testing`.

---

## 8. ai-friendly-framework-conventions

**What it buys the AI:** Frameworks with strong conventions (Rails, Next.js App Router, Effect, NestJS) collapse the design space — there's one place where the router lives, one place where DI bindings live, one place where data fetching happens. Agents thrive on convention because it reduces the "where do I put this" decision tree. The trade-off is migration cost; the scout flags frameworks whose conventions are strong AND whose ecosystems are alive.

**Maps to:**
- Effect (TS), NestJS, RedwoodJS, Remix's route conventions, Next.js App Router.
- Hono with strict middleware conventions (overlaps with `typed-schemas`).

**Does NOT map to:**
- Express with hand-rolled patterns — that's what we already have; the scout shouldn't propose "use Express better." A migration to Hono or Effect, on the other hand, is in scope.
- Spring Boot — wrong stack.

**Canonical topic tags:** `nestjs`, `effect`, `hono`, `remix`, `nextjs-app-router`.

---

## 9. lsp-language-tooling

**What it buys the AI:** Language servers, type-checkers, formatters, and linters give agents an in-loop "is this even valid?" signal that's cheaper than running CI. `tsc --noEmit`, `eslint --fix`, `prettier --check`, `biome`, `oxc` — anything an agent can shell out to inside its dispatch and get a structured pass/fail. The category specifically rewards tools that emit machine-readable diagnostics (JSON LSP-style) over those that only emit human-readable output.

**Maps to:**
- `biome`, `oxc`, `eslint --output-format=json`, `tsc --noEmit --pretty=false`.
- `dprint`, `prettier --list-different`.
- LSP clients an agent can drive headlessly (e.g. `efm-langserver`, `coc.nvim` headless).

**Does NOT map to:**
- Editor extensions that only work inside a UI — agents don't have a UI.
- VS Code-specific extensions without a CLI path.

**Canonical topic tags:** `lsp`, `language-server`, `linter`, `formatter`, `biome`, `oxc`.

---

## 10. dependency-hygiene

**What it buys the AI:** Tools that surface "you depend on a thing that's stale / vulnerable / yanked / duplicated / deprecated" let agents make informed decisions about when to upgrade and when to swap. The orchestrator already runs with a deliberately tiny dep set (4 runtime deps); the leverage here is in catching drift before it lands in CI.

**Maps to:**
- `npm-check-updates`, `taze`, `renovate`, `dependabot` automation policies.
- `pnpm-audit`, `osv-scanner`, `socket.dev`.
- `madge` / `dependency-cruiser` for in-repo dep graphs.

**Does NOT map to:**
- A specific package being out-of-date — that's a fix, not a tool.
- Bundlers (esbuild) — those are `deterministic-builds`.

**Canonical topic tags:** `dependency-management`, `npm-audit`, `renovate`, `dependency-graph`.

---

## Calibrations the operator should revisit

These are the rough edges the smoke test (see playbook §5) is meant to expose:

- **Category overlap.** Several tools span categories (Zod is `typed-schemas` and feeds `type-and-contract-driven-testing`). The scout files under the **primary** category — define one in the issue body, link to the secondary. Don't double-file.
- **Threshold tightness.** "≥ 500 stars" may be too loose for `code-search-infra` (mature category, lots of hobby repos) and too tight for `eval-harnesses` (young category). Adjust per-category in `docs/ai-leverage-rubric.md` once the smoke test produces real data.
- **Retirement criteria.** A category retires when it stops producing scout candidates over 2–3 walks. Don't keep dead categories around for symmetry.
