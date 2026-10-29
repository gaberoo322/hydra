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
#   HYDRA_AUTOPILOT_CONTEXT_COMPACTION_TURNS    (default 8 — issue #3787,
#                                                periodic session-restart
#                                                cadence in Autopilot Turns)
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
# that did not already route through a decide.py terminate decision:
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
# Idempotent: endRun dedups on a terminal status, so if decide.py
# already POSTed run-end this run the reap POST is a harmless no-op (the
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
    # decide.py's terminate (a genuine print-mode end with nothing pending). `handoff` is
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
# Issue #4305: this predicate used to be a standalone jq filter here, hand-
# mirrored against a Python `count_slots_occupied` twin (a
# docstring literally saying "mirrors bootstrap.sh:..." stood in for a shared
# implementation). It now shells out to `run_termination.py` — the ONE
# implementation both callers use — the same way this script already shells
# out to `heartbeat.py` (see the `python3 "$(dirname "$0")/heartbeat.py"` call
# below). Echoes the integer count on stdout. A missing/garbage state file,
# unavailable python3, or malformed state degrades to 0 (the pre-fix
# `interrupted` behaviour) — never blocks the reap. INV-A is preserved by the
# caller: __reap_derive_cause only consults this count on a CLEAN exit code,
# so an abnormal exit still derives `crash` regardless of in-flight work.
__reap_count_slots_occupied() {
  __rcso_state_path="${1:-}"
  if [ -z "${__rcso_state_path}" ] || [ ! -f "${__rcso_state_path}" ] \
    || ! command -v python3 >/dev/null 2>&1; then
    echo 0
    return 0
  fi
  __rcso_count="$(python3 "$(dirname "$0")/run_termination.py" count-slots "${__rcso_state_path}" 2>/dev/null || echo 0)"
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

# __reap_read_launch_model — best-effort HGET of the `model` field on
# hydra:autopilot:pace-gate:last-tick (QA re-review hard-blocker fix #2 on PR
# #4644, issue #4585): the JUST-EXITED run's own launch model, as recorded by
# pace-gate.sh's record_tick() on its "eligible-exec"/"launch" tick. POSTed
# alongside the exhaustion line so the server can tell "the fallback model
# (the one the redirect flag sent this run to) died again" (a genuine repeat)
# apart from "an independent, still-primary-model dispatch died while the
# redirect flag happens to already be live" (the false-positive the QA
# re-review found: a burst of concurrently-dying still-Fable dispatches was
# arming a session block and halting Opus launches too, violating INV-3).
# Same best-effort / fail-open stance as every other reap Redis read: any
# failure (Redis down, docker absent, no `model` field written yet by a
# pre-#4585 tick) reads as "" — the POST simply omits `model` and the server
# falls back to its safe default (never treats an unlabelled report as a
# confirmed repeat), never blocking the reap itself.
#
# HYDRA_AUTOPILOT_REDIS_CLI is the SAME test-injection seam run_ledger.py's RedisMirror
# (below) uses — a whitespace-split command prefix a test can point at a stub
# script instead of the real `docker exec hydra-redis-1 redis-cli`.
__reap_read_launch_model() {
  if [ -n "${HYDRA_AUTOPILOT_REDIS_CLI:-}" ]; then
    # shellcheck disable=SC2086
    ${HYDRA_AUTOPILOT_REDIS_CLI} HGET "hydra:autopilot:pace-gate:last-tick" model 2>/dev/null || echo ""
  else
    docker exec hydra-redis-1 redis-cli HGET "hydra:autopilot:pace-gate:last-tick" model 2>/dev/null || echo ""
  fi
}

# __reap_format_session_echo RESPONSE_JSON — QA re-review hard-blocker fix #2
# on PR #4644 (issue #4585): render the observable journal line for a
# POST /api/usage/session-block response.
#
# The PRIOR echo branched on `kind === "out-of-credits"` alone — but that kind
# is IDENTICAL for the fresh-arm redirect (`blockedUntil: null`,
# `modelExhaustedUntil: set`) and the repeat session-block arm
# (`blockedUntil: set`, `modelExhaustedUntil: null`), so a repeat printed the
# "no session block" redirect line with an EMPTY timestamp instead of the real
# block line — a false "no session block" on the very case that armed one.
# `blockedUntil` is the field that actually distinguishes "a launch block is
# live" from "a redirect flag is live"; branch on IT, never on `kind`.
#
# QA fix (PR #4644, 2026-09-24T09:49Z): the redirect line used to hardcode the
# literal `fable->opus` text, ignoring an operator override of the launch-model
# pair (`src/api/usage.ts`'s event payload had the same defect — fixed
# alongside this). Resolve the SAME two env vars pace-gate.sh reads its
# PRIMARY_MODEL/FALLBACK_MODEL from, so an override stays in sync everywhere
# the pair is surfaced in observability text.
__reap_format_session_echo() {
  __rfse_response="${1:-}"
  __rfse_primary_model="${HYDRA_AUTOPILOT_PRIMARY_MODEL:-fable}"
  __rfse_fallback_model="${HYDRA_AUTOPILOT_FALLBACK_MODEL:-opus}"
  __rfse_kind="$(printf '%s' "${__rfse_response}" | jq -r '.kind // "session-limit"' 2>/dev/null || echo "session-limit")"
  __rfse_blocked_until="$(printf '%s' "${__rfse_response}" | jq -r '.blockedUntil // ""' 2>/dev/null || echo "")"
  if [ -n "${__rfse_blocked_until}" ]; then
    echo "[autopilot] reap: posted ${__rfse_kind} block until ${__rfse_blocked_until}"
    return 0
  fi
  __rfse_model_until="$(printf '%s' "${__rfse_response}" | jq -r '.modelExhaustedUntil // ""' 2>/dev/null || echo "")"
  if [ -n "${__rfse_model_until}" ]; then
    echo "[autopilot] reap: model-fallback ${__rfse_primary_model}->${__rfse_fallback_model} reason=out-of-credits until ${__rfse_model_until} (no session block, issue #4585)"
    return 0
  fi
  # Neither field populated (recorded:false, or the #4644 no-op branch for an
  # unconfirmed still-primary-model report) — nothing was armed.
  echo "[autopilot] reap: session-block POST recorded no exhaustion state (kind=${__rfse_kind})"
}

# Issue #4583 (INV-1/INV-2): the ONE combined pattern the reap's journal scan
# greps for — both known exit-notice phrasings, so a single `grep -iE ... |
# tail -n 1` picks the NEWEST matching line regardless of which notice it is.
# Never grep the two patterns separately with a fixed precedence: a storm reap
# can scan a window spanning hours (a stale started_epoch), so a fixed
# session-limit-first order could pick a stale session-limit line whose
# already-passed reset resolves to TOMORROW via resolveWallClockInZone — a
# phantom ~24h block. The newest line is the one that actually killed THIS
# process. Shared by both live journal-scan branches below.
REAP_EXHAUSTION_GREP_PATTERN='hit your session limit|out of usage credits'

# Issue #4583 (INV-4): message-agnostic crash-streak backstop. However many
# exhaustion phrasings the reap recognises, there will always be a NEXT one it
# doesn't — this is the generic defence: N `crash` exits within a sliding
# window, with no recognised exhaustion line, still arms a self-clearing
# block. Every cause=crash reap emits a fixed marker line
# (`[autopilot] reap: crash-exit run_id=<id>`) to the unit journal — THIS
# function counts those markers in the PRIOR window (never including the
# marker this same reap is about to emit; the caller always scans BEFORE
# emitting it) and arms when `prior + 1 >= N` (the +1 accounts for the crash
# this reap itself represents).
#
# INV-5: gated on cause=crash exactly like the exhaustion-line path — a clean
# exit never arms this either (a clean exit cannot even reach this function
# with REAP_CAUSE=crash, but the guard stays explicit for the dry-run/direct
# callers). INV-6: an exact classification beats a heuristic — if the
# exhaustion-line path already decided to post (REAP_SESSION_SHOULD_POST=yes),
# this function refuses so a single reap never posts two blocks.
#
# Testability: HYDRA_AUTOPILOT_REAP_RECENT_CRASHES injects the prior-window
# count directly (mirrors HYDRA_AUTOPILOT_REAP_SESSION_LINE — the test harness
# can't poke the journal). Reads REAP_CAUSE + REAP_SESSION_SHOULD_POST (must
# already be set by the caller); sets REAP_CRASH_STREAK_SHOULD_POST=yes|no and
# REAP_CRASH_STREAK_RECENT (the resolved prior-window count, for the log line).
__reap_crash_streak_should_post() {
  REAP_CRASH_STREAK_WINDOW_MIN="${HYDRA_AUTOPILOT_CRASH_STREAK_WINDOW_MIN:-30}"
  REAP_CRASH_STREAK_N="${HYDRA_AUTOPILOT_CRASH_STREAK_N:-3}"
  if [ "${REAP_CAUSE}" != "crash" ] || [ "${REAP_SESSION_SHOULD_POST:-no}" = "yes" ]; then
    REAP_CRASH_STREAK_SHOULD_POST="no"
    REAP_CRASH_STREAK_RECENT=0
    return 0
  fi
  if [ -n "${HYDRA_AUTOPILOT_REAP_RECENT_CRASHES+set}" ]; then
    REAP_CRASH_STREAK_RECENT="${HYDRA_AUTOPILOT_REAP_RECENT_CRASHES}"
  elif command -v journalctl >/dev/null 2>&1; then
    # Epoch-based --since, mirroring this file's other journal scans
    # (@started_epoch above) rather than journalctl's relative-time parser —
    # deterministic and consistent with the rest of the reap.
    REAP_CRASH_STREAK_SINCE_EPOCH=$(( $(date -u +%s) - REAP_CRASH_STREAK_WINDOW_MIN * 60 ))
    REAP_CRASH_STREAK_RECENT="$(journalctl --user -u hydra-autopilot.service \
      --since "@${REAP_CRASH_STREAK_SINCE_EPOCH}" --no-pager 2>/dev/null \
      | grep -c '\[autopilot\] reap: crash-exit ' || echo 0)"
  else
    REAP_CRASH_STREAK_RECENT=0
  fi
  case "${REAP_CRASH_STREAK_RECENT}" in ''|*[!0-9]*) REAP_CRASH_STREAK_RECENT=0 ;; esac
  if [ $((REAP_CRASH_STREAK_RECENT + 1)) -ge "${REAP_CRASH_STREAK_N}" ]; then
    REAP_CRASH_STREAK_SHOULD_POST="yes"
  else
    REAP_CRASH_STREAK_SHOULD_POST="no"
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

# Issue #2954: bounded client-side retry for the run-end POST. A run that
# merges PRs triggers the deploy, the deploy restarts
# hydra-orchestrator.service, and the reap's run-end POST fires within
# seconds of the session exiting — frequently inside the ~10s restart
# window. A single POST then failed, the dead-pid sweeper backstop could
# only stamp status=killed / term_reason=crash, and a clean handoff exit
# was mislabeled as a crash on the behavior gallery (run 3e2ac66d,
# 2026-07-06).
#
# Policy: attempts = backoffs + 1 (default schedule '4 8 16' → 4 attempts),
# each curl bounded by --max-time 5, sleeping between attempts. Worst case
# 4x5 + 28 = 48s — inside the issue's ~30-60s band and far below the
# unit's TimeoutStopSec=600 that governs ExecStopPost, so the reap can
# never hang the stop path. The schedule is injectable via
# HYDRA_AUTOPILOT_REAP_POST_BACKOFFS (space-separated seconds; the attempt
# count derives from it, so a single knob can never produce an
# inconsistent attempts/backoff combo — tests use '0 0 0').
#
# Retrying is idempotent-safe (endRun dedups on a terminal status and the
# API returns 2xx for deduped, so re-POSTing a succeeded-but-timed-out
# attempt is a no-op); any 2xx stops the loop. On final exhaustion the
# EXACT pre-existing "sweeper will backstop" line is emitted, keeping the
# dead-pid sweeper backstop contract unchanged. Reads REAP_PAYLOAD,
# REAP_API_BASE, REAP_RUN_ID, REAP_CAUSE, REAP_EXIT_NUM. Returns 0 on
# success, 1 on exhaustion — the caller never aborts the unit stop either
# way. Shared by the live --reap path and the --reap-post-run-end dry-run
# so the test pins exactly the live assembly.
#
# Issue #4305: the retry-with-backoff loop used to be reimplemented here in
# bash (curl) AND separately in a Python twin (urllib) — two independent
# copies of the same "try, backoff, retry, give up" shape, with different
# retry counts and no shared code. It now shells out to
# `run_termination.py post-run-end`, the ONE implementation of that loop
# (the Python callers import the same module's `post_run_end` directly). This
# function's OWN contract — exact log-line text, exit 0 on success / 1 on
# exhaustion, the default "4 8 16" schedule, HYDRA_AUTOPILOT_REAP_POST_BACKOFFS
# override — is unchanged and still pinned by
# test/autopilot-dedup-reap.test.mts.
__reap_post_run_end() {
  if ! command -v python3 >/dev/null 2>&1; then
    # No python3 — degrade to the pre-existing exhaustion line so the dead-pid
    # sweeper backstop contract still holds; never abort the unit stop.
    echo "[autopilot] reap: run-end POST failed (orchestrator down?) run_id=${REAP_RUN_ID} cause=${REAP_CAUSE} — sweeper will backstop"
    return 1
  fi
  python3 "$(dirname "$0")/run_termination.py" post-run-end \
    --api-base "${REAP_API_BASE}" \
    --run-id "${REAP_RUN_ID}" \
    --cause "${REAP_CAUSE}" \
    --exit-code "${REAP_EXIT_NUM}" \
    --payload "${REAP_PAYLOAD}" \
    --backoffs "${HYDRA_AUTOPILOT_REAP_POST_BACKOFFS:-4 8 16}"
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

# Dry-run (issue #4583 INV-4): echo the crash-streak arming decision for the
# current $EXIT_CODE/$EXIT_STATUS + injected $HYDRA_AUTOPILOT_REAP_SESSION_LINE
# (feeds the INV-6 priority gate — the exhaustion-line path, when it would
# post, always wins) + injected $HYDRA_AUTOPILOT_REAP_RECENT_CRASHES (stands in
# for the journal marker-count scan). No journal scan, no POST — purely the
# gate + threshold arithmetic under test. Output shape: `cause=<c> post=<yes|no>`.
if [ "${1:-}" = "--reap-crash-streak" ]; then
  __reap_derive_cause
  REAP_SESSION_LINE="${HYDRA_AUTOPILOT_REAP_SESSION_LINE:-}"
  __reap_session_should_post
  __reap_crash_streak_should_post
  echo "cause=${REAP_CAUSE} post=${REAP_CRASH_STREAK_SHOULD_POST}"
  exit 0
fi

# Dry-run (QA re-review hard-blocker fix #2 on PR #4644, issue #4585): echo
# `__reap_read_launch_model`'s HGET result directly. No state read, no POST —
# purely the Redis read under test, via the SAME HYDRA_AUTOPILOT_REDIS_CLI
# test-injection seam run_ledger.py's RedisMirror below uses. Output: the model
# string on stdout, or nothing on a miss/failure.
if [ "${1:-}" = "--reap-launch-model" ]; then
  __reap_read_launch_model
  exit 0
fi

# Dry-run (QA re-review hard-blocker fix #2 on PR #4644, issue #4585): echo
# `__reap_format_session_echo`'s rendering of a caller-supplied
# POST /api/usage/session-block response JSON (arg 2). No state read, no
# POST — purely the kind/blockedUntil/modelExhaustedUntil branching under
# test, so the repeat-vs-redirect echo can be pinned without a live server.
if [ "${1:-}" = "--reap-session-echo" ]; then
  __reap_format_session_echo "${2:-}"
  exit 0
fi

# Dry-run (issue #2954): run the exact live run-end POST retry loop
# (__reap_post_run_end) against ${HYDRA_API_BASE} with a caller-supplied
# payload (arg 2; a minimal placeholder when omitted). No state read, no
# cause derivation, no session-block — purely the retry/backoff/logging
# assembly under test, so a test HTTP server (or a closed port) can pin
# retry-on-5xx, retry-on-connection-refused, and the exhaustion line.
# Mirrors the live --reap contract on outcomes: ALWAYS exits 0 whether the
# POST succeeded or exhausted (the reap never aborts the unit stop); the
# echoed log lines carry the attempt count + outcome. HYDRA_API_BASE is
# REQUIRED here (no localhost:4000 default) so a mis-invoked dry-run can
# never POST a fake run-end to the live prod API.
if [ "${1:-}" = "--reap-post-run-end" ]; then
  if [ -z "${HYDRA_API_BASE:-}" ]; then
    echo "[autopilot] reap: --reap-post-run-end requires HYDRA_API_BASE (refusing to default to the live API)" >&2
    exit 2
  fi
  REAP_API_BASE="${HYDRA_API_BASE}"
  REAP_PAYLOAD="${2:-}"
  if [ -z "${REAP_PAYLOAD}" ]; then
    REAP_PAYLOAD='{"run_id":"dry-run","cause":"interrupted","ended_epoch":0,"exit_code":0}'
  fi
  REAP_RUN_ID="$(printf '%s' "${REAP_PAYLOAD}" | jq -r '.run_id // "dry-run"' 2>/dev/null || echo "dry-run")"
  REAP_CAUSE="$(printf '%s' "${REAP_PAYLOAD}" | jq -r '.cause // "unknown"' 2>/dev/null || echo "unknown")"
  REAP_EXIT_NUM="$(printf '%s' "${REAP_PAYLOAD}" | jq -r '.exit_code // 0' 2>/dev/null || echo 0)"
  __reap_post_run_end || true
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

  if [ ! -f "${REAP_STATE_PATH}" ] || ! command -v python3 >/dev/null 2>&1; then
    echo "[autopilot] reap: no state file or python3 unavailable — skipping"
    exit 0
  fi

  REAP_RUN_ID="$(python3 "$(dirname "$0")/run_ledger.py" get "${REAP_STATE_PATH}" run_id --prior --default "" 2>/dev/null || echo "")"
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

  # Issue #1089 (widened by #4583): exhaustion hard-block detection. When the
  # Claude Code rolling SESSION window is exhausted the CLI prints (to the
  # journal)
  #   You've hit your session limit · resets 4:40pm (America/Los_Angeles)
  # or, on the SEPARATE per-model credits exhaustion #4583 added recognition
  # for,
  #   You're out of usage credits. Switch to another model, ...
  # and exits code=1 either way — which __reap_derive_cause maps to `crash`.
  # If the pace-gate then relaunches the service it dies instantly again,
  # repeatedly, until the quota resets, abandoning all in-flight dispatches
  # (the credits notice stormed 240 relaunches over ~14h before #4583, run
  # 6a9539de — the exact storm #1089 fixed, recurring through a second
  # exhaustion message the pre-#4583 guard didn't recognise). To break that
  # storm we POST the exit line to /api/usage/session-block, which classifies
  # + parses the exit (server-side, via `parseExhaustionBlock`) and records a
  # self-expiring guard so the pace-gate skips relaunch until it passes.
  # WHERE it lands depends on the kind (issue #4585): `session-limit` arms the
  # session BLOCK as before (skip relaunch); `out-of-credits` arms the
  # MODEL-SCOPED exhaustion flag instead — a REDIRECT, not a stop, surfaced
  # as .reasons.fableExhaustedUntil so the pace-gate's exec branch launches
  # the next run on the fallback model (opus) until the flag expires
  # (TTL = min(now+60min, next Weekly Reset Anchor boundary)). The POST
  # destination is unchanged — the narrowing is server-side; only this
  # script's echo differs by kind.
  # Best-effort: any failure here is logged and never aborts the unit
  # stop (the reap NEVER throws). The server treats an unrecognised line as a
  # no-op (recorded:false), so scanning a normal crash's journal is harmless.
  #
  # Issue #1130: TWO guards stop a PHANTOM block from a stale line:
  #   1. Cause gate — only a `crash` (the code=1 exhaustion exit signature) may
  #      arm a block. A clean exit (cause=interrupted: code 0/143/130) skips
  #      detection entirely, so an hours-old exhaustion line left in the
  #      journal by a PRIOR run can no longer re-arm a block when this run
  #      exits cleanly.
  #   2. Run-scoped scan — the journal grep is bounded to THIS run (since the
  #      state file's started_epoch) instead of a 200-line window that spans
  #      prior runs, so even a crash only matches its OWN exhaustion line.
  # Before this, a clean code=0 exit re-grepped a stale line and parked the
  # autopilot for hours with the usage meter empty.
  #
  # Issue #4583 (INV-2): ONE combined grep (REAP_EXHAUSTION_GREP_PATTERN, both
  # phrasings) piped to `tail -n 1` — never two greps with a fixed precedence
  # (see the pattern's own docstring above for why a fixed order can pick a
  # phantom-tomorrow session-limit line over the real newest exhaustion line).
  #
  # Testability: HYDRA_AUTOPILOT_REAP_SESSION_LINE injects the candidate line
  # directly (the test harness can't poke the journal); when unset and the run
  # crashed we read THIS run's journal for the just-exited run. The cause-gate
  # decision is pinned by the `--reap-session-decision` dry-run above.
  # Read this run's start epoch once — both the exhaustion-line scan AND the
  # issue #2479 crash_detail journal fallback scope their journal reads to it
  # so a stale prior-run line cannot leak in.
  REAP_STARTED_EPOCH="$(python3 "$(dirname "$0")/run_ledger.py" get "${REAP_STATE_PATH}" started_epoch --prior --default 0 2>/dev/null || echo 0)"
  REAP_SESSION_LINE="${HYDRA_AUTOPILOT_REAP_SESSION_LINE:-}"
  if [ "${REAP_CAUSE}" = "crash" ]; then
    if [ -z "${REAP_SESSION_LINE}" ] && command -v journalctl >/dev/null 2>&1; then
      # Scope the scan to THIS run (since started_epoch) so a stale line from a
      # prior run cannot match. Fall back to the bounded tail only when the
      # start epoch is unavailable — still safe because the cause=crash gate
      # already holds. Newest match wins; the server-side classifier is the
      # real filter.
      if [ -n "${REAP_STARTED_EPOCH}" ] && [ "${REAP_STARTED_EPOCH}" != "0" ]; then
        REAP_SESSION_LINE="$(journalctl --user -u hydra-autopilot.service --since "@${REAP_STARTED_EPOCH}" --no-pager 2>/dev/null \
          | grep -iE "${REAP_EXHAUSTION_GREP_PATTERN}" | tail -n 1 || echo "")"
      else
        REAP_SESSION_LINE="$(journalctl --user -u hydra-autopilot.service -n 200 --no-pager 2>/dev/null \
          | grep -iE "${REAP_EXHAUSTION_GREP_PATTERN}" | tail -n 1 || echo "")"
      fi
    fi
  else
    # Clean / interrupted exit — never arm a session block (issue #1130).
    REAP_SESSION_LINE=""
  fi
  __reap_session_should_post

  # Issue #4583 (INV-4): the crash-streak marker-count MUST be taken before
  # this reap emits its OWN marker line below, so "prior" never double-counts
  # the current crash. __reap_crash_streak_should_post also needs
  # REAP_SESSION_SHOULD_POST (just computed) to honour the INV-6 priority rule
  # (an exact exhaustion-line classification beats the heuristic).
  __reap_crash_streak_should_post

  # Issue #4583 (INV-4): unconditional crash-exit marker, emitted on EVERY
  # cause=crash reap regardless of whether an exhaustion line matched — this
  # fixed line is the ONLY signal the crash-streak count above (on a FUTURE
  # reap) reads, so an unrecognised exhaustion string is still capped at N
  # launches per window instead of storming unbounded.
  if [ "${REAP_CAUSE}" = "crash" ]; then
    echo "[autopilot] reap: crash-exit run_id=${REAP_RUN_ID}"
  fi

  if [ "${REAP_SESSION_SHOULD_POST}" = "yes" ]; then
    # QA re-review hard-blocker fix #1 on PR #4644 (issue #4585): name which
    # model THIS run was actually launched on (pace-gate.sh's last-tick
    # record) so the server's repeat/redirect classifier can tell "the
    # fallback model died again" apart from "an independent, still-primary
    # dispatch died while the redirect flag happens to already be live" — the
    # false-positive the QA re-review found. Best-effort: an empty read
    # (Redis down, pre-#4585 tick with no `model` field) just omits `model`
    # from the payload, which the server treats conservatively (never a
    # confirmed repeat) — never blocks the reap.
    REAP_LAUNCH_MODEL="$(__reap_read_launch_model)"
    if [ -n "${REAP_LAUNCH_MODEL}" ]; then
      REAP_SESSION_PAYLOAD="$(jq -n --arg line "${REAP_SESSION_LINE}" --arg model "${REAP_LAUNCH_MODEL}" '{line: $line, model: $model}')"
    else
      REAP_SESSION_PAYLOAD="$(jq -n --arg line "${REAP_SESSION_LINE}" '{line: $line}')"
    fi
    REAP_SESSION_RESPONSE="$(curl -sf --max-time 5 -X POST \
        -H "content-type: application/json" \
        -d "${REAP_SESSION_PAYLOAD}" \
        "${REAP_API_BASE}/api/usage/session-block" 2>/dev/null || echo "")"
    if [ -n "${REAP_SESSION_RESPONSE}" ]; then
      # Issue #4583 (INV-8) / QA re-review fix #2 on PR #4644 (issue #4585):
      # render via __reap_format_session_echo, which branches on
      # `blockedUntil` (the field that actually distinguishes a live launch
      # block from a live redirect flag) rather than `kind` alone — see that
      # function's docstring for why the old kind-only branch printed a false
      # "no session block" with an empty timestamp on the repeat case.
      __reap_format_session_echo "${REAP_SESSION_RESPONSE}"
    else
      echo "[autopilot] reap: session-block POST failed (orchestrator down?) — pace-gate may relaunch into the quota"
    fi
  elif [ "${REAP_CRASH_STREAK_SHOULD_POST}" = "yes" ]; then
    # Issue #4583 (INV-4/INV-6): the message-agnostic backstop — only reached
    # when the exhaustion-line path did NOT already post. Fixed
    # HYDRA_AUTOPILOT_CRASH_STREAK_BLOCK_MIN (default 60min) block, tagged
    # reason=crash-streak so the server/echo can distinguish it from an exact
    # classification.
    REAP_CRASH_STREAK_BLOCK_MIN="${HYDRA_AUTOPILOT_CRASH_STREAK_BLOCK_MIN:-60}"
    REAP_CRASH_STREAK_UNTIL_MS=$(( $(date -u +%s) * 1000 + REAP_CRASH_STREAK_BLOCK_MIN * 60 * 1000 ))
    REAP_CRASH_STREAK_PAYLOAD="$(jq -n --argjson blockedUntilMs "${REAP_CRASH_STREAK_UNTIL_MS}" \
      '{blockedUntilMs: $blockedUntilMs, reason: "crash-streak"}')"
    REAP_CRASH_STREAK_RESPONSE="$(curl -sf --max-time 5 -X POST \
        -H "content-type: application/json" \
        -d "${REAP_CRASH_STREAK_PAYLOAD}" \
        "${REAP_API_BASE}/api/usage/session-block" 2>/dev/null || echo "")"
    if [ -n "${REAP_CRASH_STREAK_RESPONSE}" ]; then
      REAP_SESSION_KIND="$(printf '%s' "${REAP_CRASH_STREAK_RESPONSE}" | jq -r '.kind // "crash-streak"' 2>/dev/null || echo "crash-streak")"
      REAP_SESSION_UNTIL="$(printf '%s' "${REAP_CRASH_STREAK_RESPONSE}" | jq -r '.blockedUntil // ""' 2>/dev/null || echo "")"
      echo "[autopilot] reap: posted ${REAP_SESSION_KIND} block until ${REAP_SESSION_UNTIL} (${REAP_CRASH_STREAK_RECENT}+1 crash exits in ${REAP_CRASH_STREAK_WINDOW_MIN}min, issue #4583)"
    else
      echo "[autopilot] reap: crash-streak block POST failed (orchestrator down?) — pace-gate may relaunch into the exhausted state"
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

  # endRun is idempotent: if decide.py already POSTed run-end this run,
  # the row is already terminal and this POST is a no-op (deduped=true). A
  # failed POST is logged but never aborts the unit stop.
  #
  # Issue #2954: the POST retries with bounded backoff (see
  # __reap_post_run_end) — a run that merges PRs triggers the deploy, whose
  # hydra-orchestrator.service restart (~10s) races this very POST; a
  # single attempt then failed and the dead-pid sweeper mislabeled the
  # clean handoff exit as status=killed / term_reason=crash. The
  # session-block POST above deliberately stays single-attempt (it only
  # fires on cause=crash, disjoint from the clean-merge deploy race).
  __reap_post_run_end || true
  exit 0
fi

# In-session re-bootstrap decision (issue #4825) — an unattended session gets
# ONE run.
#
# The periodic context_compaction restart (issue #3787) is meant to shed the
# parent session context: terminate, exit, and let the pace gate launch a
# fresh session. Measured 2026-09-25..10-01, it never did: at every one of the
# 13 such terminations the session ran this script again in place, because the
# concurrent-run guard below only refuses a DIFFERENT live process. The context
# carried over (106k tokens at the first bootstrap, up to 400k by the sixth),
# half of all parent cache-read tokens were spent after the first in-session
# re-bootstrap, and each new run reset the per-run quota caps and skipped the
# pace gate admission check.
#
# Pure: reads its three arguments and two env vars, prints one line
# `decision=<allow|refuse> reason=<slug>`. Refuses ONLY when all of these hold:
#   - the state file is owned by THIS process (prior pid == resolved pid),
#   - that earlier run already took a turn (a bootstrap retried before the
#     first decide call is not a second run),
#   - the session is unattended (HYDRA_AUTOPILOT_TRIGGER is set — the pace gate
#     exports it; an interactive operator session leaves it unset and keeps
#     re-bootstrapping in place),
#   - the operator has not set HYDRA_AUTOPILOT_ALLOW_INSESSION_REBOOTSTRAP=1.
# A non-numeric pid or turn is treated as absent, so a damaged state file
# falls open to the pre-existing behaviour instead of wedging the launch.
__insession_rebootstrap_decision() {
  local prior_pid="${1:-0}" pid="${2:-0}" prior_turn="${3:-0}"
  case "${prior_pid}" in ''|*[!0-9]*) prior_pid=0 ;; esac
  case "${prior_turn}" in ''|*[!0-9]*) prior_turn=0 ;; esac
  if [ "${prior_pid}" -le 0 ]; then
    echo "decision=allow reason=no-prior-run"
  elif [ "${prior_pid}" != "${pid}" ]; then
    echo "decision=allow reason=different-process"
  elif [ "${prior_turn}" -le 0 ]; then
    echo "decision=allow reason=prior-run-never-took-a-turn"
  elif [ -z "${HYDRA_AUTOPILOT_TRIGGER:-}" ]; then
    echo "decision=allow reason=interactive-session"
  elif [ "${HYDRA_AUTOPILOT_ALLOW_INSESSION_REBOOTSTRAP:-}" = "1" ]; then
    echo "decision=allow reason=operator-override"
  else
    echo "decision=refuse reason=unattended-session-already-ran"
  fi
}

