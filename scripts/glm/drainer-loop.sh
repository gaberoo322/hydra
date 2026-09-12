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
#   2. Kill-switch: honor ONLY the operator's durable pause flag
#      (`GET /api/autopilot/paused`) — deliberately IGNORE Anthropic
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
#      (CLAUDE.md Redis-seam rule: never a raw client). Bash reaches that
#      TypeScript function via the committed bridge file
#      `scripts/glm/drainer-driver.ts` — see `write_heartbeat()` /
#      `run_driver()` below (issue #4371).
#   5. Crash recovery: any `glm-eligible` issue stuck `in-progress` for >90
#      min is re-queued via the EXISTING `scripts/autopilot/recover-stale.sh`
#      (reused, not reimplemented, per the issue body).
#   6. Pick a `glm-eligible` + `ready-for-agent` issue (oldest first) that
#      also has an APPROVED design-concept artifact
#      (`GET /api/design-concepts/issue-<N>`, `.status == "approved"`) —
#      `design_concept_orch` designs every glm-eligible issue before the
#      drainer may touch it (ADR-0032 Decision 1). Also skips any candidate
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
#      creating a worktree, `find_resumable_branch()` looks for a pushed
#      `worktree-agent-glm-<issue>-*` head from a PRIOR timed-out session —
#      the pushed branch IS the resume record (no new label, no Redis key,
#      no state.json write: the drainer never touches the Claude lane's
#      #3866 backstop, INV-8) — and `create_worktree()` checks it out as-is
#      so the resumed session continues committed work instead of re-paying
#      a full authoring window from scratch.
#   9. Preflight: `preflightBeforePr` (secret-scan + Verifier-Core/T4 diff
#      gate, `src/glm/drainer-runner.ts`) MUST pass before this loop's OWN
#      `gh pr create`. Issue #4337 INV-3: a TIMED-OUT session whose worktree
#      has >=1 commit ahead of origin/master AND a non-empty
#      .glm-drainer-pr-body.md takes this IDENTICAL push -> preflight ->
#      open_pr fence (the PR is a normal PR, never a draft) with one
#      addition — `append_timeout_note()` discloses the cutoff in a trailing
#      plain-text section. Commits WITHOUT a pr-body are KEPT on origin for
#      the resume above instead of deleted (INV-4); repeated PR-less
#      timeouts hand the issue to the Claude lane via glm-withhold once the
#      per-issue counter reaches TIMEOUT_RESUME_CAP (INV-6).
#  10. `gh pr create --label glm-authored` (ADR-0032 Decision 5 — provenance
#      by label FIRST. Issue #4048 corrects this step's original carve-out
#      premise: the branch create_worktree() builds below inserts a literal
#      `glm` segment — `worktree-agent-glm-${issue}-${ts}` — that Opus
#      dev_orch's hex-hash `worktree-agent-<hash>-...` branches can never
#      contain (g/l are not hex digits), so the exact prefix
#      `worktree-agent-glm-` discriminates the drainer's PRs perfectly.
#      glm-beachhead-report.sh and collect-state.sh use it as an OR-fallback
#      for PRs whose non-atomic `--label` mutation was lost; the label stays
#      primary). If `gh pr create`
#      fails because a PR for this exact branch already exists (issue #3900 —
#      "already exists" is a real GitHub answer, not a generic failure),
#      `open_pr()` ADOPTS that PR (logs the anomaly, returns success) instead
#      of discarding it via `release_issue`.
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
# not the mechanism behind the "already exists" collisions this file's
# `open_pr()` now adopts instead of discarding. The more likely explanation
# (not independently verified here, and not load-bearing for this fix either
# way): `gh pr create` server-side PR creation and its separate
# `--label glm-authored` mutation are not atomic, so a prior tick's LOOP-side
# `gh pr create` call can create the PR and then fail non-zero on the label
# step, or `gh` can time out after the server has already committed the
# create. Either way `open_pr()` treating "already exists" as adoption
# rather than a genuine failure, and `pick_eligible_issue()` skipping issues
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
#       gh pr create, cap-file increment) logs "would-<action>" and no-ops
#       instead of executing. Lets the test drive the pure control-flow
#       (flock / paused / cap / heartbeat-gating) with no gh/git/claude/Redis
#       dependency, exactly like HYDRA_PACE_GATE_DRY_RUN.
#   HYDRA_GLM_DRAINER_PAUSED_URL
#       Override the operator-pause read (default
#       http://localhost:4000/api/autopilot/paused) so a test can point at a
#       local fixture server.
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
PAUSED_URL="${HYDRA_GLM_DRAINER_PAUSED_URL:-http://localhost:4000/api/autopilot/paused}"
DESIGN_CONCEPT_URL="${HYDRA_GLM_DRAINER_DESIGN_CONCEPT_URL:-http://localhost:4000/api/design-concepts}"
LOCKFILE="${HYDRA_GLM_DRAINER_LOCKFILE:-/tmp/hydra-glm-drainer.lock}"
CAP_DIR="${HYDRA_GLM_DRAINER_CAP_DIR:-/tmp}"
DAILY_CAP="${HYDRA_GLM_DRAINER_DAILY_CAP:-5}"
# Issue #4337 INV-6 — per-issue bound on timeout-driven retries. Once a
# timed-out session ends with no PR and this many timeouts have accumulated,
# the release adds glm-withhold (explicit handoff of the issue AND its pushed
# branch to the Claude dev_orch lane) instead of looping on z.ai forever.
TIMEOUT_RESUME_CAP="${HYDRA_GLM_DRAINER_TIMEOUT_RESUME_CAP:-2}"
WORKTREE_ROOT="${HYDRA_GLM_DRAINER_WORKTREE_ROOT:-/home/gabe/hydra/.claude/worktrees}"
GLM_LABEL_ELIGIBLE="glm-eligible"
GLM_LABEL_WITHHOLD="glm-withhold"
GLM_LABEL_AB_CONTROL="glm-ab-control"
GLM_LABEL_AUTHORED="glm-authored"
LABEL_READY="ready-for-agent"
LABEL_IN_PROGRESS="in-progress"
LABEL_NEEDS_QA="needs-qa"
STALE_IN_PROGRESS_SECONDS=5400 # 90 min — matches collect-state.sh's own literal

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
# Step 2 — kill-switch (operator paused ONLY)
# ---------------------------------------------------------------------------

