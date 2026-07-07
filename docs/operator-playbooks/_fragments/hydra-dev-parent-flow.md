# hydra-dev — PARENT flow (dispatcher)

You reached this file because you are the **PARENT** (you have an `Agent`/`Task`
spawn tool, or the operator is running you interactively to dispatch work). Run
Pre-flight → Spawn worktree agent → Post-agent reaping. The CHILD execution
contract lives in the sibling `hydra-dev-child-flow.md`.

## Pre-flight

### 1. Select issue

If `$issue_number` provided, use it. Otherwise:
```bash
gh issue list --repo gaberoo322/hydra --label "ready-for-agent" --state open --json number,title --jq '.[0]'
```
None → report and stop.

### 2. Fetch and validate
```bash
gh issue view $issue_number --repo gaberoo322/hydra
```
Verify structured sections (acceptance criteria or "What to build"). Vague
one-liner → stop, tell operator to run `/triage` first.

### 3. Size check — decompose if too large

If body has **>5 acceptance criteria** OR description suggests **>8 files changed**:
1. `/to-issues $issue_number` to decompose (Claude) or `codex exec --skill to-issues` (Codex)
2. `gh issue edit $issue_number --add-label blocked --remove-label ready-for-agent`
3. Comment on parent listing children
4. Stop — `/hydra-sweep` picks up children after triage

### 3.5 Scope contract (issue #396)

Before dispatching, confirm the issue body contains a `## Files in scope` section
(and ideally a `## Files out of scope` section). The CI `scope-check` gate treats
both sections as authoritative:

- Anything in **Files in scope** is fair game.
- Anything in **Files out of scope** is a HARD merge blocker — touching it fails
  CI regardless of the ratio threshold.
- The only escape hatch is for the subagent to add a `scope-justification:` block
  to its PR body listing the specific files it had to touch and why.

If the issue is missing `## Files in scope`, stop and re-triage. The
`issue-label-validation` workflow blocks the `ready-for-agent` label transition
when this section is missing, so this should be rare — but a freshly-labelled
issue may still need a one-time correction.

> **Code-span trap (recurring friction `scope-check-codespan-trap`):** the
> `scope-check` parser unions **every** backticked code-span it finds *anywhere
> inside* the `## Files in scope` / `## Files out of scope` sections into the
> scope set — not just the bullet-list entries. So a backticked filename buried
> in prose under those headings becomes a phantom scope entry that can HARD-block
> an otherwise in-scope file. Keep filenames in such prose **plain-text** (no
> backticks); reserve backticks for the actual bullet-list path entries.

The dispatched child prompt MUST include the scope-respect block below.

### 4. Mark in-progress
```bash
gh issue edit $issue_number --remove-label ready-for-agent --add-label in-progress
```

### 5. Spawn worktree agent

- **Claude:** `Agent(isolation: "worktree", prompt: <child-prompt>)`
- **Codex:** Create worktree first, then `codex exec` inside it:
  ```bash
  WT=/dev/shm/hydra-worktrees/issue-${issue_number}-$(date +%s)
  git -C ~/hydra worktree add -b "issue-${issue_number}-dev" "$WT" master
  # MANDATORY: /dev/shm worktrees have no ancestor node_modules — symlink first.
  # (cue: devshm-verify-worktree-needs-node-modules-symlink)
  ln -sfn /home/gabe/hydra/node_modules "$WT/node_modules"
  (cd "$WT" && codex exec --skill hydra-dev-child --json "{\"issue\":${issue_number}}")
  ```

**Branch held by a stale sibling worktree (cue:
pr-branch-checked-out-in-stale-sibling-worktree).** `git worktree add -b
issue-N-…` fails with `fatal: '<branch>' is already used by worktree …` when a
prior dispatch's worktree still holds that branch. Do NOT delete the other
worktree, do NOT `git branch -D` the held branch, do NOT fall back to the main
tree. Recover on a differently-named local branch and push via refspec:
```bash
git fetch origin "$REMOTE_BRANCH"
git checkout -b "${REMOTE_BRANCH}-r$(date +%s)" FETCH_HEAD  # fresh local name
# …edit, commit, verify…
git push origin "HEAD:${REMOTE_BRANCH}"  # refspec push updates the PR branch
```

