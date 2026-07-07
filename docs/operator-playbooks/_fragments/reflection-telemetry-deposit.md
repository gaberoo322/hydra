Run the deterministic deposit helper (issue #2947 lifted this bash into
`scripts/reflection-deposit.sh` so the key-derivation lives in one testable
place; behavior — deposit keys, graceful no-op, FAIL-LOUD-on-stderr — is
preserved exactly). Pass the resolved `$ANCHOR_REF` (the anchor.reference,
e.g. `issue-841`) and the raw `$REFL_JSON` body from `GET /api/reflections`.
The helper maps served blocks to the bare `per-anchor` / `by-file` bucket
tokens (#1945), derives the harness `task_id` from the `agent-<HASH>` worktree
cwd (#1945), writes `hydra-refl-sources-<task_id>` only when reflections were
served, and ALWAYS writes `hydra-refl-anchor-<task_id>` (#2112) so a
first-failure anchor is recoverable. An empty/served-nothing result deposits no
sources file, which reap.py correctly buckets to `none`.

```bash
# scripts/reflection-deposit.sh is a worktree-relative helper; resolve it from
# the repo root so a mid-plan `cd` can't lose it.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"
bash "$REPO_ROOT/scripts/reflection-deposit.sh" reflect "{{SKILL_NAME}}" "$ANCHOR_REF" "$REFL_JSON"
```
