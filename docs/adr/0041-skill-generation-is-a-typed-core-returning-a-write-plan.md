---
status: accepted
---

# ADR-0041: Skill generation is a typed TypeScript core that returns a whole-corpus write plan; Codex skill generation is retired

Date: 2026-09-27
Deciders: Operator + Hydra (wayfinder map #4394, whose three tickets locked the decisions recorded here)
Related: ADR-0006 (Codex CLI removed; Decision 4 here is its follow-through), ADR-0030 (the `compose_base` vendored-base composition this core must preserve), ADR-0040 (the precedent: a bash script's logic moved into typed TypeScript), ADR-0005 (no new runtime dependencies), #4708 (the loop inventory: the facts), #4709 (mechanism), #4710 (Claude/Codex shape), #4697 (the pr-refs.py → TS parity-test pattern reused in Decision 3), #3828 / #3693 (the default-mirror guard and banner-guarded prune, which stay in bash)

## Context

`scripts/sync-skills.sh` regenerates every `~/.claude/skills/<name>/SKILL.md` from
`docs/operator-playbooks/*.md` on every master deploy (`scripts/deploy.sh`) and from the opt-in
post-merge git hook. The #4708 inventory
(`docs/research/2026-09-27-sync-skills-loop-inventory.md`) established that it is not a bash
pipeline:

- All text transformation lives in a 279-line inline Python heredoc: frontmatter parse,
  `@include` resolution, `compose_base` composition, `supersedes:` excision and the seam marker.
  A second 20-line Python heredoc handles reference files.
- Bash re-reads the heredoc's JSON through 10–11 separate `python3 -c` projections per playbook.
- A fail-loud error (bad `@include`, missing `compose_base`) raises `SystemExit` midway through
  the loop. That leaves some skills regenerated and others stale.
- All 67 cases in `test/sync-skills.test.mts` spawn the whole script. None reaches the Python
  half directly, and many writer branches have no direct test.
- The playbook grammar has four other partial implementations, which drift independently:
  `scripts/ci/skill-size-ratchet.ts`, `scripts/ci/vendor-drift-check.ts`, the include resolver in
  `test/hydra-dev-reflection-deposit.test.mts`, and the frontmatter regex in
  `scripts/ci/check-skill-playbook-drift.sh`.
- Every run also writes a Codex copy of each skill to `~/.codex/skills`. No Hydra path consumes
  it (ADR-0006), 20 playbooks carry `claude_only: true` only to opt out, and the
  `codex_delegation` footer is declared by no playbook.

## Decision

### Decision 1 — A pure TypeScript core under `src/skills/` owns the playbook grammar and rendering

- Parse, `@include`, `compose_base`, `supersedes:` excision, the seam marker and Claude
  `SKILL.md` rendering move into pure functions under `src/skills/`.
- These functions take file contents in and return strings or data out. They do no filesystem
  writes and spawn no processes.
- The core lives under `src/` rather than `scripts/` so the full `tsc` gate covers it. The
  precedents are `src/github/pr-refs.ts` and `src/glm/`.
- It adds no runtime dependency (ADR-0005). It runs through the pinned
  `node --experimental-strip-types`, so it must avoid constructor parameter properties.
- **Bash keeps:** argument parsing, the #3828 default-mirror guard, the playbook glob, the
  tmp-file-plus-`mv` writes, and `prune_orphans` with its banner guard.
- A standalone Python module and in-place bash functions were rejected. The first adds a fifth
  copy of the grammar. The second leaves every concern testable only by spawning the whole script.

### Decision 2 — One call per run returns a whole-corpus write plan; the sync is all-or-nothing

- Bash calls the core once per run. The core reads every playbook and returns
  `{ writes: [{ path, content }], skips: [{ playbook, reason }] }`.
- If any playbook has a fail-loud error, the core exits non-zero and lists **every** error. Bash
  then aborts before any write.
- Bash applies the writes, then runs `prune_orphans`. `--dry-run` prints the plan and writes
  nothing.
- Fail-soft skips (no frontmatter, missing name or description) become explicit `skips`
  entries, not silent `continue`s.
- A per-playbook call was rejected because it keeps the half-written-sync failure. Moving the
  writes into the core was rejected because it mixes effects into the pure layer.

### Decision 3 — Migrate by strangler, guarded by a live byte-parity test

1. The core lands **beside** the untouched heredoc. A required test asserts that the core's plan
   is byte-identical to the current script's output across every live playbook.
2. Later slices add per-concern unit tests against the core, in new `test/*.test.mts` files that
   mirror `src/skills/`. Each new file regenerates the suite-count baseline in the same PR.
3. The **cutover** slice switches bash onto the core and deletes the Python heredocs, the
   `python3 -c` projections and the parity test, all in one PR.
4. After cutover, the existing black-box cases in `test/sync-skills.test.mts` are the oracle.

A single big-bang PR proven by a one-shot `diff -r` was rejected, because it cannot catch a
regression landing between slices.

### Decision 4 — Codex skill generation is retired, ahead of the core

- Removed: the Codex writer, the `codex_delegation` footer, the `claude_only` frontmatter key
  (stripped from every playbook that carries it) and all `CODEX_DIR` / `CODEX_SKILLS_DIR`
  plumbing. That includes the #3828 guard's and `prune_orphans`' Codex arms.
- This ships as the epic's **first** slice, in today's bash, before the core exists. The core
  never learns a second output format, and the parity test proves Claude output only.
- That slice ends with a one-time sweep of `~/.codex/skills` that removes only directories whose
  `SKILL.md` carries the generated banner.
- Tests that assert Codex behaviour are rewritten to assert its absence **before** the code
  change.
- A new playbook must not reintroduce `claude_only` or `codex_delegation`. Once the core owns
  the grammar, it may reject them.
- **Accepted cost:** a manual Codex CLI session no longer sees Hydra skills.

### Decision 5 — The existing grammar copies import the core

- After cutover, trailing slices switch each partial implementation to import `src/skills/`
  and delete its private copy:
  - `skill-size-ratchet.ts`: `splitFrontmatter` / `extractDescription`
  - `vendor-drift-check.ts`: `collectSupersedes` / `headingsOf` / `bodyOf`
  - the reflection-deposit test's include resolver
  - `check-skill-playbook-drift.sh`, where it parses frontmatter
- New code that needs the playbook grammar imports the core. It never re-implements it.

## Consequences

- An agent editing one concern reads one small typed function and its unit test, not a 705-line
  script. That is the map's Destination.
- A broken `@include` or `compose_base` leaves the live skill mirror untouched, where today it
  is half-regenerated.
- About 465 `python3` spawns per sync go away. `python3` stays a deploy dependency for other
  scripts.
- The #3828 guard and `prune_orphans` are unchanged apart from losing their Codex arms. They
  share no state with the loop.
