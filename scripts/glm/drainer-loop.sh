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
#      TypeScript function via a small generated Node driver — see
#      `write_heartbeat()` / `node_driver_path()` below.
#   5. Crash recovery: any `glm-eligible` issue stuck `in-progress` for >90
#      min is re-queued via the EXISTING `scripts/autopilot/recover-stale.sh`
#      (reused, not reimplemented, per the issue body).
#   6. Pick a `glm-eligible` + `ready-for-agent` issue (oldest first) that
#      also has an APPROVED design-concept artifact
#      (`GET /api/design-concepts/issue-<N>`, `.status == "approved"`) —
#      `design_concept_orch` designs every glm-eligible issue before the
#      drainer may touch it (ADR-0032 Decision 1).
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
#      body back to this loop despite that denial.
#   9. Preflight: `preflightBeforePr` (secret-scan + Verifier-Core/T4 diff
#      gate, `src/glm/drainer-runner.ts`) MUST pass before this loop's OWN
#      `gh pr create`.
#  10. `gh pr create --label glm-authored` (ADR-0032 Decision 5 — provenance
#      by label, since the drainer's worktree branch shares the
#      `worktree-agent-*` prefix Opus `dev_orch` PRs also use, so a
#      branch-name carve-out cannot discriminate them).
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
#   HYDRA_AUTOPILOT_REPO
#       Override the GitHub repo (default gaberoo322/hydra) — same var name
#       recover-stale.sh already reads, so one override affects both.
#   HYDRA_GLM_DRAINER_REPO_ROOT
#       Override the repo root the generated Node driver imports from
#       (defaults to this script's own repo). Lets a test point the driver
#       at a fixture checkout.
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
WORKTREE_ROOT="${HYDRA_GLM_DRAINER_WORKTREE_ROOT:-/home/gabe/hydra/.claude/worktrees}"
GLM_LABEL_ELIGIBLE="glm-eligible"
GLM_LABEL_WITHHOLD="glm-withhold"
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
# Generated Node driver — the bash↔TypeScript bridge
# ---------------------------------------------------------------------------
#
# Bash cannot import a TS module directly. Rather than an inline `node -e`
# string (fragile escaping for a multi-mode script), this writes a small,
# static driver file once per tick and invokes it with a mode argv. Every
# mode prints exactly one JSON line to stdout; a non-zero exit means the
# DRIVER ITSELF faulted (bad argv, import failure) — distinct from a mode's
# own result carrying `ok:false` (e.g. a blocked preflight is a completed,
# successful CHECK whose verdict is negative).
node_driver_path() {
  echo "${TMPDIR:-/tmp}/hydra-glm-drainer-driver.mts"
}

