---
name: hydra-target-incident
description: Automated incident response for the Target project — post-merge regressions, web-service crashes, and deploy failures. Single-realm to the target's app directory; investigates root cause, attempts fix or revert, files a post-mortem. Target sibling of hydra-incident (which is Orchestrator-only).
when_to_use: "When hydra-target-build's Step 8.6 post-merge health watcher alarms on a Target regression, the target's web service crashes, a Target deploy fails, or the user says 'target incident', 'what broke on the target', 'investigate the target failure'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
arguments: [context]
---

# Hydra Target Incident

Automated incident response for the **Target** (`$TARGET_WS`, code root
`$TARGET_APP_DIR/src`). Investigates root cause of post-merge regressions,
web-service crashes, and deploy failures. Attempts a fix or revert, then files a
post-mortem.

## Resolve the Target seam (run this first)

@include _fragments/target-seam-preamble.md

## Realm scope — single-realm to the Target (ADR-0025, issue #2553)

This skill operates **only** on the Target. It is the Target sibling of the
Orchestrator-only `hydra-incident`. The two are deliberately single-realm:
`hydra-incident` never touches the Target, and `hydra-target-incident` never
touches `~/hydra` source. Target work, post-mortems included, files on the
**Target board** (`$TARGET_GH_REPO`, ADR-0031 Decision 4) — never on the
Orchestrator repo. There is no Target feedback-file loop (retired, #2962): the
post-mortem issue is the durable record. Never write Orchestrator memory from
here.

**`$TARGET_WS` is the Target's serving tree and is read-only here.** Never
build, typecheck, test, check out, commit in, or restart it — the single
statement of the rule is in `hydra-target-build.md` ("`$TARGET_WS` is also the
Target's serving tree", #4525). Triage reads CI state over REST, the service
journal and the health endpoints; verify commands run only inside a remediation
worktree.

> Target test-suite caveat (CLAUDE.md): some targets alias a bare
> `npm test` to a count-gate + a handful of sentinels rather than the real
> suite (a documented failure mode on a prior Target) — always run the
> manifest's DECLARED `verify.test` command (`$TARGET_WS/.hydra/manifest.json`).
> When confirming a Target regression's blast radius, trust CI's test job as
> the gate and use the manifest's `verify.test` command for a local read —
> never read a bare `npm test` footer as "the full suite is green" without
> checking what the manifest actually declares.

## Trigger context

1. From `hydra-target-build` Step 8.6 — the alarm-only post-merge health watcher
   (`scripts/target/post-merge-health.ts` with `--dispatch`) spawns this skill on a
   detected Target regression. That watcher is **alarm-only**: it never reverts
   and never blocks a merge; it hands off to this skill, which decides whether
   to investigate / fix / revert.
2. Manual ("investigate the target regression", "what broke on the target").
3. With `$context` argument describing what's known (the watcher passes the
   merge SHA + the health delta).

## Process

### Phase 1: Triage (<60s)

```bash
hydra health
systemctl --user status "$TARGET_SERVICE" 2>&1 | head -5
# Read-only CI state of main (REST, never GraphQL). The manifest verify commands
# run ONLY inside a remediation worktree (Phase 3), never in $TARGET_WS / $TARGET_APP_DIR.
gh api -X GET "repos/$TARGET_GH_REPO/actions/runs" -f branch=main -f per_page=5 \
  --jq '.workflow_runs[] | "\(.id) \(.conclusion // .status) \(.head_sha[0:8]) \(.name)"'

git -C "${TARGET_WS:?unset - re-run the seam preamble in this Bash call}" log --oneline -10
git -C "${TARGET_WS:?unset - re-run the seam preamble in this Bash call}" diff HEAD~1 --stat
git -C "${TARGET_WS:?unset - re-run the seam preamble in this Bash call}" log --oneline -20 | grep -i "revert"

# Per-service post-merge health — the same signal that fired the watcher.
curl -s "$TARGET_WEB_URL/api/health/full" 2>/dev/null | python3 -m json.tool | head -40

hydra metrics --count 5 | python3 -c "
import json,sys
d=json.load(sys.stdin)
for m in d.get('trend',[]):
    rb='ROLLBACK' if m.get('rolledBack') in ['true',True] else ''
    reg='REGRESSION' if m.get('regressionIntroduced') in ['true',True] else ''
    status='merged' if int(m.get('tasksMerged',0))>0 else 'failed'
    print(f'{m.get(\"cycleId\",\"?\")} [{status}] {rb} {reg} {m.get(\"taskTitle\",\"?\")[:50]} tests:{m.get(\"testsBefore\",\"?\")}→{m.get(\"testsAfter\",\"?\")}')
"
```

| Type | Indicators | Severity |
|------|-----------|----------|
| Test regression | Test count dropped (manifest's `verify.test`) | HIGH if >10%, MEDIUM otherwise |
| Typecheck failure | manifest's `verify.typecheck` errors | MEDIUM |
| Web service crash | `$TARGET_SERVICE` failed/restarting | HIGH |
| Build failure | manifest's `verify.build` fails | HIGH |
| External-dependency degradation | An external API/provider the target integrates with is erroring | MEDIUM |
| Domain-data drift | Domain-specific data-consistency invariant violated (see the target's own `CONTEXT.md` / `docs/agents/domain.md` for what that means for THIS target) | CRITICAL |
| Ingestion race | Stale-feed / freshness-window race in an ingestion pipeline | HIGH |

For the target-specific incident families beyond this generic taxonomy (which
external dependencies it has, what "domain-data drift" means for this
particular target, what to `grep` the logs for), read the target's own
`$TARGET_WS/CONTEXT.md` and `$TARGET_WS/docs/agents/domain.md` — this playbook
intentionally does not restate target-specific vocabulary (INV-8, issue #4411).

### Phase 2: Root cause

#### Test regressions
```bash
git -C "${TARGET_WS:?unset - re-run the seam preamble in this Bash call}" show --stat <suspect_sha>
# Failing job log from the CI run that covers the suspect SHA (read-only):
gh run view <run_id> --repo "$TARGET_GH_REPO" --log-failed 2>&1 | grep -iE "fail|✗" | head -20
```
**Don't** run `git bisect` in `$TARGET_WS`. Use the watcher's health delta +
git diff to identify the suspect cycle; reproduce locally only inside a
remediation worktree (Phase 3).

#### Web-service crashes
```bash
journalctl --user -u "$TARGET_SERVICE" --no-pager -n 30 2>&1 | grep -v "systemd\|Consumed" | tail -15
gh api -X GET "repos/$TARGET_GH_REPO/actions/runs" -f branch=main -f per_page=3 \
  --jq '.workflow_runs[] | "\(.id) \(.conclusion // .status) \(.name)"'   # build state comes from CI, not a local build
journalctl --user -u "$TARGET_SERVICE" --no-pager -n 50 2>&1 | grep "MODULE_NOT_FOUND\|Cannot find\|ERR_MODULE"
```

#### Typecheck failures
```bash
gh run view <run_id> --repo "$TARGET_GH_REPO" --log-failed 2>&1 | grep -iE "error TS|error:" | head -30   # read-only CI log
```

#### External-dependency / domain-data drift
```bash
# Target-specific root-cause families (external API contract drift, domain-data
# inconsistency, ingestion freshness-window races) — read $TARGET_WS/CONTEXT.md
# for what these mean concretely on this target before grepping for them.
curl -s "$TARGET_WEB_URL/api/health/full" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for name,svc in (d.get('services') or {}).items():
    st=svc.get('status','?')
    if st!='ok': print(f'{name}: {st} — {svc.get(\"detail\",\"\")[:80]}')
"
journalctl --user -u "$TARGET_SERVICE" --no-pager -n 80 2>&1 | grep -iE "error|stale|freshness|timeout" | tail -15
```

### Phase 3: Remediation

Every remediation, auto-fix or revert, is a **branch off `origin/main` in a
fresh worktree that ends in a PR** — the Target's `main` requires a PR and a
passing check with admins enforced, so a direct push is rejected for every
actor. Create the worktree exactly as `hydra-target-build` Step 0.6 does
(nested under `$TARGET_APP_DIR/.worktrees/`), then `cd` into it as `$TARGET_WT`.
Never remediate in `$TARGET_WS`, and never restart the service: the Target's own
CI-owned deploy ships the merged PR.

#### Auto-fix (if obvious + bounded)
- Typecheck error from recent merge → fix the type
- Missing import → add it
- Merge conflict markers → resolve

Auto-fix only if: ≤10 lines, mechanical (not design), the manifest's `verify.test` passes in the worktree.

```bash
cd "${TARGET_WT:?unset - create the worktree per hydra-target-build Step 0.6}"
git fetch --quiet origin main
git checkout -b "fix/incident-$(date -u +%Y-%m-%d-%H%M)" origin/main
# fix
# Verify commands are app-dir relative: cd to the app-dir equivalent INSIDE the worktree.
APP_REL="${TARGET_APP_DIR#"$TARGET_WS"}"
TEST_CMD=$(jq -r '.verify.test' "$TARGET_WS/.hydra/manifest.json")
TYPECHECK_CMD=$(jq -r '.verify.typecheck' "$TARGET_WS/.hydra/manifest.json")
( cd "${TARGET_WT:?unset - create the worktree per hydra-target-build Step 0.6}$APP_REL" && eval "$TYPECHECK_CMD" && eval "$TEST_CMD" )     # worktree only
git add <files> && git commit -m "fix: <description>"
git push -u origin HEAD
gh pr create --repo "$TARGET_GH_REPO" --base main --title "fix: <description>" --body "Incident auto-fix. Refs #<post-mortem issue>"
```

#### Revert
Reuse the revert-PR recipe in the merge-flow reference, Step 8
(`_fragments/hydra-target-build-merge-flow.md`) verbatim: a `revert/<id>` branch
off `origin/main` in `$TARGET_WT`, `git revert --no-edit <breaking_sha>`, pushed
and opened with `gh pr create --repo "$TARGET_GH_REPO" --base main`. The revert
PR goes through the same required CI + automerge + CI-owned deploy as any other
change. Verify the revert before pushing: after the revert, run the same
app-dir verify block as Auto-fix (`cd "$TARGET_WT$APP_REL"`, then the manifest's
`verify.typecheck` and `verify.test`).

#### Escalate
Create an issue on the Target board (`--repo "$TARGET_GH_REPO"`) with all
evidence, label `needs-triage`, high priority.

### Phase 4: Post-mortem

The post-mortem lives on the Target board (`$TARGET_GH_REPO`, ADR-0031
Decision 4) with the `needs-triage` label. Dedup first with
`gh api -X GET search/issues -f q="repo:$TARGET_GH_REPO is:issue is:open Post-mortem (Target)"`.

```bash
gh issue create --repo "$TARGET_GH_REPO" --title "Post-mortem (Target): <summary>" --label "needs-triage" --body "$(cat <<'EOF'
## Incident Summary
- **Realm:** Target
- **Type:** <regression/crash/build-failure/domain-data-drift/ingestion-race>
- **Severity:** <critical/high/medium>
- **Duration:** <detected> → <resolved>
- **Impact:** <what was broken, how long>

## Timeline
1. <ts> — <what happened>
2. <ts> — <detected (post-merge health watcher / manual)>
3. <ts> — <action taken>

## Root Cause
<specific commit, file under the target's app source, condition>

## Remediation
<auto-fix / revert / escalate>

## Prevention
- [ ] Add test coverage for <scenario>
- [ ] Add pre-merge check for <condition>

## Evidence
<metrics, health-endpoint delta, logs, diffs>

---
Source: hydra-target-incident | $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
)"
```

### Phase 5: Report

| Field | Value |
|-------|-------|
| Realm | Target |
| Type | <regression/crash/build-failure/domain-data-drift/ingestion-race> |
| Severity | <critical/high/medium> |
| Root cause | <1-sentence> |
| Breaking commit | <sha or "unknown"> |
| Remediation | <auto-fix/revert/escalate> |
| Tests after | <count from the manifest's verify.test> |
| Post-mortem | #<issue> |

## Safety rules

1. **NEVER push to `main` or force-push anything** — every change is a PR from a worktree branch.
2. **NEVER delete data** — read-only investigation; a money-critical or
   settlement-adjacent target's data stores are especially sensitive (check
   `$TARGET_WS/.hydra/manifest.json`'s `riskCritical.surface`).
3. **If uncertain about root cause, escalate** — don't guess-fix prod.
4. **Always create a post-mortem** — even for auto-fixed incidents.
5. **Never build, test, check out, or restart in `$TARGET_WS`** — it is the
   serving tree; investigate from CI state, git log, journal and health only.
6. **Stay single-realm** — every command targets the Target (read-only on
   `$TARGET_WS`, writes only in a remediation worktree); never `cd`
   into `~/hydra` source, and never write Orchestrator memory. Cross-realm
   incident handling is forbidden by ADR-0025.
