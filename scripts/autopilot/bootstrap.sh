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

# Issue #2479: capture a bounded log tail for crash_detail.log_tail. #1079
# shipped the schema + read path but the writer only ever read the run log
# (/tmp/hydra-autopilot-nightly.log). A session that crashes at STARTUP — the
# observed network/socket failures (FailedToOpenSocket) with turns=0,
# dispatches=0 — writes NOTHING to the run log before dying, so the tail came
# back empty and log_tail was omitted: the run landed as `{exit_code: 1}` and
# the real cause was only recoverable from journald out-of-band. This function
# reads the run log first (the rich source when the session got far enough to
# write it) and, when that yields nothing, FALLS BACK to the unit's journal
# tail — the exact source the retro had to reach for by hand — so a
# startup-crash's API error is durably captured.
#
# Reads/sets REAP_LOG_TAIL. Inputs: REAP_LOG_PATH (run log), REAP_STARTED_EPOCH
# (scope the journal scan to THIS run, mirroring the session-limit scan), and
# the test-injection knob HYDRA_AUTOPILOT_REAP_JOURNAL_TAIL (stand in for the
# journal read the harness can't poke, mirroring HYDRA_AUTOPILOT_REAP_SESSION_LINE).
# Each source is capped to ~8 KB so the payload stays small; the server
# (sanitizeCrashDetail) re-truncates defensively. Best-effort throughout: a
# missing/unreadable log AND an unavailable journal yield an empty tail (the
# caller then simply omits the field — never blocks the reap).
__reap_capture_log_tail() {
  REAP_LOG_TAIL=""
  # 1. Run log straight off disk — last 120 lines, capped to ~8 KB.
  if [ -r "${REAP_LOG_PATH:-}" ]; then
    REAP_LOG_TAIL="$(tail -n 120 "${REAP_LOG_PATH}" 2>/dev/null | tail -c 8192 || echo "")"
  fi
  # 2. Journal fallback (issue #2479) — only when the run log gave us nothing,
  # i.e. the startup-crash case the run log never captured. The injected knob
  # wins (test harness); otherwise read THIS run's unit journal scoped to
  # started_epoch so a stale prior-run tail cannot leak in, falling back to a
  # bounded line window when the start epoch is unknown.
  if [ -z "${REAP_LOG_TAIL}" ]; then
    if [ -n "${HYDRA_AUTOPILOT_REAP_JOURNAL_TAIL+set}" ]; then
      # The knob is DEFINED (even if empty) — it is authoritative and fully
      # stands in for the journal read, so the real journalctl is never invoked
      # under test. An empty value pins the "no journal content available" case.
      REAP_LOG_TAIL="$(printf '%s' "${HYDRA_AUTOPILOT_REAP_JOURNAL_TAIL}" | tail -c 8192)"
    elif command -v journalctl >/dev/null 2>&1; then
      if [ -n "${REAP_STARTED_EPOCH:-}" ] && [ "${REAP_STARTED_EPOCH}" != "0" ]; then
        REAP_LOG_TAIL="$(journalctl --user -u hydra-autopilot.service --since "@${REAP_STARTED_EPOCH}" --no-pager 2>/dev/null \
          | tail -n 120 | tail -c 8192 || echo "")"
      else
        REAP_LOG_TAIL="$(journalctl --user -u hydra-autopilot.service -n 120 --no-pager 2>/dev/null \
          | tail -c 8192 || echo "")"
      fi
    fi
  fi
}

