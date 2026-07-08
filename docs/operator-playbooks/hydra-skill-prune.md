---
name: hydra-skill-prune
description: Non-interactive skill pruner. Picks ONE generated skill per run, proposes Pocock-taxonomy deletions (duplication, sediment, no-op), validates them with the promptfoo eval (golden-task parity), and opens at most one T1/T2 PR editing only that playbook, its regenerated skill, and its tightened ratchet baseline. Dry-run by default; --apply opens the PR.
when_to_use: "When the Orchestrator board is idle, or the operator says 'skill prune' or 'prune a skill'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
arguments: [apply]
claude_only: true
disable-model-invocation: true
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
autonomous behavior rather than a manual sweep (epic #2944).

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
  autopilot maps `apply=true` → `--apply`, the #1078 anti-dry-run-no-op lesson)
  is what opens the PR or files the fallback issue.
- **One skill per run.** Pick exactly one generated skill and prune only it.
- **One PR per run.** At most one T1/T2 PR, editing only that skill's playbook,
  its regenerated `SKILL.md`, and its baseline entry.

## Step 1 — Pick the ONE skill to prune

Selection is **largest-over-baseline first, else round-robin**:

1. Read `scripts/ci/skill-size-baseline.json` (the #2946 shrink-only ratchet
   baseline: per-playbook body word counts).
2. For each `docs/operator-playbooks/hydra-*.md`, compute the current body word
   count and the delta over its baseline entry.
3. If any skill's current body **exceeds** its baseline (it grew since the last
   ratchet tighten), pick the one with the **largest over-baseline delta** — it
   is the freshest accretion and the highest-value prune.
4. Otherwise (every skill at or below baseline, the steady state), fall back to
   **round-robin**: pick the skill with the oldest `skill_prune` attempt. Track
   the rotation in a small `${HYDRA_STATE_DIR:-/tmp}/hydra-skill-prune-rotation.json`
   ledger (skill name → last-pruned epoch); pick the least-recently-pruned skill,
   stamp it after the run. A missing ledger starts the rotation at the
   alphabetically first playbook.

Only ONE skill is chosen. Do not batch.

## Step 2 — Propose deletions along the Pocock taxonomy

Read the chosen playbook and classify every deletion candidate into exactly one
Pocock bucket:

- **Duplication** — the same material stated in two places (a rule restated in
  both a prose paragraph and a fenced recipe; a pitfall duplicated from
  `CLAUDE.md`). Keep the single canonical statement; delete the copy.
- **Sediment** — stale or branch-irrelevant accretions (an issue-number
  changelog line whose fix has long merged; a "NOTE for slice #N" that shipped;
  a retired-subsystem caveat). Delete the fossil.
- **No-op** — a paragraph whose deletion does **not** change agent behavior (a
  motivational preamble, a "why this exists" essay that no step reads, a
  redundant re-explanation of a rule already stated mechanically).

This is **demote-or-remove-with-parity, never blind deletion** — mirror
`hydra-cleanup`'s demote-not-delete discipline. A candidate that carries a
load-bearing contract token (a `closes #`, a `never push directly to master`, a
verification command, an ADR reference, a worktree-guard preamble) is NOT a
no-op even if it reads like prose — the Step 3 eval is the arbiter.

Assemble the pruned playbook body as the concrete diff you would apply.

## Step 3 — The deletion test, made deterministic (eval-gated parity)

A deletion is only valid if the pruned skill **still preserves the load-bearing
contract tokens** the eval suite asserts. This is the *deletion test made
deterministic*: run the promptfoo eval for the affected skill against the pruned
playbook and require **golden-task parity** before opening a PR.

```bash
# Run the eval for the affected skill (offline echo provider, zero LLM calls).
# evals/skill-prune.yaml asserts the pruned skill preserves its contract tokens.
# Invoke the pinned promptfoo directly with -c (the `npm run eval` script hard-
# pins evals/golden.yaml, so `npm run eval -- -c <other>` would run BOTH configs;
# the eval-gate.yml CI loop runs each config the same single-config way).
PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 \
  npx --yes -p promptfoo@0.121.15 promptfoo eval -c evals/skill-prune.yaml
EVAL_RC=$?
```

- **Parity PASS** (`EVAL_RC` == 0): the prune preserved every load-bearing
  contract token. Proceed to Step 4 (open the PR under `--apply`).
- **Parity FAIL** (`EVAL_RC` != 0) OR **evals cannot exercise the chosen skill**
  (no eval config covers it, or the harness errors before scoring): the run
  **DOWNGRADES**. Do NOT open a PR. Under `--apply`, file a single
  `needs-triage` GitHub issue on `gaberoo322/hydra` listing the candidate
  deletions (bucketed by Pocock taxonomy) so a human/triage pass can decide.
  Under dry-run, just print that list.

> **Scope of the offline eval (design concept, Phase A):** the echo-provider
> eval verifies load-bearing contract-token **PRESERVATION** across the prune —
> it is NOT a live behavioral golden-task replay. Behavioral parity against real
> Anthropic calls is the operator-gated live-provider follow-up (see the
> `evals/golden.yaml` + `eval-gate.yml` headers and docs/evals.md § "Live-provider
> follow-up"), explicitly out of Phase A scope. The offline gate is the
> deterministic, free, reproducible arbiter that ships today.

## Step 4 — Open the PR (under `--apply`), auto-tighten the ratchet

When Step 3 passed AND `--apply` is set, in a fresh worktree:

1. Apply the pruned playbook diff to `docs/operator-playbooks/hydra-<skill>.md`.
2. Regenerate the skill: `bash scripts/sync-skills.sh` (rewrites the
   `~/.claude/skills/hydra-<skill>/SKILL.md` artifact from the playbook).
3. **Auto-tighten the ratchet, shrink-only.** Lower ONLY the pruned file's
   `body` count in `scripts/ci/skill-size-baseline.json` to its new (smaller)
   value: `npx tsx scripts/ci/skill-size-ratchet.ts --write-baseline` regenerates
   the baseline from current sizes, but you MUST verify the diff **only lowers**
   the pruned file's entry and raises nothing (the #2946 shrink-only invariant).
   If `--write-baseline` would raise any other file's entry, hand-edit only the
   pruned file's entry instead — never let a prune PR raise a baseline.
4. Run `npm test` + `npm run typecheck` + `npm run build`.
5. Open a T1/T2 PR (`gh pr create`) whose body carries `closes #<issue>` when
   run against a tracked pruning issue, the `Tier:` line from the live tier API,
   and the Pocock-bucketed candidate list as the changelog. The PR edits ONLY
   the one playbook, its regenerated skill, and its baseline entry.

Never push to master. Always a feature branch. CI (including the advisory
`skill-size-ratchet` and `eval-gate` sibling workflows, both Tier-3, NOT in
`ci.yml`) is the merge gate.

## When NOT to run this

- The board has real `ready-for-agent` work — pruning is spare-capacity work,
  dispatched only on idle backfill (the signal class handles this).
- Fired within the last 7 days (the `skill_prune` class cooldown enforces this;
  the cooldown MUST be seeded in `bootstrap.sh` `signal_last_fired` so it
  survives the pace-gate relaunch — the #2575 cooldown-bootstrap bug class).
- No eval config can exercise ANY skill (the harness is broken) — a
  `needs-triage` issue is the only honest output; never open an unverified PR.
