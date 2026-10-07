#!/usr/bin/env bash
#
# collect-state.sh — Phase 1 of /hydra-autopilot.
#
# Cheap state collectors (~100ms total). Emits one line per signal to
# stdout; the calling Claude turn reads these as compact decision input.
# Never dumps raw responses — counts and short summaries only.
#
# This script is read-only: no Redis writes, no GitHub edits.
#
# Behavior-preserving extraction of the Phase 1 collectors (issue #409).
#
# Forcing a research cycle (issue #2489): there is no longer an HTTP lever for
# this. The old POST /research/force endpoint wrote a Redis one-shot flag
# (hydra:scheduler:research-force-once) whose consumer was deleted with the
# in-process research loop in #706; the orphaned write end was retired in #2489.
# To force research today, drive it through the autopilot brain: decide.py's
# daily research-force cap (_research_force_allowed / _research_force_stamp)
# governs forced research_target dispatches, or write the work-queue directly
# (POST /api/queue) to push a research anchor to the front of the next turn.
# This collector deliberately does NOT read or surface a force flag — it stays
# read-only and the policy lives in decide.py, not at the HTTP seam.

set -uo pipefail

# Directory of this script — the Turn Snapshot CLI (turn-snapshot.ts) lives
# next to it. Resolved to an absolute path so the CLI is found regardless of
# how $0 was passed (relative invocation, worktree path), mirroring
# recover-stale.sh's idiom (issue #3852).
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)

# Shared page size for EVERY `gh issue list` in this script (issue #3710).
#
# `gh issue list` defaults to 30 results with no warning, so an unlimited call
# silently truncates once a board exceeds 30 — and because gh sorts
# newest-first it drops the OLDEST issues, which is exactly the cohort the
# age-sensitive consumers (wire-or-retire's 45-day ledger, the backfill-idle
# checks) care about. The Target board was already past 30 when this was
# filed, so five open issues were invisible on every turn.
#
# 100 is the GitHub API's maximum single-page size: the largest value
# obtainable in ONE request on a per-turn hot path, and the same value as
# `DEFAULT_LIMIT` in src/github/issues.ts, so the degraded shell path and the
# healthy API path agree by construction. Deliberately NOT `--paginate` — that
# would trade a silent truncation for unbounded per-turn latency and
# rate-limit cost. Breaching 100 is made observable instead, via
# `target_board_signals_truncated` (see the Target board block below).
#
# One constant, referenced everywhere: nine literals would drift apart.
GH_ISSUE_LIST_LIMIT="${HYDRA_GH_ISSUE_LIST_LIMIT:-100}"

# STRUCTURE (issue #4266): every collector is a named `collect_*` function and
# `main` (at the bottom) calls them in the fixed order that defines the emitted
# key=value stream — that order IS the public interface decide.py and the
# playbook read, so never reorder calls casually. Function bodies are
# deliberately NOT indented: the inline python heredocs need their `PY` body and
# terminator at column 0, and several tests slice this file's text by exact
# markers (see the collect-state tests that slice it), so the bodies stay
# byte-identical to their pre-decomposition form. Cross-collector values
# (ORCH_*, BOARD_STATE_*, TARGET_*, ARCH_WORK_QUEUE, ...) are globals assigned in
# place; never pre-declare them in a shared init block (it would move the
# first-occurrence markers those tests key on). `main` runs only when the script
# is executed, not when sourced, so a test can source it and call one collector.

# HEALTH + DIRECTION DRIFT — Turn Snapshot collectors (ADR-0043 slice 5,
# issue #4933). collect_health + collect_direction_drift (and their heredoc)
# are now the typed `health` and `direction-drift` collectors in
# src/autopilot/turn-snapshot/passthrough.ts, run by the one-shot CLI and
# rendered byte-identically by render-kv-passthrough.ts (golden files under
# test/fixtures/turn-snapshot/passthrough/). Semantics are unchanged:
#   - health=<status> redis=<redis> from GET /api/health (health=FAIL when
#     unreadable); failed_services=<failed systemd user units matching hydra>
#     (the legacy pipefail quirk — a second `0` line on a zero count — is kept).
#   - direction_drift (#1791): true when a readable live Target direction doc
#     ($HYDRA_TARGET_REPO/direction/{priorities,roadmap}.md, else the Target
#     workspace from src/target-config.ts) differs from its readable committed
#     copy under ${HYDRA_CONFIG_PATH:-$HOME/hydra/config}/direction; a missing
#     side never drifts (fail closed to no-drift). READ-ONLY — the canonical
#     refresh is documented in docs/operator-playbooks/hydra-target-build.md.
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note.
collect_turn_snapshot_health() {
local ts_out=""
if ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors health,direction-drift --format kv) \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
else
  echo "orch turn-snapshot health/direction-drift CLI failed or produced no output — emitting the fail-open fallback (issue #4933)" >&2
  printf '%s\n' $'health=FAIL\nfailed_services=0\n0\ndirection_drift=false'
