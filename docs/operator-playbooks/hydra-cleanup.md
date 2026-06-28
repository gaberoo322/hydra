---
name: hydra-cleanup
description: Non-interactive deterministic dead-code + simplification detector. Runs a static-analysis tool (knip) over the Orchestrator to find provably-unused exports/files, then files high-confidence findings as ready-for-agent GitHub issues whose acceptance criterion is "remove X AND npm test/tsc still pass". Dry-run by default; --apply creates issues. Zero AskUserQuestion.
when_to_use: "When the Orchestrator's hydra-autopilot board is idle and it wants to turn spare capacity into high-confidence dead-code / simplification work, or when the operator says 'cleanup scan', '/hydra-cleanup', or 'find dead code'. Dispatched by the autopilot `cleanup_orch` signal class (issue #960, parent #958) on the unified `orch_backfill_idle` signal at a 1h cadence."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
arguments: [apply]
claude_only: true
---

# Hydra Cleanup (headless dead-code / simplification scan)

`hydra-cleanup` is a **non-interactive, deterministic** dead-code and simplification detector for the **Orchestrator** (`~/hydra`). It runs the `knip` static analyser to find **provably-unused** exports, types, and files, filters the findings down to high-confidence mechanical ones, and files each as a GitHub issue on `gaberoo322/hydra` whose acceptance criterion is the self-checking *"remove X **AND** `npm test` / `tsc` still pass"*.

