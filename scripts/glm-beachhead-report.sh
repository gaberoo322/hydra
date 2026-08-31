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
#     clock above. The capture MOMENT is recorded explicitly as capturedAt
#     (equal to day0 at bootstrap); readers fall back to day0 for baseline
#     files that predate the field (issue #4122) — day0 alone must not carry
#     this meaning because it is documented as a fallback window anchor.
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
#     "not comparable" instead of a figure. PROVENANCE (issue #4122): the
#     metric additionally requires the baseline to predate the GLM era — a
#     baseline captured at/after the era's day-0 (earliest glm-authored PR)
#     has BOTH sides GLM-era, so relief prints "not comparable (baseline
#     captured <N>d into the GLM era ...)" and no figure is ever computed
#     from a contaminated baseline, however mature either window position is.
#     This script deliberately never
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
# --ab-report mode (issue #4127, ADR-0032 epic #4123 slice delta; approved
# design-concept artifact on record for issue-4127): additive-only per-arm
# analysis over the randomized GLM-vs-Opus A/B populated by slice beta
# (#4125, PR #4281) and joined to cost by slice gamma (#4126, PR #4295). The
# NO-ARGUMENT invocation above is completely untouched -- this mode is reached
# ONLY via the explicit `--ab-report` flag, so hydra-review's existing
# single-line consumer contract stays byte-identical. Hard invariant carried
# over verbatim: still READ-ONLY (no baseline.json write, no label, no
# decide.py call), and nothing it prints may auto-flip keep/kill/expand --
# every figure is advisory prose for the operator to read.
#
# Cohort discovery is GitHub-label-based, not a direct Redis read: #4125's
# assignment log (`getGlmAbAssignment` in src/redis/autopilot.ts) has no
# enumeration index and no HTTP route, and src/redis/autopilot.ts is out of
# this issue's file scope (belongs to closed slice beta). glm-eligible /
# glm-ab-control are applied once by the eligibility sweep and never removed
# by any chore in this codebase, so current label state is a safe,
# non-mutating proxy -- mirroring the glm-authored discovery convention this
# script already uses. Each candidate issue's `labeled` event timestamp (via
# `gh api repos/OWNER/REPO/issues/N/events`) is then checked against
# AB_COHORT_START (slice beta's PR #4281 merge instant): a pre-beta
# glm-eligible label predates the coin flip entirely (100% forced treatment,
# no randomization), so including it would silently defeat the whole
# experiment's reason for existing.
#
# Missing-input discipline (the issue's "not comparable" reporting rule): a
# FAILED per-issue fetch is never folded into a figure as a zero. A cost-join
# fetch that fails (orchestrator unreachable) counts toward the arm's
# cost-join-missing gap and suppresses the primary endpoint figure -- an
# unreachable orchestrator silently zeroing every GLM-arm issue would read as
# maximal quota relief, exactly the "silent drop reads as relief that did not
# happen" failure the reporting rules forbid. A pr-view fetch that fails
# counts as merge-outcome unknown and keeps the issue out of every figure --
# folding it out silently would fabricate a smaller merged-n. Both gap
# counters print on the arm line. A SUCCESSFUL response with empty content is
# a different, legitimate outcome (no cost-join records yet; PR closed but
# unmerged) and shows up in the attributed fraction / cohort-vs-merged n
# instead -- never suppressed, never a gap.
#
# Bounce rate: first Automated-QA verdict FAIL, OR a re-review (>= 2
# `> *Automated QA` comments on the PR). The issue text's "reframe" half is
# proxied by that re-review signal because `reframe` is NOT a label on the
# orchestrator repo (it is a Target-board label, src/target-board-labels.ts)
# -- on gaberoo322/hydra the observable re-work signal is QA having to look
# twice.
#
# Additional testability hooks for --ab-report mode:
#   HYDRA_GLM_AB_COHORT_START            default 2026-08-29T19:03:38Z (slice
#                                         beta's PR #4281 merge instant --
#                                         labels applied before this predate
#                                         the randomized coin flip)
#   HYDRA_GLM_AB_MIN_N                   default 10 (an arm below this many
#                                         merged issues prints under-powered
#                                         in place of a primary-endpoint figure)
#   HYDRA_GLM_AB_POOL_LIMIT              default 300 (gh issue list --limit
#                                         for each of the two label queries)
#   HYDRA_GLM_AB_USAGE_BY_ISSUE_URL      default http://localhost:4000/api/usage/by-issue
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

