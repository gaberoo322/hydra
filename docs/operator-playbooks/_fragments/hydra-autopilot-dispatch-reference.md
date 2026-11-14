# hydra-autopilot — Dispatch reference

Class-by-class dispatch detail that the always-loaded SKILL.md points to: what
each class dispatches, the protocols a few classes carry in their dispatch
prompt, and why the dispatch preambles are worded as they are. Read the section a
pointer names, not the whole file. The authoritative source for dispatch policy
is `scripts/autopilot/decide.py`.

## Class taxonomy (7 pipeline slots + 15 signal classes)

The class-to-skill table is data, not prose. Every row (class, skill, stage,
model, ticket-type routing, cooldown, scope and the per-class rationale in its
`notes` column) lives in `scripts/autopilot/classes.json`, rendered at
`docs/generated/classes.json` (`/docs/cat/classes` on the dashboard). Read a
class's row there; this fragment keeps no copy that could drift.

> **One-lineage stage bindings (ADR-0030 Decision 2; ADR-0035 supersedes the spec-stage base).** The three code-writing pipeline stages compose against the same vendored upstream Pocock skills the operator runs interactively (lineage home `docs/operator-playbooks/_vendor/`, ADR-0030 Decision 4 / Option C): the **implement** stage (`dev_orch` → `hydra-dev`) rides `_vendor/implement.md`, the **review** stage (`qa_orch` → `hydra-qa`) rides `_vendor/code-review.md`, and the **spec** stage (`design_concept_orch` → `hydra-grill`) composes on no upstream base. The `decide.py` `make_dispatch` string literals (`hydra-dev` / `hydra-qa` / `hydra-grill`) are the class rows that select these composed stages, not a second inline copy of the pattern. Grill-before-build sequencing yields per-anchor, through the `orch_dev_ready_anchor` Turn Snapshot signal, and that gate lives in `decide.py`.

## Model routing rationale

The routing data (class to model) is the `model` column of
`scripts/autopilot/classes.json`. This section is the reasoning behind it.

Routing is right-sized by **stakes × frequency**: high-frequency non-authoring
classes run under the frontier model, and behaviour-reshaping and money-critical
authoring classes run on Fable 5, the frontier model, when Fable is entitled.
Verify entitlement with a throwaway `Agent(model="fable")` smoke test before
re-promoting any class.

`dev_orch` runs on Sonnet on evidence: the GLM dev-drainer (ADR-0032) authored
CI-green PRs on a model weaker than Sonnet, which is direct evidence that Sonnet clears
this repo's `dev_orch` bar. `dev_target` does not inherit that, because the
drainer is fenced off the Target board and money-critical authoring was never
measured there.

| Class (`slot`) | Rationale |
|---|---|
| `dev_orch` | Multi-file, tier-gated self-modification, measured on the GLM drainer evidence (see Model routing rationale intro). An `ESCALATION_POLICY` row re-dispatches a `subagent_failure` once at frontier, so a capability miss self-rescues. `qa_orch` and CI are the backstop. |
| `dev_target` | Money-critical authoring; frontier until evidence supports a demotion. |
| `retro_orch` | Reshapes future behaviour; low volume per run. |
| `design_concept_orch` | A weak design concept wastes a full dev and QA cycle downstream; low volume. |
| `qa_orch` | Highest ROI: structured review against an artifact on nearly every PR. |
| `qa_target` | Money-critical review, the last judgment before auto-merge on real-money code. Sonnet is the hard floor if cost forces a demotion. |
| `sweep_orch` / `sweep_target` | Board-routing decisions, not authorship. |
| `health` | Structured diagnosis; rare small fixes. |
| `research_orch` | Bounded codebase and web enrichment, not design. |
| `research_target` | Strategic; watch priority quality and revert on drift. |
| `architecture_orch` | Non-interactive Explore-and-emit wrapper. |
| `scout_orch` | Search plus rubric scoring; low frequency, modest ROI. |
| `cleanup_orch` | Deterministic knip output; the LLM only formats findings into issues. |
| `cleanup_target` | Deterministic knip output plus a tested emit runner; the LLM only drives the two commands. |
| `wire_or_retire_target` | Judgment work: recover a module's intent (git archaeology plus vision, priorities and backlog cross-reference) and decide WIRE, RETIRE or UNCLEAR. A low tier hits the Haiku premature-exit failure mode (narrates "standing by", files nothing), so `model` is omitted and the class inherits the parent. |
| `design_qa_target` | Visual judgment work: grade every route's screenshot against the Target design ADR's judgment rules. It is an opinion, not a deterministic check, so `model` is omitted and the class inherits the parent, avoiding the Haiku premature-exit failure mode. |
| `discover_orch` / `discover_target` | Patrol and diagnostics, designed small, fast and cheap. |
| `wayfinder_orch` | Works a wayfinder-map frontier ticket (research enrichment or a `wayfinder:task` build): real authoring and judgment on a foggy initiative. `model` is omitted, so the class inherits the parent and avoids the Haiku premature-exit failure mode. |

