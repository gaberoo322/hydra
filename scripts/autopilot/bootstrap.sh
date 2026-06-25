#!/usr/bin/env bash
#
# bootstrap.sh — Phase 0 of /hydra-autopilot.
#
# Heartbeat, run-log rotation, env parsing, and authoritative state.json
# initialization. The budget limits resolved here become first-class
# members of /tmp/hydra-autopilot-state.json so subsequent termination
# checks read from the state file (not from shell env, which doesn't
# persist between Claude turns).
#
# Inputs (env, all optional):
#   HYDRA_AUTOPILOT_TOKEN_BUDGET                (default 10000000)
#   HYDRA_AUTOPILOT_MAX_SEC                     (default 28800  — 8h)
#   HYDRA_AUTOPILOT_IDLE_TURNS                  (default 5)
#   HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS         (default 400000 — soft cap)
#   HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS    (default 800000 — hard cap)
#   HYDRA_AUTOPILOT_SCOPE                       (default all | orch-only | target-only)
#   HYDRA_AUTOPILOT_UNATTENDED                  (default auto — `true` if stdin is
#                                                NOT a TTY, `false` otherwise; an
#                                                explicit value of true|false wins
#                                                over the TTY auto-detect — issue #413)
#
# Inputs (slash args, all optional; processed by args-parse.sh; args > env):
#   --scope=<v>          --tokens=<N>          --token-budget=<N>
#   --max-sec=<N>        --max-seconds=<N>     --idle-turns=<N>
#   --subagent-soft=<N>  --subagent-hard=<N>   --unattended=<true|false>
#
# Unknown args are warned-and-ignored (e.g. trailing `focus=...` tokens).
#
# Side effects (default paths; override via env vars below):
#   /tmp/hydra-autopilot-heartbeat.txt       (overwritten)
#   /tmp/hydra-autopilot-nightly.log         (truncated; old → .prev)
#   /tmp/hydra-autopilot-state.json          (initialized)
#
# Test-isolation env vars (added to fix the run-start spam / state-clobber
# bug seen on 2026-05-25 and re-observed on 2026-05-26 — the autopilot
# test suite invoked bootstrap.sh with no isolation and stomped the live
# autopilot's /tmp state files AND POSTed fake runs to the live
# /api/autopilot/run-start, which made the dashboard report autopilot as
# "not running"):
#   HYDRA_AUTOPILOT_STATE       state.json path (default /tmp/...)
#   HYDRA_AUTOPILOT_HEARTBEAT   heartbeat.txt path (default /tmp/...)
#   HYDRA_AUTOPILOT_LOG         run-log path (default /tmp/...)
#
# When ANY of the three paths is non-default, bootstrap also skips the
# run-start POST to ${HYDRA_API_BASE}/api/autopilot/run-start — the
# semantic is "you are isolated from prod, so don't touch prod surfaces
# either." Production deployment sets none of these vars and gets the
# historical behavior unchanged.
#
# Behavior-preserving extraction of the Phase 0 heredoc (issue #409),
# with slash-arg parsing layered on top (issue #410).

set -euo pipefail

# ---------------------------------------------------------------------------
# Reap-on-exit backstop (issue #898)
# ---------------------------------------------------------------------------
#
# `bootstrap.sh --reap` is the guaranteed terminal-status writer. It is
# wired as the systemd unit's `ExecStopPost=` so it fires when the
# long-running `claude -p /hydra-autopilot` process exits for ANY reason
# that did not already route through a term-check stop decision:
# print-mode session end, context/output exhaustion, SIGTERM from
# `systemctl restart` / `RuntimeMaxSec`, a host event, or a genuine crash.
#
# Without this backstop the run hash is left at `status: running`, and the
# read-time sweeper later promotes it to `killed / term_reason: crash` — so
# "crash" became the catch-all for "the process is gone and nobody POSTed
# run-end", making it useless as a health signal (issue #898).
#
# The reap reads the run_id + pid from the SAME state.json bootstrap wrote,
# then POSTs run-end with a best-guess cause (issue #898 / AC2):
#   - clean process exit (EXIT_CODE=exited, status unset / 0)
#       → cause=interrupted, exit_code=0  → endRun records status=ended
#   - signal-kill SIGTERM/SIGINT (EXIT_CODE=signal, status TERM/INT/15/2)
#       → cause=interrupted, exit_code=0  → `systemctl restart` /
#         RuntimeMaxSec / Ctrl-C is an interrupt, NOT a crash
#   - any other abnormal exit (non-zero status, SEGV/KILL/etc, missing code)
#       → cause=crash, exit_code=<n>      → endRun records the crash honestly
#
# Idempotent: endRun dedups on a terminal status, so if term-check.py
# already POSTed run-end this turn the reap POST is a harmless no-op (the
# first end's term_reason wins). Isolated runs (non-default state path) are
# skipped — they never POSTed run-start, so there is nothing to reap. The
# reap NEVER aborts the unit stop: every failure path logs and exits 0.
#
# systemd hands ExecStopPost the service result via $SERVICE_RESULT,
# $EXIT_CODE ("exited"/"signal"/...), and $EXIT_STATUS (the numeric code or
# signal). We read those when present and degrade gracefully when run by
# hand (none set → assume a clean interrupt).
#
# `__reap_derive_cause` is the single source of truth for the
# EXIT_CODE/EXIT_STATUS → (cause, exit_code) mapping (issue #898 / AC2). It
# reads $EXIT_CODE / $EXIT_STATUS and sets the globals REAP_CAUSE +
# REAP_EXIT_NUM. Both the live `--reap` path and the `--reap-derive-cause`
# dry-run (used by the script-level test to pin the mapping without POSTing
# to a prod surface) call it, so the two can never drift.
__reap_derive_cause() {
  REAP_EXIT_STATUS="${EXIT_STATUS:-0}"
  REAP_EXIT_CODE_KIND="${EXIT_CODE:-exited}"
  # Issue #1903: count of pipeline slots still occupied at exit, derived from
  # state.json by the live --reap path (default 0 when unknown / unset). A CLEAN
  # exit with slots_occupied > 0 is an honest baton-pass (`handoff`), not the
  # crash-adjacent `interrupted`. Injectable for the --reap-derive-cause dry-run.
  REAP_SLOTS_OCCUPIED="${REAP_SLOTS_OCCUPIED:-0}"
  if [ "${REAP_EXIT_CODE_KIND}" = "exited" ] \
    && { [ -z "${REAP_EXIT_STATUS}" ] || [ "${REAP_EXIT_STATUS}" = "0" ] \
      || [ "${REAP_EXIT_STATUS}" = "143" ] || [ "${REAP_EXIT_STATUS}" = "130" ]; }; then
    # A clean exit (status 0 / unset) OR a self-propagated 128+signal exit
    # *code* of 143 (128+SIGTERM) / 130 (128+SIGINT) is an `interrupted` end,
    # NOT a crash (issue #925). The latter happens when the `claude` CLI's own
    # child (a dispatched subagent / tool) dies on SIGTERM/SIGINT and the
    # parent propagates 143/130 as its OWN exit STATUS — systemd reports
    # EXIT_CODE=exited (not signal), so without this branch a clean self-exit
    # fell through to the catch-all `crash`. This mirrors the EXIT_CODE=signal
    # TERM/INT mapping below; both record exit_code 0 so `crash` stays a
    # meaningful health signal and the StartLimit lockout never arms.
    #
    # Issue #1903: a clean exit with subagent slots STILL occupied is a
    # `handoff` baton-pass (the print-mode session ended its turn while
    # subagents are mid-flight; the surviving dispatch ledger is re-seeded by
    # the next pace-gate-launched run, #1352). This is the residual case
    # #1352 left: slots > 0, plan was wait, but print mode physically exits on
    # the final message. Reserve `interrupted` for a clean ZERO-slot bypass of
    # term-check (a genuine print-mode end with nothing pending). `handoff` is
    # in CLEAN_TERM_REASONS and retro-drillable; `interrupted` is not.
    if [ "${REAP_SLOTS_OCCUPIED}" -gt 0 ] 2>/dev/null; then
      REAP_CAUSE="handoff"
    else
      REAP_CAUSE="interrupted"
    fi
    REAP_EXIT_NUM=0
  elif [ "${REAP_EXIT_CODE_KIND}" = "signal" ]; then
    case "${REAP_EXIT_STATUS}" in
      TERM|SIGTERM|15|INT|SIGINT|2)
        # Operator/scheduler interrupt (SIGTERM/SIGINT) — deterministically
        # an `interrupted` end, not a crash.
        REAP_CAUSE="interrupted"
        REAP_EXIT_NUM=0
        ;;
      *)
        # Any other signal (SEGV, KILL, ABRT, …) is a genuine crash.
        REAP_CAUSE="crash"
        case "${REAP_EXIT_STATUS}" in
          ''|*[!0-9]*) REAP_EXIT_NUM=1 ;;  # signal name → non-zero sentinel
          *)           REAP_EXIT_NUM="${REAP_EXIT_STATUS}" ;;
        esac
        ;;
    esac
  else
    REAP_CAUSE="crash"
    case "${REAP_EXIT_STATUS}" in
      ''|*[!0-9]*) REAP_EXIT_NUM=1 ;;  # signal name or junk → non-zero sentinel
      *)           REAP_EXIT_NUM="${REAP_EXIT_STATUS}" ;;
    esac
  fi
}