is_operator_paused() {
  if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    log "WARN curl/jq unavailable; cannot read pause state — failing safe (treating as paused)"
    echo "true"
    return 0
  fi
  local json paused
  if ! json=$(curl -fsS --max-time 10 "$PAUSED_URL" 2>/dev/null); then
    log "WARN pause endpoint unreachable ($PAUSED_URL) — failing safe (treating as paused)"
    echo "true"
    return 0
  fi
  # CRITICAL: bare `.paused`, NOT `.paused // "parse-error"` — jq's `//`
  # operator treats `false` itself as falsy, so `.paused // "parse-error"`
  # would misreport a legitimate, correctly-parsed `paused:false` response as
  # a parse error, and this function's fail-safe direction (treat as paused)
  # would then wrongly block the drainer forever. Mirrors pace-gate.sh's own
  # documented `ALLOW=$(jq -r '.allow' ...)` fix for the identical class of
  # bug (issue #1790) — strict string matching below is what actually
  # detects "unparseable", not the `//` fallback.
  paused=$(jq -r '.paused' <<<"$json" 2>/dev/null || echo "parse-error")
  if [[ "$paused" != "true" && "$paused" != "false" ]]; then
    log "WARN pause response unparseable — failing safe (treating as paused)"
    echo "true"
    return 0
  fi
  echo "$paused"
}

# ---------------------------------------------------------------------------
# Step 3 — daily PR cap
# ---------------------------------------------------------------------------

cap_file_path() {
  echo "${CAP_DIR}/hydra-glm-drainer-daily-cap-$(date -u +%F)"
}

cap_count() {
  local f
  f="$(cap_file_path)"
  if [[ -f "$f" ]]; then
    cat "$f"
  else
    echo "0"
  fi
}

is_cap_exhausted() {
  local count
  count="$(cap_count)"
  if [[ "$count" =~ ^[0-9]+$ ]] && [[ "$count" -ge "$DAILY_CAP" ]]; then
    echo "true"
  else
    echo "false"
  fi
}

cap_increment() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-increment daily-cap counter (DRY_RUN=1)"
    return 0
  fi
  local f count
  f="$(cap_file_path)"
  count="$(cap_count)"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  echo "$((count + 1))" > "$f"
}

# ---------------------------------------------------------------------------
# Per-issue timeout counter (issue #4337 INV-6) — the SAME file-counter
# mechanism as the daily cap above, keyed per issue. Bounds GLM spend per
# issue at a finite number of authoring windows, then hands the issue (and
# its pushed branch) to the Claude dev_orch lane via glm-withhold instead of
# looping on z.ai quota forever.
# ---------------------------------------------------------------------------

timeout_counter_path() {
  echo "${CAP_DIR}/hydra-glm-drainer-timeouts-$1"
}

timeout_counter_value() {
  local f
  f="$(timeout_counter_path "$1")"
  if [[ -f "$f" ]]; then
    cat "$f"
  else
    echo "0"
  fi
}

