# Which lines of CLAUDE.md, CONTEXT.md, and the dev playbook the implementer needs, and which are reviewer-only standards

Ticket #5185, wayfinder map #5182 (fact-gathering only; the standards file's home and contract are decided in #5186). Measured against `origin/master` @ `221715373` on 2026-10-23. Word counts are `wc -w` over the stated lines.

## Headline

- **Reviewer-only standards are small: ~422 of CLAUDE.md's 5,131 words (8%).** Another 251 words (5%) are machine-enforced or generated elsewhere, so the prose is redundant. 747 words (15%) serve neither implementer nor reviewer (operator, autopilot, tool-scout and skill-author material). The remaining ~3,711 words (72%) are implementer-needed: navigation, how to run, debug and test, and safety fences.
- Moving standards out of the implementer's context would shrink CLAUDE.md by about 8% (422 words), or about 13% (673) if the machine-enforced prose were also cut. It would not shrink by the 50% or more the talk implies. The larger lever is the pitfalls section, 2,690 words, about 52% of the file. It is debug-shaped, so the implementer needs it, but it is verbose. `SUITE-COUNT GATE` alone is 676 words, and the gate prints its own fix.
- CONTEXT.md (8,216 words) is almost entirely domain vocabulary (the implementer needs it). The only standards-shaped part is the boundary-Seam entries, about 2,141 words (26%), which restate the Redis/zod/process-boundary rules that CLAUDE.md also states and that `scripts/ci/*-seam-check.ts` enforces. Those entries also define terms, so at most half of that is removable.
- The dev playbook contains no coding standards. It is an implementer process contract. The one standards-shaped block, `Fail-loud lint` (226 words), is a runnable machine check, not prose.
- The reviewer already pulls its standards from these same files. `hydra-qa.md` L45, L933 and L952 tell the Standards sub-agent to open `CLAUDE.md`, `CONTEXT.md`, `docs/adr/*` and `docs/agents/*` by name to cite one rule. It also hardcodes a three-item "CLAUDE.md coding conventions" check (L952): Redis access, `eventBus` as a parameter, and no silent `catch`. The implementer is told to read `CLAUDE.md` at step 2 of the child contract (`docs/operator-playbooks/_fragments/hydra-dev-child-flow.md` L32). So both roles share one file today, and a split changes only where the reviewer's pointer lands.

Buckets: **I** = implementer-needed (navigation, run/debug, hard safety fence). **R** = reviewer-only standard. **M** = already machine-enforced or generated (prose redundant). **O** = other role (operator, autopilot, tool-scout, skill author). The ticket named three buckets. O is added because 15% of the file fits none of them.

## CLAUDE.md, by block (5,131 words)

| Lines | Block | Words | Bucket | Evidence / note |
|---|---|---|---|---|
| 1-22 | Intro, Documentation Map, Architecture paragraph | 354 | I | Navigation. |
| 24-38 | Running (service, dev, health commands) | 42 | I | How to run. |
| 42 | TypeScript layout (`src/`, `test/*.test.mts`) | 10 | I | Orientation. |
| 43 | Node pinned via `.nvmrc` | 44 | M | `test/toolchain-pin.test.mts` fails on drift. The remedy (`nvm use`) is a failure-time pointer. |
| 44 | Runtime deps operator-approved (ADR-0005) | 33 | R | `scripts/ci/dep-boundary-check.ts` is advisory only (`advisory-checks.yml` L177). The reviewer is the enforcer. |
| 45 | Never throw from merge/grounding/verification | 16 | R | No check exists. |
| 46 | Fail loud (no silent `catch`) | 24 | M | `src/ast-grep-rules/fail-loud-catch.yml` (advisory) plus the `Fail-loud lint` pre-PR block in `hydra-dev-child-flow.md` L384. |
| 47 | Typed errors carry `code` | 34 | R | Opportunistic ("migration is opportunistic"), no check. |
| 48 | Redis access via `src/redis/<domain>.ts` | 28 | M | `scripts/ci/redis-seam-check.ts` runs in the required `ci.yml` (L51). Duplicated in CONTEXT.md "Redis Adapters". |
| 49 | HTTP bodies validate through `src/schemas/` | 34 | R | `schema-seam-check.ts` is advisory (`advisory-checks.yml` L239). Duplicated in CONTEXT.md "Schemas". |
| 50 | API routes in sub-routers; `eventBus` as parameter | 30 | R | No check. `hydra-qa.md` L952 already hardcodes the `eventBus` half. |
| 51 | `grounding.ts` is read-only | 12 | R | No check. |
| 52 | Structural code search (ast-grep / comby / probe) | 309 | I | On-demand how-to tooling. Verbose, a compression candidate. |
| 53 | Evals (promptfoo) | 123 | O | Skill and prompt authors only. |
| 54 | Dependency hygiene (taze) | 93 | O | Tool-scout and operator. |
| 55 | Vulnerability scanning (OSV) | 205 | O | Tool-scout and operator. |
| 57-62 | CI/CD: PR-only, run `npm test`, CI jobs, deploy fence | 94 | I | Hard safety fences (feature branch, never push to master, never deploy without building the dashboard). |
| 63 | Back-to-back master merges cancel deploy | 154 | O | Autopilot/operator merge-wave concern, and the memory index notes the watchdog now checks SHA drift. |
| 65-69 | Self-modification: tier ladder, Verifier Core prose | 137 | I | Fence: do not bypass the gate. |
| 71-76 | Tier table | 155 | M | `src/tier-classifier.ts` is the source of truth. `docs/reference.md` holds the path lists. |
| 80-90 | Pitfalls: port 4000, worktree isolation, Kanban title, zsh `$status`, `pgrep`/`pkill`, CI-runner kills, heredoc, single-file test, strip-types parameter properties, `/dev/shm` node_modules, buffered reporter | 1,395 | I | Run/debug/safety. The `pgrep` (278), `/dev/shm` (261) and single-file-test (212) bullets are the longest. |
| 91 | `SUITE-COUNT GATE` verdicts | 676 | I | Needed at failure time. The gate prints its own fix ("regenerate the baseline IN THIS PR"), so this is a compression candidate. |
| 92 | No nested `describe` that owns shared-Redis `after()` | 130 | R | Test-authoring rule. A reviewer can check it. Not machine-checked. |
| 93 | `beforeEach`, not `before`, for mutated state | 133 | R | Same. |
| 94 | Friction cue `worktree-write-fence-desync` | 107 | I | Agent-facing emission rule. |
| 95 | Removing behavior: flip old tests first | 172 | I | Implementer workflow ordering. A reviewer cannot observe it. |
| 96 | hydra-betting `npm test` vs `test:raw` | 159 | I | Applies only to Target work. The orchestrator is mothballed from Target (memory: orch-only scope), so it is a candidate to move. |
| 97 | design-concept-reconcile push/`gh pr edit` order | 178 | I | Implementer PR mechanics. |
| 99-108 | Agent skills (spine 172, tracker, labels, domain) and History | 244 | I (72) / O (172) | The spine bullet (172) is autopilot dispatch mapping. The rest is pointers. |

