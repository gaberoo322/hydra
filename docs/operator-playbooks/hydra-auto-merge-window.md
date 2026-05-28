---
name: hydra-auto-merge-window
description: Time-bounded auto-merger for the codex-removal refactor batch. When a window is open, classifies open hydra-dev PRs linked to refactor-batch issues, applies operator-approved to Tier-0 PRs, and enables auto-merge on Tier 1/2/3. Audit-only outside the window.
when_to_use: "When the operator says 'open the merge window', 'close the merge window', 'auto-merge refactor batch', or wants to manage bulk approval of a labeled issue batch. Also invoked on a /loop interval to process eligible PRs."
allowed_tools_claude: Read(*) Bash(*) Write(*)
arguments: [action]
---

# Hydra Auto-Merge Window

Operator-controlled batch auto-merger. Used during the codex-removal refactor (and any future batched refactor) to bulk-approve PRs against an issue list without per-PR clicking.

## Safety model

Three nested constraints — all must pass before any PR is touched:

1. **Window is open**: `~/.config/hydra/auto-merge-until.txt` exists and contains an ISO8601 timestamp in the future.
2. **PR is in the batch**: PR body references an issue carrying the configured batch label (default `refactor-batch-2026-05`).
3. **CI is green**: branch protection still enforces tests + tier-gate. This skill never bypasses CI — it only does what the operator would do manually: apply `operator-approved` to Tier-0 PRs and click `gh pr merge --auto`.

Outside the window the skill is a no-op. Audit log at `~/.config/hydra/auto-merge-log.txt` records every action.

## Actions

`$action` controls the operation:

- `open [HOURS]` — open the window (default 6h, max 24h)
- `close` — close the window immediately
- `status` — print window state + eligible PR count
- `run` (default) — process eligible PRs once
- `loop` — print the recommended /loop command

## Configuration

```bash
WINDOW_FILE=~/.config/hydra/auto-merge-until.txt
LOG_FILE=~/.config/hydra/auto-merge-log.txt
REPO=gaberoo322/hydra
BATCH_LABEL=refactor-batch-2026-05
MAX_WINDOW_HOURS=24
DEFAULT_WINDOW_HOURS=6
```

## Step 1: parse action

```bash
ACTION="${1:-run}"
mkdir -p ~/.config/hydra
case "$ACTION" in
  open) ACTION=open;;
  close) ACTION=close;;
  status) ACTION=status;;
  run) ACTION=run;;
  loop) ACTION=loop;;
  *) echo "Unknown action: $ACTION (expected: open|close|status|run|loop)"; exit 2;;
esac
```

## Step 2: window management

**Open:**
```bash
HOURS="${2:-6}"
if [ "$HOURS" -gt 24 ] 2>/dev/null; then HOURS=24; fi
UNTIL=$(date -u -d "+${HOURS} hours" '+%Y-%m-%dT%H:%M:%SZ')
echo "$UNTIL" > "$WINDOW_FILE"
echo "[$(date -u +%FT%TZ)] window OPENED until $UNTIL ($HOURS h)" | tee -a "$LOG_FILE"
echo "Eligible PRs will be auto-merged. Close with: hydra-auto-merge-window close"
```

**Close:**
```bash
if [ -f "$WINDOW_FILE" ]; then
  PREV=$(cat "$WINDOW_FILE")
  rm "$WINDOW_FILE"
  echo "[$(date -u +%FT%TZ)] window CLOSED (was open until $PREV)" | tee -a "$LOG_FILE"
else
  echo "Window already closed."
fi
```

**Status:**
```bash
if [ ! -f "$WINDOW_FILE" ]; then
  echo "Window: CLOSED"
else
  UNTIL=$(cat "$WINDOW_FILE")
  NOW=$(date -u +%s)
  THEN=$(date -u -d "$UNTIL" +%s 2>/dev/null || echo 0)
  if [ "$NOW" -ge "$THEN" ]; then
    echo "Window: EXPIRED (was open until $UNTIL)"
  else
    REMAINING_MIN=$(( (THEN - NOW) / 60 ))
    echo "Window: OPEN until $UNTIL (${REMAINING_MIN} min remaining)"
  fi
fi

# Eligible PR count
gh pr list --repo "$REPO" --state open --json number,body \
  --jq "[.[] | select(.body | test(\"#[0-9]+\"))] | length" \
  | xargs -I {} echo "Open PRs referencing any issue: {}"
```

