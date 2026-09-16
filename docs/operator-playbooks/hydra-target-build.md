---
name: hydra-target-build
description: Run a complete Hydra development build — picks a task, plans, challenges, executes, verifies, merges, and syncs state. Delegates to a subagent for context-window protection when a spawn tool is available; otherwise runs under the explicit inline-mode contract.
when_to_use: "When the user wants to build a feature, fix a bug, run a dev cycle, or says 'build', 'ship', 'execute'"
allowed-tools: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*) WebSearch(*) WebFetch(*)
arguments: [task]
reference_files: [_fragments/hydra-target-build-merge-flow.md, _fragments/hydra-target-build-inline-mode.md, _fragments/hydra-target-build-anchor-preflight.md]
---

# Hydra Build

Run one complete Hydra development build operating as every agent (planner, skeptic, executor, reporter). You write the code yourself — do NOT call Codex or the Hydra scheduler.

To prevent context window saturation under `/loop`, delegate the build to a child **when a spawn capability exists**:
- **Claude:** spawn an `Agent` with the build prompt below.
- **Codex:** `codex exec --skill hydra-target-build` as a subprocess.

Autopilot dispatch sessions carry NO Agent/Task spawn tool (issue #1782). In that environment the build runs under the **explicit inline-mode contract** in Step 2 — silently running the child prompt inline as an undeclared fallback is forbidden, and so is aborting just because the spawn tool is absent.

In delegated mode the parent does pre-flight, spawns the child, blocks on the
child in the FOREGROUND until it reaches a terminal state, and only then
relays its outcome. The child does the heavy work; the parent must never end
its turn while the child is still running (issue #4196) — relaying a summary
for a still-running child, or narrating a future notification instead of
watching the child finish now, is a forbidden ending, not a valid handoff. See
the `dev_target` variant of the `## NEVER END WAITING` preamble in
`hydra-autopilot.md`, which every `dev_target` dispatch carries verbatim
alongside this skill's own contract.

## Step 1: Pre-flight (parent context)

Before delegating, resolve the Target seam in THIS parent shell (the child
resolves it again for itself in Step 0.0 below — spawning a fresh session
does not inherit these exports):

@include _fragments/target-seam-preamble.md

Then run:

**Concurrency check (Claude only — does NOT block on Codex cycles):**
```bash
CLAUDE_LOCK=$(docker exec hydra-redis-1 redis-cli GET hydra:cycle:active:claude 2>/dev/null)
if [ -n "$CLAUDE_LOCK" ]; then echo "BLOCKED: another Claude cycle running ($CLAUDE_LOCK)"; fi
```

**WIP limit check (GitHub-Issues board — ADR-0031 Decision 4, liveness-aware since #4475):** Target tracking now lives as GitHub Issues on `$TARGET_GH_REPO`, not the Redis backlog. The WIP limit AND the rule for which `in-progress` claims count toward it live in ONE place — `~/hydra/scripts/autopilot/target-wip.py` — which the autopilot's `collect-state.sh` also calls, so `decide.py` never dispatches `dev_target` into a gate that would bounce it (and vice versa). A claim counts as live WIP only when an OPEN Target PR references it; an orphaned `in-progress` label with no PR (a crashed build — such claims are released at reap time by #4195) does not. Never hard-code the limit here. Read via **REST** (`gh api`), never `gh --json` / GraphQL — the money-critical Target loop must draw from the underused REST pool (ADR-0031 Decision 6, #3427).
```bash
# REST reads only (never GraphQL): open in-progress issue numbers + open PRs
# projected to target-wip.py's {headRefName, body} input rows.
WIP_IP=$(gh api "repos/$TARGET_GH_REPO/issues?labels=in-progress&state=open&per_page=100" \
  --jq '[.[] | select(.pull_request == null) | .number]' 2>/dev/null || echo '')
WIP_PRS=$(gh api "repos/$TARGET_GH_REPO/pulls?state=open&per_page=100" \
  --jq '[.[] | {headRefName: .head.ref, body: (.body // "")}]' 2>/dev/null || echo '')
if [ -z "$WIP_IP" ] || [ -z "$WIP_PRS" ]; then
  # Fail OPEN (issue #4475): an unreadable board never blocks the build.
  echo "WARN: WIP gate reads failed — proceeding without the WIP check (issue #4475)" >&2
else
  WIP_OUT=$({ printf '%s\n' "$WIP_IP"; printf '%s\n' "$WIP_PRS"; } \
    | jq -cs '{in_progress: .[0], prs: .[1]}' \
    | python3 ~/hydra/scripts/autopilot/target-wip.py)
  WIP_LIMIT=$(printf '%s\n' "$WIP_OUT" | sed -n 's/^target_wip_limit=//p')
  WIP_LIVE=$(printf '%s\n' "$WIP_OUT" | sed -n 's/^target_wip_live=//p')
  if [ "$(printf '%s\n' "$WIP_OUT" | sed -n 's/^target_wip_saturated=//p')" = "true" ]; then
    echo "BLOCKED: WIP limit reached (${WIP_LIVE}/${WIP_LIMIT} live in-progress claims)"
    gh api "repos/$TARGET_GH_REPO/issues?labels=in-progress&state=open&per_page=100" \
      --jq '.[] | select(.pull_request == null) | "  #\(.number) — \(.title[0:60])"'
    exit 1
  fi
fi
```

If either fails, stop. Do not delegate.

## Step 2: Delegate — or declare inline mode (issue #1782)

**Mode detection (mandatory):** make exactly ONE `ToolSearch` query (`+agent spawn task`) against the deferred-tool list, then commit to a mode.

**Delegated mode (spawn tool available):** spawn the child with
`Agent(run_in_background=true, ...)` and the prompt below, passing `$task` if
provided. **Immediately after spawning, poll the child to a terminal state in
the FOREGROUND** — repeated status checks with a bounded interval between
them, in THIS session — before your final message. Do NOT end your turn on a
still-running child, a narrated future wait ("I'll relay its summary once it
completes"), or an armed Monitor; and if a notification wakes you while the
child is STILL not done, re-arming the wait and ending your turn again is the
same forbidden ending repeated (issue #4196). Once the child reaches a
terminal state, relay its outcome: the child returns ONLY a summary table,
`Mode | delegated`.

**Inline mode (no spawn tool):** permitted ONLY under this explicit contract — never as a silent fallback. Do NOT abort: fail-loud here zeros Target throughput.

> **CONTEXT POINTER:** if you are in inline mode, read `hydra-target-build-inline-mode.md` (sibling of this SKILL.md) for the full contract: declare loudly, friction-log, apply context-budget discipline, cap complexity at standard.

---

<child-prompt>
Full autonomy: pick the task, plan, challenge your own plan, execute, verify, merge, sync state, report. Don't ask the user. If you hit a blocker, solve it.

## Step 0.0: Resolve the Target seam (run this FIRST, before anything below)

@include _fragments/target-seam-preamble.md

## CRITICAL SAFETY RULE — READ FIRST (issues #542, #3889)

Two repos are in play: `~/hydra` (orchestrator) and `$TARGET_WS` (target). `dev_target` is dispatched WITHOUT harness `isolation: "worktree"` (issue #3889): the harness's worktree isolation only covers `~/hydra`, and because `$TARGET_WS` is a sibling repo not nested under it, a pinned session is refused ALL git ops against the target. So this skill isolates the target ITSELF via Step 0.6 below (nested under `$TARGET_APP_DIR/.worktrees/` — relocated off `/dev/shm` in issue #4177 to eliminate the reach-back `node_modules` symlink hazard, #4175), and the installed `worktree-write-fence.sh` PreToolUse hook fences ghost-writes back into that worktree. Step 0.6 is therefore the SOLE isolation for the target repo — never skip it.

Before running ANY `git`, `npm`, `Edit`, or `Write` against the target repo:

1. Run `pwd` and `git rev-parse --git-dir`. If cwd is `$TARGET_WS` (the main target tree), ABORT. If cwd is `$TARGET_APP_DIR`, ABORT — same tree.
2. Create a dedicated target worktree (Step 0.6 below) and `cd` into it.
3. Verify isolation: inside the new worktree, `git rev-parse --git-common-dir` must resolve to `$TARGET_WS/.git` AND `git rev-parse --git-dir` must contain `.git/worktrees/`. ABORT otherwise.
4. From that point on, every Edit/Write/Bash file mutation against the target uses **the worktree path only** — never construct absolute paths under `$TARGET_WS/...` directly. If you must use an absolute path, anchor it to `$TARGET_WT/...`.

**`$TARGET_WS` is also the Target's serving tree** — the checkout its own deploy pipeline pulls, builds, and restarts from (issue #4525). The build never fast-forwards it, never builds or tests in it, and never restarts the Target's service: shipping is PR → the Target's CI → its automerge → its CI-owned deploy (Steps 7–8, merge-flow reference).

No fallback. No `cd "$TARGET_WS"` in any step below — those bare paths are historical and have been replaced by `$TARGET_WT` references. If `$TARGET_WT` is unset when a step needs it, ABORT — that means Step 0.6 was skipped.

### 0. Register cycle
```bash
CYCLE_ID="claude-cycle-$(date -u +%Y-%m-%d-%H%M)"
hydra raw POST /cycle/register "{\"cycleId\":\"$CYCLE_ID\",\"source\":\"claude\"}"
```

### 0.6. Create the target worktree (issue #542, relocated off `/dev/shm` in #4177)

Symmetric with how `hydra-dev` worktree-isolates `~/hydra`. The target repo (`$TARGET_WS`) is a separate git repo — the harness can't isolate it for us. Create one ourselves with the shared create+verify block below (issue #4476 — the ONE source every self-isolated Target class runs; `$TARGET_WS` / `$TARGET_APP_DIR` come from the seam preamble above, and `TARGET_WT_BASE` stays at its `origin/main` default here):

@include _fragments/target-self-isolation-preamble.md

Then, still inside `$TARGET_WT`:

```bash
# No install step here (issue #4177): node_modules AND `npm run <script>`
# binaries resolve by the ancestor walk above. A change that adds/bumps a
# dependency gets a LOCAL `npm ci` in Step 6 (Verify), only when the diff
# touches package.json/package-lock.json. appSubdir comes from the Target
# Manifest (verify.appSubdir; epic #3014, ADR-0026, issue #3019) — not
# hardcoded — because later steps `cd "$TARGET_WT/$APP_SUBDIR"`. Re-read it
# from the worktree's own manifest copy (not just $TARGET_APP_SUBDIR from the
# seam preamble) since the worktree is the canonical checkout for this cycle.
APP_SUBDIR=$(jq -r '.verify.appSubdir' "$TARGET_WT/.hydra/manifest.json")

# Mirror the Target SDLC gate scripts into the worktree (issue #1451). The gate
# scripts (mutation-check / target-design-concept / post-merge-health) and their
# small src closure live ONLY in this orchestrator repo and import `../../src/…`,
# so they do not exist in the target checkout. This sync copies them into
# `$TARGET_WT/.hydra-gate/` (git-excluded, so it never pollutes the Target PR
# diff) so Steps 4.5 / 6.6 / 8.6 run the REAL gate from the worktree — never from
# ~/hydra, never by hand-rolling the risk-critical classification.
bash ~/hydra/scripts/sync-target-gate.sh "$TARGET_WT"
```

`scripts/branch-prune.sh` (issue #443) sweeps stale worktrees under `$TARGET_APP_DIR/.worktrees/*`. We DO remove the worktree in Step 9 on success — leaking is only acceptable on crash. The `.hydra-gate/` mirror is inside the worktree, so it is GC'd with it.

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

### 1. Ground (read-only, in the manifest's appSubdir)

**Verify commands come from the Target Manifest, NOT hardcoded** (epic #3014, ADR-0026, issue #3019). Read `verify.test` / `verify.typecheck` / `verify.appSubdir` from `<TARGET_WT>/.hydra/manifest.json` and run *those* — never a hardcoded `npm test`. Some targets alias a bare `npm test` to a count-gate + a handful of sentinels rather than the real suite (a documented failure mode on a prior Target — an agent that reads its "X passed" footer as a green suite can ship a change that breaks untested modules), so grounding must run the manifest's DECLARED `verify.test` command, whatever it names. A missing/malformed manifest is **fail-closed**: abort with the `[target-manifest]` error, do NOT default to `npm test`.

```bash
# Source the verify block from the Target Manifest (fail-closed on absence).
MANIFEST="$TARGET_WT/.hydra/manifest.json"
[ -f "$MANIFEST" ] || { echo "ABORT: [target-manifest] no manifest at $MANIFEST (see ADR-0026)" >&2; exit 1; }
APP_SUBDIR=$(jq -r '.verify.appSubdir' "$MANIFEST")
TEST_CMD=$(jq -r '.verify.test' "$MANIFEST")
TYPECHECK_CMD=$(jq -r '.verify.typecheck' "$MANIFEST")
cd "$TARGET_WT/$APP_SUBDIR"      # appSubdir='' => repo root
# eval word-splits the multi-word manifest commands under zsh (a bare `$TEST_CMD`
# is taken as one command word — `command not found: npm run <script>`). Portable.
eval "$TEST_CMD"                  # the manifest's declared REAL suite, NEVER assume bare `npm test` is it
eval "$TYPECHECK_CMD"
git log --oneline -5
git status --short
```

Load context (parallel):
- `~/hydra/config/direction/priorities.md`
- `~/hydra/config/direction/vision.md`
- `~/hydra/config/feedback/to-planner.md`
- `~/hydra/config/feedback/to-executor.md`
- The Target board (open issues), via **REST** — never `gh --json` / GraphQL (ADR-0031 Decision 6): `gh api -X GET search/issues -f q="repo:$TARGET_GH_REPO is:issue is:open" --jq '.items[] | "#\(.number) [\(.labels | map(.name) | join(","))] \(.title)"'`. (Replaces the retired `hydra backlog ls` + `LRANGE hydra:anchors:work-queue` Redis reads.)
- `hydra memory planner` && `hydra memory executor`

> **Direction docs are a mirror — refresh if stale (issue #1791).** The
> `~/hydra/config/direction/{priorities,roadmap}.md` files loaded above are the
> orchestrator's COMMITTED copy and the runtime source of truth for the
> in-process readers. The LIVE docs that
> `/hydra-target-research` writes each cycle live in the Target repo at
> `$HYDRA_TARGET_REPO/direction/` (falls back to `$TARGET_WS/direction/` when
> `HYDRA_TARGET_REPO` is unset — see `src/target-config.ts`).
> Nothing auto-syncs the two, so the orch copy can lag the research cycle by
> milestones. The
> `collect-state.sh` Phase-1 collector emits `direction_drift=true` when the
> committed orch copy no longer matches the live Target docs. When you see that
> signal (or notice the loaded `priorities.md` frontmatter `updated:` lagging
> the Target's), refresh the committed copy on a feature branch and open a PR —
> never write into `config/direction/` from a read-only collector or from the
> deploy tree (the #1739 dirty-tree hazard):
>
> ```bash
> cp "${HYDRA_TARGET_REPO:-$TARGET_WS}"/direction/priorities.md ~/hydra/config/direction/priorities.md
> cp "${HYDRA_TARGET_REPO:-$TARGET_WS}"/direction/roadmap.md   ~/hydra/config/direction/roadmap.md
> ```

> **Superseded direction docs are non-groundable — check the banner before you plan from a doc (issue #2728).** A direction doc whose premise has been retired carries a machine-readable header banner as its first non-blank content line:
>
> ```
> > **STATUS: superseded by <doc-or-ADR> on <YYYY-MM-DD>.** <one-line pointer to the current doc.>
> ```
>
> A banner'd doc is a dead premise: **do NOT plan from it** — read the banner's pointer and ground on the doc it names instead. The full check (banner contract, detection recipe, STOP-AND-REFRAME handling) is the Step 3.2 grounding preflight in `hydra-target-build-anchor-preflight.md`.

### 2. Anchor (select task) — GitHub-Issues board (ADR-0031)

Target work is now tracked as **GitHub Issues on `$TARGET_GH_REPO`**, orch-style label-driven (ADR-0031 Decision 2/4) — NOT the Redis work-queue / `/backlog` API. Dispatch simplifies to the Orchestrator's own model: pick a `ready-for-agent`, **unblocked** issue, ordered by priority. There is no scored ranking, no OpenViking semantic dedup, and no Redis atomic claim — those Redis mechanisms are retired.

If operator gave a task, use it. Otherwise priority order:
1. Failing tests
2. Typecheck errors
3. **`ready-for-agent` board pick** — read the board via **REST** (`gh api`, never `gh --json` / GraphQL — ADR-0031 Decision 6, the money-critical Target loop stays off the Orchestrator's saturated GraphQL pool), then claim by relabeling `in-progress` (mirrors the Orchestrator `hydra-dev` claim). This is the label-driven replacement for the retired atomic Redis `/backlog/claim`:
   ```bash
   # Pick the highest-priority open `ready-for-agent` Target issue via the REST
   # search pool. Priority label ordering (priority/high > priority/medium > …)
   # is the intra-lane tiebreak; without one, oldest-open wins.
   ANCHOR_NUM=$(gh api -X GET search/issues \
     -f q="repo:$TARGET_GH_REPO is:issue is:open label:ready-for-agent" \
     -f sort=created -f order=asc \
     --jq '.items[0].number // empty')
   if [ -n "$ANCHOR_NUM" ]; then
     ANCHOR_REF="issue-${ANCHOR_NUM}"
     # Claim it: relabel ready-for-agent -> in-progress (the label-driven claim).
     # `gh issue edit` is a REST call under the hood — no GraphQL on the hot path.
     gh issue edit "$ANCHOR_NUM" --repo "$TARGET_GH_REPO" \
       --remove-label ready-for-agent --add-label in-progress
   fi
   # No open `ready-for-agent` issue -> fall through to the priorities doc.
   ```
   Empty `ANCHOR_NUM` → fall through to step 4.
4. Priorities doc (skip "What's been completed").

Cross-reference drift check. Skip if recently merged.

> **CONTEXT POINTER:** for a board-picked anchor run the shipped-anchor preflight (Step 2.1) and the two grounding preflights (Steps 3.1 ledger-intersection, 3.2 doc-banner) before finalising the plan. Full bash recipes live in `hydra-target-build-anchor-preflight.md` (sibling of this SKILL.md). Summary: board anchor — treat as suspected-shipped if ≥70% subject-word overlap with ONE recent origin/main commit (skip the anchor non-destructively — never close or relabel the issue — and take the next candidate; issue #4167); wire-or-retire ledger hit → HARD STOP-AND-REFRAME; superseded-doc banner → HARD STOP-AND-REFRAME. All three are fail-open on uncertainty.

### 3. Plan (planner role)

Read `~/hydra/config/agents/planner.md` and `~/hydra/config/feedback/to-planner.md`. Read relevant source. Design ONE bounded task:
- ≤5 files, 3–5 testable criteria, scope boundary, advances vision, hard verification commands.

Complexity:
- **quick-fix** (≤2 files, ≤3 criteria, failing-test): skip skeptic.
- **standard** (3–5 files, 4–8 criteria): full ceremony.
- **complex** (>5 files): split.

### 3.5. Self-declare scope (issue #396)

When hydra-target-build picks its own task from a failing test or the priorities doc there is no pre-existing scope contract, so the child MUST write its own before opening the PR. A board-picked anchor (Step 2 priority 3) is now a GitHub issue on `$TARGET_GH_REPO` and may already carry a `## Files in scope` section — reuse it verbatim when present; otherwise author the contract as below.

Compute the in-scope list from the plan's `scopeBoundary.in`, as **repo-relative** paths (prefix each with `$TARGET_APP_SUBDIR/` when the manifest declares a non-empty `appSubdir`; the examples below assume the empty/repo-root shape). Record it locally so it can be embedded in the PR body in Step 7:

```bash
SCOPE_IN_LIST=$(cat <<'EOF'
- `src/foo.ts`
- `src/foo/`
EOF
)
```

If executing requires touching a file outside the planned scope (shared fixture, adjacent import), record a justification rationale at the same time:

```bash
SCOPE_JUSTIFICATIONS=$(cat <<'EOF'
scope-justification: `src/test-helpers.ts` — shared fixture required by the new test
EOF
)
```

CI's `scope-check` gate (`.github/workflows/ci.yml` in the orchestrator repo, mirrored in the target repo if present) reads these sections from the PR body. Skipping this step doesn't block the build today (no hard requirement on PR body shape for target-repo PRs), but it's how the orchestrator learns the subagent's intended blast radius — and it's the contract reviewers + `hydra-qa` use to spot scope creep.

### 3.6. Inject per-anchor Reflections (issue #841) + deposit telemetry (issue #1136/#1912)

**Two mandatory halves — do BOTH every build:**

(a) Fetch reflection narrative: `GET /api/reflections?anchor=$ANCHOR_REF&files=$FILES_CSV`. Weave `formatted` into the plan; empty → graceful no-op. Use `anchor.reference` NOT `task.title`. Verify with `/api/reflections`, NOT `/api/learning/context-trace`.

(b) Run the deposit script immediately after — MANDATORY even when zero reflections served:

@include _fragments/reflection-telemetry-deposit.md

### 4. Skeptic (skip for quick-fix)

Read `~/hydra/config/agents/skeptic.md`. Challenge:
1. Anchored to real artifact?
2. Duplicating recent work? (`git log --oneline -20`)
3. Scope bounded? >5 files → reject.
4. Verification hard? (shell commands, not "review")
5. Smallest possible move?
6. Before deleting, prove the module is truly orphaned — but a **single-line `from`-grep is a false-negative trap** (retro cue `multiline-import-misses-importer-grep`, recurrence 4): a live consumer whose `import { … }` list spans several lines puts the symbol and the `from "./x"` clause on *different* lines, so a `from.*['"].*<name>` regex matches neither line. It also misses relative + `.ts`-suffixed specifiers (a path-fragment regex like `arbitrage/mod` skips `./mod` and `./mod.ts`). Verify by **bare basename** across the Target code root (`$TARGET_WT/$APP_SUBDIR/src` — the manifest's `appSubdir`, which may be empty, i.e. the repo root), then let the compiler be the proof:
   ```bash
   grep -rn "<basename-without-ext>" "$TARGET_WT/$APP_SUBDIR/src"   # bare name, every line — necessary-but-not-sufficient
   eval "$TYPECHECK_CMD"   # the manifest's verify.typecheck — red ⇒ NOT orphaned
   # plus the Target's own dead-code ratchet script, if its package.json declares one
   ```
   An empty bare-basename grep is only a *hint*; the retire is safe **only** when typecheck/deadcode still pass. When a `wire-or-retire` ledger row is the anchor, the row itself is the authoritative orphan source — trust it over a hand-grep, and re-verify each module against `origin/main` before deleting (the ledger lags the active retire wave).

If rejected, replan narrower.

### 4.5. Design-concept artifact (risk-critical only — issue #1056)

Before execute, risk-critical Target builds capture a **lightweight
design-concept artifact** and persist it per-anchor, so a retry on the same
anchor reuses it instead of rediscovering scope every cycle. It is a flat
4-field record (scope / modules-touched / invariants / rejected-alternatives)
— NOT the Orchestrator's `hydra-grill` Q&A loop, draft/approved/stale gate,
or tier ladder (epic #1052). The pure builder/serializer lives in the gate
mirror at `.hydra-gate/scripts/target/target-design-concept.ts` (synced into
the worktree by Step 0.6, issue #1451); this step is the I/O wrapper. Run it
from `$TARGET_WT` so the mirror's `../../src/…` imports resolve — never from
`~/hydra`.

**Gate on risk-critical first — safe-path builds skip this step entirely.**
`shouldCaptureDesignConcept()` routes on the keystone classifier
(`classifyRisk` in `src/target/risk-critical.ts`, #1053): a path is
risk-critical iff it touches the Target's own declared risk surface
(`riskCritical.surface` in `<TARGET_WT>/.hydra/manifest.json`, epic #3014 /
ADR-0026 — the Target-specific risk vocabulary lives only in the target repo,
never hardcoded here). If no
expected path is risk-critical, there is no artifact to create, persist, or
diff against — proceed straight to Step 5.

```bash
cd "$TARGET_WT"   # the .hydra-gate mirror's ../../src imports resolve from here
# EXPECTED_PATHS is the planner's `scopeBoundary.in` risk-critical surface,
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

Step 0.6 already created `$TARGET_WT` on branch `feature/$CYCLE_ID` off `origin/main`. Stay in that worktree — do NOT `cd` into `$TARGET_WS`, do NOT `git checkout main`, do NOT `git pull` from the main checkout (that's the race that #542 is fixing).

```bash
cd "$TARGET_WT"
git status --short    # must be clean — we just branched off origin/main
```

**Path discipline for Read/Edit/Write tools (issues #542, #1861):** every `file_path` argument MUST be either repo-relative (e.g. `$TARGET_APP_SUBDIR/src/foo.ts`) when cwd is `$TARGET_WT`, OR an absolute path anchored to `$TARGET_WT/...`. Do NOT construct paths directly under `$TARGET_APP_DIR/...` (the main checkout) — those bypass the worktree and write to the main checkout. This applies to **Read** too: reading the main-checkout copy of a file anchors you on the path your later Edit/Write would ghost-write into the main tree. The `worktree-write-fence.sh` PreToolUse hook now fences Read/Edit/Write/MultiEdit and, on a deny, names the corrected `$TARGET_WT/...` path — re-issue against that path rather than recomputing it or `cd`-ing out of the worktree.

**EnterWorktree / cwd discipline (issues #2371, #3889):** `dev_target` is dispatched WITHOUT `isolation="worktree"` (#3889), so you reach `$TARGET_WT` via Step 0.6 (`git worktree add` + `cd`) — there is normally NO harness `EnterWorktree` anchor engaged, and the installed `worktree-write-fence.sh` PreToolUse hook is what fences stray Edit/Write back into `$TARGET_WT`. If a harness anchor IS engaged (a session that genuinely called `EnterWorktree`), the harness tracks ONE writable-worktree-root anchor per agent: NEVER call `EnterWorktree` when your `pwd` already satisfies the worktree predicate (`git rev-parse --git-dir` under `.git/worktrees/`); a redundant or sibling switch desyncs that anchor from cwd and makes a perfectly-valid in-cwd Edit/Write get DENIED. After ANY `EnterWorktree`, re-run `pwd` immediately and re-derive every subsequent `file_path` from that fresh root. If an in-`$TARGET_WT` Edit/Write is STILL denied even though the file resolves inside your cwd, the anchor has desynced — recover by `ExitWorktree` then `EnterWorktree` by `path` (the documented re-anchor path), NOT by writing the file via `python3`/`Bash`. The shell-out workaround is reactive, bypasses the harness diff tracking, and is the exact friction #2371 exists to eliminate.

Rules:
- Smallest change wins (20 lines > 200 lines).
- Tests mandatory — write alongside.
- Match existing patterns.
- NEVER delete a path on the Target's declared risk surface (`$TARGET_RISK_SURFACE_JSON`, from the manifest's `riskCritical.surface`) unless the anchor explicitly asks for it.
- NEVER "cleanup" / "remove unused" commits.
- **Target-specific conventions come from the Target's own docs, never this skill** (ADR-0013): stack/framework versions, migration workflow, test-mocking idioms, protected directories. Read whichever of these exist — each is optional, so check with `[ -f … ]` and skip a missing one explicitly rather than treating it as an input: `$TARGET_WS/CONTEXT.md`, `$TARGET_WS/README.md`, `$TARGET_APP_DIR/AGENTS.md`, `$TARGET_APP_DIR/CLAUDE.md`.
- **Stay in scope.** If you must touch a file outside the Step 3.5 in-scope list, append it to `SCOPE_JUSTIFICATIONS` with a one-line reason before continuing.
- **Co-located glossary rule.** Treat any `CONTEXT.md` sibling of a file you're editing as required reading before the edit. Use that file's canonical vocabulary in identifiers, variable names, test names, and comments. The risk-critical design-concept artifact (if present at `hydra:target:design-concept:$ANCHOR_REF` from Step 4.5) already carries the scope and invariants forward — the co-located read is the residual case for files the artifact didn't anticipate.

### 6. Verify (NOT an agent)

**Commit before you verify (issue #3953):** `git commit` the structurally-complete change on the feature branch *before* this long verification, so a stall degrades to an unmerged PR the autopilot resumes next tick rather than work destroyed by the worktree-orphan-prune (which reaps uncommitted state).

Verify commands come from the Target Manifest (`verify.typecheck` / `verify.test` / `verify.appSubdir`; epic #3014, ADR-0026, issue #3019) — never hardcoded. Run the manifest's DECLARED `verify.test` command, whatever it names — never assume a bare `npm test` is the real suite (some targets alias it to a count-gate instead, a documented failure mode on a prior Target).

```bash
MANIFEST="$TARGET_WT/.hydra/manifest.json"
APP_SUBDIR=$(jq -r '.verify.appSubdir' "$MANIFEST")
TEST_CMD=$(jq -r '.verify.test' "$MANIFEST")
TYPECHECK_CMD=$(jq -r '.verify.typecheck' "$MANIFEST")
cd "$TARGET_WT/$APP_SUBDIR"

# JIT local install, ONLY if this change touched package.json/package-lock.json
# (issue #4177). With no local node_modules present yet, `npm ci` creates a
# fresh LOCAL node_modules inside the worktree that shadows the shared
# ancestor without ever touching it. Any other change pays no install cost.
if ! git diff --quiet origin/main -- package.json package-lock.json; then
  INSTALL_CMD=$(jq -r '.verify.install' "$MANIFEST")
  eval "$INSTALL_CMD --no-audit --no-fund"
fi

# eval word-splits the multi-word manifest commands under zsh (a bare `$TYPECHECK_CMD`
# is taken as one command word — `command not found: npm run typecheck`). Portable.
eval "$TYPECHECK_CMD"  # must pass
eval "$TEST_CMD"       # the manifest's verify.test; must pass; count must not decrease
```

After the first edit batch, sanity-check that the edits actually landed in the worktree (cheap canary against the #542 ghost-edit symptom):
```bash
( cd "$TARGET_WT" && git diff --name-only ) | head
# If this is empty when Edit calls were made, edits leaked to the main checkout —
# ABORT and do not push. Run `git -C "$TARGET_WS" status --short` to confirm.
```

Fail → fix → re-verify. After 2 failed fixes, abandon branch.

**NEVER run a bare `node --test <file>` — always pass `--test-force-exit`.** Modules that open a DB/Redis connection or a timer keep `node:test`'s event loop alive, so the process **hangs forever** after the assertions pass and blocks the Bash tool call.

### 6.6. Risk-critical mutation gate (issue #1057 — diff-scoped)

After the test/typecheck gate passes (Step 6), the changed-file set runs through
the **risk-critical mutation gate**. It mutates ONLY the changed files that
`classifyRisk()` (the keystone classifier from #1053, in
`src/target/risk-critical.ts`) flags as risk-critical — the paths the Target's
own `.hydra/manifest.json` declares under `riskCritical.surface` (epic #3014,
ADR-0026). When no changed file is risk-critical the gate exits 0 with a
`skipped` status and never spins up the runner. There is a single kill-floor,
NOT a tier ladder: either the changed risk-critical files clear it or the build
fails.

Invoke the **mirrored** gate script from the target worktree (issue #1451 —
synced into `$TARGET_WT/.hydra-gate/` by Step 0.6), feeding it the PR diff
against the merge base. Do NOT run `scripts/target/mutation-check.ts` from
`~/hydra`, and do NOT hand-strip the `appSubdir` prefix from `CHANGED_FILES` —
pass the raw repo-rooted diff paths straight through. `classifyRisk()`
(inside the mirrored script) already strips the manifest's declared
`appSubdir` prefix (#1235, ADR-0026), so hand-stripping re-introduces an
already-solved bug and runs the gate inconsistently.

**Commit brand-new files BEFORE running the gate.** Mutant scoping follows the
git diff, so an untracked (or unstaged-new) risk-critical file produces
**zero mutants** — the gate degrades to a non-blocking `0-mutant` warn instead
of actually testing the new code (friction cue
`stryker-no-mutants-on-untracked-files`, recurred 4×). The `CHANGED_FILES`
computation below only sees committed work: run the gate only after every new
file the cycle created is committed on the feature branch, and treat a
`0-mutant` warn on a diff that adds risk-critical files as a red flag, not a
pass.

**Large-file pure-enrichment diffs: the gate verdict is unreliable, not a
pass to trust.** A second, opposite failure mode (friction recurred 3× on a
prior Target): when the changed
file is a **large** risk-critical module (e.g.
a large file under one of the manifest's `riskCritical.surface` prefixes)
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
  diff "$(git merge-base origin/main HEAD)"...HEAD -- <large-file>` shows only
  additive/annotative hunks, no edit to an existing executable line. If your
  diff *does* change logic in that file, the gate verdict stands — fix the
  surviving mutants normally.
- **For a confirmed pure-enrichment diff on a too-large-to-mutate-in-budget
  file, the gate is skippable** — but the skip must be *declared, not silent*.
  Record the rationale in the PR body (e.g. `Mutation gate: skipped on
  <path/to/large-module.ts> — pure-enrichment diff, no logic-line change;
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
# in raw repo-rooted form — the gate strips the manifest's appSubdir itself,
# do NOT strip it.
# Guard-compatible form (issue #3896): the worktree-isolation Bash guard refuses
# nested command substitution `$( ... $(...) ...)`. Resolve the merge base into a
# plain variable first, then pass it to `git diff`.
MERGE_BASE=$(git merge-base origin/main HEAD)
CHANGED_FILES=$(git diff --name-only "${MERGE_BASE}"...HEAD)
# APP_SUBDIR comes from the worktree's own manifest copy (same convention as
# Step 1 / Step 6 above) — never a hardcoded subdir nesting (INV-5/INV-7):
# a target declaring `appSubdir: ""` (repo-root app) must not have this gate
# point at a subdirectory that does not exist.
APP_SUBDIR=$(jq -r '.verify.appSubdir' "$TARGET_WT/.hydra/manifest.json")
CHANGED_FILES="$CHANGED_FILES" \
TARGET_PROJECT_DIR="$TARGET_WT/$APP_SUBDIR" \
  npx tsx "$TARGET_WT/.hydra-gate/scripts/target/mutation-check.ts"
```

Exit codes: 0 = pass (or skipped/neutral), 2 = kill-rate below the floor (block
merge), 1 = usage/unexpected error. Tune the floor with
`TARGET_MUTATION_KILL_FLOOR` (default 60 — higher than the Orchestrator base
because every file the gate reaches is on the Target's declared risk surface) and the time budget
with `MUTATION_TIME_BUDGET_MS`. A `[quick-fix]` tag in `PR_BODY` writes a
neutral status and exits 0, mirroring the Orchestrator gate's exemption.

### 6.5. Glossary / ADR gate

Before opening the code PR, answer the two yes/no glossary/ADR questions below. Both answers go in the code PR body **even when both are "none"** — the declaration is the audit trail.

**The Target's domain-doc protocol is OPTIONAL input (issue #4525).** If `$TARGET_WS/docs/agents/domain.md` exists, follow its WRITE protocol (and its "Where the glossary/ADR change lands" section). If it does not exist — not every Target has a `docs/agents/` tree — skip it explicitly and use the criteria in this step: glossary changes land in the Target's `CONTEXT.md` (or the co-located `CONTEXT.md` nearest the code), ADRs under the Target's `docs/adr/`. A missing optional doc is never a blocker and never an input to invent.

```bash
DOMAIN_DOC="$TARGET_WS/docs/agents/domain.md"
if [ -f "$DOMAIN_DOC" ]; then echo "domain protocol: $DOMAIN_DOC"; else echo "domain protocol: none (optional doc absent — using this step's defaults)"; fi
```

```
Glossary impact: <term — one-line gloss | none>
ADR impact:     <one-line description | none>
```

If "Glossary impact" is not `none`:
- Identify the right file per the target's domain.md when present; otherwise the Target's `CONTEXT.md`.
- Open a **separate** PR from a sibling branch (`feature/$CYCLE_ID-glossary` off the same base) containing **only** the CONTEXT.md / CONTEXT-MAP.md delta.
- Label it `ubiquitous-language`.
- Reference its number from the code PR body. Do NOT bundle the glossary change into the code PR.

If "ADR impact" is not `none`:
- Same separate-PR pattern. ADR file is `docs/adr/NNNN-kebab-slug.md`, or a context-local `docs/adr/` directory when the Target's own docs define one.
- Same `ubiquitous-language` label. Same code-PR reference.

Gating discipline: the criteria are deliberately strict. **Both** ADR criteria must hold (hard-to-reverse AND surprising-to-a-reader AND has a real trade-off). Glossary updates fire only when you can write the one-line gloss now — if you can't, there's no glossary entry to add. Most builds will declare `none / none` — that's the expected steady state. The design-concept gate (hydra-grill) already caught the anticipated terms upfront; this step covers only the residual case where new vocabulary surfaced during implementation.

### 6.7. Changelog fragment (or opt out)

Before opening the code PR, author a per-PR changelog fragment for any user- or operator-visible change (issue #3658, epic #3676). This mirrors the Orchestrator convention on the Target board.

**Only when the Target repo has adopted the `.changelog/` convention** (a `.changelog/README.md` exists in `$TARGET_WS/`): write **one** file `.changelog/<issue>-<slug>.md` — `<issue>` is the issue this build closes, `<slug>` a short kebab-case description — whose sole line is a curated, imperative, user-facing note (NOT the issue title):

```
- <type>: <description> (#<issue>)
```

`<type>` is a Conventional-Commits type (`feat`/`fix`/`perf`/`refactor`/`docs`/`test`/`build`/`ci`/`chore`/`revert`); the dashboard groups by type at render time and links the note to the issue. Commit the fragment with your change. For a genuinely user-invisible change (pure chore, test-only, internal refactor with no observable effect), apply the **`skip-changelog`** label to the PR instead of adding an empty fragment. There is no committed `CHANGELOG.md`; per-PR fragment files are conflict-free across parallel builds.

**Graceful no-op until the Target adopts the convention:** if `$TARGET_WS/.changelog/README.md` is absent, the Target board has not yet mirrored this convention — skip this step entirely (the Target's Versions card degrades to "no releases yet"). Do NOT create the directory or the `skip-changelog` label yourself; that is the follow-on Target adoption ticket's job. QA gets no changelog role.

### Foreground-wait contract — read before the merge phase (issue #3953)

A backgrounded wait is **structurally unrecoverable**: end the turn while CI (or
any other result) is still pending and the result is delivered to a session
that has already exited — the only path back is an external `SendMessage`
resume.

**The rule: a turn ends only when the result you were waiting for is in hand
and acted on.** For the merge phase that means: block on CI in the FOREGROUND
(bounded poll below) and merge — or fix — when it settles. Do NOT background a
monitor and stop. This is the same discipline as `hydra-qa`'s blocking-dispatch
mandate (`run_in_background: false` on every spawn), applied to this build's
own CI wait.

**Foreground bounded poll** — block on CI in THIS turn instead of backgrounding
a monitor and stopping:

```bash
# BOUNDED FOREGROUND POLL — block in THIS turn until CI on $PR settles. This is
# the foreground alternative to backgrounding a monitor/wait and ending the turn.
#
# Name the state variable `run_state` (or `st`), never `status` — zsh aliases
# `$status` to `$?`, so the assignment silently fails and the loop exits 1.
deadline=$((SECONDS + 600))            # 10-min budget; size to your slowest check
while [ "$SECONDS" -lt "$deadline" ]; do
  run_state=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
    --jq 'if ([.statusCheckRollup[]?.status]
           | any(IN("QUEUED","IN_PROGRESS","PENDING","WAITING")))
          then "pending" else "settled" end' 2>/dev/null)
  [ "$run_state" = "settled" ] && break
  sleep 15
done
# run_state == "settled"  => every check is terminal: read conclusions and act
#                            (merge on success, fix on failure).
# still "pending" past the deadline => budget expired: fall through to the
#                            partial-but-posted branch below — post what you can
#                            stand behind now, with CI state as of the last poll.
#                            NEVER re-arm the loop; one bounded budget per wait.
```

**Prefer a partial-but-posted result over a pending one.** If the budget
expires, do not leave the build unshipped: make sure the PR is open with the
verification state recorded as of the last poll and a one-line note on what is
pending. A built-and-green-locally PR that is **open** is a valid end state the
autopilot resumes next tick; a built-and-green-locally PR that is still local
(or unmerged with no PR) because you backgrounded a monitor and stopped is the
failure mode.

### 7–10. Merge, deploy, verify, state sync, and report

> **CONTEXT POINTER:** when you reach the merge phase, read `hydra-target-build-merge-flow.md` (sibling of this SKILL.md). It covers: pre-merge health baseline snapshot (MANDATORY), the PR-only merge path (the Target's `main` may be branch-protected, so the build never pushes to it; already-merged-post-green is SUCCESS not friction; and the operator-review fence — a PR whose linked issue(s) or anchor carries `money-critical` or `hold-for-operator` is NEVER merged by the build, AND is fenced at the SOURCE: the target's own `automerge.yml` skips the squash-merge when the PR's own labels, or any issue it closes in that repo, carry either label. Both fences resolve the same subject — every same-repo issue the PR links via `closingIssuesReferences`, plus the anchor — and both FAIL CLOSED, so a failed lookup counts as fenced. Green-but-unmerged is a handoff to the operator, not friction; see gaberoo322/hydra#4224), deploy verification — wait for the Target's own CI-owned deploy and compare the deployed SHA; the build never deploys, restarts, or tests in the serving tree — post-merge verify via the main-branch CI run (revert PR on regression), operational-health smoke check (alarm-only), worktree cleanup, state sync, friction report, and the summary table.

### Step 8.5. Worktree cleanup (on success)

On success, remove the target worktree created in Step 0.6. Leaking on crash is acceptable — `scripts/branch-prune.sh` will GC it — but on the happy path we clean up so `$TARGET_APP_DIR/.worktrees/` does not fill with stale directories (issues #3173, #542, #4177):

```bash
git -C "$TARGET_WS" worktree remove --force "$TARGET_WT" 2>&1 || \
  echo "warn: worktree remove failed for $TARGET_WT — branch-prune.sh will GC it later"
# Prune stale metadata: an interrupted remove (or an out-of-band `rm -rf` of
# $TARGET_WT) can leave an orphaned .git/worktrees/<id> entry that blocks the
# next `git branch -d` with "branch ... used by worktree at '...'".
git -C "$TARGET_WS" worktree prune 2>&1 || true
```

</child-prompt>

## Context

- **Hydra orchestrator**: `~/hydra/` (TS, ESM, node:test)
- **Target**: `$TARGET_APP_DIR` (verify commands per the target's own `.hydra/manifest.json`; stack, framework versions, and conventions per the Target's own docs — `$TARGET_WS/CONTEXT.md`, plus `$TARGET_APP_DIR/AGENTS.md` / `CLAUDE.md` when present)
- **Config**: `~/hydra/config/direction/` and `~/hydra/config/feedback/`
- **Personalities**: `~/hydra/config/agents/`
- **Backlog/API**: `bin/hydra` → http://localhost:4000
- **Redis**: `docker exec hydra-redis-1 redis-cli`

Never assume a stack from this skill (ADR-0013 — generality lives in the swap): framework/library versions may differ from training data, so read the Target's own docs above before assuming conventions. Every Target path derives from the manifest (`verify.appSubdir`) and the seam (`scripts/target/print-target-facts.ts`).

## Guard-compatible shell forms (issue #3837 AC #3, swept in #3896)

The harness's worktree-isolation Bash guard — the same fence `hydra-dev` meets on
the Orchestrator side — refuses Bash commands it judges too complex to verify
stay inside `$TARGET_WT`. Confirmed triggers (refused categorically — one-line OR
multi-line, and a bare loop is refused even with no substitution at all):

- **Process substitution** — `comm -12 <(...) <(...)`, `mapfile -t X < <(...)`.
- **Nested command substitution** — `$( ... $(...) ... )`.
- **`for` / `while` / `until` loops** — refused regardless of formatting.

This is about our snippets meeting the guard halfway. Split compound commands
into plain sequential ones: write intermediate results to temp files or plain
variables, then operate on those — never nest `$( $( ) )` and never use `<(...)`
(the Step 6.6 mutation-gate recipe resolves `MERGE_BASE` first for exactly this
reason); replace a loop with a single awk stage (as the shipped-anchor preflight
does, issue #4167).

Do NOT disable or work around the guard itself — it is the isolation fence. The
full note (with the `Monitor` CI-poll corollary) lives in
`_fragments/hydra-dev-parent-flow.md` under the same heading.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`, classified at emit-time so the
/now-pixel dashboard can route on `category`:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

Hook script: `scripts/autopilot/hooks/on-subagent-tool-call.sh`. Registration:
sibling `<this-playbook>.settings.json` → `~/.claude/skills/<this-skill>/.claude/settings.json`
(propagated by `scripts/sync-skills.sh`). The hook never propagates errors back
to this session — any failure is a stderr warning and `exit 0`
(`test/on-subagent-tool-call.test.mts`).
