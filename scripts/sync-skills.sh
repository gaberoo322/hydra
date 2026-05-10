#!/usr/bin/env bash
# sync-skills.sh — regenerate ~/.claude/skills/ and ~/.codex/skills/ from
# docs/operator-playbooks/<name>.md.
#
# - Single source of truth: docs/operator-playbooks/*.md
# - Generated files have a "DO NOT EDIT" banner.
# - Existing skills outside the managed set are left alone.
# - Skills matching `claude_only: true` are NOT generated for Codex.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAYBOOKS="$REPO_ROOT/docs/operator-playbooks"
CLAUDE_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "sync-skills: unknown arg $1" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || { echo "sync-skills: python3 required" >&2; exit 127; }

mkdir -p "$CLAUDE_DIR" "$CODEX_DIR"

shopt -s nullglob
PLAYBOOK_FILES=("$PLAYBOOKS"/*.md)
shopt -u nullglob

# Skip the README and any file that doesn't have frontmatter.
generated_count=0
codex_count=0
claude_only_count=0
errors=0

for pb in "${PLAYBOOK_FILES[@]}"; do
  base=$(basename "$pb" .md)
  [ "$base" = "README" ] && continue

  # Parse frontmatter + body via Python; emit JSON.
  parsed=$(python3 - "$pb" <<'PY' || true
import sys, json, re
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    text = f.read()
m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
if not m:
    print(json.dumps({"error": "no frontmatter"}))
    sys.exit(0)
fm_raw, body = m.group(1), m.group(2)
fm = {}
for line in fm_raw.splitlines():
    line = line.rstrip()
    if not line or line.startswith("#"):
        continue
    if ":" not in line:
        continue
    k, _, v = line.partition(":")
    k = k.strip()
    v = v.strip()
    if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
        v = v[1:-1]
    if v.startswith("[") and v.endswith("]"):
        # naive list parse
        inner = v[1:-1].strip()
        v = [x.strip().strip('"').strip("'") for x in inner.split(",") if x.strip()]
    elif v.lower() in ("true","false"):
        v = (v.lower() == "true")
    fm[k] = v
print(json.dumps({"fm": fm, "body": body}))
PY
)

  if echo "$parsed" | grep -q '"error"'; then
    echo "skip $base — no valid frontmatter" >&2
    errors=$((errors+1))
    continue
  fi

  name=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["fm"].get("name",""))')
  desc=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["fm"].get("description",""))')
  when=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["fm"].get("when_to_use",""))')
  allowed_claude=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["fm"].get("allowed_tools_claude","Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)"))')
  args_yaml=$(echo "$parsed" | python3 -c '
import sys,json
d=json.load(sys.stdin)
a=d["fm"].get("arguments")
if isinstance(a,list): print("[" + ", ".join(a) + "]")
elif a: print(a)
else: print("")')
  claude_only=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("1" if d["fm"].get("claude_only") else "0")')
  codex_delegation=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["fm"].get("codex_delegation","none"))')
  body=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["body"])')

  if [ -z "$name" ] || [ -z "$desc" ]; then
    echo "skip $base — missing name or description" >&2
    errors=$((errors+1))
    continue
  fi

  banner_claude="<!-- DO NOT EDIT. Generated from docs/operator-playbooks/${name}.md. Run scripts/sync-skills.sh after editing the playbook. -->"
  banner_codex="<!-- DO NOT EDIT. Generated from docs/operator-playbooks/${name}.md. Run scripts/sync-skills.sh after editing the playbook. -->"

  # ---- Claude SKILL.md ----
  claude_target="$CLAUDE_DIR/$name/SKILL.md"
  {
    echo "---"
    echo "name: $name"
    echo "description: $desc"
    [ -n "$when" ] && echo "when_to_use: \"$when\""
    echo "allowed-tools: $allowed_claude"
    [ -n "$args_yaml" ] && echo "arguments: $args_yaml"
    echo "---"
    echo
    echo "$banner_claude"
    echo
    echo "$body"
  } > /tmp/sync-skills.claude.$$ || true

  if [ "$DRY_RUN" = 1 ]; then
    echo "would write $claude_target"
  else
    mkdir -p "$(dirname "$claude_target")"
    mv /tmp/sync-skills.claude.$$ "$claude_target"
    generated_count=$((generated_count+1))
  fi

  # ---- Codex SKILL.md ----
  if [ "$claude_only" = "1" ]; then
    claude_only_count=$((claude_only_count+1))
    # Remove existing Codex skill if it was previously generated for this name.
    codex_existing="$CODEX_DIR/$name/SKILL.md"
    if [ -f "$codex_existing" ] && grep -q "Generated from docs/operator-playbooks" "$codex_existing"; then
      [ "$DRY_RUN" = 1 ] && echo "would remove $codex_existing (now claude_only)" || rm -f "$codex_existing"
    fi
    continue
  fi

  codex_target="$CODEX_DIR/$name/SKILL.md"
  codex_body="$body"
  if [ "$codex_delegation" = "codex_exec" ]; then
    codex_body="$body

---

## Codex delegation note

This playbook was authored for Claude Code's \`Task\` subagent tool. When run from
Codex, replace any \`Task(...)\` step with a \`codex exec --skill <child-skill>\`
subprocess invocation, e.g.:

\`\`\`bash
codex exec --skill hydra-target-build --json <<EOF
{ \"anchor\": \"...\" }
EOF
\`\`\`

Codex does not have in-process subagent isolation — each delegated step runs in
its own short-lived process. Plan accordingly: keep parent context lean, and do
not assume child output is parseable beyond what the child explicitly emits.
"
  fi

  {
    echo "---"
    echo "name: $name"
    echo "description: $desc"
    echo "---"
    echo
    echo "$banner_codex"
    echo
    echo "$codex_body"
  } > /tmp/sync-skills.codex.$$ || true

  if [ "$DRY_RUN" = 1 ]; then
    echo "would write $codex_target"
  else
    mkdir -p "$(dirname "$codex_target")"
    mv /tmp/sync-skills.codex.$$ "$codex_target"
    codex_count=$((codex_count+1))
  fi
done

echo
echo "sync-skills summary:"
echo "  playbooks read: ${#PLAYBOOK_FILES[@]} (minus README)"
echo "  claude skills written: $generated_count"
echo "  codex skills written: $codex_count"
echo "  claude_only skills (no codex output): $claude_only_count"
echo "  errors: $errors"
[ "$DRY_RUN" = 1 ] && echo "  (dry-run; no files modified)"
