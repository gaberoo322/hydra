# hydra-target-build — Anchor preflight reference (Steps 2.1, 3.1, 3.2)

Read this file when you need the full detail for the anchor-selection preflight
(Step 2.1 — shipped-anchor guard) and the grounding preflights (Steps 3.1 — ledger
intersection, 3.2 — doc banner check). All three run before code is written.

#### 2.1. Shipped-anchor preflight — skip a board anchor already closed-by-link by a merged PR, non-destructively

The Target board is GitHub Issues on `$TARGET_GH_REPO` (ADR-0031). Enforced `Closes #N` close-discipline (ADR-0031 Decision 5) is the durable suppression: a merged PR closes its issue, so a shipped anchor normally never resurfaces on the open board. The residual case is a MERGED PR whose explicit close was dropped (the issue was reopened or the close did not fire), leaving the issue open and pickable. This preflight is the residual guard for that window at anchor-select time and is **non-destructive**: a positive verdict skips the anchor for this pick and flags it; it NEVER closes or relabels the board issue. Run it ONLY when the anchor came from the board pick (Step 2 priority 3); a failing-test / priorities anchor is not a board issue and skips this check.

**Invariants (do NOT weaken these):**
- **Positive evidence = a closing link, never a citation.** Skipping requires a MERGED PR on `$TARGET_GH_REPO` whose body carries a GitHub closing verb (`Closes`/`Fixes`/`Resolves`, any tense) for the anchor number. A commit that merely cites the issue, a `Refs #N` mention, a head-branch name, or any subject-word overlap is NEVER a positive. The closing-verb rule lives once in `scripts/autopilot/pr-refs.py` (`--closing` -> `closing_issues()`), and the recipe pipes a REST pulls payload through it. Work that shipped with NO closing link is `hydra-target-sweep` Step 7's title-overlap backstop, off the hot path.
- **Non-destructive on hit.** A positive verdict skips the
  anchor and falls through to the next candidate. It NEVER closes the board
  issue, and its only board write is clearing this preflight's own
  `in-progress` claim (claim bookkeeping that returns the board to its
  pre-pick state); a false positive must cost one cycle of re-picking, never a
  closed backlog item.
- **Fail-open on uncertainty.** Unreachable `gh`, an empty / non-JSON payload, a `python3` failure, or the anchor number absent from the emitted set all KEEP the anchor (`SHIPPED_ON_MAIN=0`). Membership is an exact whole-number match, so `#5` never matches 15 or 50.
- **REST only (ADR-0031 Decision 6).** One bounded page of `gh api repos/$TARGET_GH_REPO/pulls?state=closed...` (the 100 most-recently-updated closed PRs — an older closing PR is outside the window and falls to the sweep backstop), never `gh pr list --json` / GraphQL.
- **Friction cue still emitted on skip.** On a positive hit, still record the
  `target-build-anchor-skip-suspected-shipped` friction cue (pattern-memory
  bookkeeping).

```bash
# Only meaningful for a BOARD anchor (Step 2 priority 3). ANCHOR_NUM is the
# target issue number claimed in Step 2. A failing-test / priorities anchor has
# no ANCHOR_NUM and skips this preflight entirely.
#
# Guard-compatible form: no process substitution, no shell loops,
# no nested command substitution — one flat pipeline plus a `case` test.
# HYDRA_ROOT overrides the pr-refs.py checkout (tests point it at the PR tree).
# intentional: fail-open — stderr from gh/jq/python3 is discarded and any failure
# (missing jq, expired gh token) leaves CLOSED empty, so the preflight degrades to
# "not shipped" and the anchor proceeds. A skipped check must never block a build.
if [ -n "${ANCHOR_NUM:-}" ]; then
  SHIPPED_ON_MAIN=0
  CLOSED=$(gh api "repos/$TARGET_GH_REPO/pulls?state=closed&per_page=100&sort=updated&direction=desc" 2>/dev/null | jq -c '[.[] | select(.merged_at != null) | {headRefName: .head.ref, body: (.body // "")}]' 2>/dev/null | python3 "${HYDRA_ROOT:-$HOME/hydra}/scripts/autopilot/pr-refs.py" --closing 2>/dev/null)
  case " $CLOSED " in
    *" $ANCHOR_NUM "*) SHIPPED_ON_MAIN=1 ;;
  esac

  if [ "$SHIPPED_ON_MAIN" = "1" ]; then
    echo "shipped-on-main: a MERGED PR carries a closing verb for #$ANCHOR_NUM — skipping anchor (non-destructive) + re-selecting"
    # 1. NON-DESTRUCTIVE skip: NEVER close the board issue and
    #    never relabel it. The only board write is clearing our own claim
    #    label. REST-only (`gh issue edit`); never GraphQL (ADR-0031 Decision 6).
    gh issue edit "$ANCHOR_NUM" --repo "$TARGET_GH_REPO" --remove-label in-progress 2>/dev/null || true
    # 2. Emit the friction cue (pattern-memory bookkeeping — MUST still fire
    #    on every positive verdict).
    hydra raw POST /memory/subagent-friction "{
      \"skill\":\"hydra-target-build\",
      \"cue\":\"target-build-anchor-skip-suspected-shipped\",
      \"workaround\":\"skipped suspected-shipped board anchor (no close, no relabel); selected next candidate\",
      \"context\":\"merged PR on the Target repo carries a closing verb for the anchor at anchor-select preflight\",
      \"cycleId\":\"$CYCLE_ID\"
    }"
    # 3. Fall through to the NEXT candidate below this anchor in the priority
    #    order; do NOT re-pick it in this pass and do NOT change its labels.
    echo "select the next candidate before proceeding to Step 3"
  fi
fi
```