# Issue #2030: count "work in flight at exit" for the handoff/interrupted
# baton-pass decision, reading from a state.json path. Two sources are summed:
#
#   1. Pipeline slots (`state.json.slots`) — the 7 long-lived dev/qa/research/
#      design slots #1903 already counted (a slot is occupied when its value is
#      non-null), seeded across relaunches by #1352.
#   2. Background/signal classes fired DURING this run — every
#      `state.json.signal_last_fired[<class>]` whose timestamp is
#      `>= started_epoch`. These are the `sweep_orch` / `retro_orch` /
#      `discover_*` / `scout_orch` / `architecture_orch` / `cleanup_*` classes
#      that never enter `slots` (they hold only a last-fired timestamp, not a
#      slot), so #1903's slots-only count missed them: a clean exit whose ONLY
#      in-flight dispatches were background classes reaped with
#      slots_occupied == 0 and was mis-stamped `interrupted` — re-pinning the
#      exact failure mode #1903/#1815/#1352 retired, for this run class.
#
# A class fired this run means the dispatcher stamped its `signal_last_fired`
# entry on the turn it dispatched (the dispatcher owns the stamp; see
# reap.py "stamped by the dispatcher, not here"). The print-mode session then
# physically exits on its final message with that background subagent still
# mid-flight — an honest baton-pass the successor run continues, not a
# nothing-pending bypass.
#
# Echoes the integer count on stdout. A missing/garbage state file, slots
# object, or signal map degrades each source to 0 (the pre-fix `interrupted`
# behaviour) — never blocks the reap. INV-A is preserved by the caller:
# __reap_derive_cause only consults this count on a CLEAN exit code, so an
# abnormal exit still derives `crash` regardless of in-flight work.
__reap_count_slots_occupied() {
  __rcso_state_path="${1:-}"
  if [ -z "${__rcso_state_path}" ] || [ ! -f "${__rcso_state_path}" ] \
    || ! command -v jq >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  # jq computes both sources in one pass so the started_epoch comparison and
  # the slot null-filter share a single read. `.started_epoch // 0` degrades a
  # missing epoch to 0, which makes EVERY non-zero signal timestamp count as
  # "fired this run" — the conservative direction (prefer handoff over a false
  # interrupted) and harmless because a real run always has a started_epoch.
  __rcso_count="$(jq -r '
    ((.started_epoch // 0) | tonumber? // 0) as $start
    | ([ (.slots // {}) | .[] | select(. != null) ] | length)
      + ([ (.signal_last_fired // {})
           | to_entries[]
           | (.value | tonumber? // 0)
           | select(. >= $start and . > 0) ] | length)
  ' "${__rcso_state_path}" 2>/dev/null || echo 0)"
  case "${__rcso_count}" in
    ''|*[!0-9]*) echo 0 ;;
    *) echo "${__rcso_count}" ;;
  esac
}

# Issue #1130: decide whether the just-exited run may arm a session-limit
# block. ONLY a genuine session-limit exit qualifies: the Claude CLI prints
# `You've hit your session limit · resets <t>` and exits code=1, which
# __reap_derive_cause maps to `crash`. A clean exit (cause=interrupted) NEVER
# arms a block — so a stale `hit your session limit` line left in the journal
# by a PRIOR run can no longer re-arm a phantom block on a clean exit. Reads
# REAP_CAUSE + REAP_SESSION_LINE; sets REAP_SESSION_SHOULD_POST=yes|no.
__reap_session_should_post() {
  if [ "${REAP_CAUSE}" = "crash" ] && [ -n "${REAP_SESSION_LINE}" ]; then
    REAP_SESSION_SHOULD_POST="yes"
  else
    REAP_SESSION_SHOULD_POST="no"
  fi
}

# Dry-run: echo the derived (cause, exit_code) for the current
# $EXIT_CODE/$EXIT_STATUS and exit. No state read, no POST — purely the
# mapping under test. Output shape: `cause=<c> exit_code=<n>`.
if [ "${1:-}" = "--reap-derive-cause" ]; then
  __reap_derive_cause
  echo "cause=${REAP_CAUSE} exit_code=${REAP_EXIT_NUM}"
  exit 0
fi

# Dry-run (issue #1130): echo the session-block arming decision for the current
# $EXIT_CODE/$EXIT_STATUS + injected $HYDRA_AUTOPILOT_REAP_SESSION_LINE. No
# journal scan, no POST — purely the cause-gate under test. Output shape:
# `cause=<c> post=<yes|no>`.
# Dry-run (issue #2030): echo the slots-occupied count `__reap_count_slots_occupied`
# derives from a given state.json path (pipeline slots + background classes
# fired this run). No POST, no journal scan — purely the count under test, so a
# crafted state file can pin the background-only handoff case. Output shape: a
# bare integer on stdout.
if [ "${1:-}" = "--reap-count-slots" ]; then
  __reap_count_slots_occupied "${2:-}"
  exit 0
fi

if [ "${1:-}" = "--reap-session-decision" ]; then
  __reap_derive_cause
  REAP_SESSION_LINE="${HYDRA_AUTOPILOT_REAP_SESSION_LINE:-}"
  __reap_session_should_post
  echo "cause=${REAP_CAUSE} post=${REAP_SESSION_SHOULD_POST}"
  exit 0
fi

if [ "${1:-}" = "--reap" ]; then
  REAP_STATE_PATH="${HYDRA_AUTOPILOT_STATE:-/tmp/hydra-autopilot-state.json}"
  REAP_DEFAULT_STATE_PATH="/tmp/hydra-autopilot-state.json"
  REAP_HEARTBEAT_PATH="${HYDRA_AUTOPILOT_HEARTBEAT:-/tmp/hydra-autopilot-heartbeat.txt}"
  REAP_LOG_PATH="${HYDRA_AUTOPILOT_LOG:-/tmp/hydra-autopilot-nightly.log}"
  REAP_API_BASE="${HYDRA_API_BASE:-http://localhost:4000}"

  # Isolation parity with the run-start skip below: a non-default state /
  # heartbeat / log path means this is a test/isolated run that never POSTed
  # run-start, so there is no prod run to reap.
  if [ "${REAP_STATE_PATH}" != "${REAP_DEFAULT_STATE_PATH}" ] \
    || [ "${REAP_HEARTBEAT_PATH}" != "/tmp/hydra-autopilot-heartbeat.txt" ] \
    || [ "${REAP_LOG_PATH}" != "/tmp/hydra-autopilot-nightly.log" ]; then
    echo "[autopilot] reap: isolated run (non-default state path) — nothing to reap"
    exit 0
  fi

  if [ ! -f "${REAP_STATE_PATH}" ] || ! command -v jq >/dev/null 2>&1; then
    echo "[autopilot] reap: no state file or jq unavailable — skipping"
    exit 0
  fi

  REAP_RUN_ID="$(jq -r '.run_id // ""' "${REAP_STATE_PATH}" 2>/dev/null || echo "")"
  if [ -z "${REAP_RUN_ID}" ]; then
    echo "[autopilot] reap: no run_id in state — skipping"
    exit 0
  fi

  # Best-guess cause from the systemd-provided result (issue #898 / AC2,
  # extended by issue #925). Three distinct kinds of non-crash exit must all
  # map to `interrupted`, so `crash` stays a meaningful health signal:
  #   1. Clean process exit  — EXIT_CODE=exited, status 0 or unset.
  #   2. Self-propagated SIGTERM/SIGINT exit *code* — EXIT_CODE=exited,
  #      status 143 (128+SIGTERM) or 130 (128+SIGINT). The `claude` CLI
  #      returns these as its OWN exit status when a child it spawned (a
  #      dispatched subagent / tool) dies on SIGTERM/SIGINT — systemd then
  #      reports EXIT_CODE=exited (NOT signal). Before #925 this fell through
  #      to `crash`, mislabeling clean self-exits and (via SuccessExitStatus
  #      missing 143) arming Restart=on-failure → StartLimit lockout.
  #   3. Signal-kill         — EXIT_CODE=signal, status in {TERM,INT,15,2}.
  #      This is `systemctl restart` / `RuntimeMaxSec` (SIGTERM) or a
  #      Ctrl-C (SIGINT) — an operator/scheduler interrupt, NOT a crash.
  #      The unit is Type=exec with SuccessExitStatus=SIGTERM, so systemd
  #      exports EXIT_CODE=signal / EXIT_STATUS=TERM on a clean stop;
  #      without this arm every restart was mis-recorded as a crash.
  # Anything else — any other non-zero exit status, a non-TERM/INT signal
  # (e.g. SEGV/KILL/ABRT), or a missing/garbage code — stays `crash`
  # with the real exit status preserved. Shared with the --reap-derive-cause
  # dry-run so the test pins exactly this mapping.
  #
  # Issue #1903 + #2030: derive slots_occupied from state.json so a CLEAN exit
  # with work still in flight maps to `handoff` (honest baton-pass), not the
  # crash-adjacent `interrupted`. The count spans BOTH the fixed pipeline-slot
  # map decide.py reasons over (#1903) AND background/signal classes
  # (`sweep_orch` / `retro_orch` / …) fired during this run (#2030) — the latter
  # never enter `slots`, so #1903's slots-only count mis-stamped a
  # background-only run `interrupted`. See `__reap_count_slots_occupied` for the
  # full derivation; a missing/garbage state degrades to 0 (the pre-fix
  # `interrupted` behaviour) — never blocks the reap.
  REAP_SLOTS_OCCUPIED="$(__reap_count_slots_occupied "${REAP_STATE_PATH}")"
  case "${REAP_SLOTS_OCCUPIED}" in ''|*[!0-9]*) REAP_SLOTS_OCCUPIED=0 ;; esac
  export REAP_SLOTS_OCCUPIED
  __reap_derive_cause
  REAP_ENDED_EPOCH="$(date -u +%s)"

  # Issue #1089: session-limit hard-block detection. When the Claude Code
  # rolling SESSION window is exhausted the CLI prints (to the journal)
  #   You've hit your session limit · resets 4:40pm (America/Los_Angeles)
  # and exits code=1 — which __reap_derive_cause maps to `crash`. If the
  # pace-gate then relaunches the service it dies instantly again, repeatedly,
  # until the quota resets, abandoning all in-flight dispatches. To break that
  # storm we POST the exit line to /api/usage/session-block, which parses the
  # reset and records a self-expiring block so the pace-gate skips relaunch
  # until the reset passes. Best-effort: any failure here is logged and never
  # aborts the unit stop (the reap NEVER throws). The server treats a
  # non-session-limit line as a no-op (recorded:false), so scanning a normal
  # crash's journal is harmless.
  #
  # Issue #1130: TWO guards stop a PHANTOM block from a stale line:
  #   1. Cause gate — only a `crash` (the code=1 session-limit exit signature)
  #      may arm a block. A clean exit (cause=interrupted: code 0/143/130) skips
  #      detection entirely, so an hours-old `hit your session limit` line from
  #      a PRIOR run can no longer re-arm a block when this run exits cleanly.
  #   2. Run-scoped scan — the journal grep is bounded to THIS run (since the
  #      state file's started_epoch) instead of a 200-line window that spans
  #      prior runs, so even a crash only matches its OWN session-limit line.
  # Before this, a clean code=0 exit re-grepped a stale line and parked the
  # autopilot for hours with the usage meter empty.
  #
  # Testability: HYDRA_AUTOPILOT_REAP_SESSION_LINE injects the candidate line
  # directly (the test harness can't poke the journal); when unset and the run
  # crashed we read THIS run's journal for the just-exited run. The cause-gate
  # decision is pinned by the `--reap-session-decision` dry-run above.
  REAP_SESSION_LINE="${HYDRA_AUTOPILOT_REAP_SESSION_LINE:-}"
  if [ "${REAP_CAUSE}" = "crash" ]; then
    if [ -z "${REAP_SESSION_LINE}" ] && command -v journalctl >/dev/null 2>&1; then
      # Scope the scan to THIS run (since started_epoch) so a stale line from a
      # prior run cannot match. Fall back to the bounded tail only when the
      # start epoch is unavailable — still safe because the cause=crash gate
      # already holds. Newest match wins; the server-side regex is the real filter.
      REAP_STARTED_EPOCH="$(jq -r '.started_epoch // 0' "${REAP_STATE_PATH}" 2>/dev/null || echo 0)"
      if [ -n "${REAP_STARTED_EPOCH}" ] && [ "${REAP_STARTED_EPOCH}" != "0" ]; then
        REAP_SESSION_LINE="$(journalctl --user -u hydra-autopilot.service --since "@${REAP_STARTED_EPOCH}" --no-pager 2>/dev/null \
          | grep -i 'hit your session limit' | tail -n 1 || echo "")"
      else
        REAP_SESSION_LINE="$(journalctl --user -u hydra-autopilot.service -n 200 --no-pager 2>/dev/null \
          | grep -i 'hit your session limit' | tail -n 1 || echo "")"
      fi
    fi
  else
    # Clean / interrupted exit — never arm a session block (issue #1130).
    REAP_SESSION_LINE=""
  fi
  __reap_session_should_post
  if [ "${REAP_SESSION_SHOULD_POST}" = "yes" ]; then
    REAP_SESSION_PAYLOAD="$(jq -n --arg line "${REAP_SESSION_LINE}" '{line: $line}')"
    if curl -sf --max-time 5 -X POST \
        -H "content-type: application/json" \
        -d "${REAP_SESSION_PAYLOAD}" \
        "${REAP_API_BASE}/api/usage/session-block" >/dev/null 2>&1; then
      echo "[autopilot] reap: posted session-limit block from exit line"
    else
      echo "[autopilot] reap: session-block POST failed (orchestrator down?) — pace-gate may relaunch into the quota"
    fi
  elif [ "${REAP_CAUSE}" != "crash" ]; then
    echo "[autopilot] reap: clean exit (cause=${REAP_CAUSE}) — no session-limit block (issue #1130)"
  fi

  # Issue #1079: for an abnormal exit (cause=crash / failure_backstop) capture
  # a durable structured crash_detail so the run is drillable AFTER the
  # ephemeral /log (.log.prev-bounded) + journal rotate. We can derive the
  # signal name from EXIT_STATUS on a signal-kill and ship a bounded tail of
  # the run log read straight off disk here — the server (endRun) persists it
  # on the run hash and re-truncates defensively. A clean stop sends no
  # crash_detail, keeping the field a reliable "died badly" signal.
  REAP_CRASH_DETAIL_JSON="null"
  if [ "${REAP_CAUSE}" = "crash" ] || [ "${REAP_CAUSE}" = "failure_backstop" ]; then
    # Signal name only when systemd reported a signal kill (EXIT_CODE=signal);
    # REAP_EXIT_STATUS (set by __reap_derive_cause) then holds the name (e.g.
    # SEGV, KILL, ABRT). A numeric status is an exit *code*, not a signal name,
    # so leave signal empty there — exit_code already carries it.
    REAP_SIGNAL=""
    if [ "${REAP_EXIT_CODE_KIND:-}" = "signal" ]; then
      case "${REAP_EXIT_STATUS}" in
        ''|*[!0-9]*) REAP_SIGNAL="${REAP_EXIT_STATUS}" ;;
        *) REAP_SIGNAL="" ;;
      esac
    fi
    # Bounded log tail straight off disk — last 120 lines of the run log,
    # capped to ~8 KB so the payload stays small. Best-effort: a missing /
    # unreadable log yields an empty tail (the server simply omits the field).
    REAP_LOG_TAIL=""
    if [ -r "${REAP_LOG_PATH}" ]; then
      REAP_LOG_TAIL="$(tail -n 120 "${REAP_LOG_PATH}" 2>/dev/null | tail -c 8192 || echo "")"
    fi
    REAP_CRASH_DETAIL_JSON="$(jq -n \
      --arg signal "${REAP_SIGNAL}" \
      --argjson exit_code "${REAP_EXIT_NUM}" \
      --arg log_tail "${REAP_LOG_TAIL}" \
      '{exit_code: $exit_code}
        + (if $signal == "" then {} else {signal: $signal} end)
        + (if $log_tail == "" then {} else {log_tail: $log_tail} end)')"
  fi

  REAP_PAYLOAD="$(jq -n \
    --arg run_id "${REAP_RUN_ID}" \
    --arg cause "${REAP_CAUSE}" \
    --argjson ended_epoch "${REAP_ENDED_EPOCH}" \
    --argjson exit_code "${REAP_EXIT_NUM}" \
    --argjson crash_detail "${REAP_CRASH_DETAIL_JSON}" \
    '{run_id: $run_id, cause: $cause, ended_epoch: $ended_epoch, exit_code: $exit_code}
      + (if $crash_detail == null then {} else {crash_detail: $crash_detail} end)')"

  # endRun is idempotent: if term-check.py already POSTed run-end this turn,
  # the row is already terminal and this POST is a no-op (deduped=true). A
  # failed POST is logged but never aborts the unit stop.
  if curl -sf --max-time 5 -X POST \
      -H "content-type: application/json" \
      -d "${REAP_PAYLOAD}" \
      "${REAP_API_BASE}/api/autopilot/run-end" >/dev/null 2>&1; then
    echo "[autopilot] reap: recorded run-end run_id=${REAP_RUN_ID} cause=${REAP_CAUSE} exit_code=${REAP_EXIT_NUM} (idempotent)"
  else
    echo "[autopilot] reap: run-end POST failed (orchestrator down?) run_id=${REAP_RUN_ID} cause=${REAP_CAUSE} — sweeper will backstop"
  fi
  exit 0
fi

# Slash-arg parsing — must run BEFORE env reads below so explicit args
# override implicit env (issue #410). Sourced (not exec'd) so the
# exports land in this shell.
# shellcheck source=./args-parse.sh
. "$(dirname "$0")/args-parse.sh" "$@"

# Resolve file paths from env (test-isolation knobs). Mirrors the
# convention already established in heartbeat.py / term-check.py /
# reap.py — the only outlier was bootstrap.sh.
DEFAULT_STATE_PATH="/tmp/hydra-autopilot-state.json"
DEFAULT_HEARTBEAT_PATH="/tmp/hydra-autopilot-heartbeat.txt"
DEFAULT_LOG_PATH="/tmp/hydra-autopilot-nightly.log"
STATE_PATH="${HYDRA_AUTOPILOT_STATE:-$DEFAULT_STATE_PATH}"
HEARTBEAT_PATH="${HYDRA_AUTOPILOT_HEARTBEAT:-$DEFAULT_HEARTBEAT_PATH}"
LOG_PATH="${HYDRA_AUTOPILOT_LOG:-$DEFAULT_LOG_PATH}"
if [ "${STATE_PATH}" != "${DEFAULT_STATE_PATH}" ] \
  || [ "${HEARTBEAT_PATH}" != "${DEFAULT_HEARTBEAT_PATH}" ] \
  || [ "${LOG_PATH}" != "${DEFAULT_LOG_PATH}" ]; then
  ISOLATED_RUN=1
else
  ISOLATED_RUN=0
fi

# Heartbeat — Phase 0 marker.
#
# This is the FIRST write; subsequent decision turns must call
# scripts/autopilot/heartbeat.py to refresh the file (issue #435). The
# pid + run_id stamped here are propagated into state.json below so the
# per-turn updater can re-emit them on every line without re-querying
# the kernel for a pid that may have already exec'd into a child.
RUN_ID="$(uuidgen)"

# Resolve the OWNING pid for this autopilot run — NOT $$ (bootstrap.sh's
# own bash pid), which dies within seconds of Phase 0 completing and
# would make `sweepRunIfDead()` in src/autopilot/runs.ts immediately
# promote every run to `status: killed, term_reason: crash`. That
# caused the 2026-05-27 dashboard ghost-outage where /now showed
# "Active dispatches: 0" even though the autopilot was looping
# healthily — the recorded pid was always a dead bootstrap pid.
#
# The owning pid is the long-running `claude` CLI ancestor that hosts
# the autopilot session. Walk up the process tree looking for it.
# Fall back to $$ when no `claude` ancestor exists (manual invocations
# / tests / standalone runs) so the script still works in those
# contexts — `sweepRunIfDead()` will treat the bootstrap pid as dead
# almost immediately, but isolated runs already skip the run-start POST
# (see ISOLATED_RUN block below) so the sweeper never sees them.
resolve_autopilot_pid() {
  local candidate ppid comm
  candidate="$$"
  # Walk up at most 8 levels to avoid pathological loops on weird
  # process trees. 8 is generous — typical chain is bash → zsh → claude.
  for _ in 1 2 3 4 5 6 7 8; do
    ppid="$(ps -o ppid= -p "${candidate}" 2>/dev/null | tr -d ' ')"
    if [ -z "${ppid}" ] || [ "${ppid}" = "0" ] || [ "${ppid}" = "1" ]; then
      break
    fi
    comm="$(ps -o comm= -p "${ppid}" 2>/dev/null | tr -d ' ')"
    if [ "${comm}" = "claude" ]; then
      printf '%s' "${ppid}"
      return 0
    fi
    candidate="${ppid}"
  done
  printf '%s' "$$"
}
PID="$(resolve_autopilot_pid)"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) start pid=${PID} run_id=${RUN_ID}" > "${HEARTBEAT_PATH}"

# Concurrent-run guard. If an existing state.json's owner PID is still alive,
# refuse to overwrite — that is a real collision and the second instance
# should bow out. If the owner PID is dead, log the recovery and proceed
# (the chronic case from 2026-05-16: morning run died from a transient API
# 5xx, its state.json was left stamped with the dead PID, and the auto-retry
# misread that as a live duplicate). Best-effort: a missing jq is treated
# as "no prior state" rather than aborting bootstrap.
if [ -f "${STATE_PATH}" ] && command -v jq >/dev/null 2>&1; then
  PRIOR_PID=$(jq -r '.pid // 0' "${STATE_PATH}" 2>/dev/null || echo 0)
  if [ "${PRIOR_PID}" -gt 0 ] && [ "${PRIOR_PID}" != "${PID}" ]; then
    if kill -0 "${PRIOR_PID}" 2>/dev/null; then
      echo "[autopilot] FATAL: prior autopilot pid=${PRIOR_PID} is alive; refusing to overwrite ${STATE_PATH}"
      echo "[autopilot]   to force, kill ${PRIOR_PID} or remove ${STATE_PATH}"
      exit 1
    fi
    echo "[autopilot] recovering from stale state (prior pid=${PRIOR_PID} is dead)"
  fi
fi

# Run log (overwrites previous run; previous-run content rotated to .prev)
[ -f "${LOG_PATH}" ] && mv "${LOG_PATH}" "${LOG_PATH}.prev"
: > "${LOG_PATH}"

# Resolve budget knobs from env (per-run override) with hardcoded defaults
TOKEN_BUDGET="${HYDRA_AUTOPILOT_TOKEN_BUDGET:-10000000}"
WALL_CLOCK_MAX_SEC="${HYDRA_AUTOPILOT_MAX_SEC:-28800}"   # 8h
IDLE_DRAIN_TURNS="${HYDRA_AUTOPILOT_IDLE_TURNS:-5}"

# Per-subagent token caps (issue #395). Soft cap = stop re-dispatching that
# class; hard cap = abandon the in-flight slot and open a runaway issue.
# Soft must be <= hard. Defaults bound a single misbehaving subagent to
# ~8% of the 10M total budget at the hard cap; well-behaved subagents
# (~30-150k tokens for a normal hydra-dev run) are unaffected.
SUBAGENT_MAX_TOKENS="${HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS:-400000}"
SUBAGENT_HARD_MAX_TOKENS="${HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS:-800000}"
if [ "$SUBAGENT_MAX_TOKENS" -gt "$SUBAGENT_HARD_MAX_TOKENS" ]; then
  echo "[autopilot] FATAL: HYDRA_AUTOPILOT_SUBAGENT_MAX_TOKENS=$SUBAGENT_MAX_TOKENS exceeds HYDRA_AUTOPILOT_SUBAGENT_HARD_MAX_TOKENS=$SUBAGENT_HARD_MAX_TOKENS"
  exit 1
fi

# Tool-scout cost-cap knobs (issue #532). Both are first-class members of
# `state.limits` so the same Phase 0 schema-handshake covers them. Defaults:
#   daily_spend_cap_usd = 50.0  — operator-facing daily Claude Code budget
#                                  (matches the dashboard's $50/day cap).
#   scout_cost_share    = 0.04  — documented 4% slice; mirrors
#                                  src/scout/calendar-walk.ts:SCOUT_DAILY_COST_SHARE.
#                                  Setting to 0 is an intentional kill-switch.
# Operators override either via env (per-run) or — for the share — by
# editing state.json mid-run.
DAILY_SPEND_CAP_USD="${HYDRA_AUTOPILOT_DAILY_SPEND_CAP_USD:-50.0}"
SCOUT_COST_SHARE="${HYDRA_AUTOPILOT_SCOUT_COST_SHARE:-0.04}"

# Resolve scope from env. Allowed: all | orch-only | target-only. Default: all.
SCOPE="${HYDRA_AUTOPILOT_SCOPE:-all}"
case "$SCOPE" in
  all|orch-only|target-only) ;;
  *) echo "[autopilot] FATAL: HYDRA_AUTOPILOT_SCOPE=$SCOPE invalid (expected all|orch-only|target-only)"; exit 1 ;;