## Dispatch Intent vs prompt_args

A bespoke pipeline slot's dispatch is described by its **Dispatch Intent**
(`action.intent`; the closed kinds are in `decide_base.py`). `render-dispatch.py`
renders it and refuses a bespoke action that carries no intent. `prompt_args` is
the **signal classes'** argument bag only; the escalation keys (`escalate_model`,
`attempt`, `prior_attempt_status`) ride `prompt_args` on every class.

## Cascade-routing escalation

SKILL.md § Per-class model routing carries the three mandatory steps and the
deposit command. This section is the reasoning behind them.

**Escalation override.** When a `dispatch` action carries
`prompt_args.escalate_model` (a model alias such as `sonnet`), that value
overrides the static per-class model for that ONE dispatch: pass
`model=action.prompt_args.escalate_model` to the `Agent` call. `decide.py`
re-dispatches a cheap-tier class that just `no_op`'d or failed at a stronger tier,
and stays pure: it emits only the `escalate_model` hint, never a concrete `model`
field, because the model lever lives in the playbook. The escalation action also
carries `prompt_args.attempt`. **Stamp it onto the new slot
(`slot["attempt"] = action.prompt_args.attempt`; `stamp-slot.py` reads it off the
plan action)** so a later `no_op` of the escalation attempt reads
`attempt >= max_attempts` in `decide_escalation` and never triggers a third
dispatch (the `ESCALATION_POLICY` max-attempts cap). `prompt_args.prior_attempt_status`
records what triggered the escalation, for turn-journal visibility. A dispatch
without an `escalate_model` key uses the static routing unchanged. The policy and
reducer live in `ESCALATION_POLICY` (`decide_base.py`) and `decide_escalation`
(`decide.py`); a class absent from that dict never escalates.

**MANDATORY — deposit the escalation provenance.** The moment you execute a
`dispatch` action carrying `prompt_args.escalate_model`, deposit the provenance so
`scripts/autopilot/reap.py`'s `_read_escalation_deposit` can read it back and
forward it on the single cycle-record write. Without the deposit,
`escalationAttempt` and `escalatedModel` stay null on the durable per-dispatch
outcome record and `/metrics/cascade-routing` reports a structural zero cost-delta
and zero postEscalationMergeRate. Unlike the reflection and grounding deposits
(written by the worktree subagent from its own `agent-<HASH>` cwd), the
escalation provenance is known only to the parent at dispatch time, so pass the
escalated dispatch's **task_id explicitly**: the slot `task_id` you just
allocated, the `worktree-agent-<HASH>` suffix `reap.py` keys the completion on.
Run the SKILL.md deposit command BEFORE, or right alongside, the `Agent(...)`
dispatch.

The helper writes `hydra-escalation-<task_id>` only when the provenance is
well-formed (a positive `attempt` and a non-empty model), so a malformed
invocation cannot fabricate an escalation marker. A non-escalated dispatch never
runs it, and reap then omits the fields as a truthful null.

## dev_orch resume internals

How a `dev_orch` anchor that ended without a PR is caught, queued and
re-dispatched. The dispatch-time rules (name the pinned issue, say it is a resume,
carry the forward-fix contract) are in SKILL.md § `dev_orch` dispatch.

**Reap-side backstop.** `scripts/autopilot/reap.py`'s `_handle_dev_orch_stall`
runs from every `dev_orch` completion reap and checks whether an open PR
references the completion's anchor, through the same `pr-refs.py` predicate
`recover-stale.sh` uses. With no open PR, the source issue moves away from
`ready-for-agent` and `in-progress` to `needs-dev-resume`, an explanatory comment
is posted, and a resume record is queued onto `state.dev_resume_pending` for the
drain. It is the backstop for the forbidden-ending rule (see the Worktree-guard
preamble section in SKILL.md): it limits the blast radius of a dispatch that ends
without a PR, and does not make ending early acceptable. The check fails OPEN (no
mutation) on any `gh` hiccup, so a transient network error never mislabels a
healthy in-flight anchor.