timeout_counter_increment() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-increment timeout-counter for issue #$1 (DRY_RUN=1)"
    return 0
  fi
  local f count
  f="$(timeout_counter_path "$1")"
  count="$(timeout_counter_value "$1")"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  echo "$((count + 1))" > "$f"
}

timeout_counter_remove() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-remove timeout-counter for issue #$1 (DRY_RUN=1)"
    return 0
  fi
  rm -f "$(timeout_counter_path "$1")" 2>/dev/null || true
}

# release_after_authoring <issue> <timed_out>
# The INV-6 terminal-release rule for a session that ended WITHOUT opening a
# PR: below the cap it releases plain (the GLM lane resumes the pushed branch
# next tick via find_resumable_branch); AT/above the cap it releases with
# glm-withhold — ADR-0032 #3753 delta 4's exact "this issue genuinely needs
# frontier capability" signal — so the Claude dev_orch lane takes over.
release_after_authoring() {
  local issue="$1"
  local timed_out="$2"
  local withhold="false"
  if [[ "$timed_out" == "true" ]]; then
    local count
    count="$(timeout_counter_value "$issue")"
    if [[ "$count" =~ ^[0-9]+$ ]] && [[ "$count" -ge "$TIMEOUT_RESUME_CAP" ]]; then
      withhold="true"
      log "issue #$issue: timeout resume cap reached (${count}/${TIMEOUT_RESUME_CAP}) — releasing with glm-withhold so the Claude dev_orch lane takes this issue and its pushed branch over"
    fi
  fi
  release_issue "$issue" "$withhold"
}

# ---------------------------------------------------------------------------
# Step 5 — crash recovery (reuses recover-stale.sh, per the issue body)
# ---------------------------------------------------------------------------