# Dry-run (issue #4825): echo the decision for <prior_pid> <pid> <prior_turn>
# and exit. No state read, no process-tree walk — purely the table under test.
if [ "${1:-}" = "--insession-rebootstrap-decision" ]; then
  __insession_rebootstrap_decision "${2:-0}" "${3:-0}" "${4:-0}"
  exit 0
fi

# Slash-arg parsing — must run BEFORE env reads below so explicit args
# override implicit env (issue #410). Sourced (not exec'd) so the
# exports land in this shell.
# shellcheck source=./args-parse.sh
. "$(dirname "$0")/args-parse.sh" "$@"

# Resolve file paths from env (test-isolation knobs). Mirrors the
# convention already established in heartbeat.py /
# reap.py — the only outlier was bootstrap.sh.
#
# The state-path resolution has ONE home: run_ledger.py (issue #5072).
RUN_LEDGER="$(dirname "$0")/run_ledger.py"
DEFAULT_STATE_PATH="$(python3 "${RUN_LEDGER}" path --default)"
DEFAULT_HEARTBEAT_PATH="/tmp/hydra-autopilot-heartbeat.txt"
DEFAULT_LOG_PATH="/tmp/hydra-autopilot-nightly.log"
STATE_PATH="$(python3 "${RUN_LEDGER}" path)"
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

