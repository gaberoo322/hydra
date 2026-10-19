#!/usr/bin/env bash
# sync-skills.sh — regenerate ~/.claude/skills/ from
# docs/operator-playbooks/<name>.md.
#
# - Single source of truth: docs/operator-playbooks/*.md
# - Generated files have a "DO NOT EDIT" banner.
# - Existing skills outside the managed set are left alone.
# - Codex output is retired (ADR-0041 Decision 4): nothing is written under any
#   Codex dir. A one-time, banner-guarded sweep removes the stale generated ones.
# - Rendering is done by the pure TypeScript core (src/skills/, ADR-0041): this
#   script calls `src/skills/cli.ts` once, then applies the whole-corpus write
#   plan (tmp-file + mv). Any grammar error aborts BEFORE any write (issue #4720).
#
# compose_base composition (issue #3420, ADR-0030 Decision 4 / Option C):
#   A playbook may declare `compose_base: _vendor/<name>.md`. When it does, the
#   generated Claude SKILL.md body becomes [vendored upstream Pocock base body]
#   + [this playbook's body as a thin Hydra AFK overlay], and the composed
#   frontmatter STRIPS `disable-model-invocation` unconditionally (the vendored
#   upstream base ships it; it hard-errors under Skill-tool dispatch). Vendored
#   bases live under docs/operator-playbooks/_vendor/ — git-tracked, gate-
#   eligible, never emitted standalone (the non-recursive *.md glob skips the
#   subdirectory, exactly like _fragments/). A missing base FAILS LOUD.
#
# disable-model-invocation forwarding (issue #2945):
#   The optional `disable-model-invocation: true` playbook-frontmatter key is
#   forwarded verbatim (kebab-case, same spelling) into the generated Claude
#   SKILL.md frontmatter, and omitted entirely when absent.
#   FAIL-SAFE FLAG RULE — a playbook may carry disable-model-invocation ONLY when
#   EVERY live invocation path is an explicit slash launch (`claude -p "/name"`
#   or an operator `/name`). Any skill named in scripts/autopilot/classes.json's
#   dispatched-skill column, or invoked from another skill's session, is reached
#   through the Skill tool (model invocation) and the harness HARD-ERRORS on a
#   flagged skill even when the prompt names it by /slug — flagging it would halt
#   every such dispatch. hydra-autopilot qualifies (launched solely by pace-
#   gate's `claude -p "/hydra-autopilot"` and by the operator); so do thermo-
#   nuclear-code-quality-review and zoom-out (operator-invoked only, in no
#   dispatched-skill column). test/sync-skills.test.mts (issue #4606) enforces
#   the rule on the GENERATED output: no scripts/autopilot/classes.json skill's
#   Claude SKILL.md may carry the flag, while the three exempt skills above must
#   keep it.
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAYBOOKS="$REPO_ROOT/docs/operator-playbooks"
CLAUDE_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DRY_RUN=0
FORCE=0
[ "${HYDRA_SYNC_SKILLS_FORCE:-0}" = "1" ] && FORCE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "sync-skills: unknown arg $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "sync-skills: node required" >&2; exit 127; }
command -v jq >/dev/null || { echo "sync-skills: jq required" >&2; exit 127; }

# ---- Default-mirror content guard (issue #3828) ----------------------------
# $HOME/.claude/skills (the UNOVERRIDDEN default) is
# the LIVE, host-shared mirror every subsequent agent dispatch loads its
# skill prompts from. A worktree-scoped agent that edits a playbook and runs
# this script against the default path (the documented-but-unsafe pattern
# that produced the 2026-07-31 incident on PR #3827/#3789) makes its own
# unmerged, unreviewed change live for every other dispatch on the host
# *before* PR review, before CI, before merge -- a gate bypass on the
# highest-leverage surface in the system. This guard closes that hole:
#
#   - Active ONLY when writing to the DEFAULT path (CLAUDE_SKILLS_DIR is not
#     overridden; no Codex env var is read at all). An explicit override is always a
#     scratch/isolated destination -- test/sync-skills.test.mts, the
#     hydra-skill-prune.md regenerate-to-verify step, and the manual pattern
#     in docs/skill-quality-measurement.md all already use overrides and stay
#     completely unaffected by this guard.
#   - Compares docs/operator-playbooks/ (the ONLY tree this script reads) at
#     $REPO_ROOT against the LOCAL origin/master ref: any tracked diff, or any
#     untracked new file under that path, refuses the default-path write.
#     This is a content check, not a SHA/ancestry check (deliberately -- see
#     the design-concept's rejectedAlternatives for issue-3828): it tolerates
#     the ordinary origin/master-advanced-since-my-pull race and an operator's
#     own merge commit, while still catching the actual hazard (unmerged
#     playbook content reaching the live mirror).
#   - Fails CLOSED: an unresolvable origin/master ref, or $REPO_ROOT not being
#     a git repo at all, refuses the write rather than silently allowing it.
#   - Escape hatch for the rare, EXPLICIT operator override: --force /
#     HYDRA_SYNC_SKILLS_FORCE=1. Never the default; never used by an autopilot
#     dispatch (the worktree-isolated dev/QA/skill-prune flows all either stay
#     on the override-dir path or must not carry this flag).
#
# scripts/deploy.sh needs no change to satisfy this guard: by the time it
# calls sync-skills.sh it has already run `git checkout master && git pull
# --ff-only origin master`, so docs/operator-playbooks/ is guaranteed
# identical to origin/master's -- the guard is a no-op on that path.
GUARD_DEFAULT_PATH=1
[ -n "${CLAUDE_SKILLS_DIR:-}" ] && GUARD_DEFAULT_PATH=0

