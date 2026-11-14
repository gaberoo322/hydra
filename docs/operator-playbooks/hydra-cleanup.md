---
name: hydra-cleanup
description: Non-interactive deterministic dead-code + simplification detector. Runs a static-analysis tool (knip) over the Orchestrator to find provably-unused exports/files, then files high-confidence findings as ready-for-agent GitHub issues whose acceptance criterion is "remove X AND npm test/tsc still pass". Dry-run by default; --apply creates issues. Zero AskUserQuestion.
when_to_use: "When the Orchestrator board is idle, or the operator says 'cleanup scan' or 'find dead code'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
arguments: [apply]
---

# Hydra Cleanup (headless dead-code / simplification scan)

`hydra-cleanup` is a non-interactive, deterministic dead-code detector for the Orchestrator (`~/hydra`). It runs `knip`, filters the report to high-confidence mechanical findings, and files each module batch as a GitHub issue on `gaberoo322/hydra` whose acceptance check is self-verifying: remove X AND `npm test` / `tsc` still pass.

It is the mechanical half of the idle-backfill confidence gate; the judgment half is `hydra-architecture-scan`.

| Confidence | Meaning | Label |
|---|---|---|
| Mechanical | Acceptance is deterministic (a green suite proves the deletion). | `ready-for-agent` |
| Judgment | Correctness is an opinion (deep-module reorganisation, debatable seams). | `needs-triage` |

A deep-module reorganisation is never auto-routed to `ready-for-agent`. Every finding this skill emits is mechanical, so it routes to `ready-for-agent`.

## What this skill is NOT

- Not a code-writer: it never edits `src/` or opens a PR. A later `hydra-dev` pickup does the deletion.
- Not interactive: zero `AskUserQuestion`.
- Not a judgment pass: findings are what `knip` reports, never what the model thinks looks dead.
- Not the autopilot wiring: the `cleanup_orch` class and the `cleanup_board_saturated` signal are documented in `docs/operator-playbooks/hydra-autopilot.md`.

## When NOT to run

- The board already holds more than 10 open `cleanup-scan` issues (`CLEANUP_BOARD_SATURATION_CAP`): emit nothing and print a saturation skip.
- From inside a `dev_orch` / `dev_target` subagent: those work one issue and must not produce sibling work.
- Against the Target: this skill is Orchestrator-scoped; the Target sweep is `/hydra-target-cleanup`.

## Inputs

| Input | Notes |
|---|---|
| `apply` (positional / `--apply`) | Dry-run by default; `--apply` files issues. |
| Scan surface | Always `~/hydra`. |

## Process

One pass: detect, filter, emit, report, then exit. No polling.

### 0. Board-saturation back-stop

```bash
gh issue list --repo gaberoo322/hydra --state open --label cleanup-scan --json number --jq 'length'
```

Above 10, print the saturation skip and exit.

### 1. Detect

Scan the current `origin/master`, never the inherited worktree base: a stale base reports exports an in-flight wave already removed. Abort on either failure rather than scan a stale or diverged tree.

```bash
git fetch origin master \
  || { echo "hydra-cleanup: fetch origin/master failed - aborting"; exit 1; }
git merge --ff-only origin/master \
  || { echo "hydra-cleanup: worktree not fast-forwardable onto origin/master - aborting"; exit 1; }
npx knip --reporter json --no-exit-code > /tmp/knip-report.json 2>/dev/null || true
```

If `knip` is not installed, print an `npm ci` hint and exit; never fall back to a heuristic scan. The emit runner refuses a report older than 60 minutes (`KNIP_REPORT_MAX_AGE_MS`), so always run `knip` fresh in the same pass.

Only unused files and unused exports/types become issues; note the softer categories in the report only.

### 2. Filter

The emit runner `scripts/ci/hydra-cleanup-emit.ts` owns parse, validate, filter, classify, dedup, group and render. It drops a finding when any of these holds:

- It has an empty name or path (`validateFinding()`), so a blank-title issue cannot be filed.
- It touches the Verifier Core (`VERIFIER_CORE_PATHS` in `src/untouchable.ts`): operator-only. Note it in the report.
- It is a test file, a `.d.ts`, or flagged only because its sole consumers are tests: deleting it is a coverage regression.
- It is a public entrypoint by configuration (`src/index.ts`, a barrel that is imported elsewhere). When in doubt, drop it.
- It is an export of a module consumed through `import * as ns` (the DI-facade false positive). The drop is per module, audited, and file-kind findings are unaffected.
- A PR open now, or merged in the last 24h (`MERGED_PR_DEDUP_WINDOW_MS`), changed its path. A failed PR fetch aborts the emit.
- Its `path::symbol` identity is already open as a `cleanup-scan` issue (legacy title or batch manifest), or repeats within the run.

