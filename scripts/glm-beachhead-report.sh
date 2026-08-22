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
# A FAILED gh query aborts the whole report loud — stderr diagnostic quoting
# gh's own error text, ONE stdout ERROR line, exit 1 — BEFORE any metric
# renders: a numeric readout built on a masked "[]" is a wrong answer that
# reads as a confident one (issue #4128). A genuinely EMPTY result set (query
# succeeds, zero rows) still renders normally via insufficient-data; the two
# cases are never conflated.
#
# HARD INVARIANT (design-concept artifact, issue #3690, ADR-0032 #3671):
# this script NEVER writes a label, NEVER touches the autopilot decision
# loop's source (scripts/autopilot/ is out of scope for this issue), NEVER
# disables the drainer, and NEVER takes any action beyond printing text +
# bootstrapping its own read-only baseline file. Keep-or-kill/expand stays an
# OPERATOR JUDGMENT. The recommendation string is advisory prose only — no
# caller may treat it as a command.
#
# Provenance of "a drainer PR" (issue #4048): glm-authored label (PRIMARY,
# ADR-0032 Decision 5) OR head branch matching the drainer's exact literal
# `worktree-agent-glm-` prefix (FALLBACK). `gh pr create` and its separate
# `--label glm-authored` mutation are not atomic (drainer-loop.sh's #3900
# investigation note), so the label alone silently dropped 29 of 62 drainer
# PRs (measured live 2026-08-13) and this report judged the lane on 53% of
# its output. The prefix is a perfect discriminator because the drainer
# builds `worktree-agent-glm-${issue}-${ts}` while Opus dev_orch harness
# branches are `worktree-agent-<hex-hash>-...` and a hex hash cannot contain
# g or l. The report line prints both side counts so a widening
# label-vs-branch gap stays visible. Still READ-ONLY — this widens the
# measurement query only.
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
#   - The BASELINE snapshot (percentLast7d + churn, for delta comparisons) is
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
#   - Quota relief (issue #4049): percentLast7d is a POSITION within a window
#     that resets weekly, not a trailing average — src/cost/eligibility-usage.ts
#     assigns percentSinceReset = percentLast7d — so a raw subtraction of two
#     readings taken at different phases of their respective windows measures
#     sampling phase as much as quota relief. The report instead normalises
#     each reading to a window-relative daily-use rate (%/day = percent /
#     days-into-window, with BOTH readings' days-into-window printed so a
#     phase mismatch is visible), and compares THOSE. The current reading's
#     phase comes from the live eligibility response's `.usage.weeklyResetAnchor`;
#     the baseline's comes from `weeklyResetAnchorBaseline`, frozen into
#     baseline.json at bootstrap alongside the percent it qualifies. When
#     either reading's window position is missing (a legacy pre-#4049
#     baseline.json) or younger than MIN_DAYS_INTO_WINDOW, the report prints
#     "not comparable" instead of a figure. This script deliberately never
#     reads or reports the CLI's per-run USD-cost field for GLM runs — the
#     CLI prices GLM tokens against the Anthropic price table, which is
#     meaningless for z.ai's flat-rate plan (ADR-0032 #3758 amendment);
#     percentLast7d is the only quota-relief signal used.
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
#   HYDRA_GLM_BEACHHEAD_MIN_DAYS_INTO_WINDOW  default 0.5 (a reading younger than this many days
#                                          into its weekly window is "not comparable" — its
#                                          window-relative %/day is still near-totally sampling noise)
#   HYDRA_GLM_BEACHHEAD_NOW_EPOCH        override "now" (unix seconds) for deterministic tests
#
# Sourceable for tests (test/glm-beachhead-report.test.mts) without running main.

set -uo pipefail

