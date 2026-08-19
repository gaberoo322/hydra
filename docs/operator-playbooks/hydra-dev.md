---
name: hydra-dev
description: Pick up a GitHub issue from gaberoo322/hydra and autonomously implement it in a worktree — research the codebase, implement, verify, and open a PR.
when_to_use: "When the user wants to work on a Hydra orchestrator issue, says 'pick up an issue', 'work on issue #N', 'develop'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
claude_only: true
compose_base: _vendor/implement.md
reference_files: [_fragments/hydra-dev-parent-flow.md, _fragments/hydra-dev-child-flow.md]
---

# Hydra Dev

> **Composed skill (ADR-0030 Decision 2 / Option C, issue #3422).** This playbook is the thin Hydra **AFK overlay** on top of the vendored upstream `implement` base (`docs/operator-playbooks/_vendor/implement.md`). `scripts/sync-skills.sh` emits `~/.claude/skills/hydra-dev/SKILL.md` as **[upstream implement base] + [this overlay]**, with the vendored base's `disable-model-invocation: true` **stripped** (it hard-errors under Skill-tool dispatch). The **implement** stage of the one-lineage spine dispatches the *same* upstream skill the operator runs, in AFK mode: the upstream base sets the spirit (implement against the spec/tickets, use `/tdd` at pre-agreed seams, typecheck + single-file tests as you go, the full suite once at the end, then `/code-review`), and the worktree-isolation, verification-depth, and PR contract below are the Hydra-specific overlay that rides on it. **Contract complete (ADR-0030 Decision 5, epsilon #3424):** the standalone `hydra-dev` *fork identity* is retired as a documented concept — this is no longer a bespoke fork that re-implements `implement` inline, it **is** the composed `implement` stage. The `dev_orch` dispatch *class* and its `decide.py` `make_dispatch(…, "hydra-dev")` string literal stay live (they select this composed stage; the delta slice #3423 already migrated the learning-loop seams), but "hydra-dev the fork" no longer names a second inline copy of the pattern — a change to `implement` behaviour is made once, in the composed upstream base + this overlay.

Autonomous implementation of GitHub issues against the Hydra orchestrator
(`~/hydra`). Delegates to a worktree subagent for isolation.

This skill has two mutually exclusive branches. This SKILL.md body carries only
the branch-detection step, the critical safety rules, and two **context
pointers**. The full step-by-step contract for each branch lives in a sibling
reference file that `scripts/sync-skills.sh` emits next to this SKILL.md — read
the one that matches your branch and follow it end to end.

## Am I the parent or the child? — read FIRST (issue #1900)

This skill runs in one of two roles. Decide which BEFORE any work:

- **You are the CHILD** if you were dispatched into a fresh worktree (cwd under
  `/dev/shm/hydra-worktrees/`, `/home/gabe/hydra-worktrees/`, or
  `/home/gabe/hydra/.claude/worktrees/`, with `git rev-parse --git-dir` under
  `.git/worktrees/`) and you have NO `Agent`/`Task` spawn tool. This is the
  `hydra-autopilot` inline-dispatch case. The dispatcher already named your
  issue, prepended the worktree-guard / path-anchoring / scope-respect
  preambles, and placed you in the worktree. **Skip the parent Pre-flight and
  the spawn step — they were already done for you.**
  → **CONTEXT POINTER: read `hydra-dev-child-flow.md` (sibling of this SKILL.md)
  and run its numbered child execution contract.** Do NOT spawn another agent;
  do NOT re-select or re-label the issue.
- **You are the PARENT** if you have an `Agent`/`Task` spawn tool available (or
  are being run interactively by the operator to dispatch work).
  → **CONTEXT POINTER: read `hydra-dev-parent-flow.md` (sibling of this
  SKILL.md)** and run it top to bottom: Pre-flight → Spawn worktree agent →
  Post-agent reaping.

If unsure whether a spawn tool exists, make exactly ONE `ToolSearch` query
(e.g. `+agent spawn task`) against the deferred-tool list, then commit to a mode
— do not retry, and do not assume availability either way. The dispatch
environment never grows the tool mid-session, so an absent spawn tool means: you
are the child, proceed inline. Never abort merely because the spawn tool is
absent, and never silently run the child steps without first recognising you are
the child.

## Critical safety rules

These are load-bearing and stay in the SKILL.md body — they must be readable
without following any context pointer, because branch mis-detection and
worktree-fence violations are safety failures.

1. **NEVER run `git stash`/`checkout`/`reset`/`clean` on the main `~/hydra`
   working tree.** The operator may have uncommitted work.
2. All implementation runs inside a worktree — Claude:
   `Agent(isolation: "worktree")`; Codex: `codex exec` in a fresh
   `git worktree add`.
3. Dirty main tree is fine — worktrees are independent.
4. **No silent fallback.** If the dispatched BG agent finds itself in `~/hydra`
   instead of a worktree, it MUST abort. Falling back to `~/hydra` left the main
   checkout on a feature branch on 2026-05-11 and stalled deploys for ~30 min
   (incident: PR #245).
5. **Run tests via `npm test`, or pass `--test-force-exit` for a single file.
   NEVER run a bare `node --test <file>`.** Orchestrator modules open a
   long-lived `ioredis` connection and a scheduler `setTimeout`, so `node:test`
   keeps the event loop alive and **hangs forever** after the assertions pass.
   A hung test blocks the Bash tool call, which froze a whole autopilot session
   for 11h (2026-05-28). `npm test` already includes `--test-force-exit`; for a
   subset use `node --test --test-force-exit <file>`.
6. **To identify *which* test failed in one run, use `npm run test:debug` —
   never re-run + grep (issue #1076).** The default reporter buffers stdout and
   `--test-force-exit` tears the process down before the per-test `not ok`
   diagnostic lines flush. `test:debug` runs the identical flags plus a dual
   reporter (`tap → test-debug.tap`); read the `not ok` lines out of
   `test-debug.tap`. The artifact is git-ignored. Do **not** edit the `test`
   script — it declares the run to be the whole suite (`HYDRA_FULL_SUITE=1`),
   which is what arms the file-set coverage gate (issue #4141).
7. **NEVER end your session waiting on CI, a monitor, or a background
   process (issue #3866).** The full rule lives ONCE, canonically, in
   `hydra-autopilot.md`'s "Worktree-guard preamble" section — it is prepended
   verbatim to every `dev_orch` dispatch prompt, so you receive it at dispatch
   time regardless of this pointer. Restated here only as a cross-reference
   (not duplicated, to avoid drift): run verification **in the foreground**
   (rule 5 above) and don't emit a final message until a PR is open or you are
   reporting a hard blocker. The observed failure (#3726): dev_orch did ~9.5
   min of real implementation, backgrounded `npm test`, then stopped talking
   instead of finishing — no PR existed at reap time, and the tokens already
   spent were silently re-paid by a from-scratch redispatch. (Reap-side
   backstop for when the rule is still violated: a `dev_orch` completion with
   no open PR referencing its anchor is now detected and relabelled
   `needs-dev-resume` instead of being silently redispatched from zero — see
   `scripts/autopilot/reap.py`'s `_handle_dev_orch_stall`.)

## Never end a turn on a pending wait (issue #3953)

A backgrounded wait is **structurally unrecoverable**. End the turn while a
verification is still pending — a backgrounded `npm test`, a `Monitor`, an
`Agent`/reviewer spawned with `run_in_background: true`, a backgrounded CI
poll — and the result is delivered to a session that has already exited. The
only path back to it is an external `SendMessage` resume. In autopilot run
`028f420d` (2026-08-11) **3 of 3** code-writing/QA dispatches ended exactly
this way and each needed an operator resume; the `dev_orch` one had its changes
**staged but uncommitted**, minutes from the hourly worktree-orphan-prune that
would have destroyed them.

**The rule: a turn ends only when the result you were waiting for is in hand
and acted on.** If a result is not ready, either (a) keep waiting in the
FOREGROUND — let the Bash call block, or poll in a bounded `while` loop in THIS
turn — or (b) post the partial result you can stand behind now. Do not pick a
third option of "background it and stop". This generalises `hydra-qa`'s
blocking-dispatch mandate (`run_in_background: false` on every spawn) to every
backgrounding mechanism a dev dispatch can reach.

**Commit before you verify.** The moment the implementation is structurally
complete — it compiles, the change is whole — `git commit` and `git push`
BEFORE any long verification (`npm test`, CI, a monitor). Then a stall degrades
to "unmerged PR" (the autopilot resumes it next tick) instead of
"staged-but-uncommitted work destroyed by the worktree-orphan-prune".
Verification gates whether the PR merges, not whether the work survives.

**Foreground bounded poll.** When you have pushed and are waiting on CI — or
running any long verification — block in THIS turn; never background it and
stop. A test run via the Bash tool already blocks, so just let it; for a CI
wait, poll foreground with a bounded loop:

```bash
# BOUNDED FOREGROUND POLL — block in THIS turn until CI on $PR settles. This is
# the foreground alternative to backgrounding the wait and ending the turn.
#
# zsh $status pitfall: name the state variable `run_state` (or `st`), never
# `status` — zsh aliases `$status` to `$?`, so assigning a value to a variable
# named `status` silently fails and the loop exits 1. `status` is the natural
# spelling of this variable; that is exactly why the loop breaks. (Documented
# CLAUDE.md pitfall.)
deadline=$((SECONDS + 600))            # 10-min budget; size to your slowest check
while [ "$SECONDS" -lt "$deadline" ]; do
  run_state=$(gh pr view "$PR" --repo "$REPO" --json statusCheckRollup \
    --jq 'if ([.statusCheckRollup[]?.status]
           | any(IN("QUEUED","IN_PROGRESS","PENDING","WAITING")))
          then "pending" else "settled" end' 2>/dev/null)
  [ "$run_state" = "settled" ] && break
  sleep 15
done
# run_state == "settled"  => every check is terminal: read conclusions and act
#                            (merge on success, fix on failure).
# still "pending" past the deadline => budget expired: fall through to the
#                            partial-but-posted branch below — post what you can
#                            stand behind now, with CI state as of the last poll.
#                            NEVER re-arm the loop; one bounded budget per wait.
```

**Prefer a partial-but-posted result over a pending one.** If the budget
expires, do not leave the work unshipped: push the branch / open the PR with
the verification state recorded as of the last poll and a one-line note on what
is still pending. A partial result the autopilot can resume beats a pending one
only an external resume can finish.

## Slot lifecycle events — PostToolUse hook (issue #671)

Every tool call inside this skill emits a `subagent_tool_call` event onto the
Redis stream `hydra:autopilot:slot-events`, classified at emit-time so the
/now-pixel dashboard can route on `category`:

- `milestone` — Write, Edit, MultiEdit, NotebookEdit, MCP write surfaces, and
  Bash matching `^(git commit|gh pr|npm test|npm run build|npm run typecheck)`
- `io` — other Bash, WebFetch, WebSearch, MCP read surfaces
- `background` — Read, Grep, Glob

Hook script: `scripts/autopilot/hooks/on-subagent-tool-call.sh`. Registration:
sibling `<this-playbook>.settings.json` → `~/.claude/skills/<this-skill>/.claude/settings.json`
(propagated by `scripts/sync-skills.sh`). The hook MUST NEVER propagate errors
back to this session — a Redis outage, a malformed payload, or a missing `jq`
all result in a stderr warning and `exit 0`. See
`test/on-subagent-tool-call.test.mts` for the pinned behavior.