Bucket totals (CLAUDE.md): **I ~3,711 (72%)**, **R 422 (8%)**, **M 251 (5%)**, **O 747 (15%)**. The totals are computed from the per-line `wc -w` and sum to 5,131. Rows aggregate lines, so a few small heading lines are folded into I.

## CONTEXT.md (8,216 words)

| Part | Words | Bucket | Note |
|---|---|---|---|
| Glossary entries excluding the Seam entries below | ~6,075 | I | Domain vocabulary. The Standards reviewer also enforces it (`hydra-qa.md` L951, "CONTEXT.md vocabulary"), but the implementer needs it to name things. 61 `_Avoid_` lines (1,450 words) are the naming-standard part. |
| Boundary-Seam entries (L181-216: GitHub CLI, host-probe, journal, OV, Anthropic, Redis Adapters, Schemas) | ~2,141 | M / R | Each states "never import X from outside" rules that `scripts/ci/*-seam-check.ts` enforce and CLAUDE.md L48/L49 restate. They also define terms, so treat roughly half as removable. |
| Relationships, Example dialogue | 569 | I | Orientation. |

## Dev playbook (`hydra-dev` generated skill, ~8,400 words)

Pieces: `hydra-dev.md` 1,773, `_fragments/hydra-dev-child-flow.md` 3,535, `_fragments/hydra-dev-parent-flow.md` 3,049, vendored `_vendor/implement.md` 70. The child (implementer) path is about 5,400 words.

- **No reviewer-only standards.** Every section is process, a fence or a gate (isolation, claim, reflections, design-concept reconcile, pre-PR gates, friction report, test rules).
- **M:** `Fail-loud lint, changed files` (226 words) is a runnable check, not prose. `Pre-PR mechanical gate` (~430 words including Gates 1-3) is a deterministic check the implementer runs.
- The only standards-adjacent line is step 5's "TDD at pre-agreed seams, red before green, one slice at a time". It is an implementer cadence, so it stays I.
- The reviewer prompt (`hydra-qa.md` L933-952) carries a second copy of standards: a three-item "CLAUDE.md coding conventions" check plus a twelve-smell Fowler battery (vendored `_vendor/code-review.md`). This is the natural home for a reviewer-only standards file. Today it inlines a subset and points at CLAUDE.md for the rest.

## Implications for #5186 (where the file lives)

1. Moving R-bucket rules (roughly 420 words) out of CLAUDE.md saves the implementer little context. The justification for a standards file is separation of roles and one place for retro to write new standards, not a size win. `hydra-retro` today appends prompt-shaped fixes to CLAUDE.md and CONTEXT.md. A reviewer-only file would stop CLAUDE.md growth.
2. R rules with no check (L44, 45, 47, 49, 50, 51, 92, 93) are the real candidates. L46 and L48 are already enforced, so their prose can be dropped or reduced to one-line pointers. L44, L49 and L50 could become deterministic if the advisory seam/dep checks were promoted, which is a separate decision.
3. Compression of the I bucket (the `SUITE-COUNT GATE`, `pgrep`, `/dev/shm` and single-file-test bullets, about 1,400 words) would shrink the implementer's context more than extracting standards would. It is out of scope here but is the bigger lever.
4. The R rules from CLAUDE.md that `hydra-qa.md` L952 already hardcodes (Redis, `eventBus`, silent catch) show the reviewer prompt is already a partial standards file. The decision is whether to promote it into a first-class file or keep it inline.

## Method and caveats

- Classification is judgement, line-by-line. The bucket totals are word counts of the lines assigned to each bucket, not token counts.
- "Machine-enforced" was verified by locating the check: `ci.yml` L51 (redis seam, required), `test/toolchain-pin.test.mts`, `src/ast-grep-rules/fail-loud-catch.yml` (advisory), `advisory-checks.yml` (dep-boundary L177, schema-seam L239, biome L112, ast-grep L104). Only the redis seam check is a required CI step. The rest are advisory, so "M" for L46 and L43 means a check exists, not that it blocks.
- The CONTEXT.md Seam split (~2,141) is an upper bound for removable prose because those entries double as term definitions.
