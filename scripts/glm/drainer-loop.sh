#!/usr/bin/env bash
#
# drainer-loop.sh — the GLM dev-drainer tick (issue #3689, ADR-0032, as
# amended by #3753/#3758).
#
# Fired every ~15 min by hydra-glm-drainer.timer (mirrors the pace-gate
# oneshot+timer shape — scripts/systemd/hydra-glm-drainer.{service,timer}).
# One tick does, in order:
#
#   1. Acquire a flock lockfile (concurrency=1, kernel auto-release — NEVER a
#      Redis lock; ADR-0032 Decision 6 / invariant 5). A tick that FAILS to
#      take the lock (another tick's authoring run is still in progress —
#      API_TIMEOUT_MS is 50 min, well past this timer's 15-min cadence) still
#      refreshes the heartbeat unconditionally (2026-07-27 AMENDMENTS #3: a
#      run in progress is positive liveness evidence) and exits.
#   2. Kill-switch: honor ONLY the operator's durable pause flag (read from
#      Redis via `getAutopilotPaused()` in src/glm/gate.ts — steps 2-4 are
#      the gate phase, issue #4682) — deliberately IGNORE Anthropic
#      `emergencyStop` / `paceState` / `weeklyEmergencyStop` (ADR-0032
#      Decision 6 / rejected-alternatives: GLM runs on z.ai's OWN quota, so
#      pausing on Anthropic exhaustion would sleep exactly when most needed).
#   3. Daily PR cap: a date-stamped counter file bounds PRs/day
#      (`HYDRA_GLM_DRAINER_DAILY_CAP`, default 5) — a risk control bounding
#      blast radius (concurrency=1 + identical QA + CI), not a throughput
#      target.
#   4. Heartbeat: written ONLY once past both gates above — "able to author",
#      never "the process ran" (AMENDMENTS #2). Written through the typed
#      Redis accessor `setGlmDrainerHeartbeat` in `src/redis/autopilot.ts`
#      (CLAUDE.md Redis-seam rule: never a raw client) by the gate phase
#      itself on `able` (ADR-0040 Decision 2); bash writes it only on the
#      lock-held path of step 1 — see `write_heartbeat()` / `run_driver()`
#      below (issues #4371, #4682).
#   5. Crash recovery: any `glm-eligible` issue stuck `in-progress` for >90
#      min is re-queued via the EXISTING `scripts/autopilot/recover-stale.sh`
#      (reused, not reimplemented, per the issue body).
#   6. Pick a `glm-eligible` + `ready-for-agent` issue (oldest first) that
#      is GRILL-CLEAR (issue #4286): either an APPROVED design-concept
#      artifact (`GET /api/design-concepts/issue-<N>`,
#      `.status == "approved"`) — `design_concept_orch` designs every
#      grillable glm-eligible issue before the drainer may touch it
#      (ADR-0032 Decision 1) — or one of the two by-construction
#      exemptions collect-state.sh's grill gate applies before pinning
#      dev_orch: the `cleanup-scan` label (#1230, mechanical,
#      unconditional) or an `Expected tier: T1` body stamp (#1088,
#      trivial, suppressed by needs-design-concept). See src/glm/pick.ts
#      (issue #4686) — the grill arm is `glmGrillExemption`, guarded by the
#      parity table in test/autopilot-grill-gate.test.mts. Also skips any candidate
#      that already has an open PR referencing it (`Closes #<n>` or
#      equivalent in an open PR body) — the open-PR pre-dispatch gate other
#      classes already apply, closing the duplicate-dispatch hole from issue
#      #3900 — or a MERGED PR already referencing it (closing keyword in
#      title/body, or the repo's "(#<n>)" PR-title anchor convention): a
#      merged PR whose body lacked a closing keyword leaves the issue open,
#      and re-dispatching it re-implements merged code every tick (issue
#      #4130, whose fix merged as #4236 and was re-picked the same day).
#   7. Claim it: `ready-for-agent` → `in-progress` (the same label swap
#      hydra-dev's PARENT flow does before spawning a worktree agent —
#      docs/operator-playbooks/_fragments/hydra-dev-parent-flow.md step 4).
#   8. Create a fresh worktree (mirrors that same playbook's Codex/no-spawn-
#      tool branch, since this loop has no `Agent` tool either) and run
#      `hydra-dev` HEADLESS in it, under the GLM-fenced env
#      (`src/glm/drainer-runner.ts` buildGlmEnv/buildDrainerArgs/
#      runGlmClaude) + `--settings config/glm/drainer-settings.json` (gamma,
#      issue #3688) — which deliberately withholds `gh pr create` so the
#      authoring session cannot route around the output gate. See
#      `compose_prompt()` for how the authoring session hands its intended PR
#      body back to this loop despite that denial. Issue #4337 INV-5: BEFORE
#      creating a worktree, `pickResumeBranch` (src/glm/pick.ts) looks for a pushed
#      `worktree-agent-glm-<issue>-*` head from a PRIOR timed-out session —
#      the pushed branch IS the resume record (no new label, no Redis key,
#      no state.json write: the drainer never touches the Claude lane's
#      #3866 backstop, INV-8) — and `create_worktree()` checks it out as-is
#      so the resumed session continues committed work instead of re-paying
#      a full authoring window from scratch.
#   9. Finish phase (issue #4685, ADR-0040 Decisions 1-3): everything after
#      the author session lives in src/glm/finish.ts, driven by ONE
#      `run_driver finish` call — the three post-author arms distinguished by
#      evidence (driver FAULT / fail-closed not-run / ran-and-ended, #4337
#      INV-2), the salvage ladder (release-not-authored /
#      release-nothing-produced / keep-partial-for-resume /
#      withhold-preflight-blocked / release-after-failed-pr / open-pr, INV-3/
#      INV-4), and preflight (secret-scan + Verifier-Core/T4 diff gate,
#      preflightBeforePr) called IN-PROCESS by runFinish — never a separate
#      bash step. A TIMED-OUT session whose worktree has >=1 commit ahead of
#      origin/master AND a non-empty .glm-drainer-pr-body.md takes the
#      IDENTICAL push -> preflight -> open-pr fence (the PR is a normal PR,
#      never a draft) with one addition — a trailing plain-text note
#      discloses the cutoff (TIMEOUT_NOTE in finish.ts). Commits WITHOUT a
#      pr-body are KEPT on origin for the resume above instead of deleted
#      (INV-4); repeated PR-less timeouts hand the issue to the Claude lane
#      via glm-withhold once the per-issue counter reaches TIMEOUT_RESUME_CAP
#      (INV-6).
#  10. PR open + bookkeeping (also finish.ts, not bash): `gh pr create
#      --label glm-authored` (ADR-0032 Decision 5 — provenance by label
#      FIRST; issue #4048: the branch create_worktree() builds below inserts
#      a literal `glm` segment — `worktree-agent-glm-${issue}-${ts}` — that
#      Opus dev_orch's hex-hash branches can never contain, so the exact
#      prefix `worktree-agent-glm-` discriminates the drainer's PRs
#      perfectly). On a create failure the finish phase NEVER parses the
#      error text: it LISTS open PRs for the head branch and ADOPTS a match
#      (ANOMALY log + best-effort glm-authored relabel through `gh issue
#      edit` on the PR number — `gh pr edit` is broken for labels here,
#      ADR-0034 §7) instead of discarding it (issue #3900). The advance arm
#      relabels needs-qa, resets the per-issue timeout counter, increments
#      the daily-cap file, and removes the worktree. All of it rides the
#      GitHub CLI Adapter seams (editIssueLabels / createPr /
#      worktreeRemove / pushBranchUpstream / deleteRemoteBranch in
#      src/github/) — no gh/git process outside those modules.
#
# Amendment (issue #4273) — z.ai quota block: a weekly/monthly z.ai 429
# leaves the drainer live but sterile — every tick claims an issue, authors
# nothing, and releases it, while step 4's heartbeat keeps firing "able"
# regardless, which dead-arms the board-state fail-open that is supposed to
# hand ready-for-agent work to dev_orch when the GLM lane genuinely cannot
# produce (issue #3754 / the ADR-0032 #3753 amendment). A THIRD pre-heartbeat
# skip closes this: when `attempt_one_issue`'s existing "nothing usable
# produced" (commits=0) branch sees a 429 in the authoring stdout, it records
# a self-expiring block (a single epoch-seconds file under CAP_DIR, the same
# mechanism as the daily-cap counter — NOT a new Redis key); a subsequent
# tick that starts while that block is active is skipped by the gate phase
# BEFORE any heartbeat, so the heartbeat lapses honestly and the existing 45-min staleness
# fallback fires with zero changes to any heartbeat consumer. The block is
# recorded by the finish phase (src/glm/finish.ts — `parseQuotaBlockStdout`
# / `recordQuotaBlockIf429`, issue #4685) and read by the gate phase
# (src/glm/gate.ts); see docs/adr/0032-glm-dev-drainer-worker-lane.md's
# amendment paragraph.
#
# Investigation note (issue #3900's open question): does the authoring
# session itself reach `gh pr create` despite step 8's `--settings` fence
# withholding it? Verified live, same methodology as PR #3701/#3790 (a
# throwaway `--settings` file + a headless `claude -p` run, observed
# directly, not inferred) — `claude -p --settings config/glm/drainer-settings.json
# --output-format json` asked to run `gh pr create` returned
# `permission_denials: [{tool_name: "Bash", tool_input: {command: "gh pr
# create ..."}}]` and `result: "The command requires user approval and
# wasn't executed — no PR was created."` The fence holds — CONFIRMED NO GAP,
# not the mechanism behind the "already exists" collisions the finish phase
# now adopts instead of discarding. The more likely explanation
# (not independently verified here, and not load-bearing for this fix either
# way): `gh pr create` server-side PR creation and its separate
# `--label glm-authored` mutation are not atomic, so a prior tick's LOOP-side
# `gh pr create` call can create the PR and then fail non-zero on the label
# step, or `gh` can time out after the server has already committed the
# create. Either way the finish phase's adopt-on-collision fallback
# (src/glm/finish.ts) treating "already exists" as adoption rather than a
# genuine failure, and the pick phase (src/glm/pick.ts) skipping issues
# with an existing open PR, both hold regardless of which of these produced
# the original PR.
#
# The z.ai credential (`ANTHROPIC_AUTH_TOKEN`) arrives via a systemd
# `EnvironmentFile` this script never reads directly — `buildGlmEnv` in
# `src/glm/drainer-runner.ts` is the ONE place that resolves it, and it is
# fail-closed by construction (issue #3688 invariant 7): an absent/blank
# token aborts THAT authoring attempt (`glm-auth-token-missing`) rather than
# falling back to Anthropic quota. On a machine where the credential file is
# not yet provisioned, every tick still runs its kill-switch/cap/heartbeat
# logic and fails closed only at the authoring step — this is EXPECTED
# behavior, not a bug to route around.
#
# Style + testability (mirrors scripts/autopilot/pace-gate.sh)
# --------------------------------------------------------------------------
# `set -uo pipefail` (not `-e`: too many multi-step gh/git sequences below
# need to survive one failed sub-step and log+continue rather than abort the
# whole tick — the never-throw-from-verification spirit applied to bash).
# Every exit path is an explicit `exit 0` so a known skip/failure never marks
# the systemd unit "failed" — only a genuinely unexpected fault should alarm
# the watchdog. Quiet on the common skip paths (one log line each).
#
# Testability hooks (off-by-default; exercised by test/glm-drainer-loop.test.mts):
#   HYDRA_GLM_DRAINER_DRY_RUN=1
#       Every mutating/network action (heartbeat write, recover-stale, issue
#       label edits, worktree create, the claude authoring spawn, git push,
#       gh pr create, the cap/quota/timeout counter writes) logs
#       "would-<action>" and no-ops instead of executing. Lets the test drive
#       the flock control-flow with no gh/git/claude dependency, exactly like
#       HYDRA_PACE_GATE_DRY_RUN. Each phase honors it where it lives: the
#       gate phase still READS its inputs under dry-run (pause flag, cap and
#       quota-block files) and logs "would-heartbeat" on able; the finish
#       phase (src/glm/finish.ts) makes ZERO gh/git/preflight/file-write
#       calls and logs one "would-" line per skipped effect.
#   HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL
#       Override the design-concepts API base (default
#       http://localhost:4000/api/design-concepts).
#   HYDRA_GLM_DRAINER_LOCKFILE / HYDRA_GLM_DRAINER_CAP_DIR
#       Override the flock lockfile path / the daily-cap counter file's
#       directory, so parallel test runs and production never collide.
#   HYDRA_GLM_DRAINER_DAILY_CAP
#       Override the daily PR cap (default 5).
#   HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP
#       Override the per-issue timeout retry cap (default 2, issue #4337
#       INV-6) — the number of accumulated PR-less authoring timeouts after
#       which the release adds glm-withhold and the Claude lane takes over.
#   HYDRA_GLM_DRAINER_QUOTA_RESET_TZ_OFFSET
#       Override the timezone offset (default +0800 / Asia/Shanghai,
#       measured against the journal — issue #4273) used to interpret z.ai's
#       429 "reset at YYYY-MM-DD HH:MM:SS" clause.
#   HYDRA_AUTOPILOT_REPO
#       Override the GitHub repo (default gaberoo322/hydra) — same var name
#       recover-stale.sh already reads, so one override affects both.
#   HYDRA_GLM_DRAINER_REPO_ROOT
#       Override the checkout whose scripts/, src/, worktree base and
#       recover-stale.sh this tick uses (defaults to this script's own repo).
#       The committed driver's relative imports resolve against wherever
#       scripts/glm/drainer-driver.ts itself lives — this var selects WHICH
#       checkout that is, by choosing the path run_driver() invokes.
#
# Source of truth: this file at scripts/glm/drainer-loop.sh. Deployed to the
# live host by `scripts/deploy.sh` (same convention as pace-gate.sh); the
# systemd units invoke it via its in-repo path directly (WorkingDirectory
# already anchors %h/hydra).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${HYDRA_GLM_DRAINER_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