write_node_driver() {
  local path
  path="$(node_driver_path)"
  cat > "$path" <<'JS_EOF'
// Generated by scripts/glm/drainer-loop.sh (issue #3689) — do not edit by
// hand, it is overwritten every tick. Bridges the bash loop to the
// TypeScript seams it must use: src/redis/autopilot.ts (heartbeat, per the
// CLAUDE.md Redis-seam rule) and src/glm/drainer-runner.ts (env/argv/spawn/
// preflight, issue #3688 / ADR-0032).
//
// Invoked as: node --experimental-strip-types <this-file> <mode> [...args]
// REPO_ROOT is read from the GLM_DRAINER_REPO_ROOT env var so the caller
// controls exactly which checkout's src/ this resolves against.
const REPO_ROOT = process.env.GLM_DRAINER_REPO_ROOT;

async function main() {
  if (!REPO_ROOT) throw new Error("GLM_DRAINER_REPO_ROOT not set");
  const mode = process.argv[2];

  if (mode === "heartbeat") {
    const { setGlmDrainerHeartbeat } = await import(`${REPO_ROOT}/src/redis/autopilot.ts`);
    const r = await setGlmDrainerHeartbeat();
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exit(r.ok ? 0 : 1);
  }

  if (mode === "preflight") {
    const changedFilesPath = process.argv[3];
    if (!changedFilesPath) throw new Error("preflight mode requires <changed-files-file>");
    const fs = await import("node:fs");
    const changedPaths = fs
      .readFileSync(changedFilesPath, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const { preflightBeforePr } = await import(`${REPO_ROOT}/src/glm/drainer-runner.ts`);
    const r = await preflightBeforePr({ changedPaths });
    process.stdout.write(JSON.stringify(r) + "\n");
    // The CHECK completing is success at the driver level, regardless of the
    // verdict it carries (ok:true vs ok:false — a blocked diff is a valid,
    // completed preflight result, not a driver fault).
    process.exit(0);
  }

  if (mode === "author") {
    const promptPath = process.argv[3];
    const cwd = process.argv[4];
    if (!promptPath || !cwd) throw new Error("author mode requires <prompt-file> <cwd>");
    const fs = await import("node:fs");
    const prompt = fs.readFileSync(promptPath, "utf8");
    const { buildGlmEnv, buildDrainerArgs, runGlmClaude, GLM_API_TIMEOUT_MS } = await import(
      `${REPO_ROOT}/src/glm/drainer-runner.ts`
    );
    const { defaultClaudeSpawn } = await import(`${REPO_ROOT}/src/claude-cli/exec.ts`);

    const envResult = buildGlmEnv(process.env);
    if (!envResult.ok) {
      process.stdout.write(JSON.stringify({ ok: false, code: envResult.code, message: envResult.message }) + "\n");
      process.exit(0);
    }
    const argsResult = buildDrainerArgs({ prompt });
    if (!argsResult.ok) {
      process.stdout.write(JSON.stringify({ ok: false, code: argsResult.code, message: argsResult.message }) + "\n");
      process.exit(0);
    }
    const run = await runGlmClaude(defaultClaudeSpawn, "claude", argsResult.args, GLM_API_TIMEOUT_MS, {
      env: envResult.env,
      cwd,
    });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        code: run.code,
        // Truncated: this is a log/diagnostic surface, not the source of
        // truth for what the session did (that's the git diff + the
        // .glm-drainer-pr-body.md file it was told to write).
        stdout: run.stdout.slice(-4000),
        stderr: run.stderr.slice(-4000),
      }) + "\n",
    );
    process.exit(0);
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((err) => {
  process.stderr.write("glm-drainer driver threw: " + (err && err.stack ? err.stack : String(err)) + "\n");
  process.exit(1);
});
JS_EOF
  echo "$path"
}