fi
return 0
}

# Target identity (ADR-0002 / ADR-0013): every Target collector now resolves
# the repo / workspace / manifest through src/target-config.ts inside the Turn
# Snapshot CLI (ADR-0043 slice 4, #4932), so this script no longer shells to
# print-target-facts.ts at all.

# ORCH BOARD — a Turn Snapshot collector (ADR-0043 slice 2, issue #4930). The
# logic that lived here as collect_orch_board (two python heredocs and the
# degraded-path jq re-implementation of deriveBoardState with its own copy of
# the in-progress/blocked stale windows) is now the typed `orch-board` collector in
# src/autopilot/turn-snapshot/orch-board.ts, run by the one-shot CLI
# scripts/autopilot/turn-snapshot.ts and rendered BYTE-IDENTICALLY by its `kv`
# renderer (golden files test/fixtures/turn-snapshot/orch-board-*.json). The
# module docblock carries the rules; in short:
#   - emits the board-state JSON counts line, keys=['needs_qa','ready_for_agent','needs_triage','needs_research','in_progress','blocked','stale_in_progress','stale_blocked']
#     (the NON_KV_PRODUCERS anchor), then orch_needs_triage_items (#3939).
#     `ready_for_agent` > 0 → state.signals.orch_work_available → dev_orch
#     (#458); `needs_qa` counts ISSUES still awaiting review (hydra-qa clears
#     the label once it files a verdict, #638).
#   - PRIMARY read: GET /autopilot/board-state through the hydra HTTP adapter
#     (#934). When the service is down or degraded the CLI imports
#     `deriveBoardState` itself over the gh rows — one predicate, no second
#     language (ADR-0043 Decision 2); glm-eligible stays counted there
#     (fail-open, #3754).
#   - Issue #4130: a FAILED fallback read emits NO counts line and seeds
#     ORCH_BOARD_DEGRADED=1 — the accumulator every later orch-lane board read
#     (grill list, ARCH backfill) adds to; the one
#     `orch_board_signals_degraded=true|false` line after the ARCH block is the
#     per-lane flag decide.py gates on. A failed read never masquerades as an
#     all-zero board.
# ORCH_BOARD_DEGRADED, BOARD_STATE_DEGRADED and BOARD_STATE_JSON (the healthy
# body, the glm_withheld pin guard's source, #4254) come back through
# --exports-file. FAIL-OPEN: if the CLI itself cannot run, this prints the
# all-reads-failed fallback (no counts line, an empty needs-triage set), flags
# the lane degraded and notes why.
collect_turn_snapshot_orch_board() {
ORCH_BOARD_DEGRADED=1
BOARD_STATE_DEGRADED=1
BOARD_STATE_JSON=""
local ts_out="" ts_exports="" ts_key ts_value
ts_exports=$(mktemp) || ts_exports=""
if [ -n "$ts_exports" ] \
  && ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors orch-board --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" --exports-file "$ts_exports") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
  while IFS='=' read -r ts_key ts_value; do
    case "$ts_key" in
      ORCH_BOARD_DEGRADED) ORCH_BOARD_DEGRADED=$ts_value ;;
      BOARD_STATE_DEGRADED) BOARD_STATE_DEGRADED=$ts_value ;;
      BOARD_STATE_JSON) BOARD_STATE_JSON=$ts_value ;;
    esac
  done < "$ts_exports"
else
  echo "orch turn-snapshot orch-board CLI failed or produced no output — counts withheld, board flagged degraded (issue #4930)" >&2
  printf '%s\n' $'orch_needs_triage_items='
