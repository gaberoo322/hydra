#!/usr/bin/env bash
#
# glm-beachhead-report.sh — GLM dev-drainer beachhead measurement + informational
# keep/kill/expand readout (issue #3690, ADR-0032 Decision 6).
#
# ADR-0032 Decision 6 gives the GLM dev-drainer worker lane a ~2-week / ~25-PR
# keep-or-kill window, judged by the OPERATOR from three signals: whether the
# lane is actually relieving Anthropic subscription quota (percentLast7d),
# whether GLM's output holds up under review (first-pass QA PASS-rate), and
# whether it produces unusually thrashy diffs relative to Opus dev_orch
# (churn-vs-baseline). This script computes all three plus a window-progress
# readout, folds them into a single recommendation string, and prints ONE
# line to stdout. `hydra-review` (docs/operator-playbooks/hydra-review.md)
# runs this script and surfaces that line verbatim.
#
# HARD INVARIANT (design-concept artifact, issue #3690, ADR-0032 #3671):
# this script NEVER writes a label, NEVER touches the autopilot decision
# loop's source (scripts/autopilot/ is out of scope for this issue), NEVER
# disables the drainer, and NEVER takes any action beyond printing text +
# bootstrapping its own read-only baseline file. Keep-or-kill/expand stays an
# OPERATOR JUDGMENT. The recommendation string is advisory prose only — no
# caller may treat it as a command.
#
# Two DIFFERENT "day-0" anchors are deliberately kept separate:
#   - The WINDOW clock (elapsed days + PR count vs the ~2wk/~25-PR target) is
#     anchored to the EARLIEST glm-authored PR's `createdAt` — the drainer's
#     actual first output, wherever this script happens to be run for the
#     first time. Anchoring the window to this script's own first-run moment
#     instead would silently reset the clock to zero on every fresh checkout
#     of this report (e.g. running it days after the drainer already shipped
#     15 PRs), which is not what "a ~2-week/~25-PR window" means. Falls back
#     to the baseline bootstrap moment (below) only when there are zero
#     glm-authored PRs yet — nothing else to anchor on.
#   - The BASELINE snapshot (percentLast7d + weeklyResetAnchor + churn, for
#     quota-relief / churn comparisons) is
#     captured once at THIS SCRIPT's first run, per the design-concept's own
#     wording ("bootstrapped ... on first run if absent") — a practical
#     bootstrap timing for a comparison point, independent of the window
#     clock above.
#
# Metrics (definitions pinned by the approved design-concept artifact):
#   - Window progress: elapsed days since the window day-0 (earliest
#     glm-authored PR) vs WINDOW_DAYS (default 14), and total glm-authored PR
#     count vs WINDOW_PRS (default 25). This is a progress readout, not a
#     hard gate — nothing in this script blocks, throttles, or disables
#     anything when the window completes; it only changes the wording of the
#     printed recommendation string.
#   - percentLast7d quota-relief: current live reading (GET
#     /api/usage/eligibility, `.usage.percentLast7d`) vs the baseline-snapshot
#     value, captured once at this script's first run and never silently
#     overwritten (an operator wanting to reset the baseline deletes the
#     baseline file by hand). percentLast7d is NOT a trailing average — it is
#     a POSITION within a window that resets weekly (src/cost/ assigns
#     percentSinceReset = percentLast7d), so two readings taken at different
#     phases of different windows must never be subtracted raw (issue #4049:
#     a day-1 reading vs a day-2.4 baseline read as "relief" of roughly 2x
#     the honest magnitude; a day-6-vs-day-1 pair inverts the sign). The
#     quota-relief figure is therefore a RELIEF RATE comparison: each reading
#     is divided by its own days-into-window — computed from
#     `.usage.weeklyResetAnchor` on the SAME eligibility response (captured
#     into the baseline at bootstrap as weeklyResetAnchorBaseline, because
#     the window that was live at bootstrap can never be reconstructed
#     later) — i.e. %/day, current vs baseline, plus the relative change.
#     The report prints days-into-window for BOTH readings so a phase
#     mismatch is visible instead of hidden, and prints an explicit
#     "not comparable" state instead of a number when window-position data
#     is missing (a legacy baseline.json predating window-tracking — the
#     operator lever is still: delete the baseline file) or too shallow
#     (either reading under MIN_WINDOW_DAYS, ~2.4h — dividing by less
#     manufactures a spike out of noise). Naming note: CONTEXT.md's Pacing
#     Curve entry reserves the obvious rate-shaped two-word name for a
#     different, cumulative concept; this window-relative metric is called
#     "relief rate" (%/day) and never that name. This script deliberately
#     never reads or reports the CLI's per-run USD-cost field for GLM
#     runs — the CLI prices GLM tokens against the Anthropic price table,
#     which is meaningless for z.ai's flat-rate plan (ADR-0032 #3758
#     amendment); percentLast7d is the only quota-relief signal used.
#   - First-pass QA PASS-rate: across ALL glm-authored PRs (state=all, no
#     day-0 filter — a running quality signal, not a windowed one), the FIRST
#     "> *Automated QA" comment's **Verdict:** line. PASS / PASS-pending-CI
#     counts as a pass; FAIL / FAIL-pending-CI counts as a FAIL-bounce even if
#     a later re-review passed. A PR with no QA-verdict comment yet is
#     excluded from the denominator, not counted as a fail.
#   - Churn-vs-baseline: mean (additions+deletions) across ALL glm-authored
#     PRs, divided by a baseline mean captured ONCE at bootstrap from the most
#     recent non-glm-authored MERGED PRs (an "is GLM producing unusually
#     large/thrashy diffs relative to Opus dev_orch" signal, not an absolute
#     threshold).
#
# Recommendation heuristic (informational only — see hard invariant above):
#   - No glm-authored PRs yet -> "insufficient-data".
#   - First-pass PASS-rate < 0.5 -> lean KILL regardless of window completion
#     (a bad quality signal doesn't need two weeks to prove itself).
#   - Window complete (days-elapsed >= WINDOW_DAYS OR PR-count >= WINDOW_PRS)
#     AND PASS-rate >= 0.8 AND churn ratio <= 1.3 (or no baseline sample) ->
#     lean EXPAND.
#   - Window complete but mixed signal -> KEEP, re-evaluate next window.
#   - Window still in progress and no kill signal -> KEEP, no action needed
#     yet.
#
# Testability hooks (mirrors scripts/glm/drainer-loop.sh's style):
#   HYDRA_GLM_BEACHHEAD_REPO            default gaberoo322/hydra
#   HYDRA_GLM_BEACHHEAD_USAGE_URL        default http://localhost:4000/api/usage/eligibility
#   HYDRA_GLM_BEACHHEAD_BASELINE_FILE    default $HOME/.local/state/hydra-glm/baseline.json
#   HYDRA_GLM_BEACHHEAD_WINDOW_DAYS      default 14
#   HYDRA_GLM_BEACHHEAD_WINDOW_PRS       default 25
#   HYDRA_GLM_BEACHHEAD_BASELINE_SAMPLE  default 20 (recent merged non-glm PRs sampled for churn baseline)
#   HYDRA_GLM_BEACHHEAD_NOW_EPOCH        override "now" (unix seconds) for deterministic tests
#
# Sourceable for tests (test/glm-beachhead-report.test.mts) without running main.