run_driver() {
  local mode="$1"
  shift || true
  local driver
  driver="$(write_node_driver)"
  GLM_DRAINER_REPO_ROOT="$REPO_ROOT" node --experimental-strip-types "$driver" "$mode" "$@"
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
  # supposed to never apply glm-eligible alongside it.
  candidates=$(jq -r --arg withhold "$GLM_LABEL_WITHHOLD" \
    '[.[] | select((.labels | map(.name) | index($withhold)) | not)] | sort_by(.updatedAt) | .[].number' \
    <<<"$rows" 2>/dev/null)
  local n
  while IFS= read -r n; do
    [[ -z "$n" ]] && continue
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

compose_prompt() {
  local issue="$1"
  local issue_body="$2"
  local scope_section
  scope_section=$(printf '%s\n' "$issue_body" | awk '
    BEGIN{on=0}
    /^##[[:space:]]*Files in scope/{on=1}
    /^##[[:space:]]*Files out of scope/{on=1}
    on && /^##[[:space:]]/ && !/Files (in|out of) scope/ && ++seen>1 {on=0}
    on{print}
  ')
  cat <<PROMPT_EOF
/hydra-dev ${issue}

---

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

  gh pr create --repo "$REPO" \
    --base master --head "$branch" \
    --title "$title" \
    --body-file "$body_file" \
    --label "$GLM_LABEL_AUTHORED" \
    || {
      log "ERROR gh pr create failed for issue #$issue branch=$branch"
      return 1
    }
}

# ---------------------------------------------------------------------------
# Worktree lifecycle
# ---------------------------------------------------------------------------

create_worktree() {
  local issue="$1"
  local ts
  ts="$(date +%s)"
  local branch="worktree-agent-glm-${issue}-${ts}"
  local wt="${WORKTREE_ROOT}/agent-glm-${issue}-${ts}"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "would-create-worktree issue #$issue branch=$branch path=$wt (DRY_RUN=1)"
    echo "$branch|$wt"
    return 0
  fi

  git -C "$REPO_ROOT" fetch origin --quiet 2>/dev/null || true
  # This function's stdout IS its return contract ("branch|wt", captured by the
  # caller) — git's porcelain output must never reach it (issue #3863).
  if ! git -C "$REPO_ROOT" worktree add -b "$branch" "$wt" origin/master >/dev/null 2>&1; then
    log "ERROR failed to create worktree for issue #$issue"
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
# One authoring attempt, end to end (steps 6-10)
# ---------------------------------------------------------------------------

attempt_one_issue() {
  local issue="$1"
  log "claiming issue #$issue"
  claim_issue "$issue"

  local issue_body
  issue_body=$(gh issue view "$issue" --repo "$REPO" --json body --jq '.body' 2>/dev/null || echo "")

  local wt_result branch wt
  if ! wt_result="$(create_worktree "$issue")"; then
    log "ERROR could not create a worktree for issue #$issue — releasing claim"
    release_issue "$issue" "false"
    return 0
  fi
  branch="${wt_result%%|*}"
  wt="${wt_result##*|}"

  local prompt_file
  prompt_file="${TMPDIR:-/tmp}/hydra-glm-drainer-prompt-${issue}.txt"
  compose_prompt "$issue" "$issue_body" > "$prompt_file"

  log "authoring issue #$issue in $wt (branch=$branch)"
  local author_json
  author_json="$(run_author_session "$issue" "$wt" "$prompt_file")"
  log "authoring session finished: $(echo "$author_json" | head -c 300)"

  local author_ok
  author_ok=$(jq -r '.ok // false' <<<"$author_json" 2>/dev/null || echo "false")
  if [[ "$author_ok" != "true" ]]; then
    log "authoring session did not run (buildGlmEnv/buildDrainerArgs failed closed) for issue #$issue — releasing claim"
    cleanup_worktree "$wt"
    release_issue "$issue" "false"
    return 0
  fi

  # Did anything land? Zero commits ahead of origin/master, or a missing
  # .glm-drainer-pr-body.md, both mean "nothing usable was produced" — NOT a
  # fence violation, just an incomplete run. Release for a retry (by GLM or
  # by Opus); do not withhold.
  local commit_count
  commit_count="$(git -C "$wt" rev-list --count origin/master..HEAD 2>/dev/null || echo "0")"
  local body_file="$wt/.glm-drainer-pr-body.md"
  if [[ "$DRY_RUN" != "1" ]] && { [[ "$commit_count" -eq 0 ]] || [[ ! -s "$body_file" ]]; }; then
    log "issue #$issue: nothing usable produced (commits=$commit_count, pr-body-present=$([[ -s "$body_file" ]] && echo yes || echo no)) — releasing claim"
    cleanup_worktree "$wt"
    delete_remote_branch_if_pushed "$branch"
    release_issue "$issue" "false"
    return 0
  fi

  # Defensive push — the child SHOULD have pushed, but a supervising loop
  # that silently trusted that would be exactly the kind of unverified claim
  # CLAUDE.md warns against.
  if [[ "$DRY_RUN" != "1" ]]; then
    git -C "$wt" push -u origin "$branch" --quiet 2>&1 | while IFS= read -r line; do log "git push: $line"; done || true
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
    advance_to_needs_qa "$issue"
    cap_increment
    log "issue #$issue: PR opened (branch=$branch), advanced to needs-qa, daily cap incremented"
  else
    log "PR creation failed for issue #$issue — releasing claim (branch/worktree left for operator inspection)"
    release_issue "$issue" "false"
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
