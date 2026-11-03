Moves the dispatch-registration marker out of shared `/tmp` into a user-owned state dir and prunes stale markers on the write path.

Tier: 3 (operator-review change)
Merge danger: two-way — a shell hook default path change; `git revert` plus redeploy restores prior behaviour, markers are idempotent.

## Files in scope

- `scripts/autopilot/hooks/on-subagent-tool-call.sh`
- `test/on-subagent-tool-call.test.mts`

## Design-concept reconciliation

Artifact: `0fe5b65cfe8d`

- INV-1: "With HYDRA_DISPATCH_REGISTER_MARKER_DIR unset, the marker dir resolves to" — verified by: `file-contains: scripts/autopilot/hooks/on-subagent-tool-call.sh :: ${XDG_STATE_HOME:-$HOME/.local/state}/hydra/dispatch-markers`
- INV-2: "HYDRA_DISPATCH_REGISTER_MARKER_DIR, when set, wins over XDG_STATE_HOME and HOME" — verified by: `file-contains: scripts/autopilot/hooks/on-subagent-tool-call.sh :: ${HYDRA_DISPATCH_REGISTER_MARKER_DIR:-$DEFAULT_MARKER_DIR}`
- INV-3: "The hook still exits 0 on every path: a failed mkdir -p, a failed marker write" — verified by: `file-contains: scripts/autopilot/hooks/on-subagent-tool-call.sh :: mkdir -p "${DISPATCH_REGISTER_MARKER_DIR%/}" 2>/dev/null || true`
- INV-4: "Pruning runs only on the marker WRITE path (once per dispatch, after the positive write" — verified by: `occurrences: scripts/autopilot/hooks/on-subagent-tool-call.sh :: -mtime +1 -delete == 1`
- INV-5: "Pruning is confined to the resolved marker dir: -maxdepth 1 -type f -name" — verified by: `file-contains: scripts/autopilot/hooks/on-subagent-tool-call.sh :: -maxdepth 1 -type f`
- INV-6: "Steady-state bound: the marker dir holds at most the markers written in the trailing" — verified by: `file-contains: scripts/autopilot/hooks/on-subagent-tool-call.sh :: -mtime +1 -delete`
- INV-7: "The negative 'none' marker shares the dir, name prefix and prune rule with positive" — verified by: `file-contains: scripts/autopilot/hooks/on-subagent-tool-call.sh :: write_child_marker none`
- INV-8: "No new env var and no change to docs/generated/env-vars.json: the inventory records" — verified by: `file-lacks: docs/generated/env-vars.json :: HYDRA_DISPATCH_MARKER`

## Acceptance criteria

- [ ] Default marker dir outside /tmp — verified by: `npm run test:file -- test/on-subagent-tool-call.test.mts` exits 0
- [ ] Stale markers pruned by age — verified by: the same test file, subtest "default marker dir is under XDG_STATE_HOME, not /tmp, and stale markers are pruned (#5336)"
- [ ] `npm test` green

Note: INV-8 held for the env var (none added) but the generated inventory gained one HOME read site for the hook, so `docs/generated/env-vars.json` was regenerated (drift guard).
The full `npm test` also showed `test/session-block.test.mts` "second out-of-credits POST naming the PRIMARY model" failing, in code this PR does not touch.

Glossary impact: none. ADR impact: none.

Closes #5336


🤖 Generated with [Claude Code](https://claude.com/claude-code)