set -uo pipefail

GLM_LABEL_AUTHORED="glm-authored"
REPO="${HYDRA_GLM_BEACHHEAD_REPO:-gaberoo322/hydra}"
USAGE_URL="${HYDRA_GLM_BEACHHEAD_USAGE_URL:-http://localhost:4000/api/usage/eligibility}"
BASELINE_FILE="${HYDRA_GLM_BEACHHEAD_BASELINE_FILE:-$HOME/.local/state/hydra-glm/baseline.json}"
WINDOW_DAYS="${HYDRA_GLM_BEACHHEAD_WINDOW_DAYS:-14}"
WINDOW_PRS="${HYDRA_GLM_BEACHHEAD_WINDOW_PRS:-25}"
BASELINE_SAMPLE="${HYDRA_GLM_BEACHHEAD_BASELINE_SAMPLE:-20}"
NOW_EPOCH="${HYDRA_GLM_BEACHHEAD_NOW_EPOCH:-$(date -u +%s)}"
# Floor on days-into-window below which a %/days division is noise, not
# signal (issue #4049): a reading taken less than ~2.4h into its weekly
# window yields a relief "rate" that says more about sampling luck than
# quota consumption, so the report prints not-comparable instead.
MIN_WINDOW_DAYS=0.1

log() {
  # STDERR, deliberately — several functions below return a value via stdout
  # captured through `$(...)`; a log() line on stdout would corrupt that
  # value (same lesson as scripts/glm/drainer-loop.sh's log()).
  echo "hydra-glm-beachhead: $*" >&2
}

