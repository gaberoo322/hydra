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

## Adding a provider

The drainer authors on an ordered list of Anthropic-compatible worker providers, `config/glm/providers.json` (ADR-0032, amended by #4841). The first provider that is not quota-blocked (and not at its own `dailyCap`) is used; the lane idles only when every provider is blocked.

1. **Operator, off-git:** create the provider account and put its credential in `~/.config/hydra-glm/env` under a NEW variable name, e.g. `KIMI_API_KEY=...`. Adding a credential is an operator action (ADR-0005).
2. **Config, in a PR:** append an entry to `config/glm/providers.json`:

   ```json
   {
     "id": "kimi",
     "baseUrl": "https://<anthropic-compatible-endpoint>",
     "model": "kimi-k2.5",
     "tokenEnv": "KIMI_API_KEY",
     "quotaReset": { "format": "fallback-only" },
     "dailyCap": 3
   }
   ```

   - `model` must be an explicit non-Claude name: a Claude alias or `claude-*` is rejected at load, because the CLI would resolve it locally and bill Anthropic (#3758).
   - `quotaReset` is `{"format": "zai-wallclock", "tzOffset": "+0800"}` when the provider's 429 carries a `reset at YYYY-MM-DD HH:MM:SS` clause, else `{"format": "fallback-only"}` (a 60-minute block).
   - `dailyCap` is optional; ids and models must be unique, `tokenEnv` can never be `ANTHROPIC_API_KEY`.
3. **Verify:** a `HYDRA_GLM_DRAINER_DRY_RUN=1` run of the drainer, then the `hydra-glm-drainer` journal lines. A bad list shows `worker-provider list invalid (...)` and the lane does nothing, by design.

Order matters: list the preferred provider first. Every drainer PR body ends with `worker-provider:` / `worker-model:` trailers; `scripts/glm-beachhead-report.sh` prints a per-provider PASS-rate and churn line from them, which is the input to the per-provider keep-or-kill call.

Block files live in `$CAP_DIR` (default `/tmp`): `hydra-glm-drainer-quota-blocked-until` for `zai`, `hydra-glm-drainer-quota-blocked-until-<id>` for the others. To unblock a provider by hand, delete its file.