**Loop:**
```bash
echo "Run continuously with:  /loop 10m /hydra-auto-merge-window run"
echo "Window controls:        /hydra-auto-merge-window open 6"
echo "                        /hydra-auto-merge-window close"
echo "                        /hydra-auto-merge-window status"
```

## Step 3: run (the actual auto-merge pass)

The `run` action is the workhorse. Each step gates the next — if any check fails, exit cleanly with a log line.

### 3a. Window check

```bash
if [ ! -f "$WINDOW_FILE" ]; then
  echo "[$(date -u +%FT%TZ)] no window file — exit (no-op)" >> "$LOG_FILE"
  exit 0
fi
UNTIL=$(cat "$WINDOW_FILE")
NOW=$(date -u +%s)
THEN=$(date -u -d "$UNTIL" +%s 2>/dev/null || echo 0)
if [ "$NOW" -ge "$THEN" ]; then
  echo "[$(date -u +%FT%TZ)] window expired ($UNTIL) — auto-closing" | tee -a "$LOG_FILE"
  rm -f "$WINDOW_FILE"
  exit 0
fi
echo "[$(date -u +%FT%TZ)] window open until $UNTIL — scanning PRs" >> "$LOG_FILE"
```

### 3b. Build the eligible-issue list

A PR is eligible only if its body references an issue carrying `$BATCH_LABEL`.

```bash
# Fetch issue numbers carrying the batch label
ELIGIBLE_ISSUES=$(gh issue list --repo "$REPO" --label "$BATCH_LABEL" --state open \
  --limit 100 --json number --jq '[.[].number] | join("|")')

if [ -z "$ELIGIBLE_ISSUES" ]; then
  echo "[$(date -u +%FT%TZ)] no open issues with label $BATCH_LABEL — exit" >> "$LOG_FILE"
  exit 0
fi
```

### 3c. Fetch candidate PRs

```bash
gh pr list --repo "$REPO" --state open \
  --json number,title,body,headRefName,labels,mergeable,statusCheckRollup \
  --limit 50 > /tmp/auto-merge-prs.json
```

### 3d. Filter + classify + act

For each PR:
1. Body must reference an eligible issue number: regex `(#|issues/)($ELIGIBLE_ISSUES)\b`.
2. CI rollup must be `SUCCESS` (or `PENDING` → re-check next loop, do nothing now).
3. Run `tier-classify` on the changed file list.
4. If Tier 0 → apply `operator-approved` label (if not already present).
5. If Tier 1/2/3 → enable auto-merge (`gh pr merge --auto --squash`).
6. Append every action to `$LOG_FILE`.
7. Post one PR comment per PR documenting the auto-action (audit trail on the PR itself).