REPO="${HYDRA_AUTOPILOT_REPO:-gaberoo322/hydra}"
DRY_RUN="${HYDRA_GLM_DRAINER_DRY_RUN:-0}"
LOCKFILE="${HYDRA_GLM_DRAINER_LOCKFILE:-/tmp/hydra-glm-drainer.lock}"
# The CAP_DIR mkdir below is bash's one remaining responsibility for it: the
# gate (read side) and finish (write side) phases own every counter file
# under it (src/glm/gate.ts, src/glm/finish.ts — ADR-0040 Decision 3).
CAP_DIR="${HYDRA_GLM_DRAINER_CAP_DIR:-/tmp}"
WORKTREE_ROOT="${HYDRA_GLM_DRAINER_WORKTREE_ROOT:-/home/gabe/hydra/.claude/worktrees}"
LABEL_READY="ready-for-agent"
LABEL_IN_PROGRESS="in-progress"

log() {
  # STDERR, deliberately: several helpers below return a value via stdout
  # (`echo "$branch|$wt"`, `echo "true"`, a driver's JSON line, …) and are
  # invoked through `$(...)` command substitution — a log() line on stdout in
  # the same function would silently concatenate into that captured value.
  # Bit exactly this during manual DRY_RUN smoke-testing of this script
  # (create_worktree's DRY_RUN branch logged AND echoed on stdout, corrupting
  # the `branch|wt` pair the caller parsed) — fixed once, here, rather than
  # auditing every call site.
  echo "hydra-glm-drainer: $*" >&2
}