esac

# Resolve unattended mode (issue #413). Detection precedence chain:
#   1. Explicit HYDRA_AUTOPILOT_UNATTENDED=true|false  (always wins)
#   2. TTY auto-detect — `[ -t 0 ]` (interactive stdin) → false; non-TTY → true
# In unattended mode, the playbook must NOT invoke `AskUserQuestion`; it
# uses `scripts/autopilot/queue-decision.sh` to append a row to today's
# rolling `Operator decision queue YYYY-MM-DD` issue instead. The morning
# `/hydra-review` skill drains the queue.
if [ -n "${HYDRA_AUTOPILOT_UNATTENDED:-}" ]; then
  case "$HYDRA_AUTOPILOT_UNATTENDED" in
    true|TRUE|True|1|yes)   UNATTENDED="true" ;;
    false|FALSE|False|0|no) UNATTENDED="false" ;;
    *) echo "[autopilot] FATAL: HYDRA_AUTOPILOT_UNATTENDED=$HYDRA_AUTOPILOT_UNATTENDED invalid (expected true|false)"; exit 1 ;;
  esac
else
  if [ -t 0 ]; then
    UNATTENDED="false"
  else
    UNATTENDED="true"
  fi
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date -u +%s)"

# Schema version handshake (issue #434).
#
# Bumped every time the on-disk shape of state.json or the playbook's
# expectations of it change in an incompatible way. The playbook's
# `HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA: <N>` marker MUST match the value
# written here; Phase 0 of the playbook fails loud on mismatch and
# instructs the operator to run `scripts/sync-skills.sh`.
#
# Bump procedure (operator-only):
#   1. Bump this constant in bootstrap.sh.
#   2. Bump the `HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA:` marker in
#      docs/operator-playbooks/hydra-autopilot.md.
#   3. Update test/autopilot-schema-version.test.mts to reflect the
#      new current version.
#   4. Run `./scripts/sync-skills.sh` so ~/.claude/skills/hydra-autopilot/
#      mirrors the new playbook.
#
# Why v2 today: the post-#426 schema collapsed the legacy 10 flat slots
# into 6 pipeline slots + 5 signal_last_fired. A v1 state.json (no
# schema_version field, ten-slot shape) is detected at Phase 0 as a
# legacy run; bootstrap re-runs and writes v2 on the next tick.
SCHEMA_VERSION=2

