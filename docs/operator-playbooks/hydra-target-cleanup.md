---
name: hydra-target-cleanup
description: Non-interactive deterministic dead-code pass over the Target (~/hydra-betting/web), in two phases. Phase 1 (mechanical): knip-driven demote-only dead-export sweep — one ready-for-agent backlog item per file whose acceptance criterion is "drop the export keyword AND npm test/typecheck/deadcode:check still pass with a tightened baseline". Phase 2 (judgment): reads the Target's wiring-status ledger and files needs-triage wire-or-retire decision items for modules past the grace period. Dry-run by default; --apply files backlog items. Zero AskUserQuestion.
when_to_use: "When the Target backlog is idle and the autopilot wants to turn spare capacity into high-confidence dead-code hygiene on hydra-betting, or when the operator says 'target cleanup scan', '/hydra-target-cleanup', or 'sweep target dead code'. Dispatched by the autopilot `cleanup_target` signal class on the `target_backfill_idle` signal, suppressed first by `target_cleanup_board_saturated`."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
arguments: [apply]
claude_only: true
---

# Hydra Target Cleanup (headless demote-only dead-export sweep)

`hydra-target-cleanup` is the **Target mirror of `/hydra-cleanup`**: a non-interactive, deterministic dead-code detector for **`~/hydra-betting`**. It runs `knip` over `web/`, filters the findings down to the **demote-only** class the Target's own policy authorises, and files each surviving file as a Redis backlog item (the Target's tracker — NOT GitHub issues) whose acceptance criterion is self-checking: *"drop the `export` keyword AND `npm test` / `npm run typecheck` / `npm run deadcode:check` still pass with a tightened baseline"*.