if [ "$GUARD_DEFAULT_PATH" = 1 ] && [ "$FORCE" != 1 ]; then
  if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "sync-skills: REPO_ROOT ($REPO_ROOT) is not a git repo -- refusing the default-path write (guard fails closed; issue #3828). Pass --force / HYDRA_SYNC_SKILLS_FORCE=1 to override, or point CLAUDE_SKILLS_DIR at a scratch dir." >&2
    exit 4
  fi
  if ! git -C "$REPO_ROOT" rev-parse --verify -q origin/master >/dev/null 2>&1; then
    echo "sync-skills: origin/master could not be resolved locally -- refusing the default-path write (guard fails closed; issue #3828). Pass --force / HYDRA_SYNC_SKILLS_FORCE=1 to override, or point CLAUDE_SKILLS_DIR at a scratch dir." >&2
    exit 4
  fi
  GUARD_DIRTY=0
  git -C "$REPO_ROOT" diff --quiet origin/master -- docs/operator-playbooks || GUARD_DIRTY=1
  if [ "$GUARD_DIRTY" = 0 ] && [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all -- docs/operator-playbooks)" ]; then
    GUARD_DIRTY=1
  fi
  if [ "$GUARD_DIRTY" = 1 ]; then
    echo "sync-skills: docs/operator-playbooks/ differs from origin/master (unmerged commits, uncommitted edits, or untracked files) -- refusing the default-path write. This is the exact hazard issue #3828 exists to close: the live ~/.claude/skills mirror every agent dispatch loads from must never carry unmerged playbook content. Regenerate from a throwaway origin/master worktree instead, or point CLAUDE_SKILLS_DIR at a scratch dir for local verification, or pass --force / HYDRA_SYNC_SKILLS_FORCE=1 for a deliberate, explicit operator override (never from an autopilot dispatch)." >&2
    exit 4
  fi
fi

# ---- Core plan (ADR-0041 Decisions 2 and 3, issue #4720) -------------------
# Parsing, @include/compose resolution, frontmatter projection and reference
# files all live in the pure TypeScript core (src/skills/plan.ts). The CLI
# prints the WHOLE-corpus write plan as one JSON document `{writes, skips}`
# and performs no writes; bash only applies it. A fail-loud grammar error in
# ANY playbook exits non-zero here, BEFORE anything below touches the
# filesystem -- PLANNING is all-or-nothing (no half-regenerated skill set from
# a grammar error). The apply loop below is per-file tmp+mv and counts records.
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/sync-skills-plan.XXXXXX")"
trap 'rm -f "$PLAN_FILE"' EXIT

if ! node --experimental-strip-types "$REPO_ROOT/src/skills/cli.ts" --playbooks-dir "$PLAYBOOKS" > "$PLAN_FILE"; then
  echo "sync-skills: core plan failed — no skills written" >&2
  exit 1
fi

# Strict shape check: typed fields, and every write path is relative with no
# `..` segment (a malformed plan must never escape $CLAUDE_DIR). A U+0000 in a
# path or content is rejected too: the apply stream below is NUL-delimited, so
# an embedded NUL would split one record into two and truncate the file.
if ! jq -e '
  (.writes|type=="array") and (.skips|type=="array")
  and all(.writes[]; (.path|type=="string") and (.content|type=="string")
    and (.path|length>0) and (.path|startswith("/")|not)
    and ((.path|split("/")|index(".."))==null)
    and (any(.path|explode[]; .==0)|not)
    and (any(.content|explode[]; .==0)|not))
  and all(.skips[]; (.playbook|type=="string") and (.reason|type=="string"))