**Durable dev resume.** `/tmp/hydra-autopilot-state.json` is a cache, so the
resume path does not depend on it surviving. Four mechanisms:

1. **The kill itself.** `scripts/systemd/hydra-autopilot.service` sets
   `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. Print mode waits at most that long for
   background tasks after the parent's handoff turn, then terminates the process
   and every in-process background child with it. At the harness default no
   code-writing child reaches its commit step. The value is COUPLED to
   `decide.py`'s silent-wedge cap (`subagent_max_wall_seconds`): change one,
   change both. Never `0`: a wedged child would pin the unit to `RuntimeMaxSec`,
   and `bootstrap.sh`'s live-pid guard would refuse every Pace Gate launch.
2. **The queue survives a relaunch.** `bootstrap.sh` carries the prior state
   file's `dev_resume_pending` forward (dedup by anchor, FIFO capped; a missing or
   unparseable prior file seeds `[]`).
3. **The label and PR ledger are the source of truth.** The Turn Snapshot emits
   `orch_dev_resume_pick` (issue N, PR P, branch B) for the lowest-numbered open,
   non-draft, not-`ready-for-human` PR of ANY provenance whose single closing
   issue carries `needs-dev-resume`, OR that is red on a required check
   (quiescent, with no required check pending; it fails closed to `none`). The
   `dev_orch` selector pins it AFTER the in-state drain, regardless of
   `orch_work_available`, of whether `dev_resume_pending` holds a record, or of
   which run queued it. The action carries a `ForwardFixRed` intent (anchor, PR,
   branch), so the forward-fix dispatch contract in SKILL.md applies verbatim:
   continue the PR's head, push to the SAME branch, NEVER `gh pr create`. Only the
   red-CI arm (`orch_prs_red_resume`) is capped, by the seam's `red-ci-forward-fix`
   Live Cap. Reap's needs-qa promotion clears the label.
4. **The label alone covers the no-PR case.** A `needs-dev-resume` issue with no
   open PR referencing it is invisible to mechanism 3, which keys off an open PR.
   The Turn Snapshot's `orch_dev_resume_nopr_anchor` is an anchor, not a pin (no
   PR, branch or head exists to name): the lowest-numbered `needs-dev-resume`
   issue that no open PR references (head-branch or body, drafts included), that
   is not `in-progress` or `ready-for-human`, and that has been quiescent for the
   pr-gate window (`HYDRA_ORCH_DEV_RESUME_NOPR_QUIESCENCE_SECONDS`). It derives
   from the same single needs-dev-resume `gh` read mechanism 3 uses, and fails
   closed to `none` on any unusable input. The `dev_orch` selector pins it
   immediately AFTER the in-state drain and BEFORE the PR-keyed pins, with a
   `ResumeSalvage` intent for `issue-<N>`; with no branch to continue, the
   dispatch prompt reads the issue's own comments for the last reap stall's
   `**Branch:**` line. No state key caps it: the durable cap is the lifecycle
   seam's `dev-nopr-resume` Live Cap, counted from `claim-closed outcome=no-pr`
   journal entries and enforced at the NEXT resume claim, where the seam parks the
   issue. `_handle_dev_orch_stall` adds no park of its own, and the
   `in-progress -> needs-dev-resume` edge carries no cap; it only skips the comment
   and resume when an advance is refused for another reason (`parked:*`,
   from-mismatch, write-failed).

On the disk side, `scripts/branch-prune.sh` is the only deleter of
`.claude/worktrees/agent-*`, and it never removes a worktree holding uncommitted
work without first committing it on the worktree's own `worktree-agent-<hash>`
branch and pushing that branch to origin. A failed push leaves the worktree in
place (`skip-dirty-unpushed`). A resume's `git ls-remote origin <resume_branch>`
therefore finds salvaged work under the name the ledger already carries.

## Ordering the unpinned pick — why the ranking lives in the prompt

Unpinned self-selection is `gh issue list --label ready-for-agent … | .[0]`,
which takes whatever the API returns first and is not a priority order. No
numeric priority dial exists in the loop to consult: `classes.json` carries only
`cooldownSeconds` (a cadence dial), the Turn Snapshot counts `ready_for_agent`
without ordering it, and `config/orchestrator/vision.md` is read by no loop code.
The standing work ranking is therefore applied in the dispatch prompt, the way
`hydra-sweep` carries "pick highest unblock count first, NOT oldest".

## wayfinder_orch — claim, saturation guards, resolution protocol

SKILL.md § `wayfinder_orch` dispatch carries the ticket-type to skill override
and the claim command. This section is the rest of the protocol, and the dispatch
prompt must carry the claim and the resolution protocol.

The claim is the load-bearing mechanism for BOTH saturation guards. An open,
AFK-typed ticket that is *assigned* is an in-flight worker: the Turn Snapshot
`wayfinder-frontier` collector counts assigned tickets into
`wayfinder_orch_inflight_global` (the global-cap input `decide.py` reads), and its
frontier query skips assigned tickets (`assignees.totalCount==0`), so a claimed
ticket is never re-picked. **Skipping the claim makes both guards inert**: the
in-flight counter reads 0 forever and the same frontier ticket can be dispatched
twice. The claim is step 0 of every `wayfinder_orch` dispatch.

**Saturation guards (ADR-0029 Decision 2).** Two bounds cap concurrency, both
anchored on the claim:

- **Global cap.** The `wayfinder-frontier` collector counts open, assigned,
  AFK-typed tickets across every approved map into `wayfinder_orch_inflight_global`,
  and `decide.py` suppresses a new `wayfinder_orch` dispatch when that counter
  reaches the global cap constant in `decide.py`. It applies frontier first, then
  the cap, reading only the pre-resolved counter with no network call.
- **Per-map single-flight.** At most one worker is in flight per map, enforced
  structurally in the collector: a map that already has an in-flight (assigned)
  AFK ticket yields no new frontier pick that tick, so a second worker never
  starts on the same map even when two of its tickets are unblocked and
  unassigned.

HITL-typed tickets (`wayfinder:grilling`, `wayfinder:prototype`) are never counted
and never dispatched here. They surface only in the hydra-review HITL bucket and
resolve through `/wayfinder`.

**Resolution protocol.** Before the ticket counts as resolved, the dispatched
worker records the outcome on the map:

1. Post a **resolution comment** on the frontier ticket summarising the verdict,
   PR or findings (`gh issue comment <N> --body '…'`).
2. **Close** the ticket (`gh issue close <N>`). A `task` ticket closes when its PR
   merges; a `research` ticket closes once its enrichment lands.
3. **Append to the map's `## Decisions so far`** section (edit the map issue body)
   so the map's running ledger reflects the newly cleared frontier, and the next
   Turn Snapshot surfaces the NEXT unblocked frontier ticket.

