#!/bin/bash
# Bounded foreground poll for PR 4532 required checks settling.
PR=4532
REPO=gaberoo322/hydra
deadline=$((SECONDS + 480))
run_state="pending"
while [ "$SECONDS" -lt "$deadline" ]; do
  run_state=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
    --jq 'if ([.statusCheckRollup[]?.status] | any(IN("QUEUED","IN_PROGRESS","PENDING","WAITING"))) then "pending" else "settled" end' 2>/dev/null)
  if [ "$run_state" = "settled" ]; then
    break
  fi
  sleep 15
done
echo "FINAL_STATE=$run_state"