' "$PLAN_FILE" >/dev/null; then
  echo "sync-skills: core plan has an unexpected shape — no skills written" >&2
  exit 1
fi

shopt -s nullglob
PLAYBOOK_FILES=("$PLAYBOOKS"/*.md)
shopt -u nullglob

generated_count=0
errors=0

# Materialise the jq streams to files first so a jq failure is visible to
# `set -e` (a process substitution's exit status is never observed).
SKIPS_FILE="$PLAN_FILE.skips"
WRITES_FILE="$PLAN_FILE.writes"
trap 'rm -f "$PLAN_FILE" "$SKIPS_FILE" "$WRITES_FILE"' EXIT
if ! jq -r '.skips[] | [.playbook, .reason] | @tsv' "$PLAN_FILE" > "$SKIPS_FILE"; then
  echo "sync-skills: could not decode skips from the plan — no skills written" >&2
  exit 1
fi
if ! jq -j '.writes[] | .path, "\u0000", .content, "\u0000"' "$PLAN_FILE" > "$WRITES_FILE"; then
  echo "sync-skills: could not decode writes from the plan — no skills written" >&2
  exit 1
fi
expected_writes="$(jq '.writes|length' "$PLAN_FILE")"
applied_writes=0

# A playbook whose frontmatter fails to parse is SKIPPED, not fatal (issue
# #433 deploy contract): one `skip ...` line, `errors` incremented, exit 0.
while IFS=$'\t' read -r skip_playbook skip_reason; do
  case "$skip_reason" in
    no-frontmatter) echo "skip $skip_playbook — no valid frontmatter" >&2 ;;
    missing-name-or-description) echo "skip $skip_playbook — missing name or description" >&2 ;;
    *) echo "skip $skip_playbook — $skip_reason" >&2 ;;
  esac
  errors=$((errors+1))
done < "$SKIPS_FILE"

if [ "$DRY_RUN" != 1 ]; then
  mkdir -p "$CLAUDE_DIR"
fi

# Apply every write: NUL-delimited path/content records, one jq pass, read in
# the CURRENT shell (process substitution, not a pipe) so counters survive.
# Each file lands via tmp-file in its own directory + mv.
while IFS= read -r -d '' plan_path && IFS= read -r -d '' plan_content; do
  target="$CLAUDE_DIR/$plan_path"
  applied_writes=$((applied_writes+1))
  if [ "$DRY_RUN" = 1 ]; then
    echo "would write $target"
  else
    mkdir -p "$(dirname "$target")"
    printf '%s' "$plan_content" > "$target.tmp.$$"
    mv "$target.tmp.$$" "$target"
    case "$plan_path" in
      */SKILL.md) generated_count=$((generated_count+1)) ;;
    esac
  fi
done < "$WRITES_FILE"
if [ "$applied_writes" != "$expected_writes" ]; then
  echo "sync-skills: applied $applied_writes of $expected_writes planned writes — truncated plan stream" >&2
  exit 1
fi

