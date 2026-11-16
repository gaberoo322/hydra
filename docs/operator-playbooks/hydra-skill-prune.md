---
name: hydra-skill-prune
description: Non-interactive skill pruner. Picks ONE generated skill per run, proposes Pocock-taxonomy deletions (duplication, sediment, no-op), validates them with the promptfoo eval (golden-task parity), and opens at most one T1/T2 PR editing only that playbook, its regenerated skill, and its tightened ratchet baseline. Dry-run by default; --apply opens the PR.
when_to_use: "When the Orchestrator board is idle, or the operator says 'skill prune' or 'prune a skill'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
arguments: [apply]
---

# Hydra Skill Prune (headless eval-gated skill deletion)

`hydra-skill-prune` is a **non-interactive, deterministic** pruner for the
**Orchestrator**'s playbook-generated skills (`docs/operator-playbooks/*.md` →
`~/.claude/skills/hydra-*/SKILL.md`). Each run picks **exactly ONE** generated
skill, proposes deletions along the **Pocock pruning taxonomy**, validates every
candidate with the **deletion test made deterministic** (the promptfoo eval
suite), and opens **at most one T1/T2 PR** editing only that one playbook (plus
its regenerated skill and its tightened ratchet baseline). It is the durable,
recurring counterpart to a one-time skill-quality cleanup: it turns pruning into
autonomous behavior rather than a manual sweep.

It deliberately **mirrors `hydra-cleanup`** (the `cleanup_orch` precedent): a
depth-first pass over one surface, a deterministic acceptance check, and a
one-pass report. The decisive difference is the *surface* — `hydra-cleanup`
prunes dead **code** (knip), `hydra-skill-prune` prunes bloated **prompts**
(Pocock taxonomy + eval parity). Both follow the operator's standing
*maintainability over throughput* priority and the 25% self-improvement floor
(ADR-0003).

Dispatched by the autopilot `skill_prune` signal class on the orchestrator
idle-backfill signal, with a **7-day cooldown** — the low-cadence calendar
discipline of `scout_orch` (the walk needs a week of accreted context to be
worth re-running). Runnable by hand: `/hydra-skill-prune [apply]`.

## Contract

- **Non-interactive.** ZERO `AskUserQuestion`. A headless dispatch must complete
  without operator input, exactly like `hydra-cleanup` / `hydra-architecture-scan`.
- **Dry-run by default.** With no `apply` argument the run prints the pruning
  report (candidates + eval verdict) and files/opens NOTHING. `--apply` (the
  autopilot maps `apply=true` → `--apply`, so a dispatched run is never a
  dry-run no-op) is what opens the PR or files the fallback issue.
- **One skill per run.** Pick exactly one generated skill and prune only it.
- **One PR per run.** At most one T1/T2 PR, editing only that skill's playbook,
  its regenerated `SKILL.md`, and its baseline entry.

## Step 1 — Pick the ONE skill to prune

Selection is **largest-over-baseline first, else round-robin**, computed by
`scripts/skill-prune/select-skill.ts` (no hand-rolled pick):

```bash
npx tsx scripts/skill-prune/select-skill.ts select   # prints the playbook name
# ... after the run (PR opened or downgrade issue filed):
npx tsx scripts/skill-prune/select-skill.ts stamp <playbook-name>
```

It compares each playbook body against `scripts/ci/skill-size-baseline.json`,
picks the largest over-baseline delta, else the least-recently-pruned playbook
from its rotation ledger (alphabetically first when the ledger is missing).

Only ONE skill is chosen. Do not batch.

## Step 2 — Propose deletions along the Pocock taxonomy

Prune toward the playbook rules in `CODING_STANDARDS.md` (`STD-PLAYBOOK-*`).
Classify every deletion candidate in the chosen playbook into exactly one
Pocock bucket:

- **Duplication** — the same material stated in two places (a rule restated in
  both a prose paragraph and a fenced recipe; a pitfall duplicated from
  `CLAUDE.md`). Keep the single canonical statement; delete the copy.
- **Sediment** — stale or branch-irrelevant accretions (an issue-number
  changelog line whose fix has long merged; a "NOTE for slice #N" that shipped;
  a retired-subsystem caveat). Delete the fossil.
- **No-op** — a paragraph whose deletion does **not** change agent behavior (a
  preamble, a "why this exists" essay that no step reads, a restated rule).

This is **demote-or-remove-with-parity, never blind deletion** — mirror
`hydra-cleanup`'s demote-not-delete discipline. A candidate that carries a
load-bearing contract token (a `closes #`, a `never push directly to master`, a
verification command, an ADR reference, a worktree-guard preamble) is NOT a
no-op even if it reads like prose — the Step 3 eval is the arbiter.

Assemble the pruned playbook body as the concrete diff you would apply.

## Step 3 — The deletion test, made deterministic (eval-gated parity)

A deletion is only valid if the pruned skill **still preserves the load-bearing
contract tokens** the eval suite asserts. This is the *deletion test made
deterministic*: run the promptfoo eval for the affected skill against the
**real** before/after pair — the pre-prune playbook on `origin/master` versus
the candidate pruned body assembled in Step 2 — and require **contract-token
parity** before opening a PR.