# --ab-report mode config (issue #4127) -- see the file header's dedicated
# section above for the full rationale of each.
GLM_LABEL_ELIGIBLE="glm-eligible"
GLM_LABEL_AB_CONTROL="glm-ab-control"
AB_COHORT_START="${HYDRA_GLM_AB_COHORT_START:-2026-08-29T19:03:38Z}"
AB_MIN_N="${HYDRA_GLM_AB_MIN_N:-10}"
AB_POOL_LIMIT="${HYDRA_GLM_AB_POOL_LIMIT:-300}"
AB_USAGE_BY_ISSUE_URL="${HYDRA_GLM_AB_USAGE_BY_ISSUE_URL:-http://localhost:4000/api/usage/by-issue}"

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
#               <current_percent> <current_days|empty> <min_days> \
#               <baseline_capture_epoch|empty> <glm_era_day0_epoch|empty>
#   -> the corrected quota-relief figure for the report line and the
#      recommendation string (issue #4049, provenance guard #4122):
#        "rate 26.9 -> 15.0 %/day (-44% daily use)"
#        "not comparable (<reason>)"
#      NEVER a raw subtraction of the two percent readings — their weekly
#      window phases differ. Percent change is computed from the displayed
#      1dp rates so the printed arithmetic is self-consistent.
#      PROVENANCE FIRST (issue #4122): percentLast7d relief asks "did routing
#      dev work to the GLM drainer relieve Anthropic quota?", so the baseline
#      side must predate the GLM era. A baseline captured at or after the
#      era's day-0 (earliest glm-authored PR) has BOTH sides GLM-era — any
#      figure it yields measures week-to-week variance, not GLM's effect.
#      Contamination never expires as the window advances, so it is checked
#      before every window-position guard: a contaminated baseline must never
#      surface a window-position reason, which would imply the figure turns
#      valid once the window matures. Empty epoch inputs (capture moment
#      unknowable, or no glm-authored PRs yet to anchor the era) skip the
#      guard — absence of evidence is not contamination. The five-arg call
#      shape predating #4122 therefore behaves exactly as before.
relief_figure() {
  local bp="${1:-}" bd="${2:-}" cp="${3:-}" cd="${4:-}" min="${5:-}"
  local cap="${6:-}" era="${7:-}"
  if [[ -n "$cap" && -n "$era" ]]; then
    # Prints the days-into-era (2dp) only when the baseline is contaminated
    # (capture at/after the era day-0); empty output means "not contaminated
    # or not evaluable" and falls through to the guards below.
    local era_days
    era_days=$(awk -v c="$cap" -v d="$era" 'BEGIN{
      if (c !~ /^[0-9]+$/ || d !~ /^[0-9]+$/) { exit 1 }
      if (c+0 < d+0) { exit 1 }
      printf "%.2f", (c-d)/86400
    }')
    if [[ -n "$era_days" ]]; then
      echo "not comparable (baseline captured ${era_days}d into the GLM era — both sides are GLM-era)"
      return 0
    fi
  fi
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
# --ab-report pure helpers (issue #4127, ADR-0032 epic #4123 slice delta)
# ---------------------------------------------------------------------------

# label_added_at <events_json> <label_name> -> ISO8601 of the FIRST "labeled"
# event carrying that label name, or "" when never applied. `events_json` is
# the raw array `gh api repos/OWNER/REPO/issues/N/events` returns. Multiple
# applications (re-add after a strip) are not expected for glm-eligible /
# glm-ab-control (grepped: neither label is ever removed by any chore in this
# codebase) but sort_by + first is the conservative choice regardless.
label_added_at() {
  local events="$1" label="$2"
  jq -r --arg label "$label" \
    '[.[] | select(.event=="labeled" and .label.name==$label)] | sort_by(.created_at) | .[0].created_at // ""' \
    <<<"$events" 2>/dev/null
}

# arm_for_issue <events_json> <cohort_start_epoch> -> treatment|control|""
# "" means: neither label was ever applied, OR the one that was predates
# AB_COHORT_START (slice beta's #4281 merge instant) -- a pre-beta
# glm-eligible label was 100% forced-treatment with no coin flip, and must
# not be silently folded into the randomized cohort (issue #4127 invariant).
arm_for_issue() {
  local events="$1" cohort_start_epoch="$2"
  local ctrl_at elig_at ctrl_epoch elig_epoch
  ctrl_at=$(label_added_at "$events" "$GLM_LABEL_AB_CONTROL")
  elig_at=$(label_added_at "$events" "$GLM_LABEL_ELIGIBLE")
  ctrl_epoch=$(iso_to_epoch "$ctrl_at")
  elig_epoch=$(iso_to_epoch "$elig_at")
  if [[ -n "$ctrl_epoch" ]] && awk -v c="$ctrl_epoch" -v s="$cohort_start_epoch" 'BEGIN{exit !(c>=s)}'; then
    echo "control"
    return 0
  fi
  if [[ -n "$elig_epoch" ]] && awk -v c="$elig_epoch" -v s="$cohort_start_epoch" 'BEGIN{exit !(c>=s)}'; then
    echo "treatment"
    return 0
  fi
  echo ""
}

# elapsed_hours <epoch_then> <epoch_now> -> hours elapsed, 1dp; "" when either
# epoch is empty/non-numeric or now predates then (never fabricate a negative
# wall-clock figure). Used for the assignment-to-merge secondary endpoint,
# where elapsed_days' whole-day granularity would round small/fast dispatches
# to 0 and hide real variance.
elapsed_hours() {
  local then="${1:-}" now="${2:-}"
  if [[ -z "$then" || -z "$now" ]]; then
    echo ""
    return 0
  fi
  awk -v t="$then" -v n="$now" 'BEGIN{
    if (t !~ /^[0-9]+$/ || n !~ /^[0-9]+$/) { print ""; exit }
    if (n+0 < t+0) { print ""; exit }
    printf "%.1f", (n-t)/3600
  }'
}