GLM_LABEL_AUTHORED="glm-authored"
# Exact literal head-branch prefix the drainer builds in drainer-loop.sh's
# create_worktree(): `worktree-agent-glm-${issue}-${ts}`. The drainer inserts
# its OWN literal `glm` segment after the shared `worktree-agent-` prefix;
# Opus dev_orch harness branches are `worktree-agent-<hex-hash>-...` and a
# hex hash can never contain `g` or `l`, so this prefix discriminates the
# drainer's PRs from Opus ones perfectly (issue #4048). PREFIX-EXACT match
# only — never a loose "contains glm" substring, which would false-match
# e.g. an Opus PR authored for a GLM-lane issue like this very one. The
# label stays PRIMARY (ADR-0032 Decision 5); the prefix is the FALLBACK that
# recovers PRs whose non-atomic `--label` mutation was lost (#3900).
GLM_DRAINER_BRANCH_PREFIX="worktree-agent-glm-"
# ONE jq predicate for "is this PR drainer output?" — carries the label OR
# its head branch carries the drainer prefix — used by BOTH the measurement
# fetch (positively) and the churn-baseline sample (negated), so the report's
# two sides can never disagree on what a GLM PR is (issue #4048, same
# OR-predicate scripts/autopilot/collect-state.sh's GLM partition applies).
# `$label` / `$prefix` are jq --arg bindings supplied at each call site.
GLM_PR_MATCH_JQ='((.labels // []) | map(.name) | index($label)) or ((.headRefName // "") | startswith($prefix))'
REPO="${HYDRA_GLM_BEACHHEAD_REPO:-gaberoo322/hydra}"
USAGE_URL="${HYDRA_GLM_BEACHHEAD_USAGE_URL:-http://localhost:4000/api/usage/eligibility}"
BASELINE_FILE="${HYDRA_GLM_BEACHHEAD_BASELINE_FILE:-$HOME/.local/state/hydra-glm/baseline.json}"
WINDOW_DAYS="${HYDRA_GLM_BEACHHEAD_WINDOW_DAYS:-14}"
WINDOW_PRS="${HYDRA_GLM_BEACHHEAD_WINDOW_PRS:-25}"
BASELINE_SAMPLE="${HYDRA_GLM_BEACHHEAD_BASELINE_SAMPLE:-20}"
MIN_DAYS_INTO_WINDOW="${HYDRA_GLM_BEACHHEAD_MIN_DAYS_INTO_WINDOW:-0.5}"
NOW_EPOCH="${HYDRA_GLM_BEACHHEAD_NOW_EPOCH:-$(date -u +%s)}"

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
  # Empty input MUST yield "" — GNU `date -d ""` succeeds with midnight-today
  # rather than failing, which would fabricate a window anchor out of nothing
  # (issue #4049: 0.47d "into window" on an anchor-less fixture).
  if [[ -z "${1:-}" ]]; then
    echo ""
    return 0
  fi
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

# days_into_window <reading_epoch> <anchor_epoch> -> days between the weekly
# window's reset anchor and the reading, 2dp; "" when either epoch is
# empty/non-numeric or the reading predates its anchor (clock skew never
# fabricates a window phase). Issue #4049.
days_into_window() {
  local reading="${1:-}" anchor="${2:-}"
  if [[ -z "$reading" || -z "$anchor" ]]; then
    echo ""
    return 0
  fi
  awk -v r="$reading" -v a="$anchor" 'BEGIN{
    if (r !~ /^[0-9]+$/ || a !~ /^[0-9]+$/) { print ""; exit }
    d = (r - a) / 86400
    if (d < 0) { print ""; exit }
    printf "%.2f", d
  }'
}

# relief_rate <percent> <days_into_window> -> the window-relative daily-use
# rate in %/day, 1dp; "" on empty/zero/negative/non-numeric input. A within-
# window position only becomes comparable once divided by its own phase
# (issue #4049).
relief_rate() {
  local percent="${1:-}" days="${2:-}"
  if [[ -z "$percent" || -z "$days" ]]; then
    echo ""
    return 0
  fi
  awk -v p="$percent" -v d="$days" 'BEGIN{
    if (p !~ /^[0-9.]+$/ || d !~ /^[0-9.]+$/) { print ""; exit }
    if (d + 0 <= 0) { print ""; exit }
    printf "%.1f", p / d
  }'
}

