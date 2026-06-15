---
name: hydra-dev
description: Pick up a GitHub issue from gaberoo322/hydra and autonomously implement it in a worktree — research the codebase, implement, verify, and open a PR.
when_to_use: "When the user wants to work on a Hydra orchestrator issue, says 'pick up an issue', 'work on issue #N', 'develop'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
claude_only: true
---

# Hydra Dev

Autonomous implementation of GitHub issues against the Hydra orchestrator (`~/hydra`). Delegates to a worktree subagent for isolation.

## Am I the parent or the child? — read FIRST (issue #1900)

This playbook is written from the **parent dispatcher's** point of view (Pre-flight selection, `### 5. Spawn worktree agent`, post-agent reaping). But `hydra-autopilot` dispatches `hydra-dev` as a **background worktree subagent with no spawn tool** (inline mode, per the issue #1782 contract). In that environment **you ARE the child** — the spawn instructions do not apply to you. Mirror the inline-mode disambiguation `hydra-target-build` already uses.

**Mode detection (mandatory, before any work):** decide which role you are playing in THIS session:

- **You are the CHILD** if you were dispatched into a fresh worktree (cwd under `/dev/shm/hydra-worktrees/`, `/home/gabe/hydra-worktrees/`, or `/home/gabe/hydra/.claude/worktrees/`, with `git rev-parse --git-dir` under `.git/worktrees/`) and you have NO `Agent`/`Task` spawn tool. This is the autopilot inline-dispatch case. **Skip the parent Pre-flight (selection / size check / mark-in-progress) and the entire `### 5. Spawn worktree agent` step — they were already done for you by the dispatcher.** The dispatch prompt already named your issue, prepended the worktree-guard + path-anchoring + scope-respect preambles, and placed you in the worktree. Go straight to the **child execution contract** (the numbered child steps under "The child:" in Step 5 — verify isolation, read CONTEXT/ADRs, extract scope, fetch reflections + design-concept + tier via the live APIs, implement, run `npm test` / `npm run typecheck` / `npm run build`, open the PR with `closes #N`, emit the `## Friction Report`). Do NOT spawn another agent; do NOT re-select or re-label the issue from the parent's pre-flight.
- **You are the PARENT** if you have an `Agent`/`Task` spawn tool available (or are being run interactively by the operator to dispatch work). Run the full playbook top to bottom: Pre-flight → Spawn worktree agent → Post-agent reaping.

If unsure whether a spawn tool exists, make exactly ONE `ToolSearch` query (e.g. `+agent spawn task`) against the deferred-tool list, then commit to a mode — do not retry, and do not assume availability either way. The dispatch environment never grows the tool mid-session, so an absent spawn tool means: you are the child, proceed inline. Never abort merely because the spawn tool is absent, and never silently run the child steps without first recognising you are the child.

## Critical safety rules

