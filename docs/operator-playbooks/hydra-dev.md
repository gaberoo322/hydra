---
name: hydra-dev
description: Pick up a GitHub issue from gaberoo322/hydra and autonomously implement it in a worktree — research the codebase, implement, verify, and open a PR.
when_to_use: "When the user wants to work on a Hydra orchestrator issue, says 'pick up an issue', 'work on issue #N', 'develop'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) Agent(*)
arguments: [issue_number]
compose_base: _vendor/implement.md
reference_files: [_fragments/hydra-dev-parent-flow.md, _fragments/hydra-dev-child-flow.md]
---

# Hydra Dev

> **Composed skill (ADR-0030).** This playbook is the Hydra AFK overlay on the vendored upstream `implement` base (`compose_base`); `scripts/sync-skills.sh` emits the skill as base plus overlay. The base sets the cadence (implement against the spec, `/tdd` at pre-agreed seams, typecheck and single-file tests as you go, the full suite once at the end, then `/code-review`); the worktree-isolation, verification and PR contract below ride on it. The `dev_orch` class selects this stage.

Autonomous implementation of GitHub issues against the Hydra orchestrator
(`~/hydra`). Delegates to a worktree subagent for isolation.

This skill has two mutually exclusive branches. This SKILL.md body carries only
the branch-detection step, the critical safety rules, and two **context
pointers**. The full step-by-step contract for each branch lives in a sibling
reference file that `scripts/sync-skills.sh` emits next to this SKILL.md — read
the one that matches your branch and follow it end to end.

## Am I the parent or the child? — read FIRST

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
  do NOT re-select or re-label the issue. Its pre-PR mechanical gate (reconcile
  dry-run, baseline regeneration, `npm test` per the "Full `npm test` recipe"
  below plus `npm run typecheck:test`, and the `Merge danger:` field check) is
  mandatory before `gh pr create`.
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
2. All implementation runs inside a worktree: `Agent(isolation: "worktree")`
   (Codex dispatch is retired, ADR-0006).
3. Dirty main tree is fine — worktrees are independent.
4. **No silent fallback.** A dispatched agent that finds itself in `~/hydra`
   instead of a worktree MUST abort.
5. **Tests and baselines:** run them through the npm aliases in CLAUDE.md
   "Common Pitfalls" (`npm run test:file`, `npm run test:debug`, the SUITE-COUNT
   GATE), never a bare `node --test`. The full suite follows the "Full `npm test`
   recipe" below.
6. **NEVER end your session waiting on CI, a monitor, or a background
   process.** The canonical statement is `hydra-autopilot.md`'s "Worktree-guard
   preamble" section, prepended to every `dev_orch` dispatch prompt. Run
   verification in the foreground and emit no final message until a PR is open or
   you report a hard blocker. Reap relabels a `dev_orch` completion that has no
   open PR `needs-dev-resume` (`_handle_dev_orch_stall` in
   `scripts/autopilot/reap.py`), so an early stop re-pays the spent tokens.

@include _fragments/lifecycle-seam-writes.md

@include _fragments/blocked-slice-labelling.md

## Never end a turn on a pending wait

A backgrounded wait is structurally unrecoverable: end the turn while a
verification is pending (a backgrounded `npm test`, a `Monitor`, an `Agent`
spawned with `run_in_background: true`, a backgrounded CI poll) and the result
lands in a session that has already exited. Only an external `SendMessage`
resume gets it back.

**The rule: a turn ends only when the result you were waiting for is in hand
and acted on.** If a result is not ready, either keep waiting in the FOREGROUND
(the full `npm test` follows the "Full `npm test` recipe" below) or post the
partial result you can stand behind now. Never "background it and stop".

**Commit before you verify.** The moment the implementation is structurally
complete — it compiles, the change is whole — `git commit` and `git push`
BEFORE any long verification (`npm test`, CI, a monitor). Then a stall degrades
to "unmerged PR" (the autopilot resumes it next tick) instead of
"staged-but-uncommitted work destroyed by the worktree-orphan-prune".
Verification gates whether the PR merges, not whether the work survives.

**Foreground bounded poll.** When you have pushed and are waiting on CI, or
running any long verification, block in THIS turn. The full `npm test` runs
longer than the Bash foreground cap, so the harness auto-backgrounds a plain
call; run it as below. For a CI wait, poll foreground with the CI loop below.

**Full `npm test` recipe (canonical — other docs point here).** Commit + push
first. Launch ONE Bash call with `run_in_background: true` and an explicit
`timeout: 1800000` (the background default is also 600 s and would kill the run
mid-suite):

```bash
npm test > npm-test.log 2>&1; echo "NPM_TEST_EXIT=$?" >> npm-test.log
```

Then re-issue this FOREGROUND poll (each call under the cap) until the sentinel
appears, within ONE total budget of 30 min. No bare `sleep N`, no `Monitor`, and
never end the turn to wait for the harness notification:

```bash
deadline=$((SECONDS + 540))
until grep -q '^NPM_TEST_EXIT=' npm-test.log || [ "$SECONDS" -ge "$deadline" ]; do sleep 15; done
tail -n 25 npm-test.log
```

Verdict: `NPM_TEST_EXIT=0` AND the launcher's final
`[redis-db-launch] VERDICT exit=<n> outcome=<...>` line agree. `# fail 0` alone
is not sufficient (file-set suite-count verdicts redden a `# fail 0` run).
If the 30 min budget expires with no sentinel, take the partial-but-posted
branch below.

```bash
# BOUNDED FOREGROUND POLL — block in THIS turn until CI on $PR settles. This is
# the foreground alternative to backgrounding the wait and ending the turn.
#
# zsh: never name a loop variable `status` (CLAUDE.md "Common Pitfalls").
#
# Guard-compatible form: the worktree-isolation Bash guard refuses a clock-budgeted
# `while [ "$SECONDS" -lt "$deadline" ]` loop and a multi-line `--jq` program inside
# a loop, so the budget is a fixed iteration count and the probe is
# `gh pr checks | cut -f2 | grep -cx pending`.
pending=unknown                        # stays "unknown" if gh never answers: never read as terminal
for i in $(seq 1 40); do               # 40 x 15s = 10-min budget; size to your slowest check
  checks=$(gh pr checks "$PR" --repo "$REPO" 2>/dev/null)
  if [ -z "$checks" ]; then sleep 15; continue; fi   # gh error / rate limit / no checks yet: keep polling (fail closed)
  pending=$(printf '%s\n' "$checks" | cut -f2 | grep -cx pending)   # state column only (pass|fail|pending|skipping|cancel)
  if [ "$pending" = 0 ]; then break; fi
  sleep 15
done
gh pr checks "$PR" --repo "$REPO"      # read the terminal conclusions
# pending == 0  => every check is terminal: read conclusions and act
#                  (merge on success, fix on failure).
# pending != 0 after the last iteration => budget expired: fall through to the
#                            partial-but-posted branch below — post what you can
#                            stand behind now, with CI state as of the last poll.
#                            NEVER re-arm the loop; one TOTAL budget per wait (the npm test poll
#                            above is re-issued across <=540s calls).
```

**Prefer a partial-but-posted result over a pending one.** If the budget
expires, do not leave the work unshipped: push the branch / open the PR with
the verification state recorded as of the last poll and a one-line note on what
is still pending. A partial result the autopilot can resume beats a pending one
only an external resume can finish.

## Slot lifecycle events — PostToolUse hook

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