# ---------------------------------------------------------------------------
# Pure helpers (unit-tested directly by sourcing this script)
# ---------------------------------------------------------------------------

iso_to_epoch() { # <iso8601>
  date -u -d "$1" +%s 2>/dev/null || echo ""
}

elapsed_days() { # <epoch_then> <epoch_now>
  local then="$1" now="$2"
  if [[ -z "$then" || -z "$now" ]]; then
    echo 0
    return 0
  fi
  echo $(( (now - then) / 86400 ))
}

# classify_qa_verdict <comment_body> -> pass|fail|unknown
# Reads the `**Verdict:** \`<token>\`` line hydra-qa / code-review posts
# (confirmed live shape on PR #3773). PASS/PASS-pending-CI -> pass;
# FAIL/FAIL-pending-CI -> fail; anything else (or absent) -> unknown.
classify_qa_verdict() {
  local body="$1"
  local verdict
  verdict=$(printf '%s' "$body" | grep -o '\*\*Verdict:\*\* `[A-Za-z-]*`' | head -1 \
    | sed -E 's/.*`([A-Za-z-]*)`.*/\1/')
  case "$verdict" in
    PASS|PASS-pending-CI) echo "pass" ;;
    FAIL|FAIL-pending-CI) echo "fail" ;;
    *) echo "unknown" ;;
  esac
}