# relief_figure <baseline_percent> <baseline_days|empty|"null"> \
#               <current_percent> <current_days|empty> <min_days>
#   -> the corrected quota-relief figure for the report line and the
#      recommendation string (issue #4049):
#        "rate 26.9 -> 15.0 %/day (-44% daily use)"
#        "not comparable (<reason>)"
#      NEVER a raw subtraction of the two percent readings — their weekly
#      window phases differ. Percent change is computed from the displayed
#      1dp rates so the printed arithmetic is self-consistent.
relief_figure() {
  local bp="${1:-}" bd="${2:-}" cp="${3:-}" cd="${4:-}" min="${5:-}"
  if [[ -z "$bp" || "$bp" == "null" ]]; then
    echo "not comparable (no baseline percentLast7d snapshot)"
    return 0
  fi
  if [[ -z "$cp" ]]; then
    echo "not comparable (live percentLast7d unavailable)"
    return 0
  fi
  if [[ -z "$bd" ]]; then
    echo "not comparable (baseline days-into-window unknown)"
    return 0
  fi
  if [[ -z "$cd" ]]; then
    echo "not comparable (current days-into-window unknown)"
    return 0
  fi
  if awk -v d="$bd" -v m="$min" 'BEGIN{exit !(d < m)}'; then
    echo "not comparable (baseline only ${bd}d into its window; need >= ${min}d)"
    return 0
  fi
  if awk -v d="$cd" -v m="$min" 'BEGIN{exit !(d < m)}'; then
    echo "not comparable (current only ${cd}d into its window; need >= ${min}d)"
    return 0
  fi
  local base_rate cur_rate pct_change
  base_rate=$(relief_rate "$bp" "$bd")
  cur_rate=$(relief_rate "$cp" "$cd")
  if [[ -z "$base_rate" || -z "$cur_rate" ]]; then
    echo "not comparable (unreadable window-position data)"
    return 0
  fi
  pct_change=$(awk -v b="$base_rate" -v c="$cur_rate" 'BEGIN{printf "%+.0f", (c-b)/b*100}')
  echo "rate ${base_rate} -> ${cur_rate} %/day (${pct_change}% daily use)"
}

# recommend <pr_count_since_day0> <pass_rate_or_empty> <churn_ratio_or_empty> \
#           <days_elapsed> <window_days> <pr_target>
# Informational prose only — see the hard invariant in the file header. No
# caller may treat this as a command; it is text for the operator to read.
recommend() {
  local pr_count="$1" pass_rate="$2" churn_ratio="$3"
  local days_elapsed="$4" window_days="$5" pr_target="$6"

  if [[ "$pr_count" -eq 0 ]]; then
    echo "insufficient-data (no glm-authored PRs since day-0 yet -- nothing to judge)"
    return 0
  fi

  if [[ -n "$pass_rate" ]] && awk -v p="$pass_rate" 'BEGIN{exit !(p<0.5)}'; then
    echo "KILL-signal (informational, operator-driven) -- first-pass PASS-rate ${pass_rate} is below 0.5; quality signal is bad independent of window completion"
    return 0
  fi

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
      echo "EXPAND-signal (informational, operator-driven) -- window complete (${days_elapsed}/${window_days}d, ${pr_count}/${pr_target} PRs), PASS-rate ${pass_rate} >= 0.8, churn ratio ${churn_ratio:-n/a} within bound"
      return 0
    fi
    echo "KEEP (informational, operator-driven) -- window complete (${days_elapsed}/${window_days}d, ${pr_count}/${pr_target} PRs) but mixed signal (PASS-rate ${pass_rate:-n/a}, churn ratio ${churn_ratio:-n/a}); re-evaluate at next window"
    return 0
  fi

  echo "KEEP (informational, operator-driven) -- window in progress (${days_elapsed}/${window_days}d, ${pr_count}/${pr_target} PRs); no action needed yet"
}

# ---------------------------------------------------------------------------
# Data gathering — gh/curl fetch RAW json only; all filtering/math is jq/awk
# above/below, never gh's own --jq (keeps every gh call fakeable in tests
# with a plain JSON-serving stub, mirrors test/autopilot-recover-stale.test.mts).
# A failed gh call inside fetch_glm_authored_prs is NEVER masked as "[]": it
# fails the whole report loud (issue #4128) — a fabricated readout is worse
# than no readout, because it reads as a confident one.
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

# fetch_usage_snapshot -> "<percentLast7d>|<weeklyResetAnchor iso>", either
# side empty when the fetch failed or the field is absent. ONE eligibility
# fetch serves both the relief figure's current reading and the baseline
# bootstrap, so a percent and the window anchor that qualifies it can never
# come from different fetches (issue #4049).
fetch_usage_snapshot() {
  local json
  if ! json=$(curl -fsS --max-time 10 "$USAGE_URL" 2>/dev/null); then
    echo "|"
    return 0
  fi
  local percent anchor
  percent=$(jq -r '.usage.percentLast7d // ""' <<<"$json" 2>/dev/null || echo "")
  anchor=$(jq -r '.usage.weeklyResetAnchor // ""' <<<"$json" 2>/dev/null || echo "")
  echo "${percent}|${anchor}"
}