fi
[ -n "$ts_exports" ] && rm -f "$ts_exports"
return 0
}

# Target-side issue board — GitHub-derived Target dispatch signals (issues
# #3435, #3709, #4130, #4474, #4475, #4576, #4653, #4739, #4823; ADR-0031).
#
# Moved whole — fetches included — to the Turn Snapshot `target-board`
# collector (src/autopilot/turn-snapshot/target-board.ts, ADR-0043 slice 4,
# issue #4932), which owns the semantics and their history: the scope=target
# board-state counts (gh-REST fallback when the endpoint is down), the
# in-flight PR exclusion on target_ready_for_agent, the starvation note, the
# liveness-aware WIP keys, the needs-qa PR pre-resolution and the Target dev
# resume pick (the ONE dev-resume pick it shares with the orch realm,
# src/autopilot/turn-snapshot/dev-resume.ts). The Target repo resolves through
# src/target-config.ts (ADR-0002) inside the CLI — never a literal here.
#
# The lane-degraded accumulator (#4130) comes back through --exports-file into
# TARGET_LANE_DEGRADED, which collect_turn_snapshot_target_scan passes on.
# FAIL-CLOSED: if the CLI itself cannot run, this prints the all-reads-failed
# fallback lines (zero counts, unknown WIP limit, empty QA ref, no resume pick)
# plus a note, and latches the lane as degraded.
collect_turn_snapshot_target_board() {
TARGET_LANE_DEGRADED=1
local ts_out="" ts_exports="" ts_key ts_value
ts_exports=$(mktemp) || ts_exports=""
if [ -n "$ts_exports" ] \
  && ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors target-board --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" --exports-file "$ts_exports") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
  while IFS='=' read -r ts_key ts_value; do
    case "$ts_key" in
      TARGET_LANE_DEGRADED) TARGET_LANE_DEGRADED=$ts_value ;;
    esac
  done < "$ts_exports"
else
  echo "target turn-snapshot target-board CLI failed or produced no output — emitting the fail-closed Target board fallback; lane degraded (issue #4932)" >&2
  printf '%s\n' $'target_ready_for_agent=0\ntarget_ready_blocker_excluded=0\ntarget_needs_qa=0\ntarget_needs_triage=0\ntarget_needs_research=0\ntarget_wip_limit=unknown\ntarget_in_progress=0\ntarget_wip_live=0\ntarget_wip_saturated=false\ntarget_needs_qa_pr_ref=\ntarget_needs_qa_pr_head=\ntarget_dev_resume_pick=none'
fi
[ -n "$ts_exports" ] && rm -f "$ts_exports"
return 0
}

# UNTRIAGED ORPHANS + NEEDS-QA NUMBERS — Turn Snapshot collectors (ADR-0043
# slice 2, issue #4930). The jq filters that lived here as
# collect_untriaged_orphans + collect_needs_qa_numbers are now the typed
# `untriaged-orphans` and `needs-qa` collectors in
# src/autopilot/turn-snapshot/orch-board.ts (the exclusion-label rationale —
# #2426, #2828, #2958, #3728, #3817, #4025, #4096, #4220 — lives on
# UNTRIAGED_ORPHAN_EXCLUDED_LABELS there), rendered byte-identically:
#   - untriaged_orphans = open issues carrying no lifecycle/parking label and no
#     `wayfinder:` label; `> 0` → untriaged_orphans_orch → sweep_orch's
#     secondary trigger. A failed read emits 0 (never a spurious sweep).
#   - needs_qa_numbers = the open needs-qa issues in gh's DEFAULT order — the
#     order hydra-qa self-selects in, so `[0]` is the issue QA reviews next
#     (#3829 INV-4). A failed read emits empty (decide.py fails open).
# Both are standalone gh reads, independent of the board-state seam. FAIL-OPEN:
# if the CLI itself cannot run, this prints the failed-read fallback lines.
collect_turn_snapshot_orphans_needs_qa() {
# The `.` sentinel keeps the CLI's trailing blank line (the historical
# needs_qa_numbers shape) that `$(...)` would otherwise strip.
local ts_out=""
ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors untriaged-orphans,needs-qa --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" && printf '.')
if [ "${ts_out%.}" != "$ts_out" ] && [ -n "${ts_out%.}" ]; then
  printf '%s' "${ts_out%.}"
else
  echo "orch turn-snapshot untriaged-orphans/needs-qa CLI failed or produced no output — emitting the failed-read fallback (issue #4930)" >&2
  printf '%s\n' $'untriaged_orphans=0\nneeds_qa_numbers='
fi
return 0
}