# avg <n1> <n2> ... -> mean formatted to 2dp; empty string if no args.
avg() {
  if [[ $# -eq 0 ]]; then
    echo ""
    return 0
  fi
  local sum=0 n
  for n in "$@"; do
    sum=$(awk -v a="$sum" -v b="$n" 'BEGIN{printf "%.6f", a+b}')
  done
  awk -v s="$sum" -v c="$#" 'BEGIN{printf "%.2f", s/c}'
}

# ratio <a> <b> -> a/b to 2dp; empty string if a or b is empty/zero/non-numeric.
ratio() {
  local a="${1:-}" b="${2:-}"
  if [[ -z "$a" || -z "$b" ]]; then
    echo ""
    return 0
  fi
  awk -v a="$a" -v b="$b" 'BEGIN{ if (b+0==0) { print ""; exit } printf "%.2f", a/b }'
}

# days_into_window <anchor_epoch> <now_epoch> -> fractional days (2dp) that
# the <now_epoch> reading sits after the weekly reset anchor; empty string
# when either epoch is empty or now is at/before the anchor (a window
# position outside the window is not comparable, never a negative rate).
days_into_window() {
  local anchor="$1" now="$2"
  if [[ -z "$anchor" || -z "$now" ]]; then
    echo ""
    return 0
  fi
  awk -v a="$anchor" -v n="$now" \
    'BEGIN{ d = (n - a) / 86400; if (d <= 0) { print ""; exit } printf "%.2f", d }'
}

# rate_per_day <percent> <days_2dp> -> percent divided by days-into-window,
# 2dp; empty string when either input is empty/"null" or days is zero.
rate_per_day() {
  local percent="${1:-}" days="${2:-}"
  if [[ -z "$percent" || "$percent" == "null" || -z "$days" ]]; then
    echo ""
    return 0
  fi
  awk -v p="$percent" -v d="$days" 'BEGIN{ if (d+0==0) { print ""; exit } printf "%.2f", p/d }'
}

# relief_description <base_anchor> <base_days> <cur_anchor> <cur_days> \
#                    <base_percent> <cur_percent> <min_days>
# -> "rate <cur>%/day vs baseline <base>%/day (<pct>%)" when both readings
# carry usable window-position data, else an explicit "not comparable (...)"
# naming which side failed and why. percentLast7d readings taken at
# different phases of different weekly windows are never subtracted raw
# (issue #4049) — each is first normalised to %/day by its own
# days-into-window.
relief_description() {
  local base_anchor="${1:-}" base_days="${2:-}" cur_anchor="${3:-}" cur_days="${4:-}"
  local base_percent="${5:-}" cur_percent="${6:-}" min_days="${7:-}"

  if [[ -z "$base_anchor" ]]; then
    echo "not comparable (baseline predates window-tracking -- delete the baseline file to re-bootstrap)"
    return 0
  fi
  if [[ -z "$cur_anchor" ]]; then
    echo "not comparable (no weeklyResetAnchor on the live usage response)"
    return 0
  fi
  if [[ -z "$base_days" ]]; then
    echo "not comparable (baseline snapshot sits at or before its weekly reset anchor)"
    return 0
  fi
  if [[ -z "$cur_days" ]]; then
    echo "not comparable (current reading sits at or before its weekly reset anchor)"
    return 0
  fi
  if [[ -z "$base_percent" || "$base_percent" == "null" ]] || [[ -z "$cur_percent" || "$cur_percent" == "null" ]]; then
    echo "not comparable (missing percentLast7d reading)"
    return 0
  fi
  if awk -v d="$base_days" -v m="$min_days" 'BEGIN{exit !(d+0 < m+0)}'; then
    echo "not comparable (insufficient time into window at baseline: ${base_days}d)"
    return 0
  fi
  if awk -v d="$cur_days" -v m="$min_days" 'BEGIN{exit !(d+0 < m+0)}'; then
    echo "not comparable (insufficient time into window now: ${cur_days}d)"
    return 0
  fi

  local base_rate cur_rate
  base_rate="$(rate_per_day "$base_percent" "$base_days")"
  cur_rate="$(rate_per_day "$cur_percent" "$cur_days")"
  if [[ -z "$base_rate" || -z "$cur_rate" ]]; then
    echo "not comparable (window-position arithmetic failed)"
    return 0
  fi
  awk -v c="$cur_rate" -v b="$base_rate" \
    'BEGIN{
       tail = ""
       if (b+0 != 0) { tail = sprintf(" (%+.0f%%)", (c/b - 1) * 100) }
       printf "rate %s%%/day vs baseline %s%%/day%s", c, b, tail
     }'
}

# fmt_days <days_2dp_or_empty> -> "<n>d" for display, or "n/a" when empty.
fmt_days() {
  local d="${1:-}"
  if [[ -z "$d" ]]; then
    echo "n/a"
  else
    echo "${d}d"
  fi
}

# recommend <pr_count_since_day0> <pass_rate_or_empty> <churn_ratio_or_empty> \
#           <days_elapsed> <window_days> <pr_target> <relief_or_empty>
# Informational prose only — see the hard invariant in the file header. No
# caller may treat this as a command; it is text for the operator to read.
# The 7th arg (issue #4049) carries the phase-normalised quota-relief
# description and is appended as TRAILING TEXT to whichever branch string
# fires — deliberately never a branch condition of its own (the
# keep/kill/expand thresholds are out of scope for #4049 and unchanged).
recommend() {
  local pr_count="$1" pass_rate="$2" churn_ratio="$3"
  local days_elapsed="$4" window_days="$5" pr_target="$6"
  local relief="${7:-}"
  local out=""

  if [[ "$pr_count" -eq 0 ]]; then
    out="insufficient-data (no glm-authored PRs since day-0 yet -- nothing to judge)"
  elif [[ -n "$pass_rate" ]] && awk -v p="$pass_rate" 'BEGIN{exit !(p<0.5)}'; then
    out="KILL-signal (informational, operator-driven) -- first-pass PASS-rate ${pass_rate} is below 0.5; quality signal is bad independent of window completion"
  else
    local window_complete="false"
    if [[ "$days_elapsed" -ge "$window_days" ]] || [[ "$pr_count" -ge "$pr_target" ]]; then
      window_complete="true"
    fi

    if [[ "$window_complete" == "true" ]]; then
      local churn_ok="true"
      if [[ -n "$churn_ratio" ]] && ! awk -v c="$churn_ratio" 'BEGIN{exit !(c<=1.3)}'; then
        churn_ok="false"
      fi
      if [[ -n "$pass_rate" ]] && awk -v p="$pass_rate" 'BEGIN{exit !(p>=0.8)}' && [[ "$churn_ok" == "true" ]]; then
        out="EXPAND-signal (informational, operator-driven) -- window complete (${days_elapsed}/${window_days}d, ${pr_count}/${pr_target} PRs), PASS-rate ${pass_rate} >= 0.8, churn ratio ${churn_ratio:-n/a} within bound"
      else
        out="KEEP (informational, operator-driven) -- window complete (${days_elapsed}/${window_days}d, ${pr_count}/${pr_target} PRs) but mixed signal (PASS-rate ${pass_rate:-n/a}, churn ratio ${churn_ratio:-n/a}); re-evaluate at next window"
      fi
    else
      out="KEEP (informational, operator-driven) -- window in progress (${days_elapsed}/${window_days}d, ${pr_count}/${pr_target} PRs); no action needed yet"
    fi
  fi

  if [[ -n "$relief" ]]; then
    out="${out}; quota-relief: ${relief}"
  fi
  echo "$out"
}

# ---------------------------------------------------------------------------
# Data gathering — gh/curl fetch RAW json only; all filtering/math is jq/awk
# above/below, never gh's own --jq (keeps every gh call fakeable in tests
# with a plain JSON-serving stub, mirrors test/autopilot-recover-stale.test.mts).
# ---------------------------------------------------------------------------

require_tools() {
  local t
  for t in gh jq curl awk; do
    if ! command -v "$t" >/dev/null 2>&1; then
      log "ERROR required tool '$t' not found"
      return 1
    fi
  done
  return 0
}

# fetch_usage_percent_and_anchor -> "<percentLast7d>|<weeklyResetAnchor>"
# ONE curl for both quota-window fields; either side empty when absent from
# the response or unreachable. weeklyResetAnchor is what makes a percentLast7d
# reading's phase inside its weekly window computable (issue #4049) — the
# percent alone is not a trailing average and is not raw-comparable across
# windows.
fetch_usage_percent_and_anchor() {
  local json
  if ! json=$(curl -fsS --max-time 10 "$USAGE_URL" 2>/dev/null); then
    echo "|"
    return 0
  fi
  jq -r '[(.usage.percentLast7d // ""), (.usage.weeklyResetAnchor // "")] | join("|")' <<<"$json" 2>/dev/null || echo "|"
}

# fetch_baseline_churn_sample -> "<avg>|<sampleSize>"
# Samples the most recent BASELINE_SAMPLE merged PRs that do NOT carry
# glm-authored, as the "is GLM thrashier than Opus dev_orch" baseline.
fetch_baseline_churn_sample() {
  local rows
  rows=$(gh pr list --repo "$REPO" --state merged --json additions,deletions,labels --limit 100 2>/dev/null || echo "[]")
  local nums arr=()
  nums=$(jq -r --arg label "$GLM_LABEL_AUTHORED" --argjson n "$BASELINE_SAMPLE" \
    '[.[] | select((.labels | map(.name) | index($label)) | not) | (.additions + .deletions)][:$n][]' \
    <<<"$rows" 2>/dev/null)
  while IFS= read -r n; do
    [[ -n "$n" ]] && arr+=("$n")
  done <<<"$nums"
  echo "$(avg "${arr[@]}")|${#arr[@]}"
}

fetch_glm_authored_prs() {
  gh pr list --repo "$REPO" --label "$GLM_LABEL_AUTHORED" --state all \
    --json number,createdAt,additions,deletions --limit 100 2>/dev/null || echo "[]"
}

# window_day0_epoch_from_rows <rows_json> <fallback_epoch> -> the earliest
# glm-authored PR's createdAt as an epoch, or <fallback_epoch> when rows is
# empty (nothing to anchor on yet — see the file header's two-anchors note).
window_day0_epoch_from_rows() {
  local rows="$1" fallback_epoch="$2"
  local earliest_iso
  earliest_iso=$(jq -r '[.[].createdAt] | sort | .[0] // ""' <<<"$rows" 2>/dev/null)
  if [[ -z "$earliest_iso" ]]; then
    echo "$fallback_epoch"
    return 0
  fi
  local epoch
  epoch=$(iso_to_epoch "$earliest_iso")
  if [[ -z "$epoch" ]]; then
    echo "$fallback_epoch"
  else
    echo "$epoch"
  fi
}

churn_avg_from_rows() { # <rows_json> -> avg additions+deletions
  local rows="$1"
  local nums arr=()
  nums=$(jq -r '.[] | (.additions + .deletions)' <<<"$rows" 2>/dev/null)
  while IFS= read -r n; do
    [[ -n "$n" ]] && arr+=("$n")
  done <<<"$nums"
  avg "${arr[@]}"
}

first_pass_verdict_for_pr() { # <pr_number> -> pass|fail|unknown|no-verdict
  local pr="$1"
  local json first_body
  json=$(gh pr view "$pr" --repo "$REPO" --json comments 2>/dev/null || echo '{"comments":[]}')
  first_body=$(jq -r \
    '[.comments[] | select(.body | startswith("> *Automated QA"))] | sort_by(.createdAt) | .[0].body // ""' \
    <<<"$json" 2>/dev/null)
  if [[ -z "$first_body" ]]; then
    echo "no-verdict"
    return 0
  fi
  classify_qa_verdict "$first_body"
}

# first_pass_pass_rate <rows_json> -> "<rate_or_empty>|<pass>|<fail>|<denom>"
first_pass_pass_rate() {
  local rows="$1"
  local numbers pass=0 fail=0 n verdict
  numbers=$(jq -r '.[].number' <<<"$rows" 2>/dev/null)
  while IFS= read -r n; do
    [[ -z "$n" ]] && continue
    verdict="$(first_pass_verdict_for_pr "$n")"
    case "$verdict" in
      pass) pass=$((pass + 1)) ;;
      fail) fail=$((fail + 1)) ;;
      *) ;; # no-verdict / unknown -- excluded from the denominator, not a fail
    esac
  done <<<"$numbers"
  local denom=$((pass + fail))
  if [[ "$denom" -eq 0 ]]; then
    echo "|${pass}|${fail}|${denom}"
    return 0
  fi
  echo "$(awk -v p="$pass" -v d="$denom" 'BEGIN{printf "%.2f", p/d}')|${pass}|${fail}|${denom}"
}

