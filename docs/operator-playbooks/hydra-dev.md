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
  # MANDATORY: /dev/shm worktrees have no ancestor node_modules — symlink before any npm/npx call.
  # (cue: devshm-verify-worktree-needs-node-modules-symlink)
  ln -sfn /home/gabe/hydra/node_modules "$WT/node_modules"
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
4a. **MANDATORY — deposits the reflection-source telemetry file AND the anchor deposit (issue #1136/#1912/#2112).** Immediately after the step-4 fetch, run the "Reflection-source telemetry deposit" recipe in the "Reflection injection — live API" section below — it writes `${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-sources-<task_id>` so `reap.py` can stamp the `reflectionMatchSource` cycle metric, AND `${HYDRA_AUTOPILOT_REFL_DIR:-/tmp}/hydra-refl-anchor-<task_id>` (the anchor `issue-<N>`) so `reap.py` can fire the per-anchor reflection PRODUCER on a non-merged failure (issue #2112 — without this deposit reap's `slot.get("anchor")` is always None and `recordAnchorReflection` is never called, the dead-producer bug). This is NOT optional and NOT conditional on whether reflections were served: ALWAYS run the deposit block (an empty reflection-source result writes no sources file, which `reap.py` correctly buckets to `none`; the anchor deposit is ALWAYS written so a first-failure anchor is recoverable). Skipping it is the #1912/#2112 failure mode where the metric read `'none'` and the reflection store stayed empty on 100% of cycles. The deposit is best-effort on I/O error (never blocks work) but the step itself is mandatory.
5. Greps/reads the source for context
6. Implements the issue — touching out-of-scope files only with a `scope-justification:` block in the PR body
7. **Declares glossary/ADR impact** — per the `docs/agents/domain.md` WRITE contract, add a `Glossary impact:` / `ADR impact:` line to the PR body for any term resolved or decision made (a `## Glossary delta` in the issue or referenced ADR names it). Do **not** edit `CONTEXT.md` in this code PR — the delta lands in a **separate `ubiquitous-language`-labelled PR**.
8. Runs `npm test` + `npm run typecheck` + `npm run build`
9. **Classifies the change via the live tier API (see "Tier classification — live API" below).** Never self-classify by path patterns.
9a. **Reconciles the diff against the design-concept artifact BEFORE opening the PR (issue #2537 — do-not-open-on-unmet-invariant).** If a design-concept artifact was fetched at planning time (step 4 region / "Design-concept artifact — live API" below), run the "Design-concept reconciliation gate" recipe in that section: for EACH invariant, cite the diff hunk that satisfies it; for each MUST-NOT invariant, confirm the diff does not introduce the forbidden behavior. If ANY invariant cannot be satisfied, do **NOT** open the PR — emit a `## Friction Report` naming the unmet invariant and stop. This closes the #2504 gap where the artifact was fetched but Invariant 7 ("MUST NOT fall back to a full scan") was violated anyway — the failure was verification-side, not authoring-side. When no artifact was fetched (404 at planning time), this gate is a clean no-op.
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

**Reflection-source telemetry deposit (issue #1136 / #1912 — MANDATORY, at the
SAME planning-time step — this is child-step 4a above, NOT optional reference
prose):** you MUST run the recipe below on every dispatch, right after the
step-4 reflection fetch, before you start writing code. Omitting it is the
exact #1912 regression where `reflectionMatchSource` read `'none'` on 100% of
cycles because no `hydra-refl-sources-<task_id>` file ever landed for reap.py to
read. So the `reflectionMatchSource` cycle metric reflects what was actually
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

CRITICAL task_id source (issue #1945 — the deposit was landing under the WRONG
key on 100% of cycles). reap reads the deposit at `hydra-refl-sources-<task_id>`
where `<task_id>` is the **harness task id** — the 17-hex-char hash the Claude
Agent tool embeds in your worktree path (`.../worktrees/agent-<HASH>`) and
branch (`worktree-agent-<HASH>`). That hash flows into the slot's `task_id` and
is the only key reap ever reads. The two env vars the old recipe used are both
WRONG in this child dispatch: `HYDRA_AUTOPILOT_TASK_ID` is **unset** inside the
worktree subagent (the harness does not export it), and `CLAUDE_CODE_SESSION_ID`
is the child's session UUID (e.g. `337671f0-…`) — a DIFFERENT id from the
harness hash, so a deposit keyed on it is never found and the metric stays
`'none'`. Derive the hash from your own cwd (`pwd` → `agent-<HASH>`), which is
authoritative and always present; only fall back to the env vars if the cwd is
somehow not an `agent-<HASH>` worktree (e.g. a `/dev/shm` layout).

@include _fragments/reflection-telemetry-deposit.md

**Reading the deposit-presence diagnostic at reap time (issue #2020).** A
`reflectionMatchSource` of `'none'` is ambiguous on its own — it can be an
HONEST none (the dispatch served no reflections, so it correctly wrote no
deposit) or a FALSE none (a deposit existed but the read dropped, the
#1945-shaped hazard). To tell them apart WITHOUT manually scanning the fs /
Redis, `reap.py completion` stamps a `refl_presence=<token>` field onto the
`slot_complete` line it writes to the run log
(`/tmp/hydra-autopilot-nightly.log`):

- `deposit-absent` — no deposit file (the common honest-none case).
- `deposit-empty` — deposit file present but empty/whitespace (still honest
  none; the dispatch ran the deposit step with nothing to write).
- `deposit-present` — deposit file present with a non-empty bucket string (a
  genuinely non-'none' cycle).
- `read-error` — deposit file present but unreadable (a false-none candidate
  worth an operator's eye).
- `no-task-id` — reap had no task_id to key on.

So a window of `100 none` cycles that all read `refl_presence=deposit-absent`
is the expected steady state when `failedRate:0` (no failures → nothing to
learn from → nothing served → nothing deposited). A `read-error` (or a
`deposit-present` that still buckets to 'none') is the signal that the deposit
plumbing — not the empty store — is at fault. The dead legacy global buffer
(`hydra:reflections:buffer`, retired in ADR-0023) is NOT this store and never
feeds the metric; prune its residual runtime key with
`bash scripts/cleanup/retire-reflection-buffer.sh` so it stops looking
populated during a diagnosis.

**Verify reflections-reach-retry with this endpoint, NOT
`/api/learning/context-trace`.** The context-trace endpoint reports
`getContext()`'s *composition* (a prompt no subagent receives on today's
architecture), so a `hit` there is not proof of delivery — `/api/reflections`
is the live path a dispatch actually consumes.

### Knowledge context — live API (issue #2647)

At the **same planning-time seam** as the reflections + design-concept + tier
reads, fetch the agent-scoped **knowledge context** — the learned patterns
(prior-cycle failures, successful tactics) that OpenViking has indexed for your
skill — and weave it into your implementation plan. This is the content the
learning subsystem accumulates across cycles; consulting it at plan time is how
a dispatch benefits from prior-cycle knowledge (before #2647 no skill fetched
it, so `knowledgeContext.cyclesWithContext` read 0% on the health surface).

**Endpoint contract:**

- Method: `GET`
- Path: `/api/learning/knowledge`
- Query:
  - `agent=<skill name>` (required) — your skill name, `hydra-dev`. It scopes
    the OpenViking search to this agent's learned patterns.
- Response (200): `{ agent, content, itemCount }`
  - `content` is prompt-ready markdown (a `# <agent> — Learned Patterns` block).
    `itemCount: 0` / `content: ""` means no knowledge context — a clean no-op.

**Use this route, NOT `/api/learning/context-trace`.** context-trace is a
counts-only diagnostic composer that deliberately omits block `.content`
(#804/#841) — it returns `itemCount`/`contentBytes`, never the prompt text, so
there is nothing to weave into a plan. This route SERVES the content (the same
way `/api/reflections` serves `formatted`) AND records the #1440 per-cycle
availability metric server-side on its success path — so the record can never
desync from an actual served fetch, and you never touch the metric from a shell
block (which the single-quoted PR-body heredoc quoting would make fragile).

**Required child-side recipe (at planning time, before writing code):**

```bash
KB_JSON=$(curl -sf --max-time 5 \
  "http://localhost:4000/api/learning/knowledge?agent=hydra-dev")

KB_CONTENT=$(printf '%s' "$KB_JSON" | jq -r '.content // ""')
if [ -n "$KB_CONTENT" ]; then
  # Prepend KB_CONTENT to your implementation-planning context — these are
  # learned patterns from prior cycles for this agent. Read them and avoid
  # repeating known failures / reuse known-good tactics.
  printf '%s\n' "$KB_CONTENT"
fi
# Empty / unreachable → graceful no-op. Never fail the dispatch over a
# knowledge-context miss; the availability record is server-side and best-effort.
```

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

**Design-concept reconciliation gate (issue #2537 — MANDATORY pre-PR step when
an artifact was fetched).** Fetching the artifact at planning time is not
enough: #2504 fetched it and still violated Invariant 7 ("MUST NOT fall back to
a full scan") because nothing re-checked the *diff* against the invariants
before the PR opened. The gate closes that verification-side gap. Run it as
child-step 9a — AFTER the change is committed and tier-classified, BEFORE
`gh pr create`:

1. Re-read the `invariants` array from the artifact you fetched at planning
   time (read `.invariants` directly — there is NO `.concept` envelope).
2. For EACH invariant, cite the concrete evidence that it holds — the diff
   hunk (`git diff origin/master...HEAD`), the test name, or the command output
   that demonstrates it. For each MUST-NOT / negative invariant, confirm the
   diff does **not** introduce the forbidden behavior.
3. Mirror the existing "verified by:" framing: each invariant pairs with a
   mechanical check, exactly like the acceptance-criteria checkboxes.
4. **If ANY invariant cannot be satisfied, do NOT open the PR.** Emit a
   `## Friction Report` that names the unmet invariant and what blocks it, then
   stop. This is a gate (do-not-open), not a post-hoc report — shipping a PR
   that violates a stated invariant is the #2504 failure mode this step exists
   to catch.
5. When step 4 of planning returned a 404 (no artifact for this anchor), this
   gate is a clean no-op — proceed straight to `gh pr create`.

The reconciliation summary (each invariant + its evidence) SHOULD also be
included in the PR body so QA can re-verify it against the same artifact.

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

**Why GET, not POST `-d @<file>`:** the endpoint at `src/api/tier.ts` is a
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

### Child-prompt EnterWorktree anchor contract (REQUIRED — issue #2371)

Append the following block to every dispatched hydra-dev BG agent prompt, immediately after the PATH ANCHORING block above. It is the sibling rule that resolves the **write-fence-blocks-a-valid-in-worktree-Edit** symptom (#2371; ~16 cross-run hits) — distinct from the #1861 ghost-write symptom the PATH ANCHORING block addresses. Root cause: the native Claude Code harness tracks a single writable-worktree-root *anchor* per agent, and a **redundant** `EnterWorktree` from an agent that is already launch-pinned to its worktree (the `Agent(isolation="worktree")` dispatch case) desyncs that anchor from cwd — so a later, perfectly-valid in-cwd Edit/Write is denied. The custom `worktree-write-fence.sh` hook is NOT the cause here (it is absent from `~/.claude/settings.json`, and even when installed its in-cwd short-circuit ALLOWS a valid in-worktree write); the deny comes from the native anchor desync. The fix is preventive — don't trigger the redundant switch — never the reactive `python3`/`Bash` shell-out (which bypasses the harness's own diff/permission tracking and costs turns every recurrence).

```
## ENTERWORKTREE ANCHOR — do not desync the writable root (issue #2371)

You were dispatched via Agent(isolation="worktree"), so the harness has already
LAUNCH-PINNED your writable-worktree root to your cwd. The harness tracks ONE
writable-root anchor per agent; a redundant or sibling EnterWorktree desyncs
that anchor from your cwd and makes a valid in-cwd Edit/Write get DENIED even
though the write is correct.

RULES:
1. NEVER call EnterWorktree when your launch-time `pwd` already satisfies the
   worktree predicate (i.e. `git rev-parse --git-dir` resolves under
   `.git/worktrees/`). You are already pinned — a redundant switch is exactly
   what breaks the anchor. Verify the predicate; if it holds, proceed straight
   to file ops, NO EnterWorktree.
2. If EnterWorktree WAS genuinely required (your initial pwd failed the
   predicate — a non-pinned dispatch), re-run `pwd` IMMEDIATELY after the switch
   and re-derive EVERY subsequent `file_path` from that fresh post-switch root.
   Never reuse a path captured before the switch.
3. If an in-worktree Edit/Write is STILL denied even though the file resolves
   inside your cwd, the anchor has desynced. RECOVER by re-anchoring:
   `ExitWorktree` then `EnterWorktree` by `path` (the harness's documented
   re-anchor path). Do NOT fall back to writing the file via `python3`/`Bash` —
   that shell-out bypasses the harness diff tracking and is the reactive
   workaround this contract exists to eliminate.
```

> Orthogonal note (issue #1861 / #549 — NOT the #2371 fix): the custom `worktree-write-fence.sh` PreToolUse hook that guards against ghost-writes INTO the main tree is currently *uninstalled* on this host (absent from `~/.claude/settings.json`). Installing it via `scripts/setup-claude-hooks.sh` closes the orthogonal ghost-write-to-main gap, but does NOT resolve the #2371 write-fence-blocks-a-valid-write symptom above (the two share a path-reconciliation root-cause family but have opposite mechanics — one wrongly DENIES a valid write, the other fails to DENY an invalid one). Keep hook installation as a separate operator step; do not conflate it with the EnterWorktree anchor contract.

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