# In-session re-bootstrap guard (issue #4825) — see
# `__insession_rebootstrap_decision` above. Runs BEFORE the heartbeat write so
# a refused call leaves the ended run's heartbeat and state.json untouched.
if [ -f "${STATE_PATH}" ] && command -v python3 >/dev/null 2>&1; then
  INSESSION_PRIOR_PID=$(python3 "${RUN_LEDGER}" get "${STATE_PATH}" pid --prior --default 0 2>/dev/null || echo 0)
  INSESSION_PRIOR_TURN=$(python3 "${RUN_LEDGER}" get "${STATE_PATH}" turn --prior --default 0 2>/dev/null || echo 0)
  case "$(__insession_rebootstrap_decision "${INSESSION_PRIOR_PID}" "${PID}" "${INSESSION_PRIOR_TURN}")" in
    decision=refuse*)
      INSESSION_PRIOR_RUN=$(python3 "${RUN_LEDGER}" get "${STATE_PATH}" run_id --prior --default unknown 2>/dev/null || echo unknown)
      echo "[autopilot] FATAL: in-session re-bootstrap refused (issue #4825): this unattended session (pid=${PID}) already ran run ${INSESSION_PRIOR_RUN} to turn ${INSESSION_PRIOR_TURN}."
      echo "[autopilot]   An unattended session gets ONE run. Do NOT start another one here."
      echo "[autopilot]   Reap each child still running as it completes, run drain.sh if you have not, then end the session."
      echo "[autopilot]   The pace gate admits the next run with a fresh context. Operator override: HYDRA_AUTOPILOT_ALLOW_INSESSION_REBOOTSTRAP=1."
      exit 1
      ;;
  esac
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) start pid=${PID} run_id=${RUN_ID}" > "${HEARTBEAT_PATH}"