# issue_weighted_tokens <usage_by_issue_json> -> "<sum>|<all_calibrated>|<dispatch_count>"
# Folds `GET /api/usage/by-issue?issue=N`'s `byIssue[0].records[]` client-side
# (design-concept artifact: the composer in src/cost/cost-attribution.ts only
# rolls up the RAW totalDispatchTokensEstimate, never the quota-weighted
# figure #4123/#4127 ask for, and extending it is out of this issue's file
# scope). `all_calibrated` is "true" only when EVERY contributing record's
# quotaWeightCalibrated is true (vacuously true for zero records) -- a single
# uncalibrated record must not silently blend into a falsely-precise figure.
issue_weighted_tokens() {
  local json="$1"
  jq -r '
    (.byIssue[0]) as $e
    | if $e == null then "0|true|0" else
        ([$e.records[]?.weightedQuotaTokensEstimate // 0] | add // 0) as $sum
        | (([$e.records[]?.quotaWeightCalibrated] | all) ) as $cal
        | "\($sum)|\($cal)|\($e.dispatchCount // 0)"
      end
  ' <<<"$json" 2>/dev/null || echo "0|true|0"
}

# format_arm_primary <merged_n> <min_n> <weighted_sum> <all_calibrated> \
#                    [<cost_missing_n>] ->
# the primary-endpoint figure for one arm, or the reason it cannot be
# printed. Order matters: zero merged issues -> nothing to measure yet;
# cost-join input missing for >=1 merged issue -> not comparable (the figure
# cannot be computed at any n while an input is missing -- validity before
# power); under the configurable minimum -> under-powered (raw n still
# visible to the caller separately); uncalibrated Quota-Weight -> not
# comparable (a per-family split built from an identity pass-through is not
# the figure #4123 asks for). Never a fabricated number on any of these
# paths. <cost_missing_n> defaults to 0 so four-arg callers (the pre-#4127
# helper contract) behave exactly as before.
format_arm_primary() {
  local merged_n="$1" min_n="$2" sum="$3" cal="$4" cost_missing="${5:-0}"
  if [[ "$merged_n" -eq 0 ]]; then
    echo "no merged issues yet"
    return 0
  fi
  if [[ "$cost_missing" -gt 0 ]]; then
    echo "not comparable (cost-join input missing for ${cost_missing}/${merged_n} merged issues)"
    return 0
  fi
  if [[ "$merged_n" -lt "$min_n" ]]; then
    echo "under-powered (n=${merged_n} < ${min_n})"
    return 0
  fi
  if [[ "$cal" != "true" ]]; then
    echo "not comparable (uncalibrated Quota-Weight)"
    return 0
  fi
  awk -v s="$sum" -v n="$merged_n" 'BEGIN{printf "%.0f weighted-quota tokens/merged-issue (n=%d)", s/n, n}'
}

# format_rate <numerator> <denominator> -> "<pct>% (<num>/<den>)", or
# "n/a (0)" when the denominator is 0 (never divide by zero, never fabricate
# a rate from an empty cohort). Shared by the attributed-fraction and
# bounce-rate lines -- both are "count over merged n" shapes.
format_rate() {
  local num="$1" den="$2"
  if [[ "$den" -eq 0 ]]; then
    echo "n/a (0)"
    return 0
  fi
  local pct
  pct=$(awk -v a="$num" -v m="$den" 'BEGIN{printf "%.0f", (a/m)*100}')
  echo "${pct}% (${num}/${den})"
}

# numbers_to_rows_json <n1> <n2> ... -> '[{"number":n1},{"number":n2},...]',
# or "[]" for zero args. The shape first_pass_pass_rate expects -- lets
# --ab-report reuse that EXISTING QA-verdict computation unmodified rather
# than re-implementing any part of it (issue #4127 invariant).
numbers_to_rows_json() {
  if [[ $# -eq 0 ]]; then
    echo "[]"
    return 0
  fi
  printf '%s\n' "$@" | jq -R 'tonumber' | jq -s 'map({number: .})'
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

# glm_era_day0_epoch <rows_json> -> the earliest glm-authored PR's createdAt
# as an epoch; "" when there are no such PRs yet or the earliest createdAt is
# unparseable. Deliberately NO fallback, unlike window_day0_epoch_from_rows
# below: this is the PROVENANCE anchor for relief_figure (issue #4122), and
# the window clock's fallback is the baseline's own bootstrap moment — which
# equals the capture moment under test and so could never witness
# contamination. Zero glm-authored PRs also genuinely means the GLM era has
# not started; the empty return makes relief_figure skip the guard, because a
# baseline captured before any GLM output exists is pre-GLM by definition.
glm_era_day0_epoch() { # <rows_json>
  local rows="$1"
  local earliest_iso
  earliest_iso=$(jq -r '[.[].createdAt] | sort | .[0] // ""' <<<"$rows" 2>/dev/null)
  iso_to_epoch "$earliest_iso"
}

# window_day0_epoch_from_rows <rows_json> <fallback_epoch> -> the earliest
# glm-authored PR's createdAt as an epoch, or <fallback_epoch> when rows is
# empty (nothing to anchor on yet — see the file header's two-anchors note).
window_day0_epoch_from_rows() { # <rows_json> <fallback_epoch>
  local epoch
  epoch=$(glm_era_day0_epoch "$1")
  if [[ -z "$epoch" ]]; then
    echo "$2"
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

# first_automated_qa_body <pr_view_json> -> the FIRST "> *Automated QA"
# comment's body (earliest createdAt), or "" when the PR has none. Extracted
# verbatim from first_pass_verdict_for_pr (issue #4127) so the --ab-report
# bounce signal parses QA comments through the SAME expression the QA
# PASS-rate path uses -- one parser, two consumers, no drift between the
# metric and the bounce signal that reads it.
first_automated_qa_body() { # <pr_view_json>
  jq -r \
    '[.comments[] | select(.body | startswith("> *Automated QA"))] | sort_by(.createdAt) | .[0].body // ""' \
    <<<"$1" 2>/dev/null
}

# automated_qa_comment_count <pr_view_json> -> how many "> *Automated QA"
# comments the PR carries. >= 2 is issue #4127's re-review bounce signal: QA
# had to look at this PR more than once.
automated_qa_comment_count() { # <pr_view_json>
  jq -r '[.comments[] | select(.body | startswith("> *Automated QA"))] | length' \
    <<<"$1" 2>/dev/null || echo 0
}

first_pass_verdict_for_pr() { # <pr_number> -> pass|fail|unknown|no-verdict
  local pr="$1"
  local json first_body
  json=$(gh pr view "$pr" --repo "$REPO" --json comments 2>/dev/null || echo '{"comments":[]}')
  first_body=$(first_automated_qa_body "$json")
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
    --arg capturedAt "$day0_iso" \
    --argjson percent "$percent_json" \
    --arg anchor "$anchor" \
    --argjson churnAvg "$churn_json" \
    --argjson churnN "${churn_n:-0}" \
    '{day0: $day0, capturedAt: $capturedAt, percentLast7dBaseline: $percent, weeklyResetAnchorBaseline: (if $anchor == "" then null else $anchor end), churnBaseline: $churnAvg, churnSampleSize: $churnN}' \
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
# --ab-report data gathering (issue #4127). Same "never gh's own --jq"
# convention as above: every fetch below returns RAW json for jq/awk to fold
# afterward, which is what makes the fake-gh-on-PATH test fixtures tractable.
# ---------------------------------------------------------------------------

# gh_fetch_or_fail <description> <gh args...> -> prints gh's raw stdout on
# success; on ANY failure (non-zero exit, or exit 0 with empty stdout -- a
# successful --json query always prints at least []) logs a loud diagnostic
# quoting gh's own stderr and returns 1. Factored out of fetch_glm_authored_prs's
# inline trap/err_file dance (issue #4128) so the two NEW population-defining
# fetches below (glm-eligible / glm-ab-control issue lists) get the SAME
# fail-loud guarantee without duplicating that logic a third time. Scoped to
# the two population-breadth fetches only -- the per-issue/per-PR fetches
# below stay best-effort, mirroring first_pass_verdict_for_pr's existing
# convention that a single row's fetch failure degrades that row, not the
# whole report.
gh_fetch_or_fail() {
  local desc="$1"; shift
  local out err_file rc
  err_file="$(mktemp)" || {
    log "ERROR mktemp failed (TMPDIR unwritable/full?) -- cannot capture gh stderr for ${desc}"
    return 1
  }
  out="$(gh "$@" 2>"$err_file")"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    log "ERROR ${desc} exited ${rc}, gh stderr [$(head -c 300 "$err_file" | tr -s '[:space:]' ' ')]"
    rm -f "$err_file"
    return 1
  fi
  rm -f "$err_file"
  if [[ -z "$out" ]]; then
    log "ERROR ${desc} exited 0 with EMPTY stdout (a successful --json query always prints at least [])"
    return 1
  fi
  printf '%s\n' "$out"
}

# fetch_glm_ab_issue_pool -> union JSON of every issue ever carrying
# glm-eligible OR glm-ab-control (any state), deduped by number. FAIL LOUD
# (issue #4128 convention): a failed query here would silently zero out one
# or both arms and render a confident empty report, so this is NOT a
# best-effort fetch.
fetch_glm_ab_issue_pool() {
  local elig ctrl union
  elig="$(gh_fetch_or_fail "glm-eligible issue-list fetch" issue list --repo "$REPO" \
    --label "$GLM_LABEL_ELIGIBLE" --state all \
    --json number,createdAt,closedAt,closedByPullRequestsReferences --limit "$AB_POOL_LIMIT")" || return 1
  ctrl="$(gh_fetch_or_fail "glm-ab-control issue-list fetch" issue list --repo "$REPO" \
    --label "$GLM_LABEL_AB_CONTROL" --state all \
    --json number,createdAt,closedAt,closedByPullRequestsReferences --limit "$AB_POOL_LIMIT")" || return 1
  union="$(printf '%s\n%s\n' "$elig" "$ctrl" | jq -s '.[0] + .[1] | unique_by(.number)' 2>/dev/null)" || {
    log "ERROR glm-ab issue-pool union jq failed (malformed/partial gh response)"
    return 1
  }
  printf '%s\n' "$union"
}

# fetch_issue_events <issue> -> raw JSON array from
# `gh api repos/OWNER/REPO/issues/N/events` (best-effort: "[]" on any
# failure, degrading that one issue out of the cohort rather than aborting
# the whole report -- mirrors first_pass_verdict_for_pr's per-PR convention).
fetch_issue_events() {
  local issue="$1"
  gh api "repos/${REPO}/issues/${issue}/events" 2>/dev/null || echo "[]"
}

# fetch_pr_view <pr_number> -> raw JSON object (best-effort: "{}" on any
# failure). Carries mergedAt (the merge-outcome + wall-clock endpoint check),
# additions/deletions (churn, reusing churn_avg_from_rows unmodified), and
# comments (fed to the EXISTING first_pass_verdict_for_pr / first_pass_pass_rate
# path below -- never a second QA-verdict implementation).
fetch_pr_view() {
  local pr="$1"
  gh pr view "$pr" --repo "$REPO" --json number,mergedAt,additions,deletions,comments,headRefName 2>/dev/null || echo "{}"
}

# fetch_usage_by_issue <issue> -> raw JSON from `GET /api/usage/by-issue?issue=N`
# on success; NO output and a non-zero exit when the fetch failed. A failed
# fetch is a MISSING INPUT, not an empty ledger: masking it as "{}" would let
# an unreachable orchestrator silently contribute a zero-cost issue to an
# arm's weighted sum -- a fabricated zero on the GLM side is the strongest
# false keep/expand signal there is ("a silent drop reads as relief that did
# not happen"). The caller counts it per arm (cost-join missing) and
# format_arm_primary prints "not comparable" over any figure built on it. A
# SUCCESSFUL response with an empty byIssue (no cost-join records for this
# issue yet) is a different, legitimate outcome: it contributes zero tokens
# but stays visible in the attributed fraction, never suppressed.
fetch_usage_by_issue() {
  local issue="$1"
  curl -fsS --max-time 10 "${AB_USAGE_BY_ISSUE_URL}?issue=${issue}" 2>/dev/null
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
  # The baseline snapshot's capture moment (issue #4122): capturedAt when the
  # file records it, else its day0 — a bootstrap writes both as the same
  # instant, so operator state predating the capturedAt field keeps working
  # untouched. Kept DISTINCT from baseline_day0_epoch (which stays the window
  # clock's fallback) because day0 is documented as a fallback window anchor;
  # conflating the two is how a re-bootstrap taken 21 days into the GLM era
  # could pose as a pre-GLM reading.
  local baseline_captured_epoch
  baseline_captured_epoch=$(iso_to_epoch "$(jq -r '.capturedAt // .day0 // ""' <<<"$baseline_json" 2>/dev/null)")

  local snapshot current_percent current_anchor_iso
  snapshot="$(fetch_usage_snapshot)"
  current_percent="${snapshot%%|*}"
  current_anchor_iso="${snapshot##*|}"

  # Window-relative quota relief (issue #4049): each reading's days-into-window
  # is printed so the phase is VISIBLE, and the figure itself compares
  # %/day rates, never the raw percents. The baseline reading's moment is its
  # CAPTURE moment (issue #4122), not the window clock's fallback anchor.
  local baseline_anchor_epoch current_anchor_epoch
  baseline_anchor_epoch=$(iso_to_epoch "$baseline_anchor_iso")
  current_anchor_epoch=$(iso_to_epoch "$current_anchor_iso")
  local baseline_days current_days
  baseline_days=$(days_into_window "$baseline_captured_epoch" "$baseline_anchor_epoch")
  current_days=$(days_into_window "$NOW_EPOCH" "$current_anchor_epoch")

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

  # Window clock: anchored to the earliest glm-authored PR, NOT the baseline
  # bootstrap moment above (see the file header's two-anchors note).
  local window_day0_epoch days_elapsed
  window_day0_epoch=$(window_day0_epoch_from_rows "$rows" "$baseline_day0_epoch")
  days_elapsed=$(elapsed_days "$window_day0_epoch" "$NOW_EPOCH")

  # PR-derived GLM-era day-0, with NO fallback (see glm_era_day0_epoch's
  # comment): the provenance anchor for the relief figure below.
  local era_day0_epoch
  era_day0_epoch=$(glm_era_day0_epoch "$rows")

  # Pre-#4049 legacy warning (issue #4122's original filing; the re-scoped
  # fix keeps it honest): fires when a percent exists but the window phase it
  # was read in does not. It no longer advises deleting the file as an
  # unqualified fix — a valid relief figure requires a pre-GLM-era
  # percentLast7d snapshot, and once "now" is at/after the window day-0 a
  # re-bootstrap lands inside the GLM era, so the provenance guard below
  # keeps relief "not comparable" anyway. The file itself is operator-owned
  # state (2026-08-17 ruling: keep it, measure prospectively via #4123).
  if [[ -n "$baseline_percent" && "$baseline_percent" != "null" && -z "$baseline_anchor_iso" ]]; then
    local rebootstrap_note=""
    if awk -v n="$NOW_EPOCH" -v d="$window_day0_epoch" 'BEGIN{ if (n !~ /^[0-9]+$/ || d !~ /^[0-9]+$/) exit 1; exit !(n+0 >= d+0) }'; then
      rebootstrap_note="; re-bootstrapping today cannot produce an attributable pre-GLM baseline (a snapshot taken now is already inside the GLM era)"
    fi
    log "baseline has a percent snapshot but no weeklyResetAnchorBaseline (pre-#4049 bootstrap) -- relief stays 'not comparable'; a valid figure requires a pre-GLM-era percentLast7d snapshot${rebootstrap_note}; do not delete $BASELINE_FILE expecting one (operator ruling 2026-08-17)"
  fi

  local relief_text
  relief_text=$(relief_figure "$baseline_percent" "$baseline_days" "$current_percent" "$current_days" "$MIN_DAYS_INTO_WINDOW" "$baseline_captured_epoch" "$era_day0_epoch")

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

# ---------------------------------------------------------------------------
# main_ab_report — --ab-report mode (issue #4127)
# ---------------------------------------------------------------------------

# print_arm_line <label> <pool_n> <merged_n> <weighted_sum> <calibrated> \
#                <attributed_n> <pass_rate> <pass_n> <fail_n> <churn_avg> \
#                <wallclock_avg> <bounce_n> <cost_missing_n> <outcome_unknown_n>
# One arm's full line: cohort n, merged n, the primary endpoint (or its
# under-powered/not-comparable reason), the cohort-scoped attributed
# fraction, all four secondary endpoints, and the input-gap counters that
# keep every missing input VISIBLE instead of silently folded into a figure
# (see the file header's missing-input discipline note). Never a verdict
# beyond the primary-endpoint slot -- every other figure is a plain computed
# value or "n/a", per the existing not-comparable discipline.
print_arm_line() {
  local label="$1" pool_n="$2" merged_n="$3" weighted_sum="$4" calibrated="$5" \
    attributed_n="$6" pass_rate="$7" pass_n="$8" fail_n="$9"
  shift 9
  local churn_avg="$1" wallclock_avg="$2" bounce_n="$3" cost_missing="$4" outcome_unknown="$5"
  local excluded_n=$((merged_n - pass_n - fail_n))
  printf '  %s: cohort n=%s, merged n=%s | primary: %s | attributed %s | QA PASS-rate %s (%s pass, %s fail, %s excluded no-verdict, of %s merged) | churn avg %s | wall-clock avg %sh | bounce rate %s | input gaps: cost-join missing %s/%s merged, merge-outcome unknown %s\n' \
    "$label" "$pool_n" "$merged_n" \
    "$(format_arm_primary "$merged_n" "$AB_MIN_N" "$weighted_sum" "$calibrated" "$cost_missing")" \
    "$(format_rate "$attributed_n" "$merged_n")" \
    "$(display "$pass_rate")" "$pass_n" "$fail_n" "$excluded_n" "$merged_n" \
    "$(display "$churn_avg")" \
    "$(display "$wallclock_avg")" \
    "$(format_rate "$bounce_n" "$merged_n")" \
    "$cost_missing" "$merged_n" "$outcome_unknown"
}

# main_ab_report — per-arm A/B analysis (issue #4127). READ-ONLY: no
# baseline.json touch, no label write, no decide.py call, no auto-flip of
# anything -- every printed figure is advisory prose for the operator, same
# hard invariant as main()'s recommendation string. Reachable ONLY via the
# explicit `--ab-report` flag (see the bottom dispatcher) so main()'s
# no-argument behaviour above stays byte-identical to today.
main_ab_report() {
  if ! require_tools; then
    echo "GLM A/B delta: ERROR required tools (gh/jq/curl/awk) unavailable -- cannot compute report"
    exit 0
  fi

  local cohort_start_epoch
  cohort_start_epoch=$(iso_to_epoch "$AB_COHORT_START")

  local pool
  pool="$(fetch_glm_ab_issue_pool)" || {
    echo "GLM A/B delta: ERROR gh query failed -- no report printed (a failed query is not an empty result set; see stderr diagnostic)"
    exit 1
  }

  local t_pool_n=0 c_pool_n=0
  local t_merged=() c_merged=()
  local t_churn_rows="[]" c_churn_rows="[]"
  local t_weighted_sum=0 c_weighted_sum=0
  local t_calibrated="true" c_calibrated="true"
  local t_attributed=0 c_attributed=0
  local t_wallclock=() c_wallclock=()
  local t_bounce=0 c_bounce=0
  local t_cost_missing=0 c_cost_missing=0
  local t_outcome_unknown=0 c_outcome_unknown=0

  local numbers
  numbers=$(jq -r '.[].number' <<<"$pool" 2>/dev/null)
  while IFS= read -r issue; do
    [[ -z "$issue" ]] && continue

    local events arm
    events=$(fetch_issue_events "$issue")
    arm=$(arm_for_issue "$events" "$cohort_start_epoch")
    [[ -z "$arm" ]] && continue

    if [[ "$arm" == "treatment" ]]; then t_pool_n=$((t_pool_n + 1)); else c_pool_n=$((c_pool_n + 1)); fi

    local pr_number
    pr_number=$(jq -r --argjson n "$issue" \
      '[.[] | select(.number==$n)][0].closedByPullRequestsReferences[0].number // empty' \
      <<<"$pool" 2>/dev/null)
    [[ -z "$pr_number" ]] && continue

    local pr_json merged_at
    pr_json=$(fetch_pr_view "$pr_number")
    # A FAILED pr-view fetch is a missing input, not "not merged": folding an
    # un-fetchable PR out of the merged denominator would fabricate a smaller
    # n (and its churn/QA figures would silently vanish). Counted per arm as
    # merge-outcome unknown and excluded from every figure instead -- a
    # successful gh pr view always carries .number, so its absence is the
    # fetch-failure discriminator.
    if ! jq -e '.number' <<<"$pr_json" >/dev/null 2>&1; then
      if [[ "$arm" == "treatment" ]]; then t_outcome_unknown=$((t_outcome_unknown + 1)); else c_outcome_unknown=$((c_outcome_unknown + 1)); fi
      log "pr view fetch failed for PR ${pr_number} (issue ${issue}) -- merge outcome unknown, issue excluded from every figure (issue #4127)"
      continue
    fi
    merged_at=$(jq -r '.mergedAt // empty' <<<"$pr_json" 2>/dev/null)
    # A closed-but-unmerged PR (e.g. superseded/abandoned) is not a merged
    # outcome for this analysis -- skip it out of the merged-n denominator
    # entirely rather than counting it as a zero-cost win. This is a
    # LEGITIMATE non-outcome (the PR view succeeded), so it is not an input
    # gap: it stays visible as cohort-n minus merged-n.
    [[ -z "$merged_at" ]] && continue

    local additions deletions
    additions=$(jq -r '.additions // 0' <<<"$pr_json" 2>/dev/null)
    deletions=$(jq -r '.deletions // 0' <<<"$pr_json" 2>/dev/null)

    local usage_json wt_line wt_sum wt_cal wt_dispatch cost_missing=0
    if usage_json=$(fetch_usage_by_issue "$issue"); then
      wt_line=$(issue_weighted_tokens "$usage_json")
      IFS='|' read -r wt_sum wt_cal wt_dispatch <<<"$wt_line"
    else
      # Missing cost input (see fetch_usage_by_issue): contributes nothing to
      # the weighted sum and never to the attributed count, and suppresses
      # the arm's primary figure via the cost-missing counter -- never a
      # fabricated zero-cost issue.
      wt_sum=0 wt_cal="true" wt_dispatch=0 cost_missing=1
      log "usage by-issue fetch failed for issue ${issue} -- counted as a missing cost input, not a zero-cost issue (issue #4127)"
    fi

    local labeled_at label_epoch merge_epoch hours
    if [[ "$arm" == "treatment" ]]; then
      labeled_at=$(label_added_at "$events" "$GLM_LABEL_ELIGIBLE")
    else
      labeled_at=$(label_added_at "$events" "$GLM_LABEL_AB_CONTROL")
    fi
    label_epoch=$(iso_to_epoch "$labeled_at")
    merge_epoch=$(iso_to_epoch "$merged_at")
    hours=$(elapsed_hours "$label_epoch" "$merge_epoch")

    # Bounce: first Automated-QA verdict FAIL, or a re-review (>= 2
    # Automated-QA comments). Both parse through the SAME first-automated-QA
    # expression the PASS-rate path uses (first_automated_qa_body), read off
    # the pr view already fetched -- no second QA-verdict implementation.
    local first_qa_body qa_count verdict bounced=0
    first_qa_body=$(first_automated_qa_body "$pr_json")
    qa_count=$(automated_qa_comment_count "$pr_json")
    verdict=$(classify_qa_verdict "$first_qa_body")
    [[ "$verdict" == "fail" ]] && bounced=1
    [[ "$qa_count" -ge 2 ]] && bounced=1

    if [[ "$arm" == "treatment" ]]; then
      t_merged+=("$pr_number")
      t_churn_rows=$(jq -c --argjson a "$additions" --argjson d "$deletions" '. + [{additions:$a, deletions:$d}]' <<<"$t_churn_rows")
      t_weighted_sum=$(awk -v s="$t_weighted_sum" -v w="$wt_sum" 'BEGIN{printf "%.4f", s+w}')
      [[ "$wt_cal" == "false" ]] && t_calibrated="false"
      [[ "${wt_dispatch:-0}" -gt 0 ]] && t_attributed=$((t_attributed + 1))
      [[ -n "$hours" ]] && t_wallclock+=("$hours")
      [[ "$bounced" -eq 1 ]] && t_bounce=$((t_bounce + 1))
      [[ "$cost_missing" -eq 1 ]] && t_cost_missing=$((t_cost_missing + 1))
    else
      c_merged+=("$pr_number")
      c_churn_rows=$(jq -c --argjson a "$additions" --argjson d "$deletions" '. + [{additions:$a, deletions:$d}]' <<<"$c_churn_rows")
      c_weighted_sum=$(awk -v s="$c_weighted_sum" -v w="$wt_sum" 'BEGIN{printf "%.4f", s+w}')
      [[ "$wt_cal" == "false" ]] && c_calibrated="false"
      [[ "${wt_dispatch:-0}" -gt 0 ]] && c_attributed=$((c_attributed + 1))
      [[ -n "$hours" ]] && c_wallclock+=("$hours")
      [[ "$bounced" -eq 1 ]] && c_bounce=$((c_bounce + 1))
      [[ "$cost_missing" -eq 1 ]] && c_cost_missing=$((c_cost_missing + 1))
    fi
  done <<<"$numbers"

  local t_pass_line c_pass_line
  t_pass_line=$(first_pass_pass_rate "$(numbers_to_rows_json "${t_merged[@]}")")
  c_pass_line=$(first_pass_pass_rate "$(numbers_to_rows_json "${c_merged[@]}")")
  local t_pass_rate t_pass_n t_fail_n t_denom
  local c_pass_rate c_pass_n c_fail_n c_denom
  IFS='|' read -r t_pass_rate t_pass_n t_fail_n t_denom <<<"$t_pass_line"
  IFS='|' read -r c_pass_rate c_pass_n c_fail_n c_denom <<<"$c_pass_line"

  local t_churn_avg c_churn_avg
  t_churn_avg=$(churn_avg_from_rows "$t_churn_rows")
  c_churn_avg=$(churn_avg_from_rows "$c_churn_rows")

  local t_wallclock_avg c_wallclock_avg
  t_wallclock_avg=$(avg "${t_wallclock[@]}")
  c_wallclock_avg=$(avg "${c_wallclock[@]}")

  echo "GLM A/B delta (issue #4127): cohort start ${AB_COHORT_START} (slice beta #4125 PR #4281 merge instant)"
  print_arm_line "treatment" "$t_pool_n" "${#t_merged[@]}" "$t_weighted_sum" "$t_calibrated" \
    "$t_attributed" "$t_pass_rate" "$t_pass_n" "$t_fail_n" \
    "$t_churn_avg" "$t_wallclock_avg" "$t_bounce" "$t_cost_missing" "$t_outcome_unknown"
  print_arm_line "control  " "$c_pool_n" "${#c_merged[@]}" "$c_weighted_sum" "$c_calibrated" \
    "$c_attributed" "$c_pass_rate" "$c_pass_n" "$c_fail_n" \
    "$c_churn_avg" "$c_wallclock_avg" "$c_bounce" "$c_cost_missing" "$c_outcome_unknown"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if [[ "${1:-}" == "--ab-report" ]]; then
    shift
    main_ab_report "$@"
  else
    main "$@"
  fi
fi
