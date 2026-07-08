# ADR-0026: Target Manifest — per-target build/gate facts live in the target repo, not orchestrator `src/`

Status: Accepted
Date: 2026-07-08
Deciders: Operator + Hydra (grill-with-docs design session)
Related: ADR-0002, ADR-0013, ADR-0003, ADR-0005

## Context

ADR-0013 makes target-agnosticism a defended invariant: hardcoding a target's name, repo, paths, or **domain vocabulary** anywhere in `src/` is a defect. ADR-0002 delivers the swap mechanism through three identity env vars (`HYDRA_TARGET_NAME`, `HYDRA_PROJECT_WORKSPACE`, `HYDRA_TARGET_GITHUB_REPO`) routed through the `src/target-config.ts` seam.

But the identity vars only answer *where the target is*. Everything about *how the builder machinery operates against a target* — the real test/typecheck commands, the app subdirectory, the risk-critical path surface that gates QA depth and the mutation kill-floor — is still either hardcoded in `src/` or scattered across ~12 playbooks. The load-bearing example is `src/target/money-critical.ts`: `MONEY_CRITICAL_TARGET_PATHS` is a frozen const of betting paths (`src/lib/staking/`, `src/lib/bet-math/`, `src/lib/arbitrage/`…) living in orchestrator code. It is dressed as "data-driven," but the data is betting data in `src/` — a latent ADR-0013 defect. Pointing Hydra at a new target (e.g. a gaming webapp) therefore requires edits across ~10 code sites plus the playbooks, and the money-critical gate cannot be reconfigured without an orchestrator code change.

A second, subtler coupling: `HYDRA_BETTING_URL` (read by the long-running service for calibration/Brier metrics) hardcodes "betting" in an env-var name.

## Decision

**Introduce the Target Manifest: a typed, JSON, schema-validated per-target config declaring how the builder machinery operates against the target. It is the third per-target artifact alongside Target Vision (why the product exists) and Target Outcomes (what success means) — the manifest is *how the machinery runs*.**

1. **It lives in the target repo** at `<workspace>/.hydra/manifest.json`, read fresh after `getTargetWorkspace()` resolves. Domain knowledge lives with the code it describes (ADR-0013 §4), and there is no orchestrator-side mirror to drift (contrast the mirrored `config/direction/` docs, issue #1791).

2. **Scope is strictly what orchestrator code or a synced gate script branches on** — `verify` (install/test/typecheck/build commands + `appSubdir`) and `riskCritical` (`surface` globs + `mutationKillFloor`). Domain prose the *playbooks* read (research angles, incident families, vocabulary) is NOT the manifest; it stays in the target's own docs (`docs/agents/domain.md`, the target's `CONTEXT.md`).

3. **One path — betting migrates onto the manifest and the hardcoded consts are deleted.** `MONEY_CRITICAL_TARGET_PATHS` is removed; the classifier becomes a pure `classifyRisk(paths, surface)` taking the surface as an argument sourced from the manifest. hydra-betting ships `.hydra/manifest.json` declaring `npm run test:raw` and its six risk globs. There is exactly one code path; betting is "just another target," not a hardcoded fallback beside a manifest path.

4. **The betting-specific concept "money-critical" is generalized to "risk-critical"** — a two-level boolean (in-surface vs. safe), explicitly NOT the monotonic T1→T4 Modification Tier ladder. "Money" leaves `src/` entirely; betting expresses the concept as "money" only in its own docs.

5. **Format is JSON validated by zod `safeParse`** (`schemas/target-manifest.ts`), not YAML — the repo has no YAML parser (`outcomes.yaml` uses a bespoke subset parser), and the manifest is a validated typed input that code branches on, which is the `schemas/` convention, not the outcomes convention.

6. **The loader is a result-returning leaf** (`src/target/manifest.ts`, `loadManifest(rootDir)`), read-fresh/no-memoization, never throwing — keeping `target-config.ts` pure (`node:`-only, single-string helpers). `rootDir` parameterization lets the same loader serve build-time (workspace), synced gate (worktree), and in-process grounding calls.

7. **Fail loud, fail closed.** A missing or malformed manifest aborts the build with an operator-facing error — no defaults. An empty `riskCritical.surface` is valid *only* with an explicit `acknowledgedNoRiskSurface: true`; an accidental empty surface fails validation, so the keystone gate can never be silently disabled (the "surface gap silently defeats the gate" failure `money-critical.ts` warns against). A required top-level `version` integer makes orchestrator/target schema skew an actionable error, not a cryptic zod failure.

8. **Boundary with env vars: manifest = build/gate facts read in the workspace; env = identity + runtime-infra facts read by the long-running service.** The target web URL is runtime infra (frequent, hot, service-read), so it becomes the generic `HYDRA_TARGET_WEB_URL` env var (deprecated-alias fallback for `HYDRA_BETTING_URL`, mirroring the `HYDRA_WORKSPACE`→`HYDRA_PROJECT_WORKSPACE` migration) exposed as `getTargetWebUrl()` — NOT a manifest field.

## Considered options

- **Manifest in the orchestrator's `config/target/<name>/`** (rejected): keeps all target config under one roof the orchestrator controls, but reintroduces the `#1791` mirror-drift and does not let the risk const genuinely leave `src/` — it only relocates it.
- **Keep betting hardcoded as a fallback; only new targets read a manifest** (rejected): two code paths, and ADR-0013's defect survives behind an `if`. Added surface, removed none.
- **YAML for authoring ergonomics** (rejected): no in-repo parser; the manifest's rationale-comments would duplicate the domain prose that decision 2 already routes to target docs.
- **Graduated criticality levels** (rejected): would fork the QA-depth routing that keys off one boolean; if a target ever needs it, that is its own ADR.

## Consequences

**Positive**
- Pointing Hydra at a new target no longer requires orchestrator code edits for build/verify/risk configuration — it becomes "author `.hydra/manifest.json`."
- `MONEY_CRITICAL_TARGET_PATHS` and the hardcoded `web/` strip in `normalize()` leave `src/`; the money-critical gate is reconfigurable as data.
- Sharpens the target/orchestrator seam: manifest (build/gate, workspace-read) vs. env (identity/infra, service-read).

**Costs**
- The classifier signature change ripples to 8 sites (`scripts/ci/target-risk-core-check.ts`, `scripts/target/{mutation-check,target-design-concept,target-qa-verdict}.ts`, `sync-target-gate.sh`, `classes.json`, `decide.py`) and the "money-critical" language across `hydra-target-build.md` / `hydra-target-qa.md`. Mechanical but wide.
- Migration touches money-critical routing on a live money-handling target, so the CLAUDE.md rule applies: rewrite the tests asserting the old const *first*, verify betting's gate still fires on the same six globs, *then* delete the const.

**Out of scope (sibling work)**
- ADR-0013's coupling-guardrail CI check and de-hardcoding `src/codebase-analyzer.ts`'s betting vocabulary are not fixed here — but with the consts gone they become the last two `src/` defects, and the guardrail can then assert "no target vocabulary in `src/`" as a green invariant.

## Related

- **ADR-0002** Single target per orchestrator instance — the identity-var swap mechanism this ADR extends with a build/gate-facts layer.
- **ADR-0013** Swappable single-target builder — the invariant this ADR operationalizes; `MONEY_CRITICAL_TARGET_PATHS` was a latent defect against it.
- **ADR-0003** Terminal-goal hierarchy — unchanged; the manifest configures the machinery, not the outcomes it optimizes.
- **ADR-0005** Operator-approved dependencies — honored: JSON + zod, no new dep.