# bootstrap_or_load_baseline -> prints the baseline JSON (creating it once,
# NEVER overwriting an existing file — an operator wanting to reset the
# window deletes the file explicitly).
bootstrap_or_load_baseline() {
  if [[ -s "$BASELINE_FILE" ]]; then
    cat "$BASELINE_FILE"
    return 0
  fi
  log "no baseline at $BASELINE_FILE -- bootstrapping day-0 now"
  mkdir -p "$(dirname "$BASELINE_FILE")" 2>/dev/null || true

  local usage_line percent anchor percent_json
  usage_line="$(fetch_usage_percent_and_anchor)"
  percent="${usage_line%%|*}"
  anchor="${usage_line##*|}"
  if [[ -z "$percent" ]]; then
    percent_json="null"
  else
    percent_json="$percent"
  fi

  local churn_sample churn_avg churn_n churn_json
  churn_sample="$(fetch_baseline_churn_sample)"
  churn_avg="${churn_sample%%|*}"
  churn_n="${churn_sample##*|}"
  if [[ -z "$churn_avg" ]]; then
    churn_json="null"
  else
    churn_json="$churn_avg"
  fi

  local day0_iso
  day0_iso="$(date -u -d "@${NOW_EPOCH}" +%Y-%m-%dT%H:%M:%SZ)"

  jq -n \
    --arg day0 "$day0_iso" \
    --argjson percent "$percent_json" \
    --arg anchor "$anchor" \
    --argjson churnAvg "$churn_json" \
    --argjson churnN "${churn_n:-0}" \
    '{day0: $day0, percentLast7dBaseline: $percent, weeklyResetAnchorBaseline: (if $anchor == "" then null else $anchor end), churnBaseline: $churnAvg, churnSampleSize: $churnN}' \
    > "$BASELINE_FILE"
  cat "$BASELINE_FILE"
}