It is the gating build artifact for the `cleanup_orch` epic (#958, sub-issue #960): the **high-confidence mechanical workhorse** that reclaims idle autopilot capacity for codebase health, in line with the operator's standing *maintainability over throughput* priority and the 25% self-improvement floor (ADR-0003).

It deliberately **mirrors `hydra-architecture-scan`** (the `architecture_orch` precedent): a depth-first pass over one surface, a filter to keep the issue count honest, structured GitHub issues, and a deterministic one-pass report. The decisive difference is **confidence routing**: where architecture-scan files *judgment-call* deepening candidates at `needs-triage`, cleanup files *mechanically-verifiable* findings straight to **`ready-for-agent`** — because "no references AND the test suite still passes after deletion" is a deterministic acceptance check, not an opinion.

## "Remove unused export" is three outcomes, not one — state which BEFORE filing (issue #2521 — read FIRST)

`knip`'s "unused export" verdict means exactly one thing: *no module OUTSIDE this file imports the symbol*. It is silent on **why** that is true, and the why determines the action. There are **three distinct outcomes**, and the filing skill MUST decide which one applies and **state it in the issue body** so the picking `hydra-dev` agent does not have to re-derive it. The recurring `cleanup-issue-premise-mismatch` failure (and its sibling cues `knip-unused-export-is-internally-referenced`, `cleanup-finding-points-at-definition-not-reexport`, `knip-dead-export-still-internally-used`, `knip-unused-export-demote-not-delete` — a single high-frequency defect fragmented across a cue family, cross-run recurrence 43) is what happens when an issue says only "remove X": the agent attempts a delete, the symbol is not actually removable, and the cycle is wasted.

| Outcome | Premise | What the agent MUST do | How the scan decides it deterministically |
|---|---|---|---|
| **(a) Delete** | The symbol is *truly dead* — no reference anywhere in `src/`/`test/`, the flagged line is the definition, not a relay. | Delete the symbol/file and any imports/re-exports that only existed to reference it. | `classifyExportFix()` returns `delete` (no in-file reference survives) **and** the flagged line is not a re-export relay. Delete is the **exception**, not the default. |
| **(b) Demote** | The symbol is still *referenced within its own file* — only its `export` visibility is dead. | **Drop only the `export` keyword**, keep the definition module-private. NEVER delete (the build breaks). | `classifyExportFix()` returns `demote` (an in-file reference survives stripping the declaration site). The rendered body **leads with a "demote — NOT delete" banner**. |
| **(c) Fix at the definition, not the relay** | The flagged line is a **re-export relay** (`export { x } from './y'` / `export * from`) — the backing definition lives in another file and is still used. | **Remove only the re-export line**, leave the definition and its real consumers untouched. The fix site is the **relay**, but the liveness premise belongs to the **definition**. | The flagged line carries a `from` clause (re-export). The issue body MUST name this as case (c) so the agent does not delete the live definition the relay points at. |

**The rule:** every emitted "remove unused export" issue states a **pre-computed outcome verdict** (a/b/c) up front — `classifyExportFix()` resolves (a) vs (b) deterministically from the symbol's own file (Step 2.5 / issue #1449), and the re-export-relay (c) check distinguishes a relay line from a definition line. When the scan cannot decide deterministically (source unavailable), the body falls back to the full classification probe and labels the verdict `unknown` — it never silently asserts "delete". This is the prompt-shaped half of the fix; the four-case probe in Step 2.5 below is the agent's confirmation step, not a re-derivation of an unstated premise.

## The confidence gate (shared with `hydra-architecture-scan`)

Both idle-backfill scan skills route every emitted candidate through one **confidence gate** — a single, symmetric rule that decides the triage label:

| Confidence | What it means | Triage label | Routing rationale |
|---|---|---|---|
| **Mechanical** (high-confidence) | The acceptance check is **deterministic** — a self-checking "remove X **AND** `npm test` / `tsc` still pass". Provably-unused dead code, deletions/simplifications gated on a green suite. | **`ready-for-agent`** | No human judgment is needed: CI is the merge gate, so a wrong deletion simply fails the suite and the PR is abandoned. The autopilot picks these up hands-off. |
| **Judgment** (softer) | Correctness is an **opinion**, not a green-test check — "this seam feels shallow", a deep-module reorganisation, any deepening whose value is debatable. | **`needs-triage`** | A sweep/operator pass must approve before `dev_orch` grabs it. This keeps the operator in the loop on debatable refactors, honouring *maintainability over throughput*. |

**Deep-module reorganisation is the canonical judgment call → `needs-triage` by default.** It is the deepest, softest category: it carries policy and invariants, and its correctness is a judgment call, not a green-test check. The depth of a candidate inversely correlates with its mechanical verifiability — deeper means softer means judgment means `needs-triage`. A deep-module reorg is **never** auto-routed to `ready-for-agent`, even if a heuristic deems it "clean".

This skill is the **mechanical** half of that gate: every finding it emits is a deterministic dead-code / simplification cleanup, so it routes to **`ready-for-agent`**. The judgment half lives in `hydra-architecture-scan`, which keeps its deepening candidates at `needs-triage` and re-routes only *genuinely-unreferenced* dead code into this mechanical lane (#961). The two playbooks state the same gate symmetrically.

## What this skill is NOT

- **NOT a code-writer.** It never deletes code, never edits `src/`, never opens a PR. It runs the analyser, filters, and files issues. The actual deletion is a later `hydra-dev` pickup against the `ready-for-agent` issue it files.
- **NOT interactive.** **Zero `AskUserQuestion` calls.** It presents findings into issue bodies and stops. It never asks the operator to pick one.
- **NOT a heuristic / LLM judgment pass.** The unused-export/file detection is **deterministic** — it is whatever `knip` reports, not what the model "thinks" looks dead. The model's only job is to render the tool output into issues and apply the filter rules below.
- **NOT the autopilot wiring.** The `cleanup_orch` signal class, the `cleanup_board_saturated` state signal, `decide.py`, and the taxonomy table ship in the same PR as this playbook (issue #960) but are documented in `docs/operator-playbooks/hydra-autopilot.md`, not here.
- **NOT a runtime-dependency change.** `knip` is a **devDependency** (ADR-0005 only constrains *runtime* deps). The orchestrator service never imports it.

## When NOT to run this

- **When the board is already saturated** with open `cleanup-scan` findings. Mirror the scout/architecture discipline: if there are already more than the cap (`CLEANUP_BOARD_SATURATION_CAP = 10` in `collect-state.sh`) open issues carrying the `cleanup-scan` label, **emit nothing** and print a board-saturation skip. The autopilot's `cleanup_board_saturated` signal is the hard suppressor; this in-skill check is a belt-and-braces back-stop so a manual run never floods the board.
- **From inside a `dev_orch` / `dev_target` subagent.** Those work a single issue and must not produce sibling work. This belongs to the autopilot parent context or a manual operator invocation, same as `hydra-prd` / `hydra-architecture-scan`.
- **Against the Target (`~/hydra-betting`).** This skill is **Orchestrator-scoped** (`~/hydra`) by design. The target-scoped sweep is the separate `/hydra-target-cleanup` skill (demote-only, backlog-item-producing — see `docs/operator-playbooks/hydra-target-cleanup.md`), dispatched by the `cleanup_target` signal class.

## Inputs

| Input | Source | Notes |
|---|---|---|
| `apply` (positional / `--apply`) | Operator or autopilot dispatch | Dry-run by default. `--apply` (or `apply=true`) actually creates issues on `gaberoo322/hydra`. A dry-run is always safe — it prints the findings and the rendered issue bodies and stops. |
| Scan surface | Implicit | Always the **Orchestrator** repo at `~/hydra`. Not parameterised. |
| Open-issue board | `gh issue list` | Read before emitting, for the board-saturation back-stop and the duplicate filter. |
| PR dedup surface | `gh api repos/...` (REST) | Read by the emit runner (issue #1766): every open PR + every PR merged within the trailing 24h window, expanded to changed-file paths. A failed fetch aborts the emit. |

## Process

One pass: detect → filter → emit → report, then exit. The skill does not poll, retry, or watch.

### 0. Board-saturation back-stop (read before doing any work)

```bash
OPEN_CLEANUP=$(gh issue list --repo gaberoo322/hydra --state open --label cleanup-scan --json number --jq 'length' 2>/dev/null || echo 0)
```

If `OPEN_CLEANUP > 10`, print the board-saturation skip and exit (emit nothing). Otherwise continue.

### 1. Detect (deterministic — knip)

**First, sync the scan base to current `origin/master` (HARD — issue #1318).** The harness `isolation: "worktree"` bases the dispatched worktree on the **main working tree's current HEAD**, which can lag `origin/master` (it was 7 commits behind during the 2026-06-08 run, filing 8 already-resolved stale findings — #1310–#1317). `knip` reads whatever code is checked out, so a stale base makes it report exports that an in-flight cleanup wave already removed. Before running `knip`, fast-forward the worktree onto the freshly-fetched `origin/master` so the scan reflects the same base a `hydra-dev` pickup would branch from:

```bash
git fetch origin master \
  || { echo "hydra-cleanup: fetch origin/master failed (offline / network) — aborting (cannot guarantee the scan base is current)"; exit 1; }
git merge --ff-only origin/master \
  || { echo "hydra-cleanup: worktree not fast-forwardable onto origin/master — aborting (would scan a stale or diverged base)"; exit 1; }
```

Both guards are deliberate. The fetch guard is HARD (issue #1318 invariant 5): if `git fetch origin master` fails — offline, a network blip, an unreachable remote — execution must **abort**, never fall through to a `git merge --ff-only` against the last-known (stale) cached `origin/master` ref, which would scan exactly the stale base #1318 set out to fix. This mirrors the knip-not-installed handling below: a failed deterministic step prints a one-line hint and exits cleanly rather than degrading silently. The `--ff-only` is likewise deliberate: this scan worktree should be a clean descendant of master, so a fast-forward is always expected. If the merge is **not** fast-forwardable (the worktree has diverged commits), the base is untrustworthy — abort rather than scan a stale/diverged tree, exactly the failure #1318 describes. After the fast-forward, `git rev-parse HEAD` equals `origin/master`, so every finding is derived from the up-to-date base and a finding already resolved on `origin/master` is never reported.

Then run `knip` over the now-current Orchestrator. `knip` reports unused files, unused exports, unused exported types, and unused dependencies. We scope the run to the highest-confidence categories (unused files + unused exports/types) and emit machine-readable JSON:

```bash
npx knip --reporter json --no-exit-code > /tmp/knip-report.json 2>/dev/null || true
```

`--no-exit-code` keeps the analyser's non-zero "findings exist" exit from aborting the skill; the JSON report is the source of truth. If `knip` is not installed (`npx` fails), print a one-line install hint (`npm ci` to pull the devDependency) and exit cleanly — do NOT fall back to a heuristic scan.

**The emit runner refuses a stale report (issue #1766 — report-staleness guard).** The Step 3 runner checks `/tmp/knip-report.json`'s mtime and **aborts** (non-zero exit, with a re-run instruction) when the report is older than 60 minutes (`KNIP_REPORT_MAX_AGE_MS`). The 2026-06-11 dup wave (#1747–#1755) reproduced the 10:40Z batch title-for-title at 15:57Z — hours after the covering fix PRs had merged — which is the signature of a stale report (or a skipped fresh-base fetch) feeding the emit. A report older than one scan cadence cannot be trusted to reflect `origin/master`; always run `knip` freshly (after the Step 1 fetch + fast-forward) in the same pass as the emit.

Parse the report's `files` (provably-unused whole files) and `issues[].exports` / `issues[].types` (provably-unused named exports within a still-used file). These two categories are the **deterministic** findings. Ignore `knip`'s softer categories (unlisted/unresolved dependencies, duplicate exports) for issue emission — note them in the report only.

**Use the pure parser `parseKnipReport()` in `scripts/ci/hydra-cleanup-render.ts` (issue #1167) to do this normalisation** — it reads the symbol `name` (for an export/type) and the `path` (for a whole file) out of the SAME knip object the title is later derived from, producing a `CleanupFinding { kind, path, name }` per finding. Do NOT hand-roll the parse into parallel title/path arrays: the helper is what guarantees the title can never drift from the path (the #1005 off-by-one) and that a finding which failed to yield a name/path arrives at the validation gate (Step 2) with an empty field rather than silently rendering a blank title (the #1167 double-space / trailing-space drafts).

> In normal operation you do not call `parseKnipReport()` by hand — the Step 3 runner `scripts/ci/hydra-cleanup-emit.ts` (issue #1449) owns the whole parse → validate → filter → classify → dedup → render → create pipeline. Steps 1–2 below describe what that runner does so the contract is auditable, but the emit is a single `npx tsx scripts/ci/hydra-cleanup-emit.ts` invocation — never a transcribed bash loop, which is exactly where the #1421–#1426 blank titles came from.

### 2. Filter (keep the findings high-confidence)

**First, the blank-title guard (issue #1167 — HARD, runs before every other drop rule).** Run each `CleanupFinding` through `validateFinding()` (in `scripts/ci/hydra-cleanup-render.ts`) and DROP any finding for which it returns a non-null reason. This rejects a finding with an empty `path` (the `cleanup: remove unused file ` draft, trailing space, no path) or — for an export — an empty `name` (the `cleanup: remove unused export  (src/scheduler/heartbeat.ts)` draft, double-space where the symbol belongs). This is the single chokepoint that makes a malformed/blank-title draft *impossible to emit*: a finding that fails to parse a name or path never reaches `gh issue create`. `renderTitle()` / `renderBody()` additionally **throw** on an invalid finding, so any finding that slips past this gate fails loud in the run instead of quietly filing junk. The blank-title drafts #1151–#1158 (run ef0a9847) are exactly what this gate prevents.

Then drop a finding before it becomes an issue when ANY of:

- **It touches the Verifier Core** (`src/untouchable.ts` `VERIFIER_CORE_PATHS`: `ci.yml`, `deploy.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`). Those are operator-only (ADR-0001/0004/0015). Never steer an agent at them. Note the finding in the report, but do not file it.
- **It is a test file, a type-only `.d.ts`, or a file `knip` flags only because its sole consumers are tests** — deleting a test or a test-only export is a coverage regression, not a cleanup. The acceptance check (`npm test` still passes) would pass trivially while silently removing a test; exclude these.
- **It is a public entrypoint by configuration** — `src/index.ts`, an export re-exported through a barrel that IS imported elsewhere, or anything `knip` lists under `production`-entry ambiguity. When in doubt, drop it: a false-positive deletion that breaks a runtime path is worse than a missed cleanup.
- **It is an EXPORT finding against a module consumed via a namespace import (issue #1737).** When any file in `src/` or `scripts/` holds an `import * as ns from "<module>"` of the flagged module, knip's per-export liveness for that module is untrustworthy *wholesale*: the namespace object escapes through DI facades of the form `deps.x ?? defaultX` (then members are read off an interface-typed local), so knip reports live exports as unused — 11 of 15 findings on #1724 were this false positive (recurrence cue `knip-namespace-import-facade-false-positive`). The emit runner scans `src/**/*.ts` + `scripts/**/*.{ts,mts}` for namespace-import consumers (`collectNamespaceConsumedModules()`), resolves the specs to repo-rooted paths, and drops every export-kind finding whose module hits — each suppression appears in the dropped audit list with the `namespace-import / DI-facade` reason, never silently. The drop is deliberately per-module, not per-symbol: a genuinely-dead export inside a facade-consumed module is no longer filed (accepted trade-off — a missed cleanup is cheaper than the burnt dev+QA cycle of refuting a false positive). **File-kind and dependency findings are unaffected** — a namespace-imported file is never flagged as an unused file, so whole-file dead code is still harvested.
- **Its path is changed by an open or recently-merged pull request (issue #1766).** A finding that is live at scan time can already be covered by an **in-flight fix PR** (open) or a **just-merged sibling PR** the knip report predates — re-filing it is the #1747–#1755 dup wave (filed at 15:57Z on 2026-06-11 when ALL covering fix PRs #1719/#1720/#1722/#1723/#1743 had already merged at 11:30–11:40Z and 15:26Z; the #1318 fresh-base rule only helps when knip actually re-ran). The emit runner fetches **every open PR plus every PR merged within the trailing 24h window** (`MERGED_PR_DEDUP_WINDOW_MS`) via `gh api repos/...` REST (the GraphQL pool gets exhausted under a running autopilot), expands each to its changed-file paths, and drops any finding whose `path` intersects — at **path granularity**, deliberately: GitHub exposes changed files not symbols, and over-suppression costs one scan cycle (self-heals next hourly run) while a false re-file burns a dev+QA cycle, the same asymmetry the #1737 per-module drop accepted. Every suppression lands in the dropped audit list with a reason citing the covering PR number(s) (`covered by open PR #N` / `covered by recently-merged PR #N (merged <iso>)`) — never silent. **A failed PR fetch ABORTS the emit** (fail loud, mirroring the board-read abort): an emit that cannot dedup against in-flight fixes safely must emit nothing, because degrading to an empty PR set silently re-opens the duplicate-wave hole. There is no title filter — non-cleanup PRs (refactors, feature work) also resolve knip findings, and path intersection is the deterministic signal.
- **It duplicates an already-open `cleanup-scan` issue.** Dedup on the **stable `path::symbol` identity, NOT the title** (issue #1167). Read the open `cleanup-scan` issues (title **and body**, issue #1653) from the board (step 0), then pass them with your validated findings to `dedupAgainstOpen()` (in `scripts/ci/hydra-cleanup-render.ts`): it recovers each open issue's identities from **both surfaces** — the title via `identityFromOpenIssueTitle()` (legacy single-finding issues) and the body's `cleanup-identities` HTML-comment manifest via `identitiesFromIssueBody()` (batch issues, #1653) — and drops any finding whose `findingIdentity()` already has an open issue. **Why identity, not title:** the #1167 double-file happened because the dedup key was the *title*, and the malformed draft titles did not byte-match the canonical titles, so dedup did not recognise the drafts as duplicates of their own canonical siblings. Keying on `path::symbol` is robust to that. `dedupAgainstOpen()` also de-duplicates **within the current run**, so a single run can never file two issues for one identity. Re-filing the same finding every idle tick is the exact churn the saturation cap and this dedup guard prevent. **Partial completion (#1653):** a closed batch issue releases *all* its identities at once; the next scan re-files only the findings knip still reports.

> **Quota:** the per-run cap (`EMIT_CAP = 8`) counts **batch issues**, not findings (issue #1653) — 8 batches can cover ~150 findings. Batches holding whole-file deletions rank first (they reclaim the most surface), then the biggest harvests; the remainder is noted in the report and the next idle turn picks up where this one left off (the dedup filter ensures no double-filing).

### 2.5 knip false-positive taxonomy + safe-fix recipe (issue #1299 — read before deleting anything)

> This is the agent's **confirmation** step for the outcome the issue body already states — it is NOT where the outcome is first derived. The "Remove unused export is three outcomes, not one" section at the top of this playbook (issue #2521) is the contract the *filing* skill follows so the expected outcome (a delete / b demote / c fix-at-definition) is already written in the issue body; the four-case table below is the picking agent's probe to verify that stated verdict before writing the fix. Map (a) delete and (b) demote to the three-outcome table's rows of the same name; outcome (c) "fix at the definition, not the relay" is exactly case (c) below; case (d) coupled Redis-key sets is an additional confirmation sub-case of (a)/(c).

`knip` reports a symbol as an "unused export" without distinguishing a *truly dead* symbol from one whose only dead aspect is its `export` visibility, a re-export whose backing definition is still live, or a Redis key generator coupled to sibling generators and their test assertions. A naive **delete** on any of the last three breaks the build or orphans coupled code. The `hydra-dev` agent that picks up a `cleanup-scan` issue **MUST** classify the finding into one of the four cases below and apply the matching safe fix. This is durable guidance so the disambiguation is not re-derived per cycle (the recurring `dead-code-removal-leaves-orphan-redis-keys` / `knip-dead-export-still-internally-used` friction, cross-run recurrence 9).

**Classification probe (run before writing the fix).** For the flagged symbol `<name>` in `<path>`, grep the whole repo for remaining references and inspect the flagged line. **Use `grep -rnw`, NOT `rg -w`, for the word-boundary probe (issue #1733).** The host's `rg` is a minimal compatibility shim that *silently ignores* unsupported flags including `-w`, so `rg -w "<name>"` matches substrings (e.g. `<name>` inside `<name>Extra`) and reports a dead export as "live" — a misclassification that wastes the demote-vs-delete analysis. GNU `grep` honours `-w` (and fails loud on a genuinely unknown flag), so it is the canonical liveness-probe tool here:

```bash
# 1. Is the symbol still referenced ANYWHERE in the repo (src + test), ignoring its own definition site?
grep -rnw "<name>" src test | grep -v "<path>"
# 2. Is the flagged line a re-export (`export { x } from './y'` / `export * from`) rather than the definition?
grep -rnE "export .*\b<name>\b" "<path>"
# 3. For a Redis key generator: are sibling generators in the same file referenced only by the same test assertions?
grep -rn "<name>" src/redis test/redis-keys.test.mts
```

**The grep probe is a HINT; the compiler is the PROOF — a multi-line import defeats line-scoped grep (run 9bb60005, friction `dead-export-premise-missed-multiline-import`, cross-run recurrence 3).** `grep -rnw "<name>"` matches one line at a time, so a live consumer whose `import { … }` list spans **several lines** (e.g. `test/tier-classifier.test.mts` imports `VERIFIER_CORE_PATHS` across lines 30-33 from the `tier-classifier.ts` re-export) only matches on the line the bare symbol sits on — which may not contain `<name>` at all. An empty probe-1 result is therefore **necessary but not sufficient** for case (a) "truly dead": it can be a false-empty that mis-stamps a still-live symbol as dead, inviting a build-breaking delete. **Before stamping case (a), confirm the removal compiles** — `npm run typecheck:test` (NOT just src-only `tsc`, which misses test-file consumers) is the authoritative liveness check; if it goes red the symbol was live, so re-triage as case (b)/(c) and abort the deletion. Treat grep as the cheap first filter and the compiler as the verdict.

| Case | knip says | What's actually true | Safe fix | Evidence anchor |
|---|---|---|---|---|
| **(a) Truly dead** | unused export | No references anywhere in `src/` or `test/` (probe 1 empty), not a re-export, no coupled keys. | **Delete** the symbol/file and any imports/re-exports that only existed to reference it. This is the only case where deletion is correct. | the default knip happy-path |
| **(b) Internally referenced — demote, don't delete** | unused export | The symbol is still *called within its own file* (or module) — only its `export` visibility is dead (probe 1 shows in-file callers; probe 2 shows it's the definition). | **Drop only the `export` keyword**, keep the definition module-private. Do NOT delete the symbol — the build breaks. | `src/capacity-floor.ts:183,250,260` (function called internally); `src/autopilot/recommendation-engine.ts` incl. `MAX_RECS_PER_CALL` (const/interface still used) |
| **(c) Re-export, definition live elsewhere** | unused export (the re-export line) | The flagged line is a `export { … } from …` / barrel re-export, but the backing **definition lives in another file and is still used** (probe 2 shows a `from` clause; probe 1 finds live uses of the definition). | **Remove only the re-export line**, leave the definition and its real consumers untouched. | `src/digest.ts` re-export block (definition lives + is used in `src/digest-format.ts`) |
| **(d) Coupled Redis key generator** | unused export (a key generator) | The generator is coupled to **sibling generators in the same `src/redis/keys.ts` block AND their assertions in `test/redis-keys.test.mts`** (probe 3). Deleting the generator alone orphans the test assertions; deleting the assertions alone is a coverage false-green. | **Remove the full coupled set together** — the generator(s) *and* their test assertions — under a `scope-justification:` block in the PR body naming the test file (it is out of the single-file scope the issue names). Treat the key generator + its assertions as one atomic unit. | `planCache*` generators in `src/redis/keys.ts` + their assertions in `test/redis-keys.test.mts` (removed together under scope-justification) |

**Decision rule:** delete (case a) is the *exception*, not the default. If probe 1 finds **any** live reference, you are in case (b) or (c) → demote / drop-re-export, never delete. If the symbol is a Redis key generator, run probe 3 → case (d) → atomic coupled-set removal with scope-justification. When still ambiguous after the probes, prefer the **narrowest** edit that turns the symbol dead (drop `export` / drop the re-export line) — a missed cleanup is cheaper than a broken build, and the deterministic acceptance check (`npm test` + `tsc` + `npm run typecheck:test` still green, no new knip finding) is what proves the fix correct. If `npm test`/`tsc` go red after a delete, that is knip's false positive surfacing — revert to the demote/drop-re-export fix, do not force the deletion.

### 3. Emit issues — run the deterministic emitter, do NOT hand-roll a bash loop (issue #1449 — HARD)

**Do not drive `gh issue create` from a hand-written bash loop. Invoke the deterministic emit runner `scripts/ci/hydra-cleanup-emit.ts` instead** — it owns parse → validate → filter → classify → dedup → render → create as one pass, and it is the recurrence fix for #1449.

```bash
# Dry-run first (prints the plan: every title + body + demote/delete verdicts, files nothing):
npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json

# Apply (files one cleanup-scan + ready-for-agent BATCH issue per module-dir group):
npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json --apply
```

**The unit of work is one module batch, not one finding (issue #1653).** After validate → filter → classify → dedup (all still per-symbol, so the #1167 blank-title and #1449 demote-vs-delete guards are untouched), the runner groups the surviving findings by **module dir** — `moduleDirKey()`, the top-2 path segments of the containing directory (`src/schemas/explore-page.ts` → `src/schemas`) — and renders **one issue per group**. Groups over `SYMBOLS_PER_BATCH = 20` findings split into reviewable chunks (the largest single-batch precedent that cleared the merge gate is 16 exports, PR #1549): within each group, whole-file deletions sort first and findings within each kind sort by (path, name), so chunk boundaries are deterministic across runs — never dependent on knip's output order — and every chunk title of a split module carries an ` [i/k]` suffix so sibling chunks never render identical titles (artifact Invariant 6, #1653 forward-fix). An UNSPLIT 1-finding group keeps the legacy single-finding format below (a 1-finding remainder chunk of a split module renders the batch format, suffix included); a multi-finding group renders the batch format: a **per-symbol checklist** (each line leading with its `classifyExportFix()` verdict), the probe/taxonomy prose **once**, a `## Files in scope` section listing each distinct path, and a machine-readable **`cleanup-identities` manifest** (an HTML comment, one `path::symbol` line per finding) that `identitiesFromIssueBody()` parses back for dedup. This is the granularity flip that turns ~179 per-export PRs (~8,400 CI-job-minutes) into ~2 dozen batch PRs at byte-identical final code state — every downstream layer (dispatch, tier-gate, scope-check, auto-merge) operates on issues and paths, so it batches for free.

**Why the runner, not a bash loop (issue #1449).** #1167 moved the *parse → validate → dedup → render* helpers into `scripts/ci/hydra-cleanup-render.ts`, but the **emit step stayed LLM-prose-executed** — the playbook described a bash `gh issue create` loop the model transcribed by hand. On run f6403146 the model rendered each issue **body** via `renderBody()` (so the body H1 carried the correct symbol, e.g. `RecentMergesQuery`) yet **hand-built the issue title** by interpolating knip's raw output, which lost the symbol — producing the blank `cleanup: remove unused export  (src/schemas/today-page.ts)` titles on #1421–#1426 (the #1167 regression). The title and body diverged because they came from two different sources. The runner removes that discretionary step: the title comes **only** from `renderTitle()` and the body **only** from `renderBody()`, both from the **same** `CleanupFinding` inside one iteration, so the title can no longer drift from the body. There is no second pass, no index-aligned zip (the #997–#1004 / #1005 off-by-one), and no place for the model to build a title by hand. The runner also reads the open `cleanup-scan` board itself and aborts the dedup if it can't, applies the board-saturation cap, and ranks whole-file deletions ahead of single-export deletions.

**The runner dedups against open + recently-merged PRs and refuses a stale knip report (issue #1766).** Before planning, the runner reads the PR dedup surface via `gh api repos/...` REST — every open PR plus every PR merged within the trailing 24h window, each expanded to its changed-file paths — and injects it into `planCleanupEmit()` as an optional parameter (the same injected-parameter shape as the #1737 namespace-consumer set; an empty list degrades to the pre-#1766 plan). A finding whose path any of those PRs changed is dropped with an audit reason citing the covering PR number(s). A failed PR fetch aborts the emit with a non-zero exit (cannot dedup safely → emit nothing), and a `/tmp/knip-report.json` older than 60 minutes aborts with a re-run instruction (the staleness guard from Step 1). Replaying the 2026-06-11 scenario — fix PRs #1719/#1720/#1722/#1723/#1743 merged within the window at scan time — through the planner emits **zero** of the covered findings; pinned in the regression test.

**Demote-vs-delete is classified deterministically (issue #1449).** For every export finding the runner reads the symbol's **own file** and calls `classifyExportFix()`: if the symbol is still referenced within that file (a sibling `z.infer<typeof X>` type alias, a schema composed into another schema, an in-file caller) it stamps `fix: "demote"` and the rendered body **leads with a "Recommended fix: demote (drop the `export` keyword) — NOT delete"** banner before the generic probe; otherwise it stamps `fix: "delete"`. This is the deterministic, low-false-positive half of the Step 2.5 taxonomy (case b, internally referenced) — it resolves the most common false positive up front so the emitted issue never invites a build-breaking delete (the recurring `knip-unused-export-demote-not-delete` / `knip-unused-export-is-internally-referenced-not-dead` friction). Cross-file re-export (case c) and coupled-Redis-key (case d) disambiguation stay in the issue-body probe the picking `hydra-dev` agent runs.

If you ever need to inspect or stage a single body, render it via the helper (never hand-author it): both `renderTitle()` / `renderBody()` **throw** on an invalid finding, so a blank-title issue is impossible. But the normal path is the runner — do not reconstruct the loop in bash.

Issue body schema — **legacy single-finding format**, used when a module group holds exactly one finding (its identity lives in the title, so legacy dedup keeps working):

```markdown
# cleanup: remove unused <export|file> `<name / path>`

> Surfaced by `/hydra-cleanup` on <ISO date> against the Orchestrator (~/hydra).
> Deterministic detection via `knip` (devDependency). High-confidence mechanical cleanup.

## Finding

`knip` reports `<path>` (or the named export `<name>` in `<path>`) as **provably unused** — it has no remaining references in the orchestrator codebase.

## What to do

**`knip` reports an "unused export" without telling you *why* it is dead — classify before you delete.** A naive delete is correct only when the symbol is *truly* dead; if its only dead aspect is `export` visibility, a still-live re-export, or a coupled Redis key generator, a delete breaks the build or orphans coupled code. Run this classification probe first (for the flagged `<name>` in `<path>`):

Use `grep -rnw`, NOT `rg -w`, for the word-boundary probe — the host `rg` shim silently drops `-w` and matches substrings, mis-reporting a dead export as live (issue #1733):

```bash
# 1. Still referenced ANYWHERE (src + test), ignoring its own definition site?
grep -rnw "<name>" src test | grep -v "<path>"
# 2. Is the flagged line a re-export (`export { x } from './y'` / `export *`) rather than the definition?
grep -rnE "export .*\b<name>\b" "<path>"
# 3. Redis key generator? Are sibling generators referenced only by the same test assertions?
grep -rn "<name>" src/redis test/redis-keys.test.mts
```

Then apply the matching fix — **delete is the exception, not the default** (full table with evidence anchors lives in Step 2.5 of the hydra-cleanup playbook, `docs/operator-playbooks/hydra-cleanup.md`):

- **(a) Truly dead** — probe 1 empty, not a re-export, no coupled keys → **delete** the symbol/file and any imports/re-exports that only existed to reference it.
- **(b) Internally referenced** — probe 1 shows in-file callers, probe 2 shows it's the definition → **drop only the `export` keyword**, keep the definition module-private. Do NOT delete (the build breaks).
- **(c) Re-export, definition live elsewhere** — probe 2 shows a `from` clause, probe 1 finds live uses of the definition → **remove only the re-export line**, leave the definition and its consumers.
- **(d) Coupled Redis key generator** — probe 3 shows sibling generators coupled to assertions in `test/redis-keys.test.mts` → **remove the full coupled set atomically** (generator(s) + their test assertions) under a `scope-justification:` block naming the test file.

If `npm test` / `tsc` go red after a delete, that is knip's false positive surfacing — revert to the demote / drop-re-export fix; never force the deletion.

## Files in scope

- `<path>`

## Acceptance criteria

- [ ] `<path>` (or the named export `<name>`) is removed, along with any imports/re-exports that only existed to reference it.
- [ ] `npm test` still passes (the deletion breaks no test).
- [ ] `tsc` (`npm run typecheck` and `npm run typecheck:test`) still passes (the deletion breaks no type).
- [ ] No new `knip` finding is introduced by the change.

## Why this is safe (deterministic check)

This is a mechanically-verifiable cleanup: the deletion is correct **iff** the test suite and the type-checker still pass afterward. If either fails, the export/file was not actually dead and the PR should be abandoned, not forced.

---
*Generated by hydra-cleanup (issue #960, epic #958). Routes to `ready-for-agent` because the acceptance check is deterministic.*
```

Issue body schema — **batch format** (issue #1653), used when a module group holds 2+ findings (rendered by `renderBatchBody()`):

```markdown
# cleanup(<module dir>): demote/remove <N> unused exports (<M> files)

> Surfaced by `/hydra-cleanup` on <ISO date> against the Orchestrator (~/hydra).
> Deterministic detection via `knip` (devDependency). High-confidence mechanical cleanup,
> batched per module dir (issue #1653) — one PR resolves every finding below in `<module dir>`.

## Findings (per-symbol checklist)

- [ ] `<name>` (`<path>`) — fix: **demote** (drop only the `export` keyword — still referenced within its own file; deleting breaks `tsc`)
- [ ] `<name>` (`<path>`) — fix: **delete** (no in-file reference found — still run the probe below before deleting)
- [ ] `<path>` — fix: **delete the whole file** (knip reports it provably unused)

## What to do

<the Step 2.5 classification probe + four-case taxonomy, ONCE for the whole batch>

## Files in scope

- `<each distinct path, one bullet per file>`

## Acceptance criteria

- [ ] Every checklist item above is resolved per its verdict, or recorded in the PR body as a knip false positive with probe evidence.
- [ ] `npm test` / `tsc` / `npm run typecheck:test` still pass; no new `knip` finding.

## Why this is safe (deterministic check)

<the deterministic-acceptance paragraph + the partial-completion note>

<!-- cleanup-identities:
<path>::<symbol>
<path>::<file>
-->
```

The trailing `cleanup-identities` HTML comment is the **machine-readable dedup manifest**: one `findingIdentity()` key per line. `readBoardIssues()` fetches each open issue's title **and body**, and `dedupAgainstOpen()` unions identities from legacy titles and batch manifests — so neither issue generation can be double-filed. The batch title deliberately does NOT match the legacy title patterns; a batch's identities live only in its manifest.

**Labelling rule (HARD):** every emitted issue carries `cleanup-scan` and `ready-for-agent`. The `cleanup-scan` label is the emit/count seam that `collect-state.sh` reads for `cleanup_board_saturated`, so it MUST be present on every issue. Routing to `ready-for-agent` (NOT `needs-triage`) is the deliberate confidence-routing decision (epic #958): the acceptance criterion is self-checking, so no operator triage gate is needed — a `hydra-dev` pickup will only merge if the deletion keeps `npm test` and `tsc` green, and CI is the merge gate.

The emit itself is **not** a hand-written bash loop (issue #1449). It is the deterministic runner from the top of this step — it renders the title and body for each finding from the same object and creates the issue in one pass, so the title cannot drift from the body:

```bash
# The runner owns parse → validate → filter → classify → dedup → group → render → create.
# Title and body both come from the SAME findings in one pass — renderTitle()/renderBody()
# for a 1-finding group, renderBatchTitle()/renderBatchBody() for a multi-finding batch —
# no hand-built title, no parallel title/body lists (the #1449 / #1005 drift guard).
npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json --apply
```

### 4. Report (deterministic summary)

Print a single-pass summary — this is the operator's audit surface:

```
hydra-cleanup — Orchestrator (~/hydra) — 2026-06-03T12:00:00Z — apply

knip findings:        42 unused (4 files, 38 exports)
After filter (verifier-core/test-only/entrypoint/dup):  36
Emitted:              4 batch issues covering 36 findings  [ready-for-agent, cleanup-scan]  (#NNN ... #NNN)
Dropped:              6  (2 verifier-core, 3 test-only, 1 duplicate of open #NNN)
Board saturation:     ok (3 open cleanup-scan issues, under the 10 cap)
```

In dry-run mode the header reads `(dry-run; no GitHub issues created)` and the emitted line shows the rendered bodies instead of issue numbers.

## Rules

- **Zero `AskUserQuestion`.** Present findings into issue bodies and stop.
- **Deterministic detection only.** The findings are `knip`'s output, not the model's guess. Never file a "this looks unused" finding that the tool didn't report.
- **Scan against current `origin/master`, never the inherited stale worktree base (issue #1318).** `git fetch origin master` + `git merge --ff-only origin/master` before `knip`, so the scan reflects the same base a `hydra-dev` pickup branches from. Both steps are HARD-guarded: a failed fetch (offline / network) and a non-fast-forwardable worktree both abort the run rather than scanning a stale or diverged tree. A finding already resolved on `origin/master` must never be filed.
- **Dedup against open AND recently-merged PRs; abort if the surface is unreadable (issue #1766).** The emit runner fetches every open PR plus every PR merged within the trailing 24h window (REST, never GraphQL) and drops any finding whose path those PRs changed, citing the covering PR number in the audit list. A failed fetch aborts the emit — emitting with dedup silently disabled is the duplicate-wave failure itself. A knip report older than 60 minutes is likewise refused.
- **Every issue carries `cleanup-scan` + `ready-for-agent`.** The label is the count seam for `cleanup_board_saturated`; the routing is the confidence decision.
- **Acceptance criterion is always "remove X AND `npm test` / `tsc` still pass".** The deletion is self-checking — that is what justifies routing to `ready-for-agent` instead of `needs-triage`.
- **Never steer at the Verifier Core** (`src/untouchable.ts` paths). Reported as friction, never filed as an actionable cleanup.
- **Never delete tests / test-only exports.** A passing suite after deleting a test is a false green.
- **Orchestrator-scoped.** Always `~/hydra`. Not parameterised to the Target.
- **Board-saturation back-stop.** Emit nothing when the board already holds > 10 open `cleanup-scan` issues — belt-and-braces ahead of the autopilot's `cleanup_board_saturated` signal.
- **Dry-run default.** Only `--apply` creates issues. A dry-run is always safe.
- **One pass.** Detect → filter → emit → report, then exit.
- **knip is a devDependency.** It is pulled by `npm ci`; the orchestrator service never imports it (ADR-0005 governs runtime deps only).

## Manual smoke test

```bash
/hydra-cleanup            # dry-run: runs knip, prints findings + rendered bodies
/hydra-cleanup --apply    # files ready-for-agent issues on gaberoo322/hydra
```

Expected:

- **Fresh base before scan (issue #1318).** The run fetches `origin/master` and fast-forwards the worktree onto it before invoking `knip`, so `git rev-parse HEAD` equals `origin/master` at scan time. A finding already resolved on `origin/master` (e.g. an export an in-flight cleanup wave removed) is never reported — reproducing the 2026-06-08 stale-base run (#1310–#1317) against a freshly-fetched base emits zero of those findings. A worktree that cannot fast-forward onto `origin/master`, **or a `git fetch origin master` that fails (offline / network),** aborts the run instead of scanning a stale or diverged base.
- `knip` runs and the report parses; findings are categorised into files vs exports.
- The filter drops verifier-core, test-only, entrypoint, and duplicate findings.
- `--apply` files issues labelled `cleanup-scan` + `ready-for-agent` — each with the deterministic "remove X AND test/tsc green" acceptance criterion.
- **Title/body pairing (multi-finding regression, issue #1005).** Run the dry-run (or `--apply`) over a scenario with **≥2 findings** and assert that, for **every** emitted issue, the body's H1 (`# cleanup: remove unused <export|file> \`<name / path>\``) AND its `## Files in scope` path name the **same** target as that issue's title — no off-by-one, no rotation across the batch. The dry-run already prints both the title and the rendered body for each finding, so the check is: in a multi-finding run, every printed `(title, body-H1, files-in-scope)` triple matches. A failure here means the emit step has regressed back to two index-aligned passes (the #997–#1004 drift); the single render-then-create loop in Step 3 is what guarantees the match.
- **Scope section present (issue #1077).** Every emitted issue body carries a section headed exactly `## Files in scope` listing the single target path. This is the heading `scope-check` matches (`/Files in scope/i`, read live from the linked issue body) and the canonical heading `hydra-prd-render.ts` emits — so a `hydra-dev` pickup can copy it straight into the PR body instead of hand-authoring it from the design-concept artifact.
- Re-running `--apply` against an already-saturated board (> 10 open `cleanup-scan`) emits nothing and prints the saturation skip.
- Re-running `--apply` does not double-file a finding that already has an open `cleanup-scan` issue — whether that issue is a legacy single (identity in the title) or a batch (identities in the body's `cleanup-identities` manifest, issue #1653).
- **Batched emit (issue #1653).** Findings sharing a module dir (top-2 path segments of the containing directory) land in ONE issue with a per-symbol checklist, each line leading with its demote/delete verdict; groups over 20 findings split into chunks — sorted (path, name) within each kind, every chunk title of the split carrying an ` [i/k]` suffix; `EMIT_CAP` counts batch issues; whole-file batches rank first. Every batch body carries `## Files in scope` (each distinct path) and the `cleanup-identities` manifest. An unsplit 1-finding group keeps the legacy single-finding format. Pinned in `test/hydra-cleanup-emit.test.mts` + `test/hydra-cleanup-render.test.mts`.
- **Deterministic emit runner — no hand-built titles, demote-vs-delete classified (issue #1449).** The dry-run prints the plan via `npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json`: for every planned issue the title (from `renderTitle()`) and the body H1 (from `renderBody()`) name the same symbol — they cannot diverge because both come from the same finding in one pass, so the #1421–#1426 blank-title regression (body H1 carried the symbol, the hand-built title did not) is structurally impossible. Each export finding additionally carries a `[fix: demote|delete]` verdict: an export still referenced within its own file (a `z.infer<typeof X>` alias, a sibling-schema composition like `IdleBlockedBySchema` in `src/schemas/autopilot-idle.ts`) is classified `demote` and its body leads with "Recommended fix: demote (drop the `export` keyword) — NOT delete", never inviting a build-breaking deletion. Pinned in `test/hydra-cleanup-emit.test.mts`.
- **knip false-positive taxonomy present (issue #1299).** Step 2.5 carries a four-case table — (a) truly dead → delete, (b) internally referenced → demote `export`, (c) re-export with live definition → drop only the re-export line, (d) coupled Redis key generator → atomic removal of the generator(s) + their test assertions under scope-justification — each with a classification probe and an evidence anchor, so a `hydra-dev` pickup classifies the finding instead of re-deriving the disambiguation. A finding that turns `npm test`/`tsc` red after a delete is a knip false positive and routes to the demote/drop-re-export fix, never a forced deletion.
- **Namespace-import / DI-facade false positives suppressed (issue #1737).** A module consumed anywhere in `src/` or `scripts/` via `import * as` (e.g. `src/redis/recommendations.ts`, held live by `src/autopilot/recommendation-engine.ts` and `src/api/now-recommendations.ts` through `deps.x ?? defaultX` facades) yields **zero export-kind issues** — re-running the pipeline over the #1724 evidence emits nothing for that module while its namespace consumers exist. Every suppressed finding appears in the dropped audit list with the `namespace-import / DI-facade` reason. File-kind findings for the same module still emit. Pinned in `test/hydra-cleanup-emit.test.mts`.
- **In-flight / just-merged sibling fixes suppress re-filing (issue #1766).** Replaying the 2026-06-11 incident — a knip report still listing findings whose fix PRs #1719/#1720/#1722/#1723/#1743 were open or had merged within the trailing 24h window at scan time — emits **zero** of the covered findings; each suppression appears in the dropped audit list as `covered by open PR #N` / `covered by recently-merged PR #N (merged <iso>)` naming the intersecting path. An emit run whose `gh` PR fetch fails aborts (exit 1) instead of emitting with the PR dedup silently disabled, and a knip report older than 60 minutes is refused with a re-run instruction. Pinned in `test/hydra-cleanup-emit.test.mts` + `test/hydra-cleanup-render.test.mts`.
- **No blank-title / double-file drafts (issue #1167).** Every emitted issue has a fully-formed title with the symbol name present — `validateFinding()` drops any finding with an empty name/path before render, and `renderTitle()`/`renderBody()` throw on an invalid finding, so the malformed `cleanup: remove unused export  (…)` / `cleanup: remove unused file ` drafts (run ef0a9847, #1151–#1158) are impossible. Re-running the parse → validate → dedup pipeline against the board it just filled emits **zero** new issues, because `dedupAgainstOpen()` keys on the stable `path::symbol` identity (not the title) and so recognises the canonical issues as duplicates. Pinned in `test/hydra-cleanup-render.test.mts`.
- **Deterministic emit runner kills the #1167 regression (issue #1449).** The emit is `npx tsx scripts/ci/hydra-cleanup-emit.ts` — a single pass that renders the title from `renderTitle()` and the body from `renderBody()` on the **same** finding, so the model can never hand-build a title that drifts from the body (the #1421–#1426 blank titles, where the body H1 named the symbol but the title was blank). The runner also classifies each export demote-vs-delete from the symbol's own source (`classifyExportFix()`): an export still referenced within its own file (a `z.infer<typeof X>` alias, a sibling-schema composition) is stamped `demote` and the body leads with a "drop the `export` keyword — NOT delete" banner. Pinned in `test/hydra-cleanup-emit.test.mts`.

## Files

- `docs/operator-playbooks/hydra-cleanup.md` — this playbook (source of truth; the skill is generated by `scripts/sync-skills.sh`).
- `scripts/ci/hydra-cleanup-render.ts` — pure parse → validate → classify → render → dedup helpers (issues #1167, #1449, #1653, #1766): `parseKnipReport`, `validateFinding`, `findingIdentity`, `classifyExportFix`, `renderTitle`, `renderBody`, `identityFromOpenIssueTitle`, `identitiesFromIssueBody`, `dedupAgainstOpen` (optionally takes covering-PR refs and returns PR-covered findings separately, #1766), `moduleDirKey`, `renderBatchTitle`, `renderBatchBody`. The deterministic seam the emit runner calls.
- `scripts/ci/hydra-cleanup-emit.ts` — the deterministic emit runner (issues #1449, #1653, #1737, #1766): `planCleanupEmit()` (pure: parse → validate → filter → classify → dedup → group-by-module → render) plus the thin `gh` CLI wrapper. Replaces the hand-rolled bash emit loop that regressed #1167; batches per module dir since #1653 (`SYMBOLS_PER_BATCH = 20`, `EMIT_CAP` counts batch issues); since #1737 the wrapper injects the namespace-import consumer set (`collectNamespaceConsumedModules()` + pure `resolveNamespaceImportTargets()`) so the step-1 filter drops the DI-facade export false positives with an audit reason; since #1766 the wrapper injects the covering-PR surface (`readCoveringPrs()` via REST + pure `filterPrsInDedupWindow()`, `MERGED_PR_DEDUP_WINDOW_MS = 24h`), aborts on a failed PR fetch, and refuses a knip report older than `KNIP_REPORT_MAX_AGE_MS` (60 min).
- `test/hydra-cleanup-render.test.mts` — regression for the #1167 blank-title + double-file failure, the #1449 demote/delete recommendation banner, the #1653 batch rendering + manifest dedup (no malformed titles; identity-keyed dedup across legacy titles AND batch manifests; re-run files nothing), and the #1766 covering-PR path dedup (attributable prCovered bucket, identity-dedup precedence, two-arg backward compat).
- `test/hydra-cleanup-emit.test.mts` — regression for the #1449/#1653/#1737/#1766 emit runner: title/body coherence (no hand-built title), deterministic demote-vs-delete classification, filter/dedup, module-dir grouping, chunking, batch-cap, ranking, recurrence, full-backlog coverage, the namespace-import facade suppression (audited drops, file-kind untouched, #1724 acceptance scenario), and the covering-PR dedup replay of the 2026-06-11 dup wave (zero covered findings emitted, audited per-PR reasons, 24h window filtering).
- `package.json` — `knip` is the devDependency this skill invokes (`npx knip`).
- `scripts/autopilot/decide.py` — the `cleanup_orch` signal class + selector that dispatches this skill.
- `scripts/autopilot/collect-state.sh` — emits `cleanup_board_saturated` (the anti-flood cap).
- `docs/operator-playbooks/hydra-autopilot.md` — the `cleanup_orch` class-taxonomy + signal-wiring entry.

## Tier

Tier 3 (ships as a new operator playbook + autopilot wiring in `scripts/autopilot/`; no Verifier Core change, `knip` is a devDependency not a runtime dep). The PR body carries the live tier classifier's verdict; this footer is informational. The issues this skill later *emits* are each picked up under the normal tier gate, and the deletion only merges if `npm test` / `tsc` stay green.