Every drop appears in the report with its reason, never silently. The per-run cap is `EMIT_CAP = 8` batch issues; the next idle turn picks up the remainder.

### 2.5 "Remove unused export" is three outcomes

`knip` says only that no other module imports the symbol. Each issue states a pre-computed verdict so the picking agent does not re-derive it:

| Outcome | Premise | Action |
|---|---|---|
| Delete | Truly dead; the flagged line is the definition. | Delete it and any imports that only referenced it. |
| Demote | Still referenced inside its own file. | Drop only `export`. Never delete. |
| Fix at the relay | The flagged line is a re-export (`from` clause); the definition is live elsewhere. | Remove only the re-export line. |

`classifyExportFix()` decides delete vs demote from the symbol's own file; an undecidable case is labelled `unknown`, never silently "delete". A coupled Redis key generator (generator plus its `test/redis-keys.test.mts` assertions) is removed as one atomic set under a `scope-justification:` block.

The picking agent confirms the verdict with a probe. Use `grep -rnw`, not `rg -w`: the host `rg` shim silently ignores `-w`. A multi-line import defeats line-scoped grep, so the compiler is the proof: confirm the removal with `npm run typecheck:test` before stamping a symbol dead. If `npm test` or `tsc` goes red after a delete, revert to demote or drop-the-re-export.

```bash
grep -rnw "<name>" src test | grep -v "<path>"
grep -rnE "export .*\b<name>\b" "<path>"
grep -rn "<name>" src/redis test/redis-keys.test.mts
```

### 3. Emit

```bash
# Dry-run: prints every title, body and verdict, files nothing.
npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json
# Apply: files one batch issue per module dir.
npx tsx scripts/ci/hydra-cleanup-emit.ts /tmp/knip-report.json --apply
```

Never drive `gh issue create` from a hand-written loop: title and body must render from the same finding in one pass. Run the dry-run to see the real issue body; `scripts/ci/hydra-cleanup-render.ts` is its single home, pinned by `test/hydra-cleanup-render.test.mts`.

The unit of work is one module batch (`moduleDirKey()`, `SYMBOLS_PER_BATCH = 20`). Each issue carries a per-symbol checklist, a `## Files in scope` section and a `cleanup-identities` manifest used for dedup.

**Labels (every issue):** `cleanup-scan`, `ready-for-agent`, `design-concept-exempt`. `cleanup-scan` is the count seam for `cleanup_board_saturated` and the exemption key read by `hydra-qa`, the grill gate and the GLM drainer; `design-concept-exempt` is kept for the readers that still key on it.

### 4. Report

```
hydra-cleanup - Orchestrator (~/hydra) - <ISO timestamp> - apply
knip findings:        <n> unused (<f> files, <e> exports)
After filter:         <n>
Emitted:              <k> batch issues covering <n> findings  (#NNN ...)
Dropped:              <n>  (<reasons>)
Board saturation:     ok (<n> open cleanup-scan issues, under the 10 cap)
```

A dry-run header reads `(dry-run; no GitHub issues created)` and shows rendered bodies instead of issue numbers.

## Rules

- Zero `AskUserQuestion`; dry-run by default; one pass.
- Deterministic detection only: never file a finding `knip` did not report.
- Scan current `origin/master`; abort on a failed fetch or a non-fast-forwardable worktree.
- Never steer at the Verifier Core; never delete tests or test-only exports.
- Acceptance is always "remove X AND `npm test` / `tsc` still pass".
- `knip` is a devDependency; the service never imports it (ADR-0005 governs runtime deps only).

## Files

- `scripts/ci/hydra-cleanup-render.ts`: pure parse, validate, classify, render and dedup helpers.
- `scripts/ci/hydra-cleanup-emit.ts`: the emit runner (`planCleanupEmit()` plus the `gh` wrapper).
- `scripts/ci/hydra-knip-source.ts`: shared knip-report loader with the staleness guard.
- `test/hydra-cleanup-render.test.mts`, `test/hydra-cleanup-emit.test.mts`: regression suites.
- `scripts/autopilot/decide.py`: the `cleanup_orch` selector that dispatches this skill.

## Tier

Tier 3. The issues this skill emits are picked up under the normal tier gate; a deletion merges only if `npm test` / `tsc` stay green.
