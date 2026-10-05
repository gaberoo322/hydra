# hydra-target-build — Anchor preflight reference (Steps 2.1, 3.1, 3.2)

Read this file when you need the full detail for the anchor-selection preflight
(Step 2.1 — shipped-anchor guard) and the grounding preflights (Steps 3.1 — ledger
intersection, 3.2 — doc banner check). All three run before code is written.

Cross-reference drift check. Skip if recently merged.

#### 2.1. Shipped-anchor preflight (issue #2771) — skip a board anchor already merged to origin/main, non-destructively (issue #4167)

Under ADR-0031 the Target board is GitHub Issues on `$TARGET_GH_REPO`, and the merged/shipped-subject suppression that the Redis `work-queue-hygiene` reconciler used to run (`src/backlog/work-queue-hygiene.ts`, cause `shipped-subject`, issue #2482) is retired along with the work queue. Its role is now enforced `Closes #N` close-discipline (ADR-0031 Decision 5) — a merged PR auto-closes its issue, so a shipped anchor normally never resurfaces on the open board. But an issue whose work landed on `origin/main` via a PR that did NOT cite `Closes #N` (or a hand-filed dup of already-shipped work) can still sit open on the board and be picked. This preflight closes that selection window at anchor-select time — **non-destructively (issue #4167)**: a positive verdict skips the anchor for this pick and flags it; it NEVER closes or relabels the board issue. Run it ONLY when the anchor came from the board pick (Step 2 priority 3); a failing-test / priorities anchor is not a board issue and skips this check.

**Invariants (do NOT weaken these):**
- **Positive-evidence-only skip, exact closing-ref (issue #4279).** Skip iff at
  least ONE commit reachable from `origin/main` carries a closing-keyword
  reference to the anchor's OWN number in its subject+body blob:
  `close[sd]?|fix(e[sd])?|resolve[sd]?`, optional `:`, then `#<ANCHOR_NUM>` not
  followed by a digit (case-insensitive). Plain mentions (`part of #N`,
  `refs #N`, `after #N lands`, a `(#N)` PR-number suffix) and subject/body
  vocabulary overlap are NEVER evidence. History: #2482 vocabulary matcher ->
  #3461 inline union -> #4167 per-commit scorer; all 6 recorded hits were false
  positives (0 true), so similarity matching is deleted, not tuned. Do not
  reintroduce it "for recall".
- **Reopened-issue guard.** Before skipping, read the issue's events once
  (REST). Any `reopened` event KEEPS the anchor: a reopen is a conscious
  forward-fix decision, and close+reopen is the operator override for a stuck
  false positive.
- **Fail-open on uncertainty.** Unreachable `git`, empty log, missing
  `ANCHOR_NUM`, or a failed events read KEEPS the anchor.
- **Non-destructive on hit.** A positive verdict skips the anchor and falls
  through to the next candidate. It NEVER closes the issue; its only board write
  is clearing this preflight's own `in-progress` claim. A keep verdict (including
  one from the reopened guard) posts nothing and relabels nothing.
- **Friction cue still emitted on skip.** A positive verdict records the
  `target-build-anchor-skip-suspected-shipped` cue (name byte-identical, so
  Pattern Memory escalation stays unfragmented); only the `context` text names
  the matched commit.
- **Worktree isolation preserved.** Read `origin/main` from **inside
  `$TARGET_WT`** via one `git log`. NEVER `git checkout` / `git pull` in
  `$TARGET_WS`. REST `gh api` only, never GraphQL (ADR-0031 Decision 6).

```bash
# Only meaningful for a BOARD anchor (Step 2 priority 3). ANCHOR_NUM is the
# target issue number claimed in Step 2. A failing-test / priorities anchor has
# no ANCHOR_NUM and skips this preflight entirely.
if [ -n "${ANCHOR_NUM:-}" ]; then
  SHIPPED_ON_MAIN=0
  # Guard-compatible (issue #3896): no process substitution, shell loops, or
  # nested $( $( ) ). One log call into a temp blob, one awk pass over it.
  BLOB_TMP=$(mktemp)
  git -C "$TARGET_WT" log origin/main -n 1000 --format='%x1e%H%n%s%n%b' > "$BLOB_TMP" 2>/dev/null
  MATCH=$(awk -v NUM="$ANCHOR_NUM" '
    BEGIN {
      RS = "\036"                     # one record = one commit
      re = "(^|[^a-z0-9])(close[sd]?|fix(e[sd])?|resolve[sd]?)[ \t]*:?[ \t]*#" NUM "([^0-9]|$)"
    }
    {
      if (match(tolower($0), re) && substr(tolower($0), 1, RSTART) !~ /(not|n.t|never|without)[ \t]+$/) {
        split($0, ln, "\n")
        ref = substr(tolower($0), RSTART, RLENGTH)
        gsub(/[ \t\n]+/, " ", ref)
        print ln[1] "|" ref
        exit
      }
    }
  ' "$BLOB_TMP")
  rm -f "$BLOB_TMP"

  if [ -n "$MATCH" ]; then
    # Reopened-issue guard: one REST read, only on a hit. A failed read keeps.
    if EVENTS_OUT=$(gh api "repos/$TARGET_GH_REPO/issues/$ANCHOR_NUM/events" --paginate \
        --jq '.[] | select(.event == "reopened") | .event' 2>/dev/null); then
      if [ -z "$EVENTS_OUT" ]; then
        SHIPPED_ON_MAIN=1
      fi
    fi
  fi

  if [ "$SHIPPED_ON_MAIN" = "1" ]; then
    echo "shipped-on-main: origin/main commit ${MATCH%%|*} carries a closing ref to #$ANCHOR_NUM — skipping anchor (non-destructive) + re-selecting"
    # Only board write: clear our own claim. NEVER close, never relabel.
    gh issue edit "$ANCHOR_NUM" --repo "$TARGET_GH_REPO" --remove-label in-progress 2>/dev/null || true
    # Friction cue (cue name unchanged — escalation idempotency).
    hydra raw POST /memory/subagent-friction "{
      \"skill\":\"hydra-target-build\",
      \"cue\":\"target-build-anchor-skip-suspected-shipped\",
      \"workaround\":\"skipped suspected-shipped board anchor (no close, no relabel); selected next candidate\",
      \"context\":\"origin/main commit ${MATCH%%|*} closing-ref '${MATCH#*|}' at anchor-select preflight\",
      \"cycleId\":\"$CYCLE_ID\"
    }"
    echo "select the next candidate before proceeding to Step 3"
  fi
fi
```

The scan is bounded to the newest 1000 `origin/main` commits (a shipped anchor's closer is recent; unbounded history per pick is wasted work). The keyword and `#N` must share a line (`[ \t]*` separator), and a directly preceding negation (`not`/`n't`/`never`/`without`) disqualifies the hit; residual class: only the first keyword hit per commit is judged, so a negated hit shadows a later genuine one in the same commit (fails safe: keeps the anchor).

An exact closing ref skips the anchor + re-selects (non-destructively; the issue
stays open, flagged only by the friction cue); anything short of it (no ref,
plain mention, reopened issue, unreachable `git`, failed events read) keeps the
anchor. Enforced `Closes #N` close-discipline (ADR-0031 Decision 5) is the
durable suppression; this preflight is only the residual guard for a board issue
whose work shipped with a closing ref but never got closed (#3700). A hand-filed
duplicate with no issue reference is NOT this preflight's job: it is the lexical
dedup at file time that ADR-0031 Decision 5 accepted as the downgrade.

### 3.1. Grounding preflight — ledger intersection (issue #2727)

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

The ledger lives in the Target repo at `$TARGET_WS/docs/agents/wiring-status.md`
(read-only, main checkout copy is fine for planning — no write needed).

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
WIRING_STATUS_PATH="$TARGET_WS/docs/agents/wiring-status.md"

# Ledger-missing guard — never blocks the build (read-only advisory check);
# either way proceed to Step 3.5. Sits before the WOR_ROWS/AW_ROWS extraction
# so the `grep`s below never run against a nonexistent path.
if [ ! -f "$WIRING_STATUS_PATH" ]; then
  # A ledger is EXPECTED only if the Target ships its generator (issue #4531).
  # Positive evidence only: no/malformed package.json or no jq => not expected.
  LEDGER_GENERATOR=$(jq -r '.scripts["deadcode:ledger"] // empty' \
    "$TARGET_WS/${TARGET_APP_SUBDIR:+$TARGET_APP_SUBDIR/}package.json" 2>/dev/null || true)
  if [ -n "$LEDGER_GENERATOR" ]; then
    echo "warn: wiring-status.md not found at $WIRING_STATUS_PATH — grounding preflight skipped (cue: grounding-preflight-ledger-missing)"
    hydra raw POST /memory/subagent-friction "{
      \"skill\":\"hydra-target-build\",
      \"cue\":\"grounding-preflight-ledger-missing\",
      \"workaround\":\"skipped ledger intersection — wiring-status.md absent\",
      \"context\":\"$WIRING_STATUS_PATH\",
      \"cycleId\":\"${CYCLE_ID:-unknown}\"
    }" 2>/dev/null || true
  else
    echo "Grounding preflight: Target declares no wiring ledger (no deadcode:ledger script) — ledger intersection skipped."
  fi
else

# Extract wire-or-retire paths (table column 1, status column 2). The path is
# the backticked FIRST column, whatever its prefix — no app-subdir assumption, so
# a repo-root Target (appSubdir "") and a nested app extract identically (#4553).
# `sed -n …p` prints only rows that match, never a raw table line.
WOR_ROWS=$(grep '| wire-or-retire |' "$WIRING_STATUS_PATH" \
  | sed -n 's/^|[[:space:]]*`\([^`]*\)`.*/\1/p')

# Extract awaiting-wiring paths
AW_ROWS=$(grep '| awaiting-wiring |' "$WIRING_STATUS_PATH" \
  | sed -n 's/^|[[:space:]]*`\([^`]*\)`.*/\1/p')

# --- 2. Intersect against the plan's scopeBoundary.in ---
# SCOPE_IN was assigned at step 0 above (the newline-separated list of
# files/prefixes from Step 3's plan).
# Use a simple substring match: a scope entry S "hits" a ledger row L when
# S is a prefix of L or L is a prefix of S (covers both file and directory
# scope entries). This is intentionally broad — false positives stop the
# cycle (cheap); false negatives let bad work through (expensive).

HIT_WOR=""
for row in $WOR_ROWS; do
  while IFS= read -r scope_entry; do
    # Strip leading/trailing whitespace and backticks from scope entry
    clean_entry=$(printf '%s' "$scope_entry" | tr -d '`' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    [ -z "$clean_entry" ] && continue
    if printf '%s' "$row" | grep -qF "$clean_entry" || \
       printf '%s' "$clean_entry" | grep -qF "$row"; then
      HIT_WOR="$HIT_WOR  $row (hits scope: $clean_entry)\n"
    fi
  done <<EOF
$SCOPE_IN
EOF
done

HIT_AW=""
for row in $AW_ROWS; do
  while IFS= read -r scope_entry; do
    clean_entry=$(printf '%s' "$scope_entry" | tr -d '`' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
    [ -z "$clean_entry" ] && continue
    if printf '%s' "$row" | grep -qF "$clean_entry" || \
       printf '%s' "$clean_entry" | grep -qF "$row"; then
      HIT_AW="$HIT_AW  $row (hits scope: $clean_entry)\n"
    fi
  done <<EOF
$SCOPE_IN
EOF
done

# --- 3. Decision gate ---
if [ -n "$HIT_WOR" ]; then
  # HARD STOP-AND-REFRAME: wire-or-retire module in scope.
  echo "GROUNDING PREFLIGHT STOP: wire-or-retire ledger hit(s):"
  printf '%b\n' "$HIT_WOR"
  echo "Action: STOP-AND-REFRAME — a wire-or-retire decision is pending for these modules."
  echo "Do NOT build. Write the reframe verdict, label the issue reframe, emit the event."

  # Mark the anchor issue for reframe (ADR-0031 Decision 4/5 — the `reframe`
  # label replaces the retired Redis reframe-queue). REST-only relabel: clear the
  # in-progress claim and stamp reframe so the item leaves the build lane and the
  # next pick reads the context. `TARGET_SPECIFIC_LABELS.reframe` = "reframe"
  # (src/target-board-labels.ts). No `hydra backlog` write.
  if [ -n "${ANCHOR_NUM:-}" ]; then
    gh issue edit "$ANCHOR_NUM" --repo "$TARGET_GH_REPO" \
      --remove-label in-progress --remove-label ready-for-agent --add-label reframe 2>/dev/null || true
  fi

  # Emit reframe-save event — this is the token-value receipt for the epic.
  # Guard-compatible form (issue #3896): the worktree-isolation Bash guard
  # refuses the nested `$(jq ... --arg hits "$(printf|tr)")`. Collapse HIT_WOR
  # into a plain variable first, then interpolate — identical jq payload.
  REFRAME_HITS=$(printf '%b' "$HIT_WOR" | tr '\n' ';')
  REFRAME_PAYLOAD=$(jq -n \
    --arg anchorRef "${ANCHOR_REF:-unknown}" \
    --arg reason "wire-or-retire ledger hit — grounding preflight stopped the build" \
    --arg hits "$REFRAME_HITS" \
    '{type: "target:reframe-save", payload: {anchorRef: $anchorRef, reason: $reason, hits: $hits}}')
  hydra raw POST /events/publish "$REFRAME_PAYLOAD" 2>/dev/null || \
    echo "warn: event publish failed (non-fatal)"

  # Stop. The lane is updated; the decision loop will re-examine on the next tick.
  exit 0

elif [ -n "$HIT_AW" ]; then
  # SOFT STOP-AND-REFRAME: awaiting-wiring module in scope.
  echo "GROUNDING PREFLIGHT STOP: awaiting-wiring ledger hit(s):"
  printf '%b\n' "$HIT_AW"
  echo "Action: STOP-AND-REFRAME — these modules are awaiting-wiring (built but not yet wired)."
  echo "The correct move is to wire the existing module, NOT rebuild it."
  echo "Reframe the plan toward a wiring task (add the runtime import / route / API call)."

  # Mark the anchor issue for reframe (ADR-0031 Decision 4/5 — `reframe` label,
  # not the retired Redis reframe-queue). REST-only relabel; no `hydra backlog`.
  if [ -n "${ANCHOR_NUM:-}" ]; then
    gh issue edit "$ANCHOR_NUM" --repo "$TARGET_GH_REPO" \
      --remove-label in-progress --remove-label ready-for-agent --add-label reframe 2>/dev/null || true
  fi

  # Guard-compatible form (issue #3896): split HIT_AW into a plain variable
  # first (same nested-`$( $( ) )` avoidance as the wire-or-retire branch above).
  REFRAME_HITS=$(printf '%b' "$HIT_AW" | tr '\n' ';')
  REFRAME_PAYLOAD=$(jq -n \
    --arg anchorRef "${ANCHOR_REF:-unknown}" \
    --arg reason "awaiting-wiring ledger hit — grounding preflight stopped rebuild, steering toward wiring" \
    --arg hits "$REFRAME_HITS" \
    '{type: "target:reframe-save", payload: {anchorRef: $anchorRef, reason: $reason, hits: $hits}}')
  hydra raw POST /events/publish "$REFRAME_PAYLOAD" 2>/dev/null || \
    echo "warn: event publish failed (non-fatal)"

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
  expected (the app `package.json` has a `deadcode:ledger` script) → friction
  cue `grounding-preflight-ledger-missing`. Not expected, or the probe is
  uncertain → one stdout line, no friction. **Never fail the build on a missing
  ledger — it is a read-only advisory check.**
- `jq` unavailable → the event publish fails; log and continue (non-fatal).
- `gh issue edit … --add-label reframe` fails → log and continue (non-fatal; the
  issue keeps its current labels — a manual reframe-label is preferred over a
  blocked build).

The two-branch ledger-missing guard is woven into the snippet above (step 1,
before the `WOR_ROWS` extraction) so it is always reached.

### 3.2. Grounding preflight — doc banner check (issue #2728)

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

  # Mark the anchor issue for reframe (ADR-0031 Decision 4/5 — `reframe` label,
  # not the retired Redis reframe-queue). REST-only relabel; no `hydra backlog`.
  if [ -n "${ANCHOR_NUM:-}" ]; then
    gh issue edit "$ANCHOR_NUM" --repo "$TARGET_GH_REPO" \
      --remove-label in-progress --remove-label ready-for-agent --add-label reframe 2>/dev/null || true
  fi

  # Emit reframe-save event — same token-value receipt as the ledger gate.
  # Guard-compatible form (issue #3896): split HIT_DOCS into a plain variable
  # first (same nested-`$( $( ) )` avoidance as the ledger branches above).
  REFRAME_HITS=$(printf '%b' "$HIT_DOCS" | tr '\n' ';')
  REFRAME_PAYLOAD=$(jq -n \
    --arg anchorRef "${ANCHOR_REF:-unknown}" \
    --arg reason "superseded-doc banner hit — grounding preflight stopped the build" \
    --arg hits "$REFRAME_HITS" \
    '{type: "target:reframe-save", payload: {anchorRef: $anchorRef, reason: $reason, hits: $hits}}')
  hydra raw POST /events/publish "$REFRAME_PAYLOAD" 2>/dev/null || \
    echo "warn: event publish failed (non-fatal)"

  exit 0
else
  echo "Doc-banner check: no superseded docs in the plan's grounding set — proceeding."
fi
```

**Failure modes:**
- Doc file missing → skipped, never a hit (a doc that does not exist can't be a
  dead premise). The check is read-only advisory, same as the ledger gate.
- Banner not on the first non-blank line → not detected. The banner contract is
  first-non-blank-line placement; the doc-supersession slice (#2725-style
  generator) is responsible for stamping it there.
- `GROUND_DOCS` empty/unset → the check is a silent no-op (the plan grounds on
  no docs). Populate it from the plan's rationale sources, mirroring the
  `SCOPE_IN` discipline in Step 3.1.

**ADR acceptance-checklist rule (doc supersession).** Doc banners are the
doc-side arm of the same rule that stamps code ledger annotations: **when an ADR
(or equivalent operator supersession decision) retires a doc's premise, the
acceptance checklist for that decision requires stamping the retired doc with
the STATUS-superseded banner in the same change.** There is no separate
doc-lifecycle process — the banner is a side effect of the supersession
decision, exactly as a `retired`/`deprecated` ledger row is a side effect of a
code supersession decision (#2724). Code annotations and doc banners are two
arms of one acceptance-checklist rule, not two systems.
