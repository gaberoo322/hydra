---
name: hydra-grill
description: Produce a design-concept artifact for a Hydra anchor — runs a Q&A loop against CONTEXT.md/ADRs/research, sub-dispatches the prototype skill for hard logic questions, emits a handoff doc for unresolvable gaps. - When the autopilot needs a design concept before dispatching dev_orch/dev_target, or the operator wants to grill an issue before implementation.
when_to_use: "When the autopilot needs a design concept before dispatching dev_orch/dev_target, the operator says 'grill issue #N' / 'design-concept #N', or an issue is labelled needs-design-concept."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [anchor, scope]
claude_only: true
---

# Hydra Grill

Produce a **design-concept artifact** for a Hydra anchor before any code-writing
dispatch. Adapts Matt Pocock's upstream `grill-with-docs` to operate against
Hydra's own vocabulary — `CONTEXT.md`, ADRs under `docs/adr/`, OpenViking
knowledge, and Redis-backed research reports.

This skill is Phase A of the design-concept gate (#437). The artifact lands in
Redis via `POST /api/design-concepts` and is consumed in later phases by:

- the autopilot (`scripts/autopilot/decide.py`) before `dev_orch` / `dev_target`
  dispatch (Phase B);
- the rewritten `hydra-qa` two-axis review (sub-issue #440).

**Consumer-side shape (ADR-0008).** `GET /api/design-concepts/:anchorRef`
returns a **flat** body: the artifact fields (`anchorRef`, `scope`,
`invariants`, `qaTrace`, `modulesTouched`, ...) at the **top level**, plus a
single `gate` sub-object. There is **no `.concept` envelope** — consumers read
`.invariants` / `.scope` / `.gate` directly, never `.concept.*`. Probing for a
`.concept` field returns `undefined`.

Phase A: **build & shadow only**. The autopilot does not yet refuse dispatch
without an artifact. The skill is invocable on demand by the operator and
exists for end-to-end shakedown.

## Read these first

- [ADR-0008](../adr/0008-design-concept-gate.md) — the artifact schema and gate
  semantics. Authoritative — if this prose disagrees with the ADR, follow the
  ADR.
- [`src/design-concept.ts`](../../src/design-concept.ts) —
  `gateCheck()` is the only definition of "what the gate will accept".
- [`CONTEXT.md`](../../CONTEXT.md) — the ubiquitous-language glossary.
- Upstream skills (read these for the Q&A discipline, not the wiring):
  `~/.claude/skills/grill-with-docs/SKILL.md`,
  `~/.claude/skills/grill-me/SKILL.md`,
  `~/.claude/skills/prototype/SKILL.md`,
  `~/.claude/skills/handoff/SKILL.md`.

## Inputs

```
arguments: [anchor, scope]
```

- `anchor` — GitHub issue number (e.g. `439`) or an arbitrary anchor reference
  string. Used verbatim as the Redis key (`hydra:design-concept:{anchor}`).
- `scope` — `orch` or `target`. Defaults to `orch` if omitted; the autopilot
  passes it explicitly.

## Hard caps (non-negotiable)

| Budget | Limit | Why |
|---|---|---|
| Q&A wall-clock | 30 min | Pocock skill convention; bounds operator-invoked runs. |
| Q&A tokens | 30k | Per-session token cap from the issue body. |
| Prototype wall-clock | 5 min | Issue body — prototype is throwaway evidence. |
| Prototype tokens | 50k | Issue body — separate from the Q&A budget. |
| Q&A turn count | min 6, max 30 | Schema-min from `gateCheck()` rule 5; ADR-0008 hard cap. |

On cap-hit, the skill **yields partial state** (writes what it has, marks
`status: 'draft'`, and ends) rather than retrying or looping.

## Process

### Step 1 — Worktree-guard preamble (REQUIRED for the prototype sub-dispatch)

`hydra-grill` itself is read-mostly + API-write — it does not need worktree
isolation in its parent context. The prototype sub-dispatch (Step 4) DOES
need it: the dispatched `prototype` child writes throwaway code under
`/tmp/hydra-prototype-<anchor>/`. Verbatim block to inject into the child
prompt, per `feedback_bg_agent_worktree_hygiene`:

```
## CRITICAL SAFETY RULE — READ FIRST
Run `pwd` and `git rev-parse --git-dir` first.
- Worktree path AND `.git/worktrees/...` gitdir → proceed.
- cwd == `/home/gabe/hydra` (or `/home/gabe/hydra-betting`) → ABORT.
No fallback. No `git checkout` in the main tree.
```

The parent context also verifies it is NOT mutating the main tree before
any prototype sub-dispatch:

```bash
PARENT_BRANCH=$(git -C ~/hydra rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
PARENT_DIR=$(git -C ~/hydra rev-parse --git-dir 2>/dev/null || echo unknown)
# The parent skill must NOT write to the main hydra tree; prototype sandbox
# is always under /tmp/hydra-prototype-<anchor>.
```

### Step 2 — Load context

Four sources, read in order. Stop early as soon as enough material exists to
seed the Q&A loop; do not exhaust all four when the first two are sufficient.

The READ scope depends on `$scope`:

- `scope=orch` → orchestrator vocabulary: `~/hydra/CONTEXT.md` + `~/hydra/docs/adr/`.
- `scope=target` → target's multi-context vocabulary (see Step 2.target below). Do NOT read `~/hydra/CONTEXT.md` for target anchors — the orchestrator's glossary describes the orchestrator, not the target.

1. **`CONTEXT.md`** (scope=orch) / **target glossaries** (scope=target — Step 2.target).
   Extracts go into `glossaryTerms` only when the term is actually referenced
   by the issue body or comes up during the Q&A loop. Do not stuff the entire
   glossary into `glossaryTerms` — the artifact is a record of what *this*
   design grounded in.

2. **ADRs** (scope=orch: `~/hydra/docs/adr/`; scope=target: see Step 2.target).
   Start with the ones the issue body references by number or title. Then
   grep for any ADR mentioning a module path the change is likely to touch.

3. **Research report** (if present):
   ```bash
   curl -sf --max-time 5 \
     "http://localhost:4000/api/reports/research/$ANCHOR" \
     || echo '{"missing": true}'
   ```
   Absent report is fine — research is not a prerequisite for grilling.

4. **Issue body**:
   ```bash
   gh issue view "$ANCHOR" --repo gaberoo322/hydra --json title,body,labels
   ```

5. **OpenViking semantic search** for related past work — optional, only
   when the Q&A loop surfaces a "have we done this before?" question.

#### Step 2.target — Multi-context target glossaries (scope=target only)

The target (`~/hydra-betting`) uses a multi-context layout with one
`CONTEXT.md` per context plus a root `CONTEXT-MAP.md` index. Read lazily,
not eagerly — the autopilot dispatches grill sessions often and exhaustive
reads are wasted tokens when the issue only touches one context.

1. **Always** read `~/hydra-betting/CONTEXT-MAP.md` (the index).
2. **Always** read `~/hydra-betting/docs/agents/domain.md` — it is the
   agent-facing contract documenting both the READ layout and the WRITE
   protocol that `hydra-target-build` will follow downstream. The Q&A loop
   must respect both.
3. Identify which contexts the issue touches by grepping the context names
   from CONTEXT-MAP against the issue body. If no context is named, leave
   `modulesTouched[]` to be filled by the Q&A loop and ask the operator to
   name them.
4. For each identified context, read `web/src/lib/<context>/CONTEXT.md`.
   Some contexts are stubs marked _"to be grilled"_ — proceed silently if
   the file is sparse, but record the gap in `glossaryGaps` if a term you
   need is missing.
5. **System-wide ADRs**: always read `~/hydra-betting/docs/adr/` (index
   listing only; load specific files when the issue body or Q&A loop
   references them).
6. **Context-scoped ADRs**: for each identified context, list
   `web/src/lib/<context>/docs/adr/` if it exists. Absence is fine — the
   directory is created lazily.

The artifact's `glossaryTerms[i]` entries should record the *source path*
of the term (e.g. `web/src/lib/arbitrage/CONTEXT.md`) so downstream
reviewers can navigate back to it.

### Step 3 — Q&A loop

At least 6 questions (`gateCheck()` rule 5), capped at 30 (ADR-0008 hard
cap). Each question must close a branch of the design tree. Ask **one at a
time**; do not batch. Each `qaTrace[i]` entry pairs the question with the
agent's resolved answer — not a stream of options.

**Mandatory topics** (each one populates a specific artifact field):

| Question theme | Field populated |
|---|---|
| Which modules will this touch? | `modulesTouched[].path` |
| For each module: deep or shallow? | `modulesTouched[].depthClassification` |
| Does the change extend or break the module's public interface? | `modulesTouched[].interfaceImpact` |
| What invariants must hold after the change? | `invariants` |
| What alternatives were considered and rejected? | `rejectedAlternatives` |
| Are there terms in the issue not in `CONTEXT.md`? | `glossaryGaps` (see Step 5) |

The "deep or shallow?" classification leans on the heuristics already
encoded in [`src/codebase-analyzer.ts`](../../src/codebase-analyzer.ts) —
the skill is not required to call the module, but the same vocabulary
applies. A clearly shallow module (thin pass-through, no decisions of its
own) should be flagged; a deep one (carries policy, has invariants) is the
opposite signal.

When prose alone cannot resolve a question about a state machine, schema
shape, reducer, or any other small piece of logic — escalate to Step 4
(prototype sub-dispatch) rather than guessing.

### Step 4 — Prototype sub-dispatch (LOGIC branch)

Only when a Q&A turn surfaces a question that prose can't resolve and that
a tiny piece of code can.

1. Create the sandbox path under `/tmp/hydra-prototype-<anchor>` (NOT under
   `~/hydra`). The path includes the anchor reference so concurrent
   grilling sessions for different anchors don't collide.
2. Invoke the upstream `prototype` skill (LOGIC branch) with a single
   clear question statement. The dispatched child receives the worktree-
   guard preamble from Step 1.
3. Capture the smallest snippet that encodes the decision (state machine,
   reducer, schema, type shape). Inline it as `prototypes[i]` in the
   artifact with `branch: 'logic'`.
4. **Delete the sandbox** after capture:
   ```bash
   rm -rf "/tmp/hydra-prototype-${anchor}"
   ```
   Prototypes are throwaway evidence — they live in the artifact, never
   on disk and never in the repo. The skill MUST `rm -rf` the sandbox on
   both success and failure paths.
5. **Hard cap**: 5 min wall-clock, 50k tokens for the sub-dispatch. On
   cap-hit, capture whatever partial state the prototype produced (or
   empty-string the snippet) and continue to the next question.

The hydra-grill parent does not write the prototype code itself — the
upstream `prototype` skill is the only thing that touches the sandbox.
This keeps the throwaway code out of any agent context that might later
be tempted to copy it into `src/`.

### Step 5 — Glossary-gap handling

For each candidate gap surfaced in Step 3:

1. **Alias detection**: grep the codebase + `CONTEXT.md` for similar-but-
   not-identical terms. If a clean match exists (e.g. the issue says
   "anchor candidate" but `CONTEXT.md` has "Anchor"), the rewrite path is
   to use the canonical term and drop the entry from `glossaryGaps`.
   Optionally, leave a one-line comment on the issue suggesting the
   canonical phrasing.

2. **Genuinely new term**: file a separate PR proposing the addition to
   the relevant glossary. The PR must be labelled `ubiquitous-language`.
   Reference the PR URL in the artifact body so the gate-fail reasons
   cite something actionable.

   **Where the PR lands depends on scope:**
   - `scope=orch` → PR against `gaberoo322/hydra`, updating
     `~/hydra/CONTEXT.md`.
   - `scope=target` → PR against `~/hydra-betting`, updating either
     `web/src/lib/<context>/CONTEXT.md` (term scoped to one context) or
     `CONTEXT-MAP.md` relationships section (cross-context term). New
     ADR? `docs/adr/NNNN-kebab-slug.md` for cross-context decisions,
     `web/src/lib/<context>/docs/adr/NNNN-kebab-slug.md` for scoped ones.
     The per-context CONTEXT.md is glossary-only; ADRs go in adr/.

   **Phase A behaviour**: the gate fails closed on any non-empty
   `glossaryGaps` (per `gateCheck()` rule 1). The whitelist-via-Redis
   escape hatch lands in a later sub-issue. Phase A grilling sessions
   that surface genuinely-new terms WILL escalate to handoff (Step 8).
   That is intentional — the operator either lands the `CONTEXT.md` PR or
   invokes the override.

### Step 6 — Glossary-purity audit

While loading `CONTEXT.md` (Step 2), watch for entries that violate the
"glossary-only" rule established in #441:

- Implementation details (file paths, function names, code snippets).
- `(planned)` placeholders that never landed.
- Multi-paragraph explanations that belong in an ADR, not the glossary.

Each finding becomes a `glossary-purity` entry on a separate
`ubiquitous-language` PR — do not bundle it into the design-concept
artifact or into the gap-fix PR from Step 5. CONTEXT.md is glossary-only;
the purity audit is read-only from this skill's perspective.

This step is opportunistic — if no findings surface, skip it. Do not
generate findings for the sake of having any.

### Step 7 — Write the artifact

POST the full body to `/api/design-concepts`. The store computes
`createdAt` and `artifactHash` server-side; the skill MUST NOT supply
either field.

Use the helper at `scripts/autopilot/grill-artifact.sh`:

```bash
# Compose the body in a temp file. Order of fields doesn't matter to
# the API, but matters to artifactHash determinism (canonical-JSON
# encoding inside design-concept.ts sorts keys).
BODY_PATH=$(mktemp -t hydra-grill-XXXXXX.json)
jq -n \
  --arg anchorRef "$ANCHOR" \
  --arg scope "$SCOPE" \
  --argjson glossaryTerms "$GLOSSARY_TERMS_JSON" \
  --argjson glossaryGaps "$GLOSSARY_GAPS_JSON" \
  --argjson modulesTouched "$MODULES_TOUCHED_JSON" \
  --argjson invariants "$INVARIANTS_JSON" \
  --argjson rejectedAlternatives "$REJECTED_JSON" \
  --argjson qaTrace "$QA_TRACE_JSON" \
  --argjson prototypes "$PROTOTYPES_JSON" \
  '{
    anchorRef: $anchorRef,
    scope: $scope,
    glossaryTerms: $glossaryTerms,
    glossaryGaps: $glossaryGaps,
    modulesTouched: $modulesTouched,
    invariants: $invariants,
    rejectedAlternatives: $rejectedAlternatives,
    qaTrace: $qaTrace,
    prototypes: $prototypes
  }' > "$BODY_PATH"

bash scripts/autopilot/grill-artifact.sh write "$BODY_PATH"
rm -f "$BODY_PATH"
```

The response is the persisted artifact including the server-computed
`artifactHash`. Save it — Step 8 uses it.

### Step 8 — Gate-check → auto-approve OR escalate

Run the gate against the freshly-written artifact:

```bash
if bash scripts/autopilot/grill-artifact.sh gate "$ANCHOR"; then
  # Gate ok → auto-approve.
  bash scripts/autopilot/grill-artifact.sh approve "$ANCHOR" "auto-gate"
  echo "design-concept approved: $ANCHOR (artifactHash=$ARTIFACT_HASH)"
else
  # Gate fail → write a structured handoff into the operator queue,
  # do NOT approve, do NOT retry.
  GATE_REASONS=$(bash scripts/autopilot/grill-artifact.sh gate "$ANCHOR" 2>/dev/null || true)
  # Invoke the upstream handoff skill via the Agent tool — see below.
fi
```

`grill-artifact.sh gate` exits 0 iff the gate passes; otherwise prints the
reasons and exits 1. The skill MUST trust the helper's verdict — re-
inferring "is this approvable?" from the artifact body in prose has been
the failure mode the design-concept gate exists to prevent.

**Auto-approve** (gate ok) writes `approvedBy: 'auto-gate'`. The Phase B
autopilot wiring will then accept the artifact for dispatch.

**Escalate** (gate fail) writes a structured handoff. The handoff:

1. Goes into the issue titled `Operator decision queue YYYY-MM-DD`
   (today's date in UTC). If that issue does not exist, create it with
   the `ready-for-human` label.
2. Uses the upstream `handoff` skill format — not freeform prose. The
   body summarises (a) what was explored, (b) which gate reasons fired,
   (c) what the next session should do (typically `/grill-me` or
   `/grill-with-docs` for continuation, or "operator must decide between
   alternative X and Y").
3. References the artifact's `anchorRef` and `artifactHash` so the
   operator can pull the draft from Redis to continue from.

Concrete invocation (parent-context bash):

```bash
TODAY=$(date -u +%Y-%m-%d)
QUEUE_TITLE="Operator decision queue ${TODAY}"
QUEUE_NUM=$(gh issue list --repo gaberoo322/hydra --state open --search "$QUEUE_TITLE in:title" \
  --json number --jq '.[0].number // empty')

if [ -z "$QUEUE_NUM" ]; then
  QUEUE_NUM=$(gh issue create --repo gaberoo322/hydra \
    --title "$QUEUE_TITLE" --label ready-for-human \
    --body "Operator decision queue for $TODAY. hydra-grill / hydra-autopilot append entries here." \
    | grep -oP 'issues/\K[0-9]+')
fi

# Dispatch handoff skill via Agent tool to compose the body, then post
# as an issue comment. Do NOT write a freeform "this is stuck" prose
# message — the handoff skill is the format.
HANDOFF_BODY="$(handoff_skill_compose "$ANCHOR" "$GATE_REASONS")"
gh issue comment "$QUEUE_NUM" --repo gaberoo322/hydra --body "$HANDOFF_BODY"
```

The placeholder `handoff_skill_compose` represents the
`Agent(skill='handoff', ...)` call — the upstream skill writes the doc
itself; the parent context only routes it.

## Output

Stdout (machine-readable, one line):

```
design-concept <anchorRef> hash=<artifactHash> status=<approved|draft> gate=<ok|fail>
```

Side effects:

- Redis write at `hydra:design-concept:<anchorRef>` (7-day TTL).
- On `gate=fail`: comment on `Operator decision queue YYYY-MM-DD` issue.
- Optional: `ubiquitous-language`-labelled PR(s) for glossary gaps or
  glossary-purity findings (Steps 5, 6).
- Sandbox under `/tmp/hydra-prototype-<anchor>` is **always** deleted
  before this skill returns, even on failure paths.

## Out of scope (Phase A)

- Autopilot wiring to refuse `dev_orch` / `dev_target` dispatch without an
  artifact. That lands in Phase B (a follow-up sub-issue of #437).
- CI merge-gate hook to require an artifact in the PR body. Phase C.
- Target-side autopilot wiring that *refuses* `dev_target` dispatch
  without an approved artifact. Phase D. (Target-side READ wiring — what
  this skill reads when `scope=target` — landed via Step 2.target above;
  the artifact carries the target vocabulary forward to
  `hydra-target-build`.)

## Manual invocation

```bash
# Operator grills an issue before dispatching dev_orch:
claude --dangerously-skip-permissions -p "/hydra-grill 439 orch"

# Just gate-check an existing draft without re-grilling:
bash scripts/autopilot/grill-artifact.sh gate 439

# Operator overrides a failed gate (rare; reserved for edge cases the
# Phase A whitelist would have handled):
bash scripts/autopilot/grill-artifact.sh approve 439 "operator:gabe"
```

## Where to look when something goes wrong

| Symptom | First place to look |
|---|---|
| Skill exits without a Redis artifact | `curl http://localhost:4000/api/design-concepts/<anchor>` — was the POST attempted? |
| Gate fails on a freshly-approved artifact | Check `gateCheck()` reasons; the artifact was likely approved before all rules passed — re-grill. |
| Prototype sandbox left behind on disk | The cleanup in Step 4 was skipped; `rm -rf /tmp/hydra-prototype-<anchor>` manually and file a bug. |
| Handoff written as freeform prose | The skill bypassed the upstream `handoff` skill — that is a regression; re-dispatch via Agent tool. |
| `qaTrace.length < 6` despite a long session | The skill summarised multiple turns into one entry; the rule is one entry per resolved branch, not one per topic. |

## Safety rules

1. NEVER write to `~/hydra` or `~/hydra-betting` working trees. All file
   IO outside the artifact is under `/tmp/hydra-prototype-<anchor>`.
2. NEVER skip the Step 4 sandbox cleanup, even on failure.
3. NEVER approve an artifact whose `gateCheck()` returns `ok: false` —
   the operator override path uses `approvedBy: 'operator:<name>'` and
   is explicit.
4. NEVER write the handoff as freeform prose — always invoke the
   upstream `handoff` skill.
5. The Q&A loop is bounded — on cap-hit, yield partial state (`status:
   'draft'`); do not retry, do not extend the cap.