# Issue #1079 + #2479: assemble the structured crash_detail snapshot for an
# abnormal exit. Reads REAP_CAUSE / REAP_EXIT_NUM / REAP_EXIT_CODE_KIND /
# REAP_EXIT_STATUS (set by __reap_derive_cause) and captures the bounded log
# tail via __reap_capture_log_tail (run log → journal fallback). Echoes the
# crash_detail JSON object on stdout, or the literal `null` for a clean exit
# (cause != crash/failure_backstop) that records no detail — keeping the field
# a reliable "died badly" signal. Shared by the live --reap path and the
# --reap-crash-detail dry-run so the test pins exactly the live assembly.
__reap_build_crash_detail() {
  if [ "${REAP_CAUSE}" != "crash" ] && [ "${REAP_CAUSE}" != "failure_backstop" ]; then
    echo "null"
    return 0
  fi
  # Signal name only when systemd reported a signal kill (EXIT_CODE=signal);
  # REAP_EXIT_STATUS then holds the name (e.g. SEGV, KILL, ABRT). A numeric
  # status is an exit *code*, not a signal name, so leave signal empty there —
  # exit_code already carries it.
  __rbcd_signal=""
  if [ "${REAP_EXIT_CODE_KIND:-}" = "signal" ]; then
    case "${REAP_EXIT_STATUS}" in
      ''|*[!0-9]*) __rbcd_signal="${REAP_EXIT_STATUS}" ;;
      *) __rbcd_signal="" ;;
    esac
  fi
  __reap_capture_log_tail
  jq -n \
    --arg signal "${__rbcd_signal}" \
    --argjson exit_code "${REAP_EXIT_NUM}" \
    --arg log_tail "${REAP_LOG_TAIL}" \
    '{exit_code: $exit_code}
      + (if $signal == "" then {} else {signal: $signal} end)
      + (if $log_tail == "" then {} else {log_tail: $log_tail} end)'
}

# Dry-run (issue #2479): echo the assembled crash_detail JSON for the current
# $EXIT_CODE/$EXIT_STATUS plus injected log/journal inputs. No POST — purely the
# crash_detail assembly + log_tail capture+fallback under test. Reads the same
# REAP_LOG_PATH / REAP_STARTED_EPOCH / HYDRA_AUTOPILOT_REAP_JOURNAL_TAIL env the
# live --reap path uses, so a crafted run-log/journal can pin the startup-crash
# fallback. Output: the crash_detail JSON object on stdout (or `null` for a
# clean exit that records none).
if [ "${1:-}" = "--reap-crash-detail" ]; then
  REAP_LOG_PATH="${HYDRA_AUTOPILOT_LOG:-/tmp/hydra-autopilot-nightly.log}"
  REAP_STARTED_EPOCH="${HYDRA_AUTOPILOT_REAP_STARTED_EPOCH:-0}"
  __reap_derive_cause
  __reap_build_crash_detail
  exit 0
fi

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
  # Read this run's start epoch once — both the session-limit scan AND the
  # issue #2479 crash_detail journal fallback scope their journal reads to it
  # so a stale prior-run line cannot leak in.
  REAP_STARTED_EPOCH="$(jq -r '.started_epoch // 0' "${REAP_STATE_PATH}" 2>/dev/null || echo 0)"
  REAP_SESSION_LINE="${HYDRA_AUTOPILOT_REAP_SESSION_LINE:-}"
  if [ "${REAP_CAUSE}" = "crash" ]; then
    if [ -z "${REAP_SESSION_LINE}" ] && command -v journalctl >/dev/null 2>&1; then
      # Scope the scan to THIS run (since started_epoch) so a stale line from a
      # prior run cannot match. Fall back to the bounded tail only when the
      # start epoch is unavailable — still safe because the cause=crash gate
      # already holds. Newest match wins; the server-side regex is the real filter.
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

  # Issue #1079 + #2479: for an abnormal exit (cause=crash / failure_backstop)
  # capture a durable structured crash_detail so the run is drillable AFTER the
  # ephemeral /log (.log.prev-bounded) + journal rotate. __reap_build_crash_detail
  # derives the signal name from EXIT_STATUS on a signal-kill and ships a bounded
  # log tail — run log first, then the unit journal (issue #2479) when the run log
  # is empty (the startup-crash case, where the session died before writing the
  # run log and the real API error lives only in journald). The server (endRun)
  # persists it on the run hash and re-truncates defensively. A clean stop sends
  # no crash_detail, keeping the field a reliable "died badly" signal.
  REAP_CRASH_DETAIL_JSON="$(__reap_build_crash_detail)"

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

