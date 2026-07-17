# hydra-target-build — Anchor preflight reference (Steps 2.1, 3.1, 3.2)

Read this file when you need the full detail for the anchor-selection preflight
(Step 2.1 — shipped-anchor guard) and the grounding preflights (Steps 3.1 — ledger
intersection, 3.2 — doc banner check). All three run before code is written.

Cross-reference drift check. Skip if recently merged.

#### 2.1. Shipped-anchor preflight (issue #2771) — reject a board anchor already merged to origin/main

Under ADR-0031 the Target board is GitHub Issues on `gaberoo322/hydra-betting`, and the merged/shipped-subject suppression that the Redis `work-queue-hygiene` reconciler used to run (`src/backlog/work-queue-hygiene.ts`, cause `shipped-subject`, issue #2482) is retired along with the work queue. Its role is now enforced `Closes #N` close-discipline (ADR-0031 Decision 5) — a merged PR auto-closes its issue, so a shipped anchor normally never resurfaces on the open board. But an issue whose work landed on `origin/main` via a PR that did NOT cite `Closes #N` (or a hand-filed dup of already-shipped work) can still sit open on the board and be picked. This preflight closes that window at anchor-select time. Run it ONLY when the anchor came from the board pick (Step 2 priority 3); a failing-test / priorities anchor is not a board issue and skips this check.

**Invariants (do NOT weaken these):**
- **Positive-evidence-only removal.** The *absence* of a matching `#NNN` /
  `item-NNN` token or an `origin/main` commit is NEVER proof the anchor shipped
  — that is the documented 92%-false-positive polarity (#2031 / #2110 / #2482).
  Removal requires a POSITIVE subject-coverage hit: the anchor subject's
  significant words (length > 3, ≥ 4 of them) must be ≥ 70% contained in a
  concrete recent `origin/main` commit blob (the same asymmetric-containment
  polarity as `subjectCoveredBy` in `src/backlog/token-algebra.ts`).
- **Fail-open on uncertainty.** Any unreachable `git` / empty log / short-title
  anchor (< 4 significant words) KEEPS the anchor — the preflight degrades to a
  no-op, mirroring the retired `reconcileWorkQueue` polarity and `subjectCoveredBy`.
- **Friction cue still emitted post-close.** On a positive shipped-on-main
  hit, still record the `target-build-anchor-already-shipped-on-main` friction
  cue (pattern-memory bookkeeping) even though the issue is closed — this
  is how the learning system keeps the recurrence signal alive.
- **Worktree isolation preserved.** Read `origin/main` from **inside
  `$TARGET_WT/web`** (the worktree is already branched off `origin/main` in Step
  0.6) via `git log`. NEVER `git checkout` / `git pull` in the `~/hydra-betting`
  main tree.

```bash
# Only meaningful for a BOARD anchor (Step 2 priority 3). ANCHOR_NUM is the
# hydra-betting issue number claimed in Step 2; ANCHOR_SUBJECT is that issue's
# title (the descriptive subject). A failing-test / priorities anchor has no
# ANCHOR_NUM and skips this preflight entirely.
if [ -n "${ANCHOR_NUM:-}" ] && [ -n "${ANCHOR_SUBJECT:-}" ]; then
  # Significant-word guard: < 4 words of length > 3 → never subject-match
  # (short/generic titles like "fix tests" would spuriously hit — the #2482
  # SUBJECT_MATCH_MIN_WORDS guard, mirrored here).
  SIG_WORDS=$(printf '%s' "$ANCHOR_SUBJECT" | tr 'A-Z' 'a-z' \
    | tr -cs 'a-z0-9' '\n' | awk 'length>3' | sort -u | sed '/^$/d')
  SIG_COUNT=$(printf '%s\n' "$SIG_WORDS" | sed '/^$/d' | wc -l | tr -d ' ')

  SHIPPED_ON_MAIN=0
  if [ "$SIG_COUNT" -ge 4 ]; then
    # Recent origin/main commit blobs, read from INSIDE the worktree (never the
    # main checkout). `git log` failing (detached/empty) → empty COMMIT_WORDS →
    # zero coverage → fail-open keep.
    COMMIT_WORDS=$(git -C "$TARGET_WT/web" log origin/main --format='%s%n%b' -n 100 2>/dev/null \
      | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '\n' | sort -u | sed '/^$/d')
    if [ -n "$COMMIT_WORDS" ]; then
      # Asymmetric containment: fraction of the anchor's significant words present
      # in the commit blob. score = |anchorWords ∩ commitWords| / |anchorWords|.
      OVERLAP=$(comm -12 \
        <(printf '%s\n' "$SIG_WORDS") \
        <(printf '%s\n' "$COMMIT_WORDS") | wc -l | tr -d ' ')
      # ≥ 0.70 coverage → positive shipped-on-main evidence (integer math: 100*overlap >= 70*count).
      if [ $((100 * OVERLAP)) -ge $((70 * SIG_COUNT)) ]; then
        SHIPPED_ON_MAIN=1
      fi
    fi
  fi

  if [ "$SHIPPED_ON_MAIN" = "1" ]; then
    echo "shipped-on-main: anchor subject covered by recent origin/main — closing dup + re-selecting"
    # 1. Close the already-shipped board issue as a dup and clear the claim label.
    #    REST-only (`gh issue close` / `gh issue edit`); never GraphQL (ADR-0031 Decision 6).
    gh issue edit "$ANCHOR_NUM" --repo gaberoo322/hydra-betting --remove-label in-progress 2>/dev/null || true
    gh issue close "$ANCHOR_NUM" --repo gaberoo322/hydra-betting --reason completed \
      --comment "Already shipped on origin/main (subject-coverage ≥70% at anchor-select preflight) — closing as duplicate of merged work."
    # 2. Emit the friction cue (pattern-memory bookkeeping — MUST still fire).
    hydra raw POST /memory/subagent-friction "{
      \"skill\":\"hydra-target-build\",
      \"cue\":\"target-build-anchor-already-shipped-on-main\",
      \"workaround\":\"closed shipped board issue as dup; selected next candidate\",
      \"context\":\"origin/main subject-coverage hit at anchor-select preflight\",
      \"cycleId\":\"$CYCLE_ID\"
    }"
    # 3. Fall through to the next candidate (re-run the priority order from the
    #    top; the closed issue is off the open board, so the next board pick is a
    #    fresh candidate).
    echo "re-select the next candidate before proceeding to Step 3"
  fi
fi
```

Positive coverage closes the dup + re-selects; anything short of it (short title,
unreachable `git`, empty log, < 70% coverage) keeps the anchor and proceeds.
Enforced `Closes #N` close-discipline (ADR-0031 Decision 5) is the durable
suppression — this preflight is only the residual guard for a board issue whose
work shipped without a `Closes` linkage. ADR-0031 Decision 5 retains the
positive-evidence `merged-refs` / `token-algebra` matchers as an OPTIONAL
reconciler sweep, not a hot-path gate.

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

The ledger lives in the Target repo at `~/hydra-betting/docs/agents/wiring-status.md`
(read-only, main checkout copy is fine for planning — no write needed).

```bash
# --- 0. Populate SCOPE_IN from the plan's scopeBoundary.in ---
# SUBSTITUTE the real plan scope here: one web/-relative file OR directory
# prefix per line, exactly as computed for scopeBoundary.in in Step 3. This
# MUST be assigned before the intersection loops below use it — an empty
# SCOPE_IN makes both read loops iterate once on a blank line, so every hit
# list comes back empty and the preflight silently PASSES (a no-op). The two
# lines below are a placeholder EXAMPLE — replace them with your plan's scope:
SCOPE_IN="web/src/lib/execution/directional-clv-sizing.ts
web/src/lib/execution/directional-disagreement-signal.ts"

# --- 1. Read the ledger rows ---
WIRING_STATUS_PATH="$HOME/hydra-betting/docs/agents/wiring-status.md"

# Ledger-missing guard — degrade gracefully if the ledger file is absent.
# A missing wiring-status.md must NOT block the build (read-only advisory
# check); log a friction cue and proceed to Step 3.5 as if the preflight
# passed. This guard MUST sit before the WOR_ROWS/AW_ROWS extraction so the
# `grep`s below never run against a nonexistent path.
if [ ! -f "$WIRING_STATUS_PATH" ]; then
  echo "warn: wiring-status.md not found at $WIRING_STATUS_PATH — grounding preflight skipped (cue: grounding-preflight-ledger-missing)"
  # POST friction cue so the operator knows the ledger is missing.
  hydra raw POST /memory/subagent-friction "{
    \"skill\":\"hydra-target-build\",
    \"cue\":\"grounding-preflight-ledger-missing\",
    \"workaround\":\"skipped ledger intersection — wiring-status.md absent\",
    \"context\":\"$WIRING_STATUS_PATH\",
    \"cycleId\":\"${CYCLE_ID:-unknown}\"
  }" 2>/dev/null || true
  # Do not exit the build — proceed to Step 3.5 as if the preflight passed.
else

# Extract wire-or-retire paths (table column 1, status column 2)
WOR_ROWS=$(grep '| wire-or-retire |' "$WIRING_STATUS_PATH" \
  | sed 's/.*`\(web\/[^`]*\)`.*/\1/')

# Extract awaiting-wiring paths
AW_ROWS=$(grep '| awaiting-wiring |' "$WIRING_STATUS_PATH" \
  | sed 's/.*`\(web\/[^`]*\)`.*/\1/')

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
    gh issue edit "$ANCHOR_NUM" --repo gaberoo322/hydra-betting \
      --remove-label in-progress --remove-label ready-for-agent --add-label reframe 2>/dev/null || true
  fi

  # Emit reframe-save event — this is the token-value receipt for the epic.
  REFRAME_PAYLOAD=$(jq -n \
    --arg anchorRef "${ANCHOR_REF:-unknown}" \
    --arg reason "wire-or-retire ledger hit — grounding preflight stopped the build" \
    --arg hits "$(printf '%b' "$HIT_WOR" | tr '\n' ';')" \
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
    gh issue edit "$ANCHOR_NUM" --repo gaberoo322/hydra-betting \
      --remove-label in-progress --remove-label ready-for-agent --add-label reframe 2>/dev/null || true
  fi

  REFRAME_PAYLOAD=$(jq -n \
    --arg anchorRef "${ANCHOR_REF:-unknown}" \
    --arg reason "awaiting-wiring ledger hit — grounding preflight stopped rebuild, steering toward wiring" \
    --arg hits "$(printf '%b' "$HIT_AW" | tr '\n' ';')" \
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
newline-separated list of `web/`-relative file paths from the Step 3 plan
boundary (`scopeBoundary.in`). Replace the placeholder example there with your
plan's actual scope before running the snippet; the assignment must precede the
intersection loops (an unset `SCOPE_IN` makes the preflight a silent no-op).

**Failure modes:**
- Ledger file missing (`wiring-status.md` not found) → `grep` exits non-zero
  but the guard emits an empty `HIT_WOR`/`HIT_AW` — the preflight passes
  silently. Log a friction cue (`grounding-preflight-ledger-missing`) so the
  operator knows the file needs to exist. **Never fail the build on a missing
  ledger — it is a read-only advisory check.**
- `jq` unavailable → the event publish fails; log and continue (non-fatal).
- `gh issue edit … --add-label reframe` fails → log and continue (non-fatal; the
  issue keeps its current labels — a manual reframe-label is preferred over a
  blocked build).

The ledger-missing guard for the first case is woven into the snippet above
(step 1, right after `WIRING_STATUS_PATH` is set and before the `WOR_ROWS`
extraction) so it is always reached.

### 3.2. Grounding preflight — doc banner check (issue #2728)

**Run this alongside the ledger intersection (Step 3.1), before finalising the
plan.** A superseded direction doc is a dead premise exactly like a
wire-or-retire ledger row: planning from `north-star.md` or a retired M12 /
cross-venue-arb framing doc (post hydra-betting ADR-0002) has burned whole build
cycles. The doc-supersession slice makes that status machine-readable so the
preflight can refuse to ground on it.

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
GROUND_DOCS="$HOME/hydra-betting/docs/north-star.md
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
    gh issue edit "$ANCHOR_NUM" --repo gaberoo322/hydra-betting \
      --remove-label in-progress --remove-label ready-for-agent --add-label reframe 2>/dev/null || true
  fi

  # Emit reframe-save event — same token-value receipt as the ledger gate.
  REFRAME_PAYLOAD=$(jq -n \
    --arg anchorRef "${ANCHOR_REF:-unknown}" \
    --arg reason "superseded-doc banner hit — grounding preflight stopped the build" \
    --arg hits "$(printf '%b' "$HIT_DOCS" | tr '\n' ';')" \
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
