#!/usr/bin/env bash
# sync-target-gate.sh — mirror the Target (hydra-betting) SDLC gate scripts and
# their orchestrator src-dependency closure into a betting worktree so the
# money-critical mutation gate, design-concept artifact, and post-merge-health
# checks actually run from the worktree where a Target build happens
# (issue #1451).
#
# THE PROBLEM (issue #1451):
#   scripts/target/{mutation-check,target-design-concept,post-merge-health}.ts
#   are authored in THIS repo (~/hydra, the orchestrator) and import from
#   ../../src/ (mutation.ts, exec-with-timeout.ts, target/risk-critical.ts).
#   A hydra-target-build runs in a hydra-betting worktree where neither the
#   scripts nor src/ exist, so:
#     - running the gate from the worktree → ERR_MODULE_NOT_FOUND,
#     - running it from ~/hydra (orchestrator main tree) is path-fragile and was
#       the recurring friction the agents worked around by hand-rolling the
#       risk-critical classification (re-introducing the web/-prefix bug that
#       classifyRisk()'s appSubdir strip already handles, #1235).
#   The fix is purely deployment/mirroring: make the scripts + their small,
#   self-contained src closure present INSIDE the betting worktree so the gate
#   runs locally with classifyTargetRisk() doing the web/ normalization.
#
# THE MECHANISM (chosen — sync at worktree-setup time):
#   Copy the gate scripts + src closure into a self-contained gate dir, preserving
#   the `scripts/target/` + `src/` layout so the scripts' `../../src/...` relative
#   imports resolve unchanged. Since issue #4526 the gate dir is a SIBLING of the
#   worktree — `<target-worktree-dir>.hydra-gate` — NOT a child of it: the old
#   in-worktree `<wt>/.hydra-gate/` copy sat inside the cwd of every Target
#   tool, so CSB's `eslint .` descended into the mirrored (orchestrator-authored)
#   sources and failed with 6 `no-explicit-any` errors before any change was
#   made. The sibling location is outside the worktree by construction, so no
#   Target tool run from the worktree (eslint, tsc, vitest, next build, knip)
#   can reach the mirror — invisibility does not depend on any target-side
#   ignore rule (ADR-0013: fix at the seam). The sibling stays NESTED under
#   `$TARGET_APP_DIR/.worktrees/` so the mirror's bare `zod` import still
#   resolves through Node's ancestor node_modules walk with NO symlink (the
#   same mechanism #4177 relies on; a /tmp or $HOME location is forbidden — it
#   would need exactly the #4175-class symlink). Register the `.worktrees/`
#   scratch area in the shared git info/exclude so the mirror never pollutes
#   the Target PR diff or the main checkout's status.
#
#   Why not a vendored copy committed into hydra-betting, or a hydra-betting CI
#   step? Both require editing the SEPARATE hydra-betting repo and create a
#   perpetual drift-sync burden between two repos. Syncing at worktree setup
#   keeps a SINGLE source of truth (this repo's HEAD), is always fresh (copies
#   the current scripts every build), is self-cleaning (Step 8.5 removes the
#   sibling alongside the worktree; branch-prune.sh GCs crashed worktrees), and
#   keeps classifyTargetRisk()'s normalization authoritative.
#
# USAGE:
#   scripts/sync-target-gate.sh <target-worktree-dir>
#
#   Run from the orchestrator repo (~/hydra) — the script resolves its own
#   source files relative to this file's location, so cwd does not matter.
#   <target-worktree-dir> is the hydra-betting worktree created by Step 0.6 of
#   the hydra-target-build playbook (e.g. $TARGET_WT). The mirror lands in the
#   sibling "<target-worktree-dir>.hydra-gate", which the playbook exports as
#   $HYDRA_GATE_DIR.
#
# AFTER SYNC, run the gate from inside the worktree, e.g.:
#   CHANGED_FILES="..." TARGET_PROJECT_DIR="$TARGET_WT/$APP_SUBDIR" \
#     npx tsx "$HYDRA_GATE_DIR/scripts/target/mutation-check.ts"
#   (APP_SUBDIR from the worktree's own .hydra/manifest.json verify.appSubdir —
#   never hardcode a `web/` nesting; a target may declare appSubdir: "".)
#
# The script is idempotent — re-running overwrites the mirror with the current
# source. It fails loud (set -euo pipefail) so a broken mirror aborts the build
# rather than silently skipping the money-critical gate (the #1451 root cause).

set -euo pipefail