# Issue #1666 — carry the forced-research daily cap across runs.
#
# The heredoc below OVERWRITES state.json on every bootstrap, and the
# pace-gate relaunches the autopilot roughly every 15 minutes — so any
# counter that lives only in the state file resets per-RUN unless
# bootstrap reseeds it. Without this seed the documented 4/day
# forced-research cap (decide.py RESEARCH_FORCE_DAILY_CAP, grilled
# decision 6) silently degraded to 4/run (QA finding on PR #1678;
# design-concept artifact for #1666, Invariant 4).
#
# Seed = the prior state file's research_force_counter pruned to TODAY's
# UTC key, matching decide.py's prune-on-write semantics. Missing prior
# file, missing jq, unparseable JSON, or a non-object shape all degrade
# to {} — the breaker fails open (at worst one extra day of forced
# dispatches), and a seed failure must never block bootstrap. The read
# happens BEFORE the heredoc clobbers the file; the prior-PID guard
# above established this read-prior-state path.
RESEARCH_FORCE_SEED="{}"
if [ -f "${STATE_PATH}" ] && command -v jq >/dev/null 2>&1; then
  SEED_TODAY_UTC="$(date -u +%Y-%m-%d)"
  RESEARCH_FORCE_SEED="$(jq -c --arg today "${SEED_TODAY_UTC}" '
    (.research_force_counter // {}) as $c
    | if ($c | type) == "object" and (($c[$today] // null) | type) == "object"
      then { ($today): $c[$today] }
      else {}
      end
  ' "${STATE_PATH}" 2>/dev/null || echo "{}")"
  # Belt-and-braces: anything that does not look like a JSON object would
  # corrupt the heredoc below into invalid JSON — degrade to {}.
  case "${RESEARCH_FORCE_SEED}" in
    "{"*) ;;
    *) RESEARCH_FORCE_SEED="{}" ;;
  esac
fi

# Issue #1352 — seed in-flight pipeline slots across the pace-gate relaunch.
#
# The heredoc below clobbers state.json with all-null slots on EVERY bootstrap.
# But a pace-gate relaunch starts a fresh session while the PRIOR session's
# subagents may still be running (their SubagentStop hook has not fired yet).
# With all-null slots the new session's first `decide.py decide` sees
# `occupied == 0`, trips `_rule_idle_fallback`, and emits terminate(cause=idle)
# — the print-mode session exits and the reap stamps `interrupted`. That is the
# root of the 100%-interrupted / 0-drillable-dispatch starvation (#1352).
#
# The orchestrator owns the durable in-flight ledger (`hydra:dispatches:subagent:*`,
# which survives the relaunch). GET /api/autopilot/inflight-slots projects it
# onto the fixed pipeline-slot occupancy and returns `{ slots: { dev_orch: {…} } }`
# for any class whose subagent is still live. We merge that seed onto the 7-null
# base so `occupied > 0` and the new session emits `wait` (busy-wait nap) until
# the SubagentStop event frees the slot or the orphaned-slot age cap drains it.
#
# Best-effort and fail-open: orchestrator-down, a missing jq, a curl timeout, or
# an unparseable body all degrade to the all-null base (the pre-#1352 behaviour),
# so this can never block a bootstrap. Isolated runs (tests) skip the fetch.
SLOTS_BASE='{"dev_orch":null,"qa_orch":null,"research_orch":null,"dev_target":null,"qa_target":null,"research_target":null,"design_concept_orch":null}'
SLOTS_JSON="${SLOTS_BASE}"
if [ "${ISOLATED_RUN}" != "1" ] && command -v jq >/dev/null 2>&1; then
  SLOTS_API_BASE="${HYDRA_API_BASE:-http://localhost:4000}"
  SLOTS_SEED_RAW="$(curl -sf --max-time 5 "${SLOTS_API_BASE}/api/autopilot/inflight-slots" 2>/dev/null || echo "")"
  if [ -n "${SLOTS_SEED_RAW}" ]; then
    # Merge: 7-null base, overlaid with any seeded (non-null) slot objects. A
    # malformed payload (.slots not an object) collapses the overlay to {} so the
    # result is exactly the all-null base — never invalid JSON in the heredoc.
    SLOTS_MERGED="$(printf '%s' "${SLOTS_SEED_RAW}" | jq -c --argjson base "${SLOTS_BASE}" '
      ($base) + (if ((.slots // {}) | type) == "object" then .slots else {} end)
    ' 2>/dev/null || echo "")"
    case "${SLOTS_MERGED}" in
      "{"*) SLOTS_JSON="${SLOTS_MERGED}" ;;
      *) SLOTS_JSON="${SLOTS_BASE}" ;;
    esac
  fi
fi

# Initialize state file — limits are now first-class members.
#
# Schema migration (issue #426 decision brain rewrite + issue #466 Phase B):
#   - `slots` now contains the 7 fixed pipeline slots:
#     dev_orch / qa_orch / research_orch + their _target peers + the
#     design_concept_orch slot added in #466. ALL SEVEN KEYS MUST BE
#     PRESENT (as `null`) — issue #431. The first successful γ run
#     (2026-05-15) observed `slots: {}` because an earlier bootstrap
#     variant emitted an empty dict; downstream defensive
#     `slots.get(cls)` reads in decide.py and assert_invariants.py
#     masked the bug, but INV-002's `slots.items()` iteration over an
#     empty dict silently allowed any dispatch. Pin the 7-key schema
#     here; tests in test/autopilot-scripts.test.mts and
#     test/autopilot-invariants.test.mts enforce both shapes.
#   - The previous signal-driven classes (health / sweep_* / discover_*)
#     no longer occupy slots; they track only their last-fired timestamp
#     under `signal_last_fired`, replacing the legacy
#     `/tmp/hydra-last-*.txt` files. ALL FIVE KEYS MUST BE PRESENT
#     (as `0`) for the same reason.
#   - `failure_log` is a new ring buffer of structured failure records
#     consumed by `self_heal.py` (issue #426 self-heal table).
#   - `reaped_task_ids` (issue #411) and `burned_classes` (issue #395)
#     are preserved unchanged.
#   - `research_force_counter` (issue #1666) is the ONLY field seeded
#     from the prior state file (see RESEARCH_FORCE_SEED above) — the
#     4/day forced-research cap must survive the pace-gate's
#     multi-run-per-day relaunch cadence. Additive + tolerated-missing
#     by all readers, so no schema_version bump.
#   - `schema_version` (issue #434) participates in the Phase 0 handshake.
#   - `cumulative_tokens` seeds at 0 and is advanced ONLY by reap.py on each
#     subagent completion (the per-turn token surrogate). This is the field the
#     LIVE `TERM:budget` gate reads in term-check.py + decide.py — NOT dead code
#     (issue #2429). The same value is mirrored onto the Redis run hash by
#     heartbeat.py for the dashboard; the run-hash copy is 0 only for a run that
#     exits before the surrogate accumulates (a 1-2-turn print-mode run).
#
# Backward compat: this heredoc OVERWRITES the existing file. A v1
# legacy state.json (or a v2 state.json with `slots: {}` empty) is
# clobbered on each bootstrap, so no migration path is needed —
# bootstrap is always run before the brain reads state.
cat > "${STATE_PATH}" <<EOF
{
  "started": "${STARTED_AT}",
  "started_epoch": ${STARTED_EPOCH},
  "pid": ${PID},
  "run_id": "${RUN_ID}",
  "limits": {
    "token_budget": ${TOKEN_BUDGET},
    "wall_clock_max_sec": ${WALL_CLOCK_MAX_SEC},
    "idle_drain_turns": ${IDLE_DRAIN_TURNS},
    "scope": "${SCOPE}",
    "subagent_max_tokens": ${SUBAGENT_MAX_TOKENS},
    "subagent_hard_max_tokens": ${SUBAGENT_HARD_MAX_TOKENS},
    "unattended": ${UNATTENDED},
    "schema_version": ${SCHEMA_VERSION},
    "daily_spend_cap_usd": ${DAILY_SPEND_CAP_USD},
    "scout_cost_share": ${SCOUT_COST_SHARE}
  },
  "cumulative_tokens": 0,
  "dispatches": 0,
  "idle_turns": 0,
  "turn": 0,
  "burned_classes": [],
  "reaped_task_ids": [],
  "failure_log": [],
  "research_force_counter": ${RESEARCH_FORCE_SEED},
  "slots": ${SLOTS_JSON},
  "signal_last_fired": {
    "health": 0,
    "sweep_orch": 0,
    "sweep_target": 0,
    "discover_orch": 0,
    "discover_target": 0
  }
}
EOF

# Echo resolved limits so the model captures them in conversation context
echo "[autopilot] limits resolved: token_budget=${TOKEN_BUDGET} wall_clock_max_sec=${WALL_CLOCK_MAX_SEC} idle_drain_turns=${IDLE_DRAIN_TURNS} scope=${SCOPE} subagent_soft=${SUBAGENT_MAX_TOKENS} subagent_hard=${SUBAGENT_HARD_MAX_TOKENS} unattended=${UNATTENDED} schema_version=${SCHEMA_VERSION} daily_spend_cap_usd=${DAILY_SPEND_CAP_USD} scout_cost_share=${SCOUT_COST_SHARE}"
echo "[autopilot] state schema_version=${SCHEMA_VERSION} (playbook must match HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA marker; see Phase 0 handshake)"

# Issue #435 — overwrite the Phase 0 heartbeat with the structured
# per-turn format immediately so the file format is consistent from turn
# 0 onwards. Best-effort: a heartbeat-write failure must NOT abort
# bootstrap (we already wrote the legacy `start ...` line above which is
# enough for operators to see something).
python3 "$(dirname "$0")/heartbeat.py" --last-action=bootstrap || \
  echo "[autopilot] heartbeat.py initial write failed; continuing"

# Issue #497 — register this run with the orchestrator's autopilot-runs
# dashboard surface. Posts run-start with the limits payload + trigger from
# hour-of-day heuristic (UTC). Best-effort: orchestrator-down must not block
# bootstrap, so a curl failure is logged but ignored. The endpoint is
# idempotent on run_id, so a transient failure followed by a manual retry is
# safe.
#
# Trigger heuristic (UTC):
#   09:00–11:59 → morning-timer
#   21:00–23:59 → overnight-timer
#   else         → manual
#
# Isolated runs (non-default STATE/HEARTBEAT/LOG path) skip this POST
# entirely. The test suite frequently invokes bootstrap.sh and was
# spamming the live /api/autopilot/run-start endpoint with fake runs,
# which made the dashboard's "current run" widget report autopilot as
# down (root cause of the 2026-05-26 dashboard ghost-outage).
if [ "${ISOLATED_RUN}" = "1" ]; then
  echo "[autopilot] isolated run (non-default state/heartbeat/log path) — skipping run-start POST"
else
  HOUR_UTC=$(date -u +%H)
  HOUR_NUM=$((10#${HOUR_UTC}))
  if [ "${HOUR_NUM}" -ge 9 ] && [ "${HOUR_NUM}" -lt 12 ]; then
    TRIGGER="morning-timer"
  elif [ "${HOUR_NUM}" -ge 21 ] && [ "${HOUR_NUM}" -le 23 ]; then
    TRIGGER="overnight-timer"
  else
    TRIGGER="manual"
  fi

  HYDRA_API_BASE="${HYDRA_API_BASE:-http://localhost:4000}"
  RUN_START_PAYLOAD=$(cat <<JSON
{
  "run_id": "${RUN_ID}",
  "started": "${STARTED_AT}",
  "started_epoch": ${STARTED_EPOCH},
  "pid": ${PID},
  "trigger": "${TRIGGER}",
  "limits": {
    "token_budget": ${TOKEN_BUDGET},
    "wall_clock_max_sec": ${WALL_CLOCK_MAX_SEC},
    "idle_drain_turns": ${IDLE_DRAIN_TURNS},
    "scope": "${SCOPE}",
    "subagent_max_tokens": ${SUBAGENT_MAX_TOKENS},
    "subagent_hard_max_tokens": ${SUBAGENT_HARD_MAX_TOKENS},
    "unattended": ${UNATTENDED},
    "schema_version": ${SCHEMA_VERSION}
  }
}
JSON
)
  curl -sf --max-time 5 -X POST \
    -H "content-type: application/json" \
    -d "${RUN_START_PAYLOAD}" \
    "${HYDRA_API_BASE}/api/autopilot/run-start" >/dev/null 2>&1 || \
    echo "[autopilot] run-start POST failed (orchestrator down?); continuing run_id=${RUN_ID} trigger=${TRIGGER}"
fi
