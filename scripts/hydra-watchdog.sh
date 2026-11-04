#!/usr/bin/env bash
#
# hydra-watchdog.sh — consolidated Hydra watchdog (issue #705)
#
# This script merges the two previously-separate watchdog scripts into one
# unit that runs at the finer (2-minute) cadence. It is split into two
# clearly-labelled blocks, each with its OWN stale threshold:
#
#   ## SERVICE LIVENESS   — the former hydra-orchestrator-watchdog.sh logic
#                           (HTTP / docker / scheduler-staleness / tunnel,
#                           incl. the deliberate-stop reconciliation), now the
#                           TS CLI `hydra-watchdog.ts liveness` (issue #5096).
#                           Stale threshold: 15 min.
#   ## AUTOPILOT WEDGE     — the former hydra-autopilot-watchdog.sh PID-kill
#                           logic (incl. the HYDRA_AUTOPILOT_WATCHDOG_* test
#                           hooks). Stale threshold: 25 min. Do NOT shorten
#                           the SIGKILL threshold.
#
# The two blocks are INDEPENDENT: each is implemented as a function whose
# early returns short-circuit only that block. The original scripts used
# `exit 0` for those short-circuits; here those become `return 0` so a
# service-liveness short-circuit does NOT prevent the autopilot-wedge block
# from running on the same tick. The internal logic of each block is
# otherwise preserved verbatim from the source scripts.
#
# ⚠️ Tier-0 / Untouchable Core (ADR-0001). This is a live recovery mechanism.
# Source of truth: this file in the repo at scripts/hydra-watchdog.sh.
# Deployed by scripts/deploy.sh to ~/.local/bin/hydra-watchdog.sh.

set -euo pipefail

# =============================================================================
# ## SERVICE LIVENESS — ported to TypeScript (issue #5096, epic #5094)
# =============================================================================
#
# The liveness check (Redis ping, boot-window guards, /api/health, scheduler
# status + tick staleness, pending-work scheduler recovery, tunnel) now lives
# in scripts/hydra-watchdog.ts `liveness` over src/watchdog/liveness.ts (four
# pure predicates + a runLiveness over typed ports). See
# docs/operations/watchdog.md. It runs FIRST on every tick (before the wedge
# CLI), through run_watchdog_cli below.

# =============================================================================
# ## AUTOPILOT WEDGE — ported to TypeScript (issue #5095, epic #5094)
# =============================================================================
#
# The wedge check (SIGTERM, grace, SIGKILL of a frozen autopilot PID once its
# OS heartbeat is stale) now lives in scripts/hydra-watchdog.ts over
# src/watchdog/wedge.ts (a pure decideWedge + a runWedge over typed ports), with
# its thresholds in src/autopilot/stale-thresholds.ts. Do NOT shorten the
# SIGKILL threshold. The CLI runs from the deployed checkout ($HYDRA_ROOT), like
# operator-notify.ts; it always exits 0 itself, and this wrapper turns a missing
# node / broken runtime into a WARN line so the other blocks still run.

# Resolve a node binary WITHOUT relying on the caller's PATH: the systemd user
# unit sets no PATH, and Node is nvm-pinned (.nvmrc), so a bare `node` can be
# absent there while the deploy smoke (runner shell) passes — silently
# disarming the SIGKILL gate. Order: HYDRA_WATCHDOG_NODE override, PATH, then
# the newest nvm-installed node under $HOME. Prints the path; rc 1 if none.
resolve_watchdog_node() {
  local cand
  if [ -n "${HYDRA_WATCHDOG_NODE:-}" ] && [ -x "$HYDRA_WATCHDOG_NODE" ]; then
    printf '%s\n' "$HYDRA_WATCHDOG_NODE"; return 0
  fi
  if cand="$(command -v node 2>/dev/null)" && [ -n "$cand" ]; then
    printf '%s\n' "$cand"; return 0
  fi
  cand="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1)"
  if [ -n "$cand" ] && [ -x "$cand" ]; then
    printf '%s\n' "$cand"; return 0
  fi
  return 1
}

# run_watchdog_cli <subcommand> <log-prefix> <timeout-s>
# Runs one scripts/hydra-watchdog.ts subcommand. The CLI always exits 0 itself;
# a missing node or a non-zero exit (timeout, broken runtime) is ONE WARN line,
# never an aborted tick — every other block still runs.
run_watchdog_cli() {
  local sub="$1" prefix="$2" timeout_s="$3" node_bin rc=0
  if ! node_bin="$(resolve_watchdog_node)"; then
    echo "$prefix WARN node not found (PATH, HYDRA_WATCHDOG_NODE, ~/.nvm) — $sub check skipped this tick"
    return 0
  fi
  timeout "$timeout_s" "$node_bin" --experimental-strip-types "${HYDRA_ROOT:-$HOME/hydra}/scripts/hydra-watchdog.ts" "$sub" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "$prefix WARN $sub CLI FAILED (rc=$rc) — $sub check skipped this tick"
  fi
  return 0
}

run_liveness_cli() { run_watchdog_cli liveness "hydra-orchestrator-watchdog:" 300; }
run_wedge_cli() { run_watchdog_cli wedge "hydra-autopilot-watchdog:" 90; }
# TMPFS EXHAUSTION (issue #5327): /tmp + /dev/shm inode and space use, graded
# independently, paged through the Operator Channel once per episode — the
# 2026-10-31 inode-full outage was silent. Lives in src/watchdog/disk.ts; the
# 90s bound covers the 20s-capped `du --inodes` walk plus the channel calls.
run_disk_cli() { run_watchdog_cli disk "hydra-disk-watchdog:" 90; }
# LAUNCH FLOW (issue #5097): pace-gate last-tick streaks + the GLM-sterile signal;
# the 90s bound covers the 60s CLI force-exit (LAUNCH_FLOW_FORCE_EXIT_MS).
run_launch_flow_cli() { run_watchdog_cli launch-flow "hydra-launch-flow-watchdog:" 90; }