Positive evidence skips the anchor + re-selects (the issue stays open, flagged
only by the friction cue); anything short of it (no merged PR with a closing
link, unreachable `gh`, bad payload) keeps the anchor and proceeds.

### 3.1. Grounding preflight — ledger intersection

**Run this BEFORE finalising the plan and before Step 3.5.** A plan built on a
dead or awaiting-wiring module wastes the cycle and rebuilds what already
exists. This step catches that in O(seconds) — before any code is written.

**Two ledger reads, two distinct responses:**

- **wire-or-retire** rows — a formal decision is pending; do NOT build on these
  modules. Any hit is a hard STOP-AND-REFRAME.
- **awaiting-wiring** rows — the module exists and is waiting for a runtime
  hook; the right move is usually to wire the existing module, not write a new
  one. Any overlap with `scopeBoundary.in` is a soft STOP-AND-REFRAME with a
  wiring-steer verdict.
- **protected-provider** rows — leave alone; protected-provider modules have
  their own governance (CLAUDE.md rule 1) and are not a preflight concern.

The ledger path is the `$TARGET_CAP_WIRING_LEDGER` capability (relative to
`$TARGET_WS`; read-only, the main checkout copy is fine for planning — no write
needed). A ledger is EXPECTED only when `$TARGET_CAP_WIRING_LEDGER_GENERATOR` is
non-empty.