# Concurrent-run guard. If an existing state.json's owner PID is still alive,
# refuse to overwrite — that is a real collision and the second instance
# should bow out. If the owner PID is dead, log the recovery and proceed
# (the chronic case from 2026-05-16: morning run died from a transient API
# 5xx, its state.json was left stamped with the dead PID, and the auto-retry
# misread that as a live duplicate). Best-effort: a missing jq is treated
# as "no prior state" rather than aborting bootstrap.
if [ -f "${STATE_PATH}" ] && command -v python3 >/dev/null 2>&1; then
  PRIOR_PID=$(python3 "${RUN_LEDGER}" get "${STATE_PATH}" pid --prior --default 0 2>/dev/null || echo 0)
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
# Periodic session-restart cadence (issue #3787) — cuts the parent session's
# own prompt-cache re-read cost. Measured in Autopilot Turns (one
# decide.py-decide invocation), NOT raw Anthropic API calls — see
# decide.py's CONTEXT_COMPACTION_TURNS_DEFAULT docstring for the unit
# rationale behind the 8-turn default.
CONTEXT_COMPACTION_TURNS="${HYDRA_AUTOPILOT_CONTEXT_COMPACTION_TURNS:-8}"

# Quota-percent budget (issue #3867) — the per-run spend cap denominated in the
# currency the operator actually pays. `token_budget` above counts
# subagent-reported input/output tokens, which under-measure real cache-weighted
# account utilization by roughly two orders of magnitude: run 2bcba309 (2026-08-05)
# "spent" 801k of a 4M token budget while the OAuth meter moved 2% -> 30% over the
# same window (~150M raw tokens). These caps are measured in UTILIZATION POINTS
# added over this run's own run-start baseline — decide.py captures the baseline
# lazily on the first turn that sees a calibrated `state.usage_eligibility` payload
# (already collected every turn by the Turn Snapshot, so zero new I/O) and emits
# `TERM:quota` once the delta crosses the cap.
#
# BOTH DEFAULT TO 0 = DISABLED. There is no calibration data for a safe default
# yet, and the systemd unit's existing invocation must not silently change
# behaviour on deploy — so an unset flag leaves the termination path byte-identical
# to a pre-#3867 run (ADR-0021 D5: per-run limits are hygiene caps subordinate to
# the Pace Gate, never a second governor switched on behind the operator's back).
# Fractional values are accepted (the percentages are floats server-side).
QUOTA_5H_MAX="${HYDRA_AUTOPILOT_QUOTA_5H_MAX:-0}"
QUOTA_WEEK_MAX="${HYDRA_AUTOPILOT_QUOTA_WEEK_MAX:-0}"
# Both values are interpolated UNQUOTED into the state.json heredoc below (they
# are JSON numbers, like token_budget). So a typo — `--quota-5h-max=ten` — would
# otherwise emit torn JSON and break every downstream jq/json.load reader at
# Phase 0 with a baffling parse error instead of a clear message. Validate here
# and FATAL loudly, matching the --scope validator's style.
# The `.*` and `*.` arms (issue #4129) reject a BARE leading/trailing decimal
# point — `.5` and `5.` parse as tokens but are not JSON numbers either, and
# the glob without them let both slip through to the same torn-JSON fate. A
# valid value needs at least one digit on each side of an optional decimal
# point (the `*.*.*` arm already bounds it to at most one point).
for _q_pair in "QUOTA_5H_MAX=${QUOTA_5H_MAX}" "QUOTA_WEEK_MAX=${QUOTA_WEEK_MAX}"; do
  _q_name="${_q_pair%%=*}"
  _q_val="${_q_pair#*=}"
  case "$_q_val" in
    ''|*[!0-9.]*|*.*.*|.*|*.)
      echo "[autopilot] FATAL: ${_q_name}=${_q_val} invalid (expected a non-negative number of utilization points, e.g. 10 or 2.5; 0 disables the cap)"
      exit 1
      ;;
  esac