**`/dev/shm` worktree has no `node_modules` (cue:
devshm-verify-worktree-needs-node-modules-symlink).** Worktrees under
`~/hydra/.claude/worktrees/` resolve `node_modules` through Node's upward walk,
but `/dev/shm/hydra-worktrees/` worktrees have no such ancestor. Symlink instead
of a slow `npm ci`: `ln -sfn /home/gabe/hydra/node_modules "$WT/node_modules"`.
`git worktree move` does NOT carry the symlink — re-create it after any move.
And that symlink then leaks into the PR diff if you `git add -A` (cue:
worktree-node-modules-symlink-stages-as-file) — `.gitignore`'s `node_modules/`
trailing slash matches a directory, not the symlink-as-file. After staging, run
`git reset -q -- node_modules` and confirm `git status --porcelain node_modules`
is empty before committing. Prefer staging touched files by path.

The child prompt MUST include the worktree-guard preamble, the PATH ANCHORING
block, the ENTERWORKTREE ANCHOR block, and the scope-respect block (all in
`hydra-dev-child-flow.md`). The child runs the child execution contract there.

### Child-prompt worktree-guard preamble (REQUIRED)

Every dispatched hydra-dev BG agent prompt MUST begin with the following block,
verbatim (the parent prepends it before the task body):

```
## CRITICAL SAFETY RULE — READ FIRST

Before doing ANYTHING else, run `pwd` and check:
- If cwd is a fresh worktree (path under `/dev/shm/hydra-worktrees/`, `/home/gabe/hydra-worktrees/`, or `/home/gabe/hydra/.claude/worktrees/`) AND `git rev-parse --git-dir` returns a path under `.git/worktrees/`, proceed.
- If cwd is `/home/gabe/hydra` (the main repo working tree), **ABORT IMMEDIATELY**. Return a failure status with the message: "Worktree isolation broken — cwd is main repo. Refusing to proceed per operator memory feedback_bg_agent_worktree_hygiene. Do not run any git commands."

Do NOT fall back to running in `~/hydra`. Do NOT create a branch in the main tree. Do NOT `git checkout` in the main tree. If isolation failed, the only acceptable action is to fail loudly.
```

If the harness exposes `EnterWorktree`/`ExitWorktree`, the child should call
`EnterWorktree` only when its initial `pwd` check fails the worktree predicate.

### Child-prompt path-anchoring contract (REQUIRED — issue #1861)