# The orchestrator repo root that owns the source-of-truth scripts. Resolved
# from this file's own location so the script works regardless of cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The self-contained mirror dir: a SIBLING of the worktree (issue #4526),
# derived from the single <target-worktree-dir> argument below as
# "<worktree-dir>.hydra-gate". Kept as a dot-name + git-excluded so it never
# shows up in any Target diff; being OUTSIDE the worktree keeps it out of every
# Target tool's reach (the CSB eslint failures this fixes).
GATE_DIR_SUFFIX=".hydra-gate"

# The exact dependency closure (verified for issue #1451; manifest wiring per
# ADR-0026 / epic #3014, issue #3018 — the gate scripts now source the risk
# surface from the worktree's .hydra/manifest.json via loadRiskSurface, so the
# manifest loader + schema + resolver join the closure and the transitional
# betting-risk-surface.ts const is gone; issue #4526 adds the Step-6 install
# decision leaf):
#   scripts/target/mutation-check.ts             → src/mutation-gate-inputs.ts (issue #4346 shared leaf), src/mutation.ts, src/target/risk-critical.ts, scripts/target/target-risk-surface.ts
#   scripts/target/target-design-concept.ts      → src/target/risk-critical.ts, scripts/target/target-risk-surface.ts
#   scripts/target/post-merge-health.ts          → src/target-config.ts, src/cli-args.ts (issue #4565 shared CLI-arg seam)
#   scripts/target/target-risk-surface.ts        → src/target/manifest.ts, src/target/risk-critical.ts (type), src/target-config.ts
#   scripts/target/verify-install-decision.ts    → src/cli-args.ts (issue #4526 — the pure Step-6 install decision + CLI wrapper; issue #4565 shared CLI-arg seam)
#   src/mutation-gate-inputs.ts                  → src/mutation.ts (type-only; issue #4346 — the ONE shared home of the pure input-parse/classify helpers both mutation gates import, so the Orchestrator and Target copies can never drift)
#   src/mutation.ts                              → src/exec-with-timeout.ts
#   src/exec-with-timeout.ts                     → (stdlib only)
#   src/target/risk-critical.ts                  → (no imports)
#   src/target/manifest.ts                       → src/schemas/target-manifest.ts
#   src/schemas/target-manifest.ts               → zod (resolved via the ancestor node_modules walk — see below)
#   src/target-config.ts                         → (node: stdlib only)
#   src/cli-args.ts                              → (node:util only; issue #4565 — MUST stay stdlib-only so this closure does not grow)
# Paths are repo-relative; the layout is preserved inside the gate dir so the
# scripts' `../../src/...` relative imports resolve unchanged.
GATE_FILES=(
  "scripts/target/mutation-check.ts"
  "scripts/target/target-design-concept.ts"
  "scripts/target/post-merge-health.ts"
  "scripts/target/target-risk-surface.ts"
  "scripts/target/verify-install-decision.ts"
  "src/mutation-gate-inputs.ts"
  "src/mutation.ts"
  "src/exec-with-timeout.ts"
  "src/target/risk-critical.ts"
  "src/target/manifest.ts"
  "src/schemas/target-manifest.ts"
  "src/target-config.ts"
  "src/cli-args.ts"
)

usage() {
  sed -n '2,68p' "$0"
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
  "") echo "sync-target-gate: missing <target-worktree-dir> argument" >&2; usage 2 ;;
esac

TARGET_WT="$1"

if [ ! -d "$TARGET_WT" ]; then
  echo "sync-target-gate: target worktree '$TARGET_WT' does not exist" >&2
  exit 2
fi

# The mirror root: the worktree's SIBLING (issue #4526) —
# <worktree-dir>.hydra-gate, i.e. $TARGET_APP_DIR/.worktrees/<name>.hydra-gate.
# Outside the worktree (invisible to every Target tool run from it, INV-1) but
# still under the app dir's .worktrees/ scratch area (so bare `zod` keeps
# resolving through the ancestor walk, INV-2 — a /tmp or $HOME mirror would
# need exactly the #4175-class symlink this layout avoids).
GATE_ROOT="${TARGET_WT}${GATE_DIR_SUFFIX}"

# Verify every source file exists BEFORE we copy anything — a missing source
# file means the closure drifted and the mirror would be incomplete (a silent
# gate no-op is exactly what #1451 is fixing). Fail loud instead.
missing=0
for f in "${GATE_FILES[@]}"; do
  if [ ! -f "$REPO_ROOT/$f" ]; then
    echo "sync-target-gate: source file missing in orchestrator repo: $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "sync-target-gate: aborting — dependency closure incomplete (see above)." >&2
  exit 2