```bash
python3 <<PYEOF
import json, re, subprocess, os, sys
from datetime import datetime, timezone

REPO = "${REPO}"
LOG = os.path.expanduser("${LOG_FILE}")
ELIGIBLE = "${ELIGIBLE_ISSUES}".split("|")
ELIGIBLE_RE = re.compile(r"(?:#|issues/)(" + "|".join(re.escape(i) for i in ELIGIBLE) + r")\b")

with open("/tmp/auto-merge-prs.json") as f:
    prs = json.load(f)

def log(msg):
    line = f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}\n"
    with open(LOG, "a") as f:
        f.write(line)
    print(line, end="")

def gh(*args, check=True):
    return subprocess.run(["gh", *args], capture_output=True, text=True, check=check)

acted = 0
for pr in prs:
    num = pr["number"]
    body = pr.get("body") or ""
    if not ELIGIBLE_RE.search(body):
        continue

    # CI status
    rollup = pr.get("statusCheckRollup") or []
    states = {c.get("conclusion") or c.get("state") for c in rollup if isinstance(c, dict)}
    if "FAILURE" in states or "CANCELLED" in states or "TIMED_OUT" in states:
        log(f"PR #{num}: CI red ({states}) — skip")
        continue
    if "PENDING" in states or "IN_PROGRESS" in states or "QUEUED" in states:
        log(f"PR #{num}: CI pending — will retry next pass")
        continue
    # If no rollup yet (PR just opened), skip
    if not states:
        log(f"PR #{num}: no CI status yet — skip")
        continue

    # Changed files
    diff = gh("pr", "diff", "--name-only", str(num), "--repo", REPO, check=False)
    if diff.returncode != 0:
        log(f"PR #{num}: pr diff failed — skip")
        continue
    files = [f for f in diff.stdout.splitlines() if f.strip()]
    if not files:
        log(f"PR #{num}: no files changed — skip")
        continue

    # Classify tier
    home_hydra = os.path.expanduser("~/hydra")
    cls = subprocess.run(
        ["npx", "tsx", "scripts/tier-classify.ts", *files],
        cwd=home_hydra, capture_output=True, text=True
    )
    try:
        result = json.loads(cls.stdout)
    except Exception:
        log(f"PR #{num}: tier-classify parse error — skip. stderr={cls.stderr[:200]}")
        continue
    tier = result.get("tier")
    reason = result.get("reason", "")
    labels = {l["name"] for l in pr.get("labels") or []}

    # Tier 0: apply operator-approved label (CI re-runs and passes)
    if tier == 0:
        if "operator-approved" in labels:
            log(f"PR #{num}: tier=0 already operator-approved — enabling auto-merge")
        else:
            r = gh("pr", "edit", str(num), "--repo", REPO, "--add-label", "operator-approved", check=False)
            if r.returncode != 0:
                log(f"PR #{num}: label apply failed — {r.stderr.strip()[:200]}")
                continue
            log(f"PR #{num}: TIER-0 AUTO-APPROVED via window. Reason: {reason}")
            gh("pr", "comment", str(num), "--repo", REPO,
               "--body", f"Auto-approved via refactor-batch window (this skill: hydra-auto-merge-window). Tier-0 reason: {reason}. CI re-runs against the labeled commit.",
               check=False)
        # Enable auto-merge (will wait for CI to re-pass post-label)
        r = gh("pr", "merge", str(num), "--repo", REPO, "--auto", "--squash", check=False)
        if r.returncode != 0:
            log(f"PR #{num}: auto-merge enable failed — {r.stderr.strip()[:200]}")
        else:
            log(f"PR #{num}: auto-merge enabled (tier 0)")
            acted += 1
        continue

    # Tier 1/2/3: just enable auto-merge
    if tier in (1, 2, 3):
        r = gh("pr", "merge", str(num), "--repo", REPO, "--auto", "--squash", check=False)
        if r.returncode != 0:
            err = r.stderr.strip()[:200]
            # "already enabled" is fine
            if "already" not in err.lower():
                log(f"PR #{num}: tier={tier} auto-merge failed — {err}")
            continue
        log(f"PR #{num}: auto-merge enabled (tier {tier}). Reason: {reason}")
        gh("pr", "comment", str(num), "--repo", REPO,
           "--body", f"Auto-merge enabled via refactor-batch window. Tier {tier}: {reason}",
           check=False)
        acted += 1
        continue

    log(f"PR #{num}: unexpected tier {tier} — skip")

log(f"pass complete: acted on {acted} PR(s)")
PYEOF
```

## Operator workflow

```bash
# 1. File the refactor issues (already labeled refactor-batch-2026-05 + ready-for-agent)
# 2. Open the window for 6 hours
/hydra-auto-merge-window open 6

# 3. Let /loop /hydra-autopilot pick up the issues; PRs land as hydra-dev finishes them
#    Run the auto-merger periodically (manually or via /loop)
/loop 10m /hydra-auto-merge-window run

# 4. When done — close immediately, or just let it expire
/hydra-auto-merge-window close

# 5. Audit
tail -50 ~/.config/hydra/auto-merge-log.txt
gh pr list --repo gaberoo322/hydra --state merged --label refactor-batch-2026-05 --limit 20
```

## Failure modes the operator should know

- **CI fails after the operator-approved label lands**: the label triggers a CI re-run; if tests fail, auto-merge does not fire. The label stays on the PR (visible in audit) but nothing merges. Operator must close the PR or fix it.
- **PR body lacks issue reference**: not eligible. hydra-dev opens PRs that reference the issue; if a PR is hand-edited to remove the reference, it falls out of the batch.
- **Window expires mid-pass**: each pass re-checks the window at step 3a. A pass that started in-window completes; nothing new is started after expiry.
- **Two passes overlap**: `gh pr merge --auto` is idempotent. Worst case: a PR comment is posted twice. Not destructive.
- **Issue closed after PR opened**: PR is still eligible if its body references the (now-closed) issue number, because `gh issue list --label X` lists only OPEN issues by default. If the issue auto-closed when the PR merged, the next pass won't process other PRs referencing the same closed issue. Use `--state all` if this matters.

## What this skill does NOT do

- Does not modify branch protection rules.
- Does not modify `.github/workflows/ci.yml` (the tier-gate is exactly as before — `operator-approved` is still the only CI bypass mechanism).
- Does not modify `src/untouchable.ts` or `scripts/tier-classify.ts`.
- Does not run any agent. Pure label-application + auto-merge enablement.
- Does not run during normal operation when the window is closed.