done
unset _q_pair _q_name _q_val

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
# In unattended mode, the playbook must NOT invoke `AskUserQuestion`.
# Operator escalation is label-only: a Tier-0 / non-mechanical item that
# would have prompted the operator is left with the `ready-for-human` label
# on the item itself (ADR-0034 §8.1) — no dated queue issue is created.
# `/hydra-review` reads that label directly in the morning.
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

# Issue #4441 — fresh-run slot-events cursor seed (design-concept INV-5).
#
# The Turn Snapshot reads its `hydra:autopilot:slot-events` cursor from
# HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID (env, default "0") and deliberately
# NEVER reads state.json (its documented statelessness contract, INV-6/INV-8
# — this stays untouched so in-flight PR #4478/#4266, which moves those exact
# cursor lines into collect_slot_events, stays conflict-free either merge
# order). A fresh bootstrap with no cursor exported therefore replayed the
# stream from 0 — every historical subagent_stop since the stream began —
# which is what produced the stale reaps/escalations this issue reports.
#
# The fix seeds a NEW top-level `slot_events_last_id` field into the fresh
# state.json: a valid Redis stream id, `<STARTED_EPOCH>000-0`, meaning
# "entries after this run started". Both hooks (`on-subagent-stop.sh` /
# `on-subagent-permission-wait.sh`) XADD with `*` (server-assigned
# millisecond-timestamp ids), so this is an EXACT proxy for the stream tail
# at run start with NO Redis round-trip (a call here could fail/block Phase
# 0 — rejected alternative in the design concept). The playbook's existing
# instruction (pass HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID from state on every
# collect) then reads only current-run entries; decide.py's
# `_filter_stale_slot_events` is the load-bearing backstop for the case where
# the brain forgets to export it (a missed export just replays CURRENT-run
# entries, which reap idempotence + the escalation attempt cap absorb).
# (Issue #5072: run_ledger.py's seed_initial derives it from `now`=STARTED_EPOCH.)

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
# into pipeline slots + signal_last_fired (4 always-on classes re-armed
# each run + the carry-forward keys seeded from prior state per #2575,
# list generated per #4909). A v1 state.json (no
# schema_version field, ten-slot shape) is detected at Phase 0 as a
# legacy run; bootstrap re-runs and writes v2 on the next tick.
#
# The integer has ONE home: run_ledger.py (issue #5072, INV-5).
SCHEMA_VERSION="$(python3 "${RUN_LEDGER}" schema-version)"

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
# Best-effort and fail-open: orchestrator-down, a curl timeout, or an
# unparseable body all degrade to the all-null base (the pre-#1352 behaviour),
# so this can never block a bootstrap. Isolated runs (tests) skip the fetch.
#
# Issue #5073 — the 7-null base and the overlay merge live in run_ledger.py
# (build_slots); bash only fetches the raw payload (the ledger has no network)
# and hands it over verbatim as slots_overlay. Every other cross-run carry key
# (research_force_counter, dev_resume_pending, zero_yield_backoff,
# signal_last_fired) is read from the prior state file by the ledger's
# carry_forward() inside `run_ledger.py seed --carry-from`; bootstrap holds no
# carry logic. The carried signal set is DERIVED from classes.json.
SLOTS_SEED_RAW=""
if [ "${ISOLATED_RUN}" != "1" ]; then
  SLOTS_API_BASE="${HYDRA_API_BASE:-http://localhost:4000}"
  SLOTS_SEED_RAW="$(curl -sf --max-time 5 "${SLOTS_API_BASE}/api/autopilot/inflight-slots" 2>/dev/null || echo "")"
  # Issue #5142: drop any seeded slot the PRIOR run already reaped (its
  # state.json reaped_task_ids) — read BEFORE `run_ledger.py seed` clobbers the
  # file. Fail-open: a filter failure keeps the raw payload unchanged.
  if [ -n "${SLOTS_SEED_RAW}" ] && [ -f "${STATE_PATH}" ]; then
    SLOTS_FILTERED="$(printf '%s' "${SLOTS_SEED_RAW}" | python3 "$(dirname "$0")/run_termination.py" seed-filter "${STATE_PATH}" || echo "")"
    case "${SLOTS_FILTERED}" in
      "{"*) SLOTS_SEED_RAW="${SLOTS_FILTERED}" ;;
      *) ;;
    esac
  fi
