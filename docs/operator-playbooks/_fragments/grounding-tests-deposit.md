Run the deterministic grounding-tests deposit helper (issue #2947 lifted this
bash into `scripts/reflection-deposit.sh`; behavior — the deposit key, the
node:test footer parse, the graceful no-op — is preserved exactly). The helper
runs `npm test`, parses the `# tests N` / `# pass N` footer, and deposits
`hydra-grounding-tests-<task_id>` (`testsAfter` / `testsPassingAfter`) keyed on
the SAME harness `task_id` reap reads (#2754). Best-effort and fully non-fatal:
a missing footer, an underivable task_id, or any I/O error yields no deposit →
reap omits the fields → truthful "unknown". Run it AFTER `npm test` passes.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
bash "$REPO_ROOT/scripts/reflection-deposit.sh" grounding "{{SKILL_NAME}}"
```