The class cooldown means one frontier ticket per fire. The map is worked one
cleared ticket at a time across ticks until its frontier is empty (all AFK
tickets closed), at which point `wayfinder_orch_frontier` reads `none` and the
class idles until a new map or a newly unblocked ticket appears.

## Fable fallbacks

SKILL.md carries the rule (re-dispatch the identical action on `opus` the same
turn). This section covers the two causes.

**Fable unavailable: model-access error.** The `fable` alias is not entitled in
every environment. A background `Agent(model="fable", …)` dispatch can die in
under a second with *"There's an issue with the selected model (claude-fable-5) …
it may not exist or you may not have access to it"* (0 tokens, 0 tool uses). When
a `fable`-routed dispatch terminates immediately this way, `decide.py` re-dispatches
the identical action with `escalate_model: opus` in the same plan, so the class is
never left unrun and the parent does not detect it. This applies to the
`inherit-parent` classes (`wire_or_retire_target`, `design_qa_target`,
`wayfinder_orch`) when the parent session's saved default is Fable, and to
`dev_orch`'s `escalate_model` hint. If the fallback becomes the steady state,
every such dispatch silently pays Opus prices: demote the class instead. **Before
re-promoting any class to Fable, verify entitlement returned** with a throwaway
`Agent(model="fable", …)` smoke test that does not die in under a second with the
model-access error. Time alone does not fix it.

**Fable out of weekly usage credits.** The same immediate-death shape has a second
cause with a different fix. Fable's weekly allowance runs out BEFORE the
account-wide limit, and the CLI then exits 1 with *"You're out of usage credits.
Switch to another model, …"*. That is a quota 429, not a model-access error, and
the CLI's own `--fallback-model` does NOT catch it. When a `fable`-routed
dispatch, or the parent session itself, dies with that notice:

1. **The flag is armed for you** for an in-run subagent death: the instant-death
   `reap` action carries the notice and `reap.py` POSTs it. The manual command,
   for a death no reap saw:

   ```bash
   curl -sf --max-time 5 -X POST -H 'content-type: application/json' \
     -d '{"line":"out of usage credits"}' \
     http://localhost:4000/api/usage/session-block
   ```

   The server classifies the kind (`out-of-credits`) and arms the MODEL-SCOPED
   exhaustion flag, surfaced as `.reasons.fableExhaustedUntil` with a TTL bounded
   by the next Weekly Reset Anchor boundary. It is never a session block. On a
   parent-session death the ExecStopPost reap posts this automatically
   (`bootstrap.sh` greps the journal); post it yourself only for an in-run
   subagent death.
2. **The opus replay** is emitted by `decide.py` the SAME turn, at most once per
   original dispatch. Do not leave the class unrun.
3. Apply the pre-resolution rule (SKILL.md § Per-class model routing) for the rest
   of the turn; the next Turn Snapshot reads the armed flag either way.

The flag self-clears by TTL: the pace-gate tick after expiry launches the parent
on Fable again and logs `model-fallback: opus->fable reason=flag-expired`. Verify
Fable is back before assuming time alone fixed it; the post-expiry probe is cheap
(a 0-token 429 in under half a second re-arms the flag).

## qa_target — builder-in-flight hold