1. **NEVER run `git stash`/`checkout`/`reset`/`clean` on the main `~/hydra` working tree.** Operator may have uncommitted work.
2. All implementation runs inside a worktree — Claude: `Agent(isolation: "worktree")`; Codex: `codex exec` in a fresh `git worktree add`.
3. Dirty main tree is fine — worktrees are independent.
4. **No silent fallback.** If the dispatched BG agent finds itself in `~/hydra` instead of a worktree, it MUST abort. Falling back to `~/hydra` left the main checkout on a feature branch on 2026-05-11 and stalled deploys for ~30 min (incident: PR #245).
5. **Run tests via `npm test`, or pass `--test-force-exit` for a single file. NEVER run a bare `node --test <file>`.** Orchestrator modules open a long-lived `ioredis` connection and a scheduler `setTimeout`, so `node:test` keeps the event loop alive and **hangs forever** after the assertions pass (confirmed: `node --test test/scheduler-status.test.mts` → never exits; with `--test-force-exit` → clean). A hung test blocks the Bash tool call, which froze a whole autopilot session for 11h with the process never reaped (2026-05-28). `npm test` already includes `--test-force-exit`; for a subset use `node --test --test-force-exit <file>`.
6. **To identify *which* test failed in one run, use `npm run test:debug` — never re-run + grep (issue #1076).** The default `npm test` reporter buffers stdout and `--test-force-exit` tears the process down before the per-test `not ok …` diagnostic lines flush, leaving only the aggregate footer (`# pass N` / `# fail M`). `npm run test:debug` runs the identical flags as `npm test` (force-exit retained — dropping it hangs on the open Redis handle) but adds a **dual reporter**: `spec → stdout` for human-readable output AND `tap → test-debug.tap` written synchronously to a file fd. After a run, the failing suite/test names are in `test-debug.tap` as `not ok <n> - <name>` lines, plus the same `# pass/# fail` footer — so a single invocation surfaces the failing suite without a second full-suite run. The `test-debug.tap` artifact is git-ignored. Do **not** edit the `test` script itself: CI greps its footer for the `MIN_TESTS` ratchet, so `test:debug` is a separate additive script.

## Pre-flight (parent context)

### 1. Select issue

If `$issue_number` provided, use it. Otherwise:
```bash
gh issue list --repo gaberoo322/hydra --label "ready-for-agent" --state open --json number,title --jq '.[0]'
```
None → report and stop.

### 2. Fetch and validate
```bash
gh issue view $issue_number --repo gaberoo322/hydra
```

Verify structured sections (acceptance criteria or "What to build"). Vague one-liner → stop, tell operator to run `/triage` first.

### 3. Size check — decompose if too large

If body has **>5 acceptance criteria** OR description suggests **>8 files changed**:
1. `/to-issues $issue_number` to decompose (Claude) or `codex exec --skill to-issues` (Codex)
2. `gh issue edit $issue_number --add-label blocked --remove-label ready-for-agent`
3. Comment on parent listing children
4. Stop — `/hydra-sweep` picks up children after triage

### 3.5 Scope contract (issue #396)

Before dispatching, confirm the issue body contains a `## Files in scope` section (and ideally a `## Files out of scope` section). The CI `scope-check` gate now treats both sections as authoritative:

- Anything in **Files in scope** is fair game.
- Anything in **Files out of scope** is a HARD merge blocker — touching it fails CI regardless of the ratio threshold.
- The only escape hatch is for the subagent to add a `scope-justification:` block to its PR body listing the specific files it had to touch and why.

If the issue is missing `## Files in scope`, stop and re-triage. The `issue-label-validation` workflow blocks the `ready-for-agent` label transition when this section is missing, so this should be rare in practice — but a freshly-labelled issue may still need a one-time correction.

> **Code-span trap (recurring friction `scope-check-codespan-trap`):** the `scope-check` parser unions **every** backticked code-span it finds *anywhere inside* the `## Files in scope` / `## Files out of scope` sections into the scope set — not just the bullet-list entries. So a backticked filename buried in prose under those headings (an `Expected tier:` note, a parenthetical, a ⚠️ caveat) becomes a phantom scope entry that can HARD-block an otherwise in-scope file. Keep filenames in such prose **plain-text** (no backticks); reserve backticks for the actual bullet-list path entries.

The dispatched child prompt MUST include the scope-respect block from Step 5 below.

### 4. Mark in-progress
```bash
gh issue edit $issue_number --remove-label ready-for-agent --add-label in-progress
```

### 5. Spawn worktree agent

- **Claude:** `Agent(isolation: "worktree", prompt: <child-prompt>)`
- **Codex:** Create worktree first, then `codex exec` inside it:
  ```bash
  WT=/dev/shm/hydra-worktrees/issue-${issue_number}-$(date +%s)
  git -C ~/hydra worktree add -b "issue-${issue_number}-dev" "$WT" master
  (cd "$WT" && codex exec --skill hydra-dev-child --json "{\"issue\":${issue_number}}")
  ```

**Branch name held by a stale sibling worktree (cue:
pr-branch-checked-out-in-stale-sibling-worktree).** `git worktree add -b
issue-N-…` / `git checkout issue-N-…` fails with `fatal: '<branch>' is
already used by worktree …` when a prior dispatch's worktree still holds
that branch — common on remediation/follow-up dispatches against an existing
PR. Do NOT delete the other worktree, do NOT `git branch -D` the held branch
(blocked while its worktree exists), and do NOT fall back to the main tree.
Recover on a differently-named local branch and push via refspec:

```bash
git fetch origin "$REMOTE_BRANCH"
git checkout -b "${REMOTE_BRANCH}-r$(date +%s)" FETCH_HEAD  # fresh local name
# …edit, commit, verify…
git push origin "HEAD:${REMOTE_BRANCH}"  # refspec push updates the PR branch
```

(Proven recovery on hydra-dev-1666 2026-06-10 and hydra-dev-1667 2026-06-11;
cross-run recurrence 3 promoted this lesson via /hydra-retro.)

**`/dev/shm` worktree has no `node_modules` (cue:
devshm-verify-worktree-needs-node-modules-symlink).** Worktrees under
`~/hydra/.claude/worktrees/` resolve `node_modules` through Node's upward
directory walk (`/home/gabe/hydra/node_modules` is an ancestor), but a
`/dev/shm/hydra-worktrees/` worktree has no such ancestor — `npm test` /
`npx tsx` / `npm run typecheck` fail with module-not-found. Symlink instead
of a slow `npm ci`:

```bash
ln -sfn /home/gabe/hydra/node_modules "$WT/node_modules"
```

`git worktree move` does NOT carry the symlink — re-create it after any
move. (Observed on hydra-dev-1676 2026-06-11; cross-run recurrence 3
promoted this lesson via /hydra-retro.)

**…but that symlink then leaks into the PR diff if you `git add -A` (cue:
worktree-node-modules-symlink-stages-as-file).** `.gitignore`'s
`node_modules/` pattern has a trailing slash, so it matches a *directory*,
not the `node_modules` symlink-as-file the step above creates — `git add -A`
(or `git add .`) stages the symlink as a tracked file and it ships in the PR.
After staging, reset it before committing:

```bash
git reset -q -- node_modules   # un-stage the symlink the gitignore misses
git status --porcelain node_modules   # MUST be empty before you commit
```

Prefer staging the files you touched by path over `git add -A` in a
symlinked worktree. (Observed on hydra-dev-1834 2026-06-13; cross-run
recurrence 9 promoted this lesson via /hydra-retro.)

The child prompt MUST include the worktree-guard preamble (see below) AND the scope-respect block (see below). The child:
1. Verifies it is in a worktree (NOT `/home/gabe/hydra`). Aborts if not.
2. Reads CLAUDE.md / AGENTS.md, CONTEXT.md, relevant ADRs
3. Extracts the `## Files in scope` + `## Files out of scope` lists from the issue body
4. **Fetches per-anchor Reflections via the live API (see "Reflection injection — live API" below)** and, if any are returned, weaves the narrative into its implementation plan. Never skip — a retry of a prior-failure anchor depends on this.
5. Greps/reads the source for context
6. Implements the issue — touching out-of-scope files only with a `scope-justification:` block in the PR body
7. **Declares glossary/ADR impact** — per the `docs/agents/domain.md` WRITE contract, add a `Glossary impact:` / `ADR impact:` line to the PR body for any term resolved or decision made (a `## Glossary delta` in the issue or referenced ADR names it). Do **not** edit `CONTEXT.md` in this code PR — the delta lands in a **separate `ubiquitous-language`-labelled PR**.
8. Runs `npm test` + `npm run typecheck` + `npm run build`
9. **Classifies the change via the live tier API (see "Tier classification — live API" below).** Never self-classify by path patterns.
10. Opens a PR with `closes #$issue_number` in the body, a `## Files in scope` mirror of the issue's section, and a `Tier: <0|1|2|3>` line populated from the API. **Acceptance criteria MUST be written as checkboxes with a mechanical "verified by:" assertion** — each criterion must name the exact command or observable output a reviewer can check without reading code. Format:
    ```
    - [ ] Criterion A — verified by: `npm test -- --test-name-pattern "criterion-A"` exits 0
    - [ ] Criterion B — verified by: `curl -s http://localhost:4000/api/foo | jq '.status'` returns "ok"
    - [ ] Criterion C — verified by: `git diff --name-only origin/master...HEAD` includes path/to/file.ts
    ```
    Prose-only criteria ("implementation detail X is handled correctly") are rejected by QA — always pair a what with a how-to-verify.
11. Returns: PR URL + summary table

### Reflection injection — live API (issue #841)

A prior **failed** attempt on the same anchor (or, post-#326, a different
anchor that touched the same files) leaves a per-anchor **Reflection** —
"what was attempted, why it failed, what to change". Before #841 this
narrative reached code-writing dispatches only through the dead in-process
`buildPlannerContext`, so retries silently lost their own failure context
(the 0%-merge-rate condition #193 was created to fix). The narrative is now
re-homed on a **live** path the child fetches itself.

At **planning time** — the same point the child consults the tier API
below — fetch the per-anchor reflection narrative and weave it into the
implementation plan. The endpoint composes the existing per-anchor +
by-file reflection reads server-side, so large narrative text stays out of
`decide.py` (the dispatch JSON carries only `{anchor, score}`).

**Endpoint contract:**

- Method: `GET`
- Path: `/api/reflections`
- Query:
  - `anchor=<anchor.reference>` (the issue ref, e.g. `issue-841` — use
    `anchor.reference`, NOT `task.title`, matching the Kanban-key rule)
  - `files=<csv>` (optional) — the `## Files in scope` paths, comma-separated,
    so reflections from other anchors that touched the same files surface too
- Response (200): `{ anchor, formatted, count, blocks: [{source, count}, ...] }`
  - `formatted` is prompt-ready markdown (the `## PRIOR ATTEMPTS …` and
    `## RELATED FILES — Prior Failures …` sections). `count: 0` /
    `formatted: ""` means no prior reflections — a clean no-op.

**Required child-side recipe (at planning time, before writing code):**

```bash
# anchor.reference is the issue reference, e.g. "issue-841".
# FILES_CSV is the `## Files in scope` list, comma-separated.
REFL_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/reflections?anchor=$(printf '%s' "$ANCHOR_REF" | jq -sRr @uri)&files=$(printf '%s' "$FILES_CSV" | jq -sRr @uri)")

REFL_FORMATTED=$(printf '%s' "$REFL_JSON" | jq -r '.formatted // ""')
if [ -n "$REFL_FORMATTED" ]; then
  # Prepend REFL_FORMATTED to your implementation-planning context. This anchor
  # (or a related file) failed before — read the prior attempts and do NOT
  # repeat the same approach.
  printf '%s\n' "$REFL_FORMATTED"
fi
# Empty / unreachable → graceful no-op (degrade exactly as the dead path did
# on a miss). Never fail the dispatch over a reflections miss.
```

**Reflection-source telemetry deposit (issue #1136 — at the SAME planning-time
step):** so the `reflectionMatchSource` cycle metric reflects what was actually
served (instead of reading `'none'` on every cycle), MAP the served block
sources to the bucket tokens `deriveReflectionMatchSource` matches and DEPOSIT
the comma-separated string to a task-scoped file. reap.py reads that file on its
single authoritative `cycle-record` write — do **NOT** POST `cycle-record`
yourself (reap is the sole writer; a competing POST loses the idempotency race
and silently dedups to a no-op).

CRITICAL mapping: the API emits `blocks[].source` = `per-anchor-reflections` /
`by-file-reflections`, but `deriveReflectionMatchSource` matches the BARE tokens
`per-anchor` / `by-file`. Emit the mapped tokens, never the raw API strings
(raw strings mis-bucket to `mixed`/`none`).

```bash
# Map each served block (count>0) to its bucket token, comma-join.
REFL_SOURCES=$(printf '%s' "$REFL_JSON" | jq -r '
  [ (.blocks // [])[]
    | select((.count // 0) > 0)
    | (.source // "")
    | if test("per-anchor") then "per-anchor"
      elif test("by-file") then "by-file"
      elif test("global") then "global"
      else empty end ]
  | unique | join(",")')
# Deposit keyed on THIS dispatch's task_id so reap (which holds the same id)
# can read it. The autopilot envelope surfaces it as HYDRA_AUTOPILOT_TASK_ID;
# fall back to CLAUDE_CODE_SESSION_ID (reap's `.session_id` fallback id).
REFL_TASK_ID="${HYDRA_AUTOPILOT_TASK_ID:-$CLAUDE_CODE_SESSION_ID}"
if [ -n "$REFL_SOURCES" ] && [ -n "$REFL_TASK_ID" ]; then
  printf '%s' "$REFL_SOURCES" \
    > "${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-sources-${REFL_TASK_ID}" 2>/dev/null \
    || true   # best-effort: a deposit miss only loses telemetry, never blocks work
fi
# Empty REFL_SOURCES (served nothing) → no deposit → reap omits the field →
# the cycle truthfully buckets to 'none'. This distinguishes "served nothing"
# from the pre-#1136 "served but unstamped" false 'none'.
```

**Verify reflections-reach-retry with this endpoint, NOT
`/api/learning/context-trace`.** The context-trace endpoint reports
`getContext()`'s *composition* (a prompt no subagent receives on today's
architecture), so a `hit` there is not proof of delivery — `/api/reflections`
is the live path a dispatch actually consumes.

### Design-concept artifact — live API (cue: design-concept-endpoint-path-plural)

A grilled anchor carries a **design-concept artifact**. When the dispatch
prompt references one ("consult the design-concept API"), fetch it at
planning time — same point as the reflections + tier reads:

- Method: `GET`
- Path: `/api/design-concepts/<anchor.reference>` — **plural** resource
  name, anchor ref as a **path param** (e.g.
  `/api/design-concepts/issue-1699`). There is no singular
  `/api/design-concept` route and no `?anchor=` query form — that guess
  returns an empty/404 that looks like "no artifact" and silently drops the
  design context (cue `design-concept-endpoint-path-plural`, recurred 3×
  across runs).
- Response (200): the artifact fields at the **top level** plus a `gate`
  sub-object (`gateCheck` verdict). There is **NO `.concept` envelope** —
  read `.invariants` etc. directly; probing `.concept` returns `undefined`
  (cue `design-concept-endpoint-concept-field-absent`).
- 404 → no artifact persisted for that anchor — proceed without one; do not
  retry alternate route spellings.

### Tier classification — live API (issue #406)

The orchestrator service exposes a deterministic tier classifier at
`GET http://localhost:4000/api/tier?files=<comma-separated paths>`. The child
MUST call this endpoint with the exact list of files it changed (relative to
the repo root, as `git diff --name-only origin/master...HEAD` would emit) and use
the returned `tier` value verbatim in the PR body. Do NOT infer tier from
path patterns — that was the failure mode that motivated this rule
(autopilot run 2026-05-14 mis-classified PR #404 as Tier 2 when the live
classifier returns Tier 3 for the same file list, wasting a QA cycle).

**Endpoint contract:**

- Method: `GET` (not POST — the endpoint reads a query parameter, not a JSON body)
- Path: `/api/tier`
- Query: `files=path1,path2,path3` (comma-separated, repo-relative)
- Response (200): `{ "tier": 0|1|2|3, "reason": "<string>", "perFile": [{path,tier,matched},...] }`
- Response (400): `{ "error": "Missing query parameter 'files' (comma-separated)" }`

**Required child-side recipe:**

```bash
# After all file changes are committed on the feature branch, before opening the PR:
# Diff against origin/master, never local master — the worktree shares ~/hydra's
# gitdir, whose local master ref goes stale as sibling PRs merge mid-cycle
# (cue: stale-local-master-ref). A stale base inflates the diff and mis-tiers the PR.
git fetch origin --quiet
CHANGED=$(git diff --name-only origin/master...HEAD | paste -sd, -)
TIER_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/tier?files=$(printf '%s' "$CHANGED" | jq -sRr @uri)")

if [ -z "$TIER_JSON" ]; then
  # Endpoint unreachable — mark unknown and let QA triage instead of guessing.
  TIER_LINE="Tier: unknown (live classifier unreachable; needs operator triage)"
  TIER_LABEL_FLAG="--label needs-triage"
else
  TIER_VALUE=$(printf '%s' "$TIER_JSON" | jq -r '.tier')
  TIER_REASON=$(printf '%s' "$TIER_JSON" | jq -r '.reason')
  TIER_LINE="Tier: ${TIER_VALUE} (${TIER_REASON})"
  TIER_LABEL_FLAG=""
fi
```

Then `gh pr create` MUST include `$TIER_LINE` as its own line in the PR body
(canonically near the top, on a line that starts with `Tier:`), and MUST
pass `$TIER_LABEL_FLAG` so an unreachable classifier results in a
`needs-triage` label rather than a silently-wrong tier claim.

**Why GET, not POST `-d @<file>`:** the endpoint at `src/api/misc.ts` is a
GET route that reads `req.query.files`. An earlier draft of this skill
described `curl -d @<json>`; the live endpoint will return 400 (POST not
allowed) for that shape. The recipe above is the format the running
service accepts as of issue #406.

**Why not infer from CLAUDE.md tables:** CLAUDE.md describes tier scope
in prose for humans. The authoritative classification logic lives in
`src/tier-classifier.ts` and is the only source consulted by the CI
merge gate. A self-asserted tier in the PR body that disagrees with the
gate's answer wastes a QA cycle and produces misleading audit history.

### Child-prompt worktree-guard preamble (REQUIRED)

Every dispatched hydra-dev BG agent prompt MUST begin with the following block, verbatim. The parent skill (or autopilot) is responsible for prepending it before the task body:

```
## CRITICAL SAFETY RULE — READ FIRST

Before doing ANYTHING else, run `pwd` and check:
- If cwd is a fresh worktree (path under `/dev/shm/hydra-worktrees/`, `/home/gabe/hydra-worktrees/`, or `/home/gabe/hydra/.claude/worktrees/`) AND `git rev-parse --git-dir` returns a path under `.git/worktrees/`, proceed.
- If cwd is `/home/gabe/hydra` (the main repo working tree), **ABORT IMMEDIATELY**. Return a failure status with the message: "Worktree isolation broken — cwd is main repo. Refusing to proceed per operator memory feedback_bg_agent_worktree_hygiene. Do not run any git commands."

Do NOT fall back to running in `~/hydra`. Do NOT create a branch in the main tree. Do NOT `git checkout` in the main tree. If isolation failed, the only acceptable action is to fail loudly.
```

If the harness exposes `EnterWorktree`/`ExitWorktree` tools, the child should call `EnterWorktree` only when its initial `pwd` check fails the worktree predicate — never assume "already isolated" without verifying via `git rev-parse --git-dir`.

### Child-prompt path-anchoring contract (REQUIRED — issue #1861)

Append the following block to every dispatched hydra-dev BG agent prompt, immediately after the worktree-guard preamble. It is the prompt-side half of the `worktree-write-fence.sh` PreToolUse hook — the hook denies the bad call, but anchoring paths correctly from the first turn avoids the wasted recovery turns the deny would otherwise cost. This is the single most recurring friction pattern (#1861: ~27 combined cross-run hits under six cues after #542 was closed-not-fixed).

```
## PATH ANCHORING — every file op stays inside the worktree (issue #1861)

Your cwd is a git worktree, but Read/Edit/Write/MultiEdit resolve absolute
paths against the raw filesystem, NOT the worktree namespace. A path like
`/home/gabe/hydra/src/foo.ts` or `/home/gabe/hydra-betting/web/x.ts` points at
the MAIN checkout, not your worktree copy. Reading or writing it ghost-writes
into the main tree (leaving your PR diff empty) or gets denied by the
worktree-write-fence (burning turns).

RULES:
1. Run `pwd` once and treat its output as your worktree root `$WT`.
2. For EVERY Read/Edit/Write/MultiEdit `file_path`, use a path that is either
   repo-relative (resolved against $WT) OR absolute and prefixed with `$WT/`.
   NEVER construct a bare `/home/gabe/hydra/...` or `/home/gabe/hydra-betting/...`
   path for a file you intend to read-for-editing or write — that is the main
   checkout.
3. If a Read/Edit/Write is DENIED by worktree-write-fence, the deny reason
   names the corrected `$WT/...` path. Re-issue the call against THAT path; do
   not try to recompute it or to `cd` out of the worktree.
4. Reading a main-tree-only file with NO worktree copy (a shared config the
   worktree never checked out, an adjacent project's file for reference) is
   allowed and passes the fence — but never base an Edit on such a path.
```

### Child-prompt scope-respect block (REQUIRED — issue #396)

Append the following block to every dispatched hydra-dev BG agent prompt, immediately after the worktree-guard preamble. It is the subagent-side replacement for the deleted `reconcilePlanVsActual()` step (control-loop step 6.5, removed in PR #400):

```
## SCOPE CONTRACT — issue body is authoritative

The linked issue contains a `## Files in scope` section (mandatory) and may contain a `## Files out of scope` section. Before writing any code:

1. Extract both lists from the issue body.
2. Treat `Files in scope` as the SOFT boundary — every file you change should match one of these entries (substring/prefix match, so `src/foo/` covers everything beneath).
3. Treat `Files out of scope` as the HARD boundary — touching anything matching these entries will fail CI's scope-check gate. Do not touch them unless absolutely required.
4. If you DO have to touch an out-of-scope file (e.g. a shared test fixture, an adjacent import), include a `scope-justification:` block in the PR body listing each affected file with a one-line rationale. Example:

       scope-justification: `test/helpers/fixtures.ts` — fixture used by the new test added in scope

5. Mirror the issue's `## Files in scope` section into the PR body so the gate can match against either source.
6. CODE-SPAN TRAP: the scope-check parser treats EVERY backticked code-span inside the `Files in scope` / `Files out of scope` sections as a scope entry, not just the bullet paths. When you write those sections (or any prose under those headings — Expected-tier notes, parentheticals, caveats), keep non-path filenames PLAIN-TEXT. A stray backticked filename in prose becomes a phantom entry that can hard-block one of your real in-scope files.

The CI `scope-check` job at `.github/workflows/ci.yml` enforces this contract. Surprising the operator with out-of-scope edits is exactly the scope-creep failure mode the deleted `reconcilePlanVsActual` used to catch — the issue body + PR body convention replaces it.
```

### 6. Post-agent

**Success (PR URL returned):**

Transition the source issue `ready-for-agent`/`in-progress` → `needs-qa` so
`qa_orch` auto-fires on the open PR and the stale `ready-for-agent` can't
re-surface the issue for a duplicate dispatch (the #770/#754 hazard, root cause
of #846). Mirror `hydra-qa` Step 10 discipline: quote the label literals and
make the edit non-fatal with a `|| echo WARN` guard so a transient `gh` failure
can't abort the run. The transition is keyed by the **issue number** (exact, so
the `anchor.reference`/title pitfall does not apply) via raw `gh issue edit` —
NOT `moveItemToLane` (`src/backlog/lanes.ts`), which is a `src/` helper this bash playbook cannot call.

CRITICAL: remove BOTH `ready-for-agent` AND `in-progress`. The #846 failures
left issues stuck on `ready-for-agent`, so removing only `in-progress` is
insufficient — strip both and add `needs-qa`. `gh issue edit --remove-label` is
idempotent (removing an absent label is a no-op), so listing both is safe
whichever label the issue currently carries.

```bash
gh issue edit "$issue_number" --repo gaberoo322/hydra \
  --remove-label "ready-for-agent" --remove-label "in-progress" \
  --add-label "needs-qa" \
  || echo "WARN: failed to move issue #${issue_number} to needs-qa (non-fatal) — relabel by hand"
```

Then unblock dependents:
```bash
DEPENDENTS=$(gh issue list --repo gaberoo322/hydra --label blocked --state open --json number,body \
  --jq "[.[] | select(.body | test(\"Blocked by.*#$issue_number(\\\\b|[^0-9])\")) | .number] | .[]")
for dep in $DEPENDENTS; do
  BLOCKERS=$(gh issue view $dep --repo gaberoo322/hydra --json body --jq '.body' | grep -oP '(?<=Blocked by.*#)\d+' | tr '\n' ' ')
  ALL_CLOSED=true
  for b in $BLOCKERS; do
    STATE=$(gh issue view $b --repo gaberoo322/hydra --json state --jq '.state')
    [ "$STATE" != "CLOSED" ] && ALL_CLOSED=false && break
  done
  [ "$ALL_CLOSED" = true ] && gh issue edit $dep --repo gaberoo322/hydra --remove-label blocked --add-label ready-for-agent
done
```

**Failure (including isolation-abort):**
```bash
gh issue edit $issue_number --remove-label in-progress --add-label ready-for-agent
gh issue comment $issue_number --body "> *Automated agent comment*

Agent attempted implementation but failed.

**Reason:** <failure reason>
**Branch:** <branch name or 'none — aborted before any git ops'>
**What was tried:** <approach summary>"
```

Isolation aborts must NOT escalate to `ready-for-human` — they are infrastructure errors, not implementation failures. Re-label as `ready-for-agent` so the next dispatch can retry once the harness recovers.

### 7. Post-dispatch sanity check (parent)

After the BG agent returns (success OR failure), the dispatching parent MUST verify the main tree is still clean:

```bash
MAIN_BRANCH=$(git -C ~/hydra rev-parse --abbrev-ref HEAD)
if [ "$MAIN_BRANCH" != "master" ]; then
  echo "WARN: ~/hydra is on '$MAIN_BRANCH', expected 'master'. Isolation likely broke."
  echo "WARN: Do NOT auto-fix without operator approval — feature branch may have unpushed work."
  # Surface to operator; do not run `git checkout master` autonomously.
fi
```

This catches the case where isolation silently failed and the BG agent ran in the main tree anyway (the #245 failure mode).

#### 7a. Ghost-write canary (issue #549)

The `cwd` check above catches cwd-confusion, but NOT the more insidious failure: cwd is the worktree, but an `Edit`/`Write`/`MultiEdit` call landed a write in the main tree via an absolute `file_path` argument. The primary guard is the PreToolUse hook installed by `bash scripts/setup-claude-hooks.sh` (see `scripts/claude-hooks/worktree-write-fence.sh`). The skill-side canary is belt-and-braces in case the hook is uninstalled or a future write-tool slips past the matcher:

```bash
# Snapshot the main-tree dirty-set BEFORE dispatching the BG agent.
PRE_GHOST_SNAPSHOT=$(git -C ~/hydra diff --name-only HEAD 2>/dev/null || true)

# ... dispatch the BG agent ...

# Compare AFTER. New modifications to tracked files in the main tree that
# weren't dirty before == ghost write.
POST_GHOST_SNAPSHOT=$(git -C ~/hydra diff --name-only HEAD 2>/dev/null || true)
NEW_DIRTY=$(comm -13 <(printf '%s\n' "$PRE_GHOST_SNAPSHOT" | sort -u) \
                     <(printf '%s\n' "$POST_GHOST_SNAPSHOT" | sort -u))
if [ -n "$NEW_DIRTY" ]; then
  echo "WARN: main tree gained dirty files during this dispatch — likely an issue #549 ghost-write:"
  printf '%s\n' "$NEW_DIRTY"
  echo "WARN: Run 'python3 scripts/audit-ghost-writes.py' for forensic detail."
  # Surface to operator. Do NOT auto-revert — the operator may have legitimate WIP.
fi
```

The diff-against-HEAD form deliberately includes only changes to tracked files; an operator's untracked WIP scratch in the main tree isn't a ghost-write signal. The snapshot-diff approach also tolerates a dirty main tree at dispatch time (the operator's pre-existing WIP shows up in both snapshots and cancels out).

### 8. Lesson capture on verification failure (issue #392)

When the BG agent returns a **failure** with `verification-failure`, `no-diff`,
or `rollback` as the cause, the parent MUST capture a learning hit so the
executor pattern memory keeps growing after #383 deletes the in-process
control loop. This is the only post-cycle writer to
`hydra:memory:executor:patterns` for Claude-driven runs.

```bash
# Only on failure with a recognised cause. Skip on success (the planner
# pattern set will be trained from QA failures, not from dev success).
curl -fsS -X POST http://localhost:4000/api/memory/subagent-lesson \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg skill "hydra-dev" \
    --arg outcome "verification-failure" \
    --arg cue "verification-failure" \
    --arg context "issue-${issue_number}: ${FAILURE_REASON}" \
    --arg cycleId "hydra-dev-${issue_number}-$(date +%s)" \
    '{skill: $skill, outcome: $outcome, cue: $cue, context: $context, cycleId: $cycleId}')"
```

Use the cue that best matches what failed:
- `verification-failure` — npm test / typecheck / build failed
- `no-diff` — agent produced zero file changes
- `rollback` — merge succeeded but auto-reverted on regression

The endpoint is idempotent on `(skill, outcome, cue)` — multiple calls for
the same logical event merge into one pattern (hit count increments). Don't
call it on success, and don't call it on infrastructure aborts (the
isolation-abort path in Step 6) — those aren't agent-fixable.

### 9. Friction Report (issue #512 — ALWAYS, even on success)

Hard failures are not the whole picture. The child agent ALSO emits a
`## Friction Report` section at the bottom of its return — even on a clean
success. Each item describes a piece of soft friction the agent worked
around without failing, so the next dispatch doesn't re-discover it.

**Child-prompt contract (the dispatched BG agent MUST emit this):**

```markdown
## Friction Report

- cue: orchestrator-watchdog-units-not-in-repo
  workaround: added new install block to scripts/deploy.sh
  context: scripts/deploy.sh, scripts/hydra-watchdog.sh
- cue: hook-registration-location-unspecified
  workaround: chose sibling .settings.json + extended sync-skills.sh
  context: .claude/hooks/, scripts/sync-skills.sh
- cue: stale-local-master-ref
  workaround: used origin/master for diff base instead of master
  context: git rev-parse origin/master
- cue: scheduler-stop-semantics-test-flake
  workaround: confirmed pre-existing flake unrelated to this work
  context: test/scheduler-stop-semantics.test.mts
```

Rules:
- `cue` MUST be kebab-case and stable across runs (so multiple runs that
  hit the same friction merge into the same pattern). NOT free text.
- `workaround` is exactly one line.
- `context` is exactly one line — file paths or commands where relevant.
- If there was no friction worth noting, emit `## Friction Report` with the
  literal body `- (none)` so the parent knows the section is intentional.

**Parent post-flight (the dispatching parent MUST do this):**

After the BG agent returns (success OR failure), parse the `## Friction
Report` section from the response and POST each item to
`/api/memory/subagent-friction`:

```bash
# Pseudocode — one POST per friction item.
curl -fsS -X POST http://localhost:4000/api/memory/subagent-friction \
  -H 'content-type: application/json' \
  -d "$(jq -n \
    --arg skill "hydra-dev" \
    --arg cue "$CUE" \
    --arg workaround "$WORKAROUND" \
    --arg context "$CONTEXT" \
    --arg cycleId "hydra-dev-${issue_number}-$(date +%s)" \
    '{skill: $skill, cue: $cue, workaround: $workaround, context: $context, cycleId: $cycleId}')"
```

The endpoint is idempotent on `(skill, cue)` — multiple dispatches that
re-hit the same friction increment the hit count. When the count crosses
the promotion threshold (3 hits, `PROMOTION_THRESHOLD`), a
`meta-friction` GitHub issue is auto-opened (or comment-bumped if one
already exists for that cue). Failure to POST is logged but does NOT
fail the build — friction capture is best-effort.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`. The classification is done at
emit-time so the /now-pixel dashboard can route on `category` without
re-deriving it from the tool name:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

**Hook script:** `scripts/autopilot/hooks/on-subagent-tool-call.sh`
**Hook registration:** sibling `<this-playbook>.settings.json` →
`~/.claude/skills/<this-skill>/.claude/settings.json` (propagated by
`scripts/sync-skills.sh`)

The hook MUST NEVER propagate errors back to this skill's session — a Redis
outage, a malformed payload, or a missing `jq` all result in a stderr
warning and `exit 0`. See `test/on-subagent-tool-call.test.mts` for the
pinned behavior.
