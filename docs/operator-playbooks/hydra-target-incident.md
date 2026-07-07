---
name: hydra-target-incident
disable_model_invocation: true
description: Automated incident response for Target post-merge regressions, web-service crashes, and deploy failures — investigate, attempt a fix or revert, and file a post-mortem.
when_to_use: "When hydra-target-build's Step 8.6 post-merge health watcher alarms on a Target regression, a hydra-betting-web service crashes, a Target deploy fails, or the user says 'target incident', 'what broke on the target', 'investigate the betting failure'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
arguments: [context]
---

# Hydra Target Incident

Automated incident response for the **Target** (`~/hydra-betting`, code root
`~/hydra-betting/web/src`). Investigates root cause of post-merge regressions,
web-service crashes, and deploy failures. Attempts a fix or revert, then files a
post-mortem.

## Realm scope — single-realm to the Target (ADR-0025, issue #2553)

This skill operates **only** on `~/hydra-betting` (the Target). It is the Target
sibling of the Orchestrator-only `hydra-incident`. The two are deliberately
single-realm: `hydra-incident` never touches `~/hydra-betting`, and
`hydra-target-incident` never touches `~/hydra` source. The shared issue tracker
(`gaberoo322/hydra`) is realm-agnostic — only the investigated *tree* is
realm-scoped — so Target post-mortems file there with the `target-backlog`
label. Phase-5 prevention rules route to the **Target** planner/executor
feedback surface only (`config/feedback/to-planner.md`,
`config/feedback/to-executor.md`); never write Orchestrator memory from here.

> Target test-suite caveat (CLAUDE.md): in `~/hydra-betting/web`, bare
> `npm test` is a count-gate + 3 sentinels, NOT the full suite. The real suite
> is `npm run test:raw`. When confirming a Target regression's blast radius,
> trust CI's vitest job as the gate and use `test:raw` for a local read — never
> read the bare `npm test` footer as "the full suite is green".

## Trigger context

1. From `hydra-target-build` Step 8.6 — the alarm-only post-merge health watcher
   (`scripts/target/post-merge-health.ts --dispatch`) spawns this skill on a
   detected Target regression. That watcher is **alarm-only**: it never reverts
   and never blocks a merge; it hands off to this skill, which decides whether
   to investigate / fix / revert.
2. Manual ("investigate the betting regression", "what broke on the target").
3. With `$context` argument describing what's known (the watcher passes the
   merge SHA + the health delta).

## Process

### Phase 1: Triage (<60s)

```bash
hydra health
systemctl --user status hydra-betting-web.service 2>&1 | head -5
cd ~/hydra-betting && npm run typecheck 2>&1 | tail -3
cd ~/hydra-betting/web && npm run test:raw 2>&1 | tail -8   # real suite, not the count-gate

cd ~/hydra-betting && git log --oneline -10
cd ~/hydra-betting && git diff HEAD~1 --stat
cd ~/hydra-betting && git log --oneline -20 | grep -i "revert"

# Per-service post-merge health — the same signal that fired the watcher.
curl -s http://localhost:3000/api/health/full 2>/dev/null | python3 -m json.tool | head -40

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
| Test regression | Test count dropped (`test:raw`) | HIGH if >10%, MEDIUM otherwise |
| Typecheck failure | `npm run typecheck` errors | MEDIUM |
| Web service crash | `hydra-betting-web` failed/restarting | HIGH |
| Build failure | `next build` fails | HIGH |
| Venue/API degradation | External venue APIs erroring | MEDIUM |
| Settlement / data drift | Settlement or market-data inconsistencies | CRITICAL |
| Market-data race | Stale-feed / freshness-window race in scanner/ingestion | HIGH |

### Phase 2: Root cause

#### Test regressions
```bash
cd ~/hydra-betting
git show --stat <suspect_sha>
cd ~/hydra-betting/web && npm run test:raw 2>&1 | grep -iE "fail|✗" | head -20
```
**Don't** run `git bisect` on a dirty tree. Use the watcher's health delta +
git diff to identify the suspect cycle.

#### Web-service crashes
```bash
journalctl --user -u hydra-betting-web.service --no-pager -n 30 2>&1 | grep -v "systemd\|Consumed" | tail -15
cd ~/hydra-betting/web && npm run build 2>&1 | tail -20
journalctl --user -u hydra-betting-web.service --no-pager -n 50 2>&1 | grep "MODULE_NOT_FOUND\|Cannot find\|ERR_MODULE"
```

#### Typecheck failures
```bash
cd ~/hydra-betting/web && npm run typecheck 2>&1 | head -30
```

#### Venue / settlement / market-data drift
```bash
# Target-specific root-cause families: venue API contract drift, settlement
# data inconsistency, scanner/ingestion freshness-window races.
curl -s http://localhost:3000/api/health/full 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
for name,svc in (d.get('services') or {}).items():
    st=svc.get('status','?')
    if st!='ok': print(f'{name}: {st} — {svc.get(\"detail\",\"\")[:80]}')
