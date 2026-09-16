<!-- Fragment: target-self-isolation-preamble (issue #4476). Included by
hydra-autopilot.md (the dispatch preamble for every self-isolated class) and
hydra-target-build.md Step 0.6 (the canonical create+verify block). Must NOT
itself @include anything (sync-skills @include is single-level). Target paths
resolve through the seam vars exported by _fragments/target-seam-preamble.md
($TARGET_WS, $TARGET_APP_DIR) — never a Target-identity literal. -->

**Self-isolated Target classes (issue #4476).** A dispatch whose plan action
carries `isolation: "self"` (decide.py `TARGET_ISOLATION` — every Target-scope
class whose playbook mutates the Target tree) is launched WITHOUT harness
`isolation="worktree"`: the harness fence only covers the orchestrator repo,
and the Target workspace is a sibling repo, so a pinned session is refused
every git mutation / file write inside it (#3889). Such a class isolates
ITSELF in a Target worktree. Its dispatch prompt carries the variant below
INSTEAD of the default worktree-guard block — it REPLACES the default, never
composes with it (the default's cwd-ABORT clause describes exactly this
class's expected launch state, the #4178 false-abort trap).

```
## CRITICAL SAFETY RULE — READ FIRST (self-isolation variant, issue #4476)
This dispatch is NOT harness-worktree-isolated (#3889); it isolates itself.
- EXPECTED at launch: pwd == /home/gabe/hydra, `git rev-parse --git-dir`
  returns `.git` (not a `.git/worktrees/...` path). This is NOT an abort
  condition. Do NOT abort on it, and do NOT cd into either main checkout.
- FORBIDDEN from launch onward: any Edit/Write/Bash file mutation under the
  orchestrator main checkout /home/gabe/hydra, and any mutation of the Target
  main checkout $TARGET_WS (resolved by your skill's target-seam preamble)
  outside the Target worktree you create. Both main checkouts are read-only
  to you; pure reads (Read, rg, git log, curl, gh) are fine.
- Before the FIRST Target mutation, create the Target worktree at
  $TARGET_APP_DIR/.worktrees/<id> with the create+verify block (hydra-target-build
  Step 0.6 carries it verbatim), and verify `git rev-parse --git-common-dir`
  == $TARGET_WS/.git AND `git rev-parse --git-dir` contains `.git/worktrees/`.
- PRECEDENCE: any git operation your own playbook prescribes against the
  Target main checkout (fetch/ff-merge, checkout -b/commit/push, stash,
  checkout of a PR head) runs with cwd = $TARGET_WT instead — never against
  $TARGET_WS itself. Branch the worktree off the base your playbook needs
  (TARGET_WT_BASE, default origin/main; qa_target uses the PR head).
- ABORT only if the Target worktree creation or its rev-parse verification
  fails. No fallback to either main checkout.
```

Canonical create+verify block — the ONE source for creating a Target worktree
(hydra-target-build Step 0.6 and every self-isolated class run exactly this):

```bash
# Inputs: $TARGET_WS / $TARGET_APP_DIR (target-seam preamble), CYCLE_ID (this
# cycle's / dispatch's unique id), TARGET_WT_BASE (optional base ref; defaults
# to origin/main — qa_target sets it to the PR head, e.g. origin/<headRefName>).
#
# Nested under $TARGET_APP_DIR (= $TARGET_WS + $TARGET_APP_SUBDIR) — issue
# #4177 — NOT /dev/shm. Node's upward module-resolution walk from a file inside
# the worktree finds the REAL $TARGET_APP_DIR/node_modules as an ancestor (the
# same mechanism `~/hydra/.claude/worktrees/` relies on — see CLAUDE.md), so
# there is no per-worktree `npm ci` and no reach-back `node_modules` symlink
# (the 2026-08-19 incident, issue #4175). NEVER symlink node_modules into it.
#
# MUST be nested directly under $TARGET_APP_DIR, not $TARGET_WS/.worktrees/:
# only a `.worktrees` dir living inside $TARGET_APP_DIR puts
# $TARGET_APP_DIR/node_modules on the walk from `<wt>/$TARGET_APP_SUBDIR/src/foo.ts`.
# (When $TARGET_APP_SUBDIR is empty — the successor Target's declared shape,
# ADR-0013 amendment — $TARGET_APP_DIR equals $TARGET_WS and this collapses to
# nesting directly under the workspace root, which is still correct: the
# ancestor walk needs the worktree under whatever directory owns node_modules.)
TARGET_WT_BASE="${TARGET_WT_BASE:-origin/main}"
TARGET_WT="$TARGET_APP_DIR/.worktrees/${CYCLE_ID}"
mkdir -p "$(dirname "$TARGET_WT")"

# Ensure the base is fresh before branching off.
git -C "$TARGET_WS" fetch origin --prune
git -C "$TARGET_WS" worktree add -b "feature/${CYCLE_ID}" "$TARGET_WT" "$TARGET_WT_BASE"

cd "$TARGET_WT"

# Verify isolation — ABORT if either check fails. Do NOT proceed on the main checkout.
COMMON_DIR=$(git rev-parse --git-common-dir)
GIT_DIR=$(git rev-parse --git-dir)
case "$COMMON_DIR" in
  "$TARGET_WS/.git"|*"/$(basename "$TARGET_WS")/.git") ;;
  *) echo "ABORT: target worktree common-dir is $COMMON_DIR (expected $TARGET_WS/.git)" >&2; exit 1 ;;
esac
case "$GIT_DIR" in
  *"/.git/worktrees/"*) ;;
  *) echo "ABORT: target cwd is not a worktree (git-dir=$GIT_DIR)" >&2; exit 1 ;;
esac
```

From that point on every Edit/Write/Bash file mutation against the Target uses
worktree-anchored paths (`$TARGET_WT/...`) only. The installed
`worktree-write-fence.sh` PreToolUse hook provides the ghost-write protection
harness isolation plays for the orchestrator-only classes.
