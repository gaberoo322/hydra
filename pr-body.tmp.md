Strip heredoc bodies (data, not shell) from the command text in `gh-label-delete-guard.sh` before continuation collapse, variable resolution and shlex segmentation, so odd quotes in a PR-comment body no longer false-DENY the /hydra-review 0.9 label hand-back recipe.

Tier: 3 (operator-review change)

Merge danger: two-way — a hook-script edit and a test; `git revert` plus redeploy restores the prior behaviour, no persistent state or external contract.

Glossary impact: none
ADR impact: none

## Files in scope

- `scripts/claude-hooks/gh-label-delete-guard.sh`
- `test/gh-label-delete-guard.test.mts`

## Design-concept reconciliation

Artifact: `3220eb5144fb`

- INV-1: "INV-1 (heredoc bodies are data): a heredoc BODY" — verified by: `file-contains: scripts/claude-hooks/gh-label-delete-guard.sh :: def _strip_heredoc_bodies(text):`
- INV-2: "INV-2 (here-string untouched): `<<<` is never treated as a heredoc operator" — verified by: `test: test/gh-label-delete-guard.test.mts :: "a <<< here-string is not a heredoc (read binding still resolves)"`
- INV-3: "INV-3 (unterminated heredoc fails open to the pre-#5401 behaviour)" — verified by: `test: test/gh-label-delete-guard.test.mts :: "an unterminated heredoc leaves the command unchanged"`
- INV-4: "INV-4 (no new false-negative mask): the fix closes, rather than widens" — verified by: `test: test/gh-label-delete-guard.test.mts :: "an odd quote in a heredoc body followed by a real collection DELETE is DENIED"`
- INV-5: "INV-5 (test fails red without the fix): the new regression case must pin a shape" — verified by: `test: test/gh-label-delete-guard.test.mts :: "a quote-odd heredoc body before a path DELETE + collection GET is ALLOWED (was DENY)"`
- INV-6: "INV-6 (footing unchanged): the change stays pure string/regex work" — verified by: `file-lacks: scripts/claude-hooks/gh-label-delete-guard.sh :: urllib`

## Acceptance

- [x] Quote-odd heredoc then recipe returns ALLOW — verified by: `npm run test:file -- test/gh-label-delete-guard.test.mts` exits 0
- [x] Real collection DELETE after a heredoc still denied — verified by: same test file, "still DENIED" case
- [x] DELETE text inside a body allowed — verified by: same test file, "only inside a heredoc body" case
- [x] Here-string behaviour unchanged — verified by: existing #4728 cases stay green

The issue's abbreviated repro already ALLOWs on master (shlex ValueError fail-open); the regression test pins the shape that DENYs on master instead (INV-5).

Closes #5401
