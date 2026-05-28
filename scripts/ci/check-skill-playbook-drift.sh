#!/usr/bin/env bash
# check-skill-playbook-drift.sh — fail when the set of hydra-* operator-playbooks
# drifts from what scripts/sync-skills.sh would actually emit.
#
# Why this exists (issue #666): 10 hydra-* skills were previously installed under
# ~/.claude/skills/<name>/SKILL.md with no source-of-truth playbook in
# docs/operator-playbooks/<name>.md. The SKILL.md files carried a "DO NOT EDIT"
# banner pointing at a file that didn't exist anywhere in this repo's history —
# misleading, not load-bearing. This check prevents the orphaned state from
# coming back: every hydra-* playbook on disk must have valid frontmatter (name +
# description) and must therefore be regeneratable by sync-skills.sh.
#
# What this checks:
#   1. Every `docs/operator-playbooks/hydra-*.md` has parseable frontmatter
#      (`name:` and `description:` keys present). The one allowed exception is
#      `hydra-target-adversarial.md` — its frontmatter is intentionally broken
#      and out of scope per #666.
#   2. Optional (CI default OFF, dev opt-in): when
#      `HYDRA_DRIFT_CHECK_INSTALLED=1` is set, every installed hydra-* skill
#      under `~/.claude/skills/` has a matching playbook. CI doesn't run this
#      branch because runners don't have `~/.claude/skills/` populated; the
#      check is for local hygiene on operator machines.
#
# Exit codes:
#   0 — no drift
#   1 — orphaned playbook (broken frontmatter) OR orphaned installed skill (when
#       HYDRA_DRIFT_CHECK_INSTALLED=1)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLAYBOOKS="$REPO_ROOT/docs/operator-playbooks"

# Explicit exception list. Keep this small. If you add to it, link the issue
# explaining why the playbook is in a known-broken state.
ALLOWED_EXCEPTIONS=(
  "hydra-target-adversarial"  # broken frontmatter; #666 out-of-scope, separate cleanup
)

is_exception() {
  local name="$1"
  for ex in "${ALLOWED_EXCEPTIONS[@]}"; do
    [ "$name" = "$ex" ] && return 0
  done
  return 1
}

# Detect playbooks with broken or missing frontmatter (excluding exceptions).
broken_playbooks=()
shopt -s nullglob
for pb in "$PLAYBOOKS"/hydra-*.md; do
  base="$(basename "$pb" .md)"
  if is_exception "$base"; then
    continue
  fi
  # Use the same parser shape as sync-skills.sh so this gate fails for the same
  # reasons sync-skills.sh would skip.
  status=$(python3 - "$pb" <<'PY'
import sys, re
with open(sys.argv[1], "r", encoding="utf-8") as f:
    text = f.read()
m = re.match(r"^---\n(.*?)\n---\n.*$", text, re.DOTALL)
if not m:
    print("no-frontmatter")
    sys.exit(0)
fm_raw = m.group(1)
fm = {}
for line in fm_raw.splitlines():
    line = line.rstrip()
    if not line or line.startswith("#") or ":" not in line:
        continue
    k, _, v = line.partition(":")
    fm[k.strip()] = v.strip()
name = fm.get("name", "")
desc = fm.get("description", "")
if not name or not desc:
    print("missing-name-or-description")
    sys.exit(0)
print("ok")
PY
)
  if [ "$status" != "ok" ]; then
    broken_playbooks+=("$base ($status)")
  fi
done
shopt -u nullglob

# Optional: cross-check against installed skills. Off by default — CI runners
# don't have ~/.claude/skills/ populated. Operators run this locally to detect
# orphans they introduced by hand-editing SKILL.md without writing a playbook.
orphan_skills=()
if [ "${HYDRA_DRIFT_CHECK_INSTALLED:-0}" = "1" ]; then
  CLAUDE_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
  if [ -d "$CLAUDE_DIR" ]; then
    shopt -s nullglob
    for skill_dir in "$CLAUDE_DIR"/hydra-*/; do
      name="$(basename "$skill_dir")"
      if is_exception "$name"; then
        continue
      fi
      if [ ! -f "$PLAYBOOKS/$name.md" ]; then
        orphan_skills+=("$name")
      fi
    done
    shopt -u nullglob
  else
    echo "check-skill-playbook-drift: HYDRA_DRIFT_CHECK_INSTALLED=1 but $CLAUDE_DIR not found; skipping installed-side check" >&2
  fi
fi

rc=0
if [ ${#broken_playbooks[@]} -gt 0 ]; then
  echo "drift: playbooks with broken or missing frontmatter:" >&2
  for p in "${broken_playbooks[@]}"; do
    echo "  - $p" >&2
  done
  echo "" >&2
  echo "Fix: each docs/operator-playbooks/hydra-*.md must have ---frontmatter--- with at least 'name:' and 'description:'. See docs/operator-playbooks/hydra-grill.md or hydra-target-build.md for templates." >&2
  rc=1
fi
if [ ${#orphan_skills[@]} -gt 0 ]; then
  echo "drift: installed hydra-* skills with no playbook in docs/operator-playbooks/:" >&2
  for s in "${orphan_skills[@]}"; do
    echo "  - $s (orphaned: ~/.claude/skills/$s/SKILL.md has no source-of-truth playbook)" >&2
  done
  echo "" >&2
  echo "Fix: create docs/operator-playbooks/<name>.md or remove the installed skill. Hand-editing SKILL.md is not durable — sync-skills.sh regenerates from the playbook." >&2
  rc=1
fi

if [ "$rc" -eq 0 ]; then
  count=$(find "$PLAYBOOKS" -maxdepth 1 -name 'hydra-*.md' | wc -l)
  echo "check-skill-playbook-drift: ok — $count hydra-* playbooks, ${#ALLOWED_EXCEPTIONS[@]} known exception(s)"
fi
exit "$rc"
