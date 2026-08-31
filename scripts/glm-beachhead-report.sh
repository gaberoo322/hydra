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
#   HYDRA_GLM_AB_MIN_N                   default 10 (--ab mode: an arm with fewer MERGED cohort
#                                          issues than this prints "under-powered" in place of any
#                                          comparison verdict; figures still print)
#   HYDRA_GLM_BEACHHEAD_BY_ISSUE_URL     default http://localhost:4000/api/usage/by-issue
#                                          (--ab mode: the per-issue dispatch-cost-join read
#                                          surface, slice gamma #4126)
#
# ---
#
# Per-arm A/B analysis (`--ab` mode, issue #4127 / epic #4123 slice delta).
# STRICTLY ADDITIVE: the default invocation stays byte-identical to the
# single-line report above (hydra-review consumes that line verbatim); the
# per-arm block is reachable only via the explicit `--ab` argument. It
# computes the A/B's endpoints per arm — primary: Anthropic weighted-quota
# tokens per MERGED issue (a GLM-arm issue's cost is its Anthropic-side cost
# — QA/sweep/any Opus involvement — summed from the by-issue cost-join
# ledger, never zero); secondary: first-pass QA PASS-rate, churn, wall-clock
# assignment->merge, bounce rate — so the next keep/kill/expand call rests on
# an attributable comparison rather than a confounded delta.
#
# Arm membership is read from the glm-eligible / glm-ab-control GitHub issue
# labels. The Redis assignment log (#4125's declared source of truth) has no
# enumeration index and no HTTP route (only a per-issue in-process lookup),
# and reaching it would require new src/ code that is explicitly out of
# #4127's file scope; neither label is ever removed once applied (grep of
# glm-eligibility-sweep.ts / drainer-loop.sh), so current label state is a
# non-mutating substitute — the same discovery convention as glm-authored.
# The cohort further excludes any issue whose arm label was applied BEFORE
# slice beta merged (see AB_COHORT_SINCE_ISO below): pre-beta glm-eligible
# issues were 100% forced-treatment with no coin flip.
#
# The --ab mode NEVER touches baseline.json (not even the bootstrap-once the
# default mode performs), never labels anything, never calls decide.py,
# never disables the drainer, and prints numbers + advisory prose only —
# nothing here may auto-flip keep/kill/expand (ADR-0032 #3671).
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

# --- Per-arm A/B analysis constants (issue #4127, `--ab` mode) -----------
# The two randomized arms from slice beta (#4125): treatment is drained by
# GLM exactly as before; control carries glm-ab-control, is skipped by the
# drainer, and is worked by the Opus dev_orch lane. Assignment happens at
# eligibility-sweep ENTRY (one event per issue), so reading the label now is
# reading the arm.
AB_TREATMENT_LABEL="glm-eligible"
AB_CONTROL_LABEL="glm-ab-control"
# Cohort cutoff = the instant slice beta (#4125, PR #4281) merged. Before it,
# glm-eligible was applied unconditionally — 100% forced treatment, no coin
# flip — so an issue labeled earlier must not enter either arm: mixing those
# in would silently defeat the randomization the epic exists to establish
# (design-concept invariant). At-or-after is IN (the first genuinely
# randomized sweep tick could land in the same second as the merge).
AB_COHORT_SINCE_ISO="2026-08-29T19:03:38Z"
AB_MIN_N="${HYDRA_GLM_AB_MIN_N:-10}"
BY_ISSUE_URL="${HYDRA_GLM_BEACHHEAD_BY_ISSUE_URL:-http://localhost:4000/api/usage/by-issue}"

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
# Per-arm A/B pure helpers (issue #4127, `--ab` mode) — unit-tested directly
# like the helpers above; no gh/curl inside this block.
# ---------------------------------------------------------------------------

# arm_label_epoch <events_json> <label> -> epoch of the FIRST `labeled` event
# carrying <label>, "" when the issue has no such event (which the caller
# treats as not provably post-beta -> excluded from the cohort).
arm_label_epoch() { # <events_json> <label>
  local iso
  iso=$(jq -r --arg label "$2" \
    '[.[] | select(.event == "labeled" and .label.name == $label)]
     | sort_by(.created_at) | .[0].created_at // ""' \
    <<<"$1" 2>/dev/null)
  iso_to_epoch "$iso"
}