Before the selector runs, `decide.py` checks whether the pre-resolved needs-qa PR
was opened by the `dev_target` dispatch that is STILL RUNNING (its builder can
still push fix-up commits, moving the head a review would start against). The
join is by dispatch-token identity, not inference: `target_needs_qa_pr_head` (the
PR's `head.ref`, pre-resolved by the Turn Snapshot `target-board` collector) is
compared against the live `state.slots.dev_target` slot's own dispatch token
(`worktreeBranch`, then `dispatch_id`, then `task_id`, whichever first resolves a
`<run8>-t<N>-dev_target`-shaped value). A match holds `qa_target` for this turn
with one `idle` dispatch_decision naming the PR plus `debug.qa_target_builder_inflight`,
and the next turn re-resolves once the slot clears. A non-token-shaped slot, an
absent or empty head, or a mismatch fails OPEN: `qa_target` dispatches as normal,
so the guard never dead-arms the class.

## Preamble rationale

The verbatim preamble blocks, and the rule for which class carries which, are in
SKILL.md § Worktree-guard preamble. The sections here give the reasoning behind
those blocks.

### The companion write-fence

The preamble catches cwd-confusion. The companion guard is the PreToolUse
**worktree-write-fence**, which catches the subtler failure: cwd is correct, but
an `Edit`, `Write` or `MultiEdit` call passes a `file_path` that resolves outside
the worktree. Operators install it once with `bash scripts/setup-claude-hooks.sh`;
the hook source of truth is `scripts/claude-hooks/worktree-write-fence.sh`. When
active, it denies any out-of-worktree write from a worktree-cwd session and the
agent must self-correct. `scripts/audit-ghost-writes.py` walks the JSONL
transcript history to quantify ghost-write incidents across past dispatches.

### Why the `dev_orch` block bans delegation and backgrounded waits

A `dev_orch` dispatch that spawns a nested `Agent(run_in_background=true)` to run
the whole skill invocation and then ends its turn to wait for the completion
notification satisfies the letter of "poll to a terminal state in the FOREGROUND"
while violating its spirit, because a background child does not keep the parent
session alive. The cost is a full dispatch of tokens for zero deliverable, plus a
race between the still-live child and the no-PR-stall backstop it triggers.

The same hazard covers a `dev_orch` dispatch that backgrounds `npm test` and ends
its session waiting on the run: no PR exists at reap time, and the tokens already
spent are re-paid by a from-scratch redispatch. The `dev_orch` no-PR-stall
backstop catches this at reap time, and exists to limit the blast radius of the
failure mode, not to make it acceptable.

**The full `npm test` is the one sanctioned background launch (#5180).** The suite
outlasts the Bash tool's foreground cap, so a plain call is auto-backgrounded
anyway. The ban forbids *ending the turn* on a pending wait, not the launch: run
it per the canonical recipe in `hydra-dev.md` ("Full `npm test` recipe":
`run_in_background: true`, an explicit `timeout`, a sentinel line, foreground
bounded polls) and keep the turn alive until `NPM_TEST_EXIT=` appears.

### Why `dev_target` has its own variant

**`dev_target` dispatches carry their OWN forbidden-ending preamble variant,
additive to the self-isolation worktree-guard variant and never a replacement for
it.** Append it verbatim, immediately after the self-isolation worktree-guard
variant, for every `dev_target` dispatch; the other self-isolated classes carry no
delegated-mode child, so the variant is `dev_target`-only. Unlike the `dev_orch`
block, this variant does NOT ban the Agent tool outright. `hydra-target-build`'s
own contract requires spawning a delegated build child for context-window
protection, and a flat ban would recreate the degradation observed when the flat
block once applied to `qa_orch`: the dispatch skipped its Standards and Spec
Agent fan-out and reviewed both axes inline as one reviewer. What the variant
forbids is going quiet while that delegated child is still running. A `dev_target`
dispatch that spawned a nested `Agent(run_in_background=true)`, said "I'll relay
its summary once it completes" and ended its turn with zero deliverable is the
failure it closes, as is the recurrence where an armed Monitor re-fired, the
dispatch re-armed it and quit again, and a follow-on self-report claimed a push
and a merge that had not happened.

### Self-isolated classes

Whether a dispatch is launched with `isolation="worktree"` is data, not prose:
`decide.py` stamps `action.isolation` on every dispatch from its
`TARGET_ISOLATION` policy (validated at import to cover exactly every Target-scope
class), and the `dispatch` action-to-tool entry reads that field, so no class name
is hardcoded as the exception. The harness's worktree isolation covers only the
orchestrator repo (`~/hydra`). The Target workspace (`$TARGET_WS`, resolved by
`_fragments/target-seam-preamble.md`) is a sibling repo, so a pinned session can
READ it but is refused every git mutation and file write inside it. That made
`hydra-target-build` Step 0.6 (`git -C "$TARGET_WS" worktree add …`) fail
categorically and hard-aborted `cleanup_target` on its fetch and ff-merge. The
rule: a Target-scope class is `self` iff its playbook mutates the Target tree;
pure readers keep `worktree`. `dev_target` is `self` because Step 0.6 runs
`git worktree add` in the Target. Read each class's verdict in `TARGET_ISOLATION`
(`decide.py`) or the `isolation` field of the plan action; `health` is
orchestrator ops (scope both) and keeps `worktree`.

A self-isolated class relies solely on the Target worktree it creates with the
shared create-and-verify block (nested under `$TARGET_APP_DIR/.worktrees/`) for
isolation, and on the installed `worktree-write-fence.sh` PreToolUse hook for
ghost-write protection (the role `isolation="worktree"` plays for the
harness-isolated classes). Every self-isolated dispatch MUST create and verify
that worktree before its first Target mutation, and runs the git operations its
own playbook prescribes against the Target with cwd = `$TARGET_WT` (the
fragment's precedence rule). This launch shape is why the self-isolation variant
of the worktree-guard preamble exists: the default block's
`cwd == /home/gabe/hydra → ABORT` clause describes exactly the EXPECTED launch
state of a self-isolated class, so carrying the default preamble, or worse both,
is a guaranteed false-abort. Carry the variant instead.

### Why `qa_orch` has its own variant

**`qa_orch` dispatches carry their OWN forbidden-ending preamble variant, a
hazard-scoped rewrite rather than the `dev_orch` flat ban.** `hydra-qa`'s step 7
review fan-out is an `Agent(*)`-based design by construction: the Standards and
Spec reviewers run as **parallel sub-agents** so neither pollutes the other's
context, and every spawn already carries the blocking mandate
(`run_in_background: false`) plus the step 7.5 incomplete-fan-out exit. A blocking
spawn cannot outlive the turn, so it sits in the same safety class as a foreground
`Bash` call and is incapable of the backgrounded-wait hazard. `dev_orch` has no
equivalent internal blocking mandate, so for that class the tool ban and the
hazard ban coincide and the flat wording stays. Under the flat ban a `qa_orch`
dispatch complied with the letter by skipping the parallel Standards and Spec
fan-out and reviewing both axes itself inline: a competent single review, but not
the two independent, context-isolated reviewers the design calls for, and nothing
errored to surface the degradation.

The background-spawn ban is unconditional ("for ANY purpose") because a run that
fanned out nine background reviewer children had its parent worktree reaped by
the hourly orphan-prune and produced zero verdicts. The `run_in_background: false`
fan-out stays permitted: only a *background* spawn can outlive the parent's
worktree.
