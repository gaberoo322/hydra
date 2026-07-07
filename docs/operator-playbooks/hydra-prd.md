---
name: hydra-prd
disable_model_invocation: true
description: Non-interactive producer that converts a structured research finding into one parent epic plus dependency-ordered tracer-bullet child issues on the tracker.
when_to_use: "When the operator (or a future autopilot dispatch) has a multi-issue research finding or discover anchor that needs to become tracked work on `gaberoo322/hydra`. Replaces the role the retired Specs subsystem (#513) used to play. NOT a chat interview — input is structured JSON; the skill emits GitHub issues, no questions asked."
allowed_tools_claude: Read(*) Write(*) Bash(*) Glob(*) Grep(*)
claude_only: true
arguments: [apply, --input]
---

# Hydra PRD

Take a structured `PrdInput` and emit one **parent epic** issue plus **N tracer-bullet child** issues on `gaberoo322/hydra`. Parent + children are linked via:

- Parent body: a `## Sub-issues` markdown checklist (`- [ ] #N`) — the exact format `hydra-epic-close`'s `parseEpicReferences()` parses.
- Each child body: a `## Parent` section pointing back at the parent's real GitHub number.

This skill exists because the **Specs subsystem** (in-process multi-cycle task decomposition under `src/specs.ts`, the `/api/specs` endpoints, and the `spec-starvation` instrumentation) was retired in issue #513 — the in-process control loop that produced and consumed specs was already gone, and the autopilot's child-dispatch model superseded it. After #513, multi-issue research findings had nowhere durable to live. `hydra-prd` is the GitHub-native replacement: each slice becomes a separately mergeable issue that the **Orchestrator**'s autopilot can dispatch through `hydra-dev` / `hydra-target-build` independently, with the parent epic auto-closing once every child closes.

Unlike the generic upstream `/to-prd` skill — which interviews the operator via `AskUserQuestion` — `hydra-prd` is **fully parameterised**: input is structured JSON, output is GitHub issues. There are zero `AskUserQuestion` calls in this playbook; if the input is malformed, the skill stops with a validation report rather than asking for clarification.

The skill is **dry-run by default**. To actually create issues on `gaberoo322/hydra`, pass `--apply` (or `apply=true`). Dry-run prints the rendered parent and child bodies plus the validation report, so the operator can review before committing.

## When NOT to run this

- For a single-issue finding. Use `/triage` or `gh issue create` directly — a one-slice "PRD" is overkill.
- When the finding has fewer than 3 candidate vertical slices. The skill enforces a 3-slice minimum (see `validatePrdInput`); fewer slices means the work is not yet decomposed and should go through `/hydra-issue-research` first.
- When you have not yet picked a **Modification Tier** for the slices. The skill stamps `Expected tier: N` from `GET /api/tier` per slice; that requires concrete `filesInScope` paths, not "TBD".
- Inside a `dev_orch` / `dev_target` subagent. Those work on a single issue and should not produce sibling work — `hydra-prd` belongs to the autopilot parent context or a manual operator invocation.

## Input contract

The skill reads a `PrdInput` JSON object — from a file (`--input=/tmp/prd.json`) or stdin. The schema is defined in `scripts/ci/hydra-prd-render.ts` and unit-tested in `test/hydra-prd-template.test.mts`. Required shape:

```json
{
  "title": "Add foo to the Orchestrator",
  "problem": "Prose using Hydra glossary terms (Orchestrator, Target, Modification Tier, ...). At least one sentence.",
  "rationale": "Why ship this now. Links to Target Outcomes, Outcome Holdback, or Modification Tier where relevant.",
  "expectedGlossaryTerms": ["Orchestrator", "Target", "Modification Tier"],
  "sourceRef": "hydra:reports:research:2026-05-18T00:00:00Z",
  "slices": [
    {
      "title": "alpha — bootstrap the foo skeleton",
      "whatToBuild": "End-to-end tracer bullet: the smallest thing that exercises every layer.",
      "acceptanceCriteria": ["foo endpoint responds 200", "npm test passes"],
      "filesInScope": ["src/foo.ts", "test/foo.test.mts"],
      "filesOutOfScope": ["src/specs.ts"],
      "kind": "enhancement"
    },
    {
      "title": "beta — wire foo into the autopilot dispatch",
      "whatToBuild": "...",
      "acceptanceCriteria": ["..."],
      "filesInScope": ["docs/operator-playbooks/hydra-autopilot.md"],
      "dependsOn": [1]
    },
    {
      "title": "gamma — surface foo in the dashboard",
      "whatToBuild": "...",
      "acceptanceCriteria": ["..."],
      "filesInScope": ["dashboard/src/views/Foo.tsx"],
      "dependsOn": [1, 2]
    }
  ]
}
```

### Hard-required fields