# issue_closed_by_merge <events_json> -> ISO created_at of the first `closed`
# event carrying a NON-NULL commit_id ("closed by a merged commit"), "" when
# none. A close with commit_id null is a manual close, not a merge outcome —
# per the closed-completed-!=-shipped convention (a null commit_id means no
# fix ever landed).
issue_closed_by_merge() { # <events_json>
  jq -r '[.[] | select(.event == "closed" and .commit_id != null)]
         | sort_by(.created_at) | .[0].created_at // ""' <<<"$1" 2>/dev/null
}

# days_between_2dp <epoch_then> <epoch_now> -> fractional days, 2dp; "" when
# either epoch is empty/non-numeric or now predates then (clock skew never
# fabricates a negative wall-clock).
days_between_2dp() { # <epoch_then> <epoch_now>
  local then="${1:-}" now="${2:-}"
  if [[ -z "$then" || -z "$now" ]]; then
    echo ""
    return 0
  fi
  awk -v a="$then" -v b="$now" 'BEGIN{
    if (a !~ /^[0-9]+$/ || b !~ /^[0-9]+$/) { print ""; exit }
    d = (b - a) / 86400
    if (d < 0) { print ""; exit }
    printf "%.2f", d
  }'
}

# closing_ref_prs <merged_prs_json> <issue> -> JSON array of the merged PRs
# whose body references <issue> with a GitHub closing keyword (the Closes /
# Fixes / Resolves family, case-insensitive). Word-boundary anchored so
# closing #412 never false-matches inside #4127 — the same reconcile-by-
# Closes-ref-not-title convention the drainer's own claim detection uses.
closing_ref_prs() { # <merged_prs_json> <issue>
  jq -c --arg issue "$2" \
    '[.[] | select((.body // "")
      | test("(?i)(close[ds]?|fix(e[ds]?)?|resolve[ds]?)[ :]*#" + $issue + "\\b"))]' \
    <<<"$1" 2>/dev/null
}