fi

# Redis continuity (ADR-0012 D2, issue #2715) is consulted only under this gate:
# a non-isolated run, or a test that injected a HYDRA_AUTOPILOT_REDIS_CLI stub.
SEED_MIRROR_FLAG=()
if [ "${ISOLATED_RUN}" != "1" ] || [ -n "${HYDRA_AUTOPILOT_REDIS_CLI:-}" ]; then
  SEED_MIRROR_FLAG=(--mirror)
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
#     legacy `/tmp/hydra-last-*.txt` files. ALL SIXTEEN KEYS MUST BE PRESENT
#     for the same reason: the 4 always-on classes
#     (health / sweep_* / discover_target) seeded at `0` (re-armed each run),
#     plus the 11 long-cooldown classes (retro_orch / architecture_orch /
#     discover_orch / cleanup_orch / scout_orch / wire_or_retire_target /
#     design_qa_target / skill_prune / cleanup_target / wayfinder_orch /
#     tickets_orch; #2722/#2739/#2949 added the wire/design/skill entries,
#     #3920 moved discover_orch here from the always-on group, and #4909
#     added the three its derived-from-classes.json guard caught) which
#     are SEEDED FROM THE PRIOR STATE FILE (issue #2575 — run_ledger.carry_forward
#     derives the carried set from classes.json per #4909) so their
#     1h/24h/7d cooldown survives the pace-gate's ~15-min relaunch
#     cadence. The 12th carried key, `research_target` (issue #4611), is a
#     pipeline slot's plan-time re-fire stamp (6h interval), carried
#     forward the same way.
#     Before #2575 these were omitted entirely, so decide.py's
#     `signal_is_cooled()` read a missing key as epoch 0 (permanently cooled)
#     and retro_orch fired 5–8×/day instead of the designed 1×/day.
#   - `failure_log` is a new ring buffer of structured failure records
#     consumed by `self_heal.py` (issue #426 self-heal table).
#   - `reaped_task_ids` (issue #411) and `burned_classes` (issue #395)
#     are preserved unchanged.
#   - `research_force_counter` (issue #1666) is seeded from the prior state
#     file (carried by run_ledger.carry_forward) — the 4/day forced-research cap
#     must survive the pace-gate's multi-run-per-day relaunch cadence.
#     Additive + tolerated-missing by all readers, so no schema_version bump.
#     The 7 long-cooldown `signal_last_fired` classes are seeded from prior
#     state the same way (issue #2575 — run_ledger.carry_forward).
#   - `dev_resume_pending` (issue #4518) is carried forward from the prior
#     state file (carried by run_ledger.carry_forward) — a queued no-PR-stall
#     resume record (#3866) must survive the relaunch that follows the run
#     which queued it. Additive + tolerated-missing by all readers (decide.py
#     and reap_stall.py both treat a non-list as empty), so no schema_version
#     bump.
#   - `zero_yield_backoff` (issue #4999) is carried forward from the prior
#     state file (carried by run_ledger.carry_forward) — the discover_target
#     idle-board back-off ladder ({class: {streak, last_fired}}) must survive
#     the pace-gate relaunch or the back-off never climbs past rung 0.
#     Additive + tolerated-missing by all readers (decide.py degrades a
#     malformed entry to the streak-0 identity), so no schema_version bump.
#   - `schema_version` (issue #434) participates in the Phase 0 handshake.
#   - `limits.quota_5h_max_pts` / `limits.quota_week_max_pts` (issue #3867) are
#     the opt-in quota-percent budget, in utilization POINTS over this run's own
#     baseline; 0 = disabled (the default). Deliberately NOT seeded from prior
#     state: the cap is per-run, and the matching `quota_baseline` key (written
#     lazily by decide.py on the first calibrated turn) is likewise absent here,
#     so overwriting state.json each bootstrap is exactly what re-arms the
#     baseline capture for the new run. Additive + tolerated-missing by all
#     readers (decide.py skips the cap when either is absent), so no
#     schema_version bump.
#   - `cumulative_tokens` seeds at 0 and is advanced ONLY by reap.py on each
#     subagent completion (the per-turn token surrogate). This is the field the
#     LIVE `TERM:budget` gate reads in decide.py — NOT dead code
#     (issue #2429). The same value is mirrored onto the Redis run hash by
#     heartbeat.py for the dashboard; the run-hash copy is 0 only for a run that
#     exits before the surrogate accumulates (a 1-2-turn print-mode run).
#
# Backward compat: the seed OVERWRITES the existing file. A v1
# legacy state.json (or a v2 state.json with `slots: {}` empty) is
# clobbered on each bootstrap, so no migration path is needed —
# bootstrap is always run before the brain reads state.
# Issue #5072 — the document is written by the Run Ledger (run_ledger.py seed),
# the one atomic writer. Issue #5073 — the five carry keys are no longer passed
# in: `--carry-from` points the ledger at the prior run's file (read BEFORE the
# atomic replace) and carry_forward() derives them. An unknown or missing key
# exits 2 before any write, so a stale caller fails loud.
if ! python3 "${RUN_LEDGER}" seed "${STATE_PATH}" \
  --carry-from "${STATE_PATH}" \
  ${SEED_MIRROR_FLAG[@]+"${SEED_MIRROR_FLAG[@]}"} \
  "now=${STARTED_EPOCH}" \
  "pid=${PID}" \
  "run_id=\"${RUN_ID}\"" \
  "token_budget=${TOKEN_BUDGET}" \
  "wall_clock_max_sec=${WALL_CLOCK_MAX_SEC}" \
  "idle_drain_turns=${IDLE_DRAIN_TURNS}" \
  "context_compaction_turns=${CONTEXT_COMPACTION_TURNS}" \
  "quota_5h_max_pts=${QUOTA_5H_MAX}" \
  "quota_week_max_pts=${QUOTA_WEEK_MAX}" \
  "scope=\"${SCOPE}\"" \
  "subagent_max_tokens=${SUBAGENT_MAX_TOKENS}" \
  "subagent_hard_max_tokens=${SUBAGENT_HARD_MAX_TOKENS}" \
  "unattended=${UNATTENDED}" \
  "daily_spend_cap_usd=${DAILY_SPEND_CAP_USD}" \
  "scout_cost_share=${SCOUT_COST_SHARE}" \
  "slots_overlay=${SLOTS_SEED_RAW}"; then
  echo "[autopilot] FATAL: run_ledger.py seed failed (state path ${STATE_PATH})"
  exit 1