- `title` — single line, parent epic title
- `problem` — non-empty prose
- `rationale` — non-empty prose
- `slices` — array of **≥3** items, each with:
  - `title` — short imperative title (becomes the GitHub issue title)
  - `whatToBuild` — non-empty prose
  - `acceptanceCriteria` — non-empty array of strings
  - `filesInScope` — non-empty array (REQUIRED by the issue-label-validation workflow, #396)

### Recommended fields

- `expectedGlossaryTerms` — list of Hydra terms (`CONTEXT.md`) you expect to see in the parent narrative. Missing terms become a **soft warning** (printed; non-fatal).
- `sourceRef` — pointer to the research finding / Redis key that produced this PRD. Surfaced in the parent footer.
- `slices[].filesOutOfScope` — strongly recommended so the scope-check CI gate has explicit out-of-scope paths to enforce.
- `slices[].dependsOn` — 1-based indices of earlier sibling slices. Slices MUST be listed in dependency order — a slice cannot depend on itself or any later sibling. The validator rejects out-of-order PRDs.
- `slices[].kind` — `enhancement` (default) or `bug`. Drives the child's label.

## Process

### 1. Parse args and load input

```bash
# args is a shell-quoted string passed through Skill `args`.
# Example: --apply --input=/tmp/prd.json
APPLY=0; INPUT_FILE=""
for tok in $SKILL_ARGS; do
  case "$tok" in
    --apply|apply=true|apply=1|apply=yes) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --input=*) INPUT_FILE="${tok#--input=}" ;;
    input=*)   INPUT_FILE="${tok#input=}" ;;
  esac
done

if [ -n "$INPUT_FILE" ]; then
  INPUT_JSON=$(cat "$INPUT_FILE")
else
  INPUT_JSON=$(cat)  # stdin
fi
```

The canonical parser is `parseArgs()` in `scripts/ci/hydra-prd-render.ts` — the shell loop above is a faithful mirror for the Skill harness; the unit tests cover the TS version.

### 2. Validate

Call `validatePrdInput(input)`. On non-empty error list:

```
PrdInput validation failed. The following must be fixed before this PRD can produce issues:

  slices[3].filesInScope — at least one file in scope required (issue-label-validation #396)
  slices[2].dependsOn    — slice 2 depends on later/self slice 3 — slices must be listed in dependency order

(No GitHub issues created.)
```

Then **stop** — non-interactive. The operator (or a future autopilot wiring) fixes the input and re-invokes.

### 3. Vocabulary check (soft)

Call `vocabularyCheck(input.problem + "\n" + input.rationale, input.expectedGlossaryTerms)`. Print missing terms as a **warning** but continue:

```
Vocabulary check: 1 expected glossary term missing from parent narrative
  - Outcome Holdback
(non-fatal; parent will be created with this gap)
```

### 4. Tier each slice

For each slice, hit the live tier classifier:

```bash
FILES=$(printf '%s,' "${slice.filesInScope[@]}" | sed 's/,$//')
TIER_JSON=$(curl -sf --max-time 5 "http://localhost:4000/api/tier?files=$(printf '%s' "$FILES" | jq -sRr @uri)")
EXPECTED_TIER=$(printf '%s' "$TIER_JSON" | jq -r '.tier')
```

If the API is unreachable, fall back to `EXPECTED_TIER=3` (operator-review default — the safest classification) and print a warning. The body line is omitted entirely if no tier is available, per `renderChildBody`.

### 5. Dry-run — render and print

In dry-run mode (the default):

```bash
node -e '
  const fs = require("fs");
  const { renderParentBody, renderChildBody, parentLabels, childLabels } =
    require("./scripts/ci/hydra-prd-render.ts");
  const input = JSON.parse(process.env.INPUT_JSON);
  // Parent rendered with placeholders (no child numbers yet).
  console.log("=== PARENT ===");
  console.log(renderParentBody(input));
  for (let i = 1; i <= input.slices.length; i++) {
    console.log("=== CHILD " + i + " ===");
    console.log(renderChildBody(input, i, /*parent=*/ 0, new Map(), /*tier=*/ 3));
  }
'
```

The harness can use `tsx scripts/ci/hydra-prd-render.ts` via a tiny driver or `node --experimental-strip-types` — the point is that the renderer is pure and side-effect-free. Print the bodies, then exit.

### 6. Apply — create parent, then children in dependency order

In `--apply` mode:

```bash
# 6a. Render parent body with placeholders (we don't have child numbers yet).
PARENT_BODY=$(... renderParentBody(input, []) ...)

# 6b. Create the parent issue.
PARENT_NUM=$(gh issue create \
  --repo gaberoo322/hydra \
  --title "$INPUT_TITLE" \
  --label "enhancement" \
  --body "$PARENT_BODY" | grep -oP '/issues/\K\d+')

# 6c. Create children in dependency order (the input is already sorted; the
#     validator rejected any slice that depends on a later sibling).
declare -A SIBLING_NUMS
for i in 1..N; do
  CHILD_BODY=$(... renderChildBody(input, i, PARENT_NUM, SIBLING_NUMS, EXPECTED_TIER[i]) ...)
  CHILD_TITLE="${slice[i].title}"
  CHILD_LABELS="ready-for-agent,${slice[i].kind:-enhancement}"
  CHILD_NUM=$(gh issue create \
    --repo gaberoo322/hydra \
    --title "$CHILD_TITLE" \
    --label "$CHILD_LABELS" \
    --body "$CHILD_BODY" | grep -oP '/issues/\K\d+')
  SIBLING_NUMS[$i]=$CHILD_NUM
done

# 6d. Re-render the parent body with real child numbers and edit the parent.
PARENT_BODY_FINAL=$(... renderParentBody(input, [SIBLING_NUMS[1], ..., SIBLING_NUMS[N]]) ...)
gh issue edit "$PARENT_NUM" --repo gaberoo322/hydra --body "$PARENT_BODY_FINAL"
```

The two-pass approach (parent with placeholders → children → re-render parent with real numbers) is the same pattern `/to-issues` uses and the only one that keeps issue references resolvable without a back-edit per child.

### 7. Report

Emit a single-pass summary:

```
## Hydra PRD — <date> (apply)

Parent epic: #<PARENT_NUM> — <title>
Children created (in dependency order):
  - #<C1> — alpha — tier 1
  - #<C2> — beta — tier 2 — blocked by #<C1>
  - #<C3> — gamma — tier 3 — blocked by #<C1>, #<C2>

Vocabulary check: <ok|N missing>
hydra-epic-close: parent will auto-close when all 3 children close.
```

In dry-run mode the header reads `(dry-run; no GitHub issues created)` and the children list is rendered without numbers.

## Output contract

| Surface              | Form                                                                |
| -------------------- | ------------------------------------------------------------------- |
| Parent issue body    | `## Problem`, `## Rationale`, `## Sub-issues` (checklist), source footer |
| Parent labels        | `enhancement`                                                       |
| Child issue body     | `## Parent` `#N`, `## What to build`, `## Acceptance criteria`, `## Files in scope`, `## Files out of scope`, `## Blocked by`, `Expected tier: N` |
| Child labels         | `ready-for-agent`, `enhancement` (or `bug`)                         |
| Cross-skill contract | Parent's `## Sub-issues` is parseable by `hydra-epic-close`'s `parseEpicReferences()` — see the cross-test in `test/hydra-prd-template.test.mts` |

## Tier classification — live API

This skill ships entirely as new files under `docs/operator-playbooks/`, `scripts/ci/`, and `test/`. None of those are in the **Untouchable Core**; the live `/api/tier` classifier rates the change as **Tier 3** (`operator-review change`). A future PR that wires `hydra-prd` into the `hydra-research` autopilot path will need its own tier check.

The emitted child issues each carry an `Expected tier: N` line stamped from `/api/tier` against their `filesInScope`. CI's tier-gate runs the same classifier on the PR, so if the slice's actual file changes diverge from the stamped scope, the tier-gate catches it.

## Rules

- **Non-interactive.** Zero `AskUserQuestion` calls. Malformed input → validation report → stop.
- **Dry-run default.** Only `--apply` creates GitHub issues. A dry-run on `gaberoo322/hydra` is always safe.
- **3-slice minimum.** Fewer slices mean the work hasn't been decomposed. Send it back through research instead.
- **Dependency order.** Slices must be listed earliest-first. The validator rejects any slice with a `dependsOn` that points at a later or self index.
- **Hydra glossary.** The parent narrative uses **Orchestrator**, **Target**, **Modification Tier**, **Outcome Holdback**, **Untouchable Core** verbatim where applicable. The vocabulary check flags gaps as a soft warning.
- **Files in scope on every child.** The issue-label-validation workflow (#396) requires it; the validator pre-enforces it so the skill never produces an invalid child.
- **One pass.** The skill creates the parent and N children, then exits. It does not poll, retry, or watch.

## Failure modes

- **`gh issue create` returns 422 (label missing).** If `enhancement` or `ready-for-agent` is missing on the repo, the skill stops mid-batch. The parent may already exist; the operator can either create the missing labels and re-run with `--apply` (which is **not** idempotent — re-running creates duplicate children), or manually delete the partial parent first. A future enhancement could checkpoint progress via the parent body but is out of scope for #514.
- **`/api/tier` unreachable.** The skill falls back to `Expected tier: 3` and prints a warning. The PR's tier-gate will still classify the slice correctly on real file changes.
- **Slice `filesInScope` paths don't exist yet.** The tier classifier handles unknown paths by returning the safest tier; that's by design — most PRD slices reference files that will be created by the dispatched agent. No special-casing needed.
- **Operator passes `--apply` and the JSON is malformed.** The validator runs *before* any `gh` call; nothing is created. The Step 2 validation report is the only output.
