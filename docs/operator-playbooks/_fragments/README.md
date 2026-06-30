# Shared playbook fragments (issue #2552)

Files in this directory are **fragments** included into one or more
`docs/operator-playbooks/<name>.md` playbooks via an `@include` directive,
resolved at sync time by `scripts/sync-skills.sh`.

## Why

Several `hydra-*` playbooks carry byte-identical (modulo a per-skill log-tag)
blocks that must currently be kept in sync by hand — a bug fixed in one
silently misses the other (e.g. the #1945 reflection-deposit `task_id` fix).
Lifting those blocks into a single fragment makes `sync-skills.sh` the single
source of truth: edit the fragment once, re-sync, and every including skill
picks up the change.

## Directive syntax

In a playbook body, a line of exactly:

```
@include _fragments/<name>.md
```

(leading/trailing whitespace allowed; the path is relative to
`docs/operator-playbooks/`) is **replaced verbatim** by the fragment's content
during sync. The directive must be the whole line.

- **`{{SKILL_NAME}}` substitution.** Any occurrence of `{{SKILL_NAME}}` in the
  fragment is replaced with the including skill's frontmatter `name`
  (`hydra-dev`, `hydra-target-build`, …). This is the only systematic per-skill
  difference the shared blocks carry today (the `[hydra-dev]` vs
  `[hydra-target-build]` log-tag prefix), so one flat token suffices.
- **Non-recursive.** A fragment may not itself contain an `@include` — the
  resolver is single-level by design (ADR-0014 simplicity). A nested include
  fails the sync loud.
- **Fail loud.** A missing/typo'd fragment, a path that escapes
  `operator-playbooks/`, or a nested include makes the Python resolver exit
  non-zero, which (under `set -euo pipefail`) aborts the sync and, via the
  issue-#433 deploy contract, the deploy — so a skill never ships a literal
  `@include …` line.

## Why a subdirectory

The skill-generation glob in `sync-skills.sh` is
`PLAYBOOK_FILES=("$PLAYBOOKS"/*.md)` — **non-recursive**, so fragment files
under this subdirectory are never themselves emitted as a `SKILL.md`. (Putting
them directly under `operator-playbooks/` would rely on the fragile
no-frontmatter skip path.) This `README.md` is likewise never read by the glob.

## Editing

Edit the fragment here, then run `scripts/sync-skills.sh` (or let the deploy /
post-merge hook do it). **Never hand-edit a generated `SKILL.md`** — it carries
a DO-NOT-EDIT banner and will be overwritten on the next sync.