fi

# Issue #5149: promote the anchor of any dev_orch the PRIOR run dispatched but
# never collected (it is now an inflight-seed slot) to needs-qa when an open PR
# closes it. Promotion-only (no slot mutation), best-effort, never blocks.
if [ "${ISOLATED_RUN}" != "1" ]; then
  python3 "$(dirname "$0")/reap.py" reconcile-seeded "${STATE_PATH}" || true
fi

# Echo resolved limits so the model captures them in conversation context
echo "[autopilot] limits resolved: token_budget=${TOKEN_BUDGET} wall_clock_max_sec=${WALL_CLOCK_MAX_SEC} idle_drain_turns=${IDLE_DRAIN_TURNS} context_compaction_turns=${CONTEXT_COMPACTION_TURNS} quota_5h_max_pts=${QUOTA_5H_MAX} quota_week_max_pts=${QUOTA_WEEK_MAX} scope=${SCOPE} subagent_soft=${SUBAGENT_MAX_TOKENS} subagent_hard=${SUBAGENT_HARD_MAX_TOKENS} unattended=${UNATTENDED} schema_version=${SCHEMA_VERSION} daily_spend_cap_usd=${DAILY_SPEND_CAP_USD} scout_cost_share=${SCOUT_COST_SHARE}"
echo "[autopilot] state schema_version=${SCHEMA_VERSION} (playbook must match HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA marker; see Phase 0 handshake)"

