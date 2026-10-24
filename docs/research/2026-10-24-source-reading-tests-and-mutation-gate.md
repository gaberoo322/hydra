# Source-reading tests, tautology, and the mutation gate

**Asset for wayfinder ticket [#5188](https://github.com/gaberoo322/hydra/issues/5188)** (map [#5182](https://github.com/gaberoo322/hydra/issues/5182), two-pass code factory). This is a **fact** document. It classifies the tests that read repo text, measures whether the mutation gate rewards tests that can't fail, and samples mocked tests for the can't-fail pattern. It does not set the test-quality standard; that is [#5189](https://github.com/gaberoo322/hydra/issues/5189).

Measured against `origin/master` at `676429150` (2026-10-24).

## Headline

- **The map's premise is stale in its shape, not its size.** 507 test files exist, not 514. 192 call `readFileSync`/`readFile`/`readdirSync`; **135 have at least one case that reads repo source, docs, playbooks or config**, and the other 57 read only fixtures or temp files they wrote. The 135 files hold 5,190 cases, of which about 984 (19%) read repo text.
- **Honest drift guards are the minority of the text reading; structure-sensitive pins are spread thin.** By primary class (one per file, over the 135): 47 behaviour (repo files used as *input* to code that runs), 16 prompt-pin, 11 drift-guard, 11 invariant-lint, 8 structure-sensitive, 1 tautological. But **47 files carry structure-sensitive cases somewhere**, usually a few cases inside an otherwise-behavioural file. Their targets are mostly not `src/`: 42 target `scripts/` (bash, python, launcher `.mjs`), 37 dashboard JSX, and only 15 `src/`. 20 of the 47 pin code a test could execute instead.
- **The mutation gate does not reward constant re-assertion through literals: it has no literal mutator.** `src/mutation.ts` has exactly four mutators (`negate-boolean-return`, `swap-comparison`, `negate-condition`, `remove-early-return`), so `export const X = 30` is never mutated and `assert.equal(X, 30)` kills nothing that way.
- **It does reward any test that merely imports the module, through unparseable mutants.** `swap-comparison` rewrites the first `>` (or `<`) on a line, and in TypeScript that is usually a generic: `new Map<string, RollupEntry>()` becomes `new Map<string, RollupEntry<()`. Across all 426 mutable `src/` files, **2,238 of 7,786 candidate mutants (28.7%) do not parse**. Every one is "killed" by any related test file that loads the module, including a vacuous one. Verified on a real file (below): a test asserting only "the module exports something" kills the generic-swap mutant and survives a real `===` → `!==` mutant.
- **The inflation has no merge consequence today.** A below-floor kill rate only blocks when `MUTATION_GATE_BLOCKING` is truthy, and `ci.yml` never sets it, so `mutation-test` (a required check) cannot fail on kill rate. In 40 recent PR CI runs no verdict came near the 55% T3 floor: 14 skipped (no `src/` change), 10 passed at 84–100%, 12 ran out of time budget, 3 had only inconclusive mutants, 1 had no mutants.
- **Mocked tests are overwhelmingly honest.** Of 968 cases in a 25-file sample (top 15 by mock density plus 10 random), 899 are honest, 66 interaction-only, and **3 can't fail** (0.3%). Hydra's fakes mostly carry explicit failure knobs (`throws`, `prListFails`, `FAKE_XADD_FAIL`).
- **The biggest structure-sensitivity cost found is in a drift guard's resolution, not in a behaviour test.** Every generated inventory under `docs/generated/` records source line numbers (1,401 `"line"` fields; `env-vars.json` alone has 820). Of the last 200 master commits, 92 (46%) had to regenerate an inventory, and **32 of those 92 regenerations changed nothing but line numbers**. That is the "line-numbered `env-vars.json`" round loss the ticket names.

## Method

**Corpus.** `test/*.test.mts` at `676429150`: 507 files. Candidates: the 192 files matching `readFileSync|readFile\(|readdirSync|readFile `.

**Classification (question 1).** Four sub-agents each read about 48 files against one written rubric and gave each file a primary class (by case count), secondary classes, case counts, the paths read, and three flags. The classes:

| Class | Meaning |
|---|---|
| `no-repo-read` | reads only fixtures, temp files or stdout; not a source reader |
| `drift-guard` | two sources of truth must agree (generated artifact vs generator, doc vs code, baseline vs files) |
| `invariant-lint` | a repo-wide rule scanned over source text; lint-shaped, could be an ast-grep rule |
| `prompt-pin` | pins playbook / SKILL / prompt prose that agents execute (the prose is the behaviour) |
| `structure-sensitive` | asserts implementation shape (substring, regex, `indexOf` order, line, call-site count) where running the code is the honest test; a behaviour-preserving refactor reddens it |
| `behaviour` | reads repo files only as input to code it runs, and asserts on output |
| `tautological` | re-states a literal the module defines, or asserts its own setup |

Flags: `line_or_position` (asserts line numbers, `indexOf` order or character positions), `sibling_issue_pin` (pins another issue's text or behaviour, or asserts "added by #NNNN"), `could_run_code` (a structure-sensitive pin whose behaviour is reachable by executing the module).

Caveats: the classification is per file, not per case, so the 984 repo-text cases are not split by class. Raters were single-pass model raters with no blind second rating. The chunk-1 rater put scripts-against-temp-dirs files into `no-repo-read` where others used `behaviour`, so read `behaviour` vs `no-repo-read` as soft. Several drift guards were also flagged `tautological` because they compare against a JSON list rather than code; treat the tautological count as an upper bound.

**Mutation gate (question 2).** I read `src/mutation.ts` and `scripts/ci/mutation-check.ts`, then:
1. replayed the four mutators verbatim over every non-skipped `src/**/*.ts` file (one mutant per line, the gate's own line filter) and transpiled each mutated file with `typescript.transpileModule` to count syntactic errors beyond the unmutated baseline;
2. ran one generic-swap mutant and one `===` mutant on `src/aggregators/stalled-prs.ts` against the real related test (`test/aggregator-stalled-prs.test.mts`, via `npm run test:file`) and against a vacuous test that only imports the module;
3. pulled the `mutation-test` result JSON from the last 40 successful PR CI runs.

**Mocks (question 3).** One sub-agent ranked all 507 files by `grep -c` of mock/stub/fake terms, took the top 15 plus a seeded random 10 of the remaining 173 with any hit, and judged each case honest / can't-fail / interaction-only. About a dozen large files were judged from titles, the shared harness and spot-read bodies, so their counts are estimates.

## 1. What the source-reading tests are

| Primary class | Files | Repo-text cases in those files |
|---|---|---|
| behaviour | 47 | 383 |
| prompt-pin | 16 | 203 |
| drift-guard | 11 | 111 |
| invariant-lint | 11 | 43 |
| structure-sensitive | 8 | 101 |
| tautological | 1 | 5 |
| *(no-repo-read primary, but with some repo-text cases)* | *41* | *138* |
| **Total with any repo-text case** | **135** | **984** |

Files *touching* each class (primary or secondary): invariant-lint 64, drift-guard 45, **structure-sensitive 47**, prompt-pin 37, tautological 10. Flags: `line_or_position` 39 files, `sibling_issue_pin` 45 files.

**Drift guards (primary).** `adr-roster`, `docs-areas`, `docs-classes-skills`, `hydra-review-option-table`, `launch-flow-key-contract`, `operator-actions-parity`, `target-board-labels`, `taxonomy-classes`, `toolchain-pin`, `typecheck-test-drift`, `verifier-core-docs-drift`. Most of the ADR-0024/0034 inventory drift guarding sits outside this list, in the generated-inventory check and the 45 files that carry a drift-guard secondary.

**Invariant-lint (primary).** `api-500-catch-ratchet`, `cost-layers`, `headroom-eval-preservation`, `hydra-target-build-target-generic`, `playbook-absolute-write-target`, `playbook-seam-var-guard`, `silent-catch-lint`, `systemd-notify-failure-unit`, `telegram-seam-check`, `test-file-sprawl-guard`, `watchdog-spawn-timeout-ratchet`. These are legitimate. Some are ast-grep-shaped (CLAUDE.md already gives ast-grep the TS lane).

**Prompt-pins (primary, 16).** For example `autopilot-*-forbidden-ending-preamble` (three files), `hydra-dev-*`, `hydra-qa-needs-qa-clear`, `qa-merge-guard-callsites`. A playbook has no code to run, so a pin is the only test. The fragile ones pin an exact sentence or block order rather than a required phrase: `autopilot-dev-target-preamble` asserts the whole normalised CRITICAL SAFETY RULE block byte for byte. The `dev-target` and `qa-orch` forbidden-ending files duplicate one block extractor, assert order by `indexOf`, and each pins the other's prose (#4196 vs #4272). `design-concept-reconcile-run` pins an exact "9b. **MANDATORY — …**" step number in a shared fragment.

**Structure-sensitive, where it lives.** 47 files; 8 primary (`branch-prune-script`, `dashboard-routes`, `dashboard-server-confirmed-write`, `dashboard-ticking-clock`, `docs-page`, `hydra-cli-backlog-move`, `hydra-cli-raw-body`, `watchdog-node-modules-integrity-untouched`). Three clusters:

- **Dashboard JSX source regexes (about 37 targets).** `dashboard-ticking-clock`: all 20 cases regex JSX (exactly one `setInterval(`, `return () => clearInterval(t)`); the hook never runs. `docs-page`: 28 of 30 cases use `indexOf`/regex on the page tree and also pin #4594/#4595's work. `operator-actions-affordance`: 36 of 99 cases match exact multi-line JSX substrings including indentation. `work-page` and `runs-page` together: about 40 cases (`testId="work-promote"`, mount order by `indexOf`). The root suite has no DOM/React harness, so the raters marked these `could_run_code=false`. More precisely, they are runnable only with a harness Hydra doesn't have.
- **Bash / Python / launcher source pins (about 42 targets).** `hydra-watchdog.sh` (`watchdog-launch-flow` pins exactly one `HGETALL` and zero `HGET `, and slices helper bodies by brace position), `deploy.sh`, `branch-prune.sh` (`if [ $TOTAL_SOFT_ERRORS -gt 0 ]… exit 0`, salvage-before-remove by `indexOf`, though the same file already runs the script in a sandbox), `bin/hydra` (`cmd_backlog()` text), `redis-db-launch.mjs` (`suite-count-check` asserts `if (!result.ok && isGateBlocking())` and that `retryShortfallsInIsolation(` appears exactly twice; `redis-db-helper` pins the same launcher again), and `decide.py` (`autopilot-dev-orch-gate`: about half its cases grep for `"dev_orch": _select_slot_dev_orch`).
- **`src/` pins (15 targets).** Mostly absence or import discipline: `turn-snapshot-picks` ("no `glm-eligible` / redis outside comments"), `glm-eligibility` ("imports exactly four modules"), `attention` ("no cost import"), `hydra-target-wire-or-retire-emit` and `hydra-target-cleanup-emit` ("exactly two `"--repo", <var>,` call sites"). These are lint-shaped and sit next to real behaviour cases.

**Runnable structure-sensitive (20 files).** These could execute the code: `autopilot-decide`, `autopilot-deposit-key-resolution`, `autopilot-dev-orch-gate`, `autopilot-watchdog`, `branch-prune-script`, `design-concept-reconcile-check`, `display-format`, `glm-beachhead-report`, `glm-eligibility`, `hydra-cli-backlog-move`, `hydra-cli-raw-body`, `hydra-dev-reflection-deposit`, `hydra-target-wire-or-retire-emit`, `operator-notify-cli`, `qa-merge-guard`, `redis-db-helper`, `suite-count-check`, `taxonomy-classes`, `turn-snapshot-picks`, `watchdog-node-modules-integrity-untouched`.

**Tautological (10 files touch it; 1 primary, which is an upper bound, see caveats).** `event-bus-vocabulary` ("exposes exactly the 18 member set", "exact byte-identical wire strings"). `operator-notify-cli` asserts the literal `FORCE_EXIT_MS = 20_000` and the shebang. `taxonomy-classes` asserts `EXPECTED_*` lists and "exactly 22 classes", restating `classes.json`. `watchdog-node-modules-integrity-untouched` (all 4 cases) greps four files for the #4175 literal `INFRA_NODE_MODULES_WIPED`, though the constants are importable.

**Sibling-issue pins (45 files, a generous count).** Tests that assert another feature's prose is present, or that a file cites `#NNNN`. These are the "sibling-PR pins" the epic sprints lost rounds to: a change to feature A reddens a test named for feature B.

## 2. Does the mutation gate reward tautology?

**How it picks mutants and tests.** It mutates only `src/**/*.ts` files changed in the PR (`scripts/ci/mutation-check.ts` `filterMutationCandidates`, `src/mutation.ts` `SKIP_PATTERNS`), one mutant per line, with the first matching mutator of four. Each mutant runs only its **related** tests: direct importers, then basename-prefix matches, then transitive importers, capped at 8 (`selectRelatedTests`, `DEFAULT_MAX_RELATED_TESTS = 8`). A mutant counts as killed iff the related-test run exits non-zero; a failing unmutated baseline makes it inconclusive (#4504).

**Consequences.**

1. **No literal mutation, so constant re-assertion earns nothing directly.** `assert.equal(FORCE_EXIT_MS, 20_000)` kills no mutant, because no mutator touches `20_000`. A getter `return 30;` does get `remove-early-return`, and a constant test kills that fairly.
2. **Structure-sensitive text pins rarely kill mutants either.** Most target `scripts/` or `dashboard/`, which the gate never mutates. The 15 `src/` pins assert names, imports and comments, and the four mutators skip `import` lines and only touch `===`/`!==`/`<`/`>`/`if (`/`return`. So a text pin would have to match a mutated comparison or return line. None of the `src/` pins found does.
3. **Unparseable mutants are a free kill for any importing test. This is the real tautology reward.**

| Mutator | Candidates across `src/` | Unparseable |
|---|---|---|
| swap-comparison | 5,151 | **2,238 (43%)** |
| remove-early-return | 1,900 | 0 |
| negate-condition | 576 | 0 |
| negate-boolean-return | 159 | 0 |
| **All** | **7,786** | **2,238 (28.7%)** |

Per file (260 files with 10 or more mutants): median unparseable share 27%, p90 57%. **27 files would clear the 55% T3 floor on unparseable mutants alone**, with zero behavioural kills. Typical cases: `Record<string, number> = {}` → `Record<string, number< = {}`, `Promise<void>;` → `Promise<void<;`, `function bucketByDay<R>(` → `bucketByDay<R<(`. The `>` branch is tried before `<`, and a generic's closing `>` is usually the first `>` on a line, so type annotations draw the swap ahead of a real comparison on the same line.

**Empirical check** (`src/aggregators/stalled-prs.ts`, worktree, restored after):

| Mutant | Real related test | Vacuous import-only test |
|---|---|---|
| none (baseline) | pass | pass |
| L151 `new Map<string, RollupEntry>()` → `…RollupEntry<()` | **killed** | **killed** |
| L120 `!==` → `===` | **killed** | survived |

**Honest-floor arithmetic.** If about 28% of a diff's mutants are free kills, an observed 87% kill rate is (87 − 28) / 72 ≈ 82% on the behavioural mutants, and the nominal 55% T3 floor is about 38% honest. The free kills come from the shape of the code (how many generics it has), not from the tests, so two PRs with identical tests can report very different rates.

**What CI actually reports** (40 most recent successful PR runs of `ci.yml`; runs, not PRs, since a PR re-runs on every push):

| Status | Runs | Notes |
|---|---|---|
| skipped (no `src/**/*.ts`) | 14 | docs, scripts, playbook PRs |
| pass | 10 | kill rate 84, 84, 85, 87, 92, 93, 93, 93, 96, 100 (2 mutants) |
| warn: time budget exhausted | 12 | 120–306 of 157–470 mutants run; partial rate 84–95% |
| warn: all mutants inconclusive | 3 | 68–69 mutants, baseline or timeout |
| warn: no mutants generated | 1 | comment-only diff |

No run produced `wouldFail: true`. Because `MUTATION_GATE_BLOCKING` is unset in `ci.yml`, a below-floor result would also have exited 0 (`resolveKillRateVerdict`). Today the gate is an **advisory number inflated by a fixed but code-shape-dependent ~28%**, and 46% of `src/`-touching runs (12 of 26 non-skipped) end in budget exhaustion with no verdict.

## 3. Can't-fail mocks

25 files, 968 cases: **honest 899, interaction-only 66, can't-fail 3.**

The three can't-fail cases:
1. `autopilot-watchdog`, "stale heartbeat + live PID: would-SIGTERM (dry-run)". When the systemd service is inactive (as on CI) it returns early after asserting "service not active", and its last assertion is `assert.ok(process.pid > 0)`. A broken wedge-kill branch passes.
2. `grounding`, "no real subprocess: a stubbed run … never spawns". It checks only `typeof groundingDurationMs` and that the run took under 1s. A path that bypassed the injected `runCmd` and spawned a real process would still pass.
3. `grounding`, "byte-identical default: omitting deps does not change the call shape". It passes `deps`, so omission is never exercised.

Weaker but not vacuous: `api-versions` "sort is -v:refname" (the fake git returns pre-sorted rows, so only the argv assertion guards ordering). `builder-health` "composes every metric from stubbed sources" asserts values the stub supplied. `sync-target-gate` "fails CLOSED on gh failure" is a regex over playbook prose and never simulates a gh failure: a prompt-pin titled like a behaviour test. Fidelity gaps, not vacuity: the `event-bus` fake keeps pre-coercion values, so ioredis turning `null` into `""` is not modelled. Several tests assert *absence of output* ("never POSTs the retired endpoint") rather than intercepting the call.

The dominant idioms are injected `deps` fakes and fake `gh` / `redis-cli` binaries on `PATH` that run the real scripts. Only 4 files use `node:test` `mock.*`.

## 4. Drift guards that are structure-sensitive themselves

The ADR-0024/0034 generated inventories are drift guards by design, but they carry source **line numbers**:

| Inventory | `"line"` fields |
|---|---|
| `env-vars.json` | 820 |
| `routes.json` | 132 |
| `schemas.json` | 89 |
| `redis-keys.json` | 87 |
| 11 others | 273 |
| **Total** | **1,401** |

Of the last 200 master commits, 92 (46%) touched `docs/generated/` and 58 (29%) touched `env-vars.json`. **32 of the 92 regeneration commits changed only `"line": N` values.** Across all 92, 4,471 of 20,777 changed lines (22%) were line numbers. So any edit that shifts lines in a file that reads an env var, registers a route, or names a Redis key forces a regeneration, and a stale one fails the required `test` job. This is structure-sensitivity at the guard's resolution, not in its intent: the facts it protects (this route exists, this env var is read in this file) do not depend on the line.

## What this means for #5189 (facts, not decisions)

- **Of the three lies, "tautological" is rare, "can't-fail" is rare, and "structure-sensitive" is common but diffuse**: 47 files, usually a handful of cases each, concentrated in dashboard JSX (no harness), shell/Python scripts (runnable in a sandbox, as several files already do), and launcher `.mjs` source.
- **The mutation gate's actual defect is mutant validity, not literal-pinning.** The generic-swap mutants account for a fixed ~28% of kills, earned by any test that imports the module. Whether to fix the mutator (skip type positions, or count unparseable mutants as skipped, which `MutationResult.skipped` already models), and whether the gate should ever block, is a decision for #5189 or a follow-up.
- **Line-number resolution in generated inventories is the most measured round-loss source here**: about 16% of all master commits (32 of 200) paid a regeneration whose only content was line shifts.
- **Prompt-pins are a distinct class.** The behaviour *is* the text, so "run the code instead" doesn't apply. The robust vs fragile split is required phrase vs exact sentence / order / step number.