It is **step 2 of the Target dead-code cleanup plan** (step 1 — the deadcode ratchet + CLAUDE.md policy — shipped as hydra-betting PR #93). The Target accumulates dead exports structurally: Hydra builds modules with tests first and wires them into runtime later, so knip-with-tests-as-usage findings (~440 at the 2026-06-10 baseline) are the high-confidence, mechanically-verifiable backlog this skill drains.

## How this differs from `/hydra-cleanup` (the orch sweep)

| | `/hydra-cleanup` (orch) | `/hydra-target-cleanup` (this skill) |
|---|---|---|
| Surface | `~/hydra` | `~/hydra-betting/web` |
| Findings sink | GitHub issues (`gaberoo322/hydra`) | Redis target backlog via `POST /api/backlog` (labels `cleanup-scan` + `ready-for-agent`, moved to the `queued` lane) |
| Fix classes emitted | demote AND delete (classified per finding) | **demote ONLY** — delete-class and whole-file findings are dropped and deferred to the wire-or-retire phase |
| Grace period | none | **45-day wiring grace** (Target CLAUDE.md rule 3): findings in files touched within 45 days are dropped — young dead exports are usually wiring-in-flight |
| Item granularity | one issue per finding | **one backlog item per FILE** (all demote-class symbols batched) — `addToBacklog()` fuzzy-title dedup rejects near-identical per-symbol titles, and the picker ships one small PR per file anyway |
| Picked up by | `hydra-dev` | `hydra-target-build` (a normal `dev_target` pickup) |

Everything else mirrors the orch sweep deliberately: deterministic detection (knip's output, never the model's guess), a deterministic emit runner (never a hand-rolled loop — the #1449 lesson), an identity-keyed dedup against the open board, a per-run cap, and a saturation back-stop.

## Why demote-only is safe (and the Target policy that gates it)

The Target's `CLAUDE.md` forbids ad-hoc cleanup commits, with one carve-out (rule 3): a cleanup commit citing a `npm run deadcode` finding, in code untouched for 45+ days, scoped to the finding — and `src/lib/providers/` is **demote-only** (rule 1 forbids deleting provider files, not demoting visibility). This skill emits only work that satisfies the carve-out by construction:

- `classifyExportFix()` (shared with the orch sweep) keeps a finding only when the symbol is **still referenced within its own file** — so dropping the `export` keyword compiles by construction and changes no behavior.
- knip runs with tests-as-usage, so an emitted symbol has **no importer anywhere, not even a test** — demoting it cannot break the suite.
- The Target's deadcode ratchet (`npm run deadcode:check`, CI-gated) pins each demote: the picked-up PR tightens `web/deadcode-baseline.json`, so the improvement is locked in.

## What this skill is NOT

- **NOT a code-writer.** It never edits the Target, never opens a PR. The actual demote is a later `hydra-target-build` pickup of the backlog item it files.
- **NOT a deleter.** It emits zero deletions — not of exports, not of files, not in `src/lib/providers/`, not anywhere. Delete-class export findings are counted in the report and deferred; module-level retirements only ever happen downstream of a wire-or-retire decision item that triage explicitly resolved to RETIRE (and `ready-for-human` when intent is unclear).
- **NOT interactive.** Zero `AskUserQuestion` calls.
- **NOT a heuristic pass.** Findings are whatever `knip` reports; the classification is `classifyExportFix()` on the symbol's own source. Never file a "this looks dead" finding the tool didn't report.

## When NOT to run this

- **Board saturated**: more than 10 open backlog items carrying the `cleanup-scan` label (any lane except `done`). The emit runner checks this itself; the autopilot's `target_cleanup_board_saturated` signal suppresses the dispatch upstream.
- **From inside a `dev_orch` / `dev_target` subagent** — those work a single item and must not produce sibling work.
- **When the orchestrator API (port 4000) is down** — the runner aborts rather than emit without dedup/saturation inputs (fail closed).

## Process

One pass: detect → filter → emit → report, then exit.

### 1. Detect (deterministic — knip in the Target)

Sync the scan base to current Target `main` first (the #1318 stale-base lesson, applied to the Target):

```bash
cd /home/gabe/hydra-betting \
  && git fetch origin main \
  || { echo "hydra-target-cleanup: fetch origin/main failed — aborting (cannot guarantee a current scan base)"; exit 1; }
git -C /home/gabe/hydra-betting merge-base --is-ancestor origin/main HEAD \
  || git -C /home/gabe/hydra-betting merge --ff-only origin/main \
  || { echo "hydra-target-cleanup: working tree not fast-forwardable onto origin/main — aborting (stale/diverged base)"; exit 1; }
```

Then run knip in the Target web workspace (knip is a Target devDependency since PR #93; `web/knip.json` is the committed config):

```bash
cd /home/gabe/hydra-betting/web \
  && npx knip --reporter json --no-exit-code > /tmp/knip-target-report.json 2>/dev/null || true
```

If knip is not installed, print a one-line hint (`npm ci` in `web/`) and exit cleanly — do NOT fall back to a heuristic scan.

### 2–3. Filter + emit — run the deterministic runner, do NOT hand-roll a loop

```bash
# Dry-run (prints the plan: every title + body + drop reasons, files nothing):
npx tsx scripts/ci/hydra-target-cleanup-emit.ts /tmp/knip-target-report.json

# Apply (files one cleanup-scan + ready-for-agent backlog item per file, moved to queued):
npx tsx scripts/ci/hydra-target-cleanup-emit.ts /tmp/knip-target-report.json --apply
```

The runner (`planTargetCleanupEmit()`, pure + tested) owns the whole pipeline:

1. **Validate** (blank-title guard, shared `validateFinding()`).
2. **Demote-only filter**: whole-file findings, test/`.d.ts` paths, delete-class exports (no in-file reference), and unknown-source findings are all dropped. Only `classifyExportFix() === "demote"` survives.
3. **Wiring-grace gate**: file age from `git log -1 --format=%ct` in the Target; `< 45` days → dropped; unknown age → dropped (fail closed).
4. **Group per file**, dedup per file against the open `cleanup-scan` board (identity = the path parsed from the canonical title), cap at 8 files per run, largest demote batch first.
5. **Render** title + body from the same group in one pass (the #1449/#1005 drift guard) and file via `POST /api/backlog` + move to `queued`.

Every emitted item carries labels **`cleanup-scan` + `ready-for-agent`** (the label is the saturation/dedup count seam; the routing is the confidence decision — the acceptance check is deterministic, so no triage gate is needed) and instructs the picker to: demote each listed symbol, run `npm test` + `npm run typecheck`, run `npm run deadcode:update-baseline`, and commit with the scan citation the Target's CLAUDE.md rule 3 requires.

### 3.5 Wire-or-retire decision items (the judgment phase — step 4 of the plan)

After the demote emit, run the second deterministic emitter. Its input is the Target's **committed wiring-status ledger** (`docs/agents/wiring-status.md`, generated Target-side by `npm run deadcode:ledger` — hydra-betting PR #98). Never regenerate the ledger from this skill: the scan must not mutate the Target's working tree; staleness is handled by each item's verify-first step plus dedup.

```bash
# Dry-run (prints the plan, files nothing):
npx tsx scripts/ci/hydra-target-wire-or-retire-emit.ts

# Apply (files one needs-triage decision item per module, moved to the triage lane):
npx tsx scripts/ci/hydra-target-wire-or-retire-emit.ts --apply
```

The runner (`planWireOrRetireEmit()`, pure + tested) keeps only ledger rows with status `wire-or-retire` (modules past the 45-day grace with no runtime importer — `awaiting-wiring` and `protected-provider` rows are never eligible), dedups per module against open `wire-or-retire`-labelled items, caps at **3 per run** (oldest last-touched first; saturation back-stop at 5 open items), and renders title + body from the same row.

**Confidence routing — this is the judgment half of the gate.** Where a demote is mechanically verifiable (→ `ready-for-agent`), wire-vs-retire is an *opinion*: the module was built with intent that either stalled or died, and deciding which requires recovering that intent. So these items route to **`needs-triage`** (the `triage` lane), mirroring how `hydra-architecture-scan` routes judgment candidates on the orch side. The item body carries the three-way decision protocol for the sweep agent or operator: **(a) WIRE** — intent live → rewrite into a concrete ready-for-agent wiring task; **(b) RETIRE** — intent gone → rewrite into a ready-for-agent retirement task citing the scan (Target CLAUDE.md rule 3); **(c) UNCLEAR** — route to `ready-for-human` and stop. **Ambiguity never resolves to deletion** (rule 6); nothing is deleted while an item sits in triage.

### 4. Report

```
hydra-target-cleanup-emit — Target (~/hydra-betting/web) — <ISO> — apply
knip raw findings:   441
After filter+dedup:  8 file-items to emit (cap 8)
Dropped findings:    433
• cleanup(target): demote `PolymarketWsStats` +6 more in src/lib/providers/polymarket-ws/client.ts  [7 demote(s), file 51d old]
...
dropped 210: delete-class (no in-file reference) — deferred to wire-or-retire
dropped 180: within the 45-day wiring grace period (...)
```

## Rules

- **Zero `AskUserQuestion`.**
- **Demote-only.** This skill never emits a deletion of any kind. `src/lib/providers/` is demote-only by Target rule 1; this sweep treats the whole Target that way.
- **45-day wiring grace, fail closed.** Young files and unknown-age files are never swept.
- **Deterministic detection + emit.** knip's report through the tested runner — never a hand-rolled loop, never a model guess.
- **Backlog, not GitHub.** The Target's tracker is the Redis backlog; items go through `POST /api/backlog` and the `queued` lane.
- **Saturation back-stop**: emit nothing above 10 open `cleanup-scan` items. **Dedup per file** against the open board.
- **Dry-run default.** Only `--apply` files items. **One pass**, then exit.

## Manual smoke test

```bash
/hydra-target-cleanup            # dry-run: runs knip in the Target, prints the plan
/hydra-target-cleanup --apply    # files ready-for-agent backlog items
```

Expected: demote-class findings batch one-item-per-file with the symbol-led title; delete-class/whole-file/young/unknown findings appear only in the drop summary; re-running `--apply` files nothing new for paths already open (file-keyed dedup, plus `addToBacklog`'s exact-title dedup as belt-and-braces); a saturated board (>10 open `cleanup-scan` items) emits nothing. Pinned in `test/hydra-target-cleanup-emit.test.mts`.

## Files

- `docs/operator-playbooks/hydra-target-cleanup.md` — this playbook (source of truth; the skill is generated by `scripts/sync-skills.sh`).
- `scripts/ci/hydra-target-cleanup-emit.ts` — the demote-phase emit runner: `planTargetCleanupEmit()` (pure) + the thin fs/git/API wrapper.
- `scripts/ci/hydra-target-wire-or-retire-emit.ts` — the judgment-phase emit runner: `planWireOrRetireEmit()` (pure, ledger-driven) + the thin fs/API wrapper; routes to `needs-triage`.
- `test/hydra-target-wire-or-retire-emit.test.mts` — ledger parse, eligibility (only wire-or-retire rows), dedup, cap, decision-protocol rendering, fail-closed ambiguity.
- `scripts/ci/hydra-cleanup-render.ts` — shared pure helpers (`parseKnipReport`, `validateFinding`, `classifyExportFix`).
- `test/hydra-target-cleanup-emit.test.mts` — demote-only filter, grace gate, per-file batching, dedup, cap, title/body coherence, fuzzy-dedup title diversity.
- `scripts/autopilot/decide.py` — the `cleanup_target` signal class + selector that dispatches this skill.
- `scripts/autopilot/collect-state.sh` — emits `target_backfill_idle` + `target_cleanup_board_saturated`.
- `~/hydra-betting/CLAUDE.md` — the Target policy this sweep enforces (rule 3 carve-out, rule 1 demote-only providers, the deadcode ratchet section).

## Tier

Tier 3 (autopilot wiring in `scripts/autopilot/` + a new `scripts/ci/` runner; no Verifier Core change; no runtime dependency change). The backlog items this skill emits are each picked up by `hydra-target-build` under the Target's own CI gate (test + typecheck + deadcode ratchet).
