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
- **Against the Target (`~/hydra-betting`).** This skill is **Orchestrator-scoped** (`~/hydra`) by design. A target-scoped cleanup would be a separate skill (and is blocked on the Target PR merge backlog, #718).

## Inputs

| Input | Source | Notes |
|---|---|---|
| `apply` (positional / `--apply`) | Operator or autopilot dispatch | Dry-run by default. `--apply` (or `apply=true`) actually creates issues on `gaberoo322/hydra`. A dry-run is always safe — it prints the findings and the rendered issue bodies and stops. |
| Scan surface | Implicit | Always the **Orchestrator** repo at `~/hydra`. Not parameterised. |
| Open-issue board | `gh issue list` | Read before emitting, for the board-saturation back-stop and the duplicate filter. |

## Process

One pass: detect → filter → emit → report, then exit. The skill does not poll, retry, or watch.

### 0. Board-saturation back-stop (read before doing any work)

```bash
OPEN_CLEANUP=$(gh issue list --repo gaberoo322/hydra --state open --label cleanup-scan --json number --jq 'length' 2>/dev/null || echo 0)
```

If `OPEN_CLEANUP > 10`, print the board-saturation skip and exit (emit nothing). Otherwise continue.

### 1. Detect (deterministic — knip)

Run `knip` over the Orchestrator. `knip` reports unused files, unused exports, unused exported types, and unused dependencies. We scope the run to the highest-confidence categories (unused files + unused exports/types) and emit machine-readable JSON:

```bash
npx knip --reporter json --no-exit-code > /tmp/knip-report.json 2>/dev/null || true
```

`--no-exit-code` keeps the analyser's non-zero "findings exist" exit from aborting the skill; the JSON report is the source of truth. If `knip` is not installed (`npx` fails), print a one-line install hint (`npm ci` to pull the devDependency) and exit cleanly — do NOT fall back to a heuristic scan.

Parse the report's `files` (provably-unused whole files) and `issues[].exports` / `issues[].types` (provably-unused named exports within a still-used file). These two categories are the **deterministic** findings. Ignore `knip`'s softer categories (unlisted/unresolved dependencies, duplicate exports) for issue emission — note them in the report only.

### 2. Filter (keep the findings high-confidence)

Drop a finding before it becomes an issue when ANY of:

- **It touches the Verifier Core** (`src/untouchable.ts` `VERIFIER_CORE_PATHS`: `ci.yml`, `deploy.yml`, `scripts/tier-classify.ts`, `src/tier-classifier.ts`, `src/untouchable.ts`). Those are operator-only (ADR-0001/0004/0015). Never steer an agent at them. Note the finding in the report, but do not file it.
- **It is a test file, a type-only `.d.ts`, or a file `knip` flags only because its sole consumers are tests** — deleting a test or a test-only export is a coverage regression, not a cleanup. The acceptance check (`npm test` still passes) would pass trivially while silently removing a test; exclude these.
- **It is a public entrypoint by configuration** — `src/index.ts`, an export re-exported through a barrel that IS imported elsewhere, or anything `knip` lists under `production`-entry ambiguity. When in doubt, drop it: a false-positive deletion that breaks a runtime path is worse than a missed cleanup.
- **It duplicates an already-open `cleanup-scan` issue** (title/path match against the board read in step 0). Re-filing the same finding every idle tick is the exact churn the saturation cap and this dedup guard prevent.

> **Quota:** aim for the highest-confidence findings first. If `knip` reports more than ~8 survivors, file the top 8 (whole-file deletions rank above single-export deletions — they reclaim the most surface) and note the remainder in the report; the next idle turn picks up where this one left off (the dedup filter ensures no double-filing).

### 3. Emit issues (labelled `ready-for-agent` + `cleanup-scan`)

Each surviving finding becomes one GitHub issue. Use `gh issue create` directly (these are independent single-finding tickets, so the `hydra-prd` epic path is unnecessary).

**Emit as a SINGLE loop over the filtered findings — one finding at a time, render-then-create atomically (HARD).** For each finding: derive its title, its body H1, AND its `## Files in scope` path from the **same finding object** inside the same iteration, then immediately call `gh issue create` with both `--title` and `--body-file` built from that one finding, *before advancing to the next finding*. The `## Files in scope` path is the same target path the title names, rendered from the one `$finding` — so the scoped file can never drift from the issue title or the body H1. Never build a list of all titles in one pass and a list of all body files in a second pass and then zip the two by index — that index-aligned parallel-array pattern is exactly what produced the off-by-one title/body rotation across the #997–#1004 batch (issue #1005), where `title[i]` was paired with `body[i+1]`. There is no second pass and no shared running counter linking two separate lists: the title and body for a given issue are produced and consumed together within one iteration, so they cannot drift.

If you stage the body to a temp file, name it by the finding's **stable identity** (a slug of its `<name / path>`), e.g. `/tmp/cleanup-issue-$slug.md`, NOT by a running counter shared with a separate title loop. The slug binds the body file to the same finding the title is derived from.

Issue body schema (one per finding):

```markdown
# cleanup: remove unused <export|file> `<name / path>`

> Surfaced by `/hydra-cleanup` on <ISO date> against the Orchestrator (~/hydra).
> Deterministic detection via `knip` (devDependency). High-confidence mechanical cleanup.

## Finding

`knip` reports `<path>` (or the named export `<name>` in `<path>`) as **provably unused** — it has no remaining references in the orchestrator codebase.

## What to do

Remove the unused <file / export> and any now-orphaned imports it leaves behind.

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

**Labelling rule (HARD):** every emitted issue carries `cleanup-scan` and `ready-for-agent`. The `cleanup-scan` label is the emit/count seam that `collect-state.sh` reads for `cleanup_board_saturated`, so it MUST be present on every issue. Routing to `ready-for-agent` (NOT `needs-triage`) is the deliberate confidence-routing decision (epic #958): the acceptance criterion is self-checking, so no operator triage gate is needed — a `hydra-dev` pickup will only merge if the deletion keeps `npm test` and `tsc` green, and CI is the merge gate.

```bash
# Single loop over the filtered findings — render THIS finding's body and create
# THIS finding's issue together, before moving on. Title, body H1, and the
# `## Files in scope` path are all derived from the one $finding object, so they
# cannot drift (no parallel title/body lists).
for finding in "${findings[@]}"; do
  title=$(render_title "$finding")          # e.g. "cleanup: remove unused export `foo` (src/bar.ts)"
  slug=$(slugify "$finding")                # stable identity, NOT a running counter
  body_file="/tmp/cleanup-issue-$slug.md"
  render_body "$finding" > "$body_file"     # body H1 + `## Files in scope` from the SAME $finding
  gh issue create --repo gaberoo322/hydra \
    --title "$title" \
    --label cleanup-scan --label ready-for-agent \
    --body-file "$body_file"
done
```

### 4. Report (deterministic summary)

Print a single-pass summary — this is the operator's audit surface:

```
hydra-cleanup — Orchestrator (~/hydra) — 2026-06-03T12:00:00Z — apply

knip findings:        12 unused (4 files, 8 exports)
After filter (verifier-core/test-only/entrypoint/dup):  6
Emitted:              6 issues  [ready-for-agent, cleanup-scan]  (#NNN ... #NNN)
Dropped:              6  (2 verifier-core, 3 test-only, 1 duplicate of open #NNN)
Board saturation:     ok (3 open cleanup-scan issues, under the 10 cap)
```

In dry-run mode the header reads `(dry-run; no GitHub issues created)` and the emitted line shows the rendered bodies instead of issue numbers.

## Rules

- **Zero `AskUserQuestion`.** Present findings into issue bodies and stop.
- **Deterministic detection only.** The findings are `knip`'s output, not the model's guess. Never file a "this looks unused" finding that the tool didn't report.
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

- `knip` runs and the report parses; findings are categorised into files vs exports.
- The filter drops verifier-core, test-only, entrypoint, and duplicate findings.
- `--apply` files issues labelled `cleanup-scan` + `ready-for-agent` — each with the deterministic "remove X AND test/tsc green" acceptance criterion.
- **Title/body pairing (multi-finding regression, issue #1005).** Run the dry-run (or `--apply`) over a scenario with **≥2 findings** and assert that, for **every** emitted issue, the body's H1 (`# cleanup: remove unused <export|file> \`<name / path>\``) AND its `## Files in scope` path name the **same** target as that issue's title — no off-by-one, no rotation across the batch. The dry-run already prints both the title and the rendered body for each finding, so the check is: in a multi-finding run, every printed `(title, body-H1, files-in-scope)` triple matches. A failure here means the emit step has regressed back to two index-aligned passes (the #997–#1004 drift); the single render-then-create loop in Step 3 is what guarantees the match.
- **Scope section present (issue #1077).** Every emitted issue body carries a section headed exactly `## Files in scope` listing the single target path. This is the heading `scope-check` matches (`/Files in scope/i`, read live from the linked issue body) and the canonical heading `hydra-prd-render.ts` emits — so a `hydra-dev` pickup can copy it straight into the PR body instead of hand-authoring it from the design-concept artifact.
- Re-running `--apply` against an already-saturated board (> 10 open `cleanup-scan`) emits nothing and prints the saturation skip.
- Re-running `--apply` does not double-file a finding that already has an open `cleanup-scan` issue.

## Files

- `docs/operator-playbooks/hydra-cleanup.md` — this playbook (source of truth; the skill is generated by `scripts/sync-skills.sh`).
- `package.json` — `knip` is the devDependency this skill invokes (`npx knip`).
- `scripts/autopilot/decide.py` — the `cleanup_orch` signal class + selector that dispatches this skill.
- `scripts/autopilot/collect-state.sh` — emits `cleanup_board_saturated` (the anti-flood cap).
- `docs/operator-playbooks/hydra-autopilot.md` — the `cleanup_orch` class-taxonomy + signal-wiring entry.

## Tier

Tier 3 (ships as a new operator playbook + autopilot wiring in `scripts/autopilot/`; no Verifier Core change, `knip` is a devDependency not a runtime dep). The PR body carries the live tier classifier's verdict; this footer is informational. The issues this skill later *emits* are each picked up under the normal tier gate, and the deletion only merges if `npm test` / `tsc` stay green.