# IN-FLIGHT PRs + PR-GATE REACHABILITY + GRILL/DEV-READY PICKS — Turn Snapshot
# collectors (ADR-0043 slices 1 and 3, issues #4929 and #4931). The logic that
# lived here as collect_orch_inflight_prs + collect_pr_gate_reachability
# (slice 1) and collect_orch_grill_candidates + collect_orch_merged_prs +
# collect_orch_grill_and_dev_ready_picks + collect_candidate_exclusions +
# collect_active_dev_orch (slice 3) is now the typed `pr-gate` and `picks`
# collectors in src/autopilot/turn-snapshot/{pr-gate,picks}.ts, run in ONE
# invocation of the one-shot CLI scripts/autopilot/turn-snapshot.ts (picks takes
# pr-gate's in-flight sets in-process) and rendered by its `kv` renderer
# BYTE-IDENTICALLY to the bash it replaced (golden files under
# test/fixtures/turn-snapshot/). Semantics are unchanged; the module docblocks
# carry the rules and the issues behind them:
#   - ONE `gh pr list` payload feeds the in-flight exclusion sets (#3711,
#     #3851, #3964, #4334) AND the PR-gate buckets (#4240); the #4812 UNKNOWN
#     mergeStateStatus re-poll is the single sanctioned second PR read
#     (HYDRA_ORCH_UNKNOWN_REPOLL_DELAY_SECONDS, default 5).
#   - emits orch_prs_dirty / orch_prs_unchecked / orch_prs_behind /
#     orch_ci_trigger_stale / orch_prs_glm_red / orch_glm_red_forward_fix /
#     orch_dev_resume_pick / orch_dirty_forward_fix / orch_prs_dirty_surface,
#     in that order (#4240, #4460, #4518, #4807). Windows:
#     HYDRA_ORCH_PR_UNCHECKED_GRACE_SECONDS (600), HYDRA_ORCH_GLM_RED_QUIESCENCE_SECONDS (1800).
#   - then orch_pending_grill_anchor / orch_dev_ready_anchor (#628, #1088,
#     #1230, #3711, #3965, #4254, #4690), candidate_exclusions_json (#3964) and
#     active_dev_orch (#412, #3687, #4048). The strict-blocker, merged-PR and
#     grill-exemption predicates are the canonical TS ones
#     (src/github/blockers.ts, src/github/pr-refs.ts, src/glm/eligibility.ts) —
#     no python twin remains in this script.
#   - the stale flag fails OPEN (INV-E); the glm-red / dev-resume / dirty-fix
#     picks fail CLOSED (INV-5, #4807 INV-4). A FAILED grill-list read flips the
#     ORCH_BOARD_DEGRADED accumulator (#4130), which comes back through
#     --exports-file for the still-bash arch block below.
#   - the GLM-withheld pin refusal (#4254) reads glm_withheld off the SAME
#     healthy board-state body the counts line used (handed over through
#     --board-state-file); a degraded board-state read passes no file, so no pin
#     is refused (fail-open, #3754).
# FAIL-OPEN: if the CLI itself cannot run (no node, a crash before output) this
# prints the same all-reads-failed fallback lines the bash printed, plus a note,
# and flags the orch lane degraded (the grill list was never read).
collect_turn_snapshot_pr_gate_and_picks() {
local ts_out="" ts_exports="" ts_board="" ts_key ts_value ts_degraded_seen=0
local -a ts_board_args=()
ts_exports=$(mktemp) || ts_exports=""
if [ "${BOARD_STATE_DEGRADED:-1}" = "0" ]; then
  if ts_board=$(mktemp); then
    printf '%s' "${BOARD_STATE_JSON:-}" > "$ts_board"
    ts_board_args=(--board-state-file "$ts_board")
  else
    ts_board=""
    echo "orch turn-snapshot: mktemp for --board-state-file failed — no glm_withheld pin refusal this turn (fail-open, #3754) (issue #4931)" >&2
  fi
fi
if [ -n "$ts_exports" ] \
  && ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors pr-gate,picks --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" --exports-file "$ts_exports" \
       ${ts_board_args[@]+"${ts_board_args[@]}"}) \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
  while IFS='=' read -r ts_key ts_value; do
    case "$ts_key" in
      ORCH_BOARD_DEGRADED) ts_degraded_seen=1; [ "$ts_value" = "1" ] && ORCH_BOARD_DEGRADED=1 ;;
    esac
  done < "$ts_exports"
  # The CLI always writes ORCH_BOARD_DEGRADED=0|1; a missing key means the
  # exports write failed, so the grill-list read is unconfirmed — fail CLOSED.
  if [ "$ts_degraded_seen" != "1" ]; then
    echo "orch turn-snapshot exports file carried no ORCH_BOARD_DEGRADED — treating the orch lane as degraded (issue #4931)" >&2
    ORCH_BOARD_DEGRADED=1
  fi