```bash
# --- 0. Populate SCOPE_IN from the plan's scopeBoundary.in ---
# SUBSTITUTE the real plan scope here: one $TARGET_APP_SUBDIR-relative file OR
# directory prefix per line, exactly as computed for scopeBoundary.in in Step
# 3. This MUST be assigned before the intersection loops below use it — an
# empty SCOPE_IN makes both read loops iterate once on a blank line, so every
# hit list comes back empty and the preflight silently PASSES (a no-op). The
# two lines below are a placeholder EXAMPLE — replace them with your plan's scope:
SCOPE_IN="${TARGET_APP_SUBDIR:+$TARGET_APP_SUBDIR/}src/example-module/example-file.ts
${TARGET_APP_SUBDIR:+$TARGET_APP_SUBDIR/}src/example-module/other-file.ts"

# --- 1. Read the ledger rows ---
WIRING_STATUS_PATH=""
if [ -n "$TARGET_CAP_WIRING_LEDGER" ]; then WIRING_STATUS_PATH="$TARGET_WS/$TARGET_CAP_WIRING_LEDGER"; fi

# Ledger-missing guard — never blocks the build (read-only advisory check);
# either way proceed to Step 3.5. Sits before the WOR_ROWS/AW_ROWS extraction
# so the `grep`s below never run against a nonexistent path.
if [ ! -f "$WIRING_STATUS_PATH" ]; then
  if [ -n "$TARGET_CAP_WIRING_LEDGER_GENERATOR" ]; then
    echo "warn: wiring ledger not found — grounding preflight skipped (cue: grounding-preflight-ledger-missing)"
    hydra raw POST /memory/subagent-friction "{
      \"skill\":\"hydra-target-build\",
      \"cue\":\"grounding-preflight-ledger-missing\",
      \"workaround\":\"skipped ledger intersection — wiring ledger absent\",
      \"context\":\"$TARGET_WS\",
      \"cycleId\":\"${CYCLE_ID:-unknown}\"
    }" 2>/dev/null || true
  else
    echo "Grounding preflight: skipped (Target declares no wiring ledger) — ledger intersection skipped."
  fi
else

# Extract the backticked FIRST column of each row by status. The path is taken
# whatever its prefix — no app-subdir assumption, so a repo-root Target
# (appSubdir "") and a nested app extract identically.
WOR_ROWS=$(grep '| wire-or-retire |' "$WIRING_STATUS_PATH" \
  | sed -n 's/^|[[:space:]]*`\([^`]*\)`.*/\1/p')
AW_ROWS=$(grep '| awaiting-wiring |' "$WIRING_STATUS_PATH" \
  | sed -n 's/^|[[:space:]]*`\([^`]*\)`.*/\1/p')

# --- 2. Intersect against the plan's scopeBoundary.in ---
# A scope entry S "hits" a ledger row L when S is a prefix of L or L is a prefix
# of S (covers file and directory entries). Intentionally broad: a false
# positive stops the cycle (cheap); a false negative lets bad work through.
ledger_hits() {
  for row in $1; do
    while IFS= read -r scope_entry; do
      clean_entry=$(printf '%s' "$scope_entry" | tr -d '`' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
      [ -z "$clean_entry" ] && continue
      if printf '%s' "$row" | grep -qF "$clean_entry" || \
         printf '%s' "$clean_entry" | grep -qF "$row"; then
        echo "  $row (hits scope: $clean_entry)"
      fi
    done <<EOF
$SCOPE_IN
EOF
  done
}
HIT_WOR=$(ledger_hits "$WOR_ROWS")
HIT_AW=$(ledger_hits "$AW_ROWS")

# --- 3. Decision gate ---
REFRAME="${HYDRA_ROOT:-$HOME/hydra}/scripts/target/target-reframe.ts"
if [ -n "$HIT_WOR" ]; then
  # HARD STOP-AND-REFRAME: wire-or-retire module in scope.
  echo "GROUNDING PREFLIGHT STOP: wire-or-retire ledger hit(s):"
  printf '%s\n' "$HIT_WOR"
  echo "Action: STOP-AND-REFRAME — a wire-or-retire decision is pending for these modules."
  echo "Do NOT build. Relabel the issue reframe and emit the event."
  printf '%s\n' "$HIT_WOR" | npx tsx "$REFRAME" --repo "$TARGET_GH_REPO" --anchor "${ANCHOR_NUM:-}" \
    --anchor-ref "${ANCHOR_REF:-}" --reason "wire-or-retire ledger hit — grounding preflight stopped the build" --hits-stdin
  exit 0

elif [ -n "$HIT_AW" ]; then
  # SOFT STOP-AND-REFRAME: awaiting-wiring module in scope.
  echo "GROUNDING PREFLIGHT STOP: awaiting-wiring ledger hit(s):"
  printf '%s\n' "$HIT_AW"
  echo "Action: STOP-AND-REFRAME — these modules are awaiting-wiring (built, not wired)."
  echo "The correct move is to wire the existing module, NOT rebuild it."
  echo "Reframe the plan toward a wiring task (add the runtime import / route / API call)."
  printf '%s\n' "$HIT_AW" | npx tsx "$REFRAME" --repo "$TARGET_GH_REPO" --anchor "${ANCHOR_NUM:-}" \
    --anchor-ref "${ANCHOR_REF:-}" --reason "awaiting-wiring ledger hit — grounding preflight stopped rebuild, steering toward wiring" --hits-stdin
  exit 0

else
  echo "Grounding preflight: no ledger hits — scope is clean, proceeding to Step 3.5."
fi

fi   # end ledger-present branch (the `if [ ! -f "$WIRING_STATUS_PATH" ]` guard)
```

`SCOPE_IN` is assigned at the top of the snippet above (step 0) — the
newline-separated list of repo-relative (`$TARGET_APP_SUBDIR`-prefixed) file paths from the Step 3 plan
boundary (`scopeBoundary.in`). Replace the placeholder example there with your
plan's actual scope before running the snippet; the assignment must precede the
intersection loops (an unset `SCOPE_IN` makes the preflight a silent no-op).

**Failure modes:**
- Ledger file missing → the guard short-circuits before any `grep`. Ledger
  expected (`$TARGET_CAP_WIRING_LEDGER_GENERATOR` non-empty) → friction cue
  `grounding-preflight-ledger-missing`. Not expected → one stdout line, no
  friction. **Never fail the build on a missing ledger — it is a read-only
  advisory check.**
- The reframe write (`scripts/target/target-reframe.ts`) is fail-soft: a failed
  relabel or event publish warns and the stop still stands (a manual reframe
  label is preferred over a blocked build).

### 3.2. Grounding preflight — doc banner check

**Run this alongside the ledger intersection (Step 3.1), before finalising the
plan.** A superseded direction doc is a dead premise exactly like a
wire-or-retire ledger row: planning from `north-star.md` or another retired
framing doc the target's own ADR history has since superseded has burned whole
build cycles. The doc-supersession slice makes that status machine-readable so
the preflight can refuse to ground on it.

**Banner format.** A superseded doc carries a machine-readable banner as its
first non-blank content line:

```
> **STATUS: superseded by <doc-or-ADR> on <YYYY-MM-DD>.** <one-line pointer to the current doc.>
```

This is a thin banner slice, NOT a doc-lifecycle system — no freshness scoring,
no staleness detector. The banner is stamped only when an explicit supersession
decision happens (see the ADR acceptance-checklist rule below), so its presence
is an authoritative "do-not-plan-from-me" signal.

**Check every doc the plan intends to ground on** — the direction docs loaded
in Step 1 (`priorities.md`, `vision.md`, roadmap, `north-star.md`) plus any doc
the plan cites as its rationale source. A banner hit is a **hard
STOP-AND-REFRAME**: read the banner's pointer and re-plan against the doc it
names, never against the banner'd doc.

```bash
# --- Populate GROUND_DOCS from the plan's rationale sources ---
# One doc path per line: the direction docs read in Step 1 plus any doc the
# plan cites as its premise. Empty list ⇒ the check is a no-op (nothing planned
# from a doc). SUBSTITUTE the real paths your plan grounds on:
GROUND_DOCS="$TARGET_WS/docs/north-star.md
$HOME/hydra/config/direction/priorities.md
$HOME/hydra/config/direction/vision.md"

HIT_DOCS=""
while IFS= read -r doc; do
  clean_doc=$(printf '%s' "$doc" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
  [ -z "$clean_doc" ] && continue
  [ -f "$clean_doc" ] || continue   # missing doc is not a banner hit — skip it
  # Read the first non-blank content line and test for the banner marker.
  first_line=$(grep -m1 -v '^[[:space:]]*$' "$clean_doc")
  if printf '%s' "$first_line" | grep -qiE 'STATUS:[[:space:]]*superseded by'; then
    HIT_DOCS="$HIT_DOCS  $clean_doc — $first_line\n"
  fi
done <<EOF
$GROUND_DOCS
EOF

if [ -n "$HIT_DOCS" ]; then
  # HARD STOP-AND-REFRAME: the plan grounds on a superseded doc.
  echo "GROUNDING PREFLIGHT STOP: superseded doc banner hit(s):"
  printf '%b\n' "$HIT_DOCS"
  echo "Action: STOP-AND-REFRAME — these docs are superseded (dead premise)."
  echo "Follow each banner's 'superseded by' pointer and re-plan against the current doc."

  printf '%b' "$HIT_DOCS" | npx tsx "${HYDRA_ROOT:-$HOME/hydra}/scripts/target/target-reframe.ts" \
    --repo "$TARGET_GH_REPO" --anchor "${ANCHOR_NUM:-}" --anchor-ref "${ANCHOR_REF:-}" \
    --reason "superseded-doc banner hit — grounding preflight stopped the build" --hits-stdin
  exit 0
else
  echo "Doc-banner check: no superseded docs in the plan's grounding set — proceeding."
fi
```

**Failure modes:**
- Doc file missing → skipped, never a hit (a doc that does not exist can't be a
  dead premise). The check is read-only advisory, same as the ledger gate.
- Banner not on the first non-blank line → not detected. The banner contract is
  first-non-blank-line placement.
- `$GROUND_DOCS` empty/unset → the check is a silent no-op (the plan grounds on
  no docs). Populate it from the plan's rationale sources, mirroring the
  `SCOPE_IN` discipline in Step 3.1.

**ADR acceptance-checklist rule (doc supersession).** Doc banners are the
doc-side arm of the same rule that stamps code ledger annotations: **when an ADR
(or equivalent operator supersession decision) retires a doc's premise, the
acceptance checklist for that decision requires stamping the retired doc with
the STATUS-superseded banner in the same change.** There is no separate
doc-lifecycle process — the banner is a side effect of the supersession
decision, exactly as a `retired`/`deprecated` ledger row is a side effect of a
code supersession decision. Code annotations and doc banners are two
arms of one acceptance-checklist rule, not two systems.
