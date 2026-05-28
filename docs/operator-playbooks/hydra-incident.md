---
name: hydra-incident
description: Automated incident response for regressions, service crashes, and deployment failures. Investigates root cause, attempts fix or revert, creates post-mortem.
when_to_use: "When hydra-doctor finds a regression, hydra-target-build rolls back, tests collapse, a service crashes, or the user says 'incident', 'regression', 'what broke', 'investigate failure'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
arguments: [context]
---

# Hydra Incident

Automated incident response. Investigates root cause of regressions, crashes, deploy failures. Attempts fix or revert, creates a post-mortem.

## Trigger context

1. Manual ("investigate the regression", "what broke")
2. From `/hydra-doctor` when doctor can't quick-fix
3. From `/hydra-autopilot` when P0 health fails
4. With `$context` argument describing what's known

## Process

### Phase 1: Triage (<60s)

```bash
hydra health
systemctl --user status hydra-betting-web.service 2>&1 | head -5
cd ~/hydra-betting && npm run typecheck 2>&1 | tail -3
cd ~/hydra-betting/web && npm test 2>&1 | tail -5

cd ~/hydra-betting && git log --oneline -10
cd ~/hydra-betting && git diff HEAD~1 --stat
cd ~/hydra-betting && git log --oneline -20 | grep -i "revert"

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
| Test regression | Test count dropped | HIGH if >10%, MEDIUM otherwise |
| Typecheck failure | `npm run typecheck` errors | MEDIUM |
| Service crash | Web service failed/restarting | HIGH |
| Build failure | `next build` fails | HIGH |
| API degradation | External APIs erroring | MEDIUM |
| Data corruption | DB inconsistencies | CRITICAL |

### Phase 2: Root cause

#### Test regressions
```bash
cd ~/hydra-betting
git show --stat <suspect_sha>
```
**Don't** run `git bisect` on a dirty tree. Use metrics data + git diff to identify the suspect cycle.

#### Service crashes
```bash
journalctl --user -u hydra-betting-web.service --no-pager -n 30 2>&1 | grep -v "systemd\|Consumed" | tail -15
cd ~/hydra-betting/web && npm run build 2>&1 | tail -20
journalctl --user -u hydra-betting-web.service --no-pager -n 50 2>&1 | grep "MODULE_NOT_FOUND\|Cannot find\|ERR_MODULE"
```

#### Typecheck failures
```bash
cd ~/hydra-betting/web && npm run typecheck 2>&1 | head -30
```

### Phase 3: Remediation

#### Auto-fix (if obvious + bounded)
- Typecheck error from recent merge → fix the type, commit, push
- Missing import → add it
- Merge conflict markers → resolve

Auto-fix only if: ≤10 lines, mechanical (not design), tests pass after.

```bash
cd ~/hydra-betting
git checkout -b fix/incident-$(date -u +%Y-%m-%d-%H%M)
# fix
npm run typecheck && npm test
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
Create GitHub issue with all evidence, label `needs-triage`, high priority.

### Phase 4: Post-mortem

```bash
gh issue create --repo gaberoo322/hydra --title "Post-mortem: <summary>" --label "needs-triage" --body "$(cat <<'EOF'
## Incident Summary
- **Type:** <regression/crash/build-failure/data-corruption>
- **Severity:** <critical/high/medium>
- **Duration:** <detected> → <resolved>
- **Impact:** <what was broken, how long>

## Timeline
1. <ts> — <what happened>
2. <ts> — <detected>
3. <ts> — <action taken>

## Root Cause
<specific commit, file, condition>

## Remediation
<auto-fix / revert / escalate>

## Prevention
- [ ] Add test coverage for <scenario>
- [ ] Add pre-merge check for <condition>
- [ ] Update planner/executor feedback with prevention rule

## Evidence
<metrics, logs, diffs>

---
Source: hydra-incident | $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
)"
```

### Phase 5: Prevention rule

If the cause reveals a planner/executor pattern:
```bash
hydra raw POST /memory/executor/pattern '{
  "category":"<incident-type>",
  "action":"<what to do differently>",
  "example":"<incident description>",
  "cycleId":"incident-<date>"
}'
```

### Phase 6: Report

| Field | Value |
|-------|-------|
| Type | <regression/crash/build-failure> |
| Severity | <critical/high/medium> |
| Root cause | <1-sentence> |
| Breaking commit | <sha or "unknown"> |
| Remediation | <auto-fix/revert/escalate> |
| Tests after | <count> |
| Post-mortem | #<issue> |
| Prevention rule | <recorded/not-needed> |

## Safety rules

1. **NEVER force-push to main** — only forward-moving commits
2. **NEVER delete data** — read-only investigation
3. **If uncertain about root cause, escalate** — don't guess-fix prod
4. **Always create a post-mortem** — even for auto-fixed incidents
5. **If the working tree is dirty, don't touch it** — investigate from git log + metrics only
