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

**Mode detection (mandatory):** make exactly ONE `ToolSearch` query (`+agent spawn task`) against the deferred-tool list, then commit to a mode.

**Delegated mode (spawn tool available):** spawn the child with the prompt below. Pass `$task` if provided. Child returns ONLY a summary table, `Mode | delegated`.

**Inline mode (no spawn tool):** permitted ONLY under this explicit contract — never as a silent fallback. Do NOT abort: fail-loud here zeros Target throughput.

> **CONTEXT POINTER:** if you are in inline mode, read `hydra-target-build-inline-mode.md` (sibling of this SKILL.md) for the full contract: declare loudly, friction-log, apply context-budget discipline, cap complexity at standard.

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
# The install command + appSubdir come from the Target Manifest (verify.install /
# verify.appSubdir; epic #3014, ADR-0026, issue #3019) — not hardcoded. For
# hydra-betting these resolve to `npm ci --prefer-offline` in `web/`.
APP_SUBDIR=$(jq -r '.verify.appSubdir' "$TARGET_WT/.hydra/manifest.json")
INSTALL_CMD=$(jq -r '.verify.install' "$TARGET_WT/.hydra/manifest.json")
(cd "$TARGET_WT/$APP_SUBDIR" && $INSTALL_CMD --no-audit --no-fund)

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

### 1. Ground (read-only, in the manifest's appSubdir)

**Verify commands come from the Target Manifest, NOT hardcoded** (epic #3014, ADR-0026, issue #3019). Read `verify.test` / `verify.typecheck` / `verify.appSubdir` from `<TARGET_WT>/.hydra/manifest.json` and run *those* — never a hardcoded `npm test`. For hydra-betting the manifest declares `verify.test = "npm run test:raw"` (the **real** vitest suite), so grounding must run `test:raw`, NOT the bare `npm test` count-gate (which is a frozen-floor count ratchet + 3 sentinels, not the suite — an agent that reads its "X passed" footer as a green suite can ship a change that breaks untested betting modules). A missing/malformed manifest is **fail-closed**: abort with the `[target-manifest]` error, do NOT default to `npm test`.

```bash
# Source the verify block from the Target Manifest (fail-closed on absence).
MANIFEST="$TARGET_WT/.hydra/manifest.json"
[ -f "$MANIFEST" ] || { echo "ABORT: [target-manifest] no manifest at $MANIFEST (see ADR-0026)" >&2; exit 1; }
APP_SUBDIR=$(jq -r '.verify.appSubdir' "$MANIFEST")
TEST_CMD=$(jq -r '.verify.test' "$MANIFEST")
TYPECHECK_CMD=$(jq -r '.verify.typecheck' "$MANIFEST")
cd "$TARGET_WT/$APP_SUBDIR"     # appSubdir='' => repo root
$TEST_CMD                        # betting: `npm run test:raw` (the real suite), NEVER bare `npm test`
$TYPECHECK_CMD
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

> **CONTEXT POINTER:** for work-queue anchors run the shipped-anchor preflight (Step 2.1) and the two grounding preflights (Steps 3.1 ledger-intersection, 3.2 doc-banner) before finalising the plan. Full bash recipes live in `hydra-target-build-anchor-preflight.md` (sibling of this SKILL.md). Summary: work-queue head — LREM if ≥70% subject-word overlap with origin/main commits; wire-or-retire ledger hit → HARD STOP-AND-REFRAME; superseded-doc banner → HARD STOP-AND-REFRAME. All three are fail-open on uncertainty.

### 3. Plan (planner role)

Read `~/hydra/config/agents/planner.md` and `~/hydra/config/feedback/to-planner.md`. Read relevant source. Design ONE bounded task:
- ≤5 files, 3–5 testable criteria, scope boundary, advances vision, hard verification commands.

Complexity:
- **quick-fix** (≤2 files, ≤3 criteria, failing-test): skip skeptic.
- **standard** (3–5 files, 4–8 criteria): full ceremony.
- **complex** (>5 files): split.

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

### 3.6. Inject per-anchor Reflections (issue #841) + deposit telemetry (issue #1136/#1912)

**Two mandatory halves — do BOTH every build:**

(a) Fetch reflection narrative: `GET /api/reflections?anchor=$ANCHOR_REF&files=$FILES_CSV`. Weave `formatted` into the plan; empty → graceful no-op. Use `anchor.reference` NOT `task.title`. Verify with `/api/reflections`, NOT `/api/learning/context-trace`.

(b) Run the deposit script immediately after — MANDATORY even when zero reflections served:

@include _fragments/reflection-telemetry-deposit.md

**Knowledge context (issue #2647):** same planning-time step. `GET /api/learning/knowledge?agent=hydra-target-build&anchor=$ANCHOR_REF`. Fold `.content` into the executor plan; empty → no-op. Use this route, NOT `/api/learning/context-trace` (counts-only, no content).

```bash
KB_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/learning/knowledge?agent=hydra-target-build&anchor=$(printf '%s' "$ANCHOR_REF" | jq -sRr @uri)")
KB_CONTENT=$(printf '%s' "$KB_JSON" | jq -r '.content // ""')
[ -n "$KB_CONTENT" ] && printf '%s\n' "$KB_CONTENT"
```

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

Verify commands come from the Target Manifest (`verify.typecheck` / `verify.test` / `verify.appSubdir`; epic #3014, ADR-0026, issue #3019) — never hardcoded. For hydra-betting `verify.test` is `npm run test:raw` (the real vitest suite), so verify runs `test:raw`, NOT the bare `npm test` count-gate.

```bash
MANIFEST="$TARGET_WT/.hydra/manifest.json"
APP_SUBDIR=$(jq -r '.verify.appSubdir' "$MANIFEST")
TEST_CMD=$(jq -r '.verify.test' "$MANIFEST")
TYPECHECK_CMD=$(jq -r '.verify.typecheck' "$MANIFEST")
cd "$TARGET_WT/$APP_SUBDIR"
$TYPECHECK_CMD       # must pass
$TEST_CMD            # betting: `npm run test:raw`; must pass; count must not decrease
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

### 7–10. Merge, deploy, verify, state sync, and report

> **CONTEXT POINTER:** when you reach the merge phase, read `hydra-target-build-merge-flow.md` (sibling of this SKILL.md). It covers: pre-merge health baseline snapshot (MANDATORY on both direct-to-main AND auto-merge/PR paths), merge lock, direct-to-main git merge, auto-merge/PR path (already-merged-post-green is SUCCESS not friction), deploy + post-deploy health, post-merge verify (auto-rollback on regression), operational-health smoke check (alarm-only), worktree cleanup, state sync, friction report, and the summary table.

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