# =============================================================================
# ## DEPLOY DRIFT — ported to TypeScript (issue #5098, epic #5094)
# =============================================================================
#
# The deploy-drift backstop (#734) now lives in scripts/hydra-watchdog.ts
# `deploy-drift` over src/watchdog/deploy-drift.ts (a pure decide + a run over
# typed ports; the SHA reads and the first-seen transition are
# src/health/deployed-sha.ts). Advisory by default; the opt-in
# HYDRA_WATCHDOG_AUTODEPLOY path runs scripts/deploy.sh, so the wrapper bound
# is 1200s. See docs/operations/watchdog.md.
run_deploy_drift_cli() { run_watchdog_cli deploy-drift "hydra-deploy-drift-watchdog:" 1200; }

# =============================================================================
# ## REDIS BACKUP FRESHNESS — ported to TypeScript (issue #5098, epic #5094)
# =============================================================================
#
# The backup-freshness backstop (#4604) now lives in scripts/hydra-watchdog.ts
# `redis-backup` over src/watchdog/redis-backup.ts, on the shared episode
# tracker (threshold 0). See docs/operations/watchdog.md.
run_redis_backup_cli() { run_watchdog_cli redis-backup "hydra-redis-backup-freshness-watchdog:" 90; }

# =============================================================================
# ## CLAUDE HOOKS
# =============================================================================
#
# Issue #5064. scripts/setup-claude-hooks.sh owns the HOOKS array of Claude
# Code PreToolUse hooks (worktree-write-fence.sh, git-remote-fence.sh, …). For
# months nothing in the deploy path ran it, so git-remote-fence.sh (#4939,
# merged in #4980) was never installed and never protected a session — and
# nothing noticed. scripts/deploy.sh now runs the installer on every deploy;
# this block is the backstop alarm for when the live install still lacks a
# hook (a failed deploy step, a hand-edited settings.json, a wiped hooks dir).
#
# Fails (alarms) when ANY hook listed by `setup-claude-hooks.sh --list` (the
# single source of truth — never a second copy of the list here) is
#   (a) missing as a file under the installed hooks dir, OR
#   (b) not registered in settings.json's hooks.PreToolUse — registered means
#       a block whose `matcher` EQUALS the --list entry's matcher and which
#       holds a `{"type":"command","command":"bash <hooks dir>/<name>"}` hook
#       (exactly what the installer writes; a substring match would accept a
#       wrong matcher or a decorated command) — OR the settings file is
#       absent/unparseable (Claude Code would load no hooks from it either).
#
# STRICTLY READ-ONLY: never installs or repairs — `bash scripts/deploy.sh` (or
# `bash scripts/setup-claude-hooks.sh`) is the fix, run from an operator shell.
# One enveloped XADD onto hydra:notifications per episode (type
# infra:claude_hooks_missing), dedup'd by a since marker that is created only
# after the XADD succeeds and cleared (re-armed) once everything is present.
# "Succeeds" means the reply is a stream id (^[0-9]+-[0-9]+$): `redis-cli
# --raw` prints an error reply (ERR …, WRONGTYPE …) on stdout and still exits
# 0, so a merely non-empty reply must NOT write the marker — that would
# silence the alarm for the whole episode with nothing delivered.
#
# Fail-safe: any tooling failure (installer script missing, --list failing,
# python3 missing) logs WARN and returns 0.
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-claude-hooks.test.mts):
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_SETUP         Installer script read for the
#                                             expected list (default
#                                             $HYDRA_ROOT/scripts/setup-claude-hooks.sh).
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_DIR           Installed hooks dir (default
#                                             $HOME/.claude/hooks/hydra).
#   HYDRA_WATCHDOG_CLAUDE_SETTINGS            Settings file (default
#                                             $HOME/.claude/settings.json).
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_STATE_DIR     Marker dir (default /tmp).
#   HYDRA_WATCHDOG_CLAUDE_HOOKS_NOTIFY_STREAM Notification stream (default
#                                             hydra:notifications).

run_claude_hooks() {
  local HYDRA_ROOT="${HYDRA_ROOT:-/home/gabe/hydra}"
  local SETUP="${HYDRA_WATCHDOG_CLAUDE_HOOKS_SETUP:-${HYDRA_ROOT}/scripts/setup-claude-hooks.sh}"
  local HOOKS_DIR="${HYDRA_WATCHDOG_CLAUDE_HOOKS_DIR:-$HOME/.claude/hooks/hydra}"
  local SETTINGS="${HYDRA_WATCHDOG_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
  local STATE_DIR="${HYDRA_WATCHDOG_CLAUDE_HOOKS_STATE_DIR:-/tmp}"
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_CLAUDE_HOOKS_NOTIFY_STREAM:-hydra:notifications}"
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  local SINCE_MARKER="${STATE_DIR}/hydra-claude-hooks-missing.since"

  ch_log() {
    echo "hydra-claude-hooks-watchdog: $*"
  }

  # Output-returning call ("" on any failure) so the XADD result can gate the
  # dedup marker.
  ch_rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  if [[ ! -f "$SETUP" ]]; then
    ch_log "WARN installer ${SETUP} not found — skipping claude hooks check"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    ch_log "WARN python3 not found — skipping claude hooks check"
    return 0
  fi

  # --- Expected hooks: the installer's own HOOKS array (single source) ---
  local listing="" list_rc=0
  listing="$(bash "$SETUP" --list 2>/dev/null)" || list_rc=$?
  if (( list_rc != 0 )); then
    ch_log "WARN ${SETUP} --list failed (rc=${list_rc}) — skipping claude hooks check"
    return 0
  fi
  # entries keep the full "name|matcher" line for the registration check;
  # names is just the hook filename for the installed-file check.
  local entries=() names=() entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    entries+=("$entry")
    names+=("${entry%%|*}")
  done <<< "$listing"
  if (( ${#names[@]} == 0 )); then
    ch_log "WARN ${SETUP} --list returned no hooks — skipping claude hooks check"
    return 0
  fi

  mkdir -p "$STATE_DIR" 2>/dev/null || {
    ch_log "WARN cannot create state dir ${STATE_DIR} — skipping claude hooks check"
    return 0
  }

  local reasons=() name
  # (a) installed hook files
  for name in "${names[@]}"; do
    [[ -f "${HOOKS_DIR}/${name}" ]] || reasons+=("file-missing:${name}")
  done

  # (b) settings.json PreToolUse registrations. Prints one line per hook that
  # is NOT registered, or the single token SETTINGS_UNREADABLE.
  local unregistered="" py_rc=0
  unregistered="$(python3 - "$SETTINGS" "$HOOKS_DIR" "${entries[@]}" <<'PY' 2>/dev/null
import json, sys
settings_path, hooks_dir, *entries = sys.argv[1:]
try:
    with open(settings_path, encoding="utf-8") as f:
        data = json.load(f)
    pre = data.get("hooks", {}).get("PreToolUse", [])
    if not isinstance(pre, list):
        pre = []
except Exception:
    print("SETTINGS_UNREADABLE")
    sys.exit(0)
# Exact (matcher, command) pairs of every command hook, mirroring the shape
# setup-claude-hooks.sh writes: {"matcher": M, "hooks": [{"type": "command",
# "command": "bash <dir>/<name>"}]}.
registered = set()
for block in pre:
    if not isinstance(block, dict):
        continue
    matcher = block.get("matcher")
    for h in block.get("hooks", []) or []:
        if isinstance(h, dict) and h.get("type") == "command":
            registered.add((matcher, h.get("command")))
for entry in entries:
    name, _, matcher = entry.partition("|")
    if (matcher, f"bash {hooks_dir.rstrip('/')}/{name}") not in registered:
        print(name)
PY
)" || py_rc=$?
  if (( py_rc != 0 )); then
    ch_log "WARN settings parser failed (rc=${py_rc}) — skipping claude hooks check"
    return 0
  fi
  local u
  while IFS= read -r u; do
    [[ -n "$u" ]] || continue
    if [[ "$u" == "SETTINGS_UNREADABLE" ]]; then
      reasons+=("settings-unreadable")
    else
      reasons+=("unregistered:${u}")
    fi
  done <<< "$unregistered"

  if (( ${#reasons[@]} == 0 )); then
    if [[ -f "$SINCE_MARKER" ]]; then
      ch_log "claude hooks healthy again — dedup re-armed"
    fi
    rm -f "$SINCE_MARKER" 2>/dev/null || true
    ch_log "claude-hooks tick processed (${#names[@]} hook(s) installed and registered: ${names[*]})"
    return 0
  fi

  local reason_str
  reason_str="$(IFS=,; echo "${reasons[*]}")"
  ch_log "ALARM Claude Code PreToolUse hooks not fully installed: ${reason_str} (hooks dir ${HOOKS_DIR}, settings ${SETTINGS}; issue #5064 — run 'bash scripts/setup-claude-hooks.sh' or 'bash scripts/deploy.sh' from an operator shell)"

  if [[ ! -f "$SINCE_MARKER" ]]; then
    local iso_now payload reason_clean xadd_out
    iso_now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
    reason_clean="$(printf '%s' "$reason_str" | tr -dc 'a-zA-Z0-9_.:,-')"
    payload="$(printf '{"signal":"claude-hooks","reason":"%s"}' "$reason_clean")"
    xadd_out="$(ch_rc_read XADD "$NOTIFY_STREAM" '*' \
      id "claude-hooks-$(date +%s 2>/dev/null || echo 0)-$$" \
      type "infra:claude_hooks_missing" \
      source "watchdog-claude-hooks" \
      timestamp "$iso_now" \
      correlationId "claude-hooks" \
      payload "$payload")"
    # Only a stream id proves the entry landed. An error reply (ERR …,
    # WRONGTYPE …, NOAUTH …) is printed on stdout with exit 0 by `redis-cli
    # --raw`; treating it as success would write the marker and silence the
    # whole episode.
    if [[ "$xadd_out" =~ ^[0-9]+-[0-9]+$ ]]; then
      date +%s > "$SINCE_MARKER" 2>/dev/null || true
      ch_log "in-band delivery published type=infra:claude_hooks_missing -> ${NOTIFY_STREAM} (id ${xadd_out})"
    else
      local reply_snip
      reply_snip="$(printf '%s' "$xadd_out" | tr '\n' ' ' | cut -c1-160)"
      ch_log "WARN in-band delivery FAILED (XADD reply '${reply_snip}' is not a stream id) — will retry next tick"
    fi
  fi
  return 0
}

# =============================================================================
# ## SKILL MIRROR DRIFT — ported to TypeScript (issue #5098, epic #5094)
# =============================================================================
#
# The skill-mirror drift backstop (#3828) now lives in scripts/hydra-watchdog.ts
# `skill-mirror` over src/watchdog/skill-mirror.ts. The opt-in
# HYDRA_WATCHDOG_SKILL_MIRROR_AUTOFIX path runs scripts/sync-skills.sh, so the
# wrapper bound is 300s. See docs/operations/watchdog.md.
run_skill_mirror_cli() { run_watchdog_cli skill-mirror "hydra-skill-mirror-drift-watchdog:" 300; }

# =============================================================================
# ## NODE MODULES INTEGRITY
# =============================================================================
#
# Detection + delivery for the 2026-08-19 incident (issue #4175): a `/dev/shm`
# hydra-betting worktree's `web/node_modules` symlink reached back through the
# main checkout, and a destructive install step inside the worktree wiped
# `/home/gabe/hydra-betting/web/node_modules` — taking down six money-critical
# Target services for ~70 minutes with NO signal to anything watching the main
# checkout. The structural prevention (eliminating the reach-back symlink) is
# tracked separately in #4177; this block is the detection backstop, valuable
# regardless of which prevention lands because it is the only mitigation that
# covers causes nobody has anticipated.
#
# What it asserts
# ----------------
# Not "the directory shrank" (needs stored history + an uncalibratable
# threshold) but the structural invariant the incident actually violated —
# the binaries the live services execute exist:
#   1. the watched root exists, contains `.bin/`, and holds at least
#      ENTRY_FLOOR top-level entries (observed wiped: 24K / no `.bin/`;
#      observed healthy: ~995M / ~450 entries — the gap needs no tuning).
#   2. the specific `.bin/` entry the live systemd units reference (the five
#      `ExecStart=.../web/node_modules/.bin/tsx …` units that died
#      `203/EXEC`) exists and is executable. Hardcoded to `tsx` — the one the
#      watched services use — rather than derived from the unit files, per
#      the issue's explicit fallback.
# A resolvable-import probe (the checkpoint-refresh `ERR_MODULE_NOT_FOUND`
# symptom) is intentionally NOT implemented — checks 1+2 already cover both
# observed failure symptoms from the incident.
#
# Watched roots (a list, never a literal buried in a condition; override via
# HYDRA_WATCHDOG_NM_ROOTS for tests, colon-separated):
#   $HOME/hydra/node_modules                    (the orchestrator — always)
#   <target workspace>/<appSubdir>/node_modules (the LIVE Target, resolved
#                                                through the target-config
#                                                seam scripts/target/
#                                                print-target-facts.ts, #4608;
#                                                the incident root was the
#                                                mothballed Target's
#                                                web/node_modules, which is
#                                                no longer watched)
# The Target resolve is best-effort: on any seam failure the block logs a
# WARN and watches only the orchestrator root — fail OPEN on Target
# coverage, never on orchestrator coverage.
#
# Delivery reuses the #3848 taxonomy this file already established for
# run_launch_flow: the SAME uniform streak-rule / dedup design (Redis SET
# NX since + fired, DEL on recovery) and the SAME in-band delivery surface
# (an enveloped XADD onto hydra:notifications — the Orchestrator is
# demonstrably up when this check runs, since it is the thing running the
# check, so out-of-band is not warranted here the way it is for
# fail-safe/meter-dark). It is a SEPARATE block (a filesystem invariant is
# not a pace-gate reason and cannot share run_launch_flow's `now_ms`/`reason`
# derivation) but must never diverge from that design — if you change the
# streak/dedup shape here, check whether run_launch_flow needs the same
# change. Threshold is 0ms: a wiped node_modules under a live service is not
# something to wait out a streak on, so the fired marker sets (and delivery
# fires) on the very first qualifying tick — dedup then suppresses re-alarm
# for the duration of the outage, and recovery (DEL) re-arms a fresh streak.
#
# Surface: IN-BAND, in BOTH ALERT_TYPES (src/notification/alert-grammar.ts)
# and PAGE_KINDS (src/operator-channel/page-list.ts) — six money-critical
# services down warrants both the dashboard alert and an Operator Channel page.
# Event type pinned in test/event-bus-vocabulary.test.mts's EXPECTED_MEMBERS
# (that enum-completeness arm fails by design until a new member is
# deliberately pinned).
#
# Fail-safe (HARD): mirrors run_launch_flow's contract — this block NEVER
# throws and NEVER returns non-zero. All redis-cli / stat calls are
# best-effort (`|| true` / redirected), and a read failure never mutates a
# since/fired marker (never falsely clears an in-progress streak).
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-node-modules-integrity.test.mts):
#   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT        shared with the other blocks.
#   HYDRA_REDIS_DB                             DB index passed as `-n <db>` to
#                                               every rc_write/rc_read call
#                                               (default 0, the production DB).
#                                               Non-numeric input falls back to
#                                               0. scripts/test/redis-db-launch
#                                               .mjs exports the run's derived
#                                               per-run DB under this name, so
#                                               a test that shells into this
#                                               block writes into the run's
#                                               isolated DB instead of past it
#                                               onto production db 0 (#4183).
#   HYDRA_WATCHDOG_NM_NOW_MS                   inject `now` (epoch-ms).
#   HYDRA_WATCHDOG_NM_ROOTS                    colon-separated root override.
#   HYDRA_WATCHDOG_NM_ENTRY_FLOOR              default 20.
#   HYDRA_WATCHDOG_NM_REQUIRED_BIN             default "tsx".
#   HYDRA_WATCHDOG_NM_NOTIFY_STREAM            in-band delivery stream key
#                                               (default hydra:notifications);
#                                               rebound in tests so a case can
#                                               never write a real event onto
#                                               the PRODUCTION stream.

run_node_modules_integrity() {
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  # DB index for the bash-side redis-cli calls in rc_write/rc_read below
  # (issue #4183, mirroring run_launch_flow's identical treatment). Unset or
  # non-numeric input falls back to db 0 so production behaviour is
  # byte-identical to before this variable existed. scripts/test/
  # redis-db-launch.mjs exports the run's derived DB under this same name, so
  # any bash block a test shells into inherits the run's isolation
  # automatically rather than opting in per call site.
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  local NM_KEY_PREFIX="hydra:autopilot:node-modules-integrity"
  local NOTIFY_STREAM="${HYDRA_WATCHDOG_NM_NOTIFY_STREAM:-hydra:notifications}"
  local ENTRY_FLOOR="${HYDRA_WATCHDOG_NM_ENTRY_FLOOR:-20}"
  local REQUIRED_BIN="${HYDRA_WATCHDOG_NM_REQUIRED_BIN:-tsx}"
  [[ "$ENTRY_FLOOR" =~ ^[0-9]+$ ]] || ENTRY_FLOOR=20

  log() {
    echo "hydra-node-modules-integrity-watchdog: $*"
  }

  local -a WATCHED_ROOTS
  if [[ -n "${HYDRA_WATCHDOG_NM_ROOTS:-}" ]]; then
    IFS=':' read -r -a WATCHED_ROOTS <<< "$HYDRA_WATCHDOG_NM_ROOTS"
  else
    # Default roots (issue #4608): the orchestrator's own node_modules plus
    # the LIVE Target's app-dir node_modules — `<workspace>/<appSubdir>/
    # node_modules`, empty appSubdir = identity — resolved through the
    # target-config seam, never a hardcoded Target path (ADR-0002, ADR-0013
    # Decision 4). Every step is best-effort under `set -e`: a missing
    # seam / npx / jq degrades to "orchestrator root only" plus a WARN.
    WATCHED_ROOTS=(
      "$HOME/hydra/node_modules"
    )
    local target_facts target_nm_root
    target_facts="$(cd "$HOME/hydra" 2>/dev/null && npx tsx scripts/target/print-target-facts.ts 2>/dev/null || true)"
    target_nm_root="$(printf '%s' "$target_facts" | jq -r '
      if (.workspace // "") == "" then empty
      elif (.manifest.appSubdir // "") == "" then .workspace + "/node_modules"
      else .workspace + "/" + (.manifest.appSubdir | sub("/+$"; "")) + "/node_modules"
      end' 2>/dev/null || true)"
    if [[ -n "$target_nm_root" ]]; then
      WATCHED_ROOTS+=("$target_nm_root")
    else
      log "WARN — Target node_modules root unresolved via scripts/target/print-target-facts.ts; watching only the orchestrator root this tick"
    fi
  fi

  # rc_write/rc_read — same best-effort contract as run_launch_flow's helpers
  # (fire-and-forget mutation; "" on any read failure). Deliberately a second
  # copy rather than a shared top-level helper: hoisting would change
  # run_launch_flow's tested extraction boundary (test/watchdog-launch-flow
  # .test.mts and test/launch-flow-delivery.test.mts both extract that
  # function verbatim by name).
  rc_write() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    fi
  }
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  nm_since_key() { printf '%s:since:%s\n' "$NM_KEY_PREFIX" "$1"; }
  nm_fired_key() { printf '%s:fired:%s\n' "$NM_KEY_PREFIX" "$1"; }

  # sig_for_root ROOT — a stable, Redis-key-safe signal name derived from the
  # watched path (non-alnum runs collapsed to single underscores).
  sig_for_root() {
    printf '%s' "$1" | tr -c 'a-zA-Z0-9' '_' | tr -s '_'
  }

  # deliver_page SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045 D2,
  # issue #5046): the ONLY Telegram sender. It imports src/operator-channel/
  # directly, so it works with the Orchestrator down. The binary resolves
  # through HYDRA_WATCHDOG_OPERATOR_NOTIFY (tests: an argv-recording stub) and
  # defaults to node --experimental-strip-types — never npx tsx: a unit's
  # minimal PATH cannot see the global tsx. Best-effort by contract: timeout
  # 25, `|| log WARN`, always returns 0. Credentials are the CLI's concern
  # (one loader; the watchdog never reads TELEGRAM_*). Deliberately a per-block
  # copy, like rc_write: the test harnesses extract each block by slicing.
  deliver_page() {
    local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-node --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts}"
    local out err_file
    err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
    # stderr is kept so the WARN names WHY (a strip-types boot error, a
    # transport error) instead of a bare rc; the first Error line wins, else
    # the last line.
    # shellcheck disable=SC2086  # word-splitting binary+flags is intended
    out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" \
      && log "operator-notify $1 ok for '${3:-}' (${out:-no output})" \
      || log "WARN operator-notify $1 FAILED (rc=$?) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
    rm -f "$err_file" 2>/dev/null || true
    return 0
  }

  # deliver_signal SIG ROOT REASON DUR_MS THR_MS — enveloped XADD onto the
  # notifications stream, the exact on-wire shape src/event-bus.ts's publish()
  # constructs (ADR-0017 Category A), mirroring run_launch_flow's
  # deliver_in_band, PLUS one Operator Channel CLI page (#5046). Always
  # returns 0 (best-effort).
  deliver_signal() {
    local sig="$1" root="$2" reason="$3" dur_ms="$4" thr_ms="$5"
    local reason_clean
    reason_clean="$(printf '%s' "$reason" | tr -dc 'a-zA-Z0-9_.:-')"
    local root_clean
    root_clean="$(printf '%s' "$root" | tr -dc 'a-zA-Z0-9_./-')"
    local iso payload
    iso="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || echo "")"
    payload="$(printf '{"signal":"%s","reason":"%s","durationMs":%s,"thresholdMs":%s}' \
      "$root_clean" "$reason_clean" "$dur_ms" "$thr_ms")"
    rc_write XADD "$NOTIFY_STREAM" '*' \
      id "node-modules-integrity-$(date +%s 2>/dev/null || echo 0)-$$" \
      type "infra:node_modules_wiped" \
      source "watchdog-node-modules-integrity" \
      timestamp "$iso" \
      correlationId "node-modules-integrity-${sig}" \
      payload "$payload"
    log "in-band delivery published (best-effort) for '$root' (type=infra:node_modules_wiped -> ${NOTIFY_STREAM})"
    deliver_page page --kind "infra:node_modules_wiped" --dedup-key "infra:node_modules_wiped" \
      --title "node_modules integrity: '$root_clean' $reason_clean" \
      --fact "root=$root_clean" --fact "reason=$reason_clean" --fact "sustained_ms=$dur_ms" --fact "threshold_ms=$thr_ms"
    return 0
  }

  # track_signal SIG ROOT REASON THR_MS IS_MEMBER — the SAME uniform streak
  # rule as run_launch_flow's track_signal (SET NX since / fire once at
  # now-since >= threshold / DEL both on recovery), scoped to this block's own
  # key prefix. Always returns 0.
  track_signal() {
    local sig="$1" root="$2" reason="$3" thr_ms="$4" is_member="$5"
    local since_key fired_key
    since_key="$(nm_since_key "$sig")"
    fired_key="$(nm_fired_key "$sig")"
    if [[ "$is_member" == "1" ]]; then
      rc_write SET "$since_key" "$now_ms" NX
      local since dur
      since="$(rc_read GET "$since_key" | tr -dc '0-9')"
      [[ "$since" =~ ^[0-9]+$ ]] || since="$now_ms"
      dur=$((now_ms - since))
      if (( dur < 0 )); then dur=0; fi
      if (( dur >= thr_ms )); then
        if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" != "1" ]]; then
          log "WARNING NODE_MODULES INTEGRITY — '$root' ${reason} (sustained ${dur}ms >= ${thr_ms}ms threshold); see issue #4175"
          rc_write SET "$fired_key" 1
          deliver_signal "$sig" "$root" "$reason" "$dur" "$thr_ms"
        fi
      fi
    else
      # Recovery edge (#5046): CLI resolve only when the fired marker existed.
      if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" == "1" ]]; then
        deliver_page resolve --dedup-key "infra:node_modules_wiped" --title "node_modules integrity recovered: '$root'"
      fi
      rc_write DEL "$since_key" "$fired_key"
    fi
    return 0
  }

  local now_ms
  if [[ -n "${HYDRA_WATCHDOG_NM_NOW_MS+x}" ]]; then
    now_ms="$HYDRA_WATCHDOG_NM_NOW_MS"
  else
    now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
  fi
  [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms=0

  local root sig broken reason count
  for root in "${WATCHED_ROOTS[@]}"; do
    sig="$(sig_for_root "$root")"
    broken=0
    reason=""
    if [[ ! -d "$root" ]]; then
      broken=1
      reason="root-absent"
    elif [[ ! -d "$root/.bin" ]]; then
      broken=1
      reason="no-bin-dir"
    else
      count="$(find "$root" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -dc '0-9')"
      [[ "$count" =~ ^[0-9]+$ ]] || count=0
      if (( count < ENTRY_FLOOR )); then
        broken=1
        reason="below-entry-floor:${count}<${ENTRY_FLOOR}"
      elif [[ ! -x "$root/.bin/$REQUIRED_BIN" ]]; then
        broken=1
        reason="missing-binary:${REQUIRED_BIN}"
      fi
    fi
    # Threshold is always 0 — see header: no streak to wait out on a wiped
    # tree under a live service.
    track_signal "$sig" "$root" "$reason" 0 "$broken"
  done

  log "node-modules-integrity tick processed (${#WATCHED_ROOTS[@]} root(s) watched, now_ms=$now_ms)"
  return 0
}

# =============================================================================
# ## LAUNCH FLOW — ported to TypeScript (issue #5097, epic #5094)
# =============================================================================
#
# The launch-flow check (pace-gate last-tick streaks for fail-safe / meter-dark
# / quota / pause / latency, plus the GLM-sterile drainer signal) now lives in
# scripts/hydra-watchdog.ts `launch-flow` over src/watchdog/launch-flow.ts, with
# the streak/dedup rule written once in src/watchdog/episode.ts. Pages go
# through the Operator Channel module in-process; the in-band envelope through
# EventBus.publish(). See docs/operations/watchdog.md. Runs through
# run_watchdog_cli (entry list below).


# =============================================================================
# ## MORNING BRIEF MISSING
# =============================================================================
#
# Operator Channel delivery-health alarm (ADR-0045 Decision 8, issue #5048):
# page the operator ONCE when no Morning Brief has been delivered for 26h, and
# send the recovered message when one lands again.
#
# Why it lives here and not in the orchestrator
# ---------------------------------------------
# The brief (Decision 7) rides the scheduler heartbeat tick, so every way the
# brief can go silent — the orchestrator down, the scheduler deliberately
# stopped (`POST /scheduler/stop`), the transport failing for a day, the
# credentials unset — is a way the orchestrator could never report it. This
# block therefore reads the brief's ONLY timing state, the Redis key
# `hydra:operator-channel:brief:last-sent` (epoch ms, stamped by
# src/redis/operator-channel.ts ONLY after the transport reported a delivered
# send), directly with redis-cli — never through the orchestrator's HTTP API
# — and pages through the Operator Channel CLI, which imports the channel
# directly (Decision 6). The alarm is deliberately INDEPENDENT of the
# scheduler's running state: a stopped scheduler still earns a page after 26h,
# because the operator asked for a brief every day, not for one whenever the
# scheduler happens to run.
#
# Cold-start rule
# ---------------
# When the key has never been written (a fresh deploy, a restored Redis, or
# the key deleted) the block anchors `hydra:autopilot:brief-missing:absent-
# since` with SET NX at the FIRST tick that observes the absence and measures
# the 26h from that anchor — so a brand-new install gets a full 26h grace and
# then pages with reason `never-delivered`, instead of either paging on the
# first tick or staying silent forever. The anchor is DELeted the moment the
# key appears. (Rejected: anchoring on the orchestrator's first-start time,
# which would need the orchestrator API — the dependency this block exists to
# avoid.) A key holding an unparseable value is treated as absent.
#
# Reachability: an EXISTS that answers neither 0 nor 1 means Redis itself is
# unreachable — the block logs a WARN and leaves every state untouched (no
# page, no resolve, no anchor): the ## SERVICE LIVENESS block owns Redis-down,
# and an unreachable store must never masquerade as a missing brief.
#
# Delivery is the same edge-triggered shape the other blocks use: a fired
# marker SET on the first stale tick gates ONE `page` call per episode (the
# channel's own dedup would suppress a 2-minute repeat anyway, but every such
# call would inflate the suppressed counter the /health card shows), and the
# recovery tick calls `resolve` only when that marker existed, then DELs it.
#
# Fail-safe (HARD): never throws, never returns non-zero; every redis-cli /
# CLI call is best-effort.
#
# Testability hooks (off-by-default; pinned by
# test/watchdog-operator-channel.test.mts):
#   HYDRA_REDIS_HOST / HYDRA_REDIS_PORT / HYDRA_REDIS_DB  shared with the other
#                                               blocks (see run_launch_flow).
#   HYDRA_WATCHDOG_BRIEF_STALE_HOURS            threshold in hours (default 26).
#   HYDRA_WATCHDOG_BRIEF_NOW_MS                 deterministic clock (epoch ms)
#                                               so a test can age the key
#                                               without sleeping.
#   HYDRA_WATCHDOG_OPERATOR_NOTIFY              the CLI binary (tests: an
#                                               argv-recording stub).

run_brief_missing() {
  local REDIS_HOST="${HYDRA_REDIS_HOST:-docker}"
  local REDIS_PORT="${HYDRA_REDIS_PORT:-6379}"
  local REDIS_DB="${HYDRA_REDIS_DB:-0}"
  [[ "$REDIS_DB" =~ ^[0-9]+$ ]] || REDIS_DB=0
  # The TS-owned key name (BRIEF_LAST_SENT_KEY in src/redis/operator-channel.ts;
  # drift-guarded by the test). READ ONLY here — only the scheduler stamps it.
  local LAST_SENT_KEY="hydra:operator-channel:brief:last-sent"
  local BM_KEY_PREFIX="hydra:autopilot:brief-missing"
  local STALE_HOURS="${HYDRA_WATCHDOG_BRIEF_STALE_HOURS:-26}"
  [[ "$STALE_HOURS" =~ ^[0-9]+$ ]] || STALE_HOURS=26
  # Force base 10: a zero-padded value (e.g. "08") must not parse as octal under set -e.
  STALE_HOURS=$((10#$STALE_HOURS))
  local KIND="brief:missing"

  log() {
    echo "hydra-brief-missing-watchdog: $*"
  }

  # rc_write/rc_read — same best-effort contract as the sibling blocks
  # (fire-and-forget mutation; "" on any read failure). A per-block copy, like
  # theirs: the test harnesses extract each block by slicing.
  rc_write() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" >/dev/null 2>&1 || true
    fi
  }
  rc_read() {
    if [[ "$REDIS_HOST" == "docker" ]]; then
      timeout 5 docker exec hydra-redis-1 redis-cli --raw -n "$REDIS_DB" "$@" 2>/dev/null || true
    else
      timeout 5 redis-cli --raw -h "$REDIS_HOST" -p "$REDIS_PORT" -n "$REDIS_DB" "$@" 2>/dev/null || true
    fi
  }

  # deliver_page SUBCOMMAND ARGS... — the Operator Channel CLI (ADR-0045 D2,
  # issue #5046): the ONLY Telegram sender. It imports src/operator-channel/
  # directly, so it works with the Orchestrator down. The binary resolves
  # through HYDRA_WATCHDOG_OPERATOR_NOTIFY (tests: an argv-recording stub) and
  # defaults to node --experimental-strip-types — never npx tsx: a unit's
  # minimal PATH cannot see the global tsx. Best-effort by contract: timeout
  # 25, `|| log WARN`, always returns 0. Credentials are the CLI's concern
  # (one loader; the watchdog never reads TELEGRAM_*). Deliberately a per-block
  # copy, like rc_write: the test harnesses extract each block by slicing.
  deliver_page() {
    local notify_bin="${HYDRA_WATCHDOG_OPERATOR_NOTIFY:-node --experimental-strip-types ${HYDRA_ROOT:-$HOME/hydra}/scripts/operator-notify.ts}"
    local out err_file
    err_file="$(mktemp 2>/dev/null || printf '/tmp/hydra-operator-notify-%s.err' "$$")"
    # shellcheck disable=SC2086  # word-splitting binary+flags is intended
    out="$(timeout 25 $notify_bin "$@" 2>"$err_file")" \
      && log "operator-notify $1 ok for '${3:-}' (${out:-no output})" \
      || log "WARN operator-notify $1 FAILED (rc=$?) for '${3:-}' (best-effort — detection state is unchanged): $({ grep -m1 -E 'Error|ERR_' "$err_file" || tail -n 1 "$err_file"; } 2>/dev/null | cut -c1-300)"
    rm -f "$err_file" 2>/dev/null || true
    return 0
  }

  local now_ms="${HYDRA_WATCHDOG_BRIEF_NOW_MS:-}"
  if [[ ! "$now_ms" =~ ^[0-9]+$ ]]; then
    now_ms="$(date +%s%3N 2>/dev/null || echo 0)"
  fi
  [[ "$now_ms" =~ ^[0-9]+$ ]] || now_ms=0
  local thr_ms=$(( STALE_HOURS * 3600 * 1000 ))
  local absent_key="${BM_KEY_PREFIX}:absent-since"
  local fired_key="${BM_KEY_PREFIX}:fired"

  # --- Reachability first: neither 0 nor 1 means Redis is unreachable, not
  # that the brief is missing. Leave every state untouched. ---
  local exists
  exists="$(rc_read EXISTS "$LAST_SENT_KEY" | tr -dc '0-9')"
  if [[ "$exists" != "0" && "$exists" != "1" ]]; then
    log "WARN Redis unreachable (EXISTS ${LAST_SENT_KEY} answered '${exists:-nothing}') — cannot evaluate brief freshness this tick; alarm state unchanged (## SERVICE LIVENESS owns Redis-down)"
    return 0
  fi

  # --- Reference instant: the delivered stamp, or the cold-start anchor. ---
  local last_ms="" reference_ms reason
  if [[ "$exists" == "1" ]]; then
    last_ms="$(rc_read GET "$LAST_SENT_KEY" | tr -dc '0-9')"
  fi
  if [[ "$last_ms" =~ ^[0-9]+$ ]] && (( last_ms > 0 )); then
    reference_ms="$last_ms"
    reason="stale"
    # Gate the DEL on EXISTS: a healthy tick must not write when nothing is there.
    if [[ "$(rc_read EXISTS "$absent_key" | tr -dc '0-9')" == "1" ]]; then
      rc_write DEL "$absent_key"
    fi
  else
    rc_write SET "$absent_key" "$now_ms" NX
    local absent_since
    absent_since="$(rc_read GET "$absent_key" | tr -dc '0-9')"
    [[ "$absent_since" =~ ^[0-9]+$ ]] || absent_since="$now_ms"
    reference_ms="$absent_since"
    reason="never-delivered"
  fi
  local age_ms=$(( now_ms - reference_ms ))
  if (( age_ms < 0 )); then age_ms=0; fi
  local age_h=$(( age_ms / 3600000 ))

  # --- Edge-triggered delivery: ONE page per episode, one resolve on recovery. ---
  if (( age_ms >= thr_ms )); then
    log "WARNING MORNING BRIEF MISSING — ${reason}: no brief delivered for ${age_h}h (threshold ${STALE_HOURS}h; reference_ms=${reference_ms}, now_ms=${now_ms}) — issue #5048"
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" != "1" ]]; then
      rc_write SET "$fired_key" "$now_ms"
      deliver_page page --kind "$KIND" --dedup-key "$KIND" \
        --title "No Morning Brief delivered for ${age_h}h" \
        --fact "reason=${reason}" --fact "age_h=${age_h}" --fact "threshold_h=${STALE_HOURS}" --fact "last_sent_key=${LAST_SENT_KEY}"
    else
      log "still missing — already paged this episode (the fired marker holds the dedup)"
    fi
  else
    if [[ "$reason" == "stale" ]]; then
      log "morning brief fresh: last delivered ${age_h}h ago (threshold ${STALE_HOURS}h)"
    else
      log "morning brief never delivered yet: cold-start grace ${age_h}h of ${STALE_HOURS}h used (absent-since anchor ${reference_ms})"
    fi
    if [[ "$(rc_read EXISTS "$fired_key" | tr -dc '0-9')" == "1" ]]; then
      log "morning brief delivered again — clearing the episode (dedup re-armed)"
      deliver_page resolve --dedup-key "$KIND" --title "Morning Brief delivered again"
    fi
    rc_write DEL "$fired_key"
  fi

  log "brief-missing tick processed (threshold=${STALE_HOURS}h, reason=${reason}, now_ms=${now_ms})"
  return 0
}


# =============================================================================
# ## ORIGIN IDENTITY — ported to TypeScript (issue #5098, epic #5094)
# =============================================================================
#
# The origin-identity alarm + auto-repair (#4939 / #5065 / #5026) now lives in
# scripts/hydra-watchdog.ts `origin-identity` over src/watchdog/origin-identity.ts;
# the URL rule has one home, src/github/remote-url.ts. The bound covers the 60s
# fetch + 5s kill + the Operator Channel call. See docs/operations/watchdog.md.
run_origin_identity_cli() { run_watchdog_cli origin-identity "hydra-origin-identity-watchdog:" 120; }

# =============================================================================
# Entry point — run all blocks on every tick ONLY when the script is executed
# directly, not when it is sourced. test/autopilot-watchdog.test.mts sources
# this file to exercise run_watchdog_cli in isolation; the guard keeps that
# sourcing side-effect-free. Each block is independent and self-contained;
# a short-circuit in one MUST NOT skip the others.
# =============================================================================
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_liveness_cli
  run_wedge_cli
  run_disk_cli
  run_deploy_drift_cli
  run_redis_backup_cli
  run_skill_mirror_cli
  run_claude_hooks
  run_launch_flow_cli
  run_node_modules_integrity
  run_brief_missing
  run_origin_identity_cli
  exit 0
fi
