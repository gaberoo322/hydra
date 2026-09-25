## Summary

`hydra-skill-prune` is dispatched by the `skill_prune` autopilot class (`scripts/autopilot/classes.json`), which reaches it through the Skill tool. Its playbook carried `disable-model-invocation: true`, which HARD-ERRORS under Skill-tool dispatch — the fail-safe flag rule in `scripts/sync-skills.sh` says this flag is only safe for a skill reached solely via explicit slash-launch (never a classes.json dispatch). Two live 2026-07 `skill_prune` transcripts confirm the hard error; those runs only produced a PR because the subagent improvised a `Read()` of `SKILL.md` instead of `Skill()`.

- Delete `disable-model-invocation: true` from `docs/operator-playbooks/hydra-skill-prune.md` (line 8).
- Add a tripwire inside the existing `#3990` describe block in `test/sync-skills.test.mts`: for every skill named in `scripts/autopilot/classes.json`, read its generated Claude `SKILL.md` from the shared `liveSync()` scratch-dir sync and fail if the frontmatter carries the flag; plus a companion case pinning that `hydra-autopilot` keeps the flag and is not a classes.json-dispatched skill. Confirmed the new tripwire case FAILED against unchanged master (flag still present) before deleting the playbook line.
- Update `scripts/sync-skills.sh`'s header comment only — name the enforcing test and replace the stale "Today only hydra-autopilot qualifies" sentence with the current three exemptions (`hydra-autopilot`, `thermo-nuclear-code-quality-review`, `zoom-out`).

No new test file was added (new cases live inside the existing describe block), so the suite-count file-set baseline is unchanged.

## Design-concept reconciliation

Design-concept artifact: `GET /api/design-concepts/issue-4606`, hash `e0501fd489e2e18162ac21d5813808f4f8618f2821a4d39b5bcc89301107e899`.

Invariants and how this PR satisfies each:

1. **No classes.json-dispatched skill's generated SKILL.md may carry `disable-model-invocation`.** Satisfied by the new tripwire test, which reads every classes.json skill's generated frontmatter via `liveSync()` and fails on a match — covers both a direct playbook flag and compose_base inheritance.
2. **`hydra-autopilot` keeps the flag (not a classes.json skill); `thermo-nuclear-code-quality-review` and `zoom-out` keep theirs (operator-invoked only). Only `hydra-skill-prune`'s flag is removed.** Satisfied: the playbook edit touches only `hydra-skill-prune.md`; the new companion test pins that `hydra-autopilot` still carries the flag and is absent from `classes.json`. The other two exempt skills already have pinning tests in this file (the `#3995` describe block) that are untouched and still pass.
3. **`scripts/sync-skills.sh` behaviour is unchanged; only its header comment is updated** (names the enforcing test, drops the stale "today only hydra-autopilot" line, lists the current three exemptions). No functional/shell-logic change.
4. **The new assertion lives inside the existing top-level `#3990` describe block and uses the shared read-only `liveSync()` scratch-dir sync; it must not write to `~/.claude/skills`.** Satisfied: both new tests are added inside `describe("scripts/autopilot/classes.json — every dispatched skill resolves to a generated playbook (issue #3990)", ...)` and call the existing `liveSync()` helper, which syncs into a `mkdtemp` scratch dir via `CLAUDE_SKILLS_DIR`/`CODEX_SKILLS_DIR` env overrides — never the default live mirror. No new test file, so the suite-count file-set baseline is untouched.
5. **The worktree must not run `sync-skills.sh` against the default live mirror.** Not run against the default mirror at any point in this session — only via the test's scratch-dir `liveSync()`. The live `~/.claude/skills/hydra-skill-prune/SKILL.md` will be refreshed by the post-merge deploy.
6. **No other `hydra-skill-prune` frontmatter or body content changes.** Confirmed via a diff review — the playbook change is exactly the one deleted line.
7. **The new test must go red against current master before the playbook line is deleted, proving it pins the defect.** Confirmed: ran `npm run test:file -- test/sync-skills.test.mts` with the test added but the flag still present — the new case failed with the expected message; only then was the flag deleted, after which the full file passes (67/67).

## Verification

- `npm run typecheck` — pass
- `npm run typecheck:test` — pass (0 known errors, baseline=0)
- `npm run test:file -- test/sync-skills.test.mts` — 67/67 pass
- `npm test` — 8736/8740 pass, 0 fail, 4 skipped (pre-existing/unrelated skips); the advisory SUITE-COUNT GATE lines are the documented `--test-force-exit` reporter-truncation artifact (CLAUDE.md Common Pitfalls), not real failures — no FILE-SET (blocking) verdict fired.

Closes #4606

🤖 Generated with [Claude Code](https://claude.com/claude-code)