recover_stale_glm_claims() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-recover-stale glm-eligible in-progress issues (DRY_RUN=1)"
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    log "WARN gh/jq unavailable; skipping stale-claim recovery this tick"
    return 0
  fi
  local rows stale=()
  rows=$(gh issue list --repo "$REPO" --label "$GLM_LABEL_ELIGIBLE" --label "$LABEL_IN_PROGRESS" \
    --state open --json number,updatedAt 2>/dev/null || echo "[]")
  while IFS= read -r n; do
    [[ -n "$n" ]] && stale+=("$n")
  done < <(jq -r --argjson threshold "$STALE_IN_PROGRESS_SECONDS" \
    '.[] | select((now - (.updatedAt | fromdateiso8601)) > $threshold) | .number' <<<"$rows" 2>/dev/null)
  if [[ ${#stale[@]} -eq 0 ]]; then
    return 0
  fi
  log "recovering ${#stale[@]} stale glm-eligible in-progress issue(s): ${stale[*]}"
  bash "$REPO_ROOT/scripts/autopilot/recover-stale.sh" stale_in_progress "${stale[@]}" stale_blocked \
    || log "WARN recover-stale.sh exited non-zero (non-fatal)"
}

# ---------------------------------------------------------------------------
# Step 6 — pick an eligible, design-approved issue
# ---------------------------------------------------------------------------

has_approved_design_concept() {
  local issue="$1"
  local json status
  if ! json=$(curl -fsS --max-time 10 "${DESIGN_CONCEPT_URL}/issue-${issue}" 2>/dev/null); then
    echo "false"
    return 0
  fi
  status=$(jq -r '.status // "parse-error"' <<<"$json" 2>/dev/null || echo "parse-error")
  if [[ "$status" == "approved" ]]; then
    echo "true"
  else
    echo "false"
  fi
}

issue_has_open_pr() {
  local issue="$1"
  local open_prs_json="$2"
  # Same closing-keyword family scripts/ci/design-concept-reconcile-check.ts's
  # extractAnchorRefFromPrBody() and scripts/ci/epic-close.ts's
  # parseEpicReferences() already use ("close[sd]?|fix(e[sd])?|resolve[sd]?"),
  # so every "does PR body X reference issue N" parser in this repo agrees.
  jq -e --argjson n "$issue" \
    '[.[] | select((.body // "") | test("(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*#" + ($n | tostring) + "\\b"; "i"))] | length > 0' \
    <<<"$open_prs_json" >/dev/null 2>&1
}

# issue_has_merged_pr <issue> <merged_prs_json>
# TRUE when a MERGED PR already references the issue — the shipped-work
# guard. `issue_has_open_pr` above answers "is someone on it right now"
# (closing keyword in an OPEN PR body), but a MERGED PR answers "did work
# for this issue already ship" — and if the issue is still open after that
# merge, it is because the PR body carried no closing keyword (GitHub only
# auto-closes on the keyword), not because the work is unclaimed. Live
# incident (2026-08-27, this guard's motivation): PR #4236 implemented
# issue #4130 but referenced it ONLY as the title's "(#4130)" anchor
# suffix — no closing keyword in title or body — so the issue stayed open
# and pick_eligible_issue re-dispatched the already-merged work ~90 minutes
# later, burning a full authoring session per tick until an operator
# intervenes. Deliberately WIDER than the open-PR check: this repo's PR
# title convention carries the anchor as a bare "(#<n>)" suffix
# ("fix(scope): subject (#issue) (#pr)") even when the body has no keyword
# at all, so BOTH signals count here — a closing keyword in the merged PR's
# title or body, OR the "(#<n>)" title anchor. The false-positive cost is
# one skip plus an operator-triage log line; the hole's cost is an
# authoring session per tick re-implementing merged code.
issue_has_merged_pr() {
  local issue="$1"
  local merged_prs_json="$2"
  jq -e --argjson n "$issue" \
    '[.[] | select(
        (((.title // "") + "\n" + (.body // "")) | test("(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*#" + ($n | tostring) + "\\b"; "i"))
        or ((.title // "") | test("\\(#" + ($n | tostring) + "\\)"; "i"))
      )] | length > 0' \
    <<<"$merged_prs_json" >/dev/null 2>&1
}

pick_eligible_issue() {
  # DRY_RUN gates this too — not just the mutating actions further down the
  # pipeline. Picking is a real network round-trip (gh + the design-concepts
  # API), and the script's own contract (see header) is that DRY_RUN makes a
  # tick hermetic. Without this, a DRY_RUN test run would still depend on live
  # `gh` auth / network reachability to reach its assertions (caught during
  # this script's own test-writing: the control-flow tests were quietly
  # taking 2s+ each and hitting the real gaberoo322/hydra board).
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-pick-eligible-issue (DRY_RUN=1)"
    return 0
  fi
  if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
    log "WARN gh/jq unavailable; cannot pick a candidate this tick"
    return 0
  fi
  local rows candidates
  rows=$(gh issue list --repo "$REPO" --label "$GLM_LABEL_ELIGIBLE" --label "$LABEL_READY" \
    --state open --json number,updatedAt,labels --limit 30 2>/dev/null || echo "[]")
  # Defense in depth against a stale/incorrectly-labelled row: exclude
  # glm-withhold client-side even though the eligibility sweep (#3756) is
  # supposed to never apply glm-eligible alongside it. Also exclude
  # glm-ab-control (issue #4124) for the same reason and with the same
  # status — the candidate query already requires glm-eligible, so a control
  # issue (which the eligibility sweep is now made to skip) is never a
  # candidate in the first place; this is a second, independent guard against
  # a stale/hand-labelled row, not the fix itself.
  candidates=$(jq -r --arg withhold "$GLM_LABEL_WITHHOLD" --arg abcontrol "$GLM_LABEL_AB_CONTROL" \
    '[.[] | select((.labels | map(.name) | index($withhold)) | not) | select((.labels | map(.name) | index($abcontrol)) | not)] | sort_by(.updatedAt) | .[].number' \
    <<<"$rows" 2>/dev/null)

  # Open-PR pre-dispatch gate (issue #3900): fetch every open PR's body ONCE
  # (mirrors the single-gh-call-then-client-side-filter shape the
  # glm-withhold defense-in-depth check above already uses) so each candidate
  # can be checked against it without an extra gh round-trip per candidate.
  # A WARN (not a silent fallback, unlike the sibling gh calls above) because
  # a swallowed failure here degrades straight back into the exact
  # duplicate-dispatch hole this gate exists to close.
  local open_prs_json
  if ! open_prs_json=$(gh pr list --repo "$REPO" --state open --json number,body --limit 100 2>/dev/null); then
    log "WARN gh pr list failed while building the open-PR skip list — proceeding without it this tick (duplicate-dispatch protection degraded, not blocked)"
    open_prs_json="[]"
  fi

  # Merged-PR shipped-work guard (issue #4130): same single-fetch shape as
  # the open-PR list above, but over MERGED PRs. Without it, an issue whose
  # fix merged without a closing keyword (only the title's "(#<n>)" anchor)
  # never auto-closes and is re-picked EVERY tick — 2026-08-27: #4236 merged
  # at 14:00Z and the drainer re-dispatched #4130 by 15:37Z. A WARN (not a
  # silent fallback, mirroring the sibling above) because a swallowed
  # failure here degrades straight back into re-dispatching shipped work.
  local merged_prs_json
  if ! merged_prs_json=$(gh pr list --repo "$REPO" --state merged --json number,title,body --limit 100 2>/dev/null); then
    log "WARN gh pr list --state merged failed while building the merged-PR skip list — proceeding without it this tick (shipped-work skip degraded, not blocked)"
    merged_prs_json="[]"
  fi

  local n
  while IFS= read -r n; do
    [[ -z "$n" ]] && continue
    if issue_has_open_pr "$n" "$open_prs_json"; then
      log "skipping issue #$n — an open PR already references it (Closes #$n or equivalent) — not re-dispatching"
      continue
    fi
    if issue_has_merged_pr "$n" "$merged_prs_json"; then
      log "skipping issue #$n — a MERGED PR already references it (shipped; the issue is likely open only because that PR body had no closing keyword) — not re-dispatching; close or re-scope the issue by hand"
      continue
    fi
    if [[ "$(has_approved_design_concept "$n")" == "true" ]]; then
      echo "$n"
      return 0
    fi
  done <<<"$candidates"
  return 0
}

# ---------------------------------------------------------------------------
# Step 7 — claim / release
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

# release_issue <issue> [withhold]
# Hands the issue back to the Opus dev_orch lane. Adds glm-withhold when the
# release reason is a preflight fence hit (Verifier-Core/T4/tier) — that is
# exactly the "the brain judges this single issue genuinely needs frontier
# capability" signal glm-withhold exists to record (ADR-0032 #3753 delta 4),
# and prevents the drainer re-picking a doomed issue every tick.
release_issue() {
  local issue="$1"
  local withhold="${2:-false}"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-release issue #$issue ($LABEL_IN_PROGRESS -> $LABEL_READY, withhold=$withhold, DRY_RUN=1)"
    return 0
  fi
  gh issue edit "$issue" --repo "$REPO" --remove-label "$LABEL_IN_PROGRESS" --add-label "$LABEL_READY" \
    || log "WARN failed to release issue #$issue (non-fatal)"
  if [[ "$withhold" == "true" ]]; then
    gh issue edit "$issue" --repo "$REPO" --add-label "$GLM_LABEL_WITHHOLD" \
      || log "WARN failed to add glm-withhold to issue #$issue (non-fatal)"
  fi
}

advance_to_needs_qa() {
  local issue="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-advance issue #$issue to $LABEL_NEEDS_QA (DRY_RUN=1)"
    return 0
  fi
  gh issue edit "$issue" --repo "$REPO" \
    --remove-label "$LABEL_READY" --remove-label "$LABEL_IN_PROGRESS" --add-label "$LABEL_NEEDS_QA" \
    || log "WARN failed to advance issue #$issue to needs-qa (non-fatal — relabel by hand)"
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
# Step 9 — preflight
# ---------------------------------------------------------------------------

run_preflight_check() {
  local changed_files_file="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-preflight (DRY_RUN=1)"
    echo '{"ok":true,"checkedPaths":0}'
    return 0
  fi
  run_driver preflight "$changed_files_file"
}

# ---------------------------------------------------------------------------
# Step 10 — open the PR
# ---------------------------------------------------------------------------

open_pr() {
  local issue="$1"
  local branch="$2"
  local wt="$3"
  local body_file="$wt/.glm-drainer-pr-body.md"
  local title
  title=$(gh issue view "$issue" --repo "$REPO" --json title --jq '.title' 2>/dev/null)
  [[ -z "$title" ]] && title="glm-authored: issue #$issue"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-open-pr issue #$issue branch=$branch title=\"$title\" (DRY_RUN=1)"
    return 0
  fi

  local create_output
  if create_output=$(gh pr create --repo "$REPO" \
    --base master --head "$branch" \
    --title "$title" \
    --body-file "$body_file" \
    --label "$GLM_LABEL_AUTHORED" 2>&1); then
    log "issue #$issue: gh pr create succeeded: $(echo "$create_output" | tail -1)"
    return 0
  fi

  # gh pr create failed — but "for ANY reason" was exactly issue #3900's bug:
  # a "pull request for branch X already exists" response IS a real GitHub
  # API answer meaning a PR already exists, not a genuine creation failure.
  # (Open question the issue leaves partly unresolved: something can create a
  # PR against this exact per-tick unique branch before this call ever runs —
  # see the investigation note near the top of this file / the PR body for
  # what was found.) Rather than pattern-match the error text (fragile across
  # gh versions), ask GitHub directly whether a PR already exists for this
  # exact branch.
  log "WARN gh pr create failed for issue #$issue branch=$branch: $(echo "$create_output" | tail -1) — checking gh pr list before treating this as a genuine failure"

  local existing_prs existing_number existing_url
  if ! existing_prs=$(gh pr list --repo "$REPO" --head "$branch" --json number,url 2>/dev/null); then
    log "WARN gh pr list failed while checking for an already-exists collision for issue #$issue branch=$branch — cannot distinguish adoption from genuine failure this tick"
    existing_prs="[]"
  fi
  existing_number=$(jq -r '.[0].number // empty' <<<"$existing_prs" 2>/dev/null)
  existing_url=$(jq -r '.[0].url // empty' <<<"$existing_prs" 2>/dev/null)

  if [[ -n "$existing_number" ]]; then
    # ADOPT: treat this exactly like a fresh gh pr create success so the
    # caller's advance_to_needs_qa + cap_increment path fires (issue #3900
    # acceptance criteria) instead of release_issue discarding a real PR.
    log "ANOMALY issue #$issue: gh pr create failed but PR #$existing_number ($existing_url) already exists for branch=$branch — adopting it instead of releasing the claim (see issue #3900)"
    # The most likely origin of an adopted PR (see the investigation note
    # near the top of this file) is a PRIOR tick's gh pr create succeeding at
    # PR-creation but failing non-zero on its separate --label mutation — the
    # exact scenario where the adopted PR is most likely to be MISSING
    # glm-authored. That label is ADR-0032 Decision 5's only discriminator
    # from Opus dev_orch PRs (same worktree-agent-* branch prefix), so
    # re-apply it here, best-effort — a failure is logged, never fatal.
    gh pr edit "$existing_number" --repo "$REPO" --add-label "$GLM_LABEL_AUTHORED" >/dev/null 2>&1 \
      || log "WARN failed to (re-)apply $GLM_LABEL_AUTHORED label to adopted PR #$existing_number (non-fatal)"
    return 0
  fi

  log "ERROR gh pr create failed for issue #$issue branch=$branch and no existing PR found for that branch — genuine failure"
  return 1
}

# ---------------------------------------------------------------------------
# Worktree lifecycle
# ---------------------------------------------------------------------------

# find_resumable_branch <issue>  (issue #4337 INV-5)
# Lists origin heads matching worktree-agent-glm-<issue>-* (git ls-remote
# --heads), sorts by the trailing -<ts> suffix DESCENDING (newest attempt
# first), and echoes the FIRST branch that is >=1 commit ahead of
# origin/master (git rev-list --count origin/master..<sha> after a fetch);
# echoes the empty string when no such branch exists. The exact
# worktree-agent-glm- prefix is the same discriminator as the glm-authored
# adoption logic in open_pr (#4048) — Opus dev_orch's hex-hash branches can
# never match it. The pushed branch IS the resume record: no new issue label,
# no Redis key, no state.json write (INV-5/INV-8 — the drainer never routes
# into the Claude lane's #3866 backstop).
find_resumable_branch() {
  local issue="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-find-resumable-branch for issue #$issue (DRY_RUN=1)"
    return 0
  fi
  git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null || true
  local heads
  heads=$(git -C "$REPO_ROOT" ls-remote --heads origin "worktree-agent-glm-${issue}-*" 2>/dev/null) || return 0
  [[ -z "$heads" ]] && return 0
  local sha ref short ahead
  # Field 5 of a refs/heads/worktree-agent-glm-<issue>-<ts> ref split on "-"
  # is the epoch-seconds timestamp; numeric-descending sort = newest attempt
  # first. A head at 0 commits ahead (an empty/pushed-then-rewound attempt)
  # is skipped, not returned.
  while IFS=$'\t' read -r sha ref; do
    [[ -z "$ref" ]] && continue
    short="${ref#refs/heads/}"
    ahead="$(git -C "$REPO_ROOT" rev-list --count "origin/master..${sha}" 2>/dev/null || echo "0")"
    if [[ "$ahead" =~ ^[0-9]+$ ]] && [[ "$ahead" -ge 1 ]]; then
      echo "$short"
      return 0
    fi
  done < <(printf '%s\n' "$heads" | sort -t- -k5,5rn)
  return 0
}

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

cleanup_worktree() {
  local wt="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-remove-worktree $wt (DRY_RUN=1)"
    return 0
  fi
  git -C "$REPO_ROOT" worktree remove --force "$wt" 2>/dev/null \
    || log "WARN failed to remove worktree $wt (non-fatal — hydra-branch-prune will reap it)"
}

delete_remote_branch_if_pushed() {
  local branch="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-delete-remote-branch $branch if pushed (DRY_RUN=1)"
    return 0
  fi
  git -C "$REPO_ROOT" push origin --delete "$branch" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Timeout disclosure (issue #4337 INV-3) — appended to the salvaged session's
# .glm-drainer-pr-body.md before open_pr, so reviewers and QA judge the diff
# as a partial delivery cut off at the 50-min timeout, not as a session that
# reported completion. PLAIN TEXT ONLY: a backticked code-span in the PR body
# is a scope entry to CI's scope-check parser (code-span trap), and the note
# deliberately contains none.
# ---------------------------------------------------------------------------

append_timeout_note() {
  local body_file="$1"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-append GLM drainer timeout note to $body_file (DRY_RUN=1)"
    return 0
  fi
  if cat >> "$body_file" <<'NOTE_EOF'

## GLM drainer note

The authoring session behind this PR hit the drainer's 50-minute timeout and
was cut off at that point; the supervising loop salvaged what had been
committed. The diff is exactly what was committed at cutoff — judge it as a
partial delivery that may still need follow-up, not as a session that
reported completion.
NOTE_EOF
  then
    log "appended GLM drainer timeout note to $body_file"
  else
    log "WARN failed to append GLM drainer timeout note to $body_file (non-fatal — proceeding with the unmodified body)"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# One authoring attempt, end to end (steps 6-10)
# ---------------------------------------------------------------------------

attempt_one_issue() {
  local issue="$1"
  log "claiming issue #$issue"
  claim_issue "$issue"

  local issue_body
  issue_body=$(gh issue view "$issue" --repo "$REPO" --json body --jq '.body' 2>/dev/null || echo "")

  # INV-5 (issue #4337): before creating a fresh worktree, look for a pushed
  # drainer branch left by a prior TIMED-OUT session on this same issue —
  # the pushed branch IS the resume record (no new label, no Redis key, no
  # state.json write). Resuming continues the committed work instead of
  # re-paying a full authoring window from scratch.
  local resume_branch resume_commits=""
  resume_branch="$(find_resumable_branch "$issue")"

  local wt_result branch wt
  if ! wt_result="$(create_worktree "$issue" "$resume_branch")"; then
    log "ERROR could not create a worktree for issue #$issue — releasing claim"
    release_issue "$issue" "false"
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
  local author_json author_rc=0
  author_json="$(run_author_session "$issue" "$wt" "$prompt_file")" || author_rc=$?
  log "authoring session finished: $(echo "$author_json" | head -c 300)"

  local author_ok author_code author_message timed_out
  author_ok=$(jq -r '.ok // false' <<<"$author_json" 2>/dev/null || echo "false")
  author_code=$(jq -r 'if .code == null then "null" else (.code | tostring) end' <<<"$author_json" 2>/dev/null || echo "null")
  author_message=$(jq -r '.message // ""' <<<"$author_json" 2>/dev/null || echo "")
  timed_out=$(jq -r '.timedOut // false' <<<"$author_json" 2>/dev/null || echo "false")

  # INV-6 (issue #4337): count EVERY timed-out authoring session against the
  # per-issue resume cap — the counter is removed again on a successful
  # open_pr below, so only PR-less timeouts accumulate.
  if [[ "$timed_out" == "true" ]]; then
    timeout_counter_increment "$issue"
  fi

  # Three post-author arms, distinguished by EVIDENCE (issue #4337 INV-2).
  # The old single catch-all line ("authoring session did not run
  # (buildGlmEnv/buildDrainerArgs failed closed)") conflated a driver fault,
  # a fail-closed env/args build, AND a 50-minute session that was cut off by
  # the timeout — sending operators down the wrong diagnosis path.
  if [[ "$author_rc" -ne 0 || -z "$author_json" ]]; then
    # Arm (a): the driver itself FAULTED — non-zero exit or no JSON line on
    # stdout (a rejecting dependency, a genuine spawn error). Its stderr
    # carries the stack; there is nothing in the worktree to salvage from a
    # session that never reported an outcome.
    log "authoring driver FAULTED (exit=$author_rc) for issue #$issue — see driver stderr above"
    cleanup_worktree "$wt"
    release_issue "$issue" "false"
    return 0
  fi
  if [[ "$author_ok" != "true" ]]; then
    # Arm (b): the ONLY arm that legitimately describes a fail-closed
    # env/args build — the driver ran and reported {ok:false, code, message}
    # on stdout with exit 0 (glm-auth-token-missing,
    # glm-model-would-route-first-party).
    log "authoring session did not run for issue #$issue: ${author_code} — ${author_message:-no message from driver}"
    cleanup_worktree "$wt"
    release_issue "$issue" "false"
    return 0
  fi
  # Arm (c): the session RAN and ended — cleanly, non-zero CLI exit, or cut
  # off by the timeout (timedOut=true). Fall through to the evidence-driven
  # salvage check below.
  log "authoring session ended for issue #$issue (timedOut=${timed_out}, exit=${author_code})"

  # Evidence-driven salvage ladder (issue #4337 INV-3/INV-4) — what is on
  # disk in the worktree decides, never the timeout flag alone.
  local commit_count body_file
  commit_count="$(git -C "$wt" rev-list --count origin/master..HEAD 2>/dev/null || echo "0")"
  body_file="$wt/.glm-drainer-pr-body.md"

  if [[ "$DRY_RUN" != "1" ]] && [[ "$commit_count" -eq 0 ]]; then
    # Nothing usable was produced at all — zero commits ahead of
    # origin/master (a pr-body without commits describes work that does not
    # exist). Release for a retry and delete the possibly-pushed remote
    # branch: there is no partial work to keep.
    log "issue #$issue: nothing usable produced (commits=0) — releasing claim"
    cleanup_worktree "$wt"
    delete_remote_branch_if_pushed "$branch"
    release_after_authoring "$issue" "$timed_out"
    return 0
  fi

  if [[ "$DRY_RUN" != "1" ]] && [[ ! -s "$body_file" ]]; then
    # INV-4: commits exist but the pr-body file is missing/empty — the
    # session was cut off before writing it (the classic timeout shape).
    # KEEP the partial work: defensive push, remove ONLY the local worktree,
    # and deliberately do NOT delete_remote_branch_if_pushed — the pushed
    # branch is the resume record find_resumable_branch picks up next tick.
    # A PR opened from this state would be wedged by the design-concept and
    # scope gates (the pr-body carries those sections), so resume instead.
    git -C "$wt" push -u origin "$branch" --quiet 2>&1 | while IFS= read -r line; do log "git push: $line"; done || true
    log "issue #$issue: partial work kept on origin/$branch for resume (commits=$commit_count, pr-body-present=no)"
    cleanup_worktree "$wt"
    release_after_authoring "$issue" "$timed_out"
    return 0
  fi

  # Defensive push — the child SHOULD have pushed, but a supervising loop
  # that silently trusted that would be exactly the kind of unverified claim
  # CLAUDE.md warns against.
  if [[ "$DRY_RUN" != "1" ]]; then
    git -C "$wt" push -u origin "$branch" --quiet 2>&1 | while IFS= read -r line; do log "git push: $line"; done || true
  fi

  # INV-3: a salvaged (timed-out) session takes the IDENTICAL fence as a
  # clean one — same defensive push above, same preflight, same open_pr
  # (never a draft) — plus one addition: the trailing plain-text note that
  # discloses the cutoff.
  if [[ "$timed_out" == "true" ]]; then
    append_timeout_note "$body_file"
  fi

  git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null || true
  local changed_files_file
  changed_files_file="${TMPDIR:-/tmp}/hydra-glm-drainer-changed-${issue}.txt"
  git -C "$wt" diff --name-only origin/master...HEAD > "$changed_files_file" 2>/dev/null || true

  local preflight_json preflight_ok
  preflight_json="$(run_preflight_check "$changed_files_file")"
  preflight_ok=$(jq -r '.ok // false' <<<"$preflight_json" 2>/dev/null || echo "false")

  if [[ "$preflight_ok" != "true" ]]; then
    log "preflight BLOCKED for issue #$issue: $preflight_json"
    cleanup_worktree "$wt"
    delete_remote_branch_if_pushed "$branch"
    release_issue "$issue" "true" # withhold — this issue hit the T2/T3 fence
    return 0
  fi

  log "preflight passed for issue #$issue — opening PR"
  if open_pr "$issue" "$branch" "$wt"; then
    timeout_counter_remove "$issue" # INV-6: a PR opened — the timeout budget resets
    advance_to_needs_qa "$issue"
    cap_increment
    log "issue #$issue: PR opened (branch=$branch), advanced to needs-qa, daily cap incremented"
  else
    log "PR creation failed for issue #$issue — releasing claim (branch/worktree left for operator inspection)"
    release_after_authoring "$issue" "$timed_out"
    return 0
  fi

  cleanup_worktree "$wt"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  mkdir -p "$CAP_DIR" 2>/dev/null || true

  acquire_lock_or_heartbeat_and_exit

  local paused
  paused="$(is_operator_paused)"
  if [[ "$paused" == "true" ]]; then
    log "operator paused — skip (no heartbeat; kill-switch honors ONLY operator paused, ignoring Anthropic reasons per ADR-0032 Decision 6)"
    exit 0
  fi

  local cap_exhausted
  cap_exhausted="$(is_cap_exhausted)"
  if [[ "$cap_exhausted" == "true" ]]; then
    log "daily PR cap reached ($(cap_count)/$DAILY_CAP) — skip (no heartbeat)"
    exit 0
  fi

  # Committed to running this tick: neither paused nor cap-exhausted, so the
  # drainer IS "able to author" — write the heartbeat now.
  write_heartbeat "able"

  recover_stale_glm_claims

  local issue
  issue="$(pick_eligible_issue)"
  if [[ -z "$issue" ]]; then
    log "no glm-eligible + ready-for-agent issue with an approved design concept — idle"
    exit 0
  fi

  log "picked issue #$issue"
  attempt_one_issue "$issue"

  exit 0
}

# Sourceable for tests (test/glm-drainer-loop.test.mts) without running main.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
