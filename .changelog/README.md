# Changelog fragments

This directory holds **per-PR changelog fragments**. Each PR that ships a
user- or operator-visible change adds **one file** here; the dashboard renders
the release notes for each version from the fragments added in that version's
git-tag window (`/api/versions`, epic #3676 — tickets #3659/#3680/#3681).

There is **no committed `CHANGELOG.md`** — that would guarantee merge conflicts
across parallel autopilot PRs and would write to `master` on merge (the
`ov.conf` deploy-writes-to-master hazard). Per-PR fragment files are
**conflict-free** because each PR adds a distinct filename.

## Filename

```
.changelog/<issue>-<slug>.md
```

- `<issue>` — the issue number the PR closes (e.g. `3678`).
- `<slug>` — a short kebab-case description (e.g. `changelog-convention`).

Example: `.changelog/3678-changelog-convention.md`

## Contents

A single curated line in the form:

```
- <type>: <description> (#<issue>)
```

- `<type>` — a Conventional-Commits type: `feat`, `fix`, `perf`, `refactor`,
  `docs`, `test`, `build`, `ci`, `chore`, `revert`. The dashboard groups notes
  by type at render time.
- `<description>` — a concise, human-readable summary (imperative mood).
- `(#<issue>)` — the issue reference (the dashboard links notes to the issue,
  not the PR).

Example:

```
- feat: add per-PR changelog fragment convention (#3678)
```

## When to add one

Add a fragment for any change worth a release note. For changes that need no
note — pure chores, test-only edits, docs-only tweaks, or reverts — apply the
**`skip-changelog`** label to the PR instead of adding an empty fragment.

## Enforcement

The advisory `changelog-check.yml` workflow posts a single **non-blocking**
sticky comment on any PR that adds no fragment and lacks the `skip-changelog`
label. It is advisory only — it **never blocks merge or deploy** and is never a
required check. See `scripts/ci/changelog-check.ts` for the pure decision logic.
