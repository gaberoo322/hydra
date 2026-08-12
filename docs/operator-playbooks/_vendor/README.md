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

## Superseding a base section (issue #3990)

Composition is concatenation, so when the base and the overlay both instruct on
the same action, **both instructions ship** and a model reading top-down can act
on either. That is not hypothetical: it is #3818 (the base's own reviewer spawn
firing alongside the overlay's, ~6 sub-agents per PR against a documented 2) and
#3880 (the overlay's blocking-dispatch mandate not holding, so a PR passed review
with no verdict posted).

An overlay removes a conflicting base section by declaring it:

```yaml
compose_base: _vendor/code-review.md
supersedes:
  - "### 4. Spawn both sub-agents in parallel"
```

`sync-skills.sh` **excises** each named section from the base body at compose
time — from the heading through to the next heading of equal or shallower depth,
nested subsections included — and leaves an auditable marker naming the overlay
that removed it. The vendored file here is never modified; the excision shows up
as a reviewable diff in the generated mirror.

Matching is on heading text, normalised for leading `#`s and surrounding
whitespace, so the hashes may be included or omitted. Entries are a YAML block
sequence, not the inline `[a, b]` form — headings routinely contain commas.

Three things **fail the sync loudly** rather than proceeding:

- a `supersedes:` entry that matches **no** heading in the base (the error lists
  the base's actual headings),
- one that matches **more than one** (a supersedes entry must identify exactly
  one section),
- `supersedes:` declared **without** `compose_base:`.

The first of those is what makes an automated base refresh safe. A refreshed
upstream base that renamed a heading MUST break the sync — silently
un-suppressing the instruction the overlay meant to kill is exactly how #3818
comes back, and nothing downstream would report it.

**Prefer `supersedes:` over the `<!-- compose-seam-supersede -->` marker** when
the goal is to remove an instruction. That marker (#3818) only *hoists* overlay
prose ahead of the base — it reorders, it does not remove, and both instructions
still ship. Use it for framing that must be read first; use `supersedes:` for
anything the overlay genuinely replaces.

## Provenance (issue #3994)

Each base's origin is recorded in **`provenance.json`**, a sidecar manifest —
deliberately not an in-file header. A comment above a vendored file's frontmatter
makes `sync-skills.sh` fail loud (`compose_base … has no frontmatter`), and
keeping the captures **byte-faithful** to upstream is what makes a content diff
against the installed skill exact.

Each entry carries `skill`, `capturedAt`, `upstreamSha`, and `shaStatus`:

- **`verified`** — the SHA was recorded from the installed plugin's
  `gitCommitSha`, so a comparison against the registry is meaningful.
- **`unverified`** — captured before provenance stamping existed (or from a
  pre-plugin `npx skills add --copy` install). The upstream commit is genuinely
  unknown; the drift checker reports these as needing a baseline re-vendor rather
  than pretending they are current. Every base starts here.

## Checking for drift

```bash
npm run vendor:drift          # human-readable
npm run vendor:drift -- --json
```

It reports stale bases, bases missing a provenance entry, manifest entries whose
file is gone, and — most importantly — any `supersedes:` heading that no longer
resolves in its base. That last check is what stops a refresh from silently
un-suppressing an instruction the overlay meant to excise (the #3818 defect).

**Advisory only.** It exits 0 on drift; it exits non-zero only when it cannot do
its job. The weekly `vendor-drift` workflow uploads the report; it is never a
required check, because upstream moving is ambient activity no PR controls.

## Refreshing a vendored base

1. Copy the refreshed upstream `SKILL.md` over this dir's `<name>.md`, verbatim.
2. Record the source commit in `provenance.json` — set `upstreamSha` to the
   plugin's `gitCommitSha` and `shaStatus` to `verified`, and update `capturedAt`.
3. Run `scripts/sync-skills.sh`. **If a `supersedes:` heading was renamed
   upstream, this fails loud** — resolve the entry against the new heading rather
   than deleting it, or the excision silently stops happening.
4. Re-run `npm run vendor:drift` to confirm the base is clean.

The vendored file here is **not** banner-stamped and **not** an operator-editable
source — it is a captured upstream artifact. Edit the Hydra behaviour in the
overlay playbook (`docs/operator-playbooks/<name>.md`), never here.

## Non-emission

The non-recursive `docs/operator-playbooks/*.md` glob in `sync-skills.sh` does
**not** descend into `_vendor/`, so a vendored base is never itself emitted as a
standalone `~/.claude/skills/` entry — exactly like `_fragments/`. It is only
ever pulled in as the base of a composing playbook.