# ---------------------------------------------------------------------------
# Committed driver — the bash↔TypeScript bridge
# ---------------------------------------------------------------------------
#
# Bash cannot import a TS module directly. The bridge program used to be a
# ~90-line heredoc regenerated to a /tmp file every tick (invisible to
# tsc/ast-grep/direct unit tests — issue #4371); it now lives as a committed,
# typechecked file: logic in src/glm/drainer-driver.ts (runDriverMode), thin
# CLI entrypoint in scripts/glm/drainer-driver.ts (mirrors the
# scripts/tier-classify.ts -> src/tier-classifier.ts precedent). Every mode
# prints exactly one JSON line to stdout; a non-zero exit means the DRIVER
# ITSELF faulted (bad argv, an unknown mode, a rejecting dependency) —
# distinct from a mode's own result carrying `ok:false` (e.g. a blocked
# preflight is a completed, successful CHECK whose verdict is negative).
run_driver() {
  local mode="$1"
  shift || true
  node --experimental-strip-types "$REPO_ROOT/scripts/glm/drainer-driver.ts" "$mode" "$@"
}

# ---------------------------------------------------------------------------
# Step 4 — heartbeat
# ---------------------------------------------------------------------------

write_heartbeat() {
  local reason="$1" # "able" | "blocked" — log context only
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-heartbeat (reason=$reason, DRY_RUN=1)"
    return 0
  fi
  local out rc=0
  out="$(run_driver heartbeat 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    log "WARN heartbeat write failed (reason=$reason): $out"
  else
    log "heartbeat written (reason=$reason)"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Step 1 — flock
# ---------------------------------------------------------------------------

acquire_lock_or_heartbeat_and_exit() {
  exec 9>"$LOCKFILE"
  if ! flock -n 9; then
    log "flock blocked (another drainer tick is still authoring) — refreshing heartbeat (AMENDMENTS #3) and exiting"
    write_heartbeat "blocked"
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Steps 3/3.5/9/10 state + salvage bookkeeping (daily-cap counter, per-issue
# timeout counters, the z.ai quota-block file, release/advance label writes,
# PR open + adoption) live in the finish phase now — src/glm/finish.ts,
# driven by `run_driver finish` (issue #4685, ADR-0040 Decisions 1-3). The
# gate phase (src/glm/gate.ts) keeps the READ sides. File paths and formats
# are shared between the two TS modules (ADR-0040 Decision 3):
#   ${CAP_DIR}/hydra-glm-drainer-daily-cap-<UTC YYYY-MM-DD>   bare integer
#   ${CAP_DIR}/hydra-glm-drainer-quota-blocked-until          bare epoch secs
#   ${CAP_DIR}/hydra-glm-drainer-timeouts-<issue>             bare integer
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Step 7 — claim (the claim half stayed in bash; the release half is
# finish.ts's editIssueLabels)
# ---------------------------------------------------------------------------

claim_issue() {
  local issue="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-claim issue #$issue ($LABEL_READY -> $LABEL_IN_PROGRESS, DRY_RUN=1)"
    return 0
  fi
  gh issue edit "$issue" --repo "$REPO" --remove-label "$LABEL_READY" --add-label "$LABEL_IN_PROGRESS" \
    || log "WARN failed to claim issue #$issue (non-fatal, continuing)"
}

# release_claim_fallback <issue> [wt]
# Best-effort bash-side release for when the finish driver ITSELF faulted
# (Node crash, import failure, bad argv): finish.ts never ran its release arm,
# so without this the claim sits in-progress and the worktree leaks until
# recover-stale's 90-min requeue. Never fatal; the remote branch is left alone
# (it may carry pushed work the resume path wants).
release_claim_fallback() {
  local issue="$1" wt="${2:-}"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-release-claim-fallback issue #$issue (DRY_RUN=1)"
    return 0
  fi
  gh issue edit "$issue" --repo "$REPO" --remove-label "$LABEL_IN_PROGRESS" --add-label "$LABEL_READY" \
    >/dev/null 2>&1 \
    || log "WARN fallback claim release failed for issue #$issue (recover-stale re-queues it after 90 min)"
  if [[ -n "$wt" && -d "$wt" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 \
      || log "WARN fallback worktree removal failed for $wt"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Step 8 — worktree + authoring prompt
# ---------------------------------------------------------------------------

# compose_prompt <issue> <issue_body> [resume_branch] [resume_commits]
# The second pair of args is non-empty only on a RESUME dispatch (issue #4337
# INV-5): the prior drainer session on this issue was cut off by the timeout
# after committing+pushing <resume_commits> commit(s) on <resume_branch>, and
# this fresh session must continue that work, not re-implement it.
compose_prompt() {
  local issue="$1"
  local issue_body="$2"
  local resume_branch="${3:-}"
  local resume_commits="${4:-}"
  local scope_section
  scope_section=$(printf '%s\n' "$issue_body" | awk '
    BEGIN{on=0}
    /^##[[:space:]]*Files in scope/{on=1}
    /^##[[:space:]]*Files out of scope/{on=1}
    on && /^##[[:space:]]/ && !/Files (in|out of) scope/ && ++seen>1 {on=0}
    on{print}
  ')
    local resume_paragraph=""
  if [[ -n "$resume_branch" ]]; then
    resume_paragraph=$(cat <<RESUME_EOF

## RESUME — a prior drainer session on this issue was cut off by the timeout

A prior GLM drainer session was cut off by the drainer's 50-minute timeout
after committing and pushing ${resume_commits:-at least one} commit(s) on this
very branch (${resume_branch}), and no PR was opened for it. You are resuming
that work. Before writing any code:

1. Run git log origin/master..HEAD and git diff origin/master...HEAD FIRST to
   see exactly what the prior session already did on this branch.
2. Do NOT redo committed work — verify it, then continue from where it
   stopped.
3. Write the .glm-drainer-pr-body.md file FIRST, before touching code: the
   previous copy was lost when the prior worktree was removed, and it is the
   ONLY way your PR description reaches the opened PR.
4. Commit and push to THIS branch (the same one) when done.
RESUME_EOF
    )
  fi

  cat <<PROMPT_EOF
/hydra-dev ${issue}

---

${resume_paragraph}

GLM dev-drainer session (issue #3689, ADR-0032). Read this before doing
anything else — it changes two things about how this dispatch normally ends.

1. You are the CHILD in hydra-dev's parent/child split
   (docs/operator-playbooks/hydra-dev.md): you were placed directly into this
   worktree, you have NO Agent/Task spawn tool, and the issue's
   ready-for-agent -> in-progress label swap has ALREADY been done for you.
   Do NOT re-select or re-label the issue.

2. This session runs under a permission-fenced --settings file
   (config/glm/drainer-settings.json) that deliberately does NOT grant
   \`gh pr create\` — a supervising loop opens the PR for you, AFTER an
   additional secret-scan + Verifier-Core/tier preflight on your diff. If a
   \`gh pr create\` call is denied, that is EXPECTED, not a bug: do not treat
   it as a failure and do not abandon the work because of it.

3. Because the loop (not you) opens the PR, you MUST write your complete
   intended PR body to the file \`.glm-drainer-pr-body.md\` at the root of
   this worktree (via the Write tool) BEFORE attempting \`gh pr create\`, and
   again if you revise it. This is the ONLY way your PR description reaches
   the opened PR — nothing you pass as an argument to a denied
   \`gh pr create\` call is recoverable. Write it as soon as you reasonably
   can, not only at the very end, in case the session is cut short.

   \`.glm-drainer-pr-body.md\` MUST include, in this order:
     a. A short summary of what you built and why.
     b. A \`## Design-concept reconciliation\` section (top-level \`##\`
        heading, never nested under \`## Files in scope\`) if a
        design-concept artifact was fetched for this anchor — one
        \`INV-<n>\` bullet per invariant with a verifiable \`verified by:\`
        assertion, per the child-flow contract's reconciliation gate. Omit
        this section entirely if no artifact was fetched (404).
     c. A \`## Files in scope\` section that mirrors the issue's own section
        below, byte-for-byte.
     d. A \`## Friction Report\` section (always, even on clean success).

4. Commit AND PUSH your branch yourself (\`git push\` IS granted in this
   session's settings) — the loop reads your pushed commits to build the
   diff it preflights. Do not skip the push just because \`gh pr create\` is
   denied.

## SCOPE CONTRACT — issue body is authoritative

The linked issue contains a \`## Files in scope\` section (mandatory) and may
contain a \`## Files out of scope\` section. Before writing any code:

1. Extract both lists from the issue body.
2. Treat \`Files in scope\` as the SOFT boundary — every file you change
   should match one of these entries (substring/prefix match, so \`src/foo/\`
   covers everything beneath).
3. Treat \`Files out of scope\` as the HARD boundary — touching anything
   matching these entries will fail CI's scope-check gate. Do not touch them
   unless absolutely required.
4. If you DO have to touch an out-of-scope file, include a
   \`scope-justification:\` block in \`.glm-drainer-pr-body.md\` listing each
   affected file with a one-line rationale.
5. Mirror the issue's \`## Files in scope\` section into
   \`.glm-drainer-pr-body.md\` so the gate can match against either source
   (also required by point 3c above).
6. CODE-SPAN TRAP: the scope-check parser treats EVERY backticked code-span
   inside the \`Files in scope\` / \`Files out of scope\` sections as a scope
   entry, not just the bullet paths. Keep non-path filenames in prose
   PLAIN-TEXT.

The CI \`scope-check\` job at \`.github/workflows/ci.yml\` enforces this
contract.

For reference, the issue's own scope section(s):

${scope_section}
PROMPT_EOF
}

run_author_session() {
  local issue="$1"
  local wt="$2"
  local prompt_file="$3"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-author issue #$issue in $wt (DRY_RUN=1)"
    echo '{"ok":true,"code":0,"stdout":"","stderr":""}'
    return 0
  fi
  run_driver author "$prompt_file" "$wt"
}

# ---------------------------------------------------------------------------
# Worktree lifecycle
# ---------------------------------------------------------------------------

# create_worktree <issue> [resume_branch]
# With no resume_branch: today's behaviour — a fresh branch off origin/master.
# With one (issue #4337 INV-5): check out THAT existing branch so the PR head
# stays the same branch the prior timed-out session pushed. The prior
# session's worktree removal leaves the branch ref in the shared gitdir, so
# the plain checkout usually applies; when the local ref is gone (pruned/GC'd)
# it is re-created AT the pushed head, tracking origin — never off master,
# which would strand the prior commits off the new branch.
create_worktree() {
  local issue="$1"
  local resume_branch="${2:-}"
  local ts
  ts="$(date +%s)"
  local branch
  if [[ -n "$resume_branch" ]]; then
    branch="$resume_branch"
  else
    branch="worktree-agent-glm-${issue}-${ts}"
  fi
  local wt="${WORKTREE_ROOT}/agent-glm-${issue}-${ts}"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-create-worktree issue #$issue branch=$branch path=$wt (DRY_RUN=1)"
    echo "$branch|$wt"
    return 0
  fi

  git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null || true
  # This function's stdout IS its return contract ("branch|wt", captured by the
  # caller) — git's porcelain output must never reach it (issue #3863).
  local added=0
  if [[ -z "$resume_branch" ]]; then
    git -C "$REPO_ROOT" worktree add -b "$branch" "$wt" origin/master >/dev/null 2>&1 || added=1
  elif git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then
    git -C "$REPO_ROOT" worktree add "$wt" "$branch" >/dev/null 2>&1 || added=1
  else
    git -C "$REPO_ROOT" worktree add -b "$branch" --track "$wt" "origin/${branch}" >/dev/null 2>&1 || added=1
  fi
  if [[ "$added" -ne 0 ]]; then
    log "ERROR failed to create worktree for issue #$issue (branch=$branch)"
    return 1
  fi
  # /dev/shm and .claude/worktrees checkouts have no ancestor node_modules —
  # symlink immediately (CLAUDE.md worktree pitfall).
  ln -sfn "$REPO_ROOT/node_modules" "$wt/node_modules"
  echo "$branch|$wt"
}

# ---------------------------------------------------------------------------
# One authoring attempt, end to end (steps 6-10): claim + worktree + prompt +
# author in bash; the finish phase (src/glm/finish.ts) does everything after.
# Worktree removal, remote-branch deletion, and the timeout-note append moved
# into finish.ts with the arms that own them (issue #4685).
# ---------------------------------------------------------------------------

attempt_one_issue() {
  local issue="$1"
  log "claiming issue #$issue"
  claim_issue "$issue"

  local issue_body
  issue_body=$(gh issue view "$issue" --repo "$REPO" --json body --jq '.body' 2>/dev/null || echo "")

  # INV-5 (issue #4337): the resumable branch — a pushed drainer branch left
  # by a prior TIMED-OUT session on this same issue — is detected by the pick
  # phase (src/glm/pick.ts, issue #4686) and handed in as $2 ("" = fresh).
  # The pushed branch IS the resume record (no new label, no Redis key, no
  # state.json write). Resuming continues the committed work instead of
  # re-paying a full authoring window from scratch.
  local resume_branch="${2:-}" resume_commits=""

  local author_file
  author_file="${TMPDIR:-/tmp}/hydra-glm-drainer-author-${issue}.json"

  local wt_result branch wt
  if ! wt_result="$(create_worktree "$issue" "$resume_branch")"; then
    # No worktree to salvage from. A SYNTHETIC not-run outcome ({ok:false}
    # — finish.ts's not-run arm) carries the failure into the finish phase,
    # which releases the claim; no worktree/branch positional is passed, so
    # nothing is removed. A tick that cannot even write the outcome file
    # leaves the claim in-progress for recover-stale's 90-min requeue.
    log "ERROR could not create a worktree for issue #$issue — handing a synthetic not-run outcome to the finish phase"
    # Clear any stale outcome from a previous tick FIRST: a failed write must
    # never let finish read an old file.
    rm -f "$author_file"
    if ! printf '%s\n' '{"ok":false,"code":"glm-worktree-create-failed","message":"create_worktree failed — no worktree to salvage"}' > "$author_file"; then
      log "ERROR could not write the synthetic author-outcome file for issue #$issue — releasing the claim directly"
      rm -f "$author_file"
      release_claim_fallback "$issue"
      return 0
    fi
    if ! run_driver finish "$issue" "$author_file" 0; then
      log "ERROR finish driver faulted for issue #$issue — releasing the claim directly"
      release_claim_fallback "$issue"
    fi
    return 0
  fi
  branch="${wt_result%%|*}"
  wt="${wt_result##*|}"

  if [[ -n "$resume_branch" ]]; then
    resume_commits="$(git -C "$wt" rev-list --count origin/master..HEAD 2>/dev/null || echo "?")"
    log "issue #$issue: resuming pushed drainer branch $branch (${resume_commits} commit(s) ahead of origin/master)"
  fi

  local prompt_file
  prompt_file="${TMPDIR:-/tmp}/hydra-glm-drainer-prompt-${issue}.txt"
  compose_prompt "$issue" "$issue_body" "$resume_branch" "$resume_commits" > "$prompt_file"

  log "authoring issue #$issue in $wt (branch=$branch)"
  local author_rc=0
  run_author_session "$issue" "$wt" "$prompt_file" > "$author_file" || author_rc=$?
  log "authoring session finished: $(head -c 300 "$author_file")"

  # Everything after the author session is the finish phase: src/glm/finish.ts
  # (issue #4685, ADR-0040 Decisions 1-3) — the post-author arms, the salvage
  # ladder, preflight (in-process), open-PR-with-adoption, the label writes,
  # the timeout note, and the timeout/quota/cap counters. It prints ONE
  # FinishResult JSON line on stdout, exits 0 whenever runFinish returned
  # (every salvage arm — including finish-fault — is a COMPLETED finish, not
  # a driver fault), and logs its journal lines to stderr with this loop's
  # own hydra-glm-drainer: prefix. Non-zero here means the driver itself
  # faulted: log ERROR and let the tick still exit 0 (the claim stays
  # in-progress; recover-stale re-queues it after 90 min).
  if ! run_driver finish "$issue" "$author_file" "$author_rc" "$wt" "$branch"; then
    log "ERROR finish driver faulted for issue #$issue — releasing the claim directly"
    release_claim_fallback "$issue" "$wt"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  mkdir -p "$CAP_DIR" 2>/dev/null || true

  acquire_lock_or_heartbeat_and_exit

  # Steps 2-4 live in src/glm/gate.ts (issue #4682, ADR-0040): operator
  # pause (Redis), daily PR cap, z.ai quota block, and — only when able — the
  # heartbeat write. `run_driver gate` prints ONE JSON line:
  #   {able:true, heartbeat:"written"|"would-write"|"write-failed", detail?}
  #   {able:false, reason:"paused"|"cap-exhausted"|"quota-blocked", detail?}
  # and exits 0 either way; non-zero means the driver itself faulted. The
  # driver logs no prose — bash stays the single human-log writer, so every
  # journal line below is byte-identical to the pre-#4682 bash gate.
  local gate_out gate_rc=0
  gate_out="$(run_driver gate)" || gate_rc=$?
  gate_out="$(tail -n 1 <<<"$gate_out")"  # defensive: the JSON line is the LAST stdout line
  if [[ "$gate_rc" -ne 0 ]]; then
    log "WARN gate driver faulted (rc=$gate_rc) — failing safe, skip (no heartbeat)"
    exit 0
  fi
  # Bare jq paths + strict string comparison, never `//` (jq treats `false`
  # as falsy — the pace-gate #1790 trap). Anything unexpected fails closed.
  local gate_able gate_reason gate_heartbeat gate_detail
  gate_able="$(jq -r '.able' <<<"$gate_out" 2>/dev/null || echo "parse-error")"
  gate_reason="$(jq -r '.reason' <<<"$gate_out" 2>/dev/null || echo "")"
  gate_heartbeat="$(jq -r '.heartbeat' <<<"$gate_out" 2>/dev/null || echo "")"
  gate_detail="$(jq -r 'if .detail == null then "" else .detail end' <<<"$gate_out" 2>/dev/null || echo "")"
  if [[ "$gate_able" == "false" ]]; then
    case "$gate_reason" in
      paused)
        [[ -n "$gate_detail" ]] && log "WARN $gate_detail — failing safe (treating as paused)"
        log "operator paused — skip (no heartbeat; kill-switch honors ONLY operator paused, ignoring Anthropic reasons per ADR-0032 Decision 6)"
        ;;
      cap-exhausted)
        log "daily PR cap reached ($gate_detail) — skip (no heartbeat)"
        ;;
      quota-blocked)
        log "quota block active until $gate_detail — skip (no heartbeat)"
        ;;
      *)
        log "WARN gate skipped with an unknown reason ($gate_reason) — skip (no heartbeat)"
        ;;
    esac
    exit 0
  fi
  if [[ "$gate_able" != "true" ]]; then
    log "WARN gate line unparseable — failing safe, skip (no heartbeat)"
    exit 0
  fi
  # Committed to running this tick: the gate already wrote the heartbeat.
  case "$gate_heartbeat" in
    written)      log "heartbeat written (reason=able)" ;;
    would-write)  log "would-heartbeat (reason=able, DRY_RUN=1)" ;;
    write-failed) log "WARN heartbeat write failed (reason=able): $gate_detail" ;;
    *)            log "WARN gate reported an unknown heartbeat state ($gate_heartbeat)" ;;
  esac

  # Steps 5+6 live in src/glm/pick.ts (issue #4686, ADR-0040): stale-claim
  # recovery, the candidate pick, resume-branch detection, and the last-pick
  # verdict publication. `run_driver pick` prints ONE JSON line — either
  # {issue,reason,resumeBranch,resumeCommits} or {idle:true,skipped} — and
  # exits 0 in both cases; non-zero means the driver itself faulted. The
  # journal lines ("picked issue #N (grill-clear: <reason>)", skip reasons)
  # are logged to stderr by the driver.
  local pick_out pick_rc=0
  pick_out="$(run_driver pick)" || pick_rc=$?
  pick_out="$(tail -n 1 <<<"$pick_out")"  # defensive: the JSON line is the LAST stdout line
  if [[ "$pick_rc" -ne 0 ]]; then
    log "ERROR pick driver faulted (rc=$pick_rc) — skipping this tick"
    exit 0
  fi

  local issue resume_branch
  issue="$(jq -r '.issue // empty' <<<"$pick_out" 2>/dev/null || true)"
  if [[ -z "$issue" ]]; then
    log "no glm-eligible + ready-for-agent issue that is grill-clear (approved design concept, cleanup-scan label, or Expected tier: T1 stamp) — idle"
    exit 0
  fi
  resume_branch="$(jq -r '.resumeBranch // empty' <<<"$pick_out" 2>/dev/null || true)"

  attempt_one_issue "$issue" "$resume_branch"

  exit 0
}

# Sourceable for tests (test/glm-drainer-loop.test.mts) without running main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