# ---- Banner-guarded orphan prune (issue #3693) ----
# sync-skills.sh only ever WROTE generated skills; a playbook deleted from
# docs/operator-playbooks/ left its already-synced skill dirs lingering on every
# host until someone manually rm -rf'd them (bit the /hydra-target-review
# retirement, PR #3692). This pass removes those orphans — but ONLY dirs we own.
#
# Ownership signal: a generated SKILL.md carries the exact banner
#   <!-- DO NOT EDIT. Generated from docs/operator-playbooks/<X>.md. ... -->
# (emitted by the banner constant in src/skills/playbook.ts). We extract <X> from
# that line and prune the dir iff docs/operator-playbooks/<X>.md no longer
# exists. A dir whose SKILL.md LACKS that banner is a third-party / upstream
# skill (code-review, grilling, prototype, deep-research, …) and is NEVER
# touched — the banner match is the whole safety guard. Honors $DRY_RUN and the
# CLAUDE_SKILLS_DIR override (via $CLAUDE_DIR).
# The anchored ownership-banner regex (BRE; group 1 = <X>), shared by
# prune_orphans and the Codex sweep below so a banner change is made once.
GENERATED_BANNER_RE='^<!-- DO NOT EDIT\. Generated from docs/operator-playbooks/\(.*\)\.md\. Run scripts/sync-skills\.sh after editing the playbook\. -->$'
pruned_count=0
prune_orphans() {
  local skills_dir="$1"
  [ -d "$skills_dir" ] || return 0
  local d skill_md src_name
  for d in "$skills_dir"/*/; do
    [ -d "$d" ] || continue
    d="${d%/}"
    skill_md="$d/SKILL.md"
    [ -f "$skill_md" ] || continue
    # Extract the source playbook name from the generation banner, if present.
    # Anchored to the exact banner shape so an incidental mention of the phrase
    # elsewhere in a hand-authored SKILL.md can never match.
    src_name=$(sed -n \
      "s|${GENERATED_BANNER_RE}|\1|p" \
      "$skill_md" | head -n1)
    # No banner → not ours; leave it untouched (the safety guard).
    [ -n "$src_name" ] || continue
    # Banner present but the named source playbook still exists → keep.
    [ -f "$PLAYBOOKS/$src_name.md" ] && continue
    # Banner-owned dir whose source playbook is gone → orphan; prune it.
    if [ "$DRY_RUN" = 1 ]; then
      echo "would prune orphaned skill: $(basename "$d") ($d)"
    else
      rm -rf "$d"
      echo "pruned orphaned skill: $(basename "$d")"
    fi
    pruned_count=$((pruned_count+1))
  done
}
prune_orphans "$CLAUDE_DIR"

# ---- One-time Codex sweep (ADR-0041 Decision 4) ----
# Codex skill output is retired; earlier runs left generated dirs under
# $HOME/.codex/skills. This pass removes ONLY dirs whose SKILL.md carries the
# exact generated banner ($GENERATED_BANNER_RE, shared with prune_orphans) --
# hand-authored / third-party dirs are never touched, symlinks are skipped and
# the root itself stays. A matching dir is removed WHOLE (rm -rf): anything
# hand-added beside its generated SKILL.md goes too -- the banner marks the dir
# as generated.
#
# The root is the literal $HOME/.codex/skills (there is no env override), and
# the sweep runs ONLY on a default-path run (CLAUDE_SKILLS_DIR unset), after the
# #3828 guard has passed, so scratch regenerations and tests never touch the
# real $HOME. Idempotent. Temporary (ADR-0041 skills-epic #4716, slice #4717):
# remove this block in the epic's cutover slice once every host has been swept.
swept_count=0
if [ "$GUARD_DEFAULT_PATH" = 1 ] && [ -d "$HOME/.codex/skills" ]; then
  for d in "$HOME/.codex/skills"/*/; do
    d="${d%/}"
    [ -L "$d" ] && continue
    [ -d "$d" ] || continue
    [ -f "$d/SKILL.md" ] || continue
    if grep -q "$GENERATED_BANNER_RE" "$d/SKILL.md"; then
      if [ "$DRY_RUN" = 1 ]; then
        echo "would sweep codex skill: $(basename "$d") ($d)"
      else
        rm -rf "$d"
        echo "swept codex skill: $(basename "$d")"
      fi
      swept_count=$((swept_count+1))
    fi
  done
fi

echo
echo "sync-skills summary:"
echo "  playbooks read: ${#PLAYBOOK_FILES[@]} (minus README)"
echo "  claude skills written: $generated_count"
echo "  orphaned skills pruned: $pruned_count"
if [ "$DRY_RUN" = 1 ]; then
  echo "  would sweep codex skills: $swept_count"
else
  echo "  swept codex skills: $swept_count"
fi
echo "  errors: $errors"
if [ "$DRY_RUN" = 1 ]; then
  echo "  (dry-run; no files modified)"
fi

# A playbook whose frontmatter fails to parse is SKIPPED, not fatal: it emits a
# "skip ... " line, increments `errors`, and the run continues to this `exit 0`.
# The skip tolerates an in-progress draft playbook that has not yet gained
# frontmatter, so staging one does not wedge the deploy; the `errors` count
# surfaces in the summary above for an operator to notice. The original
# errors-driven trailing `[ -- ] && ...` test under `set -e` made every deploy
# fail once deploy.sh started invoking sync-skills.sh (issue #433); this
# normalized `exit 0` is the explicit success path. (Promoting a malformed
# playbook to a hard abort is a deliberate behaviour change, NOT part of this
# PR's reconciled design-concept — which preserves fail-soft — and is left as a
# separate, independently-grilled change.)
exit 0
