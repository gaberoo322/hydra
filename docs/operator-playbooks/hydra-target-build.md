---
name: hydra-target-build
description: Run a complete Hydra development build — picks a task, plans, challenges, executes, verifies, merges, and syncs state. Delegates to a subagent for context window protection when a spawn tool is available; otherwise runs under the explicit inline-mode contract (issue #1782).
when_to_use: "When the user wants to build a feature, fix a bug, run a dev cycle, or says 'build', 'ship', 'execute'"
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*) WebSearch(*) WebFetch(*)
arguments: [task]
---

# Hydra Build

Run one complete Hydra development build operating as every agent (planner, skeptic, executor, reporter). You write the code yourself — do NOT call Codex or the Hydra scheduler.

To prevent context window saturation under `/loop`, delegate the build to a child **when a spawn capability exists**:
- **Claude:** spawn an `Agent` with the build prompt below.
- **Codex:** `codex exec --skill hydra-target-build` as a subprocess.

Autopilot dispatch sessions carry NO Agent/Task spawn tool (issue #1782). In that environment the build runs under the **explicit inline-mode contract** in Step 2 — silently running the child prompt inline as an undeclared fallback is forbidden, and so is aborting just because the spawn tool is absent.

In delegated mode the parent only does pre-flight + relays the summary. The child does the heavy work.

## Step 1: Pre-flight (parent context)

Before delegating, run:

**Concurrency check (Claude only — does NOT block on Codex cycles):**
```bash
CLAUDE_LOCK=$(docker exec hydra-redis-1 redis-cli GET hydra:cycle:active:claude 2>/dev/null)
if [ -n "$CLAUDE_LOCK" ]; then echo "BLOCKED: another Claude cycle running ($CLAUDE_LOCK)"; fi
```

**WIP limit check:**
```bash
hydra backlog ls | python3 -c "
import json,sys
d=json.load(sys.stdin)
ip=d.get('inProgress',[])
if len(ip) >= 3:
    print(f'BLOCKED: WIP limit reached ({len(ip)}/3 in-progress)')
    for i in ip: print(f'  {i[\"id\"]} — {i[\"title\"][:60]}')
    sys.exit(1)
"
```

If either fails, stop. Do not delegate.

## Step 2: Delegate — or declare inline mode (issue #1782)

**Mode detection (mandatory, before any build work):** determine whether an `Agent`/`Task` spawn tool is actually callable in THIS session. If it is not in the loaded tool list, make exactly ONE `ToolSearch` query (e.g. `+agent spawn task`) against the deferred-tool list, then commit to a mode. Do not retry the search, and do not assume availability either way.

**Delegated mode (spawn tool available):** spawn the child with the prompt below. Pass `$task` if provided. The child returns ONLY a summary table, reporting `Mode | delegated` in its Step 10 row. This path is unchanged — builds dispatched with the spawn tool available continue to delegate normally.

**Inline mode (no spawn tool):** executing the child prompt in the parent session is permitted ONLY under this explicit contract — never as a silent fallback. Do NOT abort merely because the spawn tool is absent: the dispatch environment never grows the tool mid-session, so fail-loud here would zero Target throughput rather than reroute anywhere useful.

1. **Declare the mode loudly.** Before Step 0, state in the session output: `INLINE MODE: no Agent/Task spawn tool in this session; executing the child prompt inline under the issue #1782 contract.` Report `Mode | inline` in the Step 10 summary table.
2. **Friction-log the occurrence at detection time** (idempotent on `(skill, cue)`; best-effort — a POST failure never blocks the build):
   ```bash
   hydra raw POST /memory/subagent-friction "{
     \"skill\":\"hydra-target-build\",
     \"cue\":\"no-agent-spawn-tool-run-inline\",
     \"workaround\":\"declared inline mode per issue #1782 contract; applied context-budget discipline\",
     \"context\":\"autopilot dispatch session without Agent/Task spawn tool\",
     \"cycleId\":\"inline-$(date -u +%Y-%m-%d-%H%M)\"
   }"
   ```
3. **Context-budget discipline.** The one session must survive every later step (verify, merge, deploy, state sync), so the inline build spends context as if the saturation it causes lands on itself — because it does:
   - Targeted reads only: read specific files/line ranges you immediately need; never dump large files or broad directory listings into context.
   - Filter command output at the source (`--jq`, `grep`, `head`); never page raw `npm test` or journal output into context — capture to a file and grep the failure lines.
   - Cap task complexity at **standard** (Step 3): a **complex** (>5 files) plan MUST be split and re-queued, never built inline.
   - Skip optional exploration (broad greps, archaeology beyond Step 0.5's drift check) unless a verification failure forces it.
   - One remediation pass on a verification failure, then abandon the branch — tighter than delegated mode's "2 failed fixes" rule in Step 6.
4. **Everything else is unchanged.** All child-prompt steps (0–10), safety rules, gates, and state sync apply verbatim; "the child" simply means this session.

---

<child-prompt>
Full autonomy: pick the task, plan, challenge your own plan, execute, verify, merge, sync state, report. Don't ask the user. If you hit a blocker, solve it.

## CRITICAL SAFETY RULE — READ FIRST (issue #542)

Two repos are in play: `~/hydra` (orchestrator) and `~/hydra-betting` (target). The harness `isolation: "worktree"` ONLY creates a worktree of the orchestrator repo (`~/hydra`). Writes to `~/hydra-betting` paths bypass that isolation and land on the main hydra-betting checkout — that is the bug fixed by this preamble.

Before running ANY `git`, `npm`, `Edit`, or `Write` against the target repo:

1. Run `pwd` and `git rev-parse --git-dir`. If cwd is `/home/gabe/hydra-betting` (the main target tree), ABORT. If cwd is `/home/gabe/hydra-betting/web`, ABORT — same tree.
2. Create a dedicated hydra-betting worktree (Step 0.6 below) and `cd` into it.
3. Verify isolation: inside the new worktree, `git rev-parse --git-common-dir` must resolve to `/home/gabe/hydra-betting/.git` AND `git rev-parse --git-dir` must contain `.git/worktrees/`. ABORT otherwise.
4. From that point on, every Edit/Write/Bash file mutation against the target uses **the worktree path only** — never construct absolute paths under `/home/gabe/hydra-betting/...` directly. If you must use an absolute path, anchor it to `$TARGET_WT/...`.

No fallback. No `cd ~/hydra-betting` in any step below — those bare paths are historical and have been replaced by `$TARGET_WT` references. If `$TARGET_WT` is unset when a step needs it, ABORT — that means Step 0.6 was skipped.

### 0. Register cycle
```bash
CYCLE_ID="claude-cycle-$(date -u +%Y-%m-%d-%H%M)"
hydra raw POST /cycle/register "{\"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\"}"
```

### 0.6. Create hydra-betting worktree (issue #542)

Symmetric with how `hydra-dev` worktree-isolates `~/hydra`. The target repo (`~/hydra-betting`) is a separate git repo — the harness can't isolate it for us. Create one ourselves:

```bash
TARGET_WT="/dev/shm/hydra-worktrees/hydra-betting-worktree-${CYCLE_ID}"
mkdir -p "$(dirname "$TARGET_WT")"

# Ensure base is fresh before branching off.
git -C ~/hydra-betting fetch origin main --prune
git -C ~/hydra-betting worktree add -b "feature/${CYCLE_ID}" "$TARGET_WT" origin/main

cd "$TARGET_WT"

# Verify isolation — ABORT if either check fails. Do NOT proceed on the main checkout.
COMMON_DIR=$(git rev-parse --git-common-dir)
GIT_DIR=$(git rev-parse --git-dir)
case "$COMMON_DIR" in
  /home/gabe/hydra-betting/.git|*/hydra-betting/.git) ;;
  *) echo "ABORT: hydra-betting worktree common-dir is $COMMON_DIR (expected ~/hydra-betting/.git)" >&2; exit 1 ;;
esac
case "$GIT_DIR" in
  *"/.git/worktrees/"*) ;;
  *) echo "ABORT: hydra-betting cwd is not a worktree (git-dir=$GIT_DIR)" >&2; exit 1 ;;
esac

# Worktrees do not share node_modules with the main checkout — install once per worktree.
# Cost: ~30–60s. Acceptable; this is the price of parallel-safe target builds.
(cd "$TARGET_WT/web" && npm ci --prefer-offline --no-audit --no-fund)

# Mirror the Target SDLC gate scripts into the worktree (issue #1451). The gate
# scripts (mutation-check / target-design-concept / post-merge-health) and their
# small src closure live ONLY in this orchestrator repo and import `../../src/…`,
# so they do not exist in the hydra-betting checkout. This sync copies them into
# `$TARGET_WT/.hydra-gate/` (git-excluded, so it never pollutes the Target PR
# diff) so Steps 4.5 / 6.6 / 8.6 run the REAL gate from the worktree — never from
# ~/hydra, never by hand-rolling the money-critical classification.
bash ~/hydra/scripts/sync-target-gate.sh "$TARGET_WT"
```

`scripts/branch-prune.sh` (issue #443) sweeps `/dev/shm/hydra-worktrees/hydra-betting-worktree-*` so we don't have to clean these up on the happy path. We DO remove the worktree in Step 9 on success — leaking is only acceptable on crash. The `.hydra-gate/` mirror is inside the worktree, so it is GC'd with it.

### 0.5. Drift check
```bash
hydra metrics --count 10 | python3 -c "
import json,sys
d=json.load(sys.stdin)
recent=[m.get('taskTitle','') for m in d.get('trend',[]) if int(m.get('tasksMerged',0))>0]
if recent:
    print('Recently merged (do NOT re-propose):')
    for t in recent[:10]: print(f'  - {t}')
"
```

### 1. Ground (read-only, in $TARGET_WT/web/)
```bash
cd "$TARGET_WT/web"
npm test
npm run typecheck
git log --oneline -5
git status --short
```

Load context (parallel):
- `~/hydra/config/direction/priorities.md`
- `~/hydra/config/direction/vision.md`
- `~/hydra/config/feedback/to-planner.md`
- `~/hydra/config/feedback/to-executor.md`
- `hydra backlog ls`
- `docker exec hydra-redis-1 redis-cli LRANGE "hydra:anchors:work-queue" 0 4`
- `hydra memory planner` && `hydra memory executor`

> **Direction docs are a mirror — refresh if stale (issue #1791).** The
> `~/hydra/config/direction/{priorities,roadmap}.md` files loaded above are the
> orchestrator's COMMITTED copy and the runtime source of truth for the
> in-process readers (`readPriorities()` in `src/api/recommendations.ts`,
> `getCurrentMilestoneProgress()` in `src/backlog/reads.ts`). The LIVE docs that
> `/hydra-target-research` writes each cycle live in the Target repo at
> `$HYDRA_TARGET_REPO/direction/` (default `~/hydra-betting/direction/`).
> Nothing auto-syncs the two, so the orch copy can lag the research cycle by
> milestones — it was 3 milestones / 2 cycles stale on 2026-06-12. The
> `collect-state.sh` Phase-1 collector emits `direction_drift=true` when the
> committed orch copy no longer matches the live Target docs. When you see that
> signal (or notice the loaded `priorities.md` frontmatter `updated:` lagging
> the Target's), refresh the committed copy on a feature branch and open a PR —
> never write into `config/direction/` from a read-only collector or from the
> deploy tree (the #1739 dirty-tree hazard):
>
> ```bash
> cp "${HYDRA_TARGET_REPO:-$HOME/hydra-betting}"/direction/priorities.md ~/hydra/config/direction/priorities.md
> cp "${HYDRA_TARGET_REPO:-$HOME/hydra-betting}"/direction/roadmap.md   ~/hydra/config/direction/roadmap.md
> ```

> **Superseded direction docs are non-groundable — check the banner before you plan from a doc (issue #2728).** A direction doc whose premise has been retired carries a machine-readable header banner as its first non-blank content line:
>
> ```
> > **STATUS: superseded by <doc-or-ADR> on <YYYY-MM-DD>.** <one-line pointer to the current doc.>
> ```
>
> (e.g. the Target's `north-star.md`, documented stale-not-deprecated, and any M12 / cross-venue-arb framing docs post hydra-betting ADR-0002.) A banner'd doc is a dead premise: **do NOT plan from it** — exactly as the Step 3.1 grounding preflight refuses to build on a wire-or-retire ledger row. Read the banner's pointer and ground on the doc it names instead. This is a thin banner slice, NOT a doc-lifecycle system — there is no freshness scoring and no staleness detector. A banner is applied only when an explicit supersession decision happens, under the same **ADR acceptance-checklist rule** that governs code ledger annotations: *when an ADR (or an equivalent operator supersession decision) retires a doc's premise, the acceptance checklist requires stamping the retired doc with the STATUS-superseded banner in that same change — code annotations and doc banners are the two arms of one rule.*

### 2. Anchor (select task)

If operator gave a task, use it. Otherwise priority order:
1. Work queue: `docker exec hydra-redis-1 redis-cli LRANGE hydra:anchors:work-queue 0 0`
2. Failing tests
3. Typecheck errors
4. Queued backlog (atomic claim — prevents Codex collision):
   ```bash
   CLAIMED=$(hydra raw POST /backlog/claim '{"claimedBy":"claude"}')
   ```
   `claimed: false` → fall through to step 5.
5. Priorities doc (skip "What's been completed").

Cross-reference drift check. Skip if recently merged.

### 3. Plan (planner role)

Read `~/hydra/config/agents/planner.md` and `~/hydra/config/feedback/to-planner.md`. Read relevant source. Design ONE bounded task:
- ≤5 files, 3–5 testable criteria, scope boundary, advances vision, hard verification commands.

Complexity:
- **quick-fix** (≤2 files, ≤3 criteria, failing-test): skip skeptic.
- **standard** (3–5 files, 4–8 criteria): full ceremony.
- **complex** (>5 files): split.

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
  echo "Do NOT build. Write the reframe verdict, move the backlog lane, emit the event."

  # Move the item lane to match the verdict (lane-desync lesson):
  # requeue into backlog with a reframe note so the next pick reads the context.
  [ -n "$ITEM_ID" ] && hydra backlog move "$ITEM_ID" backlog 2>/dev/null || true

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

  [ -n "$ITEM_ID" ] && hydra backlog move "$ITEM_ID" backlog 2>/dev/null || true

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
- `hydra backlog move` fails → log and continue (non-fatal; the lane remains
  wherever it was — a manual fix is preferred over a blocked build).

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

  [ -n "$ITEM_ID" ] && hydra backlog move "$ITEM_ID" backlog 2>/dev/null || true

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

### 3.5. Self-declare scope (issue #396)

Because hydra-target-build picks its own task — there is no GitHub issue with a pre-existing scope contract — the child MUST write its own scope contract before opening the PR. This is the subagent-side replacement for the deleted `reconcilePlanVsActual()` step (control-loop step 6.5, removed in PR #400).

Compute the in-scope list from the plan's `scopeBoundary.in`. Record it locally so it can be embedded in the PR body in Step 7:

```bash
SCOPE_IN_LIST=$(cat <<'EOF'
- `web/src/foo.ts`
- `web/src/foo/`
EOF
)
```

If executing requires touching a file outside the planned scope (shared fixture, adjacent import), record a justification rationale at the same time:

```bash
SCOPE_JUSTIFICATIONS=$(cat <<'EOF'
scope-justification: `web/src/test-helpers.ts` — shared fixture required by the new test
EOF
)
```

CI's `scope-check` gate (`.github/workflows/ci.yml` in the orchestrator repo, mirrored in the target repo if present) reads these sections from the PR body. Skipping this step doesn't block the build today (no hard requirement on PR body shape for target-repo PRs), but it's how the orchestrator learns the subagent's intended blast radius — and it's the contract reviewers + `hydra-qa` use to spot scope creep.

### 3.6. Inject per-anchor Reflections (issue #841) + deposit reflection-source telemetry (issue #1136/#1912)

This step has TWO mandatory halves: (a) fetch + weave the reflection narrative,
and (b) deposit the reflection-source telemetry file. Do BOTH every build. Half
(b) — the "Reflection-source telemetry deposit" recipe lower in this section —
is NOT optional reference prose: skipping it is the #1912 regression where
`reflectionMatchSource` read `'none'` on 100% of cycles because no
`hydra-refl-sources-<task_id>` file ever landed for reap.py to read. Always run
the deposit block even when zero reflections were served (an empty result writes
no file, which reap.py correctly buckets to `none`).

A prior **failed** attempt on the same anchor (or, post-#326, a different
anchor that touched the same files) leaves a per-anchor **Reflection** —
"what was attempted, why it failed, what to change". Before #841 this
narrative reached code-writing dispatches only through the dead in-process
`buildPlannerContext`, so retries silently lost their own failure context
(the 0%-merge-rate condition #193 was created to fix). Fetch it live and
weave it into the plan before executing.

Fetch the per-anchor reflection narrative from the orchestrator. The endpoint
composes the existing per-anchor + by-file reflection reads server-side, so
the large narrative text stays out of `decide.py` (the dispatch JSON carries
only `{anchor, score}`):

```bash
# ANCHOR_REF is the selected anchor's reference (use anchor.reference, NOT
# task.title). FILES_CSV is the `scopeBoundary.in` list from Step 3.5,
# comma-separated.
REFL_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/reflections?anchor=$(printf '%s' "$ANCHOR_REF" | jq -sRr @uri)&files=$(printf '%s' "$FILES_CSV" | jq -sRr @uri)")

REFL_FORMATTED=$(printf '%s' "$REFL_JSON" | jq -r '.formatted // ""')
if [ -n "$REFL_FORMATTED" ]; then
  # This anchor (or a related file) failed before. Read the prior attempts and
  # do NOT repeat the same approach — fold REFL_FORMATTED into the plan you
  # hand the executor role in Step 5.
  printf '%s\n' "$REFL_FORMATTED"
fi
# Empty / unreachable → graceful no-op (degrade exactly as the dead path did on
# a miss). Never fail the build over a reflections miss.
```

**Reflection-source telemetry deposit (issue #1136 / #1912 — MANDATORY, at the
SAME planning-time step — run this every build, NOT optional reference prose):**
you MUST run the recipe below on every build, right after the reflection fetch
above and before handing the plan to the executor role. Omitting it is the exact
#1912 regression where `reflectionMatchSource` read `'none'` on 100% of cycles
because no `hydra-refl-sources-<task_id>` file ever landed for reap.py to read.
So the `reflectionMatchSource` cycle metric reflects what was actually
served (instead of reading `'none'` on every cycle), MAP the served block
sources to the bucket tokens `deriveReflectionMatchSource` matches and DEPOSIT
the comma-separated string to a task-scoped file. reap.py reads that file on its
single authoritative `cycle-record` write — do **NOT** POST `cycle-record`
yourself (reap is the sole writer; a competing POST loses the idempotency race
and silently dedups to a no-op).

CRITICAL mapping: the API emits `blocks[].source` = `per-anchor-reflections` /
`by-file-reflections`, but `deriveReflectionMatchSource` matches the BARE tokens
`per-anchor` / `by-file`. Emit the mapped tokens, never the raw API strings
(raw strings mis-bucket to `mixed`/`none`).

CRITICAL task_id source (issue #1945 — the deposit was landing under the WRONG
key on 100% of cycles). reap reads the deposit at `hydra-refl-sources-<task_id>`
where `<task_id>` is the **harness task id** — the 17-hex-char hash the Claude
Agent tool embeds in your worktree path (`.../worktrees/agent-<HASH>`) and
branch (`worktree-agent-<HASH>`). That hash flows into the slot's `task_id` and
is the only key reap ever reads. The two env vars the old recipe used are both
WRONG in this child build: `HYDRA_AUTOPILOT_TASK_ID` is **unset** inside the
worktree subagent (the harness does not export it), and `CLAUDE_CODE_SESSION_ID`
is the child's session UUID (e.g. `337671f0-…`) — a DIFFERENT id from the
harness hash, so a deposit keyed on it is never found and the metric stays
`'none'`. Derive the hash from your own cwd (`pwd` → `agent-<HASH>`), which is
authoritative and always present; only fall back to the env vars if the cwd is
somehow not an `agent-<HASH>` worktree (e.g. a `/dev/shm` layout).

@include _fragments/reflection-telemetry-deposit.md

To verify reflections actually reach a retry, query this `/api/reflections`
endpoint — NOT `/api/learning/context-trace`, which reports only
`getContext()`'s composition (a prompt no subagent receives on today's
architecture).

**Knowledge context — live API (issue #2647).** At the SAME planning-time step,
fetch the agent-scoped **knowledge context** — the learned patterns (prior-cycle
failures, successful tactics) OpenViking has indexed for this skill — and fold it
into the plan you hand the executor role. Before #2647 no build fetched it, so
`knowledgeContext.cyclesWithContext` read 0% on the health surface.

```bash
KB_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/learning/knowledge?agent=hydra-target-build&anchor=$(printf '%s' "$ANCHOR_REF" | jq -sRr @uri)")

KB_CONTENT=$(printf '%s' "$KB_JSON" | jq -r '.content // ""')
if [ -n "$KB_CONTENT" ]; then
  # Learned patterns for this agent from prior cycles — read them, avoid known
  # failures, reuse known-good tactics. Fold KB_CONTENT into the executor plan.
  printf '%s\n' "$KB_CONTENT"
fi
# Empty / unreachable → graceful no-op. Never fail the build over a
# knowledge-context miss.
```

The optional `anchor=<anchor.reference>` param (issue #2717 — e.g. the item id
you are building) lets the per-fetch knowledge-retrieval ledger record the join
key between this retrieval and the eventual cycle outcome; an anchor-less fetch
still succeeds (the ledger records a `null` anchor).

Use `/api/learning/knowledge`, NOT `/api/learning/context-trace`: the latter is
a counts-only diagnostic that omits block `.content` by design (#804/#841), so
there is nothing to weave into a plan. This route SERVES the content (like
`/api/reflections` serves `formatted`) and records the #1440 per-cycle
availability metric server-side on its success path — so the record stays
co-located with a real served fetch and you never touch the metric from a shell
block (which the single-quoted PR-body heredoc quoting would make fragile). It
ALSO appends one raw row per served fetch to the per-fetch knowledge-retrieval
ledger (issue #2717) — agent, anchor/cycle id, itemCount, and stable per-item
content-hash ids — so retrieval→outcome attribution becomes possible later; the
append is server-side and best-effort, exactly like the availability record.

### 4. Skeptic (skip for quick-fix)

Read `~/hydra/config/agents/skeptic.md`. Challenge:
1. Anchored to real artifact?
2. Duplicating recent work? (`git log --oneline -20`)
3. Scope bounded? >5 files → reject.
4. Verification hard? (shell commands, not "review")
5. Smallest possible move?
6. Before deleting, prove the module is truly orphaned — but a **single-line `from`-grep is a false-negative trap** (retro cue `multiline-import-misses-importer-grep`, recurrence 4): a live consumer whose `import { … }` list spans several lines puts the symbol and the `from "./x"` clause on *different* lines, so a `from.*['"].*<name>` regex matches neither line (this is why `verified-pairs.ts`'s multi-line import of `nba-finals-pair-seeding` read as zero-importer). It also misses relative + `.ts`-suffixed specifiers (a path-fragment regex like `arbitrage/mod` skips `./mod` and `./mod.ts`, falsely flagging live `kalshi-tail-zone-scanner` / `polymarket-sports-route-timing` modules). Verify by **bare basename** across the Target code root (`web/src`, NOT `src/` — Target code lives under `web/`), then let the compiler be the proof:
   ```bash
   grep -rn "<basename-without-ext>" web/src   # bare name, every line — necessary-but-not-sufficient
   npm run typecheck && npm run deadcode:check  # the authoritative liveness verdict; red ⇒ NOT orphaned
   ```
   An empty bare-basename grep is only a *hint*; the retire is safe **only** when typecheck/deadcode still pass. When a `wire-or-retire` ledger row is the anchor, the row itself is the authoritative orphan source — trust it over a hand-grep, and re-verify each module against `origin/main` before deleting (the ledger lags the active retire wave).

If rejected, replan narrower.

### 4.5. Design-concept artifact (money-critical only — issue #1056)

Before execute, money-critical Target builds capture a **lightweight
design-concept artifact** and persist it per-anchor, so a retry on the same
anchor reuses it instead of rediscovering scope every cycle. This is the
Target analogue of the Orchestrator's `hydra-grill` design-concept — but
**deliberately lighter**: a flat 4-field record (scope / modules-touched /
invariants / rejected-alternatives), NOT the full Q&A loop, NOT a
draft/approved/stale gate, NOT a tier ladder (epic #1052: selectively
converge, do not mirror). The pure builder/serializer lives in the gate
mirror at `.hydra-gate/scripts/target/target-design-concept.ts` (synced into
the worktree by Step 0.6, issue #1451); this step is the I/O wrapper. Run it
from `$TARGET_WT` so the mirror's `../../src/…` imports resolve — never from
`~/hydra`.

**Gate on money-critical first — safe-path builds skip this step entirely.**
`shouldCaptureDesignConcept()` routes on the keystone classifier
(`classifyTargetRisk`, #1053): if no expected path is money-critical
(providers / execution / staking / bet-math), there is no artifact to create,
persist, or diff against — proceed straight to Step 5.

```bash
cd "$TARGET_WT"   # the .hydra-gate mirror's ../../src imports resolve from here
# EXPECTED_PATHS is the planner's `scopeBoundary.in` money-critical surface,
# space- or newline-separated; ANCHOR_REF is anchor.reference (e.g. "issue-1056").
DC_KEY="hydra:target:design-concept:${ANCHOR_REF}"

CAPTURE=$(node --input-type=module -e '
  import { shouldCaptureDesignConcept } from "./.hydra-gate/scripts/target/target-design-concept.ts";
  const paths = process.argv.slice(1);
  process.stdout.write(shouldCaptureDesignConcept(paths) ? "yes" : "no");
' -- $EXPECTED_PATHS)

if [ "$CAPTURE" = "no" ]; then
  echo "safe-path build — skipping design-concept artifact"
else
  # Reuse-on-retry: if a prior attempt persisted one, read it back and reuse.
  EXISTING=$(docker exec hydra-redis-1 redis-cli GET "$DC_KEY" 2>/dev/null)
  REUSED=$(node --input-type=module -e '
    import { parseDesignConcept } from "./.hydra-gate/scripts/target/target-design-concept.ts";
    const dc = parseDesignConcept(process.argv[1] || "");
    process.stdout.write(dc ? JSON.stringify(dc) : "");
  ' -- "$EXISTING")

  if [ -n "$REUSED" ]; then
    echo "reusing persisted design-concept for $ANCHOR_REF (retry):"
    printf '%s\n' "$REUSED" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("  scope:", d.scope); console.log("  invariants:", d.invariants.join("; "));'
    # Fold the reused artifact into the plan you hand the executor role.
  else
    # First attempt (or corrupt prior value): the planner authors the four
    # fields now and persists. Build the input JSON from the plan, then:
    DC_JSON=$(node --input-type=module -e '
      import { buildDesignConcept, serializeDesignConcept } from "./.hydra-gate/scripts/target/target-design-concept.ts";
      const input = JSON.parse(process.argv[1]);
      process.stdout.write(serializeDesignConcept(buildDesignConcept(input)));
    ' -- "$DC_INPUT_JSON")
    # Persist per-anchor with a 14-day TTL so a stale anchor self-cleans.
    docker exec hydra-redis-1 redis-cli SET "$DC_KEY" "$DC_JSON" EX 1209600 >/dev/null
    echo "persisted design-concept for $ANCHOR_REF"
  fi
fi
```

`DC_INPUT_JSON` is the planner-authored
`{anchorRef, scope, modulesTouched, invariants, rejectedAlternatives}` object
(`rejectedAlternatives` is `[{alt, why}, ...]`). The Target QA Spec axis
(#1055) reads the same `hydra:target:design-concept:$ANCHOR_REF` key to diff
the merged change against the captured intent — that is the artifact's only
consumer; it never blocks a merge by itself.

### 5. Execute

Read `~/hydra/config/agents/executor.md` and `~/hydra/config/feedback/to-executor.md`.

Step 0.6 already created `$TARGET_WT` on branch `feature/$CYCLE_ID` off `origin/main`. Stay in that worktree — do NOT `cd ~/hydra-betting`, do NOT `git checkout main`, do NOT `git pull` from the main checkout (that's the race that #542 is fixing).

```bash
cd "$TARGET_WT"
git status --short    # must be clean — we just branched off origin/main
```

**Path discipline for Read/Edit/Write tools (issues #542, #1861):** every `file_path` argument MUST be either repo-relative (e.g. `web/src/foo.ts`) when cwd is `$TARGET_WT`, OR an absolute path anchored to `$TARGET_WT/...`. Do NOT construct paths like `/home/gabe/hydra-betting/web/...` — those bypass the worktree and write to the main checkout (the exact bug behind #542, which kept recurring under six friction cues until #1861). This applies to **Read** too: reading the main-checkout copy of a file anchors you on the path your later Edit/Write would ghost-write into the main tree. The `worktree-write-fence.sh` PreToolUse hook now fences Read/Edit/Write/MultiEdit and, on a deny, names the corrected `$TARGET_WT/...` path — re-issue against that path rather than recomputing it or `cd`-ing out of the worktree.

**EnterWorktree anchor discipline (issue #2371):** if the harness exposes `EnterWorktree`/`ExitWorktree`, you are already LAUNCH-PINNED to `$TARGET_WT` by the `Agent(isolation="worktree")` dispatch — the harness tracks ONE writable-worktree-root anchor per agent. NEVER call `EnterWorktree` when your launch-time `pwd` already satisfies the worktree predicate (`git rev-parse --git-dir` under `.git/worktrees/`); a redundant or sibling switch desyncs that anchor from cwd and makes a perfectly-valid in-cwd Edit/Write get DENIED. If `EnterWorktree` *was* genuinely required (a non-pinned dispatch whose initial `pwd` failed the predicate), re-run `pwd` immediately after and re-derive every subsequent `file_path` from that fresh root. If an in-`$TARGET_WT` Edit/Write is STILL denied even though the file resolves inside your cwd, the anchor has desynced — recover by `ExitWorktree` then `EnterWorktree` by `path` (the documented re-anchor path), NOT by writing the file via `python3`/`Bash`. The shell-out workaround is reactive, bypasses the harness diff tracking, and is the exact friction #2371 exists to eliminate. (Orthogonal — NOT this fix: the `worktree-write-fence.sh` hook itself is currently uninstalled on the orch host per #1861; installing it via `scripts/setup-claude-hooks.sh` closes the separate ghost-write-to-main gap but does not resolve this anchor-desync symptom.)

Rules:
- Smallest change wins (20 lines > 200 lines).
- Tests mandatory — write alongside.
- Match existing patterns.
- NEVER delete `src/lib/providers/` or `src/lib/execution/`.
- NEVER "cleanup" / "remove unused" commits.
- Migrations: update `drizzle/meta/_journal.json`.
- `vi.mock("server-only", () => ({}))` in tests importing server modules.
- Read `web/AGENTS.md` — Next.js 16 APIs may differ from training.
- **Stay in scope.** If you must touch a file outside the Step 3.5 in-scope list, append it to `SCOPE_JUSTIFICATIONS` with a one-line reason before continuing.
- **Co-located glossary rule.** Treat any `CONTEXT.md` sibling of a file you're editing as required reading before the edit. Use that file's canonical vocabulary in identifiers, variable names, test names, and comments. The money-critical design-concept artifact (if present at `hydra:target:design-concept:$ANCHOR_REF` from Step 4.5) already carries the scope and invariants forward — the co-located read is the residual case for files the artifact didn't anticipate.

### 6. Verify (NOT an agent)
```bash
cd "$TARGET_WT/web"
npm run typecheck    # must pass
npm test             # must pass; count must not decrease
```

After the first edit batch, sanity-check that the edits actually landed in the worktree (cheap canary against the #542 ghost-edit symptom):
```bash
( cd "$TARGET_WT" && git diff --name-only ) | head
# If this is empty when Edit calls were made, edits leaked to the main checkout —
# ABORT and do not push. Run `git -C ~/hydra-betting status --short` to confirm.
```

Fail → fix → re-verify. After 2 failed fixes, abandon branch.

**Run the full `npm test`, or pass `--test-force-exit` when running a single file. NEVER run a bare `node --test <file>`.** Modules that open a DB/Redis connection or a timer keep `node:test`'s event loop alive, so the process **hangs forever** after the assertions pass — which blocks the Bash tool call and froze an autopilot session for 11h with the process never reaped (2026-05-28, orchestrator side). `npm test` already includes `--test-force-exit`; for a subset use `node --test --test-force-exit <file>`.

For orchestrator changes (~/hydra/): `node --check src/<file>.ts` + `npm test` + restart service.

### 6.6. Money-critical mutation gate (issue #1057 — diff-scoped)

After the test/typecheck gate passes (Step 6), the changed-file set runs through
the **money-critical mutation gate**. This is the Target analogue of the
Orchestrator's diff-scoped mutation gate, with two deliberate differences from
epic #1052:

- **Diff-scoped to money-critical paths only.** The gate mutates ONLY the
  changed files that `classifyTargetRisk()` (the keystone classifier from
  #1053) flags as money-critical — provider integrations, execution, staking,
  bet-math. A green-but-empty suite over those paths costs real money; a
  green-but-empty suite over UI/docs/config does not.
- **Safe-path PRs skip mutation entirely.** When no changed file is
  money-critical, the gate exits 0 with a `skipped` status and never spins up
  the runner — keeping the single hydra-server-betting runner fast for the
  common UI/docs change.
- **A single kill-floor — NOT a tier ladder.** Either the changed
  money-critical files clear the one floor or the build fails. Mirrors the
  classifier's own two-level boolean (money-critical vs. safe).

Invoke the **mirrored** gate script from the target worktree (issue #1451 —
synced into `$TARGET_WT/.hydra-gate/` by Step 0.6), feeding it the PR diff
against the merge base. Do NOT run `scripts/target/mutation-check.ts` from
`~/hydra`, and do NOT hand-strip the `web/` prefix from `CHANGED_FILES` — pass
the raw `web/`-rooted diff paths straight through. `classifyTargetRisk()`
(inside the mirrored script) already normalizes the `web/` prefix (#1235), so
hand-stripping re-introduces an already-solved bug and runs the gate
inconsistently.

**Commit brand-new files BEFORE running the gate.** Mutant scoping follows the
git diff, so an untracked (or unstaged-new) money-critical file produces
**zero mutants** — the gate degrades to a non-blocking `0-mutant` warn instead
of actually testing the new code (friction cue
`stryker-no-mutants-on-untracked-files`, recurred 4×). The `CHANGED_FILES`
computation below only sees committed work: run the gate only after every new
file the cycle created is committed on the feature branch, and treat a
`0-mutant` warn on a diff that adds money-critical files as a red flag, not a
pass.

**Large-scanner pure-enrichment diffs: the gate verdict is unreliable, not a
pass to trust.** A second, opposite failure mode (friction cue
`mutation-gate-timeout-on-large-scanner-file`, recurred 3×): when the changed
file is a **large** money-critical module (e.g.
`web/src/lib/arbitrage/scanner.ts`, `web/src/lib/execution/kalshi-executor.ts`)
and your diff is **pure enrichment** — it adds/annotates without changing the
existing logic lines (a new field, a relocation, a comment-level tweak) — the
gate mutates the *whole* file, hits `MUTATION_TIME_BUDGET_MS` before reaching a
full verdict, and any surviving mutants it reports live in **untouched code you
did not write**. That is neither a real pass nor a real fail of *your* change;
it is a budget-exhausted partial run whose verdict is noise. Do NOT treat the
incomplete result as a kill-floor failure of your diff, and do NOT pad the PR
with throwaway tests against untouched lines to chase those mutants.

Handle it as follows:
- **Confirm the diff is genuinely pure-enrichment** for the scanned file: `git
  diff "$(git merge-base origin/main HEAD)"...HEAD -- <scanner-file>` shows only
  additive/annotative hunks, no edit to an existing executable line. If your
  diff *does* change logic in the scanner, the gate verdict stands — fix the
  surviving mutants normally.
- **For a confirmed pure-enrichment diff on a too-large-to-mutate-in-budget
  file, the gate is skippable** — but the skip must be *declared, not silent*.
  Record the rationale in the PR body (e.g. `Mutation gate: skipped on
  web/src/lib/arbitrage/scanner.ts — pure-enrichment diff, no logic-line change;
  surviving mutants are budget-truncated and land in untouched code`) so QA and
  the audit trail see why the floor was not enforced. A bare green from a
  budget-truncated run with no note is the failure mode to avoid.
- **Prefer raising the budget over skipping when the file is borderline.** If
  the file is only marginally over budget, bump `MUTATION_TIME_BUDGET_MS` for
  this run so the gate reaches a full verdict on the *changed* hunks before you
  reach for the skip.

```bash
cd "$TARGET_WT"
# CHANGED_FILES is the newline-separated diff against origin/main's merge base,
# in raw web/-rooted form — the gate normalizes web/ itself, do NOT strip it.
CHANGED_FILES=$(git diff --name-only "$(git merge-base origin/main HEAD)"...HEAD)
CHANGED_FILES="$CHANGED_FILES" \
TARGET_PROJECT_DIR="$TARGET_WT/web" \
  npx tsx "$TARGET_WT/.hydra-gate/scripts/target/mutation-check.ts"
```

Exit codes: 0 = pass (or skipped/neutral), 2 = kill-rate below the floor (block
merge), 1 = usage/unexpected error. Tune the floor with
`TARGET_MUTATION_KILL_FLOOR` (default 60 — higher than the Orchestrator base
because every file the gate reaches handles real money) and the time budget
with `MUTATION_TIME_BUDGET_MS`. A `[quick-fix]` tag in `PR_BODY` writes a
neutral status and exits 0, mirroring the Orchestrator gate's exemption.

### 6.5. Glossary / ADR gate (per target `docs/agents/domain.md`)

Before opening the code PR (or pushing the feature branch), answer the WRITE protocol's two yes/no questions documented in `~/hydra-betting/docs/agents/domain.md`. Both answers go in the code PR body (or merge commit body, for direct-to-main merges) **even when both are "none"** — the declaration is the audit trail.

```
Glossary impact: <term — one-line gloss | none>
ADR impact:     <one-line description | none>
```

If "Glossary impact" is not `none`:
- Identify the right file per the target's domain.md ("Where the glossary/ADR change lands" section).
- Open a **separate** PR from a sibling branch (`feature/$CYCLE_ID-glossary` off the same base) containing **only** the CONTEXT.md / CONTEXT-MAP.md delta.
- Label it `ubiquitous-language`.
- Reference its number from the code PR body. Do NOT bundle the glossary change into the code PR.

If "ADR impact" is not `none`:
- Same separate-PR pattern. ADR file is `docs/adr/NNNN-kebab-slug.md` or `web/src/lib/<context>/docs/adr/NNNN-kebab-slug.md` per scope.
- Same `ubiquitous-language` label. Same code-PR reference.

Gating discipline: the criteria are deliberately strict. **Both** ADR criteria must hold (hard-to-reverse AND surprising-to-a-reader AND has a real trade-off). Glossary updates fire only when you can write the one-line gloss now — if you can't, there's no glossary entry to add. Most builds will declare `none / none` — that's the expected steady state. The design-concept gate (hydra-grill) already caught the anticipated terms upfront; this step covers only the residual case where new vocabulary surfaced during implementation.

### 7. Merge (with merge lock)

Before merging, if this build went via a PR (orchestrator-side changes), the PR body MUST include the self-declared scope captured in Step 3.5:

```markdown
## Self-declared scope

The build picked this task autonomously — these are the files the planner intended to touch:

## Files in scope

$SCOPE_IN_LIST

$SCOPE_JUSTIFICATIONS
```

Just before merging, capture the **pre-merge health baseline** for the Step 8.6
delta comparison (issue #1699). While the Target baseline is ambiently degraded
(stale feeds, missing provider creds), absolute thresholds cannot tell a
merge-caused regression from the pre-existing state — the snapshot lets the
post-merge check alarm only on what THIS merge changed. Run the mirrored script
from the worktree (synced into the gate dir by Step 0.6). Fail-soft: if the
Target is unreachable, no baseline file is written and Step 8.6 falls back to
absolute thresholds — do NOT branch the cycle on this step's outcome.

**MANDATORY ON BOTH MERGE PATHS — direct-to-main AND auto-merge/PR (issue #1839).**
Capturing this baseline is NOT optional and is NOT scoped to the direct-to-main
flow below. The auto-merge/PR path (build opens a PR, lets CI + auto-merge land
it) previously skipped this snapshot because the snapshot was mentally bundled
with the inline `git merge` block that only the direct-to-main path runs. With
no `pmh-baseline.json` written, Step 8.6 fell back to absolute thresholds and —
against the ambiently-degraded betting Target — false-alarmed `hydra-target-incident`
on EVERY auto-merge, even for type-only refactors and client-nav components that
structurally cannot touch the alarming services (observed 6× in autopilot run
`4d10ad1b`, friction cue `pmh-absolute-threshold-false-alarm-on-pr-automerge-path`).
Run the snapshot command below **before the merge happens on whichever path this
build uses** — for the auto-merge/PR path, capture it just before you enable
auto-merge / push the branch that CI will merge, while the worktree mirror
(Step 0.6) is still present, so Step 8.6 has a baseline to diff against and stays
in delta mode. The file is consumed by Step 8.6 via `--baseline` regardless of
how the merge landed.

```bash
# Pre-merge health baseline (issue #1699, #1839) — consumed by Step 8.6 via
# --baseline. REQUIRED on both the direct-to-main path (below) AND the
# auto-merge/PR path. Run it before the merge lands on whichever path applies.
npx tsx "$TARGET_WT/.hydra-gate/scripts/target/post-merge-health.ts" \
  --snapshot-out "$TARGET_WT/.hydra-gate/pmh-baseline.json"
```

For direct-to-main merges (target repo), embed the same block in the merge commit message body so reviewers can audit blast radius after the fact:

```bash
for attempt in 1 2 3; do
  LOCK=$(hydra raw POST /merge/lock "{\"cycleId\":\"$CYCLE_ID\"}")
  if echo "$LOCK" | python3 -c 'import json,sys;sys.exit(0 if json.load(sys.stdin).get("acquired") else 1)' 2>/dev/null; then break; fi
  sleep $((attempt * 10))
done

# Push the worktree's feature branch first so the main checkout can merge a remote ref.
( cd "$TARGET_WT" && git push -u origin "feature/$CYCLE_ID" )

# Merge on the main checkout — the worktree itself is on the feature branch, so we
# can't merge into main from inside it. The merge-lock serialises this step across
# concurrent dispatches.
cd ~/hydra-betting
git fetch origin main
git checkout main && git pull --ff-only origin main
git merge --no-ff "feature/$CYCLE_ID" -m "merge: claude cycle — <task title>" \
  -m "## Files in scope" -m "$SCOPE_IN_LIST" -m "$SCOPE_JUSTIFICATIONS"
git push origin main
# Do NOT `git branch -d "feature/$CYCLE_ID"` here: the feature worktree
# ($TARGET_WT) still has the branch checked out at this point, so the delete
# fails with "branch ... used by worktree". The branch is deleted in Step 8.5,
# after the worktree is removed.

hydra raw POST /merge/unlock
```

#### 7b. Auto-merge / PR-path merge completion — already-merged-post-green is SUCCESS, not friction (issue #2392)

This subsection applies ONLY to the **auto-merge/PR path** — a build that opens a
hydra-betting PR and lets CI + the host-side **emulated** auto-merger
(`automerge.yml` in hydra-betting) land it. It does NOT apply to the
direct-to-main `git merge` block above, and it does NOT apply to the
orchestrator (`gaberoo322/hydra`) merge path, which is branch-protected and
unaffected.

`hydra-betting` has no native branch protection; the emulated auto-merger
squashes the PR the moment CI goes green. So by the time this build reaches its
explicit merge step, the PR is very often **already merged** — the squash landed
by `automerge.yml` on the `workflow_run`-success that this build was itself
polling for. That is a benign, expected race: the merge succeeded. Treat it as a
SUCCESS terminal state, never as friction.

```bash
# Auto-merge/PR path only. Poll CI to green, then observe the PR's merge state.
# (Poll-to-green is retained as complementary guidance — see the
# betting-automerge-bypasses-CI ops note — but the cue fix below does NOT depend
# on who wins the squash race.)
PR_STATE=$(gh pr view "$PR_NUM" --repo gaberoo322/hydra-betting \
  --json state,mergedAt,mergeStateStatus 2>/dev/null || echo '')
PR_MERGED=$(printf '%s' "$PR_STATE" | jq -r '.state // ""' 2>/dev/null)   # "MERGED" once landed
```

**Decision — the load-bearing branch:**

- **PR is MERGED and CI concluded green** → this is the **already-merged-post-green
  SUCCESS terminal state.** The merge step is COMPLETE. Read `COMMIT_SHA` from the
  merged PR's merge commit (`gh pr view "$PR_NUM" --json mergeCommit --jq
  '.mergeCommit.oid'`) for the metrics/event bookkeeping below.
  - **Explicitly DO NOT POST the `betting-emulated-automerge-lands-before-explicit-merge`
    cue to `/api/memory/subagent-friction`.** The merge succeeded — recording
    friction here is the pure-noise defect this subsection fixes (it 3-hit-escalated
    a meta-friction issue, #2391, working-as-intended-but-spurious). Root-cause
    suppression is at the emission site (do not narrate the POST), NOT a downstream
    threshold bump in `src/pattern-memory/escalation.ts`.
  - Fall through to **Step 8.5** (worktree cleanup + branch delete) and **Step 9**
    (state sync: move ITEM_ID to done, `tasksMerged:1` metrics record,
    `cycle:completed` event with `merged:true`, and `/cycle/complete`
    registration) **identically to a build-performed merge.** Nothing is silently
    skipped — the post-merge bookkeeping is the same regardless of who landed the
    squash. The post-merge health steps (7.5 deploy, 8 verify, 8.6 smoke) also
    run as normal; the Step 7 `pmh-baseline.json` you captured before enabling
    auto-merge feeds Step 8.6 in delta mode.
  - The **post-green qualifier is load-bearing**: an already-merged PR whose CI is
    NOT green / still in progress is NOT a clean success — do not silently treat it
    as one. Wait for CI to conclude before classifying the outcome.

- **PR is NOT merged** → attempt the explicit merge yourself (poll-to-green then
  merge). **Record friction (`betting-emulated-automerge-lands-before-explicit-merge`
  or the genuine merge-failure cue) ONLY if that explicit merge actually fails.**
  This is the only branch that records the cue — the genuine merge-failure signal
  is preserved; suppression is narrowly the already-merged-post-green case, nothing
  wider.

### 7.5. Deploy + post-deploy health
```bash
systemctl --user restart hydra-betting-web.service

for i in $(seq 1 18); do
  STATUS=$(systemctl --user is-active hydra-betting-web.service 2>/dev/null)
  [ "$STATUS" = "active" ] && break
  sleep 5
done

if [ "$STATUS" != "active" ]; then
  echo "DEPLOY FAILED: service not active after 90s"
  journalctl --user -u hydra-betting-web.service --no-pager -n 20 2>&1 | grep -iE "error|fail|exit" | tail -5
  cd ~/hydra-betting    # revert runs against the main checkout — merge has already landed there
  git revert --no-edit -m 1 HEAD
  git push origin main
  systemctl --user restart hydra-betting-web.service
  echo "REVERTED: deploy failure"
fi

if [ "$STATUS" = "active" ]; then
  sleep 5
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3333/api/health)
  [ "$HTTP" != "200" ] && echo "DEPLOY WARNING: /api/health=$HTTP" && \
    journalctl --user -u hydra-betting-web.service --since "2 min ago" --no-pager 2>&1 | grep -iE "error|unhandled|reject" | tail -5
fi
```

Don't fail the cycle on a degraded health check (warning OK). DO fail + revert if service won't start.

### 8. Post-merge verify (auto-rollback)
```bash
npm test    # compare to pre-merge
```

Regression → revert + restart + report.

### 8.6. Post-merge operational-health smoke check (alarm-only — issue #1054)

After the merge has landed and the service is back up (Step 7.5), run the
**alarm-only** operational-health smoke check. This is the Target's replacement
for per-merge **Outcome Holdback** (epic #1052): betting outcomes are
settlement-lagged and the outcome-ingestion seam was removed (#933), so instead
of holding a merge back on an outcome signal, we let the merge land and then
sample fast, merge-attributable operational signals the Target already exposes
(`/api/health/full` — overall status + per-service execution-success and
provider/API error proxies). On a regression past a configurable noise floor it
raises a `hydra-target-incident` alarm.

ALARM-ONLY: this step NEVER reverts and NEVER blocks a merge. It observes
post-merge and routes to `hydra-target-incident`, which decides whether to
investigate/fix/revert. The auto-revert path is Step 7.5 (deploy failure) /
Step 8 (test regression) only — do NOT add a revert here.

REALM ROUTING (ADR-0025, issue #2553): the watcher dispatches the Target-scoped
`hydra-target-incident`, NOT the Orchestrator's `hydra-incident`. Each
Operate-layer incident skill is single-realm — `hydra-target-incident` operates
only on `~/hydra-betting`, `hydra-incident` only on `~/hydra`. The dispatch
target string lives in `scripts/target/post-merge-health.ts` (the `--dispatch`
spawn); it and this playbook move in lockstep.

Run the **mirrored** script from the worktree (issue #1451 — synced into
`$TARGET_WT/.hydra-gate/` by Step 0.6); do NOT invoke it from `~/hydra`. This
step runs BEFORE the Step 8.5 worktree cleanup, so the mirror is still present.

```bash
cd "$TARGET_WT"
# Pass --dispatch so a real regression actually fires hydra-target-incident.
# Without --dispatch it is a dry-run (prints the alarm context, spawns nothing),
# which is what you want when smoke-testing the watcher itself.
# --baseline points at the pre-merge snapshot captured in Step 7 (issue #1699):
# the watcher then alarms only on DELTAS vs that baseline — services newly
# not-ok, per-service worsening (degraded -> error), or overall severity-rank
# worsening — so ambient pre-existing degradation never false-alarms.
# This baseline is captured on BOTH merge paths (issue #1839) — direct-to-main
# AND auto-merge/PR — so delta mode is the normal case regardless of how the
# merge landed; the absolute-threshold fallback below is for a genuine
# baseline-miss (Target down pre-merge), NOT the steady-state auto-merge path.
# Issue #1817 FRESHNESS-FLAP SUPPRESSION (delta mode, no extra flags needed):
# several Target services (scanner, ingestion, pinnacle/fairline) derive status
# purely from data freshness, whose window (e.g. the scanner's 180s) is far
# tighter than the cron cadence (~30min), so the signal flaps ok<->degraded
# purely as a function of WHEN the probe fires. evaluateDelta now suppresses the
# single ok->soft (degraded/stale) transition for these freshness-class services
# (keyword allowlist, env-overridable via HYDRA_PMH_FRESHNESS_SERVICES) so a
# phantom `scanner: ok -> degraded` no longer alarms. ANY move into error, any
# worsening from an already-not-ok baseline, and ok->degraded on a hard-check
# (non-freshness) service all still alarm — suppression is scoped, never global.
npx tsx "$TARGET_WT/.hydra-gate/scripts/target/post-merge-health.ts" \
  --merge-sha "$COMMIT_SHA" --dispatch \
  --baseline "$TARGET_WT/.hydra-gate/pmh-baseline.json"
```

Fail-soft: if the Target API is truly unreachable (service still restarting,
port not yet up, non-JSON body), the script logs and exits 0 — an unreachable
Target is not a merge regression and must never look like a build failure.
Note (issue #1699): a non-2xx response that still carries a health JSON body
IS a valid sample — `/api/health/full` answers 503 with a full body when the
overall status is degraded/error — so a degraded baseline still yields signal.
If the baseline file is missing (Step 7 snapshot skipped or Target was down
pre-merge), the watcher falls back to the absolute thresholds.
**Absolute-mode ambient-alarm guard (issue #1839):** in this fallback the Target's ambient
degraded services (ingestion, scanner, pinnacle/fairLine, opticOdds — stale
feeds / missing provider creds) trip the absolute thresholds on every merge.
Before honoring an absolute-mode alarm, cross-check it against this build's
in-scope diff (`scopeBoundary.in`, already computed in Step 3.5): if EVERY
alarming service is one of the known-ambient degraded services AND none of the
changed paths has any plausible path to those services (e.g. type-only
refactors, client-nav components, `package.json` config — the diff touches no
ingestion/scanner/provider/odds code), treat it as a baseline-miss false
positive — do NOT pass `--dispatch` for that run (omit it to keep the watcher in
its print-only dry-run), and log the friction cue
`pmh-absolute-threshold-false-alarm-on-pr-automerge-path` instead of spawning
`hydra-target-incident`. Any alarming service OUTSIDE the ambient set, OR any changed
path that could reach an alarming service, still dispatches normally — this
guard only suppresses the provably-spurious ambient-only case, never a true
regression. The clean fix remains capturing the Step-7 baseline on both merge
paths (above); this guard is the defense-in-depth fallback for the genuine
baseline-miss case (Target was down pre-merge). Tune the noise
floor via the `HYDRA_PMH_*` env vars documented at the top of
`scripts/target/post-merge-health.ts` (overall-status alarm set, and the
tolerated counts of degraded / execution-class / provider-class services —
applied to delta counts when a baseline is supplied). Freshness-flap suppression
(issue #1817): in delta mode the comparator suppresses the single ok->soft
(degraded/stale) transition for freshness-class services (the
`HYDRA_PMH_FRESHNESS_SERVICES` keyword allowlist — scanner, ingest, pinnacle,
fairline, freshness by default), so a sampling-phase freshness-window flap no
longer false-alarms while any error transition, any worsening from an
already-not-ok baseline, and any hard-check (non-freshness) ok->degraded still
fire. The exit code is informational only (75 on alarm, 0 otherwise); do NOT
branch the cycle on it.

### 8.5. Worktree cleanup (issue #542)

On success, remove the hydra-betting worktree we created in Step 0.6, **prune stale worktree metadata**, THEN delete the merged feature branch — in that order. `git branch -d` fails with "branch ... used by worktree" while the worktree still holds the branch checked out, which is why the delete lives here and not in Step 7 (friction cue: `worktree-held-branch-blocks-local-delete`). The `git worktree prune` between the two is load-bearing (issue #2272): `$TARGET_WT` lives on `/dev/shm` (tmpfs), so its directory can vanish underneath `git worktree remove` — leaving a *stale* `.git/worktrees/<id>` entry that still claims the branch is "used by worktree at '/dev/shm/...'". Without the prune, the very next `git branch -d` (and every retry) fails against that orphaned metadata even though the dir is long gone (9 such failures for one cycle in 24h). `git worktree prune` is git's own sanctioned metadata reconcile — it only drops entries git itself agrees are no longer in use, so it never touches a live worktree. On failure, `scripts/branch-prune.sh` will GC both on the next daily sweep — leaking is acceptable on crash but not on the happy path.

```bash
git -C ~/hydra-betting worktree remove --force "$TARGET_WT" 2>&1 || \
  echo "warn: worktree remove failed for $TARGET_WT — branch-prune.sh will GC it later"
# Reconcile stale worktree metadata before the branch delete (issue #2272):
# $TARGET_WT is on /dev/shm (tmpfs) and may have vanished underneath the
# remove above, leaving an orphaned .git/worktrees/<id> entry that makes the
# next `git branch -d` fail with "branch ... used by worktree at '/dev/shm/...'".
git -C ~/hydra-betting worktree prune 2>&1 || \
  echo "warn: worktree prune failed in ~/hydra-betting — branch-prune.sh will reconcile later"
git -C ~/hydra-betting branch -d "feature/$CYCLE_ID" 2>&1 || \
  echo "warn: branch delete failed for feature/$CYCLE_ID — branch-prune.sh will GC it later"
```

### 9. State sync (critical)

Move backlog item to done:
```bash
TASK_TITLE="<title>"
ITEM_ID=$(hydra backlog ls | python3 -c "
import json,sys
d=json.load(sys.stdin)
title=sys.argv[1].lower()
for lane in ['inProgress','queued','backlog']:
    for item in d.get(lane,[]):
        if title in item.get('title','').lower() or item.get('title','').lower() in title:
            print(item['id']); sys.exit(0)
print('')" "$TASK_TITLE")
[ -n "$ITEM_ID" ] && hydra backlog move "$ITEM_ID" done
```

If this build opened a PR instead of merging direct-to-main (orchestrator-side changes, or any flow that produces a remote PR that has not yet merged at this point), tag the inProgress kanban item with the PR-number marker BEFORE moving it to done. This is the convention `/api/anchor/candidates` uses to suppress the just-shipped anchor between PR-open and merge (issue #640):

```bash
# Only when a PR was opened and is still open.
PR_NUM=<pr-number>
if [ -n "$ITEM_ID" ] && [ -n "$PR_NUM" ]; then
  curl -fsS -X PATCH "http://localhost:4000/api/backlog/${ITEM_ID}/move" \
    -H 'content-type: application/json' \
    -d "{\"lane\":\"inProgress\",\"claimedBy\":\"pr-${PR_NUM}\"}" >/dev/null
fi
```

The `pr-<n>` claimedBy marker is what the candidates API's `excludeInFlight` filter (default true, 30-min freshness window) looks for. Without it, decide.py will re-dispatch dev_target onto the same anchor every tick until the PR merges — burning 50-150k tokens per duplicate dispatch (the original failure mode in run `ab97a2d5`). The marker is cleared automatically when the next `applyLaneTransition` runs (e.g. when the item moves to `done` post-merge).

Do **not** record completion by pushing a `COMPLETED:`/`CLOSED:` marker onto the work-queue (the old `hydra queue add "COMPLETED: <task title>"` idiom). That marker is a terminal-state note, not actionable work — it pollutes `hydra:anchors:work-queue` and resurfaces as a no-op dev_target candidate. As of #1854 the four queue-write layers (`pushToWorkQueue`, `POST /queue`, anchor-candidates read-reap, startup GC) refuse such markers, so the call is now a guaranteed 422 no-op; emitting it only re-fires the meta-friction cue. Completion is recorded by the metrics record and the `cycle:completed` event below — no work-queue write is needed.

Record metrics (shared with Codex):
```bash
hydra raw POST /metrics/record "{
  \"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\",
  \"tasksAttempted\":1,\"tasksMerged\":1,\"tasksFailed\":0,
  \"testsBefore\":$TESTS_BEFORE,\"testsAfter\":$TESTS_AFTER,
  \"filesChanged\":$FILES_CHANGED,\"totalDurationMs\":$DURATION_MS,
  \"taskTitle\":\"$TASK_TITLE\",\"anchorType\":\"$ANCHOR_TYPE\",
  \"regressionIntroduced\":false
}"
```

Publish event:
```bash
hydra raw POST /events/publish "{
  \"type\":\"cycle:completed\",\"correlationId\":\"$CYCLE_ID\",
  \"payload\":{\"source\":\"claude\",\"taskTitle\":\"$TASK_TITLE\",\"commitSha\":\"$COMMIT_SHA\",\"merged\":true,\"testDelta\":$((TESTS_AFTER - TESTS_BEFORE))}
}"
```

Complete cycle registration:
```bash
hydra raw POST /cycle/complete "{\"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\",\"status\":\"completed\"}"
```

On failure — lesson capture for shared learning (issue #392).
This is the only post-cycle writer to `hydra:memory:executor:patterns` for
Claude-driven builds after #383 deletes codex-runner. The endpoint forwards
to `recordPattern()` so the existing 3-hit auto-promotion to
`config/feedback/to-executor.md` keeps working.
```bash
# Pick the cue that matches the failure mode:
#   verification-failure | no-diff | rollback
CUE="verification-failure"   # change per failure mode
hydra raw POST /memory/subagent-lesson "{
  \"skill\":\"hydra-target-build\",
  \"outcome\":\"$CUE\",
  \"cue\":\"$CUE\",
  \"context\":\"$CYCLE_ID: $TASK_TITLE — <what failed>\",
  \"cycleId\":\"$CYCLE_ID\"
}"
```

API failures: log but don't fail the build. The endpoint is idempotent on
`(skill, outcome, cue)` — multiple calls for the same logical event merge
into one pattern (hit count increments).

### 9.5. Friction Report (issue #512 — ALWAYS, even on success)

The child agent ALSO emits a `## Friction Report` section in its return,
even on a clean merge. Each item is a piece of soft friction the agent
worked around without failing — captured so successor dispatches don't
re-discover it.

**Child-prompt contract (the dispatched BG agent MUST emit this):**

```markdown
## Friction Report

- cue: stale-local-master-ref
  workaround: used origin/master for diff base
  context: git rev-parse origin/master
- cue: vitest-flake-in-foo-spec
  workaround: re-ran the specific suite; passed on second attempt
  context: src/foo/__tests__/foo.spec.ts
```

Rules:
- `cue` MUST be kebab-case, stable across runs.
- `workaround` is exactly one line.
- `context` is exactly one line.
- If no friction worth noting, emit `- (none)`.

**Parent post-flight:**

After the BG returns, parse each `## Friction Report` item and POST to
`/api/memory/subagent-friction`:

```bash
hydra raw POST /memory/subagent-friction "{
  \"skill\":\"hydra-target-build\",
  \"cue\":\"$CUE\",
  \"workaround\":\"$WORKAROUND\",
  \"context\":\"$CONTEXT\",
  \"cycleId\":\"$CYCLE_ID\"
}"
```

Idempotent on `(skill, cue)`. When the same cue crosses the
`PROMOTION_THRESHOLD` (3 hits), a `meta-friction` GitHub issue is
auto-opened (or comment-bumped). Failure to POST is logged but never
fails the build.

### 10. Report (summary table only)

| Step | Result |
|------|--------|
| Mode | delegated / inline (issue #1782 contract) |
| Ground | X tests passing, typecheck status |
| Anchor | task title (anchor type) |
| Plan | scope: N files, M criteria |
| Self-declared scope | N in-scope, M justified out-of-scope |
| Skeptic | approved/skipped (reason) |
| Verify | test count change (before → after) |
| Merge | commit SHA |
| State sync | backlog item moved / not found |
</child-prompt>

## Context

- **Hydra orchestrator**: `~/hydra/` (TS, ESM, node:test)
- **Target**: `~/hydra-betting/web/` (Next.js 16, vitest, 3100+ tests)
- **Config**: `~/hydra/config/direction/` and `~/hydra/config/feedback/`
- **Personalities**: `~/hydra/config/agents/`
- **Backlog/API**: `bin/hydra` → http://localhost:4000
- **Redis**: `docker exec hydra-redis-1 redis-cli`
- **Stack**: Next.js 16, React 19, Tailwind 4, Zod 4, Drizzle, vitest

Read `web/AGENTS.md` before assuming Next.js conventions — APIs may differ from training data. Use atomic backlog claims, merge locks, metrics, and events for parallel execution with Codex cycles.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
