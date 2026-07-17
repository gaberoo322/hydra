# `_vendor/` — vendored upstream Pocock skill bases (ADR-0030, Option C)

Git-tracked copies of the upstream Matt Pocock skills (`mattpocock/skills`) that
Hydra's autonomous lineage composes against. This directory is the **lineage
home** ADR-0030 Decision 4 locked (Option C): the *same* skill the operator runs
interactively, vendored **into the repo** (not off-repo, not clobbered on
refresh) so it stays git-tracked and gate-eligible, while a thin per-skill Hydra
AFK **overlay** (the matching `docs/operator-playbooks/<name>.md` playbook) rides
on top.

## How compose works

A playbook opts into composition with a frontmatter key:

```yaml
compose_base: _vendor/<name>.md
```

When `scripts/sync-skills.sh` sees `compose_base`, it emits the generated
`~/.claude/skills/<name>/SKILL.md` as **[vendored base body] + [overlay body]**,
and the generated **frontmatter has `disable-model-invocation` stripped**. That
strip is the standing invariant from ADR-0030 Decision 4 / #3386: every
dispatched upstream Pocock skill ships `disable-model-invocation: true` upstream,
which **HARD-ERRORS under Skill-tool dispatch** — so the composed AFK output must
never carry it.

## Refreshing a vendored base

Refresh from upstream with:

```bash
npx skills add mattpocock/skills --copy   # installs the upstream skills
# then copy the refreshed SKILL.md body into this dir's <name>.md
```

The vendored file here is **not** banner-stamped and **not** an operator-editable
source — it is a captured upstream artifact. Edit the Hydra behaviour in the
overlay playbook (`docs/operator-playbooks/<name>.md`), never here.

## Non-emission

The non-recursive `docs/operator-playbooks/*.md` glob in `sync-skills.sh` does
**not** descend into `_vendor/`, so a vendored base is never itself emitted as a
standalone `~/.claude/skills/` entry — exactly like `_fragments/`. It is only
ever pulled in as the base of a composing playbook.