else
  echo "orch turn-snapshot pr-gate/picks CLI failed or produced no output — emitting the fail-open PR-gate + picks fallback; orch lane flagged degraded (issues #4929, #4931)" >&2
  printf '%s\n' $'orch_prs_dirty=\norch_prs_unchecked=\norch_prs_behind=\norch_ci_trigger_stale=false\norch_prs_glm_red=\norch_glm_red_forward_fix=none\norch_dev_resume_pick=none\norch_dirty_forward_fix=none\norch_prs_dirty_surface=\norch_pending_grill_anchor=none\norch_dev_ready_anchor=none\ncandidate_exclusions_json=[]\nactive_dev_orch=0'
  ORCH_BOARD_DEGRADED=1
fi
[ -n "$ts_exports" ] && rm -f "$ts_exports"
[ -n "$ts_board" ] && rm -f "$ts_board"
return 0
}

# REDIS QUEUES + SCOUT + ARCH/CLEANUP/SKILL-PRUNE BOARDS + HITL-GRILL INBOX —
# Turn Snapshot collectors (ADR-0043 slice 5B, issue #4933). collect_redis_queues,
# collect_scout, collect_arch_cleanup_boards and collect_hitl_grill (and their
# heredocs) are now the typed `redis-queues`, `scout`, `arch-cleanup-boards` and
# `hitl-grill` collectors in src/autopilot/turn-snapshot/board-saturation.ts,
# reading Redis through the typed src/redis accessors (redis-port.ts) and gh
# through the TurnSnapshotGithub port, rendered byte-identically by
# render-kv-remaining.ts (golden files under test/fixtures/turn-snapshot/remaining/).
# The module docblock carries each signal's rules and the issues behind them
# (#3478, #485, #532, #789, #959, #960, #4130, #4391, #4607, #4657). Semantics
# are unchanged — including the scout spend mirror WRITE into
# hydra:scout:spend:<DATE> (7d TTL) and the #4130 rule that a failed board read
# never computes orch_backfill_idle from fake zeros. ORCH_BOARD_DEGRADED goes in
# (earlier orch reads may have flipped it) and comes back with ARCH_WORK_QUEUE
# (read by collect_turn_snapshot_target_scan) through --exports-file.
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note and
# flag the orch lane degraded (the board read did not happen). The exported
# globals fail CLOSED: an unconfirmed work-queue depth reads as 1 (so
# target_backfill_idle cannot fire) and ORCH_BOARD_DEGRADED as 1.
collect_turn_snapshot_boards() {
ARCH_WORK_QUEUE=0
local ts_out="" ts_exports="" ts_key ts_value ts_wq_seen=0 ts_degraded_seen=0
ts_exports=$(mktemp) || ts_exports=""
if [ -n "$ts_exports" ] \
  && ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors redis-queues,scout,arch-cleanup-boards,hitl-grill --format kv \
       --gh-list-limit "$GH_ISSUE_LIST_LIMIT" --orch-board-degraded "${ORCH_BOARD_DEGRADED:-0}" \
       --exports-file "$ts_exports") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
  while IFS='=' read -r ts_key ts_value; do
    case "$ts_key" in
      ARCH_WORK_QUEUE) ts_wq_seen=1; ARCH_WORK_QUEUE=$ts_value ;;
      ORCH_BOARD_DEGRADED) ts_degraded_seen=1; ORCH_BOARD_DEGRADED=$ts_value ;;
    esac
  done < "$ts_exports"
  # The CLI always writes both keys; a missing key means the exports write
  # failed, so the work-queue depth / board read is unconfirmed — fail CLOSED:
  # a non-zero work queue keeps target_backfill_idle false, and the orch lane
  # reads degraded (the slice-3 ts_degraded_seen pattern).
  if [ "$ts_wq_seen" != "1" ]; then
    echo "orch turn-snapshot boards exports file carried no ARCH_WORK_QUEUE — treating the work queue as non-empty so target backfill cannot fire (issue #4933)" >&2
    ARCH_WORK_QUEUE=1
  fi
  if [ "$ts_degraded_seen" != "1" ]; then
    echo "orch turn-snapshot boards exports file carried no ORCH_BOARD_DEGRADED — treating the orch lane as degraded (issue #4933)" >&2
    ORCH_BOARD_DEGRADED=1
  fi