# Issue #435 — overwrite the Phase 0 heartbeat with the structured
# per-turn format immediately so the file format is consistent from turn
# 0 onwards. Best-effort: a heartbeat-write failure must NOT abort
# bootstrap (we already wrote the legacy `start ...` line above which is
# enough for operators to see something).
python3 "$(dirname "$0")/heartbeat.py" --last-action=bootstrap || \
  echo "[autopilot] heartbeat.py initial write failed; continuing"

# Issue #497 — register this run with the orchestrator's autopilot-runs
# dashboard surface. Posts run-start with the limits payload + trigger.
# Best-effort: orchestrator-down must not block bootstrap, so a curl failure
# is logged but ignored. The endpoint is idempotent on run_id, so a transient
# failure followed by a manual retry is safe.
#
# Trigger env contract (issue #2955): pace-gate.sh's eligible exec branch
# exports HYDRA_AUTOPILOT_TRIGGER=pace-gate before exec'ing the claude CLI,
# and every systemd-mediated launch (timer start AND Restart= relaunch)
# routes through that branch (issue #1089). So:
#   HYDRA_AUTOPILOT_TRIGGER set (non-empty) → its value (pace-gate)
#   unset or empty                          → manual (a hand-launched session)
# The old hour-of-day heuristic (morning-timer/overnight-timer) was deleted:
# ADR-0021 retired those timers, so the labels were phantoms stamped by clock
# coincidence.
#
# Isolated runs (non-default STATE/HEARTBEAT/LOG path) skip this POST
# entirely. The test suite frequently invokes bootstrap.sh and was
# spamming the live /api/autopilot/run-start endpoint with fake runs,
# which made the dashboard's "current run" widget report autopilot as
# down (root cause of the 2026-05-26 dashboard ghost-outage).
if [ "${ISOLATED_RUN}" = "1" ]; then
  echo "[autopilot] isolated run (non-default state/heartbeat/log path) — skipping run-start POST"
else
  # Colon-dash so an EMPTY export also falls back to manual (issue #2955).
  TRIGGER="${HYDRA_AUTOPILOT_TRIGGER:-manual}"

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
    "context_compaction_turns": ${CONTEXT_COMPACTION_TURNS},
    "quota_5h_max_pts": ${QUOTA_5H_MAX},
    "quota_week_max_pts": ${QUOTA_WEEK_MAX},
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