display() { # <value> -> value, or "n/a" for empty/null
  local v="${1:-}"
  if [[ -z "$v" || "$v" == "null" ]]; then
    echo "n/a"
  else
    echo "$v"
  fi
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  if ! require_tools; then
    echo "GLM beachhead: ERROR required tools (gh/jq/curl/awk) unavailable -- cannot compute report"
    exit 0
  fi

  local baseline_json
  baseline_json="$(bootstrap_or_load_baseline)"

  local baseline_day0_iso baseline_day0_epoch baseline_percent baseline_churn baseline_anchor
  baseline_day0_iso=$(jq -r '.day0' <<<"$baseline_json" 2>/dev/null)
  baseline_day0_epoch=$(iso_to_epoch "$baseline_day0_iso")
  baseline_percent=$(jq -r '.percentLast7dBaseline' <<<"$baseline_json" 2>/dev/null)
  baseline_churn=$(jq -r '.churnBaseline' <<<"$baseline_json" 2>/dev/null)
  # Empty for a legacy baseline bootstrapped before window-tracking (issue
  # #4049) — the report degrades to an explicit not-comparable, never a
  # crash and never a silent migration of the file.
  baseline_anchor=$(jq -r '.weeklyResetAnchorBaseline // ""' <<<"$baseline_json" 2>/dev/null)

  local usage_line current_percent current_anchor
  usage_line="$(fetch_usage_percent_and_anchor)"
  current_percent="${usage_line%%|*}"
  current_anchor="${usage_line##*|}"

  # Quota relief, phase-normalised (issue #4049): each percentLast7d reading
  # is a POSITION within a weekly window, so each is divided by its own
  # days-into-window (baseline: bootstrap moment vs its captured anchor;
  # current: now vs the live anchor) and the rates are compared — never a
  # raw subtraction of the two percents.
  local baseline_anchor_epoch current_anchor_epoch baseline_days current_days relief
  baseline_anchor_epoch=$(iso_to_epoch "$baseline_anchor")
  current_anchor_epoch=$(iso_to_epoch "$current_anchor")
  baseline_days=$(days_into_window "$baseline_anchor_epoch" "$baseline_day0_epoch")
  current_days=$(days_into_window "$current_anchor_epoch" "$NOW_EPOCH")
  relief=$(relief_description "$baseline_anchor" "$baseline_days" "$current_anchor" "$current_days" \
    "$baseline_percent" "$current_percent" "$MIN_WINDOW_DAYS")

  local rows
  rows="$(fetch_glm_authored_prs)"
  local pr_count_total
  pr_count_total=$(jq -r 'length' <<<"$rows" 2>/dev/null || echo 0)

  # Window clock: anchored to the earliest glm-authored PR, NOT the baseline
  # bootstrap moment above (see the file header's two-anchors note).
  local window_day0_epoch days_elapsed
  window_day0_epoch=$(window_day0_epoch_from_rows "$rows" "$baseline_day0_epoch")
  days_elapsed=$(elapsed_days "$window_day0_epoch" "$NOW_EPOCH")

  local churn_current churn_ratio=""
  churn_current=$(churn_avg_from_rows "$rows")
  if [[ "$baseline_churn" != "null" ]]; then
    churn_ratio=$(ratio "$churn_current" "$baseline_churn")
  fi

  local pass_line pass_rate pass_n fail_n denom
  pass_line=$(first_pass_pass_rate "$rows")
  IFS='|' read -r pass_rate pass_n fail_n denom <<<"$pass_line"

  local rec
  rec=$(recommend "$pr_count_total" "$pass_rate" "$churn_ratio" "$days_elapsed" "$WINDOW_DAYS" "$WINDOW_PRS" "$relief")

  local excluded_n=$((pr_count_total - denom))

  printf 'GLM beachhead: window %s/%sd, %s/%s PRs | first-pass PASS-rate %s (%s pass, %s fail, %s excluded no-verdict, of %s total) | percentLast7d %s%% (baseline %s%%, days-into-window current %s / baseline %s; relief %s) | churn avg %s vs baseline %s (ratio %s) | recommendation: %s\n' \
    "$days_elapsed" "$WINDOW_DAYS" "$pr_count_total" "$WINDOW_PRS" \
    "$(display "$pass_rate")" "$pass_n" "$fail_n" "$excluded_n" "$pr_count_total" \
    "$(display "$current_percent")" "$(display "$baseline_percent")" \
    "$(fmt_days "$current_days")" "$(fmt_days "$baseline_days")" "$relief" \
    "$(display "$churn_current")" "$(display "$baseline_churn")" "$(display "$churn_ratio")" \
    "$rec"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