else
  echo "orch turn-snapshot boards CLI failed or produced no output — emitting the fail-open fallback; orch board flagged degraded, work queue treated as non-empty (issue #4933)" >&2
  ORCH_BOARD_DEGRADED=1
  ARCH_WORK_QUEUE=1
  printf '%s\n' $'backlog_subsystem=retired-adr0031\nwork_queue=0\nreframe_queue=0\nprior_failures=0\nscout_last_walk_iso=\nscout_board_open_enhancements=0\nscout_tokens_today=0\nscout_spend_usd_today=0.00\narch_last_run_iso=\norch_backfill_idle=false\narch_board_open_scan=0\narch_board_open_enhancements=0\narch_board_saturated=false\ncleanup_board_open_scan=0\ncleanup_board_saturated=false\nskill_prune_board_open=0\nskill_prune_board_saturated=false\norch_board_signals_degraded=true\nhitl_grill_open=0\nhitl_grill_saturated=true'
fi
[ -n "$ts_exports" ] && rm -f "$ts_exports"
return 0
}

# Target scan-board signals + risk surface (issues #2722, #2739, #3478, #3710,
# #3726, #3729, #3973, #4130, #4411, #4528) — moved whole to the Turn Snapshot
# `target-scan-boards` and `target-risk-surface` collectors
# (src/autopilot/turn-snapshot/target-scan-boards.ts / target-risk-surface.ts,
# ADR-0043 slice 4, issue #4932): target_backfill_idle, the cleanup /
# wire-or-retire / design-QA gates, the advisory truncation / degradation /
# unlabelled / adr_present keys, and target_risk_surface_json (the Target
# Manifest via print-target-facts.ts's collectTargetFacts, imported — not
# shelled to). It takes the lane-degraded accumulator from
# collect_turn_snapshot_target_board and the work-queue length from
# collect_turn_snapshot_boards ($ARCH_WORK_QUEUE). FAIL-CLOSED: if the CLI
# itself cannot run, every gate prints its suppressing default and the risk
# surface reads ok:false (decide.py withholds wire_or_retire_target).
collect_turn_snapshot_target_scan() {
local ts_out=""
if ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
       --collectors target-scan-boards,target-risk-surface --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT" \
       --target-lane-degraded "${TARGET_LANE_DEGRADED:-1}" --target-work-queue "${ARCH_WORK_QUEUE:-0}") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
else
  echo "target turn-snapshot scan-board CLI failed or produced no output — emitting the fail-closed scan-board + risk-surface fallback (issue #4932)" >&2
  printf '%s\n' $'target_board_signals_degraded=true\ntarget_board_signals_truncated=false\ntarget_needs_triage_items=\ntarget_backfill_idle=false\ntarget_cleanup_board_open_scan=0\ntarget_cleanup_board_saturated=true\nwire_or_retire_target_triage=0\nwire_or_retire_target_available=false\nwire_or_retire_target_unlabelled=0\ndesign_qa_target_open=0\ndesign_qa_target_saturated=true\ndesign_qa_target_adr_present=false\ndesign_qa_target_due=false\ntarget_risk_surface_json={"ok":false,"errors":["target_risk_surface_json: turn-snapshot CLI unreachable"]}'
fi
return 0
}