"
journalctl --user -u hydra-betting-web.service --no-pager -n 80 2>&1 | grep -iE "venue|settle|stale|freshness|odds|pinnacle|opticodds" | tail -15
```

### Phase 3: Remediation

#### Auto-fix (if obvious + bounded)
- Typecheck error from recent merge → fix the type, commit, push
- Missing import → add it
- Merge conflict markers → resolve

Auto-fix only if: ≤10 lines, mechanical (not design), `test:raw` passes after.

```bash
cd ~/hydra-betting
git checkout -b fix/incident-$(date -u +%Y-%m-%d-%H%M)
# fix
npm run typecheck && (cd web && npm run test:raw)
git add <files> && git commit -m "fix: <description>"
# acquire merge lock, merge, push, release (use hydra raw POST /merge/lock and /merge/unlock)
```

#### Revert
```bash
cd ~/hydra-betting
git revert --no-edit <breaking_sha>
git push origin main
systemctl --user restart hydra-betting-web.service
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
- **Realm:** Target (hydra-betting)
- **Type:** <regression/crash/build-failure/settlement-drift/market-data-race>
- **Severity:** <critical/high/medium>
- **Duration:** <detected> → <resolved>
- **Impact:** <what was broken, how long>

## Timeline
1. <ts> — <what happened>
2. <ts> — <detected (post-merge health watcher / manual)>
3. <ts> — <action taken>

## Root Cause
<specific commit, file under web/src, condition>

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
cat >> ~/hydra-betting/config/feedback/to-executor.md <<'EOF'

- <incident-type>: <what to do differently> (post-mortem #<issue>)
EOF
```

### Phase 6: Report

| Field | Value |
|-------|-------|
| Realm | Target (hydra-betting) |
| Type | <regression/crash/build-failure/settlement-drift/market-data-race> |
| Severity | <critical/high/medium> |
| Root cause | <1-sentence> |
| Breaking commit | <sha or "unknown"> |
| Remediation | <auto-fix/revert/escalate> |
| Tests after | <count from test:raw> |
| Post-mortem | #<issue> |
| Prevention rule | <recorded/not-needed> |

## Safety rules

1. **NEVER force-push to main** — only forward-moving commits.
2. **NEVER delete data** — read-only investigation; the Target's settlement and
   market-data stores are especially sensitive.
3. **If uncertain about root cause, escalate** — don't guess-fix prod.
4. **Always create a post-mortem** — even for auto-fixed incidents.
5. **If the working tree is dirty, don't touch it** — investigate from git log +
   metrics only.
6. **Stay single-realm** — every command targets `~/hydra-betting`; never `cd`
   into `~/hydra` source, and never write Orchestrator memory. Cross-realm
   incident handling is forbidden by ADR-0025.
