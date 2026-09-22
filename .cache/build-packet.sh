#!/bin/bash
set -e
OUT=.cache/changed_files_packet.txt
: > "$OUT"
FILES=(
  "docs/operator-playbooks/_fragments/hydra-autopilot-ops-reference.md"
  "scripts/autopilot/collect-state.sh"
  "src/api.ts"
  "src/api/autopilot-slot-events.ts"
  "src/event-bus.ts"
  "src/schemas/autopilot-slot-events.ts"
  "src/types.d.ts"
  "test/autopilot-hooks.test.mts"
  "test/autopilot-slot-events.test.mts"
  "test/event-bus.test.mts"
  "test/fixtures/suite-count-baseline.json"
)
for f in "${FILES[@]}"; do
  echo "===== $f @ HEAD =====" >> "$OUT"
  git show "4862a6ee9:$f" >> "$OUT" 2>&1
  echo "" >> "$OUT"
done
wc -l "$OUT"
