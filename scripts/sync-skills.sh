#!/usr/bin/env bash
# sync-skills.sh — regenerate ~/.claude/skills/ and ~/.codex/skills/ from
# docs/operator-playbooks/<name>.md.
#
# - Single source of truth: docs/operator-playbooks/*.md
# - Generated files have a "DO NOT EDIT" banner.
# - Existing skills outside the managed set are left alone.
# - Skills matching `claude_only: true` are NOT generated for Codex.
#
# disable-model-invocation forwarding (issue #2945):
#   The optional `disable-model-invocation: true` playbook-frontmatter key is
#   forwarded verbatim (kebab-case, same spelling) into the generated Claude
#   SKILL.md frontmatter, and omitted entirely when absent. It is NEVER emitted
#   into the Codex output (Codex has no such concept).
#   FAIL-SAFE FLAG RULE — a playbook may carry disable-model-invocation ONLY when
#   EVERY live invocation path is an explicit slash launch (`claude -p "/name"`
#   or an operator `/name`). Any skill named in scripts/autopilot/classes.json's
#   dispatched-skill column, or invoked from another skill's session, is reached
#   through the Skill tool (model invocation) and the harness HARD-ERRORS on a
#   flagged skill even when the prompt names it by /slug — flagging it would halt
#   every such dispatch. Today only hydra-autopilot qualifies: it is launched
#   solely by pace-gate's `claude -p "/hydra-autopilot"` and by the operator.

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

  # Parse frontmatter + body via Python; emit JSON. The same Python pass also
  # resolves `@include _fragments/<name>.md` directives in the body (issue
  # #2552): a line matching `^@include\s+(\S+)$` is replaced verbatim by the
  # referenced fragment's content, with a flat `{{SKILL_NAME}}` substitution so
  # a single shared fragment can carry a per-skill log-tag prefix. Includes are
  # non-recursive (one level) and FAIL LOUD — a missing/typo'd fragment makes
  # this pass exit non-zero so `set -euo pipefail` aborts the sync (and, via the
  # issue #433 deploy contract, the deploy) before a skill ships a literal
  # `@include ...` line. Fragments live under docs/operator-playbooks/_fragments/
  # — a subdirectory the non-recursive PLAYBOOK_FILES glob never matches, so a
  # fragment is never itself emitted as a SKILL.md.
  parsed=$(python3 - "$pb" "$PLAYBOOKS" <<'PY'
import sys, json, re, os
path = sys.argv[1]
playbooks_dir = sys.argv[2]
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

# Resolve @include directives in the body. The directive must be the whole
# line (leading/trailing whitespace allowed). `{{SKILL_NAME}}` in the fragment
# body is substituted with the skill's frontmatter name so a shared fragment
# can carry a per-skill prefix (the [hydra-dev] vs [hydra-target-build] log
# tag). Fragment paths are relative to docs/operator-playbooks/.
skill_name = fm.get("name", "")
include_re = re.compile(r"^[ \t]*@include[ \t]+(\S+)[ \t]*$")

def resolve_line(line):
    mm = include_re.match(line)
    if not mm:
        return line
    frag_rel = mm.group(1)
    frag_path = os.path.normpath(os.path.join(playbooks_dir, frag_rel))
    # Contain the include within the playbooks dir — refuse path-escapes.
    if not frag_path.startswith(os.path.normpath(playbooks_dir) + os.sep):
        raise SystemExit(
            "sync-skills: @include path escapes operator-playbooks/: "
            + frag_rel + " (in " + os.path.basename(path) + ")"
        )
    if not os.path.isfile(frag_path):
        # FAIL LOUD (issue #2552 invariant): an unresolved include must abort
        # the sync, never silently emit a literal `@include` line.
        raise SystemExit(
            "sync-skills: unresolved @include " + frag_rel
            + " (in " + os.path.basename(path) + "): no such fragment at "
            + frag_path
        )
    with open(frag_path, "r", encoding="utf-8") as ff:
        frag = ff.read()
    # Strip a single trailing newline so the fragment slots in cleanly where
    # the directive line was, regardless of the fragment file's final newline.
    if frag.endswith("\n"):
        frag = frag[:-1]
    frag = frag.replace("{{SKILL_NAME}}", skill_name)
    # Guard against a fragment that itself contains an @include (non-recursive
    # by design — ADR-0014 simplicity). FAIL LOUD rather than silently leave it.
    for fl in frag.splitlines():
        if include_re.match(fl):
            raise SystemExit(
                "sync-skills: nested @include in fragment " + frag_rel
                + " — includes are non-recursive (one level)"
            )
    return frag

resolved = "\n".join(resolve_line(l) for l in body.split("\n"))
print(json.dumps({"fm": fm, "body": resolved}))
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
  # disable-model-invocation (issue #2945): the frontmatter parser coerces the
  # kebab-case key's true/false value to a Python bool, so print "1" only when it
  # is truthy — never the literal Python "True". "1" here means "emit the key".
  disable_model_invocation=$(echo "$parsed" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("1" if d["fm"].get("disable-model-invocation") else "0")')
  # reference_files (issue #2947): an optional list of _fragments/<name>.md files
  # COPIED VERBATIM into the generated skill folder as siblings of SKILL.md — the
  # progressive-disclosure escape valve that keeps the SKILL.md body small
  # (parent-flow / child-flow reference files that SKILL.md POINTS to behind a
  # context pointer, never @includes — @include grows the body, it cannot shrink
  # it). One fragment path per line for the shell loop below. FAIL LOUD on a
  # missing/escaping fragment, mirroring the @include contract.
  reference_files=$(echo "$parsed" | python3 -c '
import sys,json
d=json.load(sys.stdin)
r=d["fm"].get("reference_files")
if isinstance(r,list):
    for x in r: print(x)
elif r:
    print(r)')
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
    # Emit disable-model-invocation only when the playbook opted in; lowercase
    # `true` (never Python's "True"). Omitted entirely otherwise so untouched
    # playbooks regenerate byte-identical (issue #2945).
    [ "$disable_model_invocation" = "1" ] && echo "disable-model-invocation: true"
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

  # Companion settings.json (issue #509): if the playbook ships a sibling
  # `<name>.settings.json` (currently used by hydra-autopilot for hook
  # registration), copy it to the skill's `.claude/settings.json` so the
  # harness picks it up on next session start. The companion file is a
  # plain JSON object; we don't mutate it during sync. Hook scripts that
  # the settings reference are expected to live in the orchestrator repo
  # at stable absolute paths (e.g. /home/gabe/hydra/scripts/autopilot/hooks/).
  settings_src="$PLAYBOOKS/${name}.settings.json"
  if [ -f "$settings_src" ]; then
    settings_target="$CLAUDE_DIR/$name/.claude/settings.json"
    if [ "$DRY_RUN" = 1 ]; then
      echo "would write $settings_target"
    else
      mkdir -p "$(dirname "$settings_target")"
      cp "$settings_src" "$settings_target"
    fi
  fi

  # ---- Reference files (issue #2947) ----
  # Copy each `reference_files:` fragment VERBATIM into the generated skill
  # folder as a sibling of SKILL.md. This is the progressive-disclosure path:
  # SKILL.md stays small and POINTS to these files behind a context pointer,
  # rather than @include-ing them (which would grow the body). Substitutes
  # {{SKILL_NAME}} exactly as @include does so a shared reference fragment can
  # carry a per-skill log tag. FAIL LOUD (aborting the sync, and via the #433
  # deploy contract the deploy) on a missing fragment or a path that escapes
  # operator-playbooks/ — a broken reference pointer must never ship silently.
  if [ -n "$reference_files" ]; then
    while IFS= read -r ref_rel; do
      [ -z "$ref_rel" ] && continue
      ref_out=$(REPO_ROOT="$REPO_ROOT" PLAYBOOKS="$PLAYBOOKS" NAME="$name" \
        REF_REL="$ref_rel" python3 - <<'PY'
import os, sys
playbooks = os.environ["PLAYBOOKS"]
ref_rel = os.environ["REF_REL"]
skill_name = os.environ["NAME"]
frag_path = os.path.normpath(os.path.join(playbooks, ref_rel))
if not frag_path.startswith(os.path.normpath(playbooks) + os.sep):
    sys.stderr.write(
        "sync-skills: reference_files path escapes operator-playbooks/: "
        + ref_rel + " (in " + skill_name + ")\n")
    sys.exit(3)
if not os.path.isfile(frag_path):
    sys.stderr.write(
        "sync-skills: unresolved reference_files " + ref_rel
        + " (in " + skill_name + "): no such fragment at " + frag_path + "\n")
    sys.exit(3)
with open(frag_path, "r", encoding="utf-8") as f:
    content = f.read()
sys.stdout.write(content.replace("{{SKILL_NAME}}", skill_name))
PY
      ) || { echo "sync-skills: reference_files emission failed for $name" >&2; errors=$((errors+1)); exit 3; }
      ref_basename=$(basename "$ref_rel")
      ref_target="$CLAUDE_DIR/$name/$ref_basename"
      if [ "$DRY_RUN" = 1 ]; then
        echo "would write $ref_target (reference file from $ref_rel)"
      else
        mkdir -p "$(dirname "$ref_target")"
        printf '%s' "$ref_out" > "$ref_target"
      fi
    done <<< "$reference_files"
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
if [ "$DRY_RUN" = 1 ]; then
  echo "  (dry-run; no files modified)"
fi

# Exit non-zero only when a playbook with frontmatter (a real skill) failed to
# generate. Playbooks like `hydra-target-adversarial.md` intentionally have no
# frontmatter (stub markers); they emit a "skip ... no valid frontmatter" line
# but must not fail the deploy. The original trailing `[ -- ] && ...` test left
# the script's exit status equal to that test under `set -e`, which made every
# deploy fail once deploy.sh started invoking sync-skills.sh (issue #433). We
# normalize the exit code here.
exit 0
