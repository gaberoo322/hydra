# hydra-target-build — Merge flow reference (Steps 7–10)

Read this file when you reach the merge phase of a hydra-target-build execution.
It covers: merge-lock, pre-merge baseline snapshot, auto-merge/PR path, deploy +
post-deploy health, post-merge verify, operational-health smoke, worktree cleanup,
state sync, friction report, and the final summary table.

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

**Fast-forward the local main checkout FIRST — mandatory on the auto-merge/PR path (issue #2848).**
`hydra-betting-web.service` has `WorkingDirectory=/home/gabe/hydra-betting/web` and an
`ExecStartPre=/usr/bin/npx next build`, so the restart below **builds from the local
`~/hydra-betting` main checkout, not a worktree.** On the auto-merge/PR path the squash
landed on `origin/main` via `automerge.yml` (a GitHub-hosted runner with its own
ephemeral workspace) — no mechanism fast-forwards the local checkout, so without this
step the restart rebuilds *stale* code that is several commits behind `origin/main`
(friction cue `betting-deploy-checkout-lags-origin-after-automerge`, 3-hit-escalated).
The **direct-to-main path already pulls** in Step 7 (`git checkout main && git pull
--ff-only origin main`, line ~1030), so this block is the auto-merge/PR path's equivalent
and is a benign no-op there (already current → nothing to fast-forward).

Guard the fast-forward against a dirty or diverged local main: **fail loud and skip the
merge rather than clobbering local state — never force.** A non-fast-forward means the
local main diverged from `origin/main` (it should never, since all work is done in
worktrees) — surface it for operator triage instead of merging or resetting.

```bash
# Bring the local main checkout current after the emulated auto-merge (issue #2848).
# Only fast-forwards; fails loud + skips on a dirty/diverged tree (never force-resets).
if git -C ~/hydra-betting diff --quiet && git -C ~/hydra-betting diff --cached --quiet; then
  git -C ~/hydra-betting fetch origin main
  if ! git -C ~/hydra-betting merge --ff-only origin/main; then
    echo "WARN: ~/hydra-betting main is not fast-forwardable to origin/main (diverged) — skipping ff, restarting stale. Surface for operator triage; do NOT force-reset."
  fi
else
  echo "WARN: ~/hydra-betting main checkout is dirty — skipping fast-forward, restarting from current tree. Surface for operator triage; do NOT stash/reset autonomously."
fi

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

As of #3048 this endpoint routes through the `recordCycle()` coordinator (the same deep path `POST /autopilot/cycle-record` uses), so this inline merge-time write is now a FULL cycle record — a `hydra:cycle:<id>` hash + index membership + scheduler-counter bump, not just the metrics-hash feed the old shallow handler wrote. Because `reap.py` (`CYCLE_RECORD_SKILLS` includes `hydra-target-build`) ALSO fires `POST /autopilot/cycle-record` for this same `$CYCLE_ID`, whichever write lands first records the cycle deeply and the second dedup/enriches (`deduped:true`, `bucketed:null`) — the coordinator's idempotency guard fires each scheduler counter at most once per cycleId, so this write cannot double-count a merge.

As of #3220 the `POST /metrics/record` handler was relocated out of the `src/api/metrics.ts` read-aggregator router into the `src/api/autopilot-lifecycle.ts` write router, where its structural twin `POST /autopilot/cycle-record` already lives. The URL path is byte-identical, so this `hydra raw POST /metrics/record` call is unaffected — only the handler's home file moved.

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