Append immediately after the worktree-guard preamble. It is the prompt-side half
of the `worktree-write-fence.sh` PreToolUse hook — anchoring paths correctly from
the first turn avoids the wasted recovery turns a deny would cost (the single
most recurring friction pattern, #1861):

```
## PATH ANCHORING — every file op stays inside the worktree (issue #1861)

Your cwd is a git worktree, but Read/Edit/Write/MultiEdit resolve absolute
paths against the raw filesystem, NOT the worktree namespace. A path like
`/home/gabe/hydra/src/foo.ts` or `/home/gabe/hydra-betting/web/x.ts` points at
the MAIN checkout, not your worktree copy. Reading or writing it ghost-writes
into the main tree (leaving your PR diff empty) or gets denied by the
worktree-write-fence (burning turns).

RULES:
1. Run `pwd` once and treat its output as your worktree root `$WT`.
2. For EVERY Read/Edit/Write/MultiEdit `file_path`, use a path that is either
   repo-relative (resolved against $WT) OR absolute and prefixed with `$WT/`.
   NEVER construct a bare `/home/gabe/hydra/...` or `/home/gabe/hydra-betting/...`
   path for a file you intend to read-for-editing or write — that is the main
   checkout.
3. If a Read/Edit/Write is DENIED by worktree-write-fence, the deny reason
   names the corrected `$WT/...` path. Re-issue the call against THAT path; do
   not try to recompute it or to `cd` out of the worktree.
4. Reading a main-tree-only file with NO worktree copy (a shared config the
   worktree never checked out, an adjacent project's file for reference) is
   allowed and passes the fence — but never base an Edit on such a path.
```

### Child-prompt EnterWorktree anchor contract (REQUIRED — issue #2371)

Append immediately after the PATH ANCHORING block. It resolves the
write-fence-blocks-a-valid-in-worktree-Edit symptom (#2371) — a **redundant**
`EnterWorktree` from an agent already launch-pinned to its worktree desyncs the
harness's single writable-root anchor from cwd, so a later valid in-cwd
Edit/Write is denied. The fix is preventive — don't trigger the redundant switch:

```
## ENTERWORKTREE ANCHOR — do not desync the writable root (issue #2371)

You were dispatched via Agent(isolation="worktree"), so the harness has already
LAUNCH-PINNED your writable-worktree root to your cwd. The harness tracks ONE
writable-root anchor per agent; a redundant or sibling EnterWorktree desyncs
that anchor from your cwd and makes a valid in-cwd Edit/Write get DENIED even
though the write is correct.

RULES:
1. NEVER call EnterWorktree when your launch-time `pwd` already satisfies the
   worktree predicate (i.e. `git rev-parse --git-dir` resolves under
   `.git/worktrees/`). You are already pinned — a redundant switch is exactly
   what breaks the anchor. Verify the predicate; if it holds, proceed straight
   to file ops, NO EnterWorktree.
2. If EnterWorktree WAS genuinely required (your initial pwd failed the
   predicate — a non-pinned dispatch), re-run `pwd` IMMEDIATELY after the switch
   and re-derive EVERY subsequent `file_path` from that fresh post-switch root.
   Never reuse a path captured before the switch.
3. If an in-worktree Edit/Write is STILL denied even though the file resolves
   inside your cwd, the anchor has desynced. RECOVER by re-anchoring:
   `ExitWorktree` then `EnterWorktree` by `path` (the harness's documented
   re-anchor path). Do NOT fall back to writing the file via `python3`/`Bash` —
   that shell-out bypasses the harness diff tracking and is the reactive
   workaround this contract exists to eliminate.
```

> Orthogonal note (issue #1861 / #549 — NOT the #2371 fix): the custom
> `worktree-write-fence.sh` PreToolUse ghost-write hook is currently
> *uninstalled* on this host. Installing it via `scripts/setup-claude-hooks.sh`
> closes the orthogonal ghost-write-to-main gap but does NOT resolve the #2371
> symptom above. Keep hook installation as a separate operator step.

### Child-prompt scope-respect block (REQUIRED — issue #396)

Append immediately after the worktree-guard preamble. It is the subagent-side
replacement for the deleted `reconcilePlanVsActual()` step:

```
## SCOPE CONTRACT — issue body is authoritative

The linked issue contains a `## Files in scope` section (mandatory) and may contain a `## Files out of scope` section. Before writing any code:

1. Extract both lists from the issue body.
2. Treat `Files in scope` as the SOFT boundary — every file you change should match one of these entries (substring/prefix match, so `src/foo/` covers everything beneath).
3. Treat `Files out of scope` as the HARD boundary — touching anything matching these entries will fail CI's scope-check gate. Do not touch them unless absolutely required.
4. If you DO have to touch an out-of-scope file (e.g. a shared test fixture, an adjacent import), include a `scope-justification:` block in the PR body listing each affected file with a one-line rationale. Example:

       scope-justification: `test/helpers/fixtures.ts` — fixture used by the new test added in scope

5. Mirror the issue's `## Files in scope` section into the PR body so the gate can match against either source.
6. CODE-SPAN TRAP: the scope-check parser treats EVERY backticked code-span inside the `Files in scope` / `Files out of scope` sections as a scope entry, not just the bullet paths. When you write those sections (or any prose under those headings), keep non-path filenames PLAIN-TEXT. A stray backticked filename in prose becomes a phantom entry that can hard-block one of your real in-scope files.

The CI `scope-check` job at `.github/workflows/ci.yml` enforces this contract.
```

## Post-agent reaping

### 6. Post-agent

**Success (PR URL returned):**

Transition the source issue `ready-for-agent`/`in-progress` → `needs-qa` so
`qa_orch` auto-fires on the open PR and the stale `ready-for-agent` can't
re-surface the issue for a duplicate dispatch (the #770/#754 hazard, root cause
of #846). Remove BOTH `ready-for-agent` AND `in-progress`, add `needs-qa`.
`gh issue edit --remove-label` is idempotent, so listing both is safe. The
transition is keyed by the **issue number** via raw `gh issue edit` — NOT
`moveItemToLane`, a `src/` helper this bash playbook cannot call.

```bash
gh issue edit "$issue_number" --repo gaberoo322/hydra \
  --remove-label "ready-for-agent" --remove-label "in-progress" \
  --add-label "needs-qa" \
  || echo "WARN: failed to move issue #${issue_number} to needs-qa (non-fatal) — relabel by hand"
```

Then unblock dependents:
```bash
DEPENDENTS=$(gh issue list --repo gaberoo322/hydra --label blocked --state open --json number,body \
  --jq "[.[] | select(.body | test(\"Blocked by.*#$issue_number(\\\\b|[^0-9])\")) | .number] | .[]")
for dep in $DEPENDENTS; do
  BLOCKERS=$(gh issue view $dep --repo gaberoo322/hydra --json body --jq '.body' | grep -oP '(?<=Blocked by.*#)\d+' | tr '\n' ' ')
  ALL_CLOSED=true
  for b in $BLOCKERS; do
    STATE=$(gh issue view $b --repo gaberoo322/hydra --json state --jq '.state')
    [ "$STATE" != "CLOSED" ] && ALL_CLOSED=false && break
  done
  [ "$ALL_CLOSED" = true ] && gh issue edit $dep --repo gaberoo322/hydra --remove-label blocked --add-label ready-for-agent
done
```

**Failure (including isolation-abort):**
```bash
gh issue edit $issue_number --remove-label in-progress --add-label ready-for-agent
gh issue comment $issue_number --body "> *Automated agent comment*

Agent attempted implementation but failed.

**Reason:** <failure reason>
**Branch:** <branch name or 'none — aborted before any git ops'>
**What was tried:** <approach summary>"
```

Isolation aborts must NOT escalate to `ready-for-human` — they are infrastructure
errors, not implementation failures. Re-label as `ready-for-agent` so the next
dispatch can retry once the harness recovers.

### 7. Post-dispatch sanity check (parent)

After the BG agent returns (success OR failure), verify the main tree is still clean:
```bash
MAIN_BRANCH=$(git -C ~/hydra rev-parse --abbrev-ref HEAD)
if [ "$MAIN_BRANCH" != "master" ]; then
  echo "WARN: ~/hydra is on '$MAIN_BRANCH', expected 'master'. Isolation likely broke."
  echo "WARN: Do NOT auto-fix without operator approval — feature branch may have unpushed work."
fi
```

#### 7a. Ghost-write canary (issue #549)

cwd confusion is caught above; a ghost-write (cwd is the worktree but an
Edit/Write landed in the main tree via an absolute `file_path`) is not. The
primary guard is the PreToolUse hook from `bash scripts/setup-claude-hooks.sh`.
The skill-side canary is belt-and-braces:
```bash
PRE_GHOST_SNAPSHOT=$(git -C ~/hydra diff --name-only HEAD 2>/dev/null || true)
# ... dispatch the BG agent ...
POST_GHOST_SNAPSHOT=$(git -C ~/hydra diff --name-only HEAD 2>/dev/null || true)
NEW_DIRTY=$(comm -13 <(printf '%s\n' "$PRE_GHOST_SNAPSHOT" | sort -u) \
                     <(printf '%s\n' "$POST_GHOST_SNAPSHOT" | sort -u))
if [ -n "$NEW_DIRTY" ]; then
  echo "WARN: main tree gained dirty files during this dispatch — likely an issue #549 ghost-write:"
  printf '%s\n' "$NEW_DIRTY"
  echo "WARN: Run 'python3 scripts/audit-ghost-writes.py' for forensic detail."
fi
```

### 8. Lesson capture on verification failure (issue #392)

When the BG agent returns a **failure** with `verification-failure`, `no-diff`,
or `rollback`, capture a learning hit (the only post-cycle writer to
`hydra:memory:executor:patterns` for Claude runs). Skip on success and on
infrastructure aborts.
```bash
curl -fsS -X POST http://localhost:4000/api/memory/subagent-lesson \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg skill "hydra-dev" \
    --arg outcome "verification-failure" \
    --arg cue "verification-failure" \
    --arg context "issue-${issue_number}: ${FAILURE_REASON}" \
    --arg cycleId "hydra-dev-${issue_number}-$(date +%s)" \
    '{skill: $skill, outcome: $outcome, cue: $cue, context: $context, cycleId: $cycleId}')"
```
Cues: `verification-failure` (npm test / typecheck / build failed), `no-diff`
(zero file changes), `rollback` (merged then auto-reverted). Idempotent on
`(skill, outcome, cue)`.

### 9. Friction Report (issue #512 — ALWAYS, even on success)

The child emits a `## Friction Report` section at the bottom of its return — even
on a clean success. Parse it and POST each item to
`/api/memory/subagent-friction`:
```bash
curl -fsS -X POST http://localhost:4000/api/memory/subagent-friction \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg skill "hydra-dev" \
    --arg cue "$CUE" \
    --arg workaround "$WORKAROUND" \
    --arg context "$CONTEXT" \
    --arg cycleId "hydra-dev-${issue_number}-$(date +%s)" \
    '{skill: $skill, cue: $cue, workaround: $workaround, context: $context, cycleId: $cycleId}')"
```
Idempotent on `(skill, cue)`; crossing 3 hits auto-opens a `meta-friction`
issue. Best-effort — a failed POST does not fail the build.
