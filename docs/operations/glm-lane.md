# GLM lane — turning it off and on

The GLM dev-drainer ([ADR-0032](../adr/0032-glm-dev-drainer-worker-lane.md)) has a durable operator off switch (issue #5038). It is a sentinel file. While the file exists, the lane does nothing, and every piece of its infrastructure stays installed.

## Off

```bash
mkdir -p ~/.config/hydra-glm && touch ~/.config/hydra-glm/disabled
systemctl --user disable --now hydra-glm-drainer.timer   # optional: deploy does this on the next merge
```

Within 45 minutes the drainer heartbeat goes stale, and the Claude `dev_orch` lane picks up every `glm-eligible` issue (the #3754 fail-open). While the sentinel exists:

| Reader | Behaviour |
|---|---|
| `scripts/deploy.sh` | installs the units, **disables** the timer (never re-enables it) |
| `scripts/glm/drainer-loop.sh` | exits before flock: no tick, no heartbeat |
| `src/glm/gate.ts` | `disabled` verdict ahead of `paused`; makes no other read |
| `glm-eligibility-sweep` chore | stamps no `glm-eligible` labels |
| `scripts/glm-beachhead-report.sh` | prints one `lane DISABLED` line (`--ab-report` still works) |

Don't switch the lane off by deleting `~/.config/hydra-glm/env`. The heartbeat is written before the credential check, so the drainer would look alive while authoring nothing, and `glm-eligible` work would starve. Don't `mask` the timer either: deploy's `enable` would then fail under `set -e`.

## On

```bash
rm ~/.config/hydra-glm/disabled
systemctl --user enable --now hydra-glm-drainer.timer   # or wait for the next deploy
```

## Details

- `src/glm/disabled.ts` owns the path rule: `$HOME/.config/hydra-glm/disabled`, overridable with `HYDRA_GLM_DISABLED_FILE`.
- Nothing in the repo writes the sentinel. Only the operator turns the lane off.
- The test launcher (`scripts/test/redis-db-launch.mjs`) points the override at a path that never exists, so a live sentinel on the shared CI host never reaches the suite.