# Issue #2715 — Redis-backed reboot-survival for the cross-run cooldown subset.
#
# /tmp is boot-wiped (tmpfiles `D /tmp … 30d`), so the #2575 prior-file
# carry-forward survives pace-gate relaunches but NOT a host reboot: after a
# reboot the prior state.json is gone and the long-cooldown classes reseed to
# epoch 0, firing many times in the first post-boot run (a per-reboot recurrence
# of the #2575 token churn). Redis survives reboot (AOF + docker volume), so the
# durable fix mirrors the cross-run subset to Redis on write and reads it back as
# a seed tier BEHIND the prior file (prior-file → Redis → 0).
#
# `redis_cooldown_cli` is the single bash→Redis seam. It follows the EXACT
# docker-exec redis-cli pattern collect-state.sh already uses for every autopilot
# cross-run Redis read/write — no new typed accessor, no HTTP route (bootstrap
# runs in Phase 0 before the HTTP service is guaranteed up, so a curl seed would
# be less robust; design-concept #2715 Invariant 6 + rejectedAlternatives).
#
# `HYDRA_AUTOPILOT_REDIS_CLI` overrides the command (tests inject a stub so the
# seed logic is exercised hermetically without a live Redis). Every call is
# best-effort / fail-open: any error (redis down, docker absent, timeout) yields
# empty stdout and the caller falls back to the pre-#2715 behaviour — NEVER
# aborts bootstrap (design-concept #2715 Invariant 5).
REDIS_SIGNAL_LAST_FIRED_KEY="hydra:autopilot:signal-last-fired"
REDIS_RESEARCH_FORCE_KEY="hydra:autopilot:research-force-counter"
redis_cooldown_cli() {
  # $@ = redis-cli argv (e.g. HGET <key> <field>). Emits stdout on success,
  # nothing on any failure. Quotes are stripped by the caller as needed.
  if [ -n "${HYDRA_AUTOPILOT_REDIS_CLI:-}" ]; then
    # Test/override seam: a whitespace-split command prefix. Word-split is
    # intentional here (the override is a trusted test fixture, not user input).
    # shellcheck disable=SC2086
    ${HYDRA_AUTOPILOT_REDIS_CLI} "$@" 2>/dev/null || true
  else
    docker exec hydra-redis-1 redis-cli "$@" 2>/dev/null || true
  fi
}

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
# into 6 pipeline slots + signal_last_fired (5 always-on + 4 long-cooldown
# classes seeded from prior state per #2575). A v1 state.json (no
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

# Issue #2715 — Redis fallback tier for research_force_counter.
#
# Fallback order is prior-file → Redis → {}. When the prior file was absent or
# carried no counter for today (RESEARCH_FORCE_SEED is still the empty `{}`), try
# the Redis mirror-write left by decide.py / reap.py — this is the reboot-survival
# path (/tmp was wiped, so the prior file is gone, but Redis persists). The stored
# value is the canonical-JSON research_force_counter (a date-keyed object); we
# prune it to TODAY's UTC key exactly as the prior-file read does so a stale
# yesterday counter can never leak forward. First install (Redis empty too) keeps
# the `{}` default — first-install behaviour unchanged (design-concept #2715).
if [ "${ISOLATED_RUN}" != "1" ] || [ -n "${HYDRA_AUTOPILOT_REDIS_CLI:-}" ]; then
  if [ "${RESEARCH_FORCE_SEED}" = "{}" ] && command -v jq >/dev/null 2>&1; then
    RFC_REDIS_RAW="$(redis_cooldown_cli GET "${REDIS_RESEARCH_FORCE_KEY}")"
    if [ -n "${RFC_REDIS_RAW}" ]; then
      SEED_TODAY_UTC="${SEED_TODAY_UTC:-$(date -u +%Y-%m-%d)}"
      RFC_REDIS_SEED="$(printf '%s' "${RFC_REDIS_RAW}" | jq -c --arg today "${SEED_TODAY_UTC}" '
        . as $c
        | if ($c | type) == "object" and (($c[$today] // null) | type) == "object"
          then { ($today): $c[$today] }
          else {}
          end
      ' 2>/dev/null || echo "{}")"
      case "${RFC_REDIS_SEED}" in
        "{"*) RESEARCH_FORCE_SEED="${RFC_REDIS_SEED}" ;;
        *) ;;  # keep {} on any parse failure
      esac
    fi
  fi