# arm_cost_fold <byissue_json> <issues_json_array>
#   -> "<weightedSum>|<issuesWithRecords>|<uncalibratedRecordCount>"
# Folds records[].weightedQuotaTokensEstimate over EXACTLY the arm's issue
# numbers — the WEIGHTED figure the A/B primary endpoint asks for, never the
# raw dispatchTokensEstimate rollup /api/usage/by-issue's composer returns
# (it sums the raw field even though every record carries the weighted one).
# Also counts the arm's records whose quotaWeightCalibrated is not true: any
# such record makes the arm's figure "not comparable (uncalibrated
# Quota-Weight)" rather than a silently blended, misleadingly-precise number.
# Empty output (jq parse failure over a malformed response) means the caller
# prints not-comparable, never a zero.
arm_cost_fold() { # <byissue_json> <issues_json_array>
  jq -r --argjson issues "$2" '
    [.byIssue[] | select(.issue as $i | $issues | index($i))] as $rows
    | ([$rows[].records[].weightedQuotaTokensEstimate] | add // 0) as $sum
    | ([$rows[] | select((.records | length) > 0)] | length) as $withRec
    | ([$rows[].records[] | select(.quotaWeightCalibrated != true)] | length) as $uncal
    | "\($sum)|\($withRec)|\($uncal)"
  ' <<<"$1" 2>/dev/null
}

# per_merged_issue <sum> <n> -> sum/n to 0dp (whole tokens); "" on empty/zero n.
per_merged_issue() { # <sum> <n>
  local sum="${1:-}" n="${2:-}"
  if [[ -z "$sum" || -z "$n" ]]; then
    echo ""
    return 0
  fi
  awk -v s="$sum" -v n="$n" 'BEGIN{ if (n+0==0) { print ""; exit } printf "%.0f", s/n }'
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
# Per-arm A/B data gathering + main (issue #4127, `--ab` mode)
# ---------------------------------------------------------------------------

# fetch_ab_labeled_issues <label> -> raw gh JSON array of {number} rows for
# every issue (any state) carrying <label>. FAIL LOUD on a gh failure or an
# empty stdout (issue #4128 discipline): a masked [] here fabricates an EMPTY
# ARM, and an A/B verdict built on one reads as a confident answer.
fetch_ab_labeled_issues() { # <label>
  local out err
  err="$(mktemp)" || {
    log "ERROR mktemp failed (TMPDIR unwritable/full?) -- cannot capture gh stderr; refusing to render the A/B report (issue #4128 discipline)"
    return 1
  }
  trap 'rm -f "$err"' RETURN
  if ! out=$(gh issue list --repo "$REPO" --label "$1" --state all \
    --json number --limit 500 2>"$err"); then
    log "ERROR gh issue list --label $1 exited non-zero, gh stderr [$(head -c 300 "$err" | tr -s '[:space:]' ' ')]-- a failed query is NOT an empty result set; refusing to render an A/B report built on it (issue #4128 discipline)"
    return 1
  fi
  if [[ -z "$out" ]]; then
    log "ERROR gh issue list --label $1 exited 0 with EMPTY stdout (a successful --json query always prints at least []) -- treating that as a failed query (issue #4128 discipline)"
    return 1
  fi
  printf '%s\n' "$out"
}

# fetch_ab_issue_events <issue_number> -> raw gh api JSON of one issue's
# events (the `labeled` events carry the arm-assignment moment; the `closed`
# events carry merge evidence). FAIL LOUD: a dropped issue silently
# fabricates the cohort (an under-counted arm reads as under-powered, or at
# the margin flips which arm clears the minimum-n bar).
fetch_ab_issue_events() { # <issue_number>
  local out err
  err="$(mktemp)" || {
    log "ERROR mktemp failed -- cannot capture gh stderr; refusing to render the A/B report (issue #4128 discipline)"
    return 1
  }
  trap 'rm -f "$err"' RETURN
  if ! out=$(gh api "repos/${REPO}/issues/${1}/events?per_page=100" 2>"$err"); then
    log "ERROR gh api events fetch failed for issue #${1}, gh stderr [$(head -c 300 "$err" | tr -s '[:space:]' ' ')]-- a dropped issue would fabricate the A/B cohort; refusing to render (issue #4128 discipline)"
    return 1
  fi
  if [[ -z "$out" ]]; then
    log "ERROR gh api events fetch for issue #${1} exited 0 with EMPTY stdout -- treating that as a failed query (issue #4128 discipline)"
    return 1
  fi
  printf '%s\n' "$out"
}

# fetch_ab_merged_pool -> raw gh JSON of recent merged PRs carrying the
# fields per-arm PR resolution needs (body for closing-keyword matching,
# mergeCommit to pin THE PR that closed an issue). Same fail-loud rule.
fetch_ab_merged_pool() {
  local out err
  err="$(mktemp)" || {
    log "ERROR mktemp failed -- cannot capture gh stderr; refusing to render the A/B report (issue #4128 discipline)"
    return 1
  }
  trap 'rm -f "$err"' RETURN
  if ! out=$(gh pr list --repo "$REPO" --state merged \
    --json number,body,additions,deletions,mergedAt,mergeCommit --limit 500 2>"$err"); then
    log "ERROR gh pr list --state merged (A/B pool) exited non-zero, gh stderr [$(head -c 300 "$err" | tr -s '[:space:]' ' ')]-- a failed query is NOT an empty result set (issue #4128 discipline)"
    return 1
  fi
  if [[ -z "$out" ]]; then
    log "ERROR gh pr list --state merged (A/B pool) exited 0 with EMPTY stdout -- treating that as a failed query (issue #4128 discipline)"
    return 1
  fi
  printf '%s\n' "$out"
}

# issue_close_commit_id <events_json> -> the commit_id of the first
# closed-with-commit_id event ("" when none) — pins WHICH PR closed the issue.
issue_close_commit_id() { # <events_json>
  jq -r '[.[] | select(.event == "closed" and .commit_id != null)]
         | sort_by(.created_at) | .[0].commit_id // ""' <<<"$1" 2>/dev/null
}

# ab_collect_arm <label> <issues_json> <merged_pool_json> <cutoff_epoch>
#   Walks one arm's candidate issues; prints machine-parsed stdout lines the
#   caller parses (the function runs inside a command substitution, so it
#   communicates ONLY via stdout + its return code — never a global):
#     cohort|<issue>|<label_epoch>|<closed_epoch>  a MERGED cohort issue
#     pr|<pr-row-json>                             the PR representing a cohort issue
#     open|<issue>                                 cohort issue, no merged outcome yet
#     prebeta|<issue>                              excluded: label pre-cutoff, or no label
#                                                 event found (not provably randomized)
#     nopr|<issue>                                 merged cohort issue with no resolvable PR
#   Non-zero return = a failed gh query (fail loud; see fetch_ab_issue_events).
ab_collect_arm() { # <label> <issues_json> <merged_pool_json> <cutoff_epoch>
  local label="$1" issues_json="$2" pool="$3" cutoff="$4"
  local n events label_epoch closed_iso closed_ep commit_id prs pr
  while IFS= read -r n; do
    [[ -z "$n" ]] && continue
    events=$(fetch_ab_issue_events "$n") || return 1
    label_epoch=$(arm_label_epoch "$events" "$label")
    if [[ -z "$label_epoch" ]]; then
      echo "prebeta|$n"
      continue
    fi
    if [[ -n "$cutoff" ]] && awk -v l="$label_epoch" -v c="$cutoff" 'BEGIN{exit !(l+0 < c+0)}'; then
      echo "prebeta|$n"
      continue
    fi
    closed_iso=$(issue_closed_by_merge "$events")
    commit_id=""
    if [[ -z "$closed_iso" ]]; then
      # Fallback merge evidence: a merged PR that closing-keyword-refs the
      # issue — its merge is what closed the issue (its mergedAt is the
      # merge moment for wall-clock purposes).
      prs=$(closing_ref_prs "$pool" "$n")
      closed_iso=$(jq -r 'sort_by(.mergedAt) | .[-1].mergedAt // ""' <<<"$prs" 2>/dev/null)
      if [[ -z "$closed_iso" ]]; then
        echo "open|$n"
        continue
      fi
    else
      commit_id=$(issue_close_commit_id "$events")
    fi
    closed_ep=$(iso_to_epoch "$closed_iso")
    echo "cohort|$n|$label_epoch|$closed_ep"
    # THE PR whose QA/churn metrics represent this issue: the PR pinned by
    # the issue's close commit when there is one, else the most recent merged
    # PR that closing-keyword-refs the issue.
    pr=""
    if [[ -n "$commit_id" ]]; then
      pr=$(jq -c --arg cid "$commit_id" \
        '[.[] | select((.mergeCommit.oid // "") == $cid)] | .[0]
         | if . then {number, additions, deletions} else empty end' <<<"$pool" 2>/dev/null)
    fi
    if [[ -z "$pr" ]]; then
      prs=$(closing_ref_prs "$pool" "$n")
      pr=$(jq -c 'sort_by(.mergedAt) | .[-1]
          | if . then {number, additions, deletions} else empty end' <<<"$prs" 2>/dev/null)
    fi
    if [[ -z "$pr" ]]; then
      echo "nopr|$n"
    else
      echo "pr|$pr"
    fi
  done <<<"$(jq -r '.[].number' <<<"$issues_json" 2>/dev/null)"
}

# ab_summarize_arm <lines> <byissue_json> — folds ab_collect_arm's output for
# ONE arm into the AB_* globals below. Called in the CALLER's shell (never a
# subshell) so the globals stick; the caller snapshots them into arm-local
# variables before summarizing the other arm:
#   AB_MERGED_N AB_OPEN_N AB_PREBETA_N AB_NOPR_N AB_PR_TOTAL AB_PR_ROWS
#   AB_WALLCLOCK AB_COHORT_ISSUES AB_PRIMARY AB_PASS_RATE AB_PASS_N
#   AB_FAIL_N AB_DENOM AB_BOUNCE AB_CHURN
ab_summarize_arm() { # <lines> <byissue_json>
  local lines="$1"
  AB_BYISSUE_JSON="$2"
  AB_MERGED_N=0 AB_OPEN_N=0 AB_PREBETA_N=0 AB_NOPR_N=0
  AB_PR_ROWS="[]" AB_WALLCLOCK="" AB_COHORT_ISSUES="[]" AB_PRIMARY=""
  local kind rest issue label_ep closed_ep pr d
  local -a prs=() wall=() issues=()
  while IFS='|' read -r kind rest; do
    [[ -z "$kind" ]] && continue
    case "$kind" in
      cohort)
        IFS='|' read -r issue label_ep closed_ep <<<"$rest"
        AB_MERGED_N=$((AB_MERGED_N + 1))
        issues+=("$issue")
        d=$(days_between_2dp "$label_ep" "$closed_ep")
        [[ -n "$d" ]] && wall+=("$d")
        ;;
      pr) prs+=("$rest") ;;
      open) AB_OPEN_N=$((AB_OPEN_N + 1)) ;;
      prebeta) AB_PREBETA_N=$((AB_PREBETA_N + 1)) ;;
      nopr) AB_NOPR_N=$((AB_NOPR_N + 1)) ;;
    esac
  done <<<"$lines"

  if [[ ${#prs[@]} -gt 0 ]]; then
    AB_PR_ROWS=$(printf '%s\n' "${prs[@]}" | jq -s '.' 2>/dev/null)
    [[ -z "$AB_PR_ROWS" ]] && AB_PR_ROWS="[]"
  fi
  AB_PR_TOTAL=$(jq -r 'length' <<<"$AB_PR_ROWS" 2>/dev/null || echo 0)
  if [[ ${#issues[@]} -gt 0 ]]; then
    AB_COHORT_ISSUES=$(printf '%s\n' "${issues[@]}" | jq -R -s 'split("\n") | map(select(length > 0) | tonumber)' 2>/dev/null)
    [[ -z "$AB_COHORT_ISSUES" ]] && AB_COHORT_ISSUES="[]"
  fi
  AB_WALLCLOCK=""
  if [[ ${#wall[@]} -gt 0 ]]; then
    AB_WALLCLOCK=$(avg "${wall[@]}")
  fi

  # Primary endpoint (the attribution discipline: every reason below prints
  # not comparable with WHY, never a fabricated figure).
  if [[ -z "$AB_BYISSUE_JSON" ]]; then
    AB_PRIMARY="not comparable (usage by-issue endpoint unreachable)"
  elif [[ "$AB_MERGED_N" -eq 0 ]]; then
    AB_PRIMARY="not comparable (no merged issues in arm yet)"
  else
    local fold sum withrec uncal per
    fold=$(arm_cost_fold "$AB_BYISSUE_JSON" "$AB_COHORT_ISSUES")
    if [[ -z "$fold" ]]; then
      AB_PRIMARY="not comparable (malformed usage by-issue response)"
    else
      IFS='|' read -r sum withrec uncal <<<"$fold"
      if [[ "$uncal" -gt 0 ]]; then
        AB_PRIMARY="not comparable (uncalibrated Quota-Weight)"
      else
        per=$(per_merged_issue "$sum" "$AB_MERGED_N")
        AB_PRIMARY="${per} weighted-quota tokens/merged issue (sum ${sum}, attributed ${withrec}/${AB_MERGED_N})"
      fi
    fi
  fi

  # Secondary endpoints — QA PASS-rate and churn go through the EXACT
  # existing implementations on the arm's PR rows (no second implementation
  # of either metric), so both arms are measured identically. Bounce rate is
  # the first-FAIL share of the same denominator (a FAIL first pass is a
  # re-review bounce; the `reframe` label is a Target-board concept with no
  # equivalent on this orchestrator board).
  local pass_line
  pass_line=$(first_pass_pass_rate "$AB_PR_ROWS")
  IFS='|' read -r AB_PASS_RATE AB_PASS_N AB_FAIL_N AB_DENOM <<<"$pass_line"
  AB_BOUNCE=$(ratio "$AB_FAIL_N" "$AB_DENOM")
  AB_CHURN=$(churn_avg_from_rows "$AB_PR_ROWS")
}

# main_ab — the `--ab` mode entry point (issue #4127). READ-ONLY, and unlike
# main() it does not even bootstrap baseline.json: the baseline is
# operator-owned state (2026-08-17 ruling) and the A/B endpoints have no use
# for it. Prints a multi-line advisory block. Exit 0 on success (including
# not-comparable/under-powered outputs); exit 1 only on a FAILED QUERY (same
# fail-loud class as main's measurement fetch).
main_ab() {
  if ! require_tools; then
    echo "GLM A/B: ERROR required tools (gh/jq/curl/awk) unavailable -- cannot compute report"
    exit 0
  fi

  local cutoff_epoch
  cutoff_epoch=$(iso_to_epoch "$AB_COHORT_SINCE_ISO")

  local treat_issues ctrl_issues pool
  treat_issues=$(fetch_ab_labeled_issues "$AB_TREATMENT_LABEL") || ab_fail_loud
  ctrl_issues=$(fetch_ab_labeled_issues "$AB_CONTROL_LABEL") || ab_fail_loud
  pool=$(fetch_ab_merged_pool) || ab_fail_loud

  # An issue carrying BOTH arm labels has no attributable arm — excluded from
  # both and counted loudly, rather than double-counted into both arms.
  local both_count t_orig c_orig
  t_orig="$treat_issues"
  c_orig="$ctrl_issues"
  both_count=$(jq -n --argjson t "$t_orig" --argjson c "$c_orig" \
    '[$t[].number] as $tn | [$c[].number] as $cn
     | [$tn[] | select(. as $x | $cn | index($x))] | length' 2>/dev/null || echo 0)
  if [[ "$both_count" -gt 0 ]]; then
    log "WARNING ${both_count} issue(s) carry BOTH ${AB_TREATMENT_LABEL} and ${AB_CONTROL_LABEL} -- no attributable arm; excluded from both arms (operator may want to fix by hand)"
    treat_issues=$(jq -n --argjson t "$t_orig" --argjson c "$c_orig" \
      '[$c[].number] as $cn | [$t[] | select((.number as $n | ($cn | index($n))) | not)]' 2>/dev/null)
    ctrl_issues=$(jq -n --argjson t "$t_orig" --argjson c "$c_orig" \
      '[$t[].number] as $tn | [$c[] | select((.number as $n | ($tn | index($n))) | not)]' 2>/dev/null)
  fi

  local treat_lines ctrl_lines
  treat_lines=$(ab_collect_arm "$AB_TREATMENT_LABEL" "$treat_issues" "$pool" "$cutoff_epoch") || ab_fail_loud
  ctrl_lines=$(ab_collect_arm "$AB_CONTROL_LABEL" "$ctrl_issues" "$pool" "$cutoff_epoch") || ab_fail_loud

  # The cost-join read surface (slice gamma #4126). A failed fetch is NOT a
  # failed query over the cohort: it degrades the primary endpoint to an
  # explicit not-comparable while the gh-derived secondaries still print.
  local byissue_json residual_text
  byissue_json="$(curl -fsS --max-time 10 "$BY_ISSUE_URL" 2>/dev/null || true)"
  if [[ -n "$byissue_json" ]] && ! jq -e '.byIssue' <<<"$byissue_json" >/dev/null 2>&1; then
    byissue_json=""
  fi
  if [[ -z "$byissue_json" ]]; then
    residual_text="not comparable (usage by-issue endpoint unreachable) -- the unattributed residual cannot be shown"
  else
    residual_text="$(jq -r '.residualTokensEstimate // 0' <<<"$byissue_json" 2>/dev/null) tokens across $(jq -r '.residualDispatchCount // 0' <<<"$byissue_json" 2>/dev/null) unattributed dispatches (global dispatch-cost-join ledger, NOT cohort-scoped; global attributedPercent $(jq -r '.attributedPercent // 0' <<<"$byissue_json" 2>/dev/null)%)"
  fi

  ab_summarize_arm "$treat_lines" "$byissue_json"
  local t_n="$AB_MERGED_N" t_open="$AB_OPEN_N" t_pre="$AB_PREBETA_N" t_nopr="$AB_NOPR_N"
  local t_primary="$AB_PRIMARY" t_pr_total="$AB_PR_TOTAL" t_wall="$AB_WALLCLOCK"
  local t_rate="$AB_PASS_RATE" t_passn="$AB_PASS_N" t_failn="$AB_FAIL_N" t_denom="$AB_DENOM"
  local t_bounce="$AB_BOUNCE" t_churn="$AB_CHURN"
  ab_summarize_arm "$ctrl_lines" "$byissue_json"
  local c_n="$AB_MERGED_N" c_open="$AB_OPEN_N" c_pre="$AB_PREBETA_N" c_nopr="$AB_NOPR_N"
  local c_primary="$AB_PRIMARY" c_pr_total="$AB_PR_TOTAL" c_wall="$AB_WALLCLOCK"
  local c_rate="$AB_PASS_RATE" c_passn="$AB_PASS_N" c_failn="$AB_FAIL_N" c_denom="$AB_DENOM"
  local c_bounce="$AB_BOUNCE" c_churn="$AB_CHURN"

  # Verdict discipline: never a verdict from an under-powered arm (the
  # configurable minimum, default 10); never a comparison when either figure
  # is not comparable; advisory prose only either way.
  local verdict under="" t_per="" c_per="" pct
  # A primary that leads with a whole number is a real figure; anything else
  # is one of the not-comparable branches above.
  [[ "$t_primary" =~ ^([0-9]+) ]] && t_per="${BASH_REMATCH[1]}"
  [[ "$c_primary" =~ ^([0-9]+) ]] && c_per="${BASH_REMATCH[1]}"
  if [[ "$t_n" -lt "$AB_MIN_N" ]]; then
    under="under-powered (n=${t_n} < ${AB_MIN_N})"
  fi
  if [[ "$c_n" -lt "$AB_MIN_N" ]]; then
    under="${under:+${under}; }under-powered (n=${c_n} < ${AB_MIN_N})"
  fi
  if [[ -n "$under" ]]; then
    verdict="${under} -- no comparison published (informational, operator-driven)"
  elif [[ -n "$t_per" && -n "$c_per" ]]; then
    pct=$(awk -v t="$t_per" -v c="$c_per" 'BEGIN{ if (c+0==0) { print "n/a"; exit } printf "%+.0f", (t-c)/c*100 }')
    if [[ "$pct" == "n/a" ]]; then
      verdict="not comparable (control per-merged-issue figure is zero -- ratio undefined; informational, operator-driven)"
    else
      verdict="treatment ${t_per} vs control ${c_per} weighted-quota tokens per merged issue (treatment ${pct}%; informational, operator-driven -- acting on it is an operator decision, never this script)"
    fi
  else
    verdict="not comparable -- see the per-arm primary reasons above (informational, operator-driven)"
  fi

  printf 'GLM A/B per-arm report: cohort = issues labeled %s/%s at eligibility-sweep entry on/after %s (slice beta #4125, PR #4281)%s; advisory only -- nothing here flips keep/kill/expand, changes any label or timer, or touches the baseline\n' \
    "$AB_TREATMENT_LABEL" "$AB_CONTROL_LABEL" "$AB_COHORT_SINCE_ISO" \
    "$([[ "$both_count" -gt 0 ]] && printf '; %s both-labeled issue(s) excluded from both arms' "$both_count")"
  printf '  treatment (%s): merged n=%s (open %s, excluded pre-beta %s, no resolvable PR %s) | primary %s | QA first-pass PASS-rate %s (%s pass, %s fail, %s excluded no-verdict, of %s PRs) | bounce (first FAIL -> re-review) %s | churn avg %s | wall-clock assignment->merge %s\n' \
    "$AB_TREATMENT_LABEL" "$t_n" "$t_open" "$t_pre" "$t_nopr" \
    "$t_primary" "$(display "$t_rate")" "$t_passn" "$t_failn" "$((t_pr_total - t_denom))" "$t_pr_total" \
    "$(display "$t_bounce")" "$(display "$t_churn")" "$(display "${t_wall:+${t_wall}d}")"
  printf '  control   (%s): merged n=%s (open %s, excluded pre-beta %s, no resolvable PR %s) | primary %s | QA first-pass PASS-rate %s (%s pass, %s fail, %s excluded no-verdict, of %s PRs) | bounce (first FAIL -> re-review) %s | churn avg %s | wall-clock assignment->merge %s\n' \
    "$AB_CONTROL_LABEL" "$c_n" "$c_open" "$c_pre" "$c_nopr" \
    "$c_primary" "$(display "$c_rate")" "$c_passn" "$c_failn" "$((c_pr_total - c_denom))" "$c_pr_total" \
    "$(display "$c_bounce")" "$(display "$c_churn")" "$(display "${c_wall:+${c_wall}d}")"
  printf '  ledger residual: %s\n' "$residual_text"
  printf '  verdict: %s\n' "$verdict"
}

# One stdout ERROR line for the --ab mode's fail-loud exits (a failed query
# is not an empty result set — issue #4128 discipline; the loud log()
# diagnostic with gh's own stderr has already gone to stderr by now).
ab_fail_loud() {
  echo "GLM A/B: ERROR gh query failed -- no report printed (a failed query is not an empty result set; see stderr diagnostic)"
  exit 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-}" in
    # Per-arm A/B analysis (issue #4127): explicit opt-in only — the default
    # invocation stays byte-identical to the single-line report above.
    --ab) main_ab "$@" ;;
    *) main "$@" ;;
  esac
fi