fi

# Fresh mirror each run (idempotent). Remove a stale mirror first so a removed
# source file does not linger in the gate dir.
rm -rf "$GATE_ROOT"

copied=0
for f in "${GATE_FILES[@]}"; do
  dest="$GATE_ROOT/$f"
  mkdir -p "$(dirname "$dest")"
  cp "$REPO_ROOT/$f" "$dest"
  copied=$((copied + 1))
done

# Declare the mirror as an ESM package (issue #1883). The mirrored gate scripts
# and their src closure are authored as ES modules (import/export). Running them
# from a betting worktree leaves node unable to determine the module type of
# these .ts files from a package.json, so every gate invocation prints a
# MODULE_TYPELESS_PACKAGE_JSON warning + "Reparsing" notice on stderr —
# recurring noise that buries the real gate status line (agents grep it out by
# hand, friction cue recurrence 7x). A minimal package.json with "type":"module"
# at the mirror root makes node treat the whole gate-dir tree as ESM,
# silencing the warning. It is git-excluded with the rest of the mirror (the
# .worktrees/ exclude line below covers it), so it never pollutes any
# Target diff.
printf '%s\n' '{ "type": "module" }' > "$GATE_ROOT/package.json"

# Resolve bare npm imports for the mirror (issue #3018, no longer a symlink as
# of #4177; unchanged by the #4526 sibling move). The manifest schema
# (src/schemas/target-manifest.ts, in the closure) imports `zod`. Node resolves
# a bare import by walking UPWARD from the importing file
# (<gate-dir>/src/schemas/target-manifest.ts) through every ancestor's
# node_modules — and since #4177 nests the Target worktree itself under the
# app subdir (e.g. $TARGET_WT = .../web/.worktrees/<name>), that walk reaches
# the REAL app node_modules (e.g. ~/hydra-betting/web/node_modules) a few
# directory levels up with NO symlink needed — Node checks
# $GATE_ROOT/node_modules, then each ancestor in turn, until it finds one; the
# SIBLING gate dir (.../web/.worktrees/<name>.hydra-gate) sits on the SAME
# ancestor path as the worktree itself, so #4526's move out of the worktree
# changes nothing about resolution (INV-2). A missing zod resolution would
# surface as a loud MODULE_NOT_FOUND from the gate script itself rather than a
# silent mirror gap.

# Exclude the .worktrees/ scratch area from the target repo's git so neither
# the mirror NOR the worktree dirs ever pollute a Target diff or status. The
# line lands in the SHARED info/exclude (git-common-dir — local to this clone,
# never committed), so it covers the main checkout's view of the sibling gate
# dir AND every linked worktree's own view. The pattern is deliberately
# UNANCHORED (`.worktrees/`, not `/.worktrees/`): a root-anchored pattern
# misses an appSubdir-nested layout (web/.worktrees/... — the betting shape),
# while the unanchored form matches at any depth and covers both repo-root and
# nested targets. Excludes only affect UNTRACKED files, so a target that ever
# tracks real content under .worktrees/ is unaffected.
GIT_DIR="$(git -C "$TARGET_WT" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_DIR" ]; then
  # rev-parse may return a relative path; anchor it to the worktree.
  case "$GIT_DIR" in
    /*) ;;
    *) GIT_DIR="$TARGET_WT/$GIT_DIR" ;;
  esac
  EXCLUDE_FILE="$GIT_DIR/info/exclude"
  mkdir -p "$(dirname "$EXCLUDE_FILE")"
  EXCLUDE_LINE=".worktrees/"
  if [ ! -f "$EXCLUDE_FILE" ] || ! grep -qxF "$EXCLUDE_LINE" "$EXCLUDE_FILE" 2>/dev/null; then
    printf '%s\n' "$EXCLUDE_LINE" >> "$EXCLUDE_FILE"
  fi
else
  echo "sync-target-gate: WARN — '$TARGET_WT' is not a git worktree; skipping" \
       "git-exclude registration (mirror may show as untracked)." >&2
fi

echo "sync-target-gate: mirrored $copied gate file(s) into $GATE_ROOT"
echo "sync-target-gate: export HYDRA_GATE_DIR=\"$GATE_ROOT\" and run the gate via \$HYDRA_GATE_DIR/scripts/target/<name>.ts"