fi

# Issue #2575 — carry the cooled-class last-fired timestamps across runs.
#
# Same hazard as RESEARCH_FORCE_SEED above: the state-file heredoc clobbers
# `signal_last_fired` on EVERY bootstrap, and the pace-gate relaunches the
# autopilot roughly every 15 minutes. The original heredoc seeded only the 5
# always-on signal classes (health / sweep_* / discover_*) at 0 and OMITTED the
# long-cooldown classes `retro_orch` / `architecture_orch` / `cleanup_orch` /
# `scout_orch`. decide.py's `signal_is_cooled()` defaults a missing key to
# epoch 0 — permanently "cooled" — so the 24h retro cooldown never held across a
# relaunch and retro fired 5–8×/day instead of the designed 1×/day (~8–10× token
# overrun, all zero-emit clean runs).
#
# Seed = the prior state file's timestamp for each class (carried forward so the
# cooldown survives the relaunch), defaulting to 0 only when there is no prior
# value (first-ever run). Missing prior file, missing jq, unparseable JSON, or a
# non-object shape all degrade to all-0 — fail-open (at worst one extra fire),
# and a seed failure must never block bootstrap. Read happens BEFORE the heredoc
# clobbers the file, mirroring RESEARCH_FORCE_SEED.
COOLDOWN_SIGNAL_SEED='{"retro_orch":0,"architecture_orch":0,"cleanup_orch":0,"scout_orch":0}'
if [ -f "${STATE_PATH}" ] && command -v jq >/dev/null 2>&1; then
  COOLDOWN_SIGNAL_SEED="$(jq -c '
    (.signal_last_fired // {}) as $s
    | {
        retro_orch:        (($s.retro_orch        // 0) | if type == "number" then . else 0 end),
        architecture_orch: (($s.architecture_orch // 0) | if type == "number" then . else 0 end),
        cleanup_orch:      (($s.cleanup_orch      // 0) | if type == "number" then . else 0 end),
        scout_orch:        (($s.scout_orch        // 0) | if type == "number" then . else 0 end)
      }
  ' "${STATE_PATH}" 2>/dev/null || echo '{"retro_orch":0,"architecture_orch":0,"cleanup_orch":0,"scout_orch":0}')"
  # Belt-and-braces: anything that does not look like a JSON object would
  # corrupt the heredoc below into invalid JSON — degrade to all-0.
  case "${COOLDOWN_SIGNAL_SEED}" in
    "{"*) ;;
    *) COOLDOWN_SIGNAL_SEED='{"retro_orch":0,"architecture_orch":0,"cleanup_orch":0,"scout_orch":0}' ;;
  esac
fi

# Issue #2715 — Redis fallback tier for the 4 long-cooldown signal classes.
#
# Fallback order is prior-file → Redis → 0, applied PER CLASS. For each of the 4
# long-cooldown classes whose prior-file value came back as 0 (absent prior file
# after a reboot, or a genuinely never-stamped class), read the class's field
# from the Redis hash mirror. This is the reboot-survival path: /tmp was wiped so
# the prior file is gone, but Redis persists the last-fired stamp reap.py wrote,
# so the 24h/1h cooldowns hold across the reboot instead of resetting to epoch 0
# and firing many times in the first post-boot run. First install (no prior file
# AND no Redis key) keeps 0 — first-install behaviour unchanged. Best-effort: any
# Redis error yields empty stdout, the class keeps its prior-file value (0), and
# bootstrap never blocks (design-concept #2715 Invariants 2 + 5).
if { [ "${ISOLATED_RUN}" != "1" ] || [ -n "${HYDRA_AUTOPILOT_REDIS_CLI:-}" ]; } \
  && command -v jq >/dev/null 2>&1; then
  for _cd_cls in retro_orch architecture_orch cleanup_orch scout_orch; do
    # Only reach for Redis when the prior-file tier gave us 0 for this class.
    _cd_prior="$(printf '%s' "${COOLDOWN_SIGNAL_SEED}" | jq -r --arg c "${_cd_cls}" '(.[$c] // 0)' 2>/dev/null || echo 0)"
    case "${_cd_prior}" in
      0|"") ;;               # prior-file value missing/zero → try Redis
      *) continue ;;          # prior-file already has a real timestamp → keep it
    esac
    _cd_redis="$(redis_cooldown_cli HGET "${REDIS_SIGNAL_LAST_FIRED_KEY}" "${_cd_cls}" | tr -d '"')"
    # Accept only a positive integer epoch; anything else (empty / non-numeric)
    # leaves the class at its prior-file 0.
    case "${_cd_redis}" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "${_cd_redis}" -gt 0 ] 2>/dev/null; then
      _cd_merged="$(printf '%s' "${COOLDOWN_SIGNAL_SEED}" \
        | jq -c --arg c "${_cd_cls}" --argjson v "${_cd_redis}" '.[$c] = $v' 2>/dev/null || echo "")"
      case "${_cd_merged}" in
        "{"*) COOLDOWN_SIGNAL_SEED="${_cd_merged}" ;;
        *) ;;  # keep the prior seed on any jq failure
      esac
    fi
  done
  unset _cd_cls _cd_prior _cd_redis _cd_merged
fi

# Compose the full 9-key signal_last_fired object: the 5 always-on classes seeded
# at 0 (re-armed each run by design) plus the 4 long-cooldown classes carried
# forward from the prior state (COOLDOWN_SIGNAL_SEED). Prefer jq for the merge;
# fall back to a manual splice if jq is unavailable so bootstrap never blocks.
SIGNAL_LAST_FIRED_JSON='{"health":0,"sweep_orch":0,"sweep_target":0,"discover_orch":0,"discover_target":0,"retro_orch":0,"architecture_orch":0,"cleanup_orch":0,"scout_orch":0}'
if command -v jq >/dev/null 2>&1; then
  SIGNAL_LAST_FIRED_MERGED="$(jq -cn --argjson cooled "${COOLDOWN_SIGNAL_SEED}" '
    {health:0, sweep_orch:0, sweep_target:0, discover_orch:0, discover_target:0} + $cooled
  ' 2>/dev/null || echo "")"
  case "${SIGNAL_LAST_FIRED_MERGED}" in
    "{"*) SIGNAL_LAST_FIRED_JSON="${SIGNAL_LAST_FIRED_MERGED}" ;;
    *) ;;  # keep the all-0 fallback above
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
#   - The signal-driven classes no longer occupy slots; they track only
#     their last-fired timestamp under `signal_last_fired`, replacing the
#     legacy `/tmp/hydra-last-*.txt` files. ALL NINE KEYS MUST BE PRESENT
#     for the same reason: the 5 always-on classes
#     (health / sweep_* / discover_*) seeded at `0` (re-armed each run),
#     plus the 4 long-cooldown classes
#     (retro_orch / architecture_orch / cleanup_orch / scout_orch) which
#     are SEEDED FROM THE PRIOR STATE FILE (issue #2575 —
#     COOLDOWN_SIGNAL_SEED above) so their 24h cooldown survives the
#     pace-gate's ~15-min relaunch cadence. Before #2575 these 4 were
#     omitted entirely, so decide.py's `signal_is_cooled()` read a missing
#     key as epoch 0 (permanently cooled) and retro_orch fired 5–8×/day
#     instead of the designed 1×/day.
#   - `failure_log` is a new ring buffer of structured failure records
#     consumed by `self_heal.py` (issue #426 self-heal table).
#   - `reaped_task_ids` (issue #411) and `burned_classes` (issue #395)
#     are preserved unchanged.
#   - `research_force_counter` (issue #1666) is seeded from the prior state
#     file (see RESEARCH_FORCE_SEED above) — the 4/day forced-research cap
#     must survive the pace-gate's multi-run-per-day relaunch cadence.
#     Additive + tolerated-missing by all readers, so no schema_version bump.
#     The 4 long-cooldown `signal_last_fired` classes are seeded from prior
#     state the same way (issue #2575 — COOLDOWN_SIGNAL_SEED above).
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
  "signal_last_fired": ${SIGNAL_LAST_FIRED_JSON}
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