```bash
# SKILL is the chosen playbook slug from Step 1, e.g. "cleanup" for
# docs/operator-playbooks/hydra-cleanup.md. PRUNED_BODY is the candidate
# pruned playbook body assembled at the end of Step 2 — staged here; Step 4,
# not this step, writes it to the real playbook path.
mkdir -p evals/skill-prune/.staged
git show "origin/master:docs/operator-playbooks/hydra-${SKILL}.md" \
  > evals/skill-prune/.staged/before.md  # ref-check: example
printf '%s' "$PRUNED_BODY" > evals/skill-prune/.staged/after.md  # ref-check: example

# Invoke the pinned promptfoo directly with -c against the REAL-PAIR config
# (evals/skill-prune/parity.yaml — a subdirectory, deliberately outside the
# advisory eval-gate step's flat `evals/*.yaml` loop in
# .github/workflows/advisory-checks.yml, which has no staged pair to read).
# The `npm run eval` script hard-pins evals/golden.yaml, so `npm run eval --
# -c <other>` would run BOTH configs — invoke promptfoo directly instead.
PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 \
  npx --yes -p promptfoo@0.121.15 promptfoo eval -c evals/skill-prune/parity.yaml
EVAL_RC=$?
```

- **Parity PASS** (`$EVAL_RC` == 0): the prune preserved every load-bearing
  contract token. Proceed to Step 4 (open the PR under `--apply`).
- **Parity FAIL** (`$EVAL_RC` != 0) OR **evals cannot exercise the chosen skill**
  (no eval config covers it, the harness errors before scoring, `before` and
  `after` came out identical, or `before` carried zero load-bearing contract
  tokens — see `evals/scorers/contract-token-parity.ts`): the run
  **DOWNGRADES**. Do NOT open a PR. Under `--apply`, file a single
  `needs-triage` GitHub issue on `gaberoo322/hydra` — created with the flag
  label `--label skill-prune` only, its state written by the lifecycle seam
  as below (create the label once if absent: `gh label create skill-prune --repo gaberoo322/hydra --force`,
  the cleanup-scan precedent) — listing the candidate deletions (bucketed
  by Pocock taxonomy) so a human/triage pass can decide. The `skill-prune`
  label is the COUNT SEAM for the autopilot's `skill_prune_board_saturated`
  anti-flood cap (the Turn Snapshot counts open `skill-prune`-labelled
  issues against the cap of 3 and suppresses the class above it) — omitting it disarms the cap and lets a failing eval
  re-file candidate lists every 7d cooldown. Under dry-run, just print
  that list.

@include _fragments/issue-first-state.md

> **Scope of the offline eval:** the echo-provider
> eval verifies load-bearing contract-token **PRESERVATION** across the prune —
> it is NOT a live behavioral golden-task replay. Behavioral parity against real
> Anthropic calls is the operator-gated live-provider follow-up (see the
> `evals/golden.yaml` header and docs/evals.md § "Live-provider follow-up").
> The offline gate is the deterministic, free, reproducible arbiter. The
> advisory eval-gate step in `.github/workflows/advisory-checks.yml` loops over top-level `evals/*.yaml` only,
> which is exactly why the real gate above lives in the `evals/skill-prune/`
> subdirectory rather than at the top level.

## Step 4 — Open the PR (under `--apply`), auto-tighten the ratchet

When Step 3 passed AND `--apply` is set, in a fresh worktree:

1. Apply the pruned playbook diff to `docs/operator-playbooks/hydra-<skill>.md`.
2. Regenerate the skill **into a scratch dir to verify it, never the default
   path** (`~/.claude/skills` is the live, host-shared mirror every agent
   dispatch loads its prompts from, and this step runs from an unmerged,
   PR-authoring worktree; `sync-skills.sh`'s default-mirror content guard
   refuses that write):
   ```bash
   CLAUDE_SKILLS_DIR=$(mktemp -d) bash scripts/sync-skills.sh
   ```
   then inspect the regenerated `hydra-<skill>/SKILL.md` under `$CLAUDE_SKILLS_DIR`
   to confirm the prune compiled cleanly and the size dropped. The live mirror
   updates automatically on merge, via `scripts/deploy.sh`.
3. **Auto-tighten the ratchet, shrink-only.** Lower ONLY the pruned file's
   `body` count in `scripts/ci/skill-size-baseline.json` to its new (smaller)
   value: `npx tsx scripts/ci/skill-size-ratchet.ts --write-baseline` regenerates
   the baseline from current sizes, but you MUST verify the diff **only lowers**
   the pruned file's entry and raises nothing (the shrink-only invariant).
   If `--write-baseline` would raise any other file's entry, hand-edit only the
   pruned file's entry instead — never let a prune PR raise a baseline.
4. Run `npm test` + `npm run typecheck` + `npm run build`.
5. Open a T1/T2 PR (`gh pr create`) whose body carries `closes #<issue>` when
   run against a tracked pruning issue, the `Tier:` line from the live tier API,
   and the Pocock-bucketed candidate list as the changelog. The PR edits ONLY
   the one playbook, its regenerated skill, and its baseline entry.

Never push to master. Always a feature branch. CI (including the advisory
`skill-size-ratchet` and `eval-gate` steps inside `.github/workflows/advisory-checks.yml`,
a Tier-3 sibling, NOT `ci.yml`) is the merge gate.

## When NOT to run this

- The board has real `ready-for-agent` work — pruning is spare-capacity work,
  dispatched only on idle backfill (the signal class handles this).
- More than 3 open `skill-prune`-labelled candidate lists already sit on the
  board — the `skill_prune_board_saturated` cap suppresses the dispatch
  until triage drains them; re-pruning past them manufactures
  churn, exactly the feedback loop cleanup's cap exists to break.
- Fired within the last 7 days (the `skill_prune` class cooldown enforces this;
  the cooldown MUST be seeded in `bootstrap.sh` `signal_last_fired` so it
  survives the pace-gate relaunch).
- No eval config can exercise ANY skill (the harness is broken) — a
  `needs-triage` issue is the only honest output; never open an unverified PR.