# RETRO + WAYFINDER FRONTIER + TICKETS — Turn Snapshot collectors (ADR-0043
# slice 5B, issue #4933). collect_retro, collect_wayfinder_frontier and
# collect_tickets (and their heredocs) are now the typed `retro`,
# `wayfinder-frontier` and `tickets` collectors in
# src/autopilot/turn-snapshot/afk-frontier.ts, rendered byte-identically by
# render-kv-remaining.ts (golden files under test/fixtures/turn-snapshot/remaining/).
# The pre-resolution decide.py stays too pure to do (#920, #3871, #4244, #4584;
# #3351, #3354, #3400, ADR-0029; #4014) is unchanged; the module docblock
# carries the rules. Every failure still degrades in each signal's documented
# direction (retro_run_available=false, retro_run_drillable=true on a failed
# bundle read, wayfinder/tickets suppressed).
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note.
collect_turn_snapshot_afk_frontier() {
local ts_out=""
if ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors retro,wayfinder-frontier,tickets --format kv --gh-list-limit "$GH_ISSUE_LIST_LIMIT") \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
else
  echo "orch turn-snapshot retro/wayfinder/tickets CLI failed or produced no output — emitting the fail-open fallback (issue #4933)" >&2
  printf '%s\n' $'retro_run_available=false\nretro_run_drillable=false\nwayfinder_orch_frontier=none\nwayfinder_orch_ticket_type=\nwayfinder_orch_inflight_global=0\ntickets_available=false\ntickets_orch_pending_spec=none'
fi
return 0
}

# DATA-PLANE PASSTHROUGHS — Turn Snapshot collectors (ADR-0043 slice 5,
# issue #4933). collect_scout_alerts, collect_realm_share,
# collect_usage_eligibility, collect_emergency_brake, collect_class_stats,
# collect_capacity, collect_scheduler, collect_recommendations and
# collect_slot_events (and their heredocs) are now typed collectors in
# src/autopilot/turn-snapshot/passthrough.ts, read through the injected hydra
# HTTP client (`hydra raw GET` semantics) and rendered byte-identically by
# render-kv-passthrough.ts (golden files under
# test/fixtures/turn-snapshot/passthrough/). The module docblock carries each
# signal's rules and the issues behind them (#486, #4161, #744, #2943, #4298,
# #509, #4510). The slot-events cursor still comes from
# HYDRA_AUTOPILOT_SLOT_EVENTS_LAST_ID / HYDRA_AUTOPILOT_SLOT_EVENTS_COUNT
# (turn.sh), which the CLI reads from its environment.
# FAIL-OPEN: if the CLI cannot run, print the all-reads-failed lines + a note.
collect_turn_snapshot_passthrough() {
local ts_out=""
if ts_out=$(node --no-warnings --experimental-strip-types "$SCRIPT_DIR/turn-snapshot.ts" \
     --collectors scout-alerts,realm-share,usage-eligibility,emergency-brake,class-stats,capacity,scheduler,recommendations,slot-events \
     --format kv) \
  && [ -n "$ts_out" ]; then
  printf '%s\n' "$ts_out"
else
  echo "orch turn-snapshot passthrough CLI failed or produced no output — emitting the fail-open fallback (issue #4933)" >&2
  printf '%s\n' $'scout_alert_eligible_count=0\n0\norch_realm_weekly_share=unavailable\nusage_eligibility_json={"allow":true,"shed":[],"reasons":{"calibrated":false}}\nemergency_brake_json={"engaged":false}\nclass_stats_json={"scoreboard":{"classes":[]},"shadow":{"verdicts":[]}}\ncapacity_floor_met=None capacity_floor_status=unmeasured capacity_window=0\nCODEX_IDLE\nscheduler=unknown stall=unknown\nrecommendations=unavailable\nslot_events_json={"events": [], "last_id": null}'
fi
return 0
}

# Run every collector in the order that defines the emitted key=value stream.
main() {
  collect_turn_snapshot_health
  collect_turn_snapshot_orch_board
  collect_turn_snapshot_target_board
  collect_turn_snapshot_orphans_needs_qa
  collect_turn_snapshot_pr_gate_and_picks
  collect_turn_snapshot_boards
  collect_turn_snapshot_target_scan
  collect_turn_snapshot_afk_frontier
  collect_turn_snapshot_passthrough
}

# Execute main only when run (bash collect-state.sh), never when sourced.
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  main "$@"
fi