# fetch_baseline_churn_sample -> "<avg>|<sampleSize>"
# Samples the most recent BASELINE_SAMPLE merged PRs that are NOT drainer
# output, as the "is GLM thrashier than Opus dev_orch" baseline. Not-drainer
# uses the same OR-predicate as the measurement fetch, negated — an
# unlabelled drainer PR must not pollute the Opus baseline either (issue
# #4048), exactly as it must not drop out of the measurement.
fetch_baseline_churn_sample() {
  local rows
  rows=$(gh pr list --repo "$REPO" --state merged --json additions,deletions,labels,headRefName --limit 100 2>/dev/null || echo "[]")
  local nums arr=()
  nums=$(jq -r --arg label "$GLM_LABEL_AUTHORED" --arg prefix "$GLM_DRAINER_BRANCH_PREFIX" \
    --argjson n "$BASELINE_SAMPLE" \
    "[.[] | select((${GLM_PR_MATCH_JQ}) | not) | (.additions + .deletions)][:\$n][]" \
    <<<"$rows" 2>/dev/null)
  while IFS= read -r n; do
    [[ -n "$n" ]] && arr+=("$n")
  done <<<"$nums"
  echo "$(avg "${arr[@]}")|${#arr[@]}"
}

# fetch_glm_authored_prs -> union JSON of drainer-output PRs (issue #4048):
# PRs carrying glm-authored (PRIMARY, filtered server-side by gh) OR on a
# worktree-agent-glm-* head branch (the FALLBACK recovering PRs whose
# non-atomic `--label` mutation was lost). Two raw-JSON fetches, unioned +
# deduped by PR number in jq below (same never-gh's-own---jq convention as
# every other fetch in this script). The per-side counts are derived from
# the union rows by main() so the label-vs-branch gap stays VISIBLE.
#
# FAIL LOUD (issue #4128): any failed fetch — a gh non-zero exit, gh exiting
# 0 with EMPTY stdout (a successful --json query always prints at least []),
# or a union jq parse failure over a malformed/partial response — makes this
# function RETURN NON-ZERO (with a loud log() diagnostic quoting gh's own
# stderr) instead of masking the failure as "[]". The caller detects the
# failure via THIS return code — never a global variable: this function runs
# inside `rows="$(fetch_glm_authored_prs)"`, a command-substitution subshell
# whose variable assignments cannot leak back to main() anyway. During the
# 2026-08-17 GitHub 503 window the old `2>/dev/null || echo "[]"` mask let a
# COMPLETED 20/14d window with 83 PRs render as a confident "9/14d, 0/25
# PRs, insufficient-data" — a wrong answer that reads as a right one.
fetch_glm_authored_prs() {
  local labeled branch_pool union err_file rc
  # gh's stderr lands in a temp file so the failure diagnostic can quote gh's
  # own error text (503 / rate-limit / auth) instead of discarding it. The
  # RETURN trap removes it on EVERY exit path, including ones added later —
  # there is no per-path `rm` to forget.
  err_file="$(mktemp)" || {
    log "ERROR mktemp failed (TMPDIR unwritable/full?) -- cannot capture gh stderr; refusing to render a report (issue #4128)"
    return 1
  }
  trap 'rm -f "$err_file"' RETURN
  # The section's shared gh-failure handler, defined INSIDE this function on
  # purpose (the design-concept artifact scopes this fix to
  # fetch_glm_authored_prs() and main() only): loud log() diagnostic quoting
  # gh's own stderr + `return 1`. A `return` from THIS helper only leaves the
  # helper, so each call site follows it with its own `return 1` to propagate
  # the failure out of fetch_glm_authored_prs (issue #4128).
  _glm_fetch_fail_loud() {
    rc=$?
    log "ERROR ${1} exited ${rc}, gh stderr [$(head -c 300 "$err_file" | tr -s '[:space:]' ' ')]-- a failed query is NOT an empty result set; refusing to render a report built on [] (issue #4128)"
    return 1
  }
  labeled="$(gh pr list --repo "$REPO" --label "$GLM_LABEL_AUTHORED" --state all \
    --json number,createdAt,additions,deletions,labels,headRefName --limit 100 \
    2>"$err_file")" || { _glm_fetch_fail_loud "label fetch (gh pr list --label ${GLM_LABEL_AUTHORED})"; return 1; }
  # Branch scan over recent PRs of every state. The scan depth bounds how far
  # back the branch fallback can see: 500 recent PRs spans months at this
  # repo's merge rate, well past the ~2-week window this report judges. (The
  # label side is filtered server-side, so its own --limit caps a set that is
  # already all-drainer.) A PR appearing in BOTH fetches dedupes onto its
  # label-fetch row below.
  branch_pool="$(gh pr list --repo "$REPO" --state all \
    --json number,createdAt,additions,deletions,labels,headRefName --limit 500 \
    2>"$err_file")" || { _glm_fetch_fail_loud "branch scan (gh pr list --state all --limit 500)"; return 1; }
  if [[ -z "$labeled" ]]; then
    log "ERROR label fetch exited 0 with EMPTY stdout (a successful --json query always prints at least []) -- treating that as a failed query, not an empty result set (issue #4128)"
    return 1
  fi
  if [[ -z "$branch_pool" ]]; then
    log "ERROR branch scan exited 0 with EMPTY stdout (a successful --json query always prints at least []) -- treating that as a failed query, not an empty result set (issue #4128)"
    return 1
  fi
  union="$(printf '%s\n%s\n' "$labeled" "$branch_pool" | jq -s \
    --arg label "$GLM_LABEL_AUTHORED" \
    --arg prefix "$GLM_DRAINER_BRANCH_PREFIX" \
    "(.[1] | map(select(${GLM_PR_MATCH_JQ}))) as \$branchside
     | .[0] + \$branchside | unique_by(.number)" 2>"$err_file")" || {
    log "ERROR union jq failed (malformed/partial gh response), jq stderr [$(head -c 300 "$err_file" | tr -s '[:space:]' ' ')]-- refusing to render a report built on [] (issue #4128)"
    return 1
  }
  printf '%s\n' "$union"
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

  local snapshot percent percent_json anchor
  snapshot="$(fetch_usage_snapshot)"
  percent="${snapshot%%|*}"
  anchor="${snapshot##*|}"
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

  local baseline_day0_iso baseline_day0_epoch baseline_percent baseline_churn baseline_anchor_iso
  baseline_day0_iso=$(jq -r '.day0' <<<"$baseline_json" 2>/dev/null)
  baseline_day0_epoch=$(iso_to_epoch "$baseline_day0_iso")
  baseline_percent=$(jq -r '.percentLast7dBaseline' <<<"$baseline_json" 2>/dev/null)
  baseline_churn=$(jq -r '.churnBaseline' <<<"$baseline_json" 2>/dev/null)
  # A legacy pre-#4049 baseline.json has no anchor field: jq's `// ""` keeps
  # this an empty string and the relief figure degrades to "not comparable"
  # below — never a crash, never a phase-blind subtraction.
  baseline_anchor_iso=$(jq -r '.weeklyResetAnchorBaseline // ""' <<<"$baseline_json" 2>/dev/null)
  if [[ -n "$baseline_percent" && "$baseline_percent" != "null" && -z "$baseline_anchor_iso" ]]; then
    log "baseline has a percent snapshot but no weeklyResetAnchorBaseline (pre-#4049 bootstrap) -- delete $BASELINE_FILE by hand to re-bootstrap with window position; relief stays 'not comparable' until then"
  fi

  local snapshot current_percent current_anchor_iso
  snapshot="$(fetch_usage_snapshot)"
  current_percent="${snapshot%%|*}"
  current_anchor_iso="${snapshot##*|}"

  # Window-relative quota relief (issue #4049): each reading's days-into-window
  # is printed so the phase is VISIBLE, and the figure itself compares
  # %/day rates, never the raw percents.
  local baseline_anchor_epoch current_anchor_epoch
  baseline_anchor_epoch=$(iso_to_epoch "$baseline_anchor_iso")
  current_anchor_epoch=$(iso_to_epoch "$current_anchor_iso")
  local baseline_days current_days
  baseline_days=$(days_into_window "$baseline_day0_epoch" "$baseline_anchor_epoch")
  current_days=$(days_into_window "$NOW_EPOCH" "$current_anchor_epoch")
  local relief_text
  relief_text=$(relief_figure "$baseline_percent" "$baseline_days" "$current_percent" "$current_days" "$MIN_DAYS_INTO_WINDOW")

  local rows
  rows="$(fetch_glm_authored_prs)" || {
    # A failed gh query is NOT an empty result set (issue #4128): rendering on
    # the masked [] fabricates BOTH the window position (day-0 falls back to
    # the baseline epoch, so a completed window reads as an early one) and the
    # recommendation (zero PRs -> insufficient-data). The loud log() stderr
    # diagnostic above (from inside fetch_glm_authored_prs) quotes gh's own
    # error text; this is the single stdout ERROR line, and main() exits
    # BEFORE window_day0_epoch_from_rows() or recommend() ever run — no
    # recommendation: line of any kind is printed on this path.
    #
    # Deliberate divergence from require_tools()'s exit-0-with-ERROR-text
    # convention at the top of main(): a MISSING TOOL is the caller
    # environment's problem (don't block hydra-review over it), while a
    # FAILED QUERY makes every number below fiction. Do NOT "harmonize" the
    # two exits back together (design-concept artifact, issue #4128).
    echo "GLM beachhead: ERROR gh query failed -- no report printed (a failed query is not an empty result set; see stderr diagnostic)"
    exit 1
  }
  local pr_count_total
  pr_count_total=$(jq -r 'length' <<<"$rows" 2>/dev/null || echo 0)

  # Side-by-side provenance counts (issue #4048): of the union rows above,
  # how many carry the label vs sit on a drainer head branch. The label is
  # the PRIMARY signal; branch >= label is expected, and a widening gap means
  # non-atomic `--label` mutations are being lost (drainer-loop.sh's #3900
  # note) — printed so that drift is visible, not silent.
  local labeled_n branch_n
  labeled_n=$(jq -r --arg label "$GLM_LABEL_AUTHORED" \
    '[.[] | select((.labels // []) | map(.name) | index($label))] | length' \
    <<<"$rows" 2>/dev/null || echo 0)
  branch_n=$(jq -r --arg prefix "$GLM_DRAINER_BRANCH_PREFIX" \
    '[.[] | select((.headRefName // "") | startswith($prefix))] | length' \
    <<<"$rows" 2>/dev/null || echo 0)

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
  rec=$(recommend "$pr_count_total" "$pass_rate" "$churn_ratio" "$days_elapsed" "$WINDOW_DAYS" "$WINDOW_PRS")
  # The corrected relief figure rides along as DESCRIPTIVE TEXT ONLY —
  # recommend()'s branch thresholds are untouched (the issue scopes
  # keep/kill/expand thresholds out). relief_figure always returns a string,
  # comparable figure or explicit not-comparable.
  rec="${rec}; quota relief: ${relief_text}"

  local excluded_n=$((pr_count_total - denom))

  local current_days_disp baseline_days_disp
  current_days_disp="$(display "${current_days:+${current_days}d}")"
  baseline_days_disp="$(display "${baseline_days:+${baseline_days}d}")"

  printf 'GLM beachhead: window %s/%sd, %s/%s PRs (glm-authored label %s / worktree-agent-glm-* branch %s) | first-pass PASS-rate %s (%s pass, %s fail, %s excluded no-verdict, of %s total) | percentLast7d %s%% @ %s into window (baseline %s%% @ %s into window; relief: %s) | churn avg %s vs baseline %s (ratio %s) | recommendation: %s\n' \
    "$days_elapsed" "$WINDOW_DAYS" "$pr_count_total" "$WINDOW_PRS" "$labeled_n" "$branch_n" \
    "$(display "$pass_rate")" "$pass_n" "$fail_n" "$excluded_n" "$pr_count_total" \
    "$(display "$current_percent")" "$current_days_disp" \
    "$(display "$baseline_percent")" "$baseline_days_disp" "$relief_text" \
    "$(display "$churn_current")" "$(display "$baseline_churn")" "$(display "$churn_ratio")" \
    "$rec"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
