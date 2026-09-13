**Run this FIRST, before any other step in this playbook.** It resolves every
Target identity fact and the Target Manifest's risk surface through the ONE
seam (`scripts/target/print-target-facts.ts`, issue #4411) instead of a
hardcoded Target-identity literal. `src/target-config.ts` is the only owner of
defaults (ADR-0002) — this playbook never restates one. The autopilot session
env carries NO `HYDRA_TARGET_*` vars (`pace-gate.service` sets only
`HOME`/`PATH`), so a bare `$HYDRA_TARGET_*` read in prose would be empty; every
literal below is composed through this preamble instead.

```bash
# {{SKILL_NAME}}: resolve the Target seam. Aborts loudly on failure — a
# playbook must never proceed with an empty or guessed Target identity/risk
# surface (fail closed, mirroring decide.py's wire_or_retire_target
# withhold-on-unresolved invariant).
#
# NOTE: on failure, `--sh` mode writes NOTHING to stdout (only stderr) and
# exits 1 — so `eval "$(... --sh)" || abort` never fires: `$(...)` captures
# an empty string, and `eval ""` is a no-op that returns 0. Capture the
# output and its exit status SEPARATELY so the failure path actually aborts.
_target_seam_sh="$(cd "$HOME/hydra" && npx tsx scripts/target/print-target-facts.ts --sh)"
_target_seam_rc=$?
if [ "$_target_seam_rc" -ne 0 ]; then
  echo "ABORT: target seam unresolved (print-target-facts.ts failed) — see stderr above" >&2
  exit 1
fi
eval "$_target_seam_sh"
unset _target_seam_sh _target_seam_rc
```

This exports:

- `$TARGET_NAME` — the target slug (`getTargetName()`)
- `$TARGET_GH_REPO` — `owner/repo` (`getTargetGithubRepo()`) — use for every `gh … --repo "$TARGET_GH_REPO"` call, never a literal repo
- `$TARGET_WS` — the target workspace absolute path (`getTargetWorkspace()`) — the root a per-cycle worktree branches from
- `$TARGET_SERVICE` — the systemd unit name (`getTargetServiceName()`) — use for `journalctl --user -u "$TARGET_SERVICE"` / `systemctl --user status "$TARGET_SERVICE"`
- `$TARGET_WEB_URL` — the target's web base URL (`getTargetWebUrl()`) — probe `$TARGET_WEB_URL/api/health` etc., never a hardcoded port
- `$TARGET_APP_SUBDIR` — the manifest's `verify.appSubdir` (may be empty — the successor Target's declared shape, ADR-0013 amendment)
- `$TARGET_APP_DIR` — `$TARGET_WS` joined with `$TARGET_APP_SUBDIR` (empty subdir is the identity) — the directory the build/test/typecheck commands run from; never assume a bare `web/` nesting
- `$TARGET_RISK_SURFACE_JSON` — the manifest's `riskCritical.surface`, repo-relative-joined against `$TARGET_APP_SUBDIR`, JSON-encoded — the machine-readable carve-out `hydra-wire-or-retire` matches module paths against

For domain knowledge this playbook needs (research angles, incident families,
series/venue vocabulary, design-language rules) — read the target's own docs,
never restate them here: `$TARGET_WS/CONTEXT.md`, `$TARGET_WS/direction/vision.md`,
`$TARGET_WS/docs/agents/domain.md`.
