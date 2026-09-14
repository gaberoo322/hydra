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

This skill operates **only** on `$TARGET_WS` (the Target). It is the Target
sibling of the Orchestrator-only `hydra-incident`. The two are deliberately
single-realm: `hydra-incident` never touches `$TARGET_WS`, and
`hydra-target-incident` never touches `~/hydra` source. The shared issue tracker
(`gaberoo322/hydra`) is realm-agnostic — only the investigated *tree* is
realm-scoped — so Target post-mortems file there with the `target-backlog`
label. Phase-5 prevention rules route to the **Target** planner/executor
feedback surface only (`config/feedback/to-planner.md`,
`config/feedback/to-executor.md`); never write Orchestrator memory from here.

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
   (`scripts/target/post-merge-health.ts --dispatch`) spawns this skill on a
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
TEST_CMD=$(jq -r '.verify.test' "$TARGET_WS/.hydra/manifest.json")
TYPECHECK_CMD=$(jq -r '.verify.typecheck' "$TARGET_WS/.hydra/manifest.json")
( cd "$TARGET_APP_DIR" && eval "$TYPECHECK_CMD" 2>&1 | tail -3 )
( cd "$TARGET_APP_DIR" && eval "$TEST_CMD" 2>&1 | tail -8 )   # the manifest's real suite, never assume bare `npm test`

git -C "$TARGET_WS" log --oneline -10
git -C "$TARGET_WS" diff HEAD~1 --stat
git -C "$TARGET_WS" log --oneline -20 | grep -i "revert"

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
git -C "$TARGET_WS" show --stat <suspect_sha>
( cd "$TARGET_APP_DIR" && eval "$TEST_CMD" 2>&1 | grep -iE "fail|✗" | head -20 )
```
**Don't** run `git bisect` on a dirty tree. Use the watcher's health delta +
git diff to identify the suspect cycle.

#### Web-service crashes
```bash
journalctl --user -u "$TARGET_SERVICE" --no-pager -n 30 2>&1 | grep -v "systemd\|Consumed" | tail -15
BUILD_CMD=$(jq -r '.verify.build' "$TARGET_WS/.hydra/manifest.json")
( cd "$TARGET_APP_DIR" && eval "$BUILD_CMD" 2>&1 | tail -20 )
journalctl --user -u "$TARGET_SERVICE" --no-pager -n 50 2>&1 | grep "MODULE_NOT_FOUND\|Cannot find\|ERR_MODULE"
```

#### Typecheck failures
```bash
( cd "$TARGET_APP_DIR" && eval "$TYPECHECK_CMD" 2>&1 | head -30 )
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

#### Auto-fix (if obvious + bounded)
- Typecheck error from recent merge → fix the type, commit, push
- Missing import → add it
- Merge conflict markers → resolve

Auto-fix only if: ≤10 lines, mechanical (not design), the manifest's `verify.test` passes after.

```bash
cd "$TARGET_WS"
git checkout -b fix/incident-$(date -u +%Y-%m-%d-%H%M)
# fix
( cd "$TARGET_APP_DIR" && eval "$TYPECHECK_CMD" && eval "$TEST_CMD" )
git add <files> && git commit -m "fix: <description>"
# acquire merge lock, merge, push, release (use hydra raw POST /merge/lock and /merge/unlock)
```

#### Revert
```bash
cd "$TARGET_WS"
git revert --no-edit <breaking_sha>
git push origin main
systemctl --user restart "$TARGET_SERVICE"
```

#### Escalate
Create a GitHub issue with all evidence, label `needs-triage` + `target-backlog`,
high priority.

### Phase 4: Post-mortem

The tracker is realm-agnostic; the post-mortem lives on `gaberoo322/hydra` with
the `target-backlog` label so it routes to the Target board.

```bash
gh issue create --repo gaberoo322/hydra --title "Post-mortem (Target): <summary>" --label "needs-triage" --label "target-backlog" --body "$(cat <<'EOF'
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
- [ ] Append a prevention rule to the Target planner/executor feedback files

## Evidence
<metrics, /api/health/full delta, logs, diffs>

---
Source: hydra-target-incident | $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
)"
```

### Phase 5: Prevention rule (Target feedback surface only)

If the cause reveals a recurring Target planner/executor pattern, append a
prevention instruction to the **Target** feedback files the build loop already
reads (`config/feedback/to-planner.md`, `config/feedback/to-executor.md`). Do
NOT write the Orchestrator's executor-pattern memory from here — that is a
cross-realm write the single-realm contract forbids.

```bash
# Append a one-line prevention instruction to the matching Target feedback file.
# Prefer to-executor.md for "how to build" gotchas, to-planner.md for
# "what to scope / sequence" gotchas.
cat >> "$TARGET_WS/config/feedback/to-executor.md" <<'EOF'

- <incident-type>: <what to do differently> (post-mortem #<issue>)
EOF
```

### Phase 6: Report

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
| Prevention rule | <recorded/not-needed> |

## Safety rules

1. **NEVER force-push to main** — only forward-moving commits.
2. **NEVER delete data** — read-only investigation; a money-critical or
   settlement-adjacent target's data stores are especially sensitive (check
   `$TARGET_WS/.hydra/manifest.json`'s `riskCritical.surface`).
3. **If uncertain about root cause, escalate** — don't guess-fix prod.
4. **Always create a post-mortem** — even for auto-fixed incidents.
5. **If the working tree is dirty, don't touch it** — investigate from git log +
   metrics only.
6. **Stay single-realm** — every command targets `$TARGET_WS`; never `cd`
   into `~/hydra` source, and never write Orchestrator memory. Cross-realm
   incident handling is forbidden by ADR-0025.
